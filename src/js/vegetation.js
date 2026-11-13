// Arbres 3D (fichiers « .veg », voir GUIDE-DEV.md) : lecture, détection des arbres et retrait des cônes du MNS.
//
// Ce fichier ne dépend ni du navigateur, ni d'iTowns, ni de three : il se teste sous Node (test/vegetation.test.mjs).
// Les fichiers sont produits par scripts/vegetation/pack_veg.py (little-endian, charge utile compressée en deflate).

var MAGIC = 0x31474556;   // « VEG1 » lu en little-endian
var HEADER_BYTES = 48;
var FLAG_DEFLATE = 1;

// Inflate d'un tampon deflate (format zlib) avec DecompressionStream, disponible dans les navigateurs récents et sous Node.
function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') { return Promise.reject(new Error('DecompressionStream indisponible : navigateur trop ancien')); }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(stream).arrayBuffer();
}

// Lit un fichier .veg. Renvoie une Promise de :
//   size, step, bands   nombre de cellules par côté, taille d'une cellule (m), nombre de bandes
//   x0, y0              bord ouest et bord nord de la grille, en Lambert-93
//   z(band, k)          altitude NGF de la bande `band` (0 = sommet de la végétation, 1 = base de la végétation haute) à la cellule
//                       k = ligne * size + colonne (ligne 0 au nord), NaN sans donnée
function parseVeg(buffer) {
    if (!buffer || buffer.byteLength < HEADER_BYTES) { return Promise.reject(new Error('fichier .veg trop court')); }
    var dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== MAGIC) { return Promise.reject(new Error('fichier .veg : signature « VEG1 » absente')); }
    var size = dv.getUint32(4, true), bands = dv.getUint32(8, true), flags = dv.getUint32(12, true);
    var step = dv.getFloat32(16, true), zMin = dv.getFloat32(20, true), zRes = dv.getFloat32(24, true);
    var x0 = dv.getFloat64(32, true), y0 = dv.getFloat64(40, true);
    if (!(size > 0 && size <= 8192 && bands >= 1 && bands <= 16 && step > 0 && zRes > 0)) {
        return Promise.reject(new Error('fichier .veg : en-tête invalide'));
    }
    var expected = 2 * bands * size * size;
    var body = new Uint8Array(buffer, HEADER_BYTES);
    var raw = (flags & FLAG_DEFLATE) ? inflate(body) : Promise.resolve(body.slice().buffer);
    return raw.then(function (payload) {
        if (payload.byteLength !== expected) {
            throw new Error('fichier .veg : taille inattendue (' + payload.byteLength + ' octets au lieu de ' + expected + ')');
        }
        var q = new Uint16Array(payload);
        return {
            size: size, step: step, bands: bands, x0: x0, y0: y0,
            z: function (band, k) { var v = q[band * size * size + k]; return v ? zMin + (v - 1) * zRes : NaN; }
        };
    });
}

// Altitude du sol au point (x, y) en Lambert-93 : bilinéaire, pixel voisin en repli (comme le reste du module) ; NaN si inconnue.
function groundAt(mnt, x, y) {
    var v = mnt.sample(x, y);
    return v === v ? v : mnt.nearest(x, y);
}

