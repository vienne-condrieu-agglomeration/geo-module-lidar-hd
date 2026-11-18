// Cache persistant (API Cache du navigateur) des réponses déjà lues : plages COPC et rasters.
// Il survit au rechargement de la page, contrairement au cache mémoire. Taille bornée (les entrées les moins
// récemment utilisées sont retirées en premier) et durée de validité limitée. Toute erreur de stockage
// (navigation privée, quota, API absente) est ignorée : le module retombe alors sur le seul réseau.

var BASE = 'https://geo-lidar-hd.invalid/';

// `storage` : l'objet `caches` du navigateur (ou un équivalent pour les tests).
export function createDiskCache(storage, opts) {
    var o = opts || {};
    var name = o.name || 'geo-lidar-hd-v1';
    var maxBytes = o.maxBytes || 2 * 1024 * 1024 * 1024;
    var maxEntry = o.maxEntry || 256 * 1024 * 1024;
    var ttlMs = o.ttlMs || 7 * 24 * 3600 * 1000;
    var now = o.now || Date.now;

    var _cache = null, _index = null, _total = 0, _ready = null;

    function _req(key) { return new Request(BASE + encodeURIComponent(key)); }
    function _keyOf(request) { return decodeURIComponent(request.url.slice(BASE.length)); }

    // Ouvre le cache et reconstitue l'index (taille, date) depuis les en-têtes : le corps n'est pas lu.
    function _open() {
        if (_ready) { return _ready; }
        _ready = Promise.resolve().then(function () {
            if (!storage || typeof storage.open !== 'function') { return false; }
            return storage.open(name).then(function (c) {
                _cache = c;
                return c.keys();
            }).then(function (requests) {
                _index = new Map(); _total = 0;
                return Promise.all(requests.map(function (rq) {
                    return _cache.match(rq).then(function (res) {
                        var size = res ? parseInt(res.headers.get('x-size'), 10) : NaN;
                        var at = res ? parseInt(res.headers.get('x-cached-at'), 10) : NaN;
                        if (!(size >= 0) || !(at > 0) || now() - at > ttlMs) { return _cache.delete(rq); }
                        _index.set(_keyOf(rq), { size: size, at: at, used: at });
                        _total += size;
                    });
                }));
            }).then(function () { return _evict(); }).then(function () { return true; });
        }).catch(function () { _cache = null; return false; });
        return _ready;
    }

    function _evict() {
        var jobs = [];
        if (_total <= maxBytes) { return Promise.resolve(); }
        var entries = Array.from(_index.entries()).sort(function (a, b) { return a[1].used - b[1].used; });
        for (var i = 0; i < entries.length && _total > maxBytes; i++) {
            _total -= entries[i][1].size; _index.delete(entries[i][0]);
            jobs.push(_cache.delete(_req(entries[i][0])));
        }
        return Promise.all(jobs);
    }

    return {
        // Contenu mis en cache (copie), ou null.
        get: function (key) {
            return _open().then(function (ok) {
                var e = ok && _index.get(key);
                if (!e) { return null; }
                if (now() - e.at > ttlMs) {
                    _total -= e.size; _index.delete(key);
                    return _cache.delete(_req(key)).then(function () { return null; });
                }
                return _cache.match(_req(key)).then(function (res) {
                    if (!res) { _total -= e.size; _index.delete(key); return null; }
                    e.used = now();
                    return res.arrayBuffer();
                });
            }).catch(function () { return null; });
        },
        // Enregistre une copie de `buf` ; ne rejette jamais.
        put: function (key, buf) {
            return _open().then(function (ok) {
                if (!ok || buf.byteLength > maxEntry) { return; }
                var old = _index.get(key);
                if (old) { _total -= old.size; _index.delete(key); }
                var at = now();
                var res = new Response(buf.slice(0), { headers: { 'x-size': String(buf.byteLength), 'x-cached-at': String(at), 'content-type': 'application/octet-stream' } });
                return _cache.put(_req(key), res).then(function () {
                    _index.set(key, { size: buf.byteLength, at: at, used: at });
                    _total += buf.byteLength;
                    return _evict();
                });
            }).catch(function () { /* quota atteint ou stockage refusé : on s'en passe */ });
        },
        // Octets et nombre d'entrées conservés.
        stats: function () {
            return _open().then(function (ok) { return ok ? { bytes: _total, count: _index.size, max: maxBytes } : null; })
                .catch(function () { return null; });
        },
        clear: function () {
            return _open().then(function (ok) {
                if (!ok) { return; }
                _index.clear(); _total = 0;
                return storage.delete(name).then(function () { _ready = null; _cache = null; });
            }).catch(function () { /* rien à vider */ });
        }
    };
}
