import assert from 'node:assert/strict';
import { parcelLimits, buildingSpans, pointInPoly, snapTargets, nearestSnap } from '../src/js/profile-cadastre.js';

function seg(x, y, ux, uy, len, cum) { return { x, y, ux, uy, len, cum }; }
function box(x0, y0, x1, y1) { return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]; }
const line = [seg(0, 0, 1, 0, 100, 0)];                       // de (0,0) à (100,0)
const elbow = [seg(0, 0, 1, 0, 50, 0), seg(50, 0, 0, 1, 50, 50)];   // puis de (50,0) à (50,50)
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' != ' + b);

// Une parcelle traversée : deux limites
let l = parcelLimits(line, [box(10, -5, 30, 5)]);
assert.equal(l.length, 2); near(l[0], 10); near(l[1], 30);

// Deux parcelles voisines : leur limite commune compte une fois, même avec un léger écart de sommets
l = parcelLimits(line, [box(10, -5, 30, 5), box(30.1, -5, 50, 5)]);
assert.deepEqual(l.map(Math.round), [10, 30, 50]);

// Écart plus grand que la tolérance : deux limites distinctes
assert.equal(parcelLimits(line, [box(10, -5, 30, 5), box(31, -5, 50, 5)]).length, 4);

// Parcelle hors du tracé, ou tracé entièrement dedans : aucune limite
assert.equal(parcelLimits(line, [box(10, 5, 30, 9)]).length, 0);
assert.equal(parcelLimits(line, [box(-5, -5, 200, 5)]).length, 0);

// Tracé le long d'une arête : pas de croisement faux au milieu de l'arête parallèle
assert.deepEqual(parcelLimits(line, [box(10, 0, 30, 5)]).map(Math.round), [10, 30]);

// Distance cumulée sur un tracé à deux tronçons
l = parcelLimits(elbow, [box(40, 10, 60, 20)]);
assert.deepEqual(l.map(Math.round), [60, 70]);

// Bâtiment traversé
let s = buildingSpans(line, [box(10, -5, 30, 5)]);
assert.equal(s.length, 1); near(s[0][0], 10); near(s[0][1], 30);

// Tracé qui commence et finit dans le bâtiment
s = buildingSpans(line, [box(-10, -5, 200, 5)]);
assert.equal(s.length, 1); near(s[0][0], 0); near(s[0][1], 100);

// Bâtiment avec cour intérieure : deux longueurs
const court = [box(10, -10, 50, 10)[0], box(20, -5, 40, 5)[0]];
s = buildingSpans(line, [court]);
assert.deepEqual(s.map((q) => q.map(Math.round)), [[10, 20], [40, 50]]);

// Deux bâtiments mitoyens : une seule longueur
s = buildingSpans(line, [box(10, -5, 30, 5), box(30, -5, 50, 5)]);
assert.deepEqual(s.map((q) => q.map(Math.round)), [[10, 50]]);

// Bâtiment à cheval sur un coude : fusion à travers le sommet du tracé
s = buildingSpans(elbow, [box(40, -5, 60, 20)]);
assert.deepEqual(s.map((q) => q.map(Math.round)), [[40, 70]]);

// Bâtiment en U traversé deux fois
const u = [[[10, -10], [50, -10], [50, 10], [40, 10], [40, -5], [20, -5], [20, 10], [10, 10], [10, -10]]];
s = buildingSpans(line, [u]);
assert.deepEqual(s.map((q) => q.map(Math.round)), [[10, 20], [40, 50]]);

assert.equal(pointInPoly(30, 0, court), false);
assert.equal(pointInPoly(15, 0, court), true);
// Accroche : limites et bords de bâti, sans les bouts coupés par le tracé
const tg = snapTargets([20, 60], [[0, 10], [30, 40], [90, 100]], 100);
assert.deepEqual(tg.map((t) => t.s), [10, 20, 30, 40, 60, 90]);
assert.equal(nearestSnap(tg, 21, 2).s, 20);
assert.equal(nearestSnap(tg, 21, 2).type, 'limit');
assert.equal(nearestSnap(tg, 31, 2).type, 'building');
assert.equal(nearestSnap(tg, 25, 2), null);
assert.equal(nearestSnap([], 25, 2), null);
// Limite et bord de bâti confondus : la limite gagne, même un peu plus loin
const both = snapTargets([50.1], [[50, 70]], 100);
assert.equal(nearestSnap(both, 49.9, 1).type, 'limit');
assert.equal(nearestSnap(both, 49.9, 1).s, 50.1);

console.log('profile-cadastre : OK');
