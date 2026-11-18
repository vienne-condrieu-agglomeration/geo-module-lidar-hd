import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { city3dUrls, city3dIndexUrl, parseCity3dIndex, fetchRetry } from '../src/js/city3d.js';

const off = { buildings: '', vegetation: '' };
// sans URL de base, tout est désactivé, quels que soient les interrupteurs
assert.deepEqual(city3dUrls(undefined), off);
assert.deepEqual(city3dUrls({}), off);
assert.deepEqual(city3dUrls({ city3dUrl: '' }), off);
assert.deepEqual(city3dUrls({ city3dUrl: '   ' }), off);
assert.deepEqual(city3dUrls({ city3dUrl: '', buildingsEnabled: true, treesEnabled: true }), off);
assert.deepEqual(city3dUrls({ city3dUrl: null }), off);
// avec une base : un sous-dossier par fonction, interrupteurs absents = activés
const on = { buildings: 'http://localhost:8777/buildings', vegetation: 'http://localhost:8777/vegetation' };
assert.deepEqual(city3dUrls({ city3dUrl: 'http://localhost:8777' }), on);
assert.deepEqual(city3dUrls({ city3dUrl: 'http://localhost:8777', buildingsEnabled: true, treesEnabled: true }), on);
// barres obliques finales et espaces ignorés
assert.deepEqual(city3dUrls({ city3dUrl: '  http://localhost:8777///  ' }), on);
assert.deepEqual(city3dUrls({ city3dUrl: 'https://cdn.example.org/ville3d/' }), { buildings: 'https://cdn.example.org/ville3d/buildings', vegetation: 'https://cdn.example.org/ville3d/vegetation' });
// un interrupteur décoché désactive sa fonction seulement
assert.deepEqual(city3dUrls({ city3dUrl: 'http://x', buildingsEnabled: false }), { buildings: '', vegetation: 'http://x/vegetation' });
assert.deepEqual(city3dUrls({ city3dUrl: 'http://x', treesEnabled: false }), { buildings: 'http://x/buildings', vegetation: '' });
assert.deepEqual(city3dUrls({ city3dUrl: 'http://x', buildingsEnabled: false, treesEnabled: false }), off);
// les anciens réglages n'ont plus d'effet
assert.deepEqual(city3dUrls({ buildingsUrl: 'http://old/b', vegetationUrl: 'http://old/v' }), off);

// --- adresse de l'index : même base que les dossiers, vide si la base est vide ---
assert.equal(city3dIndexUrl({}), '');
assert.equal(city3dIndexUrl({ city3dUrl: '  ' }), '');
assert.equal(city3dIndexUrl({ city3dUrl: 'https://o.github.io/d' }), 'https://o.github.io/d/index.json');
assert.equal(city3dIndexUrl({ city3dUrl: ' https://o.github.io/d/// ' }), 'https://o.github.io/d/index.json');

// --- lecture de l'index (même forme que celui qu'écrit l'intégrateur city3d) ---
const entry = (kinds) => ({ integrateur: '0.1.0', ...(kinds.includes('b') ? { batiments: { fichier: 'buildings/x.bld', taille: 1, sha256: 'a' } } : {}), ...(kinds.includes('v') ? { vegetation: { fichier: 'vegetation/x.veg', taille: 1, sha256: 'b' } } : {}) });
const idx = parseCity3dIndex({ format: 1, dalles: { '0846-6494': entry('bv'), '0845-6494': entry('b'), '0847-6494': entry('v') } });
assert.equal(idx.status, 'ok');
assert.deepEqual(Object.keys(idx.buildings).sort(), ['0845-6494', '0846-6494']);
assert.deepEqual(Object.keys(idx.vegetation).sort(), ['0846-6494', '0847-6494']);
assert.ok(!idx.buildings['0847-6494'] && !idx.vegetation['0845-6494'] && !idx.buildings['toString'], 'une dalle absente ou un nom d\'objet ne compte pas');
// format inconnu : refusé (on ne devine pas) ; structure invalide : on revient aux fichiers un à un
assert.equal(parseCity3dIndex({ format: 2, dalles: {} }).status, 'unsupported');
assert.equal(parseCity3dIndex({ dalles: {} }).status, 'unsupported');
assert.match(parseCity3dIndex({ format: 2, dalles: {} }).reason, /format 2 non pris en charge/);
for (const bad of [null, undefined, 'x', 3, [], {}, { format: 1 }, { format: 1, dalles: null }]) { assert.equal(parseCity3dIndex(bad).status, 'invalid', JSON.stringify(bad)); }
// l'index réel publié par le premier lancement du workflow (9 dalles, intégrateur 0.1.0)
const real = parseCity3dIndex(JSON.parse(readFileSync(new URL('./fixtures/city3d-index.json', import.meta.url), 'utf8')));
assert.equal(real.status, 'ok');
assert.equal(Object.keys(real.buildings).length, 9);
assert.ok(real.buildings['0846-6494'] && real.vegetation['0846-6494'] && !real.buildings['0848-6494']);

