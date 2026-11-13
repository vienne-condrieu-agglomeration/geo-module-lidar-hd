#!/usr/bin/env python3
"""Fabrique un FAUX fichier .veg pour les tests (sans PDAL) : dalle 0846-6494 réduite à 64 x 64 cellules de 1 m.

    python3 -I make_fake_veg.py SORTIE.veg

Trois arbres isolés (houppiers en demi-ellipsoïde, base à 2 m, 6 m et 3 m du sol), une haie (ligne de 20 m de long, 2,5 m de
haut) et quelques cellules basses (pelouse, 0,5 m) qui ne doivent pas devenir des arbres. Le sol est à 100 m NGF (plat).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # -I n'ajoute pas le dossier du script
import pack_veg  # noqa: E402

SIZE = 64
GROUND = 100.0
# (colonne, ligne, rayon m, hauteur m, hauteur de la base m)
TREES = [(16, 16, 4.0, 10.0, 2.0), (44, 20, 3.0, 8.0, 3.0), (30, 46, 5.0, 14.0, 6.0)]


def build():
    top = [None] * (SIZE * SIZE)
    base = [None] * (SIZE * SIZE)
    for ci, cj, r, h, hb in TREES:
        for j in range(SIZE):
            for i in range(SIZE):
                d = math.hypot(i - ci, j - cj)
                if d <= r:
                    k = j * SIZE + i
                    top[k] = max(top[k] or -1e9, GROUND + hb + (h - hb) * (0.35 + 0.65 * math.sqrt(max(0.0, 1 - (d / r) ** 2))))
                    base[k] = GROUND + hb
    for i in range(8, 28):   # haie : 2 m de haut, sans base (classe 5 absente)
        for j in (56, 57):
            top[j * SIZE + i] = GROUND + 2.5
    for j in range(2, 6):    # pelouse : 0,5 m
        for i in range(40, 60):
            top[j * SIZE + i] = GROUND + 0.5
    return top, base


def main(out):
    top, base = build()
    blob = pack_veg.pack([top, base], SIZE, 1.0, (846000.0, 6494000.0))
    with open(out, 'wb') as fh:
        fh.write(blob)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage : make_fake_veg.py SORTIE.veg')
    main(sys.argv[1])
