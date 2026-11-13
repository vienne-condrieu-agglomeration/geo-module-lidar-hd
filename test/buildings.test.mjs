import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBld, rasterizeFootprints, dilate, maskSurface } from '../src/js/buildings.js';
import { Grid } from '../src/js/raster.js';

const fixture = (name) => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
const load = (name) => { const b = readFileSync(fixture(name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// --- lecture du .bld (convertisseur Python sur la fausse sortie roofer : 3 bâtiments) ---
const bld = parseBld(load('fake.bld'));
assert.deepEqual(bld.origin, [846000, 6493000]);
assert.equal(bld.nVerts, 39);
assert.equal(bld.indices.length / 3, 56);
assert.equal(bld.polys.length, 3);
assert.deepEqual(bld.polys.map((p) => p.length).sort(), [1, 1, 2]);   // le L a une cour : 2 anneaux
let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity;
for (let i = 0; i < bld.nVerts; i++) {
    const x = bld.positions[3 * i], z = bld.positions[3 * i + 2];
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
    assert.equal(bld.foot[i], Math.abs(z - 100) < 1e-4 ? 1 : 0, 'pied de mur = sommet au sol');
}
assert.ok(Math.abs(zmin - 100) < 1e-4 && Math.abs(zmax - 109) < 1e-4, 'altitudes NGF absolues');
assert.ok(Math.abs(xmin - 120) < 1e-3 && Math.abs(xmax - 208) < 1e-3, 'coordonnées locales à la dalle');

// fichiers invalides : refusés, jamais lus de travers
const good = load('fake.bld');
assert.throws(() => parseBld(good.slice(0, 100)), /taille inattendue/);
assert.throws(() => parseBld(good.slice(0, 20)), /trop court/);
const bad = good.slice(0); new Uint8Array(bad)[0] = 0x58;
assert.throws(() => parseBld(bad), /signature/);
const badIdx = good.slice(0); new Uint32Array(badIdx, 40 + 12 * 39, 1)[0] = 99999;
assert.throws(() => parseBld(badIdx), /hors limites/);

// --- rastérisation : cellules dont le centre est dans l'emprise ---
// grille de 1 m, 1000 x 1000 : centres en 0,5 / 1,5 ... ; carré 10..20 : 10 x 10 cellules ; trou 13..17 : 4 x 4
const sq = new Float32Array([10, 10, 20, 10, 20, 20, 10, 20]);
const hole = new Float32Array([13, 13, 13, 17, 17, 17, 17, 13]);
const count = (m) => m.reduce((a, v) => a + v, 0);
assert.equal(count(rasterizeFootprints([[sq]], 1000, 1, 0.5, 999.5)), 100);
assert.equal(count(rasterizeFootprints([[sq, hole]], 1000, 1, 0.5, 999.5)), 84);
assert.equal(count(rasterizeFootprints([[sq], [sq]], 1000, 1, 0.5, 999.5)), 100, 'deux polygones se recouvrent : union, pas pair-impair entre eux');
assert.equal(count(rasterizeFootprints([[sq]], 2000, 0.5, 0.25, 999.75)), 400);
assert.equal(count(rasterizeFootprints([[new Float32Array([-50, -50, -40, -50, -40, -40])]], 1000, 1, 0.5, 999.5)), 0, 'hors grille');

// --- dilatation ---
const one = new Uint8Array(25); one[12] = 1;   // grille 5 x 5, cellule centrale
assert.equal(count(dilate(one, 5, 1)), 5, 'rayon 1 : croix');
assert.equal(count(dilate(one, 5, 0)), 1);
assert.equal(count(dilate(one, 5, 2)), 13, 'rayon 2 : disque de 13 cellules');
const corner = new Uint8Array(25); corner[0] = 1;
assert.equal(count(dilate(corner, 5, 1)), 3, 'bord de grille');

// --- masquage du MNS ---
function grids(size) {
    const step = 1000 / size, bbox = [845999.75, 6493000.25, 846999.75, 6494000.25];
    const mnt = new Grid('mnt', size, bbox, new Float32Array(size * size));
    const mns = new Grid('mns', size, bbox, new Float32Array(size * size));
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const x = mnt.x0 + i * step, y = mnt.y0 - j * step, lx = x - 846000, ly = y - 6493000;
            mnt.data[j * size + i] = 100 + 0.02 * lx;                      // terrain en pente
            let over = 5;                                                   // couche au-dessus du sol partout (arbustes)
            if (lx >= 120 && lx <= 140 && ly >= 120 && ly <= 130) { over = 12; }   // bâtiment 1
            if (lx >= 100 && lx <= 104 && ly >= 125 && ly <= 129) { over = 20; }   // arbre, à 16 m du bâtiment
            mns.data[j * size + i] = mnt.data[j * size + i] + over;
        }
    }
    return { mnt: mnt, mns: mns };
}
for (const size of [1000, 2000]) {
    const { mnt, mns } = grids(size), step = 1000 / size;
    const before = mns.data.slice();
    const r = maskSurface(mns, mnt, bld, 1);
    assert.ok(r.grid !== mns && r.grid.data !== mns.data, 'copie');
    assert.ok(r.grid instanceof Grid && r.grid.size === size && r.grid.step === step && r.grid.x0 === mns.x0, 'même type et mêmes champs');
    assert.deepEqual(mns.data, before, 'le MNS d\'origine reste intact (le profil l\'utilise)');
    const cell = (g, lx, ly) => g.data[Math.round((mns.y0 - 6493000 - ly) / step) * size + Math.round((846000 + lx - mns.x0) / step)];
    const gt = (lx, ly) => cell(mnt, lx, ly);
    // sous le bâtiment : le MNT ; arbre et arbustes : inchangés
    assert.equal(cell(r.grid, 130.25, 125.25), gt(130.25, 125.25), size + ' : toit remplacé par le sol');
    assert.equal(cell(r.grid, 102.25, 127.25), cell(mns, 102.25, 127.25), size + ' : arbre intact');
    assert.equal(cell(r.grid, 60.25, 60.25), cell(mns, 60.25, 60.25), size + ' : arbustes intacts');
    // marge d'environ 1 m : cellule à ~0,75 m du mur remplacée, à ~2,75 m inchangée
    assert.equal(cell(r.grid, 119.25, 125.25), gt(119.25, 125.25), size + ' : dans la marge');
    assert.equal(cell(r.grid, 117.25, 125.25), cell(mns, 117.25, 125.25), size + ' : hors marge');
    // cour du bâtiment en L (cour : x 176..186, y 123..129) : le centre n'est pas touché, ses abords oui
    assert.equal(cell(r.grid, 181.25, 126.25), cell(mns, 181.25, 126.25), size + ' : cour intacte');
    assert.equal(cell(r.grid, 176.25, 126.25), gt(176.25, 126.25), size + ' : bord de la cour dans la marge');
    assert.ok(r.covered > 0 && r.covered < size * size / 100);
    // marge nulle : seulement l'emprise
    const r0 = maskSurface(mns, mnt, bld, 0);
    assert.ok(r0.covered < r.covered);
}

// MNT inconnu sous le bâtiment : la cellule garde la valeur du MNS (pas de trou ni de valeur inventée)
{
    const { mnt, mns } = grids(1000);
    mnt.data.fill(NaN);
    const r = maskSurface(mns, mnt, bld, 1);
    assert.equal(r.covered, 0);
    assert.deepEqual(r.grid.data, mns.data);
}
// MNT partiel : pixel le plus proche en repli de l'interpolation
{
    const { mnt, mns } = grids(1000);
    const k = Math.round((mns.y0 - 6493000 - 125.25) / 1) * 1000 + Math.round((846000 + 130.25 - mns.x0) / 1);
    mnt.data[k] = NaN;
    const r = maskSurface(mns, mnt, bld, 1);
    assert.ok(Number.isFinite(r.grid.data[k]), 'repli sur le pixel voisin');
}

// --- branchement dans le module (lecture du source : extension.js dépend du navigateur) ---
const ext = readFileSync(fileURLToPath(new URL('../src/js/extension.js', import.meta.url)), 'utf8');
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../src/plugin.geoext.json', import.meta.url)), 'utf8'));
const settings = manifest.configuration.flatMap((g) => g.elements);
const bldSetting = settings.find((e) => e.key === 'buildingsUrl');
assert.ok(bldSetting && bldSetting.defaultValue === '' && !bldSetting.required, 'réglage buildingsUrl : vide par défaut = désactivé');
// le fragment shader des bâtiments est dérivé de celui de la maquette par remplacement de ces deux lignes : si elles changent, les murs ne seraient plus adaptés
assert.ok(ext.includes("'    if (n.z < 0.0) { n = -n; }',") && ext.includes("'    float l = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.70))), 0.0, 1.0);',"), 'ancres du shader de la maquette');
// sans réglage, rien ne doit se charger ni se masquer
assert.ok(ext.includes("var wantBld = !!(_buildingsUrl && m.buildings);"));
assert.ok(ext.includes('ng-if=\\"bldEnabled\\"') || ext.includes('ng-if="bldEnabled"'), 'case visible seulement si buildingsUrl est réglé');
assert.ok(/t\.bldMesh\.geometry\.dispose\(\); t\.bldMesh\.material\.dispose\(\)/.test(ext), 'bldMesh détruit avec sa dalle');

// --- la fausse donnée du dépôt est à jour avec le convertisseur Python (ignoré sans python3) ---
const py = spawnSync('python3', ['-I', fixture('../../scripts/roofer/cityjsonseq_to_bld.py'), fixture('fake.city.jsonl'),
    '--tile', '0846-6494', '-o', fixture('../../node_modules/.fake-check.bld')], { encoding: 'utf8' });
if (py.status === 0) {
    const a = readFileSync(fixture('fake.bld')), b = readFileSync(fixture('../../node_modules/.fake-check.bld'));
    assert.ok(a.equals(b), 'test/fixtures/fake.bld périmé : relancer scripts/roofer/cityjsonseq_to_bld.py');
} else {
    console.log('buildings : python3 indisponible, régénération de fake.bld ignorée');
}
console.log('buildings : OK');
