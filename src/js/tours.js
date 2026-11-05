// Visites guidées par outil (Driver.js). Ce fichier ne contient que les étapes : le lancement est dans extension.js.
// Il ne dépend pas du navigateur : test/tours.test.mjs vérifie que chaque sélecteur existe encore dans le gabarit.
//
//   sel  : élément visé dans le module, ou MAP_TARGET pour la carte GEO
//   tab  : onglet du panneau à afficher avant l'étape (Terrain ou Filtres)
//   lazy : l'élément n'existe qu'une fois l'onglet affiché (ng-if) : l'étape est gardée sans vérification préalable
//   demo : réglages activés le temps de l'étape (Filtres), voir _filtersDemo dans extension.js
//   needs: donnée requise pour que l'élément apparaisse : 'alt' (altitude) ou 'ground' (MNT), sinon l'étape est ignorée
//   side : côté de la bulle ; les étapes dont l'élément est absent (ex. pendant un export) sont ignorées

var MAP_TARGET = '@map';

var DRAW_END = 'Double-clic ou Entrée pour terminer, Échap pour annuler.';

var TOURS = {
    profileDraw: [
        { sel: '.geo-lidar-drawcard', side: 'left', title: 'Tracer un profil en travers',
          text: 'Le profil est une coupe verticale du nuage de points le long d\'un tracé. La vue 3D est désactivée le temps de le dessiner.' },
        { sel: MAP_TARGET, side: 'right', title: 'Dessinez sur la carte GEO',
          text: 'Après cette visite, cliquez sur la carte pour poser chaque nœud du tracé. ' + DRAW_END },
        { sel: '.geo-lidar-tb--profile', side: 'bottom', title: 'Retrouver son profil',
          text: 'Ce bouton masque le profil sans le perdre, et le retrouve au clic suivant, même après un passage par Terrain.' }
    ],
    mntDraw: [
        { sel: '.geo-lidar-drawcard', side: 'left', title: 'Tracer l\'emprise à exporter',
          text: 'L\'outil Terrain exporte le sol ou les points du nuage sur une zone de votre choix. La vue 3D est désactivée le temps de la dessiner.' },
        { sel: MAP_TARGET, side: 'right', title: 'Dessinez sur la carte GEO',
          text: 'Après cette visite, cliquez sur la carte pour poser chaque sommet du polygone, au moins 3. ' + DRAW_END },
        { sel: '.geo-lidar-tb--terrain', side: 'bottom', title: 'Retrouver son emprise',
          text: 'Ce bouton masque le panneau sans perdre l\'emprise, et la retrouve au clic suivant, même après un passage par Profil.' }
    ],
    style: [
        { sel: '.geo-lidar-row--size', side: 'left', title: 'Forme et taille',
          text: 'Choisissez des points ronds ou carrés et leur taille à l\'écran. Des points plus gros comblent les trous, mais estompent les détails.' },
        { sel: '.geo-lidar-row--attenuated', side: 'left', title: 'Atténuation',
          text: 'Les points proches paraissent plus gros que les points lointains, entre une taille minimale et une taille maximale.' },
        { sel: '.geo-lidar-row--gamma', side: 'left', title: 'Gamma et luminosité',
          text: 'Ces deux réglages éclaircissent ou assombrissent les couleurs du nuage, si le rendu est trop sombre ou trop terne.' },
        { sel: '.geo-lidar-row--opacity', side: 'left', title: 'Opacité',
          text: 'Rend le nuage plus ou moins transparent.' },
        { sel: '.geo-lidar-row--sse', side: 'left', title: 'Seuil SSE',
          text: 'Niveau de détail chargé selon la distance. Une valeur basse charge plus de détails, mais demande plus de données. Une valeur haute allège l\'affichage.' },
        { sel: '.geo-lidar-row--budget', side: 'left', title: 'Budget de points',
          text: 'Nombre maximal de points affichés, pour l\'ensemble des dalles, en millions. Augmentez-le pour un rendu plus fin, baissez-le si le poste ralentit.' },
        { sel: '.geo-lidar-row--bg', side: 'left', title: 'Fond',
          text: 'Couleur de fond de la vue 3D, claire ou sombre.' }
    ],
    filters: [
        { sel: '.geo-lidar-panel--filters .geo-lidar-tabs', side: 'left', title: 'Filtres d\'affichage', demo: {},
          text: 'Ces filtres s\'appliquent à la vue 3D et au profil, sans rien modifier dans les fichiers. Cette visite les active pour vous les montrer, puis remet vos réglages à la fin. Un point sur un onglet signale un filtre actif.' },
        { sel: '.geo-lidar-row--f-alt', tab: 'alt', lazy: true, demo: { alt: true }, side: 'left', title: 'Filtrer par altitude',
          text: 'Une fois cette case cochée, seule une tranche d\'altitude NGF reste affichée.' },
        { sel: '.geo-lidar-row--f-altmin', tab: 'alt', lazy: true, needs: 'alt', demo: { alt: true }, side: 'left', title: 'Régler la tranche',
          text: 'Les curseurs Min et Max fixent cette tranche. « Tout afficher » remet les valeurs d\'origine.' },
        { sel: '.geo-lidar-row--f-hagcolor', tab: 'hag', lazy: true, demo: { hagColor: true }, side: 'left', title: 'Colorer par hauteur',
          text: 'Une fois cette case cochée, les points sont colorés selon leur hauteur au-dessus du sol. Elle est disponible une fois le MNT de la dalle chargé.' },
        { sel: '.geo-lidar-row--f-hagmax', tab: 'hag', lazy: true, needs: 'ground', demo: { hagColor: true }, side: 'left', title: 'Échelle de couleur',
          text: 'Ce curseur fixe la hauteur à partir de laquelle les points sont rouges.' },
        { sel: '.geo-lidar-row--f-hag', tab: 'hag', lazy: true, demo: { hag: true }, side: 'left', title: 'Filtrer par hauteur',
          text: 'Une fois cette case cochée, seule une tranche de hauteur au-dessus du sol reste affichée, réglée par les curseurs De et Jusqu\'à.' },
        { sel: '.geo-lidar-presets--hag', tab: 'hag', lazy: true, needs: 'ground', demo: { hag: true, hagPreset: 'high' }, side: 'left', title: 'Raccourcis de hauteur',
          text: 'Ils isolent les 2 premiers mètres, ou ce qui dépasse : canopée et toitures. Ici, « > 2 m » est appliqué.' },
        { sel: '.geo-lidar-presets--classes', demo: { classes: 'ground' }, side: 'left', title: 'Classes visibles',
          text: 'Ces raccourcis affichent toutes les classes, le sol seul, le bâti, ou tout sauf la végétation. Ici, « Sol seul » est appliqué.' },
        { sel: '.geo-lidar-classes--filters', demo: { classes: 'ground' }, side: 'left', title: 'Choisir les classes',
          text: 'Vous pouvez aussi cocher chaque classe une à une. À la fin de cette visite, vos réglages sont rétablis.' }
    ],
    maq: [
        { sel: '.geo-lidar-row--maq', side: 'left', title: 'Maquette 3D',
          text: 'Affiche le relief sous forme de surface pleine, d\'après les rasters MNT et MNS de l\'IGN, à la place du nuage de points. Cochez cette case pour accéder aux autres réglages.' },
        { sel: '.geo-lidar-maq-slider', side: 'left', title: 'Du terrain à la surface',
          text: 'Glissez le curseur : les bâtiments et les arbres montent depuis le terrain nu (MNT) jusqu\'à la surface (MNS).' },
        { sel: '.geo-lidar-presets', side: 'left', title: 'Raccourcis',
          text: 'Passez directement au terrain nu ou à la surface, ou lancez une animation entre les deux.' },
        { sel: '.geo-lidar-row--maq-tex', side: 'left', title: 'Texture',
          text: 'Habillez la maquette avec l\'orthophoto IGN, la hauteur au-dessus du sol, ou un gris qui fait ressortir le relief seul.' },
        { sel: '.geo-lidar-row--maq-relief', side: 'left', title: 'Relief',
          text: 'Exagère les altitudes jusqu\'à 3 fois, pour mieux voir les faibles reliefs. Les formes ne sont alors plus à l\'échelle.' },
        { sel: '.geo-lidar-row--maq-pts', side: 'left', title: 'Nuage de points',
          text: 'Garde le nuage affiché avec la maquette. Tant qu\'il est masqué, le pointage d\'altitude est indisponible, mais le profil reste utilisable.' }
    ],
    profile: [
        { sel: '.geo-lidar-profile-head', side: 'top', title: 'Résumé du profil',
          text: 'Le badge indique la précision : Aperçu avec les points déjà affichés, Affinage pendant la lecture du fichier, puis Pleine densité. À côté : longueur du tracé, nombre de points et altitudes.' },
        { sel: '.geo-lidar-profile-read', side: 'top', title: 'Lecture',
          text: 'Cette ligne donne les valeurs sous le curseur : distance, altitude, hauteur au-dessus du sol. Elle affiche aussi le résultat des mesures.' },
        { sel: '.geo-lidar-profile-plot', side: 'top', title: 'Graphique',
          text: 'Molette : zoomer (Maj pour la distance seule, Alt pour l\'altitude seule). Glisser : déplacer. En pleine densité, deux clics mesurent la distance, le dénivelé et la pente entre deux points.' },
        { sel: '.geo-lidar-opts-color', side: 'top', title: 'Couleurs',
          text: 'Colorez les points du graphique selon leur classe, leur altitude ou l\'orthophoto.' },
        { sel: '.geo-lidar-opts-width', side: 'top', title: 'Épaisseur',
          text: 'Largeur du couloir de points autour du tracé, visible en bleu sur la carte GEO. Plus elle est grande, plus la coupe contient de points, mais moins elle est nette.' },
        { sel: '.geo-lidar-tb--scale', side: 'top', title: 'Échelle 1:1',
          text: 'Même échelle en distance et en altitude : les bâtiments et les pentes ne sont pas déformés.' },
        { sel: '.geo-lidar-tb--curves', side: 'top', title: 'Courbes MNT et MNS',
          text: 'Ajoute les courbes du sol (MNT) et de la surface (MNS) d\'après les données de l\'IGN.' },
        { sel: '.geo-lidar-tb--cad', side: 'top', title: 'Cadastre',
          text: 'Affiche les limites de parcelles traversées et le bâti (ruban au bas du graphique). Le curseur et les mesures s\'y accrochent. Tracé indicatif, sans valeur juridique, et absent des exports.' },
        { sel: '.geo-lidar-opts-actions', side: 'top', title: 'Actions',
          text: 'Actualiser le profil d\'après les points affichés, dessiner un nouveau tracé, ou cadrer la vue 3D sur le plan de coupe.' },
        { sel: '.geo-lidar-menu-wrap', side: 'top', title: 'Exporter',
          text: 'Enregistrez le graphique en PNG, les points en CSV, la coupe ou les points en DXF.' },
        { sel: '[aria-label="Agrandir ou réduire le profil"]', side: 'bottom', title: 'Agrandir',
          text: 'Passe le profil sur toute la hauteur de la fenêtre pour lire le graphique plus en détail.' },
        { sel: MAP_TARGET, side: 'right', title: 'Modifier le tracé',
          text: 'Sur la carte GEO, glissez un nœud pour le déplacer ou un segment pour en ajouter un. Alt + clic supprime un nœud. Le profil est recalculé au relâcher.' }
    ],
    mnt: [
        { sel: '.geo-lidar-mnt-retrace', side: 'left', title: 'Emprise',
          text: 'Retracez la zone à exporter. Le résumé dessous donne sa surface et le nombre de dalles concernées.' },
        { sel: MAP_TARGET, side: 'right', title: 'Ajuster l\'emprise',
          text: 'Sur la carte GEO, glissez un sommet pour le déplacer ou un segment pour en ajouter un. Alt + clic supprime un sommet. Les estimations se mettent à jour.' },
        { sel: '.geo-lidar-row--crs', side: 'left', title: 'Projection',
          text: 'Elle s\'applique aux deux exports. Choisissez celle de votre logiciel de dessin.' },
        { sel: '.geo-lidar-panel--mnt .geo-lidar-tabs', side: 'left', title: 'Deux exports',
          text: 'Terrain (MNT) exporte le sol en faces 3D. Points du nuage exporte les points LiDAR. Chacun produit son propre fichier.' },
        { sel: '.geo-lidar-row--mesh', tab: 'mnt', side: 'left', title: 'Maillage',
          text: 'Taille des faces du terrain. Un maillage plus grossier donne un fichier bien plus léger. L\'estimation est affichée plus bas.' },
        { sel: '.geo-lidar-row--cad', tab: 'mnt', side: 'left', title: 'Cadastre',
          text: 'Ajoute au DXF les parcelles, les bâtiments, les sections et les numéros. Tracé indicatif, sans valeur de bornage.' },
        { sel: '.geo-lidar-row--ortho', tab: 'mnt', side: 'left', title: 'Orthophoto',
          text: 'Livre aussi l\'orthophoto IGN de l\'emprise en GeoTIFF géoréférencé. Indisponible en WGS84.' },
        { sel: '.geo-lidar-export--mnt', tab: 'mnt', side: 'left', title: 'Exporter le terrain',
          text: 'Lance l\'export. Il continue si vous masquez le module, et la progression reste visible dans le panneau.' },
        { sel: '.geo-lidar-classes--pts', tab: 'pts', side: 'left', title: 'Classes de points',
          text: 'Cochez les classes à exporter : un calque DXF est créé par classe.' },
        { sel: '.geo-lidar-row--thin', tab: 'pts', side: 'left', title: 'Densité',
          text: 'Allégez le fichier en ne gardant qu\'une partie des points. L\'estimation donne une taille maximale.' },
        { sel: '.geo-lidar-export--pts', tab: 'pts', side: 'left', title: 'Exporter les points',
          text: 'Lance l\'export des points cochés sur la même emprise, dans la même projection.' }
    ]
};

export { TOURS, MAP_TARGET };
