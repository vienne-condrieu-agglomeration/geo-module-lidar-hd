import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { CATALOG, DEFAULT_LIST, parseCrsList, pickDefault } from '../src/js/crs.js';

// Valeurs de référence calculées avec PROJ 9.9.0 (pyproj, EPSG:4326 vers le code, lon/lat) : [nom, lon, lat, x, y]
const REF = {
    'EPSG:2154': [["Vienne", 4.874, 45.525, 846272.5418, 6493460.378], ["Oise", 2.5, 49.4, 663696.0791, 6922394.3344], ["Pau", -0.37, 43.3, 426467.9675, 6250374.9908], ["Lille", 3.06, 50.63, 704252.441, 7059225.8748], ["Nice", 7.26, 43.7, 1043310.2914, 6298259.4456], ["Strasbourg", 7.75, 48.58, 1050163.9436, 6841622.7155]],
    'EPSG:3942': [["Vienne", 4.874, 45.525, 1846660.8053, 1593475.6078], ["Oise", 2.5, 49.4, 1663394.5303, 2024872.7864], ["Pau", -0.37, 43.3, 1426571.0977, 1349793.2177], ["Lille", 3.06, 50.63, 1704295.8316, 2162979.0641], ["Nice", 7.26, 43.7, 2043376.0452, 1397407.8883], ["Strasbourg", 7.75, 48.58, 2052670.7023, 1942657.8228]],
    'EPSG:3943': [["Vienne", 4.874, 45.525, 1846522.3434, 2482273.067], ["Oise", 2.5, 49.4, 1663475.9166, 2912960.8993], ["Pau", -0.37, 43.3, 1426640.5862, 2238809.5984], ["Lille", 3.06, 50.63, 1704284.4442, 3050728.6798], ["Nice", 7.26, 43.7, 2043244.3594, 2286469.5841], ["Strasbourg", 7.75, 48.58, 2051978.1529, 2831104.2283]],
    'EPSG:3944': [["Vienne", 4.874, 45.525, 1846430.3152, 3371138.0337], ["Oise", 2.5, 49.4, 1663544.8387, 3801258.6016], ["Pau", -0.37, 43.3, 1426626.6944, 3127816.6174], ["Lille", 3.06, 50.63, 1704274.5568, 3938735.5444], ["Nice", 7.26, 43.7, 2043218.0637, 3175535.4852], ["Strasbourg", 7.75, 48.58, 2051403.7626, 3719728.8332]],
    'EPSG:3945': [["Vienne", 4.874, 45.525, 1846383.9309, 4260035.5866], ["Oise", 2.5, 49.4, 1663601.5271, 4689728.44], ["Pau", -0.37, 43.3, 1426530.7764, 4016780.6538], ["Lille", 3.06, 50.63, 1704266.1409, 4826961.3096], ["Nice", 7.26, 43.7, 2043295.4333, 4064571.77], ["Strasbourg", 7.75, 48.58, 2050945.3862, 4608494.8344]],
    'EPSG:3946': [["Vienne", 4.874, 45.525, 1846382.405, 5148931.3845], ["Oise", 2.5, 49.4, 1663646.2093, 5578333.5673], ["Pau", -0.37, 43.3, 1426354.1879, 4905668.6611], ["Lille", 3.06, 50.63, 1704259.1684, 5715368.2462], ["Nice", 7.26, 43.7, 2043474.7436, 4953545.1883], ["Strasbourg", 7.75, 48.58, 2050600.9046, 5497366.0188]],
    'EPSG:3947': [["Vienne", 4.874, 45.525, 1846424.9523, 6037791.6842], ["Oise", 2.5, 49.4, 1663679.1105, 6467037.7507], ["Pau", -0.37, 43.3, 1426098.2911, 5794448.1898], ["Lille", 3.06, 50.63, 1704253.6117, 6603919.2509], ["Nice", 7.26, 43.7, 2043754.2632, 5842423.0834], ["Strasbourg", 7.75, 48.58, 2050368.2176, 6386306.7736]],
    'EPSG:3948': [["Vienne", 4.874, 45.525, 1846510.7858, 6926583.3617], ["Oise", 2.5, 49.4, 1663700.4538, 7355805.3846], ["Pau", -0.37, 43.3, 1425764.4611, 6683087.4142], ["Lille", 3.06, 50.63, 1704249.4433, 7492577.8553], ["Nice", 7.26, 43.7, 2044132.2467, 6731173.4172], ["Strasbourg", 7.75, 48.58, 2050245.2366, 7275282.1011]],
    'EPSG:3949': [["Vienne", 4.874, 45.525, 1846639.1128, 7815273.9384], ["Oise", 2.5, 49.4, 1663710.4617, 8244601.5067], ["Pau", -0.37, 43.3, 1425354.0919, 7571555.1633], ["Lille", 3.06, 50.63, 1704246.636, 8381308.2388], ["Nice", 7.26, 43.7, 2044606.927, 7619764.801], ["Strasbourg", 7.75, 48.58, 2050229.8767, 8164257.636]],
    'EPSG:3950': [["Vienne", 4.874, 45.525, 1846809.1316, 8703831.6106], ["Oise", 2.5, 49.4, 1663709.3568, 9133391.8173], ["Pau", -0.37, 43.3, 1424868.6028, 8459820.9571], ["Lille", 3.06, 50.63, 1704245.1626, 9270075.2454], ["Nice", 7.26, 43.7, 2045176.507, 8508166.5294], ["Strasbourg", 7.75, 48.58, 2050320.048, 9053199.6678]]
};

