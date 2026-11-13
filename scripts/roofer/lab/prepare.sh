#!/bin/bash
# Prépare bld/<dalle>.bld pour une ou plusieurs dalles LiDAR HD : téléchargement, roofer (Docker), conversion.
#
#   ./prepare.sh                      dalle 0846-6494 (centre de Vienne)
#   ./prepare.sh 0846-6494 0847-6494  les dalles données (nom « XXXX-YYYY » = coin nord-ouest en km, Lambert-93)
#   ./prepare.sh around 0846-6494     la dalle et ses 8 voisines (9 dalles)
#
# Prérequis : docker, curl, python3. Par dalle : ~290 Mo à télécharger, ~1 min 30 de roofer sur 12 cœurs. Relançable :
# les fichiers déjà présents dans work/<dalle>/ ne sont pas retéléchargés (supprimer work/ pour tout refaire).
set -eu
cd "$(dirname "$0")"
IMAGE=3dgi/roofer:v1.0.0
CONVERT=../cityjsonseq_to_bld.py
. ./lib.sh

set -- $(expand_tiles "$@")
mkdir -p bld
for DALLE in "$@"; do
  echo "=== dalle $DALLE ==="
  W=work/$DALLE
  mkdir -p $W/in $W/out
  read -r X Y <<< "$(tile_origin $DALLE)"
  BBOX="$X $((Y - 1000)) $((X + 1000)) $Y"
  fetch_copc $DALLE $W/in/$DALLE.copc.laz
  if [ ! -s $W/in/bdtopo.geojson ]; then
    echo "Emprises BD TOPO…"
    curl -fSL -o $W/in/bdtopo.geojson "$WFS_TILES?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=$X,$((Y - 1000)),$((X + 1000)),$Y,EPSG:2154"
  fi
  python3 -I - $W/in/bdtopo.geojson <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
n, m = len(d['features']), d.get('numberMatched')
print('BD TOPO : %d bâtiments (numberMatched %s)' % (n, m))
if m is not None and n != m:
    raise SystemExit('réponse WFS tronquée : %d sur %d bâtiments, voir scripts/roofer/README.md' % (n, m))
PY
  if ! ls $W/out/*.city.jsonl >/dev/null 2>&1; then
    echo "roofer ($IMAGE)…"
    docker run --rm --user "$(id -u):$(id -g)" -w /data -v "$PWD/$W":/data "$IMAGE" \
      --box $BBOX --id-attribute cleabs /data/in/$DALLE.copc.laz /data/in/bdtopo.geojson /data/out
  fi
  python3 -I "$CONVERT" $W/out/*.city.jsonl --tile $DALLE -o bld/$DALLE.bld
done
echo "Prêt : $(ls bld | tr '\n' ' '). Suite : python3 -I serve.py"
