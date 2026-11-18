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

// Adresse de l'index publié avec les fichiers (<base>/index.json, écrit par l'intégrateur city3d), ou '' si la base est vide.
function city3dIndexUrl(props) {
    var p = props || {}, base = p.city3dUrl ? String(p.city3dUrl).trim().replace(/\/+$/, '') : '';
    return base ? base + '/index.json' : '';
}

var INDEX_FORMAT = 1;   // version du format de l'index que ce module sait lire (champ `format`)

// Lit l'index. Renvoie { status, ... } :
//   'ok'          buildings / vegetation : tables { <dalle>: true } des dalles qui ont le fichier ;
//   'unsupported' le champ `format` n'est pas celui que ce module connaît : les données ne doivent pas être lues ;
//   'invalid'     pas un index exploitable : on revient à l'essai fichier par fichier.
function parseCity3dIndex(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.dalles || typeof data.dalles !== 'object') {
        return { status: 'invalid', reason: 'index illisible' };
    }
    if (data.format !== INDEX_FORMAT) {
        return { status: 'unsupported', reason: 'format ' + JSON.stringify(data.format) + ' non pris en charge (attendu ' + INDEX_FORMAT + ')' };
    }
    var buildings = Object.create(null), vegetation = Object.create(null);
    Object.keys(data.dalles).forEach(function (tile) {
        var e = data.dalles[tile] || {};
        if (e.batiments && typeof e.batiments.fichier === 'string') { buildings[tile] = true; }
        if (e.vegetation && typeof e.vegetation.fichier === 'string') { vegetation[tile] = true; }
    });
    return { status: 'ok', buildings: buildings, vegetation: vegetation };
}

// fetch avec reprises : erreur réseau et réponses 429 / 502 / 503 / 504 sont rejouées à délai croissant (GitHub Pages renvoie des 503 sans
// en-tête CORS sous rafale : le navigateur les voit comme une erreur réseau). Les autres réponses (200, 404…) sont rendues telles quelles.
// opts : tries (4 par défaut), sleep(ms) -> Promise (injectable pour les tests).
function fetchRetry(fetchFn, url, opts) {
    var o = opts || {}, tries = o.tries || 4;
    var sleep = o.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    function delay(n, r) {
        var h = r && r.headers && r.headers.get && parseFloat(r.headers.get('retry-after'));
        return h > 0 ? Math.min(h, 30) * 1000 : 400 * Math.pow(2, n) + Math.random() * 250;
    }
    function attempt(n) {
        return fetchFn(url).then(function (r) {
            if ((r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) && n < tries - 1) {
                return sleep(delay(n, r)).then(function () { return attempt(n + 1); });
            }
            return r;
        }, function (err) {
            if (n < tries - 1) { return sleep(delay(n)).then(function () { return attempt(n + 1); }); }
            throw err;
        });
    }
    return attempt(0);
}

export { city3dUrls, city3dIndexUrl, parseCity3dIndex, fetchRetry };
