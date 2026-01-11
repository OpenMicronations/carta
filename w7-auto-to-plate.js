// w7-auto-to-plate.js
const fs = require("fs");
const { JSDOM } = require("jsdom");
const d3geo = require("d3-geo");
const d3proj = require("d3-geo-projection");

const inFile = process.argv[2] || "flat.svg";
const outFile = process.argv[3] || "plate.svg";

function getAllPoints(doc) {
  const pts = [];
  for (const el of doc.querySelectorAll("path[d],polygon,polyline")) {
    if (el.tagName === "path") {
      const d = el.getAttribute("d") || "";
      const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        pts.push([nums[i], nums[i + 1]]);
      }
    } else {
      const arr = (
        el.getAttribute("points") || ""
      ).trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i + 1 < arr.length; i += 2) {
        pts.push([arr[i], arr[i + 1]]);
      }
    }
  }
  return pts;
}

function autoCalibrate(pts) {
  let xmin = Infinity,
    ymin = Infinity,
    xmax = -Infinity,
    ymax = -Infinity;
  for (const [x, y] of pts) {
    if (x < xmin) xmin = x;
    if (y < ymin) ymin = y;
    if (x > xmax) xmax = x;
    if (y > ymax) ymax = y;
  }

  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const w = xmax - xmin;
  const h = ymax - ymin;

  const wagnerFullWidth = 2 * 2.6632136599;
  const scale = w / wagnerFullWidth;

  console.log(
    `Auto: center=[${cx.toFixed(1)}, ${cy.toFixed(1)}], ` +
      `scale=${scale.toFixed(2)}, size=${w.toFixed(0)}x${h.toFixed(0)}`
  );

  return { cx, cy, scale };
}

function calibrateFromRedEquator(doc) {
  // Use the red horizontal line (equator) to derive translate+scale exactly.
  const unit = d3proj.geoWagner7().scale(1).translate([0, 0]);
  const p180 = unit([180, 0]);
  if (!p180 || !isFinite(p180[0]) || Math.abs(p180[0]) < 1e-9) return null;

  for (const el of Array.from(doc.querySelectorAll("path[d]"))) {
    const style = el.getAttribute("style") || "";
    const stroke = el.getAttribute("stroke") || "";
    const isRed =
      style.includes("stroke:rgb(255,0,0)") ||
      style.includes("stroke:#ff0000") ||
      style.includes("stroke:red") ||
      stroke === "#ff0000" ||
      stroke === "red";
    if (!isRed) continue;

    const d = el.getAttribute("d") || "";
    const m = d.match(
      /\bM\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+L\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)/i
    );
    if (!m) continue;

    const x1 = Number(m[1]);
    const y1 = Number(m[2]);
    const x2 = Number(m[3]);
    const y2 = Number(m[4]);
    if (![x1, y1, x2, y2].every(isFinite)) continue;
    if (Math.abs(y1 - y2) > 1e-3) continue;

    const xLeft = Math.min(x1, x2);
    const xRight = Math.max(x1, x2);
    const x180 = Math.abs(p180[0]);
    const scale = (xRight - xLeft) / (2 * x180);
    const cx = (xLeft + xRight) / 2;
    const cy = y1; // unit([0,0]).y is 0

    if (!isFinite(scale) || scale <= 0) continue;

    console.log(
      `Cal (red equator): center=[${cx.toFixed(3)}, ${cy.toFixed(3)}], scale=${scale.toFixed(6)}`
    );

    return { cx, cy, scale };
  }

  return null;
}

function wrapDeg180(a) {
  // Wrap to [-180, 180)
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  // normalize -180 to +180 for stability
  if (x === -180) x = 180;
  return x;
}

function parseDToPoints(d) {
  const nums = ((d || "").match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) || []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    if (!isFinite(x) || !isFinite(y)) continue;
    pts.push([x, y]);
  }
  return pts;
}

