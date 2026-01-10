#!/bin/bash

# --- Einstellungen ---
INPUT_PNG="world-map.png"
OUTPUT_PNG="output_map.png"
CENTER_LON="-77.9"
CENTER_LAT="45.9"
SIZE_M="3500000"  # 500km in jede Richtung vom Mittelpunkt
RES_PX="2048"    # Zielauflösung in Pixeln

# Proj-String für LAEA
PROJ_STR="+proj=laea +lat_0=$CENTER_LAT +lon_0=$CENTER_LON +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"

echo "Starte Export für $CENTER_LAT N, $CENTER_LON E..."

# 1. Georeferenzierung zuweisen (Plate Carree 2:1)
gdal_translate -of GTiff \
  -a_srs EPSG:4326 \
  -a_ullr -180 90 180 -90 \
  "$INPUT_PNG" world_referenced.tif

# 2. Umprojizieren, Ausschnitt wählen & Schärfe optimieren
# -r lanczos sorgt für die Schärfe
# -te xmin ymin xmax ymax
gdalwarp -overwrite \
  -r lanczos \
  -t_srs "$PROJ_STR" \
  -te "-$SIZE_M" "-$SIZE_M" "$SIZE_M" "$SIZE_M" \
  -ts "$RES_PX" "$RES_PX" \
  world_referenced.tif temp_result.tif

# 3. Finaler PNG Export
gdal_translate -of PNG temp_result.tif "$OUTPUT_PNG"

# 4. Aufräumen
rm world_referenced.tif temp_result.tif

echo "Fertig! Karte gespeichert als $OUTPUT_PNG"
