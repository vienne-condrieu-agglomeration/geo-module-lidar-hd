# Essai local : bâtiments LoD2 et arbres 3D (centre de Vienne, dalle 0846-6494)

Prépare les fichiers de bâtiments (`.bld`) et de végétation (`.veg`) d'une ou plusieurs dalles et les sert en local avec CORS,
pour essayer les cases « Bâtiments LoD2 » et « Arbres » de la maquette dans un vrai GEO. Les deux fonctions ont chacune leur
préparation, leur dossier servi et leur URL ; elles ne se mélangent pas.

| | Bâtiments LoD2 | Arbres 3D |
|---|---|---|
| Outil de préparation | roofer (Docker) | PDAL (Docker) |
| Script | `prepare-buildings.sh` | `prepare-vegetation.sh` |
| Pipeline et format | [`../buildings/README.md`](../buildings/README.md), `GUIDE-DEV.md` « Bâtiments LoD2 » | [`../vegetation/README.md`](../vegetation/README.md), `GUIDE-DEV.md` « Arbres » |
| Fichiers servis | `served/buildings/<dalle>.bld` | `served/vegetation/<dalle>.veg` |
| Réglage du Générateur | `buildingsUrl` = `http://localhost:8777/buildings` | `vegetationUrl` = `http://localhost:8777/vegetation` |

## Contenu du dossier

```
www/
  prepare-buildings.sh    bâtiments : COPC + BD TOPO -> roofer -> served/buildings/*.bld
  prepare-vegetation.sh   végétation : COPC -> PDAL (2 passes) -> served/vegetation/*.veg
  lib.sh                  fonctions communes (liste de dalles, téléchargement du COPC)
  serve.py                serveur HTTP de served/ avec CORS (lecture seule, 127.0.0.1)
  README.md
  work/                   (ignoré par git) fichiers de travail
    <dalle>/copc/           le nuage COPC, partagé par les deux préparations
    <dalle>/buildings/      BD TOPO, sortie de roofer
    <dalle>/vegetation/     grilles PDAL
    logs/
  served/                 (ignoré par git) ce que le serveur expose
    buildings/              <dalle>.bld
    vegetation/             <dalle>.veg
```

Prérequis : `docker`, `curl`, `python3`, un accès à `data.geopf.fr` et à Docker Hub, ~290 Mo de COPC par dalle (~1 Go par dalle
avec les produits de roofer), plus 4 Go pour l'image PDAL si l'on prépare la végétation.

## 1. Préparer les fichiers

Les deux scripts prennent les mêmes arguments : aucune dalle (0846-6494), une liste de dalles « XXXX-YYYY » (coin nord-ouest en km,
Lambert-93), ou `around XXXX-YYYY` (la dalle et ses 8 voisines). Ils sont relançables : ce qui est déjà téléchargé ou calculé n'est
pas refait (supprimer `work/` pour tout refaire).

```bash
cd src/modules/geo-lidar-hd/scripts/city3d/www

./prepare-buildings.sh                       # la dalle 0846-6494 : ~2 min + ~290 Mo de COPC
./prepare-buildings.sh around 0846-6494      # + ses 8 voisines : ~15 min de roofer
./prepare-vegetation.sh                      # la dalle 0846-6494 : ~30 s si le COPC est déjà là
./prepare-vegetation.sh around 0846-6494     # ses 8 voisines : ~5 min
```