// Détecte les arbres. `veg` : résultat de parseVeg ; `mnt` : Grid du MNT ; `origin` : [x, y] Lambert-93 du coin sud-ouest de la
// dalle (les positions renvoyées sont locales à la dalle) ; `opts` (tous facultatifs) : minCanopy (m, 2), minTree (m, 3), window
// (demi-fenêtre en cellules des maxima locaux, 2).
// Renvoie { trees, n, canopy } : `trees` est un Float32Array de 6 valeurs par arbre (x, y locaux, altitude du sol, altitude de la
// base du houppier, altitude du sommet, rayon, en m) ; `canopy` est un Uint8Array (size x size) valant 1 sur les cellules de
// canopée (végétation à plus de minCanopy au-dessus du sol).
function detectTrees(veg, mnt, origin, opts) {
    var o = opts || {}, minCanopy = o.minCanopy === undefined ? 2 : o.minCanopy, minTree = o.minTree === undefined ? 3 : o.minTree;
    var R = o.window || 2, N = veg.size, step = veg.step;
    var ch = new Float32Array(N * N), ground = new Float32Array(N * N), canopy = new Uint8Array(N * N), k, i, j, di, dj;
    for (j = 0; j < N; j++) {
        for (i = 0; i < N; i++) {
            k = j * N + i;
            var top = veg.z(0, k);
            if (top !== top) { continue; }
            var g = groundAt(mnt, veg.x0 + (i + 0.5) * step, veg.y0 - (j + 0.5) * step);
            if (g !== g) { continue; }
            ground[k] = g;
            if (top - g > minCanopy) { ch[k] = top - g; canopy[k] = 1; }
        }
    }
    // lissage léger (moyenne normalisée 3x3 sur la canopée) : évite les maxima dus au bruit d'une cellule
    var sm = new Float32Array(ch);
    for (j = 1; j < N - 1; j++) {
        for (i = 1; i < N - 1; i++) {
            k = j * N + i;
            if (!canopy[k]) { continue; }
            var s = 0, w = 0;
            for (dj = -1; dj <= 1; dj++) { for (di = -1; di <= 1; di++) { var q = k + dj * N + di; if (canopy[q]) { s += ch[q]; w++; } } }
            sm[k] = s / w;
        }
    }
    var out = [], rays = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    var ox = veg.x0 - origin[0], oy = veg.y0 - origin[1];
    for (j = R; j < N - R; j++) {
        for (i = R; i < N - R; i++) {
            k = j * N + i;
            var h = sm[k];
            if (!canopy[k] || h < minTree) { continue; }
            var isTop = true;
            for (dj = -R; dj <= R && isTop; dj++) {
                for (di = -R; di <= R; di++) {
                    if (!di && !dj) { continue; }
                    var q2 = k + dj * N + di, hv = sm[q2];
                    if (hv > h || (hv === h && q2 < k)) { isTop = false; break; }
                }
            }
            if (!isTop) { continue; }
            // rayon du houppier : distance moyenne, sur 8 directions, jusqu'à ce que la canopée tombe sous la moitié de la cime
            var sum = 0;
            for (var d = 0; d < 8; d++) {
                var L = 0, cx = i, cy = j;
                for (; L < 12; L++) {
                    cx += rays[d][0]; cy += rays[d][1];
                    if (cx < 0 || cy < 0 || cx >= N || cy >= N) { break; }
                    var qq = cy * N + cx;
                    if (!canopy[qq] || sm[qq] < 0.5 * h) { break; }
                }
                sum += (L + 0.5) * step * (rays[d][0] && rays[d][1] ? 1.414 : 1);
            }
            var gz = ground[k], zTop = gz + ch[k], zBase = veg.z(1, k);
            // base du houppier : celle de la végétation haute si elle est connue (au moins 0,8 m sous le sommet), sinon le sol (haie, arbuste)
            if (zBase !== zBase || zBase < gz) { zBase = gz; }
            zBase = Math.min(zBase, zTop - 0.8);
            out.push(ox + (i + 0.5) * step, oy - (j + 0.5) * step, gz, zBase, zTop, Math.max(1.2, Math.min(7, sum / 8)));
        }
    }
    // houppiers qui se touchent : le rayon ne dépasse pas 0,6 fois la distance au voisin le plus proche (grille de 16 m)
    var cell = 16, hash = {}, cnt = out.length / 6, t, key;
    for (t = 0; t < cnt; t++) {
        key = Math.floor(out[6 * t] / cell) + ',' + Math.floor(out[6 * t + 1] / cell);
        (hash[key] = hash[key] || []).push(t);
    }
    for (t = 0; t < cnt; t++) {
        var tx = out[6 * t], ty = out[6 * t + 1], best = Infinity, gx = Math.floor(tx / cell), gy = Math.floor(ty / cell);
        for (var a = -1; a <= 1; a++) {
            for (var b = -1; b <= 1; b++) {
                var lst = hash[(gx + a) + ',' + (gy + b)];
                if (!lst) { continue; }
                for (var u = 0; u < lst.length; u++) {
                    if (lst[u] === t) { continue; }
                    var dd = Math.hypot(out[6 * lst[u]] - tx, out[6 * lst[u] + 1] - ty);
                    if (dd < best) { best = dd; }
                }
            }
        }
        if (best < Infinity) { out[6 * t + 5] = Math.max(1.2, Math.min(out[6 * t + 5], 0.6 * best)); }
    }
    return { trees: new Float32Array(out), n: cnt, canopy: canopy };
}

// Copie du MNS (Grid de raster.js, éventuellement déjà masqué des bâtiments) où les cellules de canopée reprennent l'altitude du
// MNT : les cônes du MNS laissent la place aux arbres. La grille de canopée et celle du MNS peuvent avoir des mailles différentes
// (1 m et 0,5 m). Le MNS d'origine n'est pas modifié. Renvoie { grid, removed }.
function removeCanopy(surf, mnt, veg, canopy) {
    var N = surf.size, step = surf.step, data = new Float32Array(surf.data), removed = 0;
    for (var j = 0; j < N; j++) {
        var y = surf.y0 - j * step, vj = Math.floor((veg.y0 - y) / veg.step);
        if (vj < 0 || vj >= veg.size) { continue; }
        for (var i = 0; i < N; i++) {
            var x = surf.x0 + i * step, vi = Math.floor((x - veg.x0) / veg.step);
            if (vi < 0 || vi >= veg.size || !canopy[vj * veg.size + vi]) { continue; }
            var g = groundAt(mnt, x, y);
            if (g === g) { data[j * N + i] = g; removed++; }
        }
    }
    var grid = Object.create(Object.getPrototypeOf(surf));
    Object.keys(surf).forEach(function (key) { grid[key] = surf[key]; });
    grid.data = data;
    return { grid: grid, removed: removed };
}

export { parseVeg, detectTrees, removeCanopy };
