// Lecteur des rasters LiDAR HD de l'IGN : MNT (sol nu), MNS (surface) et MNH (hauteur = MNS - MNT).
//
// Le WFS publie pour chaque dalle trois requêtes WMS GetMap (url_mnt, url_mns, url_mnh) en GeoTIFF flottant.
// Le WMS accepte aussi `image/x-bil;bits=32` : le même contenu en flottants 32 bits little-endian bruts, ligne par
// ligne du nord au sud, sans en-tête. Aucun lecteur GeoTIFF n'est donc nécessaire (vérifié : octets identiques).
//
// Ce fichier ne dépend ni d'iTowns ni de three : le téléchargement est injecté (fetchBuffer), pour que la file à
// concurrence limitée du module (limitation de débit 429 de data.geopf.fr) serve aussi aux rasters.

// Valeur en dessous de laquelle un pixel est considéré « sans donnée » (le WMS remplit les trous avec une
// valeur très négative ; aucun relief français n'est sous -500 m).
var NODATA_BELOW = -500;

var KINDS = { mnt: 'url_mnt', mns: 'url_mns', mnh: 'url_mnh' };

// Passes de résolution : 1000 px (1 m, ~4 Mo) puis 2000 px (0,5 m, ~16 Mo).
var SIZES = [1000, 2000];

// URL d'un raster de la dalle : reprend l'URL du WFS en forçant le format et la taille.
function rasterUrl(baseUrl, size) {
    return baseUrl
        .replace(/([?&])FORMAT=[^&]*/i, '$1FORMAT=image%2Fx-bil%3Bbits%3D32')
        .replace(/([?&])WIDTH=[^&]*/i, '$1WIDTH=' + size)
        .replace(/([?&])HEIGHT=[^&]*/i, '$1HEIGHT=' + size)
        .replace(/&FILENAME=[^&]*/i, '');
}

// Grille décodée. Les pixels sont repérés par leur centre : la colonne i est en x0 + i * step, la ligne j en
// y0 - j * step (la ligne 0 est au nord). Les pixels sans donnée valent NaN.
function Grid(kind, size, bbox, data) {
    this.kind = kind;
    this.size = size;
    this.step = (bbox[2] - bbox[0]) / size;
    this.x0 = bbox[0] + this.step / 2;
    this.y0 = bbox[3] - this.step / 2;
    this.bbox = bbox;
    this.data = data;
}