function fitScaleYFromMeridians(doc, { cx, cy, scaleX, shearX = 0 }) {
  const g = doc.getElementById("Längengrade");
  if (!g) return null;

  const unit = d3proj.geoWagner7().scale(1).translate([0, 0]);
  const meridians = [];

  for (const p of Array.from(g.querySelectorAll("path[d]"))) {
    const d0 = p.getAttribute("d") || "";
    const d = densifyPath(d0, 6);
    const pts = parseDToPoints(d);
    if (pts.length < 8) continue;

    // Find the point closest to equator to define the meridian's reference longitude.
    let best = null;
    for (const [x, y] of pts) {
      const dy = Math.abs(y - cy);
      if (!best || dy < best.dy) best = { x, y, dy };
    }
    if (!best || best.dy > 8) continue; // likely doesn't cross equator

    const uEq = (best.x - cx) / scaleX;
    const llEq = unit.invert([uEq, 0]);
    if (!llEq || !isFinite(llEq[0])) continue;
    const lonEq = llEq[0];

    // Sample points away from equator (they constrain scaleY)
    const samples = [];
    const step = Math.max(1, Math.floor(pts.length / 60));
    for (let i = 0; i < pts.length; i += step) {
      const [x, y] = pts[i];
      if (Math.abs(y - cy) < 20) continue;
      samples.push([x, y]);
      if (samples.length >= 60) break;
    }
    if (samples.length < 6) continue;

    meridians.push({ lonEq, samples });
  }

  if (meridians.length < 3) return null;

  function score(scaleY) {
    if (!isFinite(scaleY) || scaleY <= 0) return Infinity;
    let sum = 0;
    let n = 0;
    for (const m of meridians) {
      for (const [x, y] of m.samples) {
        const u = (x - cx - shearX * (y - cy)) / scaleX;
        const v = (y - cy) / scaleY;
        const ll = unit.invert([u, v]);
        if (!ll || !isFinite(ll[0])) continue;
        const dLon = wrapDeg180(ll[0] - m.lonEq);
        sum += dLon * dLon;
        n++;
      }
    }
    return n > 50 ? sum / n : Infinity;
  }

  // Coarse log sweep to bracket the minimum robustly.
  const minS = scaleX / 4;
  const maxS = scaleX * 4;
  const vals = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const s = minS * Math.pow(maxS / minS, t);
    vals.push({ s, v: score(s) });
  }
  vals.sort((a, b) => a.v - b.v);
  const best = vals[0];
  if (!isFinite(best.v) || best.v === Infinity) return null;

  // Refine around best using golden-section search.
  const idx = (() => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const s = minS * Math.pow(maxS / minS, t);
      const dist = Math.abs(Math.log(s / best.s));
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  })();

  const loIdx = Math.max(0, idx - 2);
  const hiIdx = Math.min(40, idx + 2);
  const lo = minS * Math.pow(maxS / minS, loIdx / 40);
  const hi = minS * Math.pow(maxS / minS, hiIdx / 40);

  let a = lo,
    b = hi;
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = score(c);
  let fd = score(d);
  for (let iter = 0; iter < 40; iter++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = score(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = score(d);
    }
  }

  const bestY = fc < fd ? c : d;
  const bestScore = Math.min(fc, fd);
  if (!isFinite(bestScore) || bestScore === Infinity) return null;
  return bestY;
}

