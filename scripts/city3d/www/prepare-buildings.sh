#!/bin/bash
# Prépare served/buildings/<dalle>.bld pour une ou plusieurs dalles LiDAR HD : téléchargement, roofer (Docker), conversion.
#
#   ./prepare-buildings.sh                      dalle 0846-6494 (centre de Vienne)
#   ./prepare-buildings.sh 0846-6494 0847-6494  les dalles données (nom « XXXX-YYYY » = coin nord-ouest en km, Lambert-93)
#   ./prepare-buildings.sh around 0846-6494     la dalle et ses 8 voisines (9 dalles)
#
# Prérequis : docker, curl, python3. Par dalle : ~290 Mo à télécharger, ~1 min 30 de roofer sur 12 cœurs. Relançable :
# les fichiers déjà présents ne sont pas retéléchargés. Le nuage COPC est partagé avec prepare-vegetation.sh (work/<dalle>/copc),
# les fichiers propres aux bâtiments sont dans work/<dalle>/buildings (supprimer work/ pour tout refaire).
set -eu
cd "$(dirname "$0")"
IMAGE=3dgi/roofer:v1.0.0
CONVERT=../buildings/cityjsonseq_to_bld.py
. ./lib.sh

set -- $(expand_tiles "$@")
mkdir -p served/buildings
for DALLE in "$@"; do
  echo "=== dalle $DALLE (bâtiments) ==="
  W=work/$DALLE
  mkdir -p $W/copc $W/buildings/out
  read -r X Y <<< "$(tile_origin $DALLE)"
  BBOX="$X $((Y - 1000)) $((X + 1000)) $Y"
  fetch_copc $DALLE $W/copc/$DALLE.copc.laz
  if [ ! -s $W/buildings/bdtopo.geojson ]; then
    echo "Emprises BD TOPO…"
    curl -fSL -o $W/buildings/bdtopo.geojson "$WFS_TILES?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=$X,$((Y - 1000)),$((X + 1000)),$Y,EPSG:2154"
  fi
  python3 -I - $W/buildings/bdtopo.geojson <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
n, m = len(d['features']), d.get('numberMatched')
print('BD TOPO : %d bâtiments (numberMatched %s)' % (n, m))
if m is not None and n != m:
    raise SystemExit('réponse WFS tronquée : %d sur %d bâtiments, voir scripts/city3d/buildings/README.md' % (n, m))
PY
  if ! ls $W/buildings/out/*.city.jsonl >/dev/null 2>&1; then
    echo "roofer ($IMAGE)…"
    # /data = work/<dalle>/buildings (roofer y écrit son journal), /copc = le nuage en lecture seule
    docker run --rm --user "$(id -u):$(id -g)" -w /data -v "$PWD/$W/buildings":/data -v "$PWD/$W/copc":/copc:ro "$IMAGE" \
      --box $BBOX --id-attribute cleabs /copc/$DALLE.copc.laz /data/bdtopo.geojson /data/out
  fi
  python3 -I "$CONVERT" $W/buildings/out/*.city.jsonl --tile $DALLE -o served/buildings/$DALLE.bld
done
echo "Prêt : $(ls served/buildings | tr '\n' ' '). Suite : python3 -I serve.py"
