# Guide de développement de geo-lidar-hd

Fonctionnement interne, vérifications réalisées et pistes d'évolution. Pour l'utilisation et l'installation, voir le
[README](README.md).

## Sommaire

- [Particularités techniques](#particularités-techniques)
- [Cycle de vie et mémoire des outils](#cycle-de-vie-et-mémoire-des-outils)
- [Cadastre dans le profil](#cadastre-dans-le-profil)
- [Projections](#projections)
- [Visites guidées](#visites-guidées)
- [Dalles voisines (9 dalles)](#dalles-voisines-9-dalles)
- [Rendu](#rendu)
- [Bâtiments LoD2](#bâtiments-lod2)
- [Arbres](#arbres)
- [Navigation 3D](#navigation-3d)
- [Pointage dans le nuage](#pointage-dans-le-nuage)
- [Vérifications](#vérifications)
- [Journal des nouveautés](#journal-des-nouveautés)
- [Pistes d'évolution](#pistes-dévolution)

## Particularités techniques

- **Webpack 5**, contrairement aux autres modules (webpack 4) : iTowns et three sont en ESM pur avec un champ
  `exports`, que webpack 4 ne résout pas. `npm run build` enchaîne deux étapes : le worker LAZ
  (`webpack.worker.config.js` → `build/las-worker.js`), puis le bundle principal qui l'embarque en texte.
- Le worker est instancié depuis un Blob (`scripts/loaders/inline-worker-loader.js` réécrit
  `new Worker(new URL(...))` dans iTowns) : le ZIP ne contient qu'un seul `main.js` (~1,6 Mo).
  Le loader échoue volontairement si iTowns change ce motif : **iTowns est figé à 2.46.0**.
- `EPSG:2154` est enregistré sur l'unique copie de `proj4` embarquée (iTowns est consommé depuis `lib/`,
  pas depuis `dist/itowns.js`, qui contient sa propre copie de proj4).
- Le décodeur `laz-perf.wasm` est chargé par le navigateur depuis `lazPerfUrl` (CDN jsDelivr par défaut).
  Sur un poste sans accès Internet public, héberger `laz-perf@0.0.6/lib` en interne et régler cette clé.
- Pas de publication directe sur le serveur GEO (`npm run publish`) pour ce module : importer le ZIP à la main dans le Générateur.

## Cycle de vie et mémoire des outils

- **Module masqué** : GEO détruit le panneau et son scope. La vue n'est pas détruite : `_parkView` range son élément,
  canvas WebGL compris, dans un conteneur hors écran, et `_unparkView` le remet en place. L'ancien scope reste
  `_currentScope` pendant le masquage, pour recevoir les chargements et les exports en cours, et le nouveau reprend ses
  données à la réouverture. En cas de contexte WebGL perdu, la dernière dalle est rechargée (`_disposeParked`).
- **Mémoire des tracés** : `_suspendProfile` / `_restoreProfile` et `_suspendMnt` / `_restoreMnt`. Le profil est recalculé
  à son retour. `_drawReturn` donne l'outil à rétablir si un tracé est abandonné. La croix du panneau efface le tracé.
- **Fin du chargement des voisines** : une voisine compte comme chargée quand son nombre de points affichés ne bouge plus.
  Un recalcul complet est alors forcé, car des nœuds pouvaient rester masqués jusqu'au prochain déplacement de la caméra.
  La cause exacte de ce masquage n'a pas été établie.
- **Défilement** : le conteneur `.scroll-extension` de GEO débordait de 4 px, sans origine établie. Son défilement est
  coupé pour ce module seul (`.geo_lidar_hd`).

## Cadastre dans le profil

Les calculs sont dans `src/js/profile-cadastre.js`, sans dépendance au navigateur et testés par
`test/profile-cadastre.test.mjs` : limites traversées (`parcelLimits`), longueurs en bâtiment (`buildingSpans`), accroche du
curseur (`snapTargets`, `nearestSnap`). Les fichiers communaux d'Etalab sont gardés en mémoire (6 au plus, `_cadFiles`).
L'accroche ne porte que sur la distance : l'altitude reste celle du nuage à cet endroit, ou du MNT s'il n'y a pas de point.

## Projections

Le catalogue et la lecture du réglage `crsList` sont dans `src/js/crs.js`. `test/crs.test.mjs` compare chaque définition à
des valeurs de PROJ, au centimètre près. Pour ajouter une projection : compléter `CATALOG`, le tableau du README, la
description du réglage dans le manifeste et les valeurs de référence du test. Lambert-93 (dalles, calculs) et WGS84 (WFS,
carte) restent utilisés en interne, quelle que soit la liste. WGS84 a ses cas particuliers : orthophoto indisponible,
coordonnées en degrés. Le WMS de l'IGN accepte `EPSG:3942` à `EPSG:3950` (vérifié dans ses capacités le 2026-11-05).

## Visites guidées

Les étapes sont dans `src/js/tours.js`, et `test/tours.test.mjs` vérifie que les éléments visés existent dans le gabarit.
Le lancement est `_startTour`. Une étape dont l'élément est absent est ignorée. Le voile de Driver.js bloque les clics
pendant la visite, et les gestionnaires de clavier des tracés s'effacent pour qu'Échap ne ferme que la visite.
La visite des Filtres active réellement les réglages (`_filtersDemo`), puis rétablit l'état d'origine.

## Dalles voisines (9 dalles)

Une fois la dalle cliquée affichée (son streaming stabilisé), le module charge en arrière-plan les 8 dalles qui
l'entourent, soit 9 km² d'un seul tenant. Le bouton **Voisines** de la barre d'outils l'active ou le désactive, avant
comme après le clic sur une dalle : activé, il charge les voisines de la dalle affichée ; désactivé, il les retire et
ne garde que la dalle cliquée. Le choix est mémorisé dans le navigateur ; à défaut, c'est le réglage `neighbourTiles`
du générateur (activé par défaut) qui s'applique.

- une seule requête WFS (emprise de la dalle élargie de 500 m, en EPSG:2154) donne les voisines ; elles sont ajoutées une
  à une — d'abord les 4 qui partagent un côté, puis les coins — chacune dans sa propre couche COPC. En limite de
  couverture, seules les dalles existantes sont chargées (« + 5 dalles voisines (sur 8) ») ;
- **indicateur de chargement** : un anneau bleu autour du badge « i » se remplit à mesure que les voisines sont prêtes ; son
  infobulle donne l'avancement (« Dalles voisines : 3 / 8… ») et signale les dalles non chargées ;
- **budget de points partagé** : iTowns applique son budget par couche. Le sien est neutralisé et le module fait le même
  tri (nœuds d'octree les moins importants à l'écran masqués d'abord) sur les nœuds de toutes les dalles, juste avant le
  rendu (`_applyBudget`). Le budget réglé reste donc un total, quel que soit le nombre de dalles ;
- **orthophoto par dalle** : chaque couche a sa texture et son emprise. Les voisines s'arrêtent à 2048 px (8 textures de
  4096 px pèseraient ~500 Mo de mémoire graphique) ; une voisine dont l'orthophoto n'est pas encore arrivée reste en
  classification ;
- la tranche d'altitude prend les bornes de l'ensemble des dalles ; les classes, le style, le pointage et le profil
  (aperçu et pleine densité) portent sur toutes les dalles : un profil peut traverser une limite de dalle ;
- sur la carte GEO, les emprises des voisines sont tracées en pointillé fin. Cliquer dans une voisine en fait la nouvelle
  dalle centrale (les plages COPC déjà lues restent en cache mémoire, 250 Mo au plus, d'où un rechargement sans réseau).

## Rendu

Le LiDAR HD IGN est classifié mais sans RVB. Le mode par défaut « Orthophoto IGN » colore chaque point avec
l'orthophoto de la dalle (WMS `ORTHOIMAGERY.ORTHOPHOTOS`, par passes 1024, 2048 puis 4096 px, chacune remplaçant la précédente : un 4096 px coûte ~14 s au WMS, d'où l'affichage progressif), plaquée par un ajout au vertex shader
d'iTowns (`_patchOrthoShader`, désactivé automatiquement si le shader change). Le panneau « Style » reprend
les réglages de l'exemple iTowns (forme, taille et atténuation, gamma, opacité, seuil SSE, budget de points,
fond clair/sombre, visibilité par classe).

## Bâtiments LoD2

Prototype. La maquette (MNT + MNS) rend les bâtiments en rampes bruitées. Avec le réglage `buildingsUrl`, le module
superpose des bâtiments reconstruits par [roofer](https://github.com/3DBAG/roofer) (3DBAG), lus dans des fichiers statiques
`<dalle>.bld`, et retire les bâtiments du MNS. Sans le réglage, rien n'est chargé ni modifié.

**Pipeline** (hors navigateur, `scripts/city3d/buildings/README.md`) : nuage LiDAR HD (COPC) + emprises BD TOPO → roofer (Docker,
`3dgi/roofer:v1.0.0`) → CityJSONSeq → `scripts/city3d/buildings/cityjsonseq_to_bld.py` → un `.bld` par dalle. Mesuré sur la dalle
0846-6494 : roofer lit directement le `.copc.laz` et traite 1 531 bâtiments en 1 min 28 s ; la conversion prend 1 s et donne
un `.bld` de 2,7 Mo (1 471 bâtiments, 128 033 triangles).

**Format `.bld`** (little-endian, toutes les sections alignées sur 4 octets ; dalle « XXXX-YYYY » = coin nord-ouest en km
Lambert-93, origine locale = coin sud-ouest `(bbox[0], bbox[1])`, soit `(XXXX·1000, YYYY·1000 - 1000)`) :

| Section | Contenu |
|---|---|
| En-tête, 40 octets | `"BLD1"`, uint32 `nVerts`, `nIdx`, `nPolys`, `nRings`, `nPts`, float64 `originX`, `originY` (Lambert-93 de l'origine locale) |
| Positions | float32 × 3 × `nVerts` : x et y locaux à la dalle (m), z altitude NGF (m) |
| Indices | uint32 × `nIdx` : triangles déjà découpés, 3 indices chacun. Les faces de sol (GroundSurface) ne sont pas dessinées |
| Pieds de mur | uint8 × `nVerts` (1 = pied de mur, sommet du sol), complété à un multiple de 4 octets |
| Emprises | uint32 × `nPolys` : nombre d'anneaux de chaque polygone (le premier est extérieur, les suivants sont des trous) ; uint32 × `nRings` : nombre de points de chaque anneau ; float32 × 2 × `nPts` : x, y locaux, anneaux ouverts |

`parseBld` (`src/js/buildings.js`) refuse un fichier dont la signature, la taille ou les indices sont incohérents, et le module
ignore un fichier dont l'origine n'est pas celle de la dalle.

**Rendu** (`_startBuildings`, `_maquetteUpdate`) : par dalle, un `bldMesh` à côté de `maqMesh`, de même position, dont le
matériau partage les objets `uniforms` de la maquette (`mixT`, `exag`, `zRef`, `tTex`, `tInfo`, `oTex`, `useOrtho`,
`colorMode`, `hagMax`). Vertex shader `_BLD_VS` : un pied de mur prend l'altitude du MNT, les autres sommets vont de l'altitude
du MNT à celle du toit selon `mixT` (comme le MNS dans la maquette). Fragment `_BLD_FS` : celui de la maquette, avec les murs
(normale presque horizontale) grisés, et sans le retournement `n.z < 0` pour eux : leur `n.z` vaut 0 au bruit près et
l'éclairage devenait moucheté (défaut vu sur le banc d'essai).
**Masquage** : `maskSurface` (`buildings.js`) rastérise les emprises (trous compris) sur la grille du MNS, les élargit d'un
disque et renvoie une COPIE du MNS où ces cellules prennent l'altitude du MNT. La marge (`_BLD_MARGIN`, `marginFor`) vaut 1 m
jusqu'à 12 m de hauteur, puis 0,1 m de plus par mètre, au plus 3 m : la hauteur de chaque emprise est mesurée dans le MNS
(maximum de MNS - MNT sous l'emprise), le `.bld` ne la porte pas. Un grand bâtiment dépasse plus son emprise BD TOPO
(relevée au niveau du toit, avec ses contreforts) : sur la tour de 38 m du centre de Vienne, une marge fixe de 1 m laissait 81
cellules de rampe à plus de 15 m de haut, la marge variable en laisse 4, pour 10 000 cellules remplacées de plus sur la dalle
(+3,7 %) contre 80 000 de plus avec une marge fixe de 3 m. `surfGrid` reste
intact (le profil l'utilise) ; la texture est refaite quand la résolution du MNS ou du MNT change, quand les bâtiments arrivent
et quand la case est cochée ou décochée. Un fichier absent (404) ou invalide laisse la dalle comme sans le réglage.

**Ce que fournit roofer v1.0.0** (observé, y compris sur la dalle réelle) : première ligne `transform` (sans elle, par exemple
avec `--omit-metadata`, le convertisseur s'arrête) ; `Building` + `BuildingPart` portant un `Solid` de LoD `"2.2"` avec les
surfaces sémantiques `GroundSurface`, `WallSurface`, `RoofSurface` ; faces à trous (une face de toit réelle en a 10) ; sol plat
(`rf_h_ground`). Cas rencontrés sur la dalle : 65 bâtiments sans géométrie (`skip`, 4 %), 18 murs d'aire nulle (ignorés), 3
`BuildingPart` à coque ouverte sans face de sol (écrits sans pieds de mur ni emprise, signalés par le convertisseur, rien n'est
deviné). Un toit à deux pans n'a pas pu être obtenu sur des données synthétiques (roofer retombe en toit plat) ; les toits
en pente (`slanted`) viennent de la dalle réelle.

**Limites connues**

- les bâtiments `skip` ne sont pas dans le `.bld` : ils restent en rampes dans le MNS ; la végétation n'est pas traitée ;
- le sol de roofer est plat : sur une pente, les pieds de mur sont recalés sur le MNT (les murs s'allongent côté aval) ; le
  rendu sur forte pente n'a pas été examiné de près ;
- un bâtiment à cheval sur deux dalles appartient à celle qui contient son centre ; il est dessiné en entier, mais la dalle
  voisine ne le retire pas de son MNS ;
- le masque dépend de la maille du MNS (1 m puis 0,5 m) : un liséré de rampe peut subsister (quelques pointes fines au pied de la
  tour de 38 m malgré la marge variable), ou un trottoir être mordu ;
- un bâtiment dont l'emprise BD TOPO diffère de la réalité (construction récente ou démolie) est masqué d'après l'emprise ;
- une requête par dalle (pas de cache hors celui du navigateur). Mesuré sur la dalle centrale de Vienne et ses 8 voisines
  (Node, `maskSurface` à 1 m) : 360 113 triangles de bâtiments au total (128 000 pour la dalle centrale, 16 000 à 48 000 pour
  les autres), 7,5 Mo de `.bld`, 6,9 Mo de tampons de maillage, lecture 7 ms et masquage 183 ms pour les 9 dalles. Les
  bâtiments ajoutent environ 6 % de triangles à la maquette (terrain : environ 6 millions pour 9 dalles) et aucune texture
  de plus (la texture du MNS est remplacée, pas ajoutée) ; la fluidité vient donc surtout de la maquette elle-même. Les
  images par seconde n'ont été mesurées sur aucune carte graphique ;
- les altitudes de roofer sont celles du nuage (IGN69), comme le MNT : le module ne les recale pas.

## Arbres

Prototype. La végétation du MNS est dessinée en cônes bruités. Avec le réglage `vegetationUrl`, le module lit pour chaque dalle un
fichier `<dalle>.veg` (la canopée issue des points classés végétation du LiDAR HD), repère les arbres, retire la végétation de la copie
du MNS et dessine à la place un houppier et un tronc par arbre. Sans le réglage, rien n'est chargé ni modifié. La case « Arbres » du
panneau Maquette n'existe que si le réglage est renseigné.

**Pipeline** (hors navigateur, `scripts/city3d/vegetation/README.md`) : nuage COPC → PDAL (Docker, deux passes) → deux grilles de 1 m →
`scripts/city3d/vegetation/pack_veg.py` → un `.veg` par dalle (`scripts/city3d/www` enchaîne les étapes et sert les fichiers pour un essai local). Mesuré sur la dalle 0846-6494 : ~13 s par passe PDAL, 923 Ko par `.veg`.
PDAL ne sert qu'à lire les classes du COPC, que rien d'autre ne sait lire ici sans nouvelle dépendance ; roofer ne traite que les
bâtiments.

**Format `.veg`** (little-endian ; dalle « XXXX-YYYY » = coin nord-ouest en km Lambert-93) :

| Section | Contenu |
|---|---|
| En-tête, 48 octets | `"VEG1"`, uint32 `size` (cellules par côté), `bands`, `flags` (1 = charge utile compressée en deflate), float32 `step` (m), `zMin`, `zRes` (0,1 m), un réservé, float64 `originX`, `originY` (bord ouest et bord nord de la grille, Lambert-93) |
| Charge utile | `bands` x `size` x `size` uint16, ligne 0 au nord. Valeur 0 = pas de donnée, sinon altitude NGF = `zMin + (v - 1) * zRes`. Compressée en deflate (format zlib) si `flags & 1` |

Bande 0 : altitude maximale des points de classes 3 à 5. Bande 1 : altitude minimale des points de classe 5. D'autres bandes pourront
s'ajouter (`bands` est lu dans l'en-tête). `parseVeg` (`src/js/vegetation.js`) refuse un fichier dont la signature, l'en-tête ou la taille
sont incohérents, et le module ignore un fichier dont la grille n'est pas celle de la dalle (origine, 1000 m de côté).

**Détection** (`detectTrees`, testée dans `test/vegetation.test.mjs`) : une cellule est de la canopée si son sommet dépasse le MNT de
plus de 2 m ; hauteurs lissées (moyenne normalisée 3x3), cimes = maxima locaux sur 5x5 d'au moins 3 m ; rayon du houppier = distance
moyenne sur 8 directions jusqu'à ce que la canopée tombe sous la moitié de la cime (au plus 7 m), borné par 0,6 fois la distance à la
cime voisine ; base du houppier = bande 1 si elle existe, sinon le sol (pas de tronc). 3 399 arbres sur la dalle 0846-6494, 74 ms.
**Rendu** (`_TREE_VS`, `_TREE_FS`, `_maquetteUpdate`) : deux `InstancedMesh` par dalle (houppiers : icosphère aplatie ; troncs :
cylindre) dont les matériaux partagent les uniforms de la maquette ; le vertex shader pose chaque arbre au sol (MNT), le fait monter et
grossir avec le curseur (à 0, il a disparu), suit l'exagération du relief, et prend la couleur de l'orthophoto à son pied (éclaircie,
variation d'un arbre à l'autre). `removeCanopy` retire les cellules de canopée de la copie du MNS (après le masquage des bâtiments ; les
mailles du MNS et de la canopée peuvent différer). La texture est refaite à chaque passe de résolution du MNT ou du MNS. Un fichier
absent (404) ou invalide laisse la dalle comme sans le réglage.

**Limites connues**

- les formes sont des boules : pas de conifères, pas de haies continues (une haie de moins de 3 m d'épaisseur de canopée devient un
  alignement de petits arbres, sous 2 m elle n'est pas retirée) ;
- les cimes sont des maxima locaux : des houppiers qui se touchent peuvent être fusionnés ou doublés ; aucune vérité terrain ;
- la couleur vient de l'orthophoto au pied de l'arbre, parfois du sol (asphalte) et non du feuillage ;
- les 10 % de cellules hautes sans point de végétation (ponts, bâtiments non reconstruits) restent en rampes ;
- sans les bâtiments LoD2, une cellule où un arbre déborde sur un toit est retirée du MNS comme le reste de la canopée : le toit y
  perd sa rampe (avec les bâtiments, c'est le maillage LoD2 qui dessine le toit) ;
- une base mesurée sur la classe 5 seule limite les troncs à environ 1,5 m et plus ;
- l'image PDAL fait 4 Go ; le module lui-même n'en dépend pas ;
- performances : détection de ~3 400 arbres en 74 ms par dalle sous Node ; images par seconde non mesurées sur une carte graphique.

## Navigation 3D

Orbit (`OrbitControls` de three) autour du centre de la dalle : clic gauche = pivoter, clic droit ou Maj + gauche =
déplacer, molette ou pincement = zoom sur le curseur. Les flèches du clavier déplacent la vue. Pour les trackpads, des boutons à l'écran (zoom, pivoter,
incliner, vue de dessus), un bouton ✋ qui fait *déplacer* le centre de la vue par le glisser à un doigt (au lieu de pivoter) et un bouton ☝ qui fait pivoter la vue avec le défilement à deux doigts (le pincement
zoome toujours) ; ce choix est mémorisé dans le navigateur (`localStorage`, clé `geo-lidar-hd-wheel`).
Une fenêtre d'aide s'ouvre au premier affichage d'une dalle (bouton **?** pour la rouvrir) ; « Ne plus afficher » est
mémorisé dans la clé `geo-lidar-hd-help-dismissed`.

## Pointage dans le nuage

Un clic (sans glisser) sur un point de la vue 3D affiche son **altitude** (NGF), sa classe et ses **coordonnées** en
l'une des projections proposées (choix mémorisé dans `localStorage`, clé `geo-lidar-hd-pick-crs`), avec un bouton « Copier ».
Un repère orange marque le point dans la vue 3D et sur la carte GEO. Le pointage d'iTowns étant limité à 65 535 points,
le module projette lui-même à l'écran les points affichés (~20 ms pour 2 millions de points) et retient le plus proche de
la caméra à moins de 3 px du clic (6 px à défaut) ; les classes masquées et la tranche d'altitude sont respectées.
Le point retenu est un point du niveau de détail affiché : zoomer pour pointer plus finement.

## Vérifications

Les tests automatisés tournent en Chromium headless (WebGL logiciel) avec un `geoApplication` factice, et un vrai
AngularJS pour compiler le gabarit : bundle, worker Blob, WASM, EPSG:2154, chargement d'une dalle de 292 Mo
(WFS 200, Range 206, reprise sur 429), remplacement rapide de dalle, point hors couverture, orthophoto progressive,
panneau de style, navigation (glisser, boutons, molette, mode deux doigts, déplacement), aide.
Le module a aussi été essayé dans un vrai GEO (widget, élargissement du panneau, marqueur et emprise de la dalle,
indicateur de chargement, icône).
La version 0.7.0 a été vérifiée sur le même banc (OpenLayers 4.6.5, dalle 0846-6494) : zoom et déplacement du graphique,
couloir de 20 cm, déplacement d'un sommet, pentes, volume 3D, et les deux DXF relus par GDAL. Elle n'a pas encore été
essayée dans un vrai GEO, ni les DXF ouverts dans AutoCAD / Covadis.
La version 0.8.0 (pointage) a été vérifiée de la même façon : repère sous le curseur en vue oblique et de dessus, glisser
sans pointage, conversions CC45 / CC46 identiques à GDAL au centimètre. Le bouton « Copier » n'a pas été essayé (il demande
un contexte HTTPS).
La version 0.9.0 (dalles voisines) a été vérifiée sur le même banc : 8 voisines chargées et tracées sur la carte, total
affiché maintenu sous le budget (2 M puis 0,5 M) en vue oblique comme de dessus, orthophoto sur les 9 dalles, pointage dans
une voisine, profil à pleine densité à cheval sur une limite de dalle (points des deux côtés, couleurs d'orthophoto
continues), changement de dalle centrale en cliquant dans une voisine. Les 429 de data.geopf.fr (une vingtaine sur 400
requêtes) ont tous été rejoués avec succès. Non essayée dans un vrai GEO, ni en limite de couverture (moins de 8 voisines).
**Non vérifié** : le sens du défilement à deux doigts (bouton ☝) sur un vrai trackpad, une éventuelle CSP bloquant
les workers `blob:`, et le comportement avec une très mauvaise connexion.

Depuis, les fonctions ajoutées ont été essayées dans un vrai GEO au fil de leur développement : indicateur des voisines,
barres d'outils, tracé direct, mémoire des tracés, cadastre dans le profil, profil agrandi, onglets Terrain, conservation
de la vue et visites guidées. Le détail de ces essais n'a pas toujours été noté.

## Journal des nouveautés

`CHANGELOG.md` (Keep a Changelog, en français, pour les utilisateurs) est embarqué dans le module : le bouton d'aide `?` de la barre d'outils porte un point rouge
tant que la dernière version n'a pas été lue, et la fenêtre d'aide donne le lien « v… · Nouveautés » qui ouvre le journal. Les fichiers `src/js/changelog.js`,
`scripts/check-version.js` et `test/changelog.test.mjs` sont copiés du gabarit du dépôt d'origine (ne pas les modifier ici) ; le build étant en webpack 5, le
Markdown est chargé par `type: "asset/source"` (pas de `raw-loader`). `npm test` et `npm run package` vérifient que `package.json`, `src/plugin.geoext.json` et le
premier `## [x.y.z]` du journal portent la même version : les trois s'écrivent dans le même commit.

## Pistes d'évolution

Idées chiffrées à la louche (non réalisées), de la plus à la moins prioritaire. Estimations d'effort indicatives.

### Retours utilisateurs : avancement des lots

| Lot | Contenu | État |
|---|---|---|
| 1 | Profil : zoom, épaisseur dès 20 cm, sommets déplaçables, pentes, exports DXF, couloir en 3D | fait (0.7.0) |
| 2 | Pointage d'un point du nuage (altitude, classe, coordonnées L93 / CC45 / CC46) | fait (0.8.0) |
| 3 | 9 dalles : la dalle cliquée puis ses 8 voisines en arrière-plan | fait (0.9.0) |
| 4 | Socle MNT et export DXF du terrain en faces 3D | **codé, à essayer dans GEO** (voir ci-dessous) |
| 5 | Bassin versant, dans un module séparé (ex. `geo-bassin-versant`) qui réutilise le lecteur de MNT | à faire |
| — | Coloration par les orthophotos du CRAIG | en attente des dernières orthophotos |

### Lot 4 — socle MNT et export DXF en faces 3D (codé, à essayer dans GEO)

**Demande** : exporter en DXF le MNT d'une zone, en CC45 (ou au choix entre CC46, CC45 et Lambert-93), avec un maillage
pour n'avoir que des faces 3D, y compris quand la zone s'étend sur plusieurs dalles.

**Décisions prises**

- *Emprise* : dessinée au polygone sur la carte GEO, sans surface maximale imposée.
- *Résolution* : 50 cm, celle du MNT d'origine.
- *Projection* : choix entre CC45 (EPSG:3945), CC46 (EPSG:3946), Lambert-93 (EPSG:2154) et WGS84 (EPSG:4326) à l'export. En WGS84,
  X = longitude et Y = latitude en degrés (9 décimales), Z en mètres : peu adapté à AutoCAD / Covadis.
- *Maillage* : 50 cm (résolution du MNT), 1 m ou 2 m (nœuds multiples de 1 m ou 2 m, donc toujours alignés d'une dalle à l'autre).
- *Taille des fichiers* : à 50 cm, compter à la louche 1 à 2 Go de DXF par km². Pas de plafond : un avertissement indique
  la taille estimée avant l'export (choix par défaut, à confirmer).

**Contenu**

1. **Lecteur de MNT** : le WFS publie pour chaque dalle `url_mnt`, une requête WMS `GetMap` en GeoTIFF flottant
   (`CRS=EPSG:2154`, 2000 × 2000 px à 0,5 m, altimétrie IGN69, ~16 Mo). Il faut un lecteur GeoTIFF (ou un format de sortie
   plus simple si le WMS en accepte un, voir « Rasters MNS / MNT / MNH ») et le fetcher à concurrence limitée du module,
   data.geopf.fr répondant 429 au-delà d'un certain débit. Ce lecteur est le socle du lot 5 (bassin versant).
   **Fait** (`src/js/raster.js`, non encore branché sur l'interface) : le WMS accepte `FORMAT=image/x-bil;bits=32`, soit
   des flottants 32 bits bruts sans en-tête (octets identiques au GeoTIFF, vérifié), donc **aucune dépendance `geotiff`**.
   Lecture progressive 1 m (~4 Mo) puis 0,5 m (~16 Mo) via le fetcher à concurrence limitée, cache mémoire, trous en NaN,
   échantillonnage bilinéaire. Grille repérée par les centres de pixels (le BBOX du WFS est décalé de 0,25 m).
2. **Dessin de l'emprise** : polygone tracé sur la carte GEO (`ol.interaction.Draw`, comme le tracé du profil), avec la
   surface et la taille estimée du fichier affichées avant l'export.
3. **Assemblage multi-dalles** : recherche WFS des dalles touchées par le polygone, lecture de leurs MNT, grille continue
   d'une dalle à l'autre. Vérifié sur deux dalles voisines : les nœuds tombent sur une grille commune de 0,5 m (dernier
   nœud d'une dalle à x = 838999,5, premier nœud de la suivante à 839000,0), donc ni trou ni doublon aux jonctions, et
   les altitudes sont continues (écart de 1 à 15 cm au bord, dû au calcul indépendant des dalles).
4. **Maillage et écriture** : deux triangles par maille de 50 cm à l'intérieur du polygone, écrits en entités `3DFACE`
   (DXF ASCII R12, comme les exports du profil), reprojetés dans le système choisi, les cellules sans donnée étant
   ignorées. Écriture par morceaux pour ne pas tenir tout le fichier en mémoire.
5. **Choix de projection étendu au « DXF 3D » du profil** (fait).
6. **Export des points du nuage sur la même emprise** (0.18.0, codé, non essayé dans GEO) : second DXF d'entités `POINT`,
   un calque par classe (`LIDAR_CLASSE_xx`), même projection que le MNT. Classes à cocher (sol seul par défaut) et
   densité 1 point sur 1, 2, 5 ou 10. Chaque dalle est lue hors de la vue (couche COPC isolée), nœud par nœud, seuls
   les nœuds touchant l'emprise étant décodés ; écriture par morceaux. Estimation de taille : majorant toutes classes
   confondues, environ 95 octets par point.

**Points d'attention**

- Le MNT décrit le sol nu : ni bâti, ni ponts, ni tabliers.
- Un DXF de plusieurs gigaoctets peut dépasser ce qu'AutoCAD ou Covadis ouvrent confortablement ; l'avertissement de
  taille est là pour ça, et une résolution réduite en option serait un complément simple.
- À vérifier en fin de lot : relecture des DXF par GDAL, ouverture dans AutoCAD / Covadis, continuité aux limites de dalle.

**Réalisé** (bouton « Terrain » de la barre d'outils) : polygone tracé sur la carte, recherche WFS des dalles (millésime le plus
récent si plusieurs), alerte sur les dalles sans MNT, estimation du nombre de faces et de la taille, puis export. Une maille est
écrite si son centre est dans le polygone ; ses deux triangles suivent la diagonale la plus plate ; un triangle dont un sommet est
sans donnée est omis. Écriture en flux directement sur disque quand le navigateur offre `showSaveFilePicker` (Chrome, Edge), sinon
Blob assemblé en mémoire avec avertissement au-delà de 1,5 Go. Mémoire bornée : une à deux rangées de dalles de la bande courante.
Annulation possible en cours d'export. Vérifié en navigateur headless sur le vrai WFS / WMS : polygone sur 2 puis 4 dalles, en CC45,
WGS84 et Lambert-93, altitudes du DXF à 5 mm du raster d'origine, aucune face en NaN, raccord continu aux jonctions.
Le « DXF 3D » du profil propose le même choix de projection (point 5, mémorisé d'une session à l'autre, Lambert-93 par défaut) ;
vérifié sur un vrai profil : mêmes points dans les trois projections, à moins d'1 mm après retour en Lambert-93.
**Reste** : essai dans un vrai GEO (sélecteur de fichier, ouverture dans AutoCAD / Covadis, relecture GDAL).

**Effort estimé** : 2 à 3 jours.

### Profil en travers (demandé)

**Disposition du panneau** (0.14.1) : en-tête (titre, badge Aperçu / Pleine densité, pastilles Longueur · Points · Altitude),
puis un **bandeau de lecture de hauteur fixe** (le graphique ne bouge plus) qui affiche, selon le cas, les pastilles du
survol (distance, altitude et classe, hauteur au sol, sol, surface, hauteur de surface), celles de la mesure (distance,
dénivelé, pente, distance 3D, hauteurs de A et B) ou une consigne. Sous le graphique, une barre de contrôles : affichage à
gauche (Couleurs, Épaisseur, interrupteurs 1:1 et MNT / MNS), actions à droite (Actualiser, Nouveau tracé, Voir en 3D en
icônes, Arrêter pendant le calcul) et un menu **Exporter** (PNG, CSV, DXF coupe, DXF 3D avec sa projection). Les messages
d'état se posent au-dessus du panneau quelle que soit sa hauteur.

**État** : réalisé en deux temps.
- *Aperçu* (0.6.x) : bouton « Profil », tracé en polyligne sur la carte GEO (un clic par nœud, double-clic ou Entrée pour finir,
  Échap pour annuler), graphique calculé sur les points déjà affichés en 3D (couleurs classification / altitude / orthophoto,
  largeur réglable, échelle 1:1, survol relié à la carte).
- *Pleine densité* (0.6.3) : dès l'aperçu affiché, relecture des nœuds COPC qui touchent le couloir (parcours de l'octree en
  largeur, 4 nœuds en parallèle, plages mises en cache mémoire → un changement de largeur ne retélécharge presque rien). Le
  graphique s'affine au fil de l'eau (badge « Affinage n % » puis « Pleine densité », bouton « Arrêter »). Mesure par deux clics
  sur le graphique (distance le long du tracé, dénivelé, pente, distance 3D), réservée à la pleine densité. Les classes
  décochées dans le panneau Style masquent aussi les points du profil.
- *Retours utilisateurs* (0.7.0) :
  - épaisseur du couloir de **20 cm à 50 m** (curseur à paliers ; à 20 cm il reste ~2 points par mètre de tracé) ;
  - **zoom du graphique** : molette autour du curseur (Maj = distance seule, Alt = altitude seule), glisser pour déplacer,
    bouton « Vue entière » ; le PNG exporte la vue affichée ;
  - **sommets déplaçables** sur la carte GEO (`ol.interaction.Modify` : glisser un sommet, glisser un segment pour en insérer
    un, Alt + clic pour en supprimer un) ; le profil est recalculé au relâcher, sans recadrer la vue 3D ;
  - **pente du terrain entre sommets**, affichée en haut de chaque segment avec la corde correspondante. L'altitude du sol à un
    sommet est la médiane des points classés « sol » du couloir à moins de 25 cm le long du tracé (fenêtre élargie jusqu'à
    4 m) ; pas de pente si un sommet n'a pas de sol à proximité (eau, bâti, couloir très fin) ;
  - **export DXF** (ASCII R12, mètres) : « DXF coupe » = dessin distance / altitude à l'échelle 1:1 (calques `PROFIL_CADRE`,
    `PROFIL_TERRAIN` — médiane des points sol par pas de 25 cm —, `PROFIL_SOMMETS`, `PROFIL_PENTES`, `PROFIL_NUAGE` éclairci
    à 200 000 points) ; « DXF 3D » = points affichés dans la projection choisie (Lambert-93 par défaut, CC45, CC46 ou WGS84), altitude NGF, un calque par classe, plus le tracé.
- Limites : 1,5 M de points au plus par profil ; le décodage passe par le même worker que la vue 3D.
- Export : PNG du graphique ; CSV des points affichés (x, y en Lambert-93, altitude, distance, classe) ; DXF (voir ci-dessus).
  Fichiers suffixés `_pleine-densite` ou `_apercu`.
- Dans la vue 3D : plan de coupe sur l'axe du tracé (bleu franc) et volume translucide du couloir à son épaisseur réelle
  (arêtes plus claires), repère blanc au survol du graphique, repères et segment de la mesure. Le tracé recadre la caméra de côté ; bouton « Voir en 3D » pour recommencer. (iTowns désactive la mise à jour
  automatique des matrices de la scène : le module met à jour celles de son propre groupe.)
- Reste : mesures de surface.

Tracer une ligne (deux clics, éventuellement une polyligne) et afficher un graphique altitude / distance, points
colorés par classification ou orthophoto.

- **Tracé** : sur la carte GEO, par une interaction OpenLayers (`ol.interaction.Draw`) ; on a déjà accès à l'`ol.Map`
  (marqueur et emprise). Plus fiable que de pointer dans la 3D, où le pointage sur nuage d'iTowns est limité à moins de
  65 535 points. Un tracé direct dans la 3D reste possible ensuite.
- **Source des points** :
  - *points déjà chargés* : instantané, mais la résolution suit le niveau de détail courant (grossier en vue éloignée) ;
  - *relecture exacte du COPC* : `copc.js` permet de ne lire que les nœuds d'octree qui touchent le couloir, donc un
    profil à pleine densité pour un coût réseau modéré. Attention à la limitation de débit de l'IGN (429) : réutiliser
    le fetcher à concurrence limitée du module.
- **Contenu** : bande de largeur réglable (ex. ±5 m) autour de la ligne ; distance, dénivelé, pente ; survol qui
  localise le point sur la carte et dans la 3D ; export CSV / PNG.
- **Variante légère** : profil du terrain seul via le service d'altimétrie de l'IGN (ni bâti ni végétation).
- **Effort** : ~1 jour pour la version « points déjà chargés », ~2 jours pour la version exacte.
- **Décisions** (réponses du demandeur) :
  - *usage* : les deux. Un mode **rapide** (points déjà chargés, aperçu immédiat de la coupe) et un mode **exact**
    (relecture du COPC à pleine densité, pour les mesures), le second pouvant raffiner le premier sur la même vue ;
  - *tracé* : **sur la carte GEO** (`ol.interaction.Draw`), pas dans la 3D.
- **Conséquence de conception** : un seul graphique, alimenté d'abord par les points chargés puis remplacé par la
  version exacte quand elle arrive (même principe que l'orthophoto progressive), avec un indicateur du mode affiché
  (« aperçu » / « pleine densité »). Les mesures (distance, dénivelé, pente) ne sont proposées que sur la version exacte.

### Fort intérêt, effort modéré

- ~~**Filtre d'altitude / tranche**~~ *(fait)* : bouton « Filtres » de la barre du haut (devient bleu dès qu'un filtre est actif) →
  « Tranche d'altitude » (deux curseurs, bornes de la dalle), appliquée dans le vertex shader (points hors tranche transparents,
  comme les classes décochées) et au profil en travers ; classes visibles avec préréglages en un clic : Tout, Sol seul, Bâti
  (bâtiments + ponts), Sans végétation.
- **Outils de mesure** : distance, hauteur d'un bâtiment ou d'un arbre, surface. Même socle de pointage et de
  géométrie que le profil : à faire ensemble.
- ~~**Pointage d'un point**~~ *(fait, 0.8.0)* : voir « Pointage dans le nuage ».
- **Lien avec la carte GEO** : cône de la position et de l'orientation de la caméra 3D sur la carte ; recentrer la
  carte sur un point choisi en 3D ; recentrer le pivot de l'orbite sur un point cliqué (aujourd'hui : centre de la dalle).
- **Ombrage de profondeur (Eye-Dome Lighting)** : améliore beaucoup la lisibilité d'un nuage non coloré ; absent
  d'iTowns, petit développement shader.
- **Bornes du déplacement** autour de la dalle (aujourd'hui non bornées).

### Robustesse

- **Embarquer `laz-perf.wasm`** dans le bundle (~210 Ko) : plus de dépendance au CDN jsDelivr, utile en intranet
  (la clé `lazPerfUrl` pourrait alors servir de surcharge).
- **Cache des plages COPC** (API Cache du navigateur) : revenir sur une dalle sans retélécharger, moins de 429.

### Plus ambitieux

- ~~**Dalles voisines** : 3×3 avec budget de points partagé~~ *(fait, 0.9.0)* : voir « Dalles voisines (9 dalles) ».
- **Statistiques par classe** (surface bâtie, hauteur moyenne de la canopée).
- **Lien partageable** : dalle, caméra et style encodés dans une URL.
- **Capture PNG de la vue** ; **export du sous-nuage** découpé (le plus lourd).
- ~~**Colorisation par hauteur au-dessus du sol**~~ *(fait)* : mode « Hauteur au sol » du sélecteur Couleurs, voir la section « Rasters MNS / MNT / MNH » ci-dessous.

### Rasters MNS / MNT / MNH (idées, non réalisées)

Le flux WFS de chaque dalle publie, en plus du COPC (`url_npl`), trois rasters dérivés du même nuage LiDAR HD, donc
parfaitement superposables aux points :

| Champ | Contenu | 
|---|---|
| `url_mns` | modèle numérique de **surface** (sol + bâti + végétation) |
| `url_mnt` | modèle numérique de **terrain** (sol nu) |
| `url_mnh` | modèle numérique de **hauteur** = MNS − MNT |

Ce sont des requêtes WMS `GetMap` (`FORMAT=image/geotiff`, `CRS=EPSG:2154`) sur l'emprise de la dalle : **2000 × 2000 px à
0,5 m**, altimétrie IGN69, soit ~16 Mo par raster en flottant 32 bits. Aucun n'est utilisé aujourd'hui.

**À savoir avant de s'y mettre**
- *Volume et débit* : passe rapide à 1 m (`WIDTH=HEIGHT=1000`, ~4 Mo) puis pleine résolution, comme l'orthophoto progressive ;
  même limitation de débit (429) que le reste de data.geopf.fr, donc réutiliser le fetcher à concurrence limitée.
- *Lecture* : le GeoTIFF flottant demande un lecteur (`geotiff`, ~100 Ko) ; vérifier d'abord quels formats le WMS accepte
  (une sortie plus simple à décoder, ex. `image/x-bil;bits=32`, éviterait la dépendance).
- *Utilisation GPU* : les rasters deviennent une texture flottante échantillonnée dans le vertex shader d'iTowns, comme
  l'orthophoto (`_patchOrthoShader`) ; prévoir `OES_texture_float_linear` ou un filtrage `Nearest`.
- *Effets de bord* : ombres, crue et vue sont faussées près du bord de la dalle sans les dalles voisines (voir « Dalles voisines »).
- Le MNT n'a pas les ponts, tabliers ni le bâti ; il décrit le sol, pas la route circulée.

**Idées, de la plus rentable à la plus spectaculaire** (efforts indicatifs)

1. ~~**Profil en travers : courbes MNT et MNS**~~ *(fait, 0.14.0)* : case « Courbes MNT / MNS » (cochée par défaut) sous le
   graphique. Le MNS des dalles touchées par le tracé est lu à la demande (1 m puis 0,5 m) et le MNT des dalles voisines
   est affiné à 0,5 m. Sol en orange, surface en bleu clair (liseré sombre pour rester lisibles sur les points), voile entre
   les deux ; l'échelle englobe les courbes. Au survol : altitude du sol (MNT), de la surface (MNS) et hauteur de la surface
   au-dessus du sol (« faîtage : 11,4 m »), même sans point proche ; avec un point : sa hauteur au-dessus du sol. La
   mesure à deux points donne aussi la hauteur de chacun. L'export « DXF coupe » ajoute les calques PROFIL_MNT et PROFIL_MNS.
   Détail de la tâche d'origine : Le sol et la surface s'affichent tout de suite en courbes continues,
   avant même les points, puis les points s'affinent autour. Le survol et la mesure donnent la **hauteur au-dessus du sol**
   (ex. « faîtage : 11,4 m »). S'appuie sur l'échantillonnage le long du tracé déjà fait pour le profil.
2. ~~**Hauteur au-dessus du sol dans la vue 3D**~~ *(fait, 0.13.0)* :
   le MNT de chaque dalle (1 m puis 0,5 m pour la dalle cliquée, 1 m pour les voisines) devient une texture flottante
   échantillonnée dans le vertex shader à la position XY de chaque point (`texelFetch`, plus proche maille ; trous = -99999,
   le point reste affiché). Tout se règle dans le panneau Filtres, qui a deux onglets : **Altitude** (tranche d'altitude
   NGF) et **Hauteur au sol**, avec la case « Colorer » (rampe bleu → vert → jaune → rouge, légende en bas à gauche, curseur
   « Rouge à », 30 m par défaut ; le menu Couleurs affiche alors « Hauteur au sol ») et la case « Filtrer » (de -2 m à la
   hauteur max, préréglages « ≤ 2 m », « > 2 m »), suivie par le pointage et par le profil. Un point bleu sur l'onglet signale
   un filtre ou la coloration actifs. Les panneaux s'arrêtent à gauche de la barre verticale de commandes. Précision : coordonnées monde en
   float32 dans le shader (~0,25 m en Y), sans effet visible hors pentes très raides. Détail de la tâche d'origine :
   - *colorisation par hauteur* (arbres de plus de 15 m, toitures…) ;
   - *filtre de hauteur au sol*, qui remplace avantageusement l'altitude absolue du filtre actuel sur un terrain en pente
     (« enlever la canopée », « ne garder que les 2 premiers mètres ») ; même mécanisme que l'orthophoto plaquée.
3. ~~**« Déshabiller la ville »**~~ *(fait, 0.15.0)* : bouton **Maquette** de la barre du haut. Un maillage régulier par dalle
   (1 m pour la dalle cliquée, 2 m pour les voisines), en coordonnées locales à la dalle, dont les altitudes sont lues dans le
   vertex shader depuis deux textures flottantes (MNT et MNS) : un uniforme fait glisser chaque sommet du terrain nu (0) à la
   surface (1), donc sans recalcul côté processeur. Habillage : orthophoto, rampe de hauteur au sol ou gris (relief seul),
   ombrage par dérivées de la position (soleil au nord-ouest), relief ×1 à ×3, bouton « Animer » (aller-retour en 6 s). Le
   nuage de points est masqué par défaut (case « Nuage de points » pour le garder) ; le pointage d'altitude est alors
   indisponible, le profil reste utilisable. Les panneaux Style, Filtres et Maquette s'excluent ; la maquette reste affichée
   quand son panneau se ferme (point bleu sur le bouton). Détail de la tâche d'origine :
   Maillage 3D du MNS ou du MNT habillé de l'orthophoto, affiché en quelques secondes
   (le nuage complet met plusieurs dizaines de secondes) ; un curseur glisse du terrain nu à la surface, bâtiments et arbres
   montent ou s'effacent. Sert aussi de repli sur poste modeste.
4. **Simulation de crue** (~2 à 3 j). Clic sur un point d'eau (le Rhône) + niveau réglable ; remplissage du MNT par
   propagation depuis ce point (pas un simple plan d'eau horizontal). À présenter comme simulation simplifiée, pas comme
   de l'hydraulique ; attention aux ponts absents du MNT et aux effets de bord de dalle.
5. **Ombres et ensoleillement** (~2 à 3 j). Curseur d'heure et de date, ombres portées calculées sur le MNS ; en cumulant
   sur l'année, un **potentiel solaire des toitures**. Le plus parlant en urbanisme (covisibilité, ombres, cadastre solaire) ;
   modèle d'irradiation à rester simple et à présenter comme tel.
6. **Autres pistes** : ligne de vue / zone visible depuis un point sur le MNS ; statistiques par dalle (hauteur moyenne de la
   canopée, emprise bâtie) à partir du MNH ; alignement des points avec le MNT pour détecter des artefacts.

**Ordre conseillé** : 2 (fait) puis 1 — la hauteur au sol corrige un vrai défaut du filtre d'altitude et les courbes du profil
l'améliorent immédiatement — puis 3, qui réutilise les mêmes rasters ; 4 et 5 ensuite, après les dalles voisines.

### Priorité recommandée

Fait : profil en travers (aperçu, pleine densité, polyligne, mesure, zoom, sommets déplaçables, pentes, exports PNG / CSV /
DXF, volume du couloir en 3D), filtres d'altitude et de classes. Suite conseillée : rasters MNS / MNT / MNH (hauteur au sol, puis courbes du profil), puis dalles voisines, puis
`laz-perf.wasm` embarqué et cache de plages disque (reporté pour l'instant : utile surtout si les serveurs GEO n'ont pas
d'accès sortant vers le CDN jsDelivr).