function fitShearXFromMeridians(doc, { cx, cy, scaleX, scaleY }) {
  const g = doc.getElementById("Längengrade");
  if (!g) return null;

  const unit = d3proj.geoWagner7().scale(1).translate([0, 0]);
  const meridians = [];

  for (const p of Array.from(g.querySelectorAll("path[d]"))) {
    const d0 = p.getAttribute("d") || "";
    const d = densifyPath(d0, 6);
    const pts = parseDToPoints(d);
    if (pts.length < 8) continue;

    let best = null;
    for (const [x, y] of pts) {
      const dy = Math.abs(y - cy);
      if (!best || dy < best.dy) best = { x, y, dy };
    }
    if (!best || best.dy > 8) continue;

    const uEq = (best.x - cx) / scaleX;
    const llEq = unit.invert([uEq, 0]);
    if (!llEq || !isFinite(llEq[0])) continue;
    const lonEq = llEq[0];

    const samples = [];
    const step = Math.max(1, Math.floor(pts.length / 60));
    for (let i = 0; i < pts.length; i += step) {
      const [x, y] = pts[i];
      if (Math.abs(y - cy) < 20) continue;
      samples.push([x, y]);
      if (samples.length >= 60) break;
    }
    if (samples.length < 6) continue;

    meridians.push({ lonEq, samples });
  }

  if (meridians.length < 3) return null;

  function score(shearX) {
    if (!isFinite(shearX)) return Infinity;
    let sum = 0;
    let n = 0;
    for (const m of meridians) {
      for (const [x, y] of m.samples) {
        const u = (x - cx - shearX * (y - cy)) / scaleX;
        const v = (y - cy) / scaleY;
        const ll = unit.invert([u, v]);
        if (!ll || !isFinite(ll[0])) continue;
        const dLon = wrapDeg180(ll[0] - m.lonEq);
        sum += dLon * dLon;
        n++;
      }
    }
    return n > 50 ? sum / n : Infinity;
  }

  let a = -0.05;
  let b = 0.05;
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = score(c);
  let fd = score(d);
  for (let iter = 0; iter < 50; iter++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = score(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = score(d);
    }
  }
  const best = fc < fd ? c : d;
  const bestScore = Math.min(fc, fd);
  if (!isFinite(bestScore) || bestScore === Infinity) return null;
  return best;
}

