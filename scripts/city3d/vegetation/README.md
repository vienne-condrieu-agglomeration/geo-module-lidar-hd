# Arbres 3D : pipeline PDAL → `.veg`

Prépare, hors du navigateur, les fichiers `<dalle>.veg` que le module lit quand le réglage `vegetationUrl` est renseigné
(format : `GUIDE-DEV.md`, section « Arbres »). Rien ici n'est exécuté par GEO ni livré dans le ZIP du module.

```
LiDAR HD (COPC, IGN) ── PDAL (Docker) ── 2 grilles de 1 m ── pack_veg.py ── <dalle>.veg ── fichiers statiques
                        classes 3 à 5 : altitude max          (sommet + base du houppier)
                        classe 5      : altitude min
```

PDAL est utilisé seulement pour lire les points classés « végétation » du nuage COPC de l'IGN, que l'on ne peut pas lire sans outil
spécialisé (format compressé). Il tourne à la préparation des fichiers, jamais dans le module. Image :
`pdal/pdal@sha256:3e38c3feaa100878a285a8dba721dea3995f335f2b70e930382586279e32e064` (PDAL 2.10.2, GDAL 3.13 inclus), ~4 Go sur
disque. Testée le 2026-11-13 ; le tag `latest` change, d'où l'empreinte.

## En pratique

Le plus simple : `scripts/city3d/www/prepare-vegetation.sh` (voir `scripts/city3d/www/README.md`), qui télécharge le nuage de la dalle si
besoin, lance les deux passes PDAL et empaquette :

```bash
cd scripts/city3d/www
./prepare-vegetation.sh around 0846-6494   # la dalle et ses 8 voisines ; ~30 s de PDAL par dalle (le COPC est partagé avec prepare-buildings.sh)
```

À la main, pour une dalle (ex. 0846-6494, coin nord-ouest en km Lambert-93 : x 846000-847000, y 6493000-6494000) :

```bash
# 1. sommet : altitude maximale des points de classes 3 à 5 (pipeline-top.json, voir le script pour le gabarit)
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/veg":/veg -v "$PWD/in":/in:ro "$PDAL_IMAGE" pdal pipeline /veg/top.json
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/veg":/veg "$PDAL_IMAGE" gdal_translate -q -of ENVI /veg/top.tif /veg/top.bin
# 2. base : altitude minimale des points de classe 5 (même chose avec base.json)
# 3. empaquetage
python3 -I pack_veg.py --tile 0846-6494 --top veg/top.bin --base veg/base.bin -o 0846-6494.veg
```

Pipeline de la bande « sommet » (celui de la « base » est identique avec `Classification[5:5]` et `"output_type": "min"`) :

```json
[
  { "type": "readers.copc", "filename": "/in/0846-6494.copc.laz", "bounds": "([846000, 847000], [6493000, 6494000])" },
  { "type": "filters.range", "limits": "Classification[3:5]" },
  { "type": "writers.gdal", "filename": "/veg/top.tif", "resolution": 1.0, "output_type": "max", "origin_x": 846000, "origin_y": 6493000,
    "width": 1000, "height": 1000, "data_type": "float32", "nodata": -9999, "dimension": "Z" }
]
```

PDAL n'accepte qu'un écrivain par pipeline (« Pipeline has multiple leaf nodes ») : d'où deux exécutions.

## Mesuré sur la dalle 0846-6494 (centre de Vienne)

- 40,6 millions de points lus ; ~13 s par passe PDAL ; `.veg` de 923 Ko (compressé), 418 076 cellules avec un sommet, 340 496 avec une base ;
- parmi les cellules du MNS encore à plus de 2 m du sol après masquage des bâtiments, 89,8 % contiennent au moins un point des classes 3 à 5 ;
- la base du houppier (classe 5) est connue pour 99,5 % des cellules de canopée ; médiane 1,7 m au-dessus du sol, houppier médian de 6,4 m d'épaisseur.

## Limites

- une base mesurée sur la classe 5 seule ne descend pas sous le seuil de cette classe : les troncs sont visibles à partir d'environ 1,5 m,
  jamais plus bas ; sans point de classe 5 (haie, arbuste), l'arbre n'a pas de tronc ;
- la qualité de la classification de la végétation du LiDAR HD n'a été examinée que sur cette dalle, et seulement par recoupement avec
  le MNS ; aucune vérité terrain ;
- seuls les feuillus et les haies de cette dalle ont été vus : pas de distinction résineux / feuillus.

## Tests

```bash
python3 -I -m unittest discover -s scripts/city3d/vegetation      # depuis la racine du module
python3 -I scripts/city3d/vegetation/make_fake_veg.py test/fixtures/fake.veg      # régénère le faux fichier de test
```

`test/fixtures/fake.veg` est un **faux** fichier (3 arbres, une haie, une pelouse sur 64 x 64 m), pas une vraie sortie de PDAL.
