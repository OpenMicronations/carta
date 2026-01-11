// Reads carta.svg, applies transforms, expands simple <use>, flattens groups,
// writes flat.svg (no viewBox/size changes)

const fs = require("fs");
const { JSDOM } = require("jsdom");

const IN = "carta.svg";
const OUT = "flat.svg";

function parseTransform(t) {
  // returns 3x3 matrix [a,c,e; b,d,f; 0,0,1] as [a,b,c,d,e,f] (SVG matrix form)
  // supports matrix(), translate(), scale(), rotate([angle [cx cy]]), skewX, skewY
  if (!t) return [1, 0, 0, 1, 0, 0];
  const cmds = [];
  t.replace(/([a-zA-Z]+)\s*\(([^)]*)\)/g, (_, name, args) => {
    const v = args
      .split(/[, \t\r\n]+/)
      .filter(Boolean)
      .map((x) => parseFloat(x));
    name = name.toLowerCase();
    let m = [1, 0, 0, 1, 0, 0];
    if (name === "matrix" && v.length >= 6) {
      m = [v[0], v[1], v[2], v[3], v[4], v[5]];
    } else if (name === "translate") {
      const tx = v[0] || 0;
      const ty = v[1] || 0;
      m = [1, 0, 0, 1, tx, ty];
    } else if (name === "scale") {
      const sx = v[0] ?? 1;
      const sy = v.length > 1 ? v[1] : sx;
      m = [sx, 0, 0, sy, 0, 0];
    } else if (name === "rotate") {
      const ang = ((v[0] || 0) * Math.PI) / 180;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      if (v.length > 2) {
        const cx = v[1] || 0;
        const cy = v[2] || 0;
        // T(cx,cy) R T(-cx,-cy)
        m = mul(mul([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [
          1,
          0,
          0,
          1,
          -cx,
          -cy,
        ]);
      } else {
        m = [cos, sin, -sin, cos, 0, 0];
      }
    } else if (name === "skewx") {
      const ang = ((v[0] || 0) * Math.PI) / 180;
      m = [1, 0, Math.tan(ang), 1, 0, 0];
    } else if (name === "skewy") {
      const ang = ((v[0] || 0) * Math.PI) / 180;
      m = [1, Math.tan(ang), 0, 1, 0, 0];
    }
    cmds.push(m);
  });
  return cmds.reduce((A, B) => mul(A, B), [1, 0, 0, 1, 0, 0]);
}

function mul(a, b) {
  // multiply 2x3 SVG matrices
  // a = [a,b,c,d,e,f] meaning [[a c e],[b d f],[0 0 1]]
  // b same; result a*b
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyToPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function absPath(d) {
  // convert path data to absolute commands, minimal subset covers M,L,H,V,C,S,Q,T,A,Z
  if (!d) return d;
  const tokens = d
    .replace(/([a-zA-Z])/g, " $1 ")
    .trim()
    .split(/[\s,]+/);

  let i = 0;
  let cmd = "";
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  let out = [];
  function num() {
    return parseFloat(tokens[i++]);
  }
  while (i < tokens.length) {
    const t = tokens[i++];
    if (/[a-zA-Z]/.test(t)) cmd = t;
    else {
      i--;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === "M" || C === "L" || C === "T") {
      let nx = num();
      let ny = num();
      if (rel) {
        nx += x;
        ny += y;
      }
      if (C === "M") {
        sx = nx;
        sy = ny;
      }
      out.push(`${C} ${nx} ${ny}`);
      x = nx;
      y = ny;
      if (C === "M") cmd = rel ? "l" : "L"; // subsequent pairs as L
    } else if (C === "H") {
      let nx = num();
      if (rel) nx += x;
      out.push(`L ${nx} ${y}`);
      x = nx;
    } else if (C === "V") {
      let ny = num();
      if (rel) ny += y;
      out.push(`L ${x} ${ny}`);
      y = ny;
    } else if (C === "C") {
      let x1 = num(),
        y1 = num(),
        x2 = num(),
        y2 = num(),
        nx = num(),
        ny = num();
      if (rel) {
        x1 += x;
        y1 += y;
        x2 += x;
        y2 += y;
        nx += x;
        ny += y;
      }
      out.push(`C ${x1} ${y1} ${x2} ${y2} ${nx} ${ny}`);
      x = nx;
      y = ny;
    } else if (C === "S") {
      // shorthand cubic; reflect not handled precisely without previous control
      let x2 = num(),
        y2 = num(),
        nx = num(),
        ny = num();
      if (rel) {
        x2 += x;
        y2 += y;
        nx += x;
        ny += y;
      }
      out.push(`C ${x} ${y} ${x2} ${y2} ${nx} ${ny}`);
      x = nx;
      y = ny;
    } else if (C === "Q") {
      let x1 = num(),
        y1 = num(),
        nx = num(),
        ny = num();
      if (rel) {
        x1 += x;
        y1 += y;
        nx += x;
        ny += y;
      }
      out.push(`Q ${x1} ${y1} ${nx} ${ny}`);
      x = nx;
      y = ny;
    } else if (C === "T") {
      let nx = num(),
        ny = num();
      if (rel) {
        nx += x;
        ny += y;
      }
      out.push(`Q ${x} ${y} ${nx} ${ny}`);
      x = nx;
      y = ny;
    } else if (C === "A") {
      // rx ry xrot large-arc sweep x y
      let rx = num(),
        ry = num(),
        xrot = num(),
        large = num(),
        sweep = num(),
        nx = num(),
        ny = num();
      if (rel) {
        nx += x;
        ny += y;
      }
      out.push(`A ${rx} ${ry} ${xrot} ${large} ${sweep} ${nx} ${ny}`);
      x = nx;
      y = ny;
    } else if (C === "Z") {
      out.push("Z");
      x = sx;
      y = sy;
    }
  }
  return out.join(" ");
}

function transformPath(d, m) {
  if (!d) return d;
  const parts = d
    .replace(/([a-zA-Z])/g, " $1 ")
    .trim()
    .split(/[\s,]+/);
  let i = 0;
  let cmd = "";
  let out = [];
  function read(n) {
    const a = [];
    for (let k = 0; k < n; k++) a.push(parseFloat(parts[i++]));
    return a;
  }
  while (i < parts.length) {
    const t = parts[i++];
    if (/[a-zA-Z]/.test(t)) cmd = t.toUpperCase();
    else {
      i--;
    }
    if (cmd === "M" || cmd === "L" || cmd === "T") {
      const [x, y] = read(2);
      const [X, Y] = applyToPoint(m, x, y);
      out.push(`${cmd} ${X} ${Y}`);
    } else if (cmd === "C") {
      const [x1, y1, x2, y2, x, y] = read(6);
      const [X1, Y1] = applyToPoint(m, x1, y1);
      const [X2, Y2] = applyToPoint(m, x2, y2);
      const [X, Y] = applyToPoint(m, x, y);
      out.push(`C ${X1} ${Y1} ${X2} ${Y2} ${X} ${Y}`);
    } else if (cmd === "Q") {
      const [x1, y1, x, y] = read(4);
      const [X1, Y1] = applyToPoint(m, x1, y1);
      const [X, Y] = applyToPoint(m, x, y);
      out.push(`Q ${X1} ${Y1} ${X} ${Y}`);
    } else if (cmd === "A") {
      // Approx: transform only endpoints, keep rx/ry/xrot/flags
      const [rx, ry, xrot, large, sweep, x, y] = read(7);
      const [X, Y] = applyToPoint(m, x, y);
      out.push(`A ${rx} ${ry} ${xrot} ${large} ${sweep} ${X} ${Y}`);
    } else if (cmd === "Z") {
      out.push("Z");
    } else if (cmd === "H" || cmd === "V" || cmd === "S") {
      // Should not occur hopefully
    }
  }
  return out.join(" ");
}

function flattenNode(node, parentMatrix) {
  const own = parseTransform(node.getAttribute("transform"));
  const m = mul(parentMatrix, own);

  // Recurse first so we can hoist children if needed
  for (const child of Array.from(node.children)) {
    flattenNode(child, m);
  }

  // Apply to current element if its a shape
  const tag = node.tagName?.toLowerCase();
  if (tag === "path") {
    const d = node.getAttribute("d");
    const abs = absPath(d);
    const tr = transformPath(abs, m);
    node.setAttribute("d", tr);
    node.removeAttribute("transform");
  } else if (tag === "polygon" || tag === "polyline") {
    const pts = (node.getAttribute("points") || "")
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((n) => parseFloat(n));
    const out = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const [X, Y] = applyToPoint(m, pts[i], pts[i + 1]);
      out.push(`${X},${Y}`);
    }
    node.setAttribute("points", out.join(" "));
    node.removeAttribute("transform");
  } else if (tag === "circle") {
    const cx = parseFloat(node.getAttribute("cx") || "0");
    const cy = parseFloat(node.getAttribute("cy") || "0");
    const [X, Y] = applyToPoint(m, cx, cy);
    node.setAttribute("cx", X);
    node.setAttribute("cy", Y);
    node.removeAttribute("transform");
    // r is not scaled keep as-is
  } else if (tag === "ellipse" || tag === "rect" || tag === "line") {
    // Convert to path for simplicity
    toPath(node, m);
  }

  // After transforming, if it was a group with only geometry, clear its transform
  if (node.hasAttribute && node.hasAttribute("transform")) {
    node.removeAttribute("transform");
  }
}

function toPath(node, m) {
  const tag = node.tagName.toLowerCase();
  let d = "";
  if (tag === "rect") {
    const x = parseFloat(node.getAttribute("x") || "0");
    const y = parseFloat(node.getAttribute("y") || "0");
    const w = parseFloat(node.getAttribute("width") || "0");
    const h = parseFloat(node.getAttribute("height") || "0");
    const p = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    const t = p.map((pt) => applyToPoint(m, pt[0], pt[1]));
    d = `M ${t[0][0]} ${t[0][1]} L ${t[1][0]} ${t[1][1]} ${t[2][0]} ${t[2][1]} ${t[3][0]} ${t[3][1]} Z`;
  } else if (tag === "line") {
    const x1 = parseFloat(node.getAttribute("x1") || "0");
    const y1 = parseFloat(node.getAttribute("y1") || "0");
    const x2 = parseFloat(node.getAttribute("x2") || "0");
    const y2 = parseFloat(node.getAttribute("y2") || "0");
    const a = applyToPoint(m, x1, y1);
    const b = applyToPoint(m, x2, y2);
    d = `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`;
  } else if (tag === "ellipse") {
    // Rough convert to circle-like path via bounding box corners
    const cx = parseFloat(node.getAttribute("cx") || "0");
    const cy = parseFloat(node.getAttribute("cy") || "0");
    const rx = parseFloat(node.getAttribute("rx") || "0");
    const ry = parseFloat(node.getAttribute("ry") || "0");
    const p1 = applyToPoint(m, cx - rx, cy);
    const p2 = applyToPoint(m, cx + rx, cy);
    const p3 = applyToPoint(m, cx, cy - ry);
    const p4 = applyToPoint(m, cx, cy + ry);
    // Keep as two arcs (not fully accurate under rotation/scale)
    d = `M ${p1[0]} ${p1[1]} A ${rx} ${ry} 0 1 0 ${p2[0]} ${p2[1]} A ${rx} ${ry} 0 1 0 ${p1[0]} ${p1[1]} Z`;
  } else if (tag === "circle") {
    return; // alr done
  } else {
    return;
  }
  const path = node.ownerDocument.createElementNS(
    "http://www.w3.org/2000/svg",
    "path"
  );
  // copy style-ish attributes
  for (const attr of Array.from(node.attributes)) {
    if (!["x", "y", "width", "height", "x1", "y1", "x2", "y2", "cx", "cy", "rx", "ry", "transform"].includes(attr.name)) {
      path.setAttribute(attr.name, attr.value);
    }
  }
  path.setAttribute("d", d);
  node.parentNode.replaceChild(path, node);
}

function inlineUses(doc) {
  const uses = Array.from(doc.querySelectorAll("use"));
  for (const u of uses) {
    const href =
      u.getAttribute("href") || u.getAttribute("xlink:href") || "";
    if (!href.startsWith("#")) continue;
    const ref = doc.querySelector(href);
    if (!ref) continue;
    const clone = ref.cloneNode(true);
    const tx = [];
    const x = parseFloat(u.getAttribute("x") || "0");
    const y = parseFloat(u.getAttribute("y") || "0");
    if (x || y) tx.push(`translate(${x},${y})`);
    const t2 = u.getAttribute("transform");
    if (t2) tx.push(t2);
    if (tx.length) clone.setAttribute("transform", tx.join(" "));
    u.parentNode.replaceChild(clone, u);
  }
}

function run() {
  const svgText = fs.readFileSync(IN, "utf8");
  const dom = new JSDOM(svgText);
  const doc = dom.window.document;

  inlineUses(doc);

  const svg = doc.querySelector("svg");
  if (!svg) throw new Error("No <svg> root found");

  // Walk and flatten starting at root with identity matrix
  flattenNode(svg, [1, 0, 0, 1, 0, 0]);

  // Remove transforms left on groups
  doc.querySelectorAll("[transform]").forEach((el) =>
    el.removeAttribute("transform")
  );

  fs.writeFileSync(OUT, dom.serialize(), "utf8");
  console.log(`Wrote ${OUT}`);
}

run();
