// Données 3D de la ville (bâtiments LoD2 et arbres 3D) : lecture des réglages du Générateur.
//
// Un seul dossier de base (`city3dUrl`) contient un sous-dossier par fonction : <base>/buildings/<dalle>.bld et
// <base>/vegetation/<dalle>.veg. Deux interrupteurs (`buildingsEnabled`, `treesEnabled`) choisissent les fonctions proposées ;
// ils sont activés tant qu'ils ne sont pas décochés (une propriété absente compte comme activée, comme neighbourTiles).
// Ce fichier ne dépend pas du navigateur : il se teste sous Node (test/city3d.test.mjs).

// Renvoie { buildings, vegetation } : l'URL du dossier de chaque fonction, ou '' si elle est désactivée (base vide ou
// interrupteur décoché). Les espaces et les barres obliques finales de la base sont ignorés.
function city3dUrls(props) {
    var p = props || {}, base = p.city3dUrl ? String(p.city3dUrl).trim().replace(/\/+$/, '') : '';
    return {
        buildings: base && p.buildingsEnabled !== false ? base + '/buildings' : '',
        vegetation: base && p.treesEnabled !== false ? base + '/vegetation' : ''
    };
}

export { city3dUrls };
