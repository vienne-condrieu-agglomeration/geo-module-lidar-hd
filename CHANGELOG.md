# Journal des nouveautés

Toutes les évolutions notables du module « LiDAR HD 3D ». Le format suit
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le versionnement
[SemVer](https://semver.org/lang/fr/).

Ce fichier est affiché dans GEO, dans la fenêtre « Nouveautés » du module (bouton d'aide `?` de la vue 3D) :
il s'écrit pour les **utilisateurs**, en français, pas pour les développeurs (la liste des commits est dans
git). La version la plus récente publiée doit être celle de `package.json` et de `src/plugin.geoext.json`
(`npm test` le vérifie).

## [Non publié]

## [2.0.0] — 2026-11-18

Version majeure : le réglage « URL du décodeur laz-perf » du Générateur disparaît (voir « Supprimé »). Les autres réglages existants ne changent pas : tout le reste est ajouté ou facultatif.

### Ajouté

- Maquette : des bâtiments reconstruits en 3D (LoD2, toits en pente et murs droits) peuvent remplacer les bâtiments bruités
  du MNS. Une case « Bâtiments LoD2 » apparaît dans le panneau Maquette quand l'administrateur a renseigné le réglage
  « URL des données 3D de la ville » et laissé activé « Activer les bâtiments LoD2 » ; elle est absente sinon, et le module se comporte comme avant. Les bâtiments suivent le
  curseur (du terrain nu à la surface), le relief et « Animer ». Les murs sont gris, les toits portent l'orthophoto.
  Fonction en prototype : les fichiers sont préparés hors du module par l'intégrateur communautaire `geo-community-integrator-city3d`, une dalle sans fichier
  reste inchangée, et les bâtiments qu'on ne sait pas reconstruire restent tels que dans le MNS
- Maquette : les arbres peuvent remplacer les cônes de la végétation du MNS. Une case « Arbres » apparaît dans le panneau Maquette
  quand l'administrateur a renseigné le réglage « URL des données 3D de la ville » et laissé activé « Activer les arbres 3D » ; elle est absente sinon, et le module se comporte comme
  avant. Chaque arbre est un houppier arrondi sur un tronc, posé au sol, à la couleur de l'orthophoto ; les arbres suivent le curseur
  (ils poussent du terrain nu à la surface), le relief et « Animer ». Les arbres viennent des points classés « végétation » du
  LiDAR HD, préparés hors du module par l'intégrateur communautaire `geo-community-integrator-city3d`. Fonction en prototype : les formes sont des volumes simples, sans
  distinction entre résineux et feuillus, et une dalle sans fichier reste inchangée
- Données 3D de la maquette : l'adresse à saisir est celle du site qui les héberge (pour GitHub Pages, `https://<organisation>.github.io/<dépôt>`, et non celle du dépôt). Des fichiers prêts pour neuf dalles autour du centre de Vienne sont publiés par la bibliothèque : `https://vienne-condrieu-agglomeration.github.io/geo-community-data-city3d`. Le module lit l'`index.json` publié avec les fichiers, quand il existe, et ne demande que les dalles qu'il liste ; sans index il les essaie une à une, et un index d'un format inconnu désactive bâtiments et arbres au lieu de les lire de travers. Les fichiers sont relus en cas d'erreur réseau, 429, 502, 503 ou 504 (3 reprises à délai croissant), pour qu'une dalle ne manque pas au hasard quand le serveur répond un 503 sous rafale
- Orthophoto : la couche du WMS n'est plus imposée. Un nouveau réglage « Couche WMS d'orthophotos » du Générateur fixe la couche par défaut, et le panneau « Style » propose les autres couches du service (liste lue dans son GetCapabilities, limitée à celles qui servent EPSG:2154), ce qui permet d'utiliser par exemple le WMS du CRAIG ou un espace de travail GeoServer. Le choix est mémorisé par navigateur. Si l'orthophoto ne se charge pas (couche inconnue, projection non servie, service inaccessible), l'encart d'informations (« i ») s'ouvre et le dit, au lieu de laisser disparaître le mode « Orthophoto » sans explication. Le mode s'appelle désormais « Orthophoto » (et non « Orthophoto IGN »)
- Maquette : un bouton « Exporter » (ligne « Vidéo ») enregistre un tour complet autour d'un point et télécharge une vidéo MP4 (WebM si le navigateur n'a pas d'encodeur H.264), durée au choix : 10, 20 ou 30 s. Le point se choisit en cliquant sur la maquette (« Choisir le point ») ; un repère le montre, mais il n'apparaît pas dans la vidéo. Sans point choisi, la vidéo tourne autour du centre de la vue. Le réglage « Qualité » choisit la définition : « Full HD » (1920 px de large, par défaut), « Taille de la vue » ou « 4K » (3840 px). La vidéo est calculée image par image : elle fait toujours 30 images par seconde, fluide, quelle que soit la puissance du poste ; l'export est plus long sur un poste lent, et une barre de progression l'indique

### Modifié

- Générateur : les réglages sont répartis en quatre sections (« Données LiDAR HD », « Coloration par orthophoto (WMS) », « Maquette 3D », « Options du panneau »), et leurs descriptions suivent le même ordre : rôle, valeur par défaut (celle de l'IGN pour le WMS), contraintes. Un champ vidé reprend désormais la valeur de l'IGN (c'était déjà le cas partout sauf pour l'URL du WMS d'orthophotos, qui désactivait alors la coloration) ; la désactivation passe par une nouvelle case « Colorer par orthophoto », cochée par défaut. Une configuration déjà enregistrée avec une URL de WMS vide colore donc de nouveau les points avec le WMS de l'IGN : décocher la case pour l'éviter
- Les données LiDAR (plages COPC) et les rasters MNT / MNS / MNH sont désormais conservés par le navigateur (2 Go au plus, 7 jours) : recharger la page, rouvrir le panneau ou refaire un export ne retélécharge plus les dalles déjà vues. Avant, le cache ne vivait qu'en mémoire (vidé au rechargement de la page) et les rasters n'étaient jamais conservés. L'encart d'informations de la dalle (bouton « i ») indique la taille du cache et propose de le vider
- Le décodeur LAZ (laz-perf) est désormais embarqué dans le module : il n'est plus téléchargé depuis le CDN jsDelivr au démarrage, et le module fonctionne sur un poste sans accès à Internet public, hors services de l'IGN

### Corrigé

- Maquette : les dalles voisines se raccordent désormais quand on exagère le relief, sans fentes blanches entre elles
- Maquette : une dalle dont le relief n'a pas pu être lu au premier essai est relue automatiquement, au lieu de manquer dans la maquette

### Supprimé

- Le réglage « URL du décodeur laz-perf » du Générateur : le décodeur est embarqué dans le module. Une valeur déjà enregistrée est ignorée, sans erreur

## [1.1.2] — 2026-11-05

### Corrigé

- Documentation : liens du sommaire réparés sur le site de la bibliothèque de modules. Le module lui-même ne change pas

## [1.1.1] — 2026-11-05

### Modifié

- Documentation : un aperçu animé présente le module en tête du README. Le module lui-même ne change pas

## [1.1.0] — 2026-11-05

### Ajouté

- Projections : toutes les coniques conformes du RGF93 (CC42 à CC50) sont proposées avec Lambert-93 et WGS84, pour le
  pointage, l'export du terrain et le DXF 3D du profil. Le nouveau réglage « Projections proposées » du Générateur
  choisit la liste et son ordre. Le pointage donne aussi les coordonnées en WGS84, en degrés décimaux

### Modifié

- Export du terrain : la projection proposée d'abord est la première de la liste, donc Lambert-93 par défaut au lieu de
  CC45

## [1.0.0] — 2026-11-05

Première version publiée.

### Ajouté

- Visites guidées des outils Style, Filtres, Maquette, Profil et Terrain : un bouton `?` dans l'en-tête de leur panneau, ou « Visite guidée » dans
  le message de tracé, présente l'outil étape par étape. La visite ne se lance qu'à la demande et peut être quittée à
  tout moment, sans effet sur le travail en cours
- Profil : un bouton « Cadastre » affiche sur le graphique les limites de parcelles traversées (traits verticaux) et les
  longueurs situées dans un bâtiment (ruban au bas du graphique). Le curseur et les mesures s'accrochent à ces limites et aux bords de bâti. Il est désactivé par défaut et l'affichage
  reste à l'écran, hors des exports. Cadastre PCI Vecteur (DGFiP) diffusé par Etalab : tracé indicatif, sans valeur juridique

### Modifié

- Masquer le module ne fait plus perdre le travail : en le rouvrant, on retrouve les dalles chargées, le point de vue,
  les réglages, le profil et l'emprise, jusqu'au rechargement de la page. Un export en cours continue pendant le masquage.
  Le profil est recalculé au retour, et les tracés sont masqués sur la carte GEO tant que le module l'est
- Terrain : les exports du terrain et des points du nuage sont maintenant dans deux onglets. L'emprise et la projection
  restent au-dessus, communes aux deux, et le dernier onglet utilisé est retrouvé tant que la vue reste ouverte

## [0.28.0] — 2026-11-05

### Ajouté

- Profil : un bouton dans son en-tête l'agrandit sur toute la hauteur de la fenêtre du module, sous la barre d'outils,
  pour lire le graphique plus en détail. Le zoom et les mesures sont conservés, et l'image PNG exportée garde sa taille
  habituelle

## [0.27.1] — 2026-11-05

### Corrigé

- Fenêtre du module : elle ne défile plus verticalement, et la vue 3D ne se décale plus sous l'en-tête du panneau

## [0.27.0] — 2026-11-05

### Modifié

- Profil et Terrain : passer d'un outil à l'autre ne fait plus perdre le tracé. Un clic sur le bouton de l'outil le
  retrouve avec son panneau, tant que la vue reste ouverte, et annuler un nouveau tracé ramène à l'outil précédent.
  Le profil est recalculé à son retour. Un nouveau tracé passe par « Nouveau tracé » ou « Retracer l'emprise », et la
  croix du panneau efface le tracé. Un changement de dalle efface le profil en mémoire

## [0.26.0] — 2026-11-05

### Modifié

- Terrain : un clic sur le bouton lance directement le tracé de l'emprise sur la carte GEO, avec le même message
  d'aide que pour le profil. Le panneau d'export s'affiche une fois le polygone terminé. Abandonner un nouveau tracé
  rétablit l'emprise précédente
- Profil et Terrain : un seul de ces outils est actif à la fois. Ouvrir l'un ferme l'autre, avec son tracé ou son
  emprise. Le bouton Profil est indisponible pendant un export du terrain

## [0.25.3] — 2026-11-05

### Corrigé

- Barre d'outils : elle reste sur une seule ligne pendant le tracé d'un profil. Le bouton garde son libellé « Profil »

## [0.25.2] — 2026-11-05

### Corrigé

- Profil : les réglages et les boutons du bas du panneau restent sur une seule ligne, ce qui laisse plus de place au
  graphique. Quand la largeur manque, certains libellés s'effacent et restent disponibles dans les infobulles

## [0.25.1] — 2026-11-05

### Corrigé

- Dalles voisines : celles qui restaient invisibles jusqu'au prochain changement de point de vue doivent désormais
  s'afficher d'elles-mêmes. L'anneau du badge « i » attend la fin de ce contrôle, et l'infobulle signale une dalle
  restée sans point affiché

## [0.25.0] — 2026-11-05

### Ajouté

- Dalles voisines : un anneau bleu autour du badge « i » montre leur chargement en arrière-plan et se remplit à
  mesure qu'elles sont prêtes. Son infobulle indique l'avancement (« Dalles voisines : 3 / 8… ») et signale les
  dalles qui n'ont pas pu être chargées

## [0.24.1] — 2026-10-23

### Modifié

- Licence : le module est désormais publié sous GPL-3.0-or-later (code) et CC-BY-4.0 (documentation), à la place
  de l'AGPL-3.0. L'utilisation dans GEO ne change pas

## [0.24.0] — 2026-10-23

### Ajouté

- Fenêtre « Nouveautés » : le bouton d'aide `?` ouvre une fenêtre d'aide qui renvoie vers ce journal, avec
  un point rouge sur le bouton tant que la dernière version n'a pas été lue

## [0.23.0] — 2026-10-15

### Ajouté

- Export du terrain : option « Orthophoto » qui livre l'orthophoto IGN de l'emprise en GeoTIFF géoréférencés,
  dans la projection du DXF (CC45, CC46 ou Lambert-93), à 20 cm, 50 cm ou 1 m, dans une archive ZIP séparée.
  Le poids estimé est annoncé avant l'export, qui est bloqué au-delà de 3,5 Go

## [0.22.0] — 2026-10-15

### Ajouté

- Export du terrain : option « Cadastre » qui ajoute au DXF les parcelles, bâtiments, sections et numéros de
  parcelle du PCI Vecteur (Etalab), sur des calques dédiés, à l'altitude 0 ou au-dessus du terrain avec une
  surélévation réglable

## [0.21.1] — 2026-10-15

### Corrigé

- Les exports du terrain et des points du nuage partagent un seul panneau : le second cachait le bouton
  d'export DXF du premier

## [0.21.0] — 2026-10-15

### Modifié

- La fiche de la dalle est repliée par défaut et se déplie avec le bouton rond « i » en bas à gauche de la
  vue 3D ; le choix est mémorisé

## [0.20.1] — 2026-10-15

### Corrigé

- Carte GEO centrée dans la partie visible : le décalage est maintenant mesuré une fois le panneau en place

## [0.20.0] — 2026-10-15

### Ajouté

- À la réouverture du module, la dernière dalle consultée se recharge toute seule (jusqu'à 5 minutes après
  la fermeture), sans avoir à recliquer sur la carte

## [0.19.0] — 2026-10-15

### Modifié

- La carte GEO se recentre dans la partie restée visible quand le panneau en recouvre la droite

## [0.18.1] — 2026-10-15

### Modifié

- Les messages d'invitation, de chargement et d'erreur s'affichent dans une carte centrée de la vue 3D, avec
  icône et barre de progression, sans bloquer la souris

## [0.18.0] — 2026-10-15

### Ajouté

- Export des points du nuage en DXF sur la même emprise que le terrain : un calque par classe, classes à
  cocher, densité « 1 point sur N », même projection que le MNT

## [0.17.0] — 2026-10-15

### Ajouté

- La fiche de la dalle indique la période d'acquisition, la date de publication du nuage de points (dont
  dérivent le MNT et le MNS) et le code de mission

## [0.16.0] — 2026-10-13

### Ajouté

- Bouton « Voisines » dans la barre d'outils pour charger (ou retirer) les 8 dalles voisines, avant comme
  après le clic sur une dalle ; le choix est mémorisé et le réglage du Générateur sert de valeur par défaut

## [0.15.0] — 2026-10-12

### Ajouté

- Bouton « Maquette » : le terrain et la surface en maillage 3D habillé de l'orthophoto. Un curseur fait
  passer chaque sommet du terrain nu à la surface : bâtiments et arbres montent ou s'effacent
- Textures orthophoto, hauteur au sol ou grise ; relief de ×1 à ×3 ; ombrage ; bouton « Animer »

## [0.14.1] — 2026-10-12

### Modifié

- Panneau de profil réorganisé : informations en pastilles et bandeau de lecture à hauteur fixe, commandes
  regroupées sous le graphique, menu « Exporter » (PNG, CSV, DXF coupe, DXF 3D)

## [0.14.0] — 2026-10-12

### Ajouté

- Le profil trace le sol (MNT) et la surface (MNS) le long du tracé, avec une case pour les masquer
- Au survol : altitude du sol et de la surface, hauteur de la surface au-dessus du sol, hauteur du point
- La mesure à deux points donne la hauteur au-dessus du sol de chacun

## [0.13.2] — 2026-10-12

### Corrigé

- Le bouton d'export du terrain porte son libellé « Terrain »
- Les panneaux déroulants se placent sous la barre d'outils même quand elle passe sur deux lignes

## [0.13.1] — 2026-10-12

### Modifié

- Le panneau Filtres a deux onglets, « Altitude » et « Hauteur au sol » ; un point signale un filtre actif
- Les panneaux s'arrêtent à gauche de la barre de commandes au lieu de la recouvrir

## [0.13.0] — 2026-10-12

### Ajouté

- Mode de couleur « Hauteur au sol » (bleu, vert, jaune, rouge) avec légende et réglage de la hauteur du rouge
- Filtre « Hauteur au-dessus du sol », avec les préréglages « ≤ 2 m » et « > 2 m », pris en compte par le
  pointage et le profil

## [0.12.0] — 2026-10-12

### Ajouté

- L'emprise tracée pour l'export du terrain se retouche sur la carte : glisser un sommet, glisser un segment
  pour en ajouter un, Alt + clic pour en supprimer un ; dalles et taille estimée sont recalculées

## [0.11.2] — 2026-10-12

### Corrigé

- Pendant le tracé d'un profil ou d'une emprise, une couche grise sur la vue 3D indique de cliquer sur la
  carte GEO, à gauche du panneau (avec un bouton pour annuler) ; les clics ne déclenchent plus le pointage

## [0.11.1] — 2026-10-12

### Modifié

- Le bouton « Recadrer sur la dalle » rejoint les commandes de vue de la barre de droite

## [0.11.0] — 2026-10-12

### Ajouté

- Choix de la projection du « DXF 3D » du profil : Lambert-93 (par défaut), CC45, CC46 ou WGS84 ; le choix
  est mémorisé et figure dans le nom du fichier

## [0.10.0] — 2026-10-12

### Ajouté

- Bouton « Terrain » : on trace une emprise sur la carte GEO et le module exporte son MNT en DXF, en faces 3D
- Projection au choix (CC45, CC46, Lambert-93, WGS84), maillage de 50 cm, 1 m ou 2 m, estimation du nombre de
  faces et de la taille avant l'export, annulation possible

## [0.9.0] — 2026-10-12

### Ajouté

- Chargement en arrière-plan des 8 dalles voisines : on travaille d'emblée sur 9 dalles ; filtres, pointage et
  profil s'appliquent à l'ensemble, un profil peut traverser plusieurs dalles

## [0.8.0] — 2026-10-12

### Ajouté

- Pointage d'un point du nuage : un clic dans la vue 3D affiche son altitude, sa classe et ses coordonnées
  (Lambert-93, CC45 ou CC46), avec un repère sur la vue et sur la carte et un bouton « Copier »

## [0.7.0] — 2026-10-12

### Ajouté

- Profil : épaisseur du couloir réglable de 20 cm à 50 m, zoom à la molette, déplacement au glisser, « Vue
  entière », sommets du tracé déplaçables sur la carte, pente du terrain entre sommets
- Export DXF du profil : dessin de la coupe à l'échelle 1:1, ou points 3D géoréférencés avec un calque par classe
- Vue 3D : le volume du couloir à son épaisseur réelle autour du plan de coupe

## [0.6.5] — 2026-10-10

### Ajouté

- Bouton « Filtres » (tranche d'altitude, classes visibles, préréglages)
- Export du profil en PNG et en CSV ; plan de coupe, repères de survol et de mesure dans la vue 3D

## [0.6.4] — 2026-10-10

### Ajouté

- Filtre de tranche d'altitude à deux curseurs, appliqué au nuage et au profil ; préréglages de classes
  « Tout », « Sol seul », « Bâti », « Sans végétation »

## [0.6.3] — 2026-10-10

### Ajouté

- Profil en pleine densité : relecture des données du nuage sous le couloir, avec affinage progressif ;
  mesure de distance, dénivelé et pente sur le graphique

## [0.6.2] — 2026-10-10

### Ajouté

- Profil en polyligne : un clic par nœud, double-clic ou Entrée pour finir, Échap pour annuler

## [0.6.1] — 2026-10-10

### Modifié

- Boutons de commande modernisés : barres en verre dépoli, icônes Lucide, états actifs en bleu

## [0.6.0] — 2026-10-10

### Ajouté

- Profil en travers : tracé en deux clics sur la carte, graphique altitude / distance avec coloration par
  classe, altitude ou orthophoto, largeur réglable, échelle 1:1 et survol relié à la carte

## [0.5.0] — 2026-10-09

### Modifié

- Navigation 3D adaptée au trackpad : clic gauche pour pivoter, clic droit pour déplacer, zoom vers le
  curseur, flèches du clavier ; boutons à l'écran (zoom, pivoter, incliner, vue de dessus), mode « déplacer »
  et mode « défilement à deux doigts »
- Fenêtre d'aide à la navigation à la première ouverture (« Ne plus afficher » mémorisé)

## [0.4.0] — 2026-10-09

### Ajouté

- Orthophoto chargée par passes successives (1024, 2048 puis 4096 px) : disponible en quelques secondes, de
  plus en plus fine ; réglage du Générateur pour plafonner la résolution

## [0.3.1] — 2026-10-09

### Modifié

- L'orthophoto s'affiche beaucoup plus vite (demandée dès le choix de la dalle, en parallèle du nuage)

## [0.3.0] — 2026-10-09

### Ajouté

- Points colorés par l'orthophoto (le LiDAR HD n'a pas de couleur) ; fond clair par défaut
- Panneau « Style » : mode de couleur, forme, taille et atténuation des points, luminosité, opacité, budget de
  points, fond, visibilité par classe

## [0.2.0] — 2026-10-09

### Ajouté

- Progression du chargement : étape en cours, puis barre de progression

## [0.1.2] — 2026-10-09

### Corrigé

- Icône de l'en-tête du panneau centrée

## [0.1.1] — 2026-10-09

### Corrigé

- Taille de l'icône de l'onglet ajustée dans la barre latérale et dans l'en-tête du panneau

## [0.1.0] — 2026-10-09

Première version.

### Ajouté

- Un onglet de la barre latérale droite affiche en 3D le nuage de points LiDAR HD de la dalle IGN cliquée sur
  la carte, avec le marqueur et l'emprise de la dalle sur la carte GEO
