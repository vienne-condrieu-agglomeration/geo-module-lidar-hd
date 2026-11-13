#!/usr/bin/env python3
"""Empaquette les grilles de canopée produites par PDAL en fichier « .veg » lu par le module geo-lidar-hd.

    python3 -I pack_veg.py --tile 0846-6494 --top top.bin --base base.bin -o 0846-6494.veg

Entrées : deux grilles flottantes brutes (ENVI, float32 little-endian, ligne 0 au nord, `size` x `size` cellules de 1 m sur
la dalle) produites par PDAL puis `gdal_translate -of ENVI` (voir README.md) :
- `--top`  : altitude NGF maximale des points des classes 3 à 5 (végétation) par cellule ;
- `--base` : altitude NGF minimale des points de classe 5 (végétation haute) par cellule.
Les cellules sans point valent -9999. Format décrit dans GUIDE-DEV.md (section « Arbres »). Bibliothèque standard seulement.
"""
import argparse
import re
import struct
import sys
import zlib

MAGIC = b'VEG1'
HEADER = struct.Struct('<4sIIIffffdd')   # magic, size, bands, flags, step, zMin, zRes, réservé, originX, originY
FLAG_DEFLATE = 1
Z_RES = 0.1          # résolution de l'altitude stockée (m) : uint16 = (z - zMin) / zRes + 1, 0 = pas de donnée
NODATA_BELOW = -500  # en dessous : pas de donnée (PDAL écrit -9999)


def tile_bbox(name):
    """Dalle « XXXX-YYYY » = coin nord-ouest en km (Lambert-93) -> [xmin, ymin, xmax, ymax]."""
    m = re.fullmatch(r'(\d{4})-(\d{4})', name or '')
    if not m:
        raise ValueError('nom de dalle attendu « XXXX-YYYY » (ex. 0846-6494), reçu : %r' % name)
    x, y = int(m.group(1)) * 1000, int(m.group(2)) * 1000
    return [x, y - 1000, x + 1000, y]


def read_grid(path, size):
    """Lit une grille ENVI float32 little-endian de size x size valeurs ; renvoie une liste (None = pas de donnée)."""
    with open(path, 'rb') as fh:
        raw = fh.read()
    if len(raw) != 4 * size * size:
        raise SystemExit('%s : %d octets au lieu de %d (grille %d x %d attendue)' % (path, len(raw), 4 * size * size, size, size))
    vals = struct.unpack('<%df' % (size * size), raw)
    return [v if v > NODATA_BELOW else None for v in vals]


def pack(bands, size, step, origin, compress=True):
    """bands : liste de grilles (listes de float ou None). Renvoie les octets du fichier .veg."""
    zs = [v for b in bands for v in b if v is not None]
    z_min = (min(zs) - 1.0) if zs else 0.0
    z_min = float(struct.unpack('<f', struct.pack('<f', z_min))[0])   # la valeur écrite est celle utilisée pour quantifier
    payload = bytearray()
    for b in bands:
        q = [0 if v is None else min(65535, int(round((v - z_min) / Z_RES)) + 1) for v in b]
        payload += struct.pack('<%dH' % len(q), *q)
    body = zlib.compress(bytes(payload), 9) if compress else bytes(payload)
    head = HEADER.pack(MAGIC, size, len(bands), FLAG_DEFLATE if compress else 0, step, z_min, Z_RES, 0.0, origin[0], origin[1])
    return head + body


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--tile', required=True, help='dalle « XXXX-YYYY » (coin nord-ouest en km, Lambert-93)')
    ap.add_argument('--top', required=True, help='grille ENVI de l\'altitude maximale de la végétation')
    ap.add_argument('--base', required=True, help='grille ENVI de l\'altitude minimale de la végétation haute')
    ap.add_argument('--size', type=int, default=1000, help='cellules par côté (défaut 1000, soit 1 m)')
    ap.add_argument('-o', '--output', required=True, help='fichier .veg à écrire')
    args = ap.parse_args(argv)
    try:
        bbox = tile_bbox(args.tile)
    except ValueError as e:
        ap.error(str(e))
    top, base = read_grid(args.top, args.size), read_grid(args.base, args.size)
    step = (bbox[2] - bbox[0]) / args.size
    blob = pack([top, base], args.size, step, (float(bbox[0]), float(bbox[3])))
    with open(args.output, 'wb') as fh:
        fh.write(blob)
    n_top = sum(v is not None for v in top)
    n_base = sum(v is not None for v in base)
    sys.stderr.write('%s : %d cellules avec sommet, %d avec base, %d octets\n' % (args.output, n_top, n_base, len(blob)))
    if n_top == 0:
        sys.stderr.write('ATTENTION : aucune cellule de végétation (dalle sans classe 3-5, ou grille vide)\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