// --- fetch avec reprises ---
const resp = (status, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
const scripted = (outcomes) => { const calls = []; const fn = (url) => { calls.push(url); const o = outcomes.shift(); return o instanceof Error ? Promise.reject(o) : Promise.resolve(o); }; fn.calls = calls; return fn; };
const noWait = (waits) => (ms) => { waits.push(ms); return Promise.resolve(); };
{   // 503 puis erreur réseau (un 503 sans CORS) puis 200 : trois essais, délais croissants
    const waits = [], f = scripted([resp(503), new TypeError('NetworkError'), resp(200)]);
    const r = await fetchRetry(f, 'u', { sleep: noWait(waits) });
    assert.equal(r.status, 200); assert.equal(f.calls.length, 3); assert.equal(waits.length, 2);
    assert.ok(waits[0] >= 400 && waits[0] < 650 && waits[1] >= 800 && waits[1] < 1050, 'délai croissant : ' + waits);
}
{   // 404 et 200 ne sont jamais rejoués
    for (const st of [200, 404, 403]) { const f = scripted([resp(st)]); assert.equal((await fetchRetry(f, 'u', { sleep: noWait([]) })).status, st); assert.equal(f.calls.length, 1); }
}
{   // Retry-After honoré (borné à 30 s)
    const waits = [], f = scripted([resp(429, { 'retry-after': '2' }), resp(429, { 'retry-after': '999' }), resp(200)]);
    await fetchRetry(f, 'u', { sleep: noWait(waits) });
    assert.deepEqual(waits, [2000, 30000]);
}
{   // abandon après le nombre d'essais : la dernière réponse 503 est rendue, la dernière erreur réseau est levée
    const f = scripted([resp(503), resp(503), resp(503)]);
    assert.equal((await fetchRetry(f, 'u', { tries: 3, sleep: noWait([]) })).status, 503); assert.equal(f.calls.length, 3);
    const g = scripted([new TypeError('a'), new TypeError('b')]);
    await assert.rejects(() => fetchRetry(g, 'u', { tries: 2, sleep: noWait([]) }), /b/); assert.equal(g.calls.length, 2);
}

// --- branchement dans le module (lecture du source : extension.js dépend du navigateur) ---
const ext = readFileSync(new URL('../src/js/extension.js', import.meta.url), 'utf8');
assert.ok(ext.includes("_city3dIndexUrl = urls3d.buildings || urls3d.vegetation ? city3dIndexUrl(props) : '';"), 'index lu seulement si une fonction est active');
assert.ok(/function _fetchCity3dFile\(kind, tileName, url\)[\s\S]*idx\.status === 'unsupported'[\s\S]*!idx\[kind\]\[tileName\][\s\S]*fetchRetry/.test(ext), 'les fichiers passent par l\'index puis par fetchRetry');
assert.ok(ext.includes("_fetchCity3dFile('buildings', tile.name, url)") && ext.includes("_fetchCity3dFile('vegetation', tile.name, url)"), 'bâtiments et arbres passent par _fetchCity3dFile');
console.log('city3d : OK');
