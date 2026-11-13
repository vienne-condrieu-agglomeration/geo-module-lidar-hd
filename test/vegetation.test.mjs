import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseVeg, detectTrees, removeCanopy } from '../src/js/vegetation.js';
import { Grid } from '../src/js/raster.js';

const fixture = (name) => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
const load = (name) => { const b = readFileSync(fixture(name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' : ' + a + ' attendu ' + b + ' ± ' + tol);

// --- lecture du .veg (faux fichier : 3 arbres, une haie de 2,5 m, une pelouse de 0,5 m ; sol à 100 m NGF) ---
const veg = await parseVeg(load('fake.veg'));
assert.equal(veg.size, 64); assert.equal(veg.bands, 2); assert.equal(veg.step, 1);
assert.equal(veg.x0, 846000); assert.equal(veg.y0, 6494000);
near(veg.z(0, 16 * 64 + 16), 110, 0.1, 'sommet de l\'arbre 1');
near(veg.z(1, 16 * 64 + 16), 102, 0.1, 'base de l\'arbre 1');
assert.ok(Number.isNaN(veg.z(0, 0)) && Number.isNaN(veg.z(1, 0)), 'cellule sans donnée');
near(veg.z(0, 56 * 64 + 10), 102.5, 0.1, 'haie');
assert.ok(Number.isNaN(veg.z(1, 56 * 64 + 10)), 'la haie n\'a pas de base (pas de végétation haute)');

// fichiers invalides : refusés, jamais lus de travers
const good = load('fake.veg');
await assert.rejects(parseVeg(good.slice(0, 20)), /trop court/);
const badMagic = good.slice(0); new Uint8Array(badMagic)[0] = 0x58;
await assert.rejects(parseVeg(badMagic), /signature/);
const badSize = good.slice(0); new DataView(badSize).setUint32(4, 63, true);
await assert.rejects(parseVeg(badSize), /taille inattendue|inflate|incorrect|invalid|Z_/i);
const badHead = good.slice(0); new DataView(badHead).setFloat32(16, 0, true);
await assert.rejects(parseVeg(badHead), /en-tête invalide/);
await assert.rejects(parseVeg(good.slice(0, 60)));   // charge utile tronquée

// --- détection des arbres sur un MNT plat à 100 m (dalle réduite à 64 m : coin nord-ouest en 846000, 6494000) ---
const mnt = new Grid('mnt', 64, [846000, 6493936, 846064, 6494000], new Float32Array(64 * 64).fill(100));
const origin = [846000, 6493000];
const det = detectTrees(veg, mnt, origin);
assert.equal(det.n, 3, 'trois arbres : ni la haie (2,5 m) ni la pelouse (0,5 m)');
const trees = [0, 1, 2].map((t) => Array.from(det.trees.slice(6 * t, 6 * t + 6))).sort((a, b) => a[0] - b[0]);
// [x, y, sol, base, sommet, rayon] ; x, y locaux à la dalle (origine au sud-ouest) : colonne i -> i + 0,5 ; ligne j -> 1000 - (j + 0,5)
const expect = [[16.5, 983.5, 102, 110, 4], [30.5, 953.5, 106, 114, 5], [44.5, 979.5, 103, 108, 3]];
trees.forEach((t, n) => {
    near(t[0], expect[n][0], 1, 'x'); near(t[1], expect[n][1], 1, 'y');
    near(t[2], 100, 0.01, 'sol'); near(t[3], expect[n][2], 0.15, 'base du houppier'); near(t[4], expect[n][3], 0.3, 'sommet');
    assert.ok(t[5] >= 1.2 && t[5] <= 7 && Math.abs(t[5] - expect[n][4]) <= 2.5, 'rayon ' + t[5] + ' pour ' + expect[n][4]);
});
assert.ok(trees[1][5] > trees[2][5], 'l\'arbre de 14 m a un houppier plus large que celui de 8 m');
// canopée : arbres et haie oui, pelouse non
assert.equal(det.canopy[16 * 64 + 16], 1); assert.equal(det.canopy[56 * 64 + 10], 1); assert.equal(det.canopy[3 * 64 + 50], 0);
// un seuil plus haut écarte les arbres bas
assert.equal(detectTrees(veg, mnt, origin, { minTree: 9 }).n, 2);
// sans sol connu, rien n'est inventé
const noGround = new Grid('mnt', 64, [846000, 6493936, 846064, 6494000], new Float32Array(64 * 64).fill(NaN));
assert.equal(detectTrees(veg, noGround, origin).n, 0);

// --- deux houppiers qui se chevauchent : chaque rayon est borné par 0,6 fois la distance entre les deux cimes ---
{
    const N = 40, centers = [[16, 20], [24, 20]], vz = new Float32Array(N * N).fill(NaN), vb = new Float32Array(N * N).fill(NaN);
    for (let j = 0; j < N; j++) { for (let i = 0; i < N; i++) {
        let best = 0; for (const [cx, cy] of centers) { const d = Math.hypot(i - cx, j - cy); if (d < 9) { best = Math.max(best, 15 - 0.1 * d); } }
        if (best > 0) { vz[j * N + i] = 100 + best; vb[j * N + i] = 100 + 2; }
    } }
    const two = { size: N, step: 1, bands: 2, x0: 846000, y0: 6494000, z: (b, k) => (b ? vb[k] : vz[k]) };
    const flat = new Grid('mnt', N, [846000, 6493960, 846040, 6494000], new Float32Array(N * N).fill(100));
    const d2 = detectTrees(two, flat, [846000, 6493000]);
    assert.equal(d2.n, 2, 'deux cimes');
    const gap = Math.abs(d2.trees[0] - d2.trees[6]);
    assert.ok(gap > 6 && gap < 10, 'cimes à ' + gap + ' m');
    for (let t = 0; t < 2; t++) { assert.ok(d2.trees[6 * t + 5] <= 0.6 * gap + 1e-6, 'rayon ' + d2.trees[6 * t + 5] + ' > ' + (0.6 * gap)); }
}

// --- retrait de la canopée du MNS (deux mailles : 1 m et 0,5 m) ---
for (const size of [64, 128]) {
    const step = 64 / size, bbox = [846000, 6493936, 846064, 6494000];
    const data = new Float32Array(size * size).fill(105);
    const surf = new Grid('mns', size, bbox, data), before = surf.data.slice();
    const r = removeCanopy(surf, new Grid('mnt', 64, bbox, new Float32Array(64 * 64).fill(100)), veg, det.canopy);
    assert.ok(r.grid !== surf && r.grid.data !== surf.data && r.grid instanceof Grid, 'copie');
    assert.deepEqual(surf.data, before, 'le MNS d\'origine reste intact');
    const at = (g, col, row) => g.data[Math.round(row / step) * size + Math.round(col / step)];
    assert.equal(at(r.grid, 16, 16), 100, size + ' : cône de l\'arbre 1 remplacé par le sol');
    assert.equal(at(r.grid, 15, 56), 100, size + ' : la haie est aussi retirée');
    assert.equal(at(r.grid, 50, 3), 105, size + ' : la pelouse reste comme avant');
    assert.equal(at(r.grid, 2, 40), 105, size + ' : cellule hors végétation inchangée');
    near(r.removed, (size / 64) ** 2 * det.canopy.reduce((a, v) => a + v, 0), size, size + ' : nombre de cellules retirées');
}

// --- le faux fichier du dépôt est à jour avec le script Python (comparaison des valeurs décompressées ; ignoré sans python3) ---
const out = fixture('../../node_modules/.fake-check.veg');
const py = spawnSync('python3', ['-I', fixture('../../scripts/vegetation/make_fake_veg.py'), out], { encoding: 'utf8' });
if (py.status === 0) {
    const fresh = await parseVeg((() => { const b = readFileSync(out); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })());
    for (let band = 0; band < 2; band++) {
        for (let k = 0; k < 64 * 64; k++) {
            const a = veg.z(band, k), b = fresh.z(band, k);
            assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b, 'test/fixtures/fake.veg périmé : relancer scripts/vegetation/make_fake_veg.py');
        }
    }
} else {
    console.log('vegetation : python3 indisponible, régénération de fake.veg ignorée');
}
// --- branchement dans le module (lecture du source : extension.js dépend du navigateur) ---
const ext = readFileSync(fileURLToPath(new URL('../src/js/extension.js', import.meta.url)), 'utf8');
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../src/plugin.geoext.json', import.meta.url)), 'utf8'));
const vegSetting = manifest.configuration.flatMap((g) => g.elements).find((e) => e.key === 'vegetationUrl');
assert.ok(vegSetting && vegSetting.defaultValue === '' && !vegSetting.required, 'réglage vegetationUrl : vide par défaut = désactivé');
assert.ok(ext.includes('var wantVeg = !!(_vegetationUrl && m.trees);'), 'sans réglage, rien ne se charge');
assert.ok(ext.includes('ng-if=\\"vegEnabled\\"') || ext.includes('ng-if="vegEnabled"'), 'case Arbres visible seulement si vegetationUrl est réglé');
assert.ok(/function _disposeTrees\(t\)[\s\S]*im\.geometry\.dispose\(\); im\.material\.dispose\(\); im\.dispose\(\);/.test(ext), 'arbres détruits avec leur dalle');
assert.ok(/_disposeTrees\(t\);\s*t\.veg = null; t\.treeData = null;/.test(ext), '_disposeTile libère les arbres');
// le vertex shader des arbres est dérivé de celui de la maquette : il faut que ses ancres existent
assert.ok(ext.includes("'varying vec3 vLocal; varying float vOk; varying float vH;',") && ext.includes("void main() {'"), 'ancres du shader de la maquette');
console.log('vegetation : OK');
