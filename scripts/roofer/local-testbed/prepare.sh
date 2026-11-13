#!/bin/bash
# Prépare bld/0846-6494.bld (dalle du centre de Vienne) : téléchargement, roofer (Docker), conversion.
# Prérequis : docker, curl, python3. Durée : ~2 min sur 12 cœurs + téléchargement de ~290 Mo. Relançable : les
# fichiers déjà présents dans work/ ne sont pas retéléchargés (supprimer work/ pour tout refaire).
set -eu
cd "$(dirname "$0")"
DALLE=0846-6494
BBOX="846000 6493000 847000 6494000"
IMAGE=3dgi/roofer:v1.0.0
COPC="https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_OL_2025-02-20/LHD_FXX_0846_6494_PTS_LAMB93_IGN69.copc.laz"
WFS="https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=846000,6493000,847000,6494000,EPSG:2154"
CONVERT=../cityjsonseq_to_bld.py

mkdir -p work/in work/out bld
[ -s work/in/$DALLE.copc.laz ] || { echo "Nuage de points (~290 Mo)…"; curl -fSL -o work/in/$DALLE.copc.laz.part "$COPC" && mv work/in/$DALLE.copc.laz.part work/in/$DALLE.copc.laz; }
[ -s work/in/bdtopo.geojson ] || { echo "Emprises BD TOPO…"; curl -fSL -o work/in/bdtopo.geojson "$WFS"; }
python3 -I - <<'PY'
import json
d = json.load(open('work/in/bdtopo.geojson'))
n, m = len(d['features']), d.get('numberMatched')
print('BD TOPO : %d bâtiments (numberMatched %s)' % (n, m))
if m is not None and n != m:
    raise SystemExit('réponse WFS tronquée : %d sur %d bâtiments, voir scripts/roofer/README.md' % (n, m))
PY

if ! ls work/out/*.city.jsonl >/dev/null 2>&1; then
  echo "roofer ($IMAGE)…"
  docker run --rm --user "$(id -u):$(id -g)" -w /data -v "$PWD/work":/data "$IMAGE" \
    --box $BBOX --id-attribute cleabs /data/in/$DALLE.copc.laz /data/in/bdtopo.geojson /data/out
fi

python3 -I "$CONVERT" work/out/*.city.jsonl --tile $DALLE -o bld/$DALLE.bld
echo "Prêt : bld/$DALLE.bld. Suite : python3 -I serve.py"
