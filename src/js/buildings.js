// Bâtiments LoD2 (fichiers « .bld », voir GUIDE-DEV.md) : lecture et masquage des bâtiments du MNS.
//
// Ce fichier ne dépend ni du navigateur, ni d'iTowns, ni de three : il se teste sous Node (test/buildings.test.mjs).
// Les fichiers sont produits par scripts/roofer/cityjsonseq_to_bld.py (little-endian, sections alignées sur 4 octets,
// ce que lisent tous les navigateurs courants).

var MAGIC = 0x31444c42;   // « BLD1 » lu en little-endian
var HEADER_BYTES = 40;

// Lit un fichier .bld. Renvoie :
//   origin    [x, y] Lambert-93 du coin sud-ouest de la dalle (origine des coordonnées locales)
//   positions Float32Array x, y locaux (m) et z altitude NGF (m), 3 valeurs par sommet
//   indices   Uint32Array, 3 par triangle (sans les faces de sol)
//   foot      Uint8Array, 1 = pied de mur (sommet à poser sur le terrain)
//   polys     emprises : tableau de polygones, chacun un tableau d'anneaux (extérieur puis trous),
//             chaque anneau un Float32Array x0, y0, x1, y1… (coordonnées locales)
// Les tableaux positions / indices / foot sont des vues sur le tampon fourni (pas de copie).
function parseBld(buffer) {
    if (!buffer || buffer.byteLength < HEADER_BYTES) { throw new Error('fichier .bld trop court'); }
    var dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== MAGIC) { throw new Error('fichier .bld : signature « BLD1 » absente'); }
    var nv = dv.getUint32(4, true), ni = dv.getUint32(8, true), np = dv.getUint32(12, true),
        nr = dv.getUint32(16, true), npts = dv.getUint32(20, true);
    var origin = [dv.getFloat64(24, true), dv.getFloat64(32, true)];
    var footBytes = nv + ((4 - (nv % 4)) % 4);
    var expected = HEADER_BYTES + 12 * nv + 4 * ni + footBytes + 4 * np + 4 * nr + 8 * npts;
    if (ni % 3 !== 0 || buffer.byteLength !== expected) {
        throw new Error('fichier .bld : taille inattendue (' + buffer.byteLength + ' octets au lieu de ' + expected + ')');
    }
    var o = HEADER_BYTES;
    var positions = new Float32Array(buffer, o, 3 * nv); o += 12 * nv;
    var indices = new Uint32Array(buffer, o, ni); o += 4 * ni;
    var foot = new Uint8Array(buffer, o, nv); o += footBytes;
    var polyRings = new Uint32Array(buffer, o, np); o += 4 * np;
    var ringLens = new Uint32Array(buffer, o, nr); o += 4 * nr;
    var pts = new Float32Array(buffer, o, 2 * npts);
    var k, polys = [], r = 0, p = 0;
    for (k = 0; k < ni; k++) {
        if (indices[k] >= nv) { throw new Error('fichier .bld : indice de sommet hors limites'); }
    }
    for (k = 0; k < np; k++) {
        var rings = [];
        for (var q = 0; q < polyRings[k]; q++, r++) {
            if (r >= nr || p + ringLens[r] > npts) { throw new Error('fichier .bld : anneaux incohérents'); }
            rings.push(pts.subarray(2 * p, 2 * (p + ringLens[r])));
            p += ringLens[r];
        }
        polys.push(rings);
    }
    return { origin: origin, nVerts: nv, positions: positions, indices: indices, foot: foot, polys: polys };
}