// Cubic bezier interpolation
function cubicBezier(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

// Quadratic bezier interpolation
function quadBezier(t, p0, p1, p2) {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

function densifyPath(d, maxSegmentLen = 2) {
  const toks = (d || "")
    .replace(/([a-zA-Z])/g, " $1 ")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  let i = 0;
  let cmd = "";
  let lastX = 0,
    lastY = 0;
  let startX = 0,
    startY = 0;
  let prevCmd = "";
  let prevCubicCtrlX = null,
    prevCubicCtrlY = null;
  let prevQuadCtrlX = null,
    prevQuadCtrlY = null;
  const out = [];

  function isCmdTok(tok) {
    return typeof tok === "string" && /^[a-zA-Z]$/.test(tok);
  }

  function hasNumber() {
    return i < toks.length && !isCmdTok(toks[i]);
  }

  function nextNum() {
    return parseFloat(toks[i++]);
  }

  function interpolateLine(x1, y1, x2, y2) {
    const dx = x2 - x1,
      dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(dist / maxSegmentLen));
    const pts = [];
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      pts.push([x1 + dx * t, y1 + dy * t]);
    }
    return pts;
  }

  function interpolateCubic(x0, y0, x1, y1, x2, y2, x3, y3) {
    // Estimate curve length for step count
    const approxLen = Math.sqrt((x3 - x0) ** 2 + (y3 - y0) ** 2) +
                      Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2) +
                      Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) +
                      Math.sqrt((x3 - x2) ** 2 + (y3 - y2) ** 2);
    const steps = Math.max(4, Math.ceil(approxLen / maxSegmentLen));
    const pts = [];
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      pts.push([
        cubicBezier(t, x0, x1, x2, x3),
        cubicBezier(t, y0, y1, y2, y3)
      ]);
    }
    return pts;
  }

  function interpolateQuad(x0, y0, x1, y1, x2, y2) {
    const approxLen = Math.sqrt((x2 - x0) ** 2 + (y2 - y0) ** 2) +
                      Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2) +
                      Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const steps = Math.max(4, Math.ceil(approxLen / maxSegmentLen));
    const pts = [];
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      pts.push([
        quadBezier(t, x0, x1, x2),
        quadBezier(t, y0, y1, y2)
      ]);
    }
    return pts;
  }

  function interpolateArc(x1, y1, rx, ry, xAxisRotation, largeArc, sweep, x2, y2) {
    // approximate arc with many line segments
    const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const steps = Math.max(8, Math.ceil(dist / maxSegmentLen) * 2);
    const pts = [];
    
    // linear interpolation as fallback (proper arc math is too complex for my brain)
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
    return pts;
  }

  while (i < toks.length) {
    if (isCmdTok(toks[i])) {
      cmd = toks[i++];
    }
    if (!cmd) break;

    const up = cmd.toUpperCase();
    const rel = cmd !== up;

    if (up === "M") {
      if (!hasNumber()) continue;
      let x = nextNum();
      let y = nextNum();
      if (rel) {
        x += lastX;
        y += lastY;
      }
      lastX = x;
      lastY = y;
      startX = x;
      startY = y;
      out.push(`M ${lastX} ${lastY}`);
      prevCubicCtrlX = prevCubicCtrlY = null;
      prevQuadCtrlX = prevQuadCtrlY = null;
      prevCmd = up;

      cmd = rel ? "l" : "L";
      continue;
    }

    if (up === "Z") {
      if (lastX !== startX || lastY !== startY) {
        const pts = interpolateLine(lastX, lastY, startX, startY);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
      }
      out.push("Z");
      lastX = startX;
      lastY = startY;
      prevCubicCtrlX = prevCubicCtrlY = null;
      prevQuadCtrlX = prevQuadCtrlY = null;
      prevCmd = up;
      continue;
    }

    if (up === "L") {
      while (hasNumber()) {
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x += lastX;
          y += lastY;
        }
        const pts = interpolateLine(lastX, lastY, x, y);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        lastX = x;
        lastY = y;
      }
      prevCubicCtrlX = prevCubicCtrlY = null;
      prevQuadCtrlX = prevQuadCtrlY = null;
      prevCmd = up;
      continue;
    }

    if (up === "H") {
      while (hasNumber()) {
        let x = nextNum();
        if (rel) x += lastX;
        const pts = interpolateLine(lastX, lastY, x, lastY);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        lastX = x;
      }
      prevCubicCtrlX = prevCubicCtrlY = null;
      prevQuadCtrlX = prevQuadCtrlY = null;
      prevCmd = up;
      continue;
    }

    if (up === "V") {
      while (hasNumber()) {
        let y = nextNum();
        if (rel) y += lastY;
        const pts = interpolateLine(lastX, lastY, lastX, y);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        lastY = y;
      }
      prevCubicCtrlX = prevCubicCtrlY = null;
      prevQuadCtrlX = prevQuadCtrlY = null;
      prevCmd = up;
      continue;
    }

    if (up === "C") {
      while (hasNumber()) {
        let x1 = nextNum();
        let y1 = nextNum();
        let x2 = nextNum();
        let y2 = nextNum();
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x1 += lastX;
          y1 += lastY;
          x2 += lastX;
          y2 += lastY;
          x += lastX;
          y += lastY;
        }
        const pts = interpolateCubic(lastX, lastY, x1, y1, x2, y2, x, y);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        lastX = x;
        lastY = y;
        prevCubicCtrlX = x2;
        prevCubicCtrlY = y2;
        prevQuadCtrlX = prevQuadCtrlY = null;
        prevCmd = up;
      }
      continue;
    }

    if (up === "S") {
      while (hasNumber()) {
        let x2 = nextNum();
        let y2 = nextNum();
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x2 += lastX;
          y2 += lastY;
          x += lastX;
          y += lastY;
        }
        let x1 = lastX;
        let y1 = lastY;
        if (prevCmd === "C" || prevCmd === "S") {
          if (prevCubicCtrlX != null && prevCubicCtrlY != null) {
            x1 = 2 * lastX - prevCubicCtrlX;
            y1 = 2 * lastY - prevCubicCtrlY;
          }
        }
        const pts = interpolateCubic(lastX, lastY, x1, y1, x2, y2, x, y);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        lastX = x;
        lastY = y;
        prevCubicCtrlX = x2;
        prevCubicCtrlY = y2;
        prevQuadCtrlX = prevQuadCtrlY = null;
        prevCmd = up;
      }
      continue;
    }

    if (up === "Q") {
      while (hasNumber()) {
        let x1 = nextNum();
        let y1 = nextNum();
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x1 += lastX;
          y1 += lastY;
          x += lastX;
          y += lastY;
        }
        const pts = interpolateQuad(lastX, lastY, x1, y1, x, y);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        lastX = x;
        lastY = y;
        prevQuadCtrlX = x1;
        prevQuadCtrlY = y1;
        prevCubicCtrlX = prevCubicCtrlY = null;
        prevCmd = up;
      }
      continue;
    }

    if (up === "T") {
      while (hasNumber()) {
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x += lastX;
          y += lastY;
        }
        let x1 = lastX;
        let y1 = lastY;
        if (prevCmd === "Q" || prevCmd === "T") {
          if (prevQuadCtrlX != null && prevQuadCtrlY != null) {
            x1 = 2 * lastX - prevQuadCtrlX;
            y1 = 2 * lastY - prevQuadCtrlY;
          }
        }
        const pts = interpolateQuad(lastX, lastY, x1, y1, x, y);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        prevQuadCtrlX = x1;
        prevQuadCtrlY = y1;
        prevCubicCtrlX = prevCubicCtrlY = null;
        prevCmd = up;
        lastX = x;
        lastY = y;
      }
      continue;
    }

    if (up === "A") {
      while (hasNumber()) {
        const rx = nextNum();
        const ry = nextNum();
        const xrot = nextNum();
        const large = nextNum();
        const sweep = nextNum();
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x += lastX;
          y += lastY;
        }
        const pts = interpolateArc(lastX, lastY, rx, ry, xrot, large, sweep, x, y);
        pts.slice(1).forEach(([px, py]) => out.push(`L ${px} ${py}`));
        lastX = x;
        lastY = y;
        prevCubicCtrlX = prevCubicCtrlY = null;
        prevQuadCtrlX = prevQuadCtrlY = null;
        prevCmd = up;
      }
      continue;
    }

    // Unknown/unsupported command:
    prevCmd = up;
  }
  return out.join(" ");
}