for (const c of CATALOG) { if (c.def) { proj4.defs(c.code, c.def); } }
for (const [code, rows] of Object.entries(REF)) {
    for (const [name, lon, lat, x, y] of rows) {
        const got = proj4('EPSG:4326', code, [lon, lat]);
        assert.ok(Math.hypot(got[0] - x, got[1] - y) < 0.01, `${code} ${name} : ${got} au lieu de ${x}, ${y}`);
    }
}

const codes = (r) => r.items.map((c) => c.code);
// Liste par défaut : les 11 projections demandées
assert.equal(DEFAULT_LIST, 'EPSG:2154,EPSG:3942,EPSG:3943,EPSG:3944,EPSG:3945,EPSG:3946,EPSG:3947,EPSG:3948,EPSG:3949,EPSG:3950,EPSG:4326');
assert.equal(parseCrsList(DEFAULT_LIST).items.length, 11);
// Ordre saisi, espaces, casse, numéros seuls, séparateurs et doublons
assert.deepEqual(codes(parseCrsList(' epsg:3946 , 2154;EPSG:3946 4326')), ['EPSG:3946', 'EPSG:2154', 'EPSG:4326']);
// Code inconnu : ignoré et signalé
let r = parseCrsList('EPSG:2154,EPSG:27572,n importe');
assert.deepEqual(codes(r), ['EPSG:2154']);
assert.deepEqual(r.unknown, ['EPSG:27572', 'n', 'importe']);
assert.equal(r.fallback, false);
// Vide ou entièrement invalide : liste par défaut
for (const text of ['', '   ', null, undefined, 'EPSG:1,EPSG:2']) {
    r = parseCrsList(text);
    assert.equal(r.fallback, true);
    assert.equal(r.items.length, 11);
}
// Libellés, degrés et noms courts
const items = parseCrsList('EPSG:3947,EPSG:4326').items;
assert.equal(items[0].label, 'CC47 (EPSG:3947)');
assert.equal(items[0].short, 'CC47');
assert.equal(items[1].degrees, true);
assert.equal(items[1].label, 'WGS84 (EPSG:4326), degrés');
// Choix mémorisé valide, sinon premier code
assert.equal(pickDefault(items, 'EPSG:4326'), 'EPSG:4326');
assert.equal(pickDefault(items, 'EPSG:2154'), 'EPSG:3947');
assert.equal(pickDefault(items, null), 'EPSG:3947');
console.log('crs : OK');
