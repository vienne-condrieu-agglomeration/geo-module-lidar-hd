#!/bin/bash
# Prépare bld/<dalle>.veg (canopée) pour une ou plusieurs dalles LiDAR HD : lecture du nuage COPC avec PDAL (Docker), puis
# empaquetage. Deux passes PDAL par dalle (PDAL n'accepte qu'un écrivain par pipeline) : sommet de la végétation (classes 3 à 5,
# altitude maximale) et base de la végétation haute (classe 5, altitude minimale), en grille de 1 m sur la dalle.
#
#   ./prepare-veg.sh                      dalle 0846-6494 (centre de Vienne)
#   ./prepare-veg.sh 0846-6494 0847-6494  les dalles données (nom « XXXX-YYYY » = coin nord-ouest en km, Lambert-93)
#   ./prepare-veg.sh around 0846-6494     la dalle et ses 8 voisines (9 dalles)
#
# Prérequis : docker, curl, python3. Par dalle : ~290 Mo à télécharger si ce n'est pas déjà fait (le COPC est partagé avec
# prepare.sh dans work/<dalle>/in), ~30 s de PDAL. L'image PDAL (~4 Go sur disque) est figée par son empreinte.
set -eu
cd "$(dirname "$0")"
PDAL_IMAGE="pdal/pdal@sha256:3e38c3feaa100878a285a8dba721dea3995f335f2b70e930382586279e32e064"   # PDAL 2.10.2 (testée le 2026-11-13)
PACK=../../vegetation/pack_veg.py
. ./lib.sh

# pdal_band DALLE X Y NOM LIMITES SORTIE : une passe PDAL (lecture COPC bornée à la dalle, filtre de classes, écriture d'une grille
# de 1 m : « max » ou « min » de Z) puis conversion en grille brute ENVI lue par pack_veg.py.
pdal_band() {
  local dalle=$1 x=$2 y=$3 name=$4 limits=$5 stat=$6 w=work/$1
  cat > $w/veg/$name.json <<JSON
[
  { "type": "readers.copc", "filename": "/in/$dalle.copc.laz", "bounds": "([$x, $((x + 1000))], [$((y - 1000)), $y])" },
  { "type": "filters.range", "limits": "$limits" },
  { "type": "writers.gdal", "filename": "/veg/$name.tif", "resolution": 1.0, "output_type": "$stat", "origin_x": $x, "origin_y": $((y - 1000)),
    "width": 1000, "height": 1000, "data_type": "float32", "nodata": -9999, "dimension": "Z" }
]
JSON
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/$w/veg":/veg -v "$PWD/$w/in":/in:ro "$PDAL_IMAGE" pdal pipeline /veg/$name.json
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/$w/veg":/veg "$PDAL_IMAGE" gdal_translate -q -of ENVI /veg/$name.tif /veg/$name.bin
}

set -- $(expand_tiles "$@")
mkdir -p bld
for DALLE in "$@"; do
  echo "=== dalle $DALLE (végétation) ==="
  W=work/$DALLE
  mkdir -p $W/in $W/veg
  read -r X Y <<< "$(tile_origin $DALLE)"
  fetch_copc $DALLE $W/in/$DALLE.copc.laz
  if [ ! -s $W/veg/top.bin ]; then pdal_band $DALLE $X $Y top "Classification[3:5]" max; fi
  if [ ! -s $W/veg/base.bin ]; then pdal_band $DALLE $X $Y base "Classification[5:5]" min; fi
  python3 -I "$PACK" --tile $DALLE --top $W/veg/top.bin --base $W/veg/base.bin -o bld/$DALLE.veg
done
echo "Prêt : $(ls bld | tr '\n' ' '). Suite : python3 -I serve.py"
