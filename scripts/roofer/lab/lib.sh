# Fonctions communes à prepare.sh (bâtiments) et prepare-veg.sh (végétation). À sourcer, pas à lancer.

WFS_TILES="https://data.geopf.fr/wfs/ows"

# expand_tiles ARGS... : "around XXXX-YYYY" donne la dalle et ses 8 voisines, sinon les dalles telles quelles (défaut 0846-6494).
# Le résultat (une dalle par mot) est écrit sur la sortie standard.
expand_tiles() {
  if [ "$#" -eq 0 ]; then set -- 0846-6494; fi
  if [ "$1" = around ]; then
    [ "$#" -eq 2 ] || { echo "usage : around XXXX-YYYY" >&2; return 2; }
    python3 -I - "$2" <<'PY'
import re, sys
m = re.fullmatch(r'(\d{4})-(\d{4})', sys.argv[1])
if not m: raise SystemExit('nom de dalle attendu « XXXX-YYYY »')
x, y = int(m.group(1)), int(m.group(2))
print(' '.join('%04d-%04d' % (x + dx, y + dy) for dy in (1, 0, -1) for dx in (-1, 0, 1)))
PY
  else
    echo "$@"
  fi
}

# tile_origin DALLE : écrit « X Y » du coin nord-ouest en mètres (Lambert-93).
tile_origin() { echo "$((10#${1%-*} * 1000)) $((10#${1#*-} * 1000))"; }

# fetch_copc DALLE DESTINATION : télécharge le nuage COPC de la dalle si DESTINATION n'existe pas. L'URL est le champ url_npl
# du WFS des dalles, interrogé au centre de la dalle.
fetch_copc() {
  local dalle=$1 dest=$2 x y url
  [ -s "$dest" ] && return 0
  read -r x y <<< "$(tile_origin "$dalle")"
  url=$(curl -fsS "$WFS_TILES?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0&TYPENAMES=IGNF_LIDAR-HD_METADONNEE%3Ametadata&OUTPUTFORMAT=application%2Fjson&SRSNAME=EPSG:2154&COUNT=1&BBOX=$((x + 500)),$((y - 500)),$((x + 500)),$((y - 500)),EPSG:2154" \
    | python3 -I -c "
import json, sys
f = json.load(sys.stdin)['features']
if not f: raise SystemExit('aucune dalle LiDAR HD ici')
p = f[0]['properties']
if p.get('coordonnees_nw') != '$dalle': raise SystemExit('le WFS renvoie la dalle %s, pas $dalle' % p.get('coordonnees_nw'))
print(p['url_npl'])")
  echo "Nuage de points (~290 Mo) : $url"
  mkdir -p "$(dirname "$dest")"
  curl -fSL -o "$dest.part" "$url" && mv "$dest.part" "$dest"
}