Résultats attendus sur la dalle 0846-6494 : environ 1 471 bâtiments et 128 000 triangles, un `.bld` d'environ 2,7 Mo (le résultat de
roofer varie un peu d'une exécution à l'autre) ; 3 399 arbres, un `.veg` de 923 Ko. Les lignes « ignorés » (bâtiments sans géométrie,
murs d'aire nulle) et « ATTENTION : 3 bâtiments sans GroundSurface » de la préparation des bâtiments sont normales : voir « Limites » du
GUIDE-DEV. Sur les 9 dalles de Vienne centre : 360 000 triangles de bâtiments (7,5 Mo de `.bld`) et 10,5 Mo de `.veg`.

## 2. Lancer le serveur

```bash
python3 -I serve.py            # port 8777 ; un autre port : python3 -I serve.py 9000
```

Le terminal affiche, pour chaque sous-dossier, le nombre de fichiers et le réglage à saisir. Le laisser ouvert pendant l'essai.
Contrôle depuis un autre terminal :

```bash
curl -sI http://localhost:8777/buildings/0846-6494.bld     # 200, Access-Control-Allow-Origin: *, ~2,7 Mo
curl -sI http://localhost:8777/vegetation/0846-6494.veg     # 200, ~0,9 Mo
```

## 3. Mettre le module dans GEO

```bash
cd ../../..                    # racine du module (src/modules/geo-lidar-hd)
npm run package                # build + ZIP daté
```

1. Générateur GEO, **ancienne interface** : Modules > + Module, importer le ZIP (nom daté, un ZIP déjà importé est refusé).
2. Dans la configuration du module, groupe « Données LiDAR HD », renseigner, selon ce que l'on essaie :
   - **URL des bâtiments LoD2 (prototype)** : `http://localhost:8777/buildings` (sans `/` final) ;
   - **URL de la végétation 3D (prototype)** : `http://localhost:8777/vegetation`.
3. Enregistrer et republier l'application.

Le navigateur qui ouvre GEO doit tourner **sur la machine où tourne `serve.py`** (`localhost` désigne le poste du navigateur).
Si GEO est en https, Chrome et Edge acceptent `http://localhost` ; Firefox peut le bloquer comme contenu mixte, ce qui se
verrait dans la console.

## 4. Essayer sur le centre-ville de Vienne

1. Ouvrir l'application GEO, ouvrir l'onglet **LiDAR HD**, centrer la carte sur le centre de Vienne (Isère) et cliquer dans la
   dalle **0846-6494** (environ x 846 000–847 000, y 6 493 000–6 494 000 en Lambert-93). Pour un point de contrôle : le secteur
   du théâtre antique et de la cathédrale Saint-Maurice est dans cette dalle.
2. Attendre l'affichage des points, puis ouvrir **Maquette** dans la barre d'outils.
3. Les cases **Bâtiments LoD2** et **Arbres** doivent être présentes (selon les réglages) et cochées. Les bâtiments apparaissent avec
   toits en pente et murs gris à la place des rampes ; les arbres, avec un houppier et un tronc, à la place des cônes de végétation.
   Décocher une case rend la maquette d'avant pour cette fonction.

Ce qu'il faut vérifier, et noter :

| À regarder | Attendu |
|---|---|
| Curseur 100 → 0, puis « Animer » | bâtiments et arbres s'aplatissent ou rétrécissent jusqu'au terrain nu, puis remontent |
| Relief ×3, texture « Hauteur au sol » / « Grise » | bâtiments et arbres suivent le relief et la texture choisis |
| Rues en pente | murs sans jour ni enfoncement visible au pied (le sol de roofer est plat, le pied est recalé sur le MNT) |
| Autour des bâtiments | pas de liséré de rampe gênant ; pas de morsure sur les trottoirs |
| Arbres | un arbre par houppier, tronc visible, couleurs plausibles ; pas de rampe de végétation résiduelle importante |
| Fluidité | rotation et zoom sans à-coups. Mesure : voir « Mesurer la fluidité » |
| Voisines (bouton « Voisines ») | seules les dalles ayant un fichier ont des bâtiments ou des arbres ; les autres restent comme avant, sans message |
| Profil et courbes | inchangés (le profil utilise le MNS d'origine, non masqué) |
| Réglage vide | pas de case correspondante, comportement identique à la 1.1.2 |

Console du navigateur (F12) : un fichier absent ne doit rien afficher ; une erreur affiche une seule ligne
`[geo-lidar-hd] bâtiments LoD2 de la dalle … ignorés (URL) : …` ou `[geo-lidar-hd] arbres de la dalle … ignorés (URL) : …`.
Onglet Réseau : un seul fichier en 200 par dalle et par fonction.

## Mesurer la fluidité

Avec « Voisines » activé et les 9 dalles servies, comparer **la case cochée puis décochée** (bâtiments, puis arbres), même vue,
même taille de panneau. Dans la console du navigateur (F12), coller le script ci-dessous, puis cliquer sur **Animer** aussitôt :
l'animation force un rendu à chaque image pendant 6 s, et le script compte les images dessinées.

```js
(function () {
  var n = 0, t0 = performance.now();
  (function f(t) { n++; if (t - t0 < 6000) { requestAnimationFrame(f); } else { console.log('images/s :', (n / ((t - t0) / 1000)).toFixed(1)); } })(t0);
})();
```

Noter le résultat avec la carte graphique du poste, et l'écart entre case cochée et décochée : il donne le coût de la fonction,
indépendamment de celui de la maquette. Mesure faite sur la dalle de Vienne et ses 8 voisines avec les bâtiments : 53,2 images par
seconde cochée contre 58,1 décochée ; non mesuré avec les arbres.

## En cas de problème

| Symptôme | Piste |
|---|---|
| Pas de case « Bâtiments LoD2 » ou « Arbres » | réglage vide ou ZIP ancien non remplacé ; republier l'application |
| Case présente, rien ne change, console « ignorés … Failed to fetch » | serveur arrêté, mauvaise URL (vérifier `/buildings` ou `/vegetation`), ou navigateur sur une autre machine |
| « … ignorés … origine … au lieu de … » | fichier produit pour une autre dalle que son nom |
| Murs mouchetés, bâtiments décalés, arbres mal placés | noter la capture et le niveau de zoom : défaut du rendu à corriger |
| `prepare-buildings.sh` : « réponse WFS tronquée » | le WFS a plafonné le nombre d'objets : paginer, voir `../buildings/README.md` |
| Docker : `permission denied` dans `work/` | un ancien passage en root a laissé des fichiers : `sudo rm -rf work/<dalle>/buildings/out` |
| `serve.py` ne voit plus les fichiers après un déplacement du dossier | relancer `python3 -I serve.py` depuis son nouvel emplacement |

Pour une autre dalle, passer simplement son nom aux scripts (`./prepare-buildings.sh 0847-6494`). L'URL du COPC est lue dans le WFS
des dalles ; une dalle absente du LiDAR HD arrête le script avec « aucune dalle LiDAR HD ici ».
