# Bâtiments LoD2 : pipeline roofer → `.bld`

Prépare, hors du navigateur, les fichiers `<dalle>.bld` que le module lit quand le réglage `city3dUrl` est renseigné (sous-dossier `buildings/`, interrupteur `buildingsEnabled`)
(format : `GUIDE-DEV.md`, section « Bâtiments LoD2 »). Rien ici n'est exécuté par GEO ni livré dans le ZIP du module.

```
LiDAR HD (COPC, IGN)  ─┐
                       ├─ roofer (Docker) ─ CityJSONSeq ─ cityjsonseq_to_bld.py ─ <dalle>.bld ─ fichiers statiques
BD TOPO bâtiments  ────┘
```

Versions et options vérifiées le 2026-11-13 avec l'image `3dgi/roofer:v1.0.0`
(`sha256:dd2c415aaee337502bde0dc1426dfa9c9f88e648f9d2f6340110c49932c251d2`). Le tag `latest` n'existe pas sur Docker Hub :
garder une version figée.

## 1. Données d'entrée (dalle 0846-6494)

Une dalle « XXXX-YYYY » est le coin nord-ouest en km (Lambert-93) : 0846-6494 couvre x 846000–847000, y 6493000–6494000.

```bash
mkdir -p roofer/in roofer/out && cd roofer

# Nuage de points : champ url_npl du WFS des dalles (IGNF_LIDAR-HD_METADONNEE:metadata), altitudes IGN69
curl -o in/0846-6494.copc.laz \
  "https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_OL_2025-02-20/LHD_FXX_0846_6494_PTS_LAMB93_IGN69.copc.laz"

# Emprises : BD TOPO (couche BDTOPO_V3:batiment du WFS de la Géoplateforme), en Lambert-93, au format GeoJSON
curl -o in/bdtopo.geojson \
  "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=846000,6493000,847000,6494000,EPSG:2154"
```

Le WFS peut limiter le nombre d'objets par réponse : contrôler que le nombre d'objets du fichier égale `numberMatched` (1 574
bâtiments pour cette dalle, obtenus en une requête). Si ce n'est pas le cas, paginer (`STARTINDEX`, `COUNT`) ou passer par un GeoPackage.
Lire directement le WFS depuis roofer (`WFS:https://…`) a été essayé : l'ouverture échoue dans l'image.

## 2. Reconstruction

```bash
docker run --rm --user "$(id -u):$(id -g)" -w /data -v "$PWD":/data \
  3dgi/roofer:v1.0.0 \
  --box 846000 6493000 847000 6494000 \
  --id-attribute cleabs \
  /data/in/0846-6494.copc.laz /data/in/bdtopo.geojson /data/out
```

- `--box xmin ymin xmax ymax` : région d'intérêt (ici la dalle) ; hors de cette région, les données sont ignorées ;
- `--id-attribute cleabs` : l'identifiant BD TOPO devient l'identifiant du bâtiment ;
- `--user` fait écrire les fichiers à votre nom (sinon ils appartiennent à root) ; avec `--user`, `-w /data` est indispensable : roofer écrit `roofer.log.json` dans le dossier courant et s'arrête sinon ;
- LoD 2.2 est la sortie par défaut (`--lod22`) ; classes LAS par défaut : 6 bâtiment, 2 sol (`--bld-class`, `--grnd-class`) ;
- `--srs EPSG:2154` n'est utile que si l'entrée n'a pas de projection déclarée ;
- sans `--tiling` (défaut), une seule sortie : `out/<xmin>_<ymin>.city.jsonl`.

Ne pas utiliser `--omit-metadata` : le convertisseur a besoin de la ligne `transform`.

Liste complète des options : `docker run --rm 3dgi/roofer:v1.0.0 --help-all` ; attributs de sortie : `… -a`.

## 3. Conversion

```bash
python3 -I ../scripts/city3d/buildings/cityjsonseq_to_bld.py out/*.city.jsonl --tile 0846-6494 -o 0846-6494.bld
```

Le script (bibliothèque standard seulement) dit ce qu'il ignore : bâtiments sans géométrie (roofer écrit `skip` quand le
nuage est insuffisant), bâtiments dont le centre est hors de la dalle, et il signale tout bâtiment sans surface
`GroundSurface` (écrit sans pieds de mur ni emprise : rien n'est deviné). Un bâtiment qui chevauche deux dalles appartient
à celle qui contient son centre et est dessiné en entier.

Publier ensuite les `.bld` à côté les uns des autres sur un serveur de fichiers statiques (CORS ouvert), nommés
`<dalle>.bld`, et renseigner l'URL du dossier parent (celui qui contient `buildings/`) dans le réglage `city3dUrl` du module.

## Exécution réelle (dalle 0846-6494)

Commandes ci-dessus exécutées telles quelles le 2026-11-13 : roofer lit le `.copc.laz` de la Géoplateforme, 1 574 emprises
dont 1 531 avec assez de points, durée 1 min 28 s sur 12 cœurs, sortie `out/846000_6493000.city.jsonl` (8 Mo).
Conversion : 1 471 bâtiments, 128 033 triangles, 1 468 emprises, `.bld` de 2,7 Mo, en 1 s.

## Ce qui a été observé de la sortie de roofer v1.0.0

- première ligne `{"type": "CityJSON", "transform": {scale, translate}, …}` puis un `CityJSONFeature` par bâtiment, avec
  des sommets entiers relatifs à ce `transform` (échelle 0,001 par défaut, translation = centre du jeu de données, z compris) ;
- `Building` (emprise LoD 0 en `MultiSurface`) avec un enfant `BuildingPart` portant une géométrie `Solid` de LoD `"2.2"` ;
- `semantics` : `GroundSurface`, `WallSurface`, `RoofSurface` ; les faces ont leurs trous (anneaux suivants : cour intérieure) ;
  l'ordre des faces varie (le sol peut être la première ou la dernière) ;
- le sol est plat (une seule altitude par bâtiment, `rf_h_ground`) : le module recale les pieds de mur sur le MNT ;
- un bâtiment dont le nuage est insuffisant n'a pas de `BuildingPart` (`rf_extrusion_mode: skip`) ; `lod11_fallback` = simple
  extrusion en toit plat.

## Tests

```bash
python3 -I -m unittest discover -s scripts/city3d/buildings      # depuis la racine du module
python3 -I scripts/city3d/buildings/make_fake_cityjsonseq.py test/fixtures/fake.city.jsonl      # régénère la fausse sortie
python3 -I scripts/city3d/buildings/cityjsonseq_to_bld.py test/fixtures/fake.city.jsonl --tile 0846-6494 -o test/fixtures/fake.bld
```

`test/fixtures/` contient :

- `fake.city.jsonl` : **fausse** sortie roofer, écrite à la main (toit à deux pans, bâtiment en L avec cour et toit à un
  pan, toit à quatre pans), à la structure de la vraie ; `fake.bld` en est la conversion ;
- `roofer-v1.0.0-synthetique.city.jsonl` : **vraie** sortie de roofer v1.0.0 sur un nuage et des emprises synthétiques
  (2 bâtiments, dont un avec cour ; roofer est retombé en toit plat). Elle fixe la structure observée.