// Altitude au point (x, y) en Lambert-93, par interpolation bilinéaire ; NaN hors de la grille ou si l'un des
// quatre pixels voisins n'a pas de donnée.
Grid.prototype.sample = function (x, y) {
    var n = this.size, fx = (x - this.x0) / this.step, fy = (this.y0 - y) / this.step;
    if (!(fx >= 0 && fy >= 0 && fx <= n - 1 && fy <= n - 1)) { return NaN; }
    var i = Math.min(Math.floor(fx), n - 2), j = Math.min(Math.floor(fy), n - 2), tx = fx - i, ty = fy - j, d = this.data;
    var a = d[j * n + i], b = d[j * n + i + 1], c = d[(j + 1) * n + i], e = d[(j + 1) * n + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;   // NaN se propage
};

// Pixel le plus proche (pas d'interpolation avec un trou voisin) ; NaN hors grille.
Grid.prototype.nearest = function (x, y) {
    var n = this.size, i = Math.round((x - this.x0) / this.step), j = Math.round((this.y0 - y) / this.step);
    return (i < 0 || j < 0 || i >= n || j >= n) ? NaN : this.data[j * n + i];
};

// Décode la réponse brute du WMS ; refuse tout ce qui n'a pas la taille attendue (réponse d'erreur XML, etc.).
function decode(kind, size, bbox, buffer) {
    if (buffer.byteLength !== size * size * 4) {
        var head = '';
        try { head = String.fromCharCode.apply(null, new Uint8Array(buffer, 0, Math.min(160, buffer.byteLength))); } catch (e) { /* ignoré */ }
        throw new Error('raster ' + kind + ' inattendu (' + buffer.byteLength + ' octets au lieu de ' + (size * size * 4) + ') : ' + head);
    }
    var data = new Float32Array(buffer);   // le WMS répond en little-endian, comme tous les navigateurs courants
    for (var k = 0; k < data.length; k++) {
        var v = data[k];
        if (!(v > NODATA_BELOW)) { data[k] = NaN; }   // couvre aussi NaN et -Infinity
    }
    return new Grid(kind, size, bbox, data);
}

// Fabrique un lecteur. `fetchBuffer(url)` renvoie une Promise d'ArrayBuffer (avec limitation de débit et reprise).
// Les grilles lues sont gardées en mémoire (au plus `maxBytes`, les plus anciennes sortent d'abord) et les
// lectures simultanées de la même grille partagent une seule requête.
function createRasterReader(fetchBuffer, maxBytes) {
    var limit = maxBytes || 160 * 1024 * 1024;
    var cache = new Map(), bytes = 0, pending = new Map();

    function remember(key, grid) {
        cache.set(key, grid); bytes += grid.data.byteLength;
        var it = cache.keys();
        while (bytes > limit && cache.size > 1) {
            var k = it.next().value;
            if (k === key) { continue; }
            bytes -= cache.get(k).data.byteLength; cache.delete(k);
        }
    }

    // tile : { name, bbox: [xmin, ymin, xmax, ymax] en Lambert-93, rasters: { mnt, mns, mnh } (URLs du WFS) }
    function load(tile, kind, size) {
        var base = tile.rasters && tile.rasters[kind];
        if (!KINDS[kind]) { return Promise.reject(new Error('type de raster inconnu : ' + kind)); }
        if (!base) { return Promise.reject(new Error('dalle ' + tile.name + ' sans ' + KINDS[kind])); }
        var key = tile.name + '|' + kind + '|' + size;
        if (cache.has(key)) {
            var hit = cache.get(key);
            cache.delete(key); cache.set(key, hit);   // plus récemment utilisé
            return Promise.resolve(hit);
        }
        if (pending.has(key)) { return pending.get(key); }
        var bbox = rasterBbox(base);
        var p = fetchBuffer(rasterUrl(base, size)).then(function (buf) {
            var grid = decode(kind, size, bbox, buf);
            remember(key, grid);
            return grid;
        }).then(function (g) { pending.delete(key); return g; }, function (e) { pending.delete(key); throw e; });
        pending.set(key, p);
        return p;
    }

    // Lecture progressive : `onGrid(grid)` est appelé à 1 m puis à 0,5 m (la passe fine peut seule suffire si la
    // première échoue ; `sizes` remplace les passes par défaut, ex. [1000] pour une seule passe à 1 m). Renvoie une Promise résolue avec la meilleure grille obtenue. `isStale()` (facultatif)
    // permet d'abandonner entre deux passes quand l'utilisateur a changé de dalle.
    function loadProgressive(tile, kind, onGrid, isStale, sizes) {
        var best = null, lastError = null;
        return (sizes || SIZES).reduce(function (chain, size) {
            return chain.then(function () {
                if (isStale && isStale()) { return null; }
                return load(tile, kind, size).then(function (g) {
                    best = g;
                    if (!(isStale && isStale()) && onGrid) { onGrid(g); }
                }, function (e) { lastError = e; });
            });
        }, Promise.resolve()).then(function () {
            if (!best && lastError) { throw lastError; }
            return best;
        });
    }

    function clear() { cache.clear(); pending.clear(); bytes = 0; }

    return { load: load, loadProgressive: loadProgressive, clear: clear };
}

// Emprise exacte du raster, lue dans le BBOX de l'URL du WFS (décalée d'un quart de mètre par rapport aux
// limites nominales de la dalle : les centres de pixels tombent ainsi sur la grille de 0,5 m).
function rasterBbox(url) {
    var m = /[?&]BBOX=([^&]*)/i.exec(url);
    var b = m ? decodeURIComponent(m[1]).split(',').map(Number) : [];
    if (b.length !== 4 || b.some(isNaN)) { throw new Error('BBOX introuvable dans ' + url); }
    return b;
}

export { createRasterReader, rasterUrl, rasterBbox, decode, Grid, SIZES };
