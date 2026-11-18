# city3d : la ville en 3D pour la maquette

> **Repris dans l'intégrateur `src/integrators/city3d`** (dépôt GitHub `geo-community-integrator-city3d`, commande `integrator_city3d.py`), qui remplace les scripts `prepare-*.sh` et produira les fichiers pour GitHub Pages. Ce dossier reste inchangé jusqu'à la validation de l'intégrateur, puis sera supprimé du module. Les formats restent décrits dans `GUIDE-DEV.md`.

Outils hors navigateur qui préparent les fichiers statiques lus par le panneau Maquette du module (bâtiments LoD2 et arbres 3D), et
de quoi les essayer en local. Rien ici n'est exécuté par GEO ni livré dans le ZIP du module.

| Dossier | Contenu |
|---|---|
| [`buildings/`](buildings/README.md) | bâtiments LoD2 : sortie CityJSONSeq de roofer -> `<dalle>.bld` (`<city3dUrl>/buildings/`) |
| [`vegetation/`](vegetation/README.md) | arbres 3D : grilles de canopée de PDAL -> `<dalle>.veg` (`<city3dUrl>/vegetation/`) |
| [`www/`](www/README.md) | essai local : scripts `prepare-buildings.sh` et `prepare-vegetation.sh` qui enchaînent téléchargement, outil et conversion, et `serve.py` qui sert `served/buildings` et `served/vegetation` avec CORS |

Un seul réglage de base du module, `city3dUrl`, désigne le dossier qui contient `buildings/` et `vegetation/` ; deux interrupteurs
(`buildingsEnabled`, `treesEnabled`, activés par défaut) choisissent les fonctions proposées. Les formats, le rendu et les limites sont décrits dans `GUIDE-DEV.md` (sections « Bâtiments LoD2 » et « Arbres »).
