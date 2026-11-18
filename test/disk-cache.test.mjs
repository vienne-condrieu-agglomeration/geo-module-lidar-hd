import assert from 'node:assert/strict';
import { createDiskCache } from '../src/js/disk-cache.js';

// Faux `caches` : un seul cache nommé, réponses conservées telles quelles.
function fakeStorage() {
    const stores = new Map();
    return {
        stores,
        open: async (n) => {
            if (!stores.has(n)) { stores.set(n, new Map()); }
            const m = stores.get(n);
            return {
                keys: async () => Array.from(m.keys()).map((u) => new Request(u)),
                match: async (rq) => { const r = m.get(rq.url); return r ? r.clone() : undefined; },
                put: async (rq, res) => { m.set(rq.url, res); },
                delete: async (rq) => m.delete(rq.url)
            };
        },
        delete: async (n) => stores.delete(n)
    };
}
const buf = (n, v) => new Uint8Array(n).fill(v).buffer;
let t = 1000;
const now = () => t;

// aller-retour, et la clé « plage » reste distincte d'une autre plage
const st = fakeStorage();
let c = createDiskCache(st, { maxBytes: 100, ttlMs: 50, now });
assert.equal(await c.get('a|bytes=0-9'), null);
await c.put('a|bytes=0-9', buf(10, 7));
const got = await c.get('a|bytes=0-9');
assert.equal(got.byteLength, 10);
assert.equal(new Uint8Array(got)[0], 7);
assert.equal(await c.get('a|bytes=10-19'), null);

// survit à un « rechargement de page » : nouvel objet, même stockage
c = createDiskCache(st, { maxBytes: 100, ttlMs: 50, now });
assert.equal((await c.get('a|bytes=0-9')).byteLength, 10);
assert.deepEqual(await c.stats(), { bytes: 10, count: 1, max: 100 });

// éviction : on retire d'abord l'entrée la moins récemment utilisée
t = 1001; await c.put('b', buf(40, 1));
t = 1002; await c.put('c', buf(40, 2));
t = 1003; await c.get('a|bytes=0-9');        // « a » redevient récente
t = 1004; await c.put('d', buf(40, 3));      // 130 > 100 : « b » (la plus ancienne) part
assert.equal(await c.get('b'), null);
assert.ok(await c.get('c'));
assert.ok(await c.get('d'));
assert.ok((await c.stats()).bytes <= 100);

// péremption
t = 5000;
assert.equal(await c.get('c'), null);
c = createDiskCache(st, { maxBytes: 100, ttlMs: 50, now });
assert.deepEqual(await c.stats(), { bytes: 0, count: 0, max: 100 });

// entrée trop grosse : ignorée sans erreur
await c.put('gros', buf(500, 1));
assert.equal(await c.get('gros'), null);

// vidage
await c.put('x', buf(5, 1));
await c.clear();
assert.equal(await c.get('x'), null);
assert.deepEqual(await c.stats(), { bytes: 0, count: 0, max: 100 });

// stockage absent ou qui échoue : aucune exception, rien en cache
for (const bad of [undefined, null, { open: async () => { throw new Error('refusé'); } }]) {
    const d = createDiskCache(bad, {});
    await d.put('k', buf(3, 1));
    assert.equal(await d.get('k'), null);
    assert.equal(await d.stats(), null);
    await d.clear();
}
console.log('disk-cache : OK');
