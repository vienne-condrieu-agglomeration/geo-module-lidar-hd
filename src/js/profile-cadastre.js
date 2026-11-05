// Positions du cadastre le long d'un tracé de profil : limites de parcelles traversées et longueurs situées dans un
// bâtiment, en distance depuis le début du tracé (m). Coordonnées planes (Lambert-93).
//
// Ce fichier ne dépend ni d'iTowns ni du navigateur, pour être testé sous Node (test/profile-cadastre.test.mjs).
//   segs  : tronçons du tracé { x, y, ux, uy, len, cum }
//   polys : polygones, chacun étant une liste d'anneaux [[x, y], ...] (extérieur puis trous)

// Tolérance de regroupement (m) : deux parcelles voisines ne partagent pas toujours exactement les mêmes sommets.
var SAME_LIMIT = 0.2;

function ringsBox(rings) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    rings.forEach(function (ring) {
        ring.forEach(function (c) {
            if (c[0] < b[0]) { b[0] = c[0]; }
            if (c[1] < b[1]) { b[1] = c[1]; }
            if (c[0] > b[2]) { b[2] = c[0]; }
            if (c[1] > b[3]) { b[3] = c[1]; }
        });
    });
    return b;
}

function segHitsBox(seg, b) {
    var x1 = seg.x + seg.ux * seg.len, y1 = seg.y + seg.uy * seg.len;
    return Math.max(seg.x, x1) >= b[0] && Math.min(seg.x, x1) <= b[2] &&
           Math.max(seg.y, y1) >= b[1] && Math.min(seg.y, y1) <= b[3];
}

// Distances le long du tronçon (0 à len) où il coupe les arêtes des anneaux.
function crossings(seg, rings) {
    var out = [];
    rings.forEach(function (ring) {
        for (var i = 0; i < ring.length - 1; i++) {
            var ax = ring[i][0], ay = ring[i][1], ex = ring[i + 1][0] - ax, ey = ring[i + 1][1] - ay;
            var den = seg.ux * ey - seg.uy * ex;
            if (Math.abs(den) < 1e-12) { continue; }   // arête parallèle au tronçon
            var dx = ax - seg.x, dy = ay - seg.y;
            var t = (dx * ey - dy * ex) / den, u = (dx * seg.uy - dy * seg.ux) / den;
            if (t >= 0 && t <= seg.len && u >= 0 && u <= 1) { out.push(t); }
        }
    });
    return out;
}

// Pair-impair sur tous les anneaux : un point dans un trou n'est pas dans le polygone.
function pointInPoly(x, y, rings) {
    var inside = false;
    rings.forEach(function (ring) {
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var yi = ring[i][1], yj = ring[j][1];
            if ((yi > y) !== (yj > y) && x < (ring[j][0] - ring[i][0]) * (y - yi) / (yj - yi) + ring[i][0]) { inside = !inside; }
        }
    });
    return inside;
}

// Distances des limites de parcelles traversées, triées et sans doublon.
function parcelLimits(segs, polys, sameLimit) {
    var tol = sameLimit === undefined ? SAME_LIMIT : sameLimit, all = [];
    polys.forEach(function (rings) {
        var box = ringsBox(rings);
        segs.forEach(function (seg) {
            if (!segHitsBox(seg, box)) { return; }
            crossings(seg, rings).forEach(function (t) { all.push(seg.cum + t); });
        });
    });
    all.sort(function (a, b) { return a - b; });
    var out = [];
    all.forEach(function (s) { if (!out.length || s - out[out.length - 1] > tol) { out.push(s); } });
    return out;
}

// Longueurs du tracé situées dans un bâtiment : [[début, fin], ...], triées et fusionnées.
function buildingSpans(segs, polys) {
    var spans = [];
    polys.forEach(function (rings) {
        var box = ringsBox(rings);
        segs.forEach(function (seg) {
            if (!segHitsBox(seg, box)) { return; }
            var cuts = [0, seg.len].concat(crossings(seg, rings)).sort(function (a, b) { return a - b; });
            for (var i = 0; i < cuts.length - 1; i++) {
                var a = cuts[i], b = cuts[i + 1];
                if (b - a < 1e-6) { continue; }
                var mid = (a + b) / 2;
                if (pointInPoly(seg.x + seg.ux * mid, seg.y + seg.uy * mid, rings)) { spans.push([seg.cum + a, seg.cum + b]); }
            }
        });
    });
    spans.sort(function (p, q) { return p[0] - q[0]; });
    var out = [];
    spans.forEach(function (s) {
        var last = out[out.length - 1];
        if (last && s[0] <= last[1] + 1e-3) { last[1] = Math.max(last[1], s[1]); } else { out.push([s[0], s[1]]); }
    });
    return out;
}

// Positions où le curseur s'accroche : limites de parcelles et bords de bâti, triées. Le bout d'une longueur coupée par
// le début ou la fin du tracé n'est pas un bord de bâtiment.
function snapTargets(limits, spans, length) {
    var out = limits.map(function (s) { return { s: s, type: 'limit' }; });
    spans.forEach(function (sp) {
        if (sp[0] > 0.01) { out.push({ s: sp[0], type: 'building' }); }
        if (sp[1] < length - 0.01) { out.push({ s: sp[1], type: 'building' }); }
    });
    return out.sort(function (a, b) { return a.s - b.s; });
}

// Position la plus proche à moins de `tol` (m), ou null. Une limite et un bord de bâti presque confondus : la limite.
function nearestSnap(targets, s, tol) {
    var best = null, bestD = Infinity;
    targets.forEach(function (t) {
        var dist = Math.abs(t.s - s);
        if (dist > tol) { return; }
        if (best && Math.abs(best.s - t.s) <= SAME_LIMIT) {
            if (t.type === 'limit' && best.type !== 'limit') { best = t; bestD = dist; }
            else if (t.type === best.type && dist < bestD) { best = t; bestD = dist; }
            return;
        }
        if (dist < bestD) { best = t; bestD = dist; }
    });
    return best;
}

export { parcelLimits, buildingSpans, pointInPoly, snapTargets, nearestSnap };