// Rastérise les emprises sur une grille : renvoie un Uint8Array (size × size) valant 1 pour chaque cellule dont le
// centre est dans un polygone (anneau extérieur moins trous, règle pair-impair). Les cellules sont repérées comme dans
// raster.js : colonne i au centre x0 + i·step, ligne j (0 au nord) au centre y0 - j·step ; x0 et y0 sont ici dans le même
// repère que les polygones (locaux à la dalle).
function rasterizeFootprints(polys, size, step, x0, y0) {
    var mask = new Uint8Array(size * size);
    for (var k = 0; k < polys.length; k++) {
        var rings = polys[k], ymin = Infinity, ymax = -Infinity, a, b;
        for (a = 0; a < rings.length; a++) {
            for (b = 1; b < rings[a].length; b += 2) {
                if (rings[a][b] < ymin) { ymin = rings[a][b]; }
                if (rings[a][b] > ymax) { ymax = rings[a][b]; }
            }
        }
        var j0 = Math.max(0, Math.ceil((y0 - ymax) / step)), j1 = Math.min(size - 1, Math.floor((y0 - ymin) / step));
        for (var j = j0; j <= j1; j++) {
            var y = y0 - j * step, xs = [];
            for (a = 0; a < rings.length; a++) {
                var ring = rings[a], n = ring.length / 2;
                for (var e = 0; e < n; e++) {
                    var ax = ring[2 * e], ay = ring[2 * e + 1], bx = ring[2 * ((e + 1) % n)], by = ring[2 * ((e + 1) % n) + 1];
                    if ((ay <= y && by > y) || (by <= y && ay > y)) { xs.push(ax + (y - ay) / (by - ay) * (bx - ax)); }
                }
            }
            xs.sort(function (u, v) { return u - v; });
            for (var s = 0; s + 1 < xs.length; s += 2) {
                var i0 = Math.max(0, Math.ceil((xs[s] - x0) / step)), i1 = Math.min(size - 1, Math.floor((xs[s + 1] - x0) / step));
                for (var i = i0; i <= i1; i++) { mask[j * size + i] = 1; }
            }
        }
    }
    return mask;
}

// Dilate un masque d'un disque de rayon `radius` cellules (réel). Renvoie un nouveau masque.
function dilate(mask, size, radius) {
    if (!(radius > 0)) { return mask.slice(); }
    var out = new Uint8Array(mask.length), R = Math.ceil(radius), j, i, dy;
    var half = [];
    for (dy = -R; dy <= R; dy++) {
        var h2 = radius * radius - dy * dy;
        half.push(h2 >= 0 ? Math.floor(Math.sqrt(h2)) : -1);
    }
    for (j = 0; j < size; j++) {
        i = 0;
        while (i < size) {
            if (!mask[j * size + i]) { i++; continue; }
            var a = i;
            while (i < size && mask[j * size + i]) { i++; }
            var b = i - 1;   // course [a, b] de cellules couvertes dans la ligne j
            for (dy = -R; dy <= R; dy++) {
                var hw = half[dy + R], jj = j + dy;
                if (hw < 0 || jj < 0 || jj >= size) { continue; }
                var from = Math.max(0, a - hw), to = Math.min(size - 1, b + hw);
                for (var c = from; c <= to; c++) { out[jj * size + c] = 1; }
            }
        }
    }
    return out;
}

// Copie du MNS où les cellules couvertes par les emprises des bâtiments (élargies de `margin` mètres, 1 par défaut)
// prennent l'altitude du MNT. Les grilles sont celles de raster.js (Grid : size, step, x0, y0, data, sample(), nearest()).
// Le MNS d'origine n'est pas modifié (le profil l'utilise). Renvoie { grid, covered } : la copie (même type que le MNS,
// mêmes champs) et le nombre de cellules remplacées. Une cellule dont le MNT est inconnu garde la valeur du MNS.
function maskSurface(mns, mnt, buildings, margin) {
    var m = margin === undefined ? 1 : margin;
    var size = mns.size, step = mns.step, ox = buildings.origin[0], oy = buildings.origin[1];
    var mask = dilate(rasterizeFootprints(buildings.polys, size, step, mns.x0 - ox, mns.y0 - oy), size, m / step);
    var data = new Float32Array(mns.data), covered = 0;
    for (var j = 0; j < size; j++) {
        for (var i = 0; i < size; i++) {
            var k = j * size + i;
            if (!mask[k]) { continue; }
            var x = mns.x0 + i * step, y = mns.y0 - j * step, v = mnt.sample(x, y);
            if (v !== v) { v = mnt.nearest(x, y); }
            if (v === v) { data[k] = v; covered++; }
        }
    }
    var grid = Object.create(Object.getPrototypeOf(mns));
    Object.keys(mns).forEach(function (key) { grid[key] = mns[key]; });
    grid.data = data;
    return { grid: grid, covered: covered };
}

export { parseBld, rasterizeFootprints, dilate, maskSurface };
