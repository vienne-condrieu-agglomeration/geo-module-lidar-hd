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
WFS_TILES="https://data.geopf.fr/wfs/ows"
CONVERT=../cityjsonseq_to_bld.py

if [ "$#" -eq 0 ]; then set -- 0846-6494; fi
if [ "$1" = around ]; then
  [ "$#" -eq 2 ] || { echo "usage : ./prepare.sh around XXXX-YYYY" >&2; exit 2; }
  set -- $(python3 -I - "$2" <<'PY'
import re, sys
m = re.fullmatch(r'(\d{4})-(\d{4})', sys.argv[1])
if not m: raise SystemExit('nom de dalle attendu « XXXX-YYYY »')
x, y = int(m.group(1)), int(m.group(2))
print(' '.join('%04d-%04d' % (x + dx, y + dy) for dy in (1, 0, -1) for dx in (-1, 0, 1)))
PY
)
fi

mkdir -p bld
for DALLE in "$@"; do
  echo "=== dalle $DALLE ==="
  W=work/$DALLE
  mkdir -p $W/in $W/out
  X=$((10#${DALLE%-*} * 1000)); Y=$((10#${DALLE#*-} * 1000))      # coin nord-ouest
  BBOX="$X $((Y - 1000)) $((X + 1000)) $Y"
  # URL du fichier COPC : champ url_npl du WFS des dalles, au centre de la dalle
  if [ ! -s $W/in/$DALLE.copc.laz ]; then
    COPC=$(curl -fsS "$WFS_TILES?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0&TYPENAMES=IGNF_LIDAR-HD_METADONNEE%3Ametadata&OUTPUTFORMAT=application%2Fjson&SRSNAME=EPSG:2154&COUNT=1&BBOX=$((X + 500)),$((Y - 500)),$((X + 500)),$((Y - 500)),EPSG:2154" \
      | python3 -I -c "
import json, sys
f = json.load(sys.stdin)['features']
if not f: raise SystemExit('aucune dalle LiDAR HD ici')
p = f[0]['properties']
if p.get('coordonnees_nw') != '$DALLE': raise SystemExit('le WFS renvoie la dalle %s, pas $DALLE' % p.get('coordonnees_nw'))
print(p['url_npl'])")
    echo "Nuage de points (~290 Mo) : $COPC"
    curl -fSL -o $W/in/$DALLE.copc.laz.part "$COPC" && mv $W/in/$DALLE.copc.laz.part $W/in/$DALLE.copc.laz
  fi
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
