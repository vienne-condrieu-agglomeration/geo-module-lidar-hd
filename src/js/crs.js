// Projections proposées par le module : catalogue et lecture du réglage « crsList » du Générateur.
// Ce fichier ne dépend ni d'iTowns ni du navigateur : test/crs.test.mjs compare ses définitions à des valeurs de PROJ.
// Lambert-93 (dalles, calculs) et WGS84 (WFS, carte) restent utilisés en interne, quelle que soit la liste.

var GRS80 = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

// Coniques conformes 9 zones du RGF93 : CC42 (EPSG:3942) à CC50 (EPSG:3950).
function conicConformal(zone) {
    return '+proj=lcc +lat_0=' + zone + ' +lon_0=3 +lat_1=' + (zone - 0.75) + ' +lat_2=' + (zone + 0.75) +
           ' +x_0=1700000 +y_0=' + ((zone - 41) * 1000000 + 200000) + ' ' + GRS80;
}

var CATALOG = [
    { code: 'EPSG:2154', name: 'Lambert-93', short: 'L93',
      def: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 ' + GRS80 }
];
for (var zone = 42; zone <= 50; zone++) {
    CATALOG.push({ code: 'EPSG:' + (3900 + zone), name: 'CC' + zone, short: 'CC' + zone, def: conicConformal(zone) });
}
CATALOG.push({ code: 'EPSG:4326', name: 'WGS84', short: 'WGS84', degrees: true, def: null });   // déjà connue de proj4

var DEFAULT_LIST = CATALOG.map(function (c) { return c.code; }).join(',');

// Élément des listes déroulantes.
function crsItem(entry) {
    return {
        code: entry.code, short: entry.short, name: entry.name, degrees: !!entry.degrees,
        label: entry.name + ' (' + entry.code + ')' + (entry.degrees ? ', degrés' : '')
    };
}

// Lit le réglage : codes séparés par des virgules, points-virgules ou espaces, dans l'ordre saisi, sans doublon.
// Retourne { items, unknown, fallback } ; fallback : aucun code valide, la liste par défaut est reprise.
function parseCrsList(text) {
    var items = [], unknown = [], seen = {};
    String(text === undefined || text === null ? '' : text).split(/[\s,;]+/).forEach(function (raw) {
        if (!raw) { return; }
        var code = /^\d+$/.test(raw) ? 'EPSG:' + raw : raw.toUpperCase();
        var entry = CATALOG.filter(function (c) { return c.code === code; })[0];
        if (!entry) { unknown.push(raw); return; }
        if (!seen[code]) { seen[code] = true; items.push(crsItem(entry)); }
    });
    var fallback = !items.length;
    return { items: fallback ? CATALOG.map(crsItem) : items, unknown: unknown, fallback: fallback };
}

// Choix mémorisé s'il reste dans la liste, sinon le premier code.
function pickDefault(items, saved) {
    return items.some(function (c) { return c.code === saved; }) ? saved : items[0].code;
}

export { CATALOG, DEFAULT_LIST, parseCrsList, pickDefault };