function run() {
  const svgTxt = fs.readFileSync(inFile, "utf8");
  const dom = new JSDOM(svgTxt);
  const doc = dom.window.document;

  function getBBoxFromPathD(d) {
    const nums = ((d || "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    let xmin = Infinity,
      ymin = Infinity,
      xmax = -Infinity,
      ymax = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i];
      const y = nums[i + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < xmin) xmin = x;
      if (y < ymin) ymin = y;
      if (x > xmax) xmax = x;
      if (y > ymax) ymax = y;
    }
    if (!isFinite(xmin)) return null;
    return { xmin, ymin, xmax, ymax, w: xmax - xmin, h: ymax - ymin };
  }

  function getStyleAttr(el, key) {
    const direct = el.getAttribute(key);
    if (direct != null) return direct;
    const style = el.getAttribute("style") || "";
    const m = style.match(new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([^;]+)`));
    return m ? m[1].trim() : null;
  }

  const pts = getAllPoints(doc);
  if (pts.length < 10) {
    console.error("Zu wenige Punkte");
    process.exit(1);
  }

  const cal = calibrateFromRedEquator(doc);
  const { cx, cy, scale } = cal || autoCalibrate(pts);
  const scaleX = scale;
  let scaleY = cal ? fitScaleYFromMeridians(doc, { cx, cy, scaleX }) || scaleX : scaleX;
  let shearX = 0;
  if (cal) {
    // Fit a small x-shear (x depends on y) to remove consistent meridian tilt.
    shearX = fitShearXFromMeridians(doc, { cx, cy, scaleX, scaleY }) || 0;
    // Re-fit scaleY with shear applied (they interact slightly).
    scaleY = fitScaleYFromMeridians(doc, { cx, cy, scaleX, shearX }) || scaleY;
  }
  if (cal) {
    console.log(
      `Cal (meridians): scaleX=${scaleX.toFixed(6)}, scaleY=${scaleY.toFixed(6)}, shearX=${shearX.toFixed(6)}`
    );
  }

  const unitW7 = d3proj.geoWagner7().scale(1).translate([0, 0]);

  // Plate Carrée: Breite = 2×Höhe, zentriert
  const plateWidth = 1800;
  const plateHeight = 900;
  const plateScale = plateWidth / (2 * Math.PI);

  const projTo = d3geo
    .geoEquirectangular()
    .scale(plateScale)
    .translate([plateWidth / 2, plateHeight / 2]);

  function inv(x, y) {
    // Undo the SVG's Wagner-screen mapping manually to allow anisotropic scaling.
    const u = (x - cx - shearX * (y - cy)) / scaleX;
    const v = (y - cy) / scaleY;
    const ll = unitW7.invert([u, v]);
    if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return null;
    return ll;
  }

  function fwd(lon, lat) {
    const [x, y] = projTo([lon, lat]);
    return [x, y];
  }

  function transformPath(d) {
    const toks = (d || "")
      .replace(/([a-zA-Z])/g, " $1 ")
      .trim()
      .split(/[\s,]+/);
    let i = 0,
      cmd = "";
    const out = [];

    function pair() {
      const x = parseFloat(toks[i++]);
      const y = parseFloat(toks[i++]);
      const ll = inv(x, y);
      if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return null;
      const xy = fwd(ll[0], ll[1]);
      return xy && isFinite(xy[0]) && isFinite(xy[1]) ? xy : null;
    }

    let penUp = true;
    let lastOutX = null;

    function emitPoint(x, y) {
      // Break subpaths across the antimeridian to avoid huge diagonals.
      if (!penUp && lastOutX != null && Math.abs(x - lastOutX) > plateWidth * 0.5) {
        penUp = true;
      }

      if (penUp) {
        out.push(`M ${x} ${y}`);
        penUp = false;
      } else {
        out.push(`L ${x} ${y}`);
      }
      lastOutX = x;
    }

    while (i < toks.length) {
      const t = toks[i++];
      if (/[a-zA-Z]/.test(t)) cmd = t.toUpperCase();
      else i--;

      if (cmd === "M" || cmd === "L" || cmd === "T") {
        const p = pair();
        if (p) emitPoint(p[0], p[1]);
        else {
          penUp = true;
          lastOutX = null;
        }
      } else if (cmd === "C") {
        const p1 = pair(),
          p2 = pair(),
          p3 = pair();
        if (p1 && p2 && p3) {
          emitPoint(p1[0], p1[1]);
          emitPoint(p2[0], p2[1]);
          emitPoint(p3[0], p3[1]);
        } else {
          penUp = true;
          lastOutX = null;
        }
      } else if (cmd === "Q") {
        const p1 = pair(),
          p2 = pair();
        if (p1 && p2) {
          emitPoint(p1[0], p1[1]);
          emitPoint(p2[0], p2[1]);
        } else {
          penUp = true;
          lastOutX = null;
        }
      } else if (cmd === "A") {
        parseFloat(toks[i++]); // rx
        parseFloat(toks[i++]); // ry
        parseFloat(toks[i++]); // xrot
        parseFloat(toks[i++]); // large
        parseFloat(toks[i++]); // sweep
        const p = pair();
        if (p) emitPoint(p[0], p[1]);
        else {
          penUp = true;
          lastOutX = null;
        }
      } else if (cmd === "Z") {
        if (!penUp) out.push("Z");
        penUp = true;
        lastOutX = null;
      }
    }
    return out.join(" ");
  }

  // polygon 2 paths
  for (const poly of Array.from(
    doc.querySelectorAll("polygon, polyline")
  )) {
    const arr = (poly.getAttribute("points") || "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const path = doc.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    for (const a of Array.from(poly.attributes)) {
      if (!["points", "transform"].includes(a.name))
        path.setAttribute(a.name, a.value);
    }
    let d = "";
    for (let i = 0; i + 1 < arr.length; i += 2) {
      d += (i === 0 ? "M " : "L ") + arr[i] + " " + arr[i + 1] + " ";
    }
    if (poly.tagName.toLowerCase() === "polygon") d += "Z";
    if (d.trim()) {
      path.setAttribute("d", d.trim());
      poly.parentNode.replaceChild(path, poly);
    }
  }

  // transform paths with densify..
  for (const p of doc.querySelectorAll("path[d]")) {
    let d = p.getAttribute("d");
    d = densifyPath(d, 2); // Verdichte gekrümmte Linien
    const nd = transformPath(d);
    if (nd.trim()) p.setAttribute("d", nd);
    p.removeAttribute("transform");
  }

  // Transform image elements by reprojecting their position... only needede for Molillo but still doesn't work lol
  for (const img of doc.querySelectorAll("image")) {
    let x = parseFloat(img.getAttribute("x") || 0);
    let y = parseFloat(img.getAttribute("y") || 0);
    const w = parseFloat(img.getAttribute("width") || 0);
    const h = parseFloat(img.getAttribute("height") || 0);
    
    // Check for transform attribute and extract translation
    const transform = img.getAttribute("transform");
    if (transform) {
      const translateMatch = transform.match(/translate\(\s*([^,\s]+)[\s,]+([^)]+)\)/);
      if (translateMatch) {
        x += parseFloat(translateMatch[1]);
        y += parseFloat(translateMatch[2]);
      }
      const matrixMatch = transform.match(/matrix\(\s*([^,\s]+)[\s,]+([^,\s]+)[\s,]+([^,\s]+)[\s,]+([^,\s]+)[\s,]+([^,\s]+)[\s,]+([^)]+)\)/);
      if (matrixMatch) {
        x += parseFloat(matrixMatch[5]);
        y += parseFloat(matrixMatch[6]);
      }
    }
    
    // Reproject the top-left and bottom-right corners
    const ll1 = inv(x, y);
    const ll2 = inv(x + w, y + h);
    
    if (ll1 && ll2 && isFinite(ll1[0]) && isFinite(ll1[1]) && isFinite(ll2[0]) && isFinite(ll2[1])) {
      const xy1 = fwd(ll1[0], ll1[1]);
      const xy2 = fwd(ll2[0], ll2[1]);
      
      if (xy1 && xy2 && isFinite(xy1[0]) && isFinite(xy1[1]) && isFinite(xy2[0]) && isFinite(xy2[1])) {
        img.setAttribute("x", xy1[0]);
        img.setAttribute("y", xy1[1]);
        img.setAttribute("width", Math.abs(xy2[0] - xy1[0]));
        img.setAttribute("height", Math.abs(xy2[1] - xy1[1]));
        img.removeAttribute("transform");
      }
    }
  }

  // viewbox to pc
  const svg = doc.querySelector("svg");
  svg.setAttribute("viewBox", `0 0 ${plateWidth} ${plateHeight}`);
  svg.setAttribute("width", plateWidth);
  svg.setAttribute("height", plateHeight);

  {
    let best = null;
    for (const p of doc.querySelectorAll("path[d]")) {
      const d = p.getAttribute("d") || "";
      const bb = getBBoxFromPathD(d);
      if (!bb) continue;
      const fill = getStyleAttr(p, "fill");
      if (!fill || fill === "none") continue;
      // near-canvas coverage threshold
      if (bb.w < plateWidth * 0.97 || bb.h < plateHeight * 0.97) continue;
      const area = bb.w * bb.h;
      if (!best || area > best.area) best = { p, area, fill };
    }

    if (best) {
      const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", "0");
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(plateWidth));
      rect.setAttribute("height", String(plateHeight));
      // copy presentation attributes/styles except geometry
      for (const a of Array.from(best.p.attributes)) {
        if (["d", "transform", "x", "y", "width", "height"].includes(a.name)) continue;
        rect.setAttribute(a.name, a.value);
      }
      // ensure fill stays the same (in case it was style-only)
      if (!rect.getAttribute("fill") || rect.getAttribute("fill") === "none") {
        rect.setAttribute("fill", best.fill);
      }
      best.p.parentNode.replaceChild(rect, best.p);
    }
  }

  const svgStr = svg.outerHTML;
  fs.writeFileSync(outFile, svgStr, "utf8");
  console.log(`OK -> ${outFile}`);
}

run();
