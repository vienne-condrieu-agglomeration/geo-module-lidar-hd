#!/usr/bin/env python3
"""Convertit la sortie CityJSONSeq de roofer en fichier « .bld » lu par le module geo-lidar-hd.

Usage :
    python3 -I cityjsonseq_to_bld.py ENTREE.city.jsonl [ENTREE2...] --tile 0846-6494 -o 0846-6494.bld

Le format .bld est décrit dans GUIDE-DEV.md (section « Bâtiments LoD2 »). Bibliothèque standard seulement.

Ce que la sortie de roofer (v1.0.0, vérifié) fournit et ce que le script en fait :
- la première ligne porte `transform` (échelle + translation) : sans elle (option `--omit-metadata` de roofer), le script
  s'arrête au lieu de deviner l'échelle ;
- chaque BuildingPart a une géométrie « Solid » de LoD 2.2 dont les faces sont étiquetées par `semantics`
  (GroundSurface, WallSurface, RoofSurface) ; une face peut avoir des trous (anneaux suivants) ;
- les faces GroundSurface ne sont pas dessinées (le sol du bâtiment est le terrain) : elles donnent les pieds de mur
  (sommets du sol) et les emprises (anneaux XY, trous compris) ;
- un bâtiment sans géométrie (extrusion_mode « skip ») est ignoré ; un bâtiment sans sémantique GroundSurface est écrit
  quand même, mais sans pieds de mur ni emprise, et signalé.
"""
import argparse
import json
import math
import re
import struct
import sys

MAGIC = b'BLD1'
HEADER = struct.Struct('<4sIIIIIdd')   # magic, nVerts, nIdx, nPolys, nRings, nPts, originX, originY


# ---------------------------------------------------------------------------
# Triangulation d'une face 3D (anneau extérieur + trous) : projection sur le plan, pont vers chaque trou, découpe
# en oreilles.
# ---------------------------------------------------------------------------

def _area2(pts):
    """Deux fois l'aire signée d'un anneau 2D [(u, v), ...] (positive si antihoraire)."""
    s = 0.0
    n = len(pts)
    for i in range(n):
        u1, v1 = pts[i]
        u2, v2 = pts[(i + 1) % n]
        s += u1 * v2 - u2 * v1
    return s


def _newell(ring):
    """Normale (non normalisée) d'un anneau 3D, méthode de Newell."""
    nx = ny = nz = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1, z1 = ring[i]
        x2, y2, z2 = ring[(i + 1) % n]
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    return nx, ny, nz


def _seg_cross(a, b, c, d):
    """Vrai si les segments ab et cd se coupent en leur intérieur (les extrémités communes ne comptent pas)."""
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return ((o1 > 0) != (o2 > 0)) and ((o3 > 0) != (o4 > 0)) and o1 != 0 and o2 != 0 and o3 != 0 and o4 != 0


def _in_ring(p, ring):
    """Point dans un anneau 2D (pair-impair)."""
    inside = False
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        if (a[1] > p[1]) != (b[1] > p[1]):
            if p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
    return inside


def _in_wedge(prev, cur, nxt, target):
    """Le point `target` est-il dans le coin intérieur du sommet `cur` ? Les anneaux ont la matière à gauche du parcours
    (extérieur antihoraire, trous horaires) ; les sommets sont (id, u, v). Indispensable quand un sommet apparaît
    plusieurs fois dans l'anneau fusionné (extrémité d'un pont déjà posé) : il faut choisir la bonne occurrence."""
    def cr(a, b):
        return a[0] * b[1] - a[1] * b[0]
    dn = (nxt[1] - cur[1], nxt[2] - cur[2])
    dp = (prev[1] - cur[1], prev[2] - cur[2])
    dt = (target[1] - cur[1], target[2] - cur[2])
    if cr(dn, dp) > 0:   # coin convexe (moins de 180°)
        return cr(dn, dt) > 0 and cr(dt, dp) > 0
    return not (cr(dp, dt) >= 0 and cr(dt, dn) >= 0)


def _bridge(merged, hole, others):
    """Relie un trou (CW) à l'anneau fusionné (CCW). Les sommets sont (id, u, v). Renvoie l'anneau fusionné.

    Cherche la paire (sommet de l'anneau, sommet du trou) la plus courte dont le segment ne coupe aucun bord et passe
    à l'intérieur de la matière (dans l'anneau, hors du trou).
    """
    edges = []
    for ring in [merged, hole] + others:
        n = len(ring)
        edges.extend((ring[i], ring[(i + 1) % n]) for i in range(n))
    hole_xy = [(p[1], p[2]) for p in hole]
    merged_xy = [(p[1], p[2]) for p in merged]
    best = None
    for i, m in enumerate(merged):
        for j, h in enumerate(hole):
            d = (m[1] - h[1]) ** 2 + (m[2] - h[2]) ** 2
            if best is not None and d >= best[0]:
                continue
            if not _in_wedge(merged[i - 1], m, merged[(i + 1) % len(merged)], h) or \
                    not _in_wedge(hole[j - 1], h, hole[(j + 1) % len(hole)], m):
                continue
            a, b = (m[1], m[2]), (h[1], h[2])
            if any(_seg_cross(a, b, (e0[1], e0[2]), (e1[1], e1[2])) for e0, e1 in edges):
                continue
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if not _in_ring(mid, merged_xy) or _in_ring(mid, hole_xy):
                continue
            best = (d, i, j)
    if best is None:
        return None
    _, i, j = best
    return merged[:i + 1] + hole[j:] + hole[:j + 1] + merged[i:]


def _ear_clip(poly):
    """Découpe en oreilles un anneau 2D antihoraire [(id, u, v), ...] (doublons de pont admis).

    Renvoie (triangles [(id, id, id)], dégradé). `dégradé` est vrai si une oreille a dû être forcée.
    """
    n = len(poly)
    prev = [(i - 1) % n for i in range(n)]
    nxt = [(i + 1) % n for i in range(n)]
    alive = n
    tris = []
    degraded = False
    cur = 0

    def cross(a, b, c):
        return (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])

    def is_ear(i):
        a, b, c = poly[prev[i]], poly[i], poly[nxt[i]]
        if cross(a, b, c) <= 1e-12:
            return False
        k = nxt[nxt[i]]
        while k != prev[i]:
            p = poly[k]
            same = any(p[1] == q[1] and p[2] == q[2] for q in (a, b, c))
            if not same:
                c1, c2, c3 = cross(a, b, p), cross(b, c, p), cross(c, a, p)
                if c1 >= 0 and c2 >= 0 and c3 >= 0:
                    return False
            k = nxt[k]
        return True

    def remove(i):
        nxt[prev[i]] = nxt[i]
        prev[nxt[i]] = prev[i]

    while alive > 3:
        found = None
        i = cur
        for _ in range(alive):
            if is_ear(i):
                found = i
                break
            i = nxt[i]
        if found is None:
            # pas d'oreille stricte : on retire d'abord un sommet aligné (triangle plat, rien à dessiner)
            i = cur
            for _ in range(alive):
                a, b, c = poly[prev[i]], poly[i], poly[nxt[i]]
                if abs(cross(a, b, c)) <= 1e-9:
                    found = i
                    break
                i = nxt[i]
            if found is not None:
                cur = nxt[found]
                remove(found)
                alive -= 1
                continue
            # dernier recours : sommet le plus convexe, signalé
            degraded = True
            best, bi = -1e300, cur
            i = cur
            for _ in range(alive):
                cv = cross(poly[prev[i]], poly[i], poly[nxt[i]])
                if cv > best:
                    best, bi = cv, i
                i = nxt[i]
            found = bi
        a, b, c = poly[prev[found]], poly[found], poly[nxt[found]]
        tris.append((a[0], b[0], c[0]))
        cur = nxt[found]
        remove(found)
        alive -= 1
    if alive == 3:
        a, b, c = poly[cur], poly[nxt[cur]], poly[nxt[nxt[cur]]]
        if abs(cross(a, b, c)) > 1e-9:
            tris.append((a[0], b[0], c[0]))
    return tris, degraded


def triangulate_face(rings):
    """rings : [[(id, x, y, z), ...], ...] anneau extérieur puis trous.

    Renvoie (triangles [(id, id, id)], aire 3D attendue, dégradé). Les triangles gardent le sens de parcours de la face.
    """
    outer = rings[0]
    if len(outer) < 3:
        return [], 0.0, False
    nx, ny, nz = _newell([p[1:] for p in outer])
    mags = [abs(nx), abs(ny), abs(nz)]
    k = mags.index(max(mags))
    if mags[k] < 1e-9:
        return [], 0.0, False   # face dégénérée (aire nulle)
    # projection qui garde le sens : l'orientation 2D est celle de la normale si sa composante k est positive
    def proj(p):
        if k == 0:
            return (p[2], p[3])
        if k == 1:
            return (p[3], p[1])
        return (p[1], p[2])

    def to2d(ring):
        out = []
        for p in ring:   # sommets consécutifs confondus (fréquents dans la sortie de roofer) : un seul
            q = (p[0],) + proj(p)
            if not out or (out[-1][1], out[-1][2]) != (q[1], q[2]):
                out.append(q)
        if len(out) > 1 and (out[0][1], out[0][2]) == (out[-1][1], out[-1][2]):
            out.pop()
        return out

    o2 = to2d(outer)
    flipped = _area2([(p[1], p[2]) for p in o2]) < 0
    if flipped:
        o2.reverse()
    holes = []
    for h in rings[1:]:
        if len(h) < 3:
            continue
        h2 = to2d(h)
        if _area2([(p[1], p[2]) for p in h2]) > 0:
            h2.reverse()   # les trous sont horaires
        holes.append(h2)
    merged = o2
    for idx, h in enumerate(holes):
        merged = _bridge(merged, h, holes[idx + 1:])
        if merged is None:
            return [], 0.0, True   # pont impossible : face abandonnée, signalée par l'appelant
    tris, degraded = _ear_clip(merged)
    if flipped:
        tris = [(t[0], t[2], t[1]) for t in tris]
    # aire 3D attendue = |normale de Newell| / 2 pour l'anneau extérieur, moins celle des trous
    area = math.sqrt(nx * nx + ny * ny + nz * nz) / 2.0
    for h in rings[1:]:
        if len(h) >= 3:
            hx, hy, hz = _newell([p[1:] for p in h])
            area -= math.sqrt(hx * hx + hy * hy + hz * hz) / 2.0
    return tris, area, degraded


def triangulation_error(rings, tris):
    """Erreur relative de la triangulation d'une face : écart entre l'aire du polygone et la somme de celle des triangles, toutes
    deux projetées dans le plan de la triangulation. Exacte (nulle) pour n'importe quelle triangulation correcte, que la face soit
    plane ou gauchie ; grande si des triangles sortent du polygone ou s'il en manque. rings : comme triangulate_face."""
    nx, ny, nz = _newell([p[1:] for p in rings[0]])
    mags = [abs(nx), abs(ny), abs(nz)]
    k = mags.index(max(mags))
    if mags[k] < 1e-9:
        return 0.0
    def proj(p):
        return (p[2], p[3]) if k == 0 else ((p[3], p[1]) if k == 1 else (p[1], p[2]))
    polygon = abs(_area2([proj(p) for p in rings[0]])) / 2.0
    for h in rings[1:]:
        if len(h) >= 3:
            polygon -= abs(_area2([proj(p) for p in h])) / 2.0
    xy = {p[0]: proj(p) for r in rings for p in r}
    got = 0.0
    for a, b, c in tris:
        got += abs(_area2([xy[a], xy[b], xy[c]])) / 2.0
    return abs(got - polygon) / polygon if polygon > 1e-12 else 0.0


def tri_area3d(tris, coords):
    """Somme des aires 3D des triangles (coords : id -> (x, y, z))."""
    s = 0.0
    for a, b, c in tris:
        pa, pb, pc = coords[a], coords[b], coords[c]
        ux, uy, uz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
        vx, vy, vz = pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]
        cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        s += math.sqrt(cx * cx + cy * cy + cz * cz) / 2.0
    return s


# ---------------------------------------------------------------------------
# Lecture de la CityJSONSeq de roofer
# ---------------------------------------------------------------------------

def tile_bbox(name):
    """Dalle « XXXX-YYYY » = coin nord-ouest en km (Lambert-93) -> [xmin, ymin, xmax, ymax]."""
    m = re.fullmatch(r'(\d{4})-(\d{4})', name or '')
    if not m:
        raise ValueError('nom de dalle attendu « XXXX-YYYY » (ex. 0846-6494), reçu : %r' % name)
    x, y = int(m.group(1)) * 1000, int(m.group(2)) * 1000
    return [x, y - 1000, x + 1000, y]


class Stats(object):
    def __init__(self):
        self.buildings = 0       # bâtiments écrits
        self.no_geometry = 0     # sans géométrie du LoD demandé (ex. extrusion_mode « skip »)
        self.outside = 0         # hors de la dalle (centre hors emprise)
        self.no_ground = 0       # écrits sans sémantique GroundSurface
        self.zero_area = 0       # faces d'aire nulle ignorées (murs à sommets confondus, fréquents dans la sortie de roofer)
        self.bad_faces = 0       # faces non triangulées alors qu'elles ont une aire (pont vers un trou impossible)
        self.degraded = 0        # faces dont une oreille a été forcée
        self.area_mismatch = 0   # faces dont l'aire triangulée s'écarte de plus de 1 %
        self.other_types = 0     # géométries ni Solid ni MultiSurface


def _surfaces(geom):
    """Itère (face, type sémantique) d'une géométrie Solid ou MultiSurface ; face = liste d'anneaux d'indices."""
    sem = geom.get('semantics') or {}
    surfaces = sem.get('surfaces') or []
    values = sem.get('values')
    if geom['type'] == 'Solid':
        faces = [f for shell in geom['boundaries'] for f in shell]
        vals = [v for shell in values for v in shell] if values else [None] * len(faces)
    else:   # MultiSurface
        faces = geom['boundaries']
        vals = values if values else [None] * len(faces)
    for face, v in zip(faces, vals):
        yield face, (surfaces[v]['type'] if v is not None and v < len(surfaces) else None)


def convert(paths, tile, lod='2.2', log=None):
    """Lit les CityJSONSeq et renvoie (dictionnaire du .bld, Stats). `log(message)` reçoit les avertissements."""
    log = log or (lambda m: None)
    bbox = tile_bbox(tile)
    ox, oy = float(bbox[0]), float(bbox[1])
    st = Stats()
    pos, idx, foot = [], [], []
    polys = []   # [[ring XY locaux, ...], ...]

    for path in paths:
        transform = None
        with open(path, 'r', encoding='utf-8') as fh:
            for ln, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if obj.get('type') == 'CityJSON':
                    transform = obj.get('transform')
                    continue
                if obj.get('type') != 'CityJSONFeature':
                    continue
                t = obj.get('transform') or transform
                if not t:
                    raise SystemExit('%s:%d : pas de « transform » (ligne de métadonnées absente : roofer lancé avec '
                                     '--omit-metadata ?). Échelle inconnue, rien n\'est deviné.' % (path, ln))
                sc, tr = t['scale'], t['translate']
                verts = [(v[0] * sc[0] + tr[0], v[1] * sc[1] + tr[1], v[2] * sc[2] + tr[2]) for v in obj['vertices']]
                for name, co in obj['CityObjects'].items():
                    if co.get('type') not in ('BuildingPart', 'Building'):
                        continue
                    geoms = [g for g in co.get('geometry', []) if str(g.get('lod')) == lod]
                    if not geoms:
                        if co.get('type') == 'BuildingPart' or not co.get('children'):
                            st.no_geometry += 1
                        continue
                    for g in geoms:
                        if g['type'] not in ('Solid', 'MultiSurface'):
                            st.other_types += 1
                            continue
                        _add_geometry(g, name, verts, (ox, oy), bbox, pos, idx, foot, polys, st, log)

    nv = len(pos) // 3
    data = {'nVerts': nv, 'positions': pos, 'indices': idx, 'foot': foot, 'polys': polys, 'origin': (ox, oy)}
    return data, st


def _add_geometry(g, name, verts, origin, bbox, pos, idx, foot, polys, st, log):
    ox, oy = origin
    faces = list(_surfaces(g))
    ground = [f for f, ty in faces if ty == 'GroundSurface']
    has_sem = bool(ground)
    # centre du bâtiment : emprise du sol si connue, sinon tous les sommets utilisés
    if ground:
        pts = [verts[i] for f in ground for i in f[0]]
    else:
        pts = [verts[i] for f, _ in faces for r in f for i in r]
    if not pts:
        return
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    if not (bbox[0] <= cx < bbox[2] and bbox[1] <= cy < bbox[3]):
        st.outside += 1
        return
    if not has_sem:
        st.no_ground += 1
        log('%s : pas de surface GroundSurface (sémantique absente) : écrit sans pieds de mur ni emprise' % name)

    foot_ids = set(i for f in ground for r in f for i in r)
    remap = {}

    def vid(i):
        if i not in remap:
            x, y, z = verts[i]
            remap[i] = len(pos) // 3
            pos.extend((x - ox, y - oy, z))
            foot.append(1 if i in foot_ids else 0)
        return remap[i]

    for face, ty in faces:
        if ty == 'GroundSurface':
            continue   # le sol du bâtiment est le terrain : pas de face dessinée
        rings = [[(i,) + verts[i] for i in r] for r in face]
        tris, area, degraded = triangulate_face(rings)
        if not tris:
            if degraded:
                st.bad_faces += 1
                log('%s : face non triangulée (trous non reliables)' % name)
            else:
                st.zero_area += 1
            continue
        if degraded:
            st.degraded += 1
        err = triangulation_error(rings, tris)
        if err > 0.01:
            st.area_mismatch += 1
            log('%s : face triangulée avec une aire projetée écartée de %.1f %% de celle du polygone' % (name, 100 * err))
        for a, b, c in tris:
            idx.extend((vid(a), vid(b), vid(c)))
    for face in ground:
        poly = []
        for r in face:
            ring = [(verts[i][0] - ox, verts[i][1] - oy) for i in r]
            if len(ring) >= 3:
                poly.append(ring)
        if poly:
            polys.append(poly)
    st.buildings += 1


# ---------------------------------------------------------------------------
# Écriture du .bld
# ---------------------------------------------------------------------------

def encode(data):
    """Sérialise le dictionnaire de `convert` au format .bld (little-endian, sections alignées sur 4 octets)."""
    pos, idx, foot, polys = data['positions'], data['indices'], data['foot'], data['polys']
    nv = len(pos) // 3
    ring_lens = [len(r) for p in polys for r in p]
    pts = [c for p in polys for r in p for xy in r for c in xy]
    out = bytearray()
    out += HEADER.pack(MAGIC, nv, len(idx), len(polys), len(ring_lens), len(pts) // 2, data['origin'][0], data['origin'][1])
    out += struct.pack('<%df' % len(pos), *pos)
    out += struct.pack('<%dI' % len(idx), *idx)
    out += bytes(foot)
    out += b'\0' * (-len(foot) % 4)
    out += struct.pack('<%dI' % len(polys), *[len(p) for p in polys])
    out += struct.pack('<%dI' % len(ring_lens), *ring_lens)
    out += struct.pack('<%df' % len(pts), *pts)
    return bytes(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('inputs', nargs='+', help='fichier(s) CityJSONSeq de roofer (.city.jsonl)')
    ap.add_argument('--tile', required=True, help='dalle « XXXX-YYYY » (coin nord-ouest en km, Lambert-93)')
    ap.add_argument('-o', '--output', required=True, help='fichier .bld à écrire')
    ap.add_argument('--lod', default='2.2', help='LoD de la géométrie retenue (défaut 2.2)')
    args = ap.parse_args(argv)
    try:
        data, st = convert(args.inputs, args.tile, args.lod, log=lambda m: sys.stderr.write('avertissement : ' + m + '\n'))
    except ValueError as e:
        ap.error(str(e))
    blob = encode(data)
    with open(args.output, 'wb') as fh:
        fh.write(blob)
    sys.stderr.write(
        '%s : %d bâtiments, %d sommets, %d triangles, %d emprises, %d octets\n'
        % (args.output, st.buildings, data['nVerts'], len(data['indices']) // 3, len(data['polys']), len(blob)))
    skipped = []
    if st.no_geometry:
        skipped.append('%d sans géométrie LoD %s (extrusion « skip » de roofer)' % (st.no_geometry, args.lod))
    if st.outside:
        skipped.append('%d hors de la dalle (centre hors emprise)' % st.outside)
    if st.other_types:
        skipped.append('%d géométries ni Solid ni MultiSurface' % st.other_types)
    if st.zero_area:
        skipped.append('%d faces d\'aire nulle' % st.zero_area)
    if skipped:
        sys.stderr.write('ignorés : ' + ' ; '.join(skipped) + '\n')
    if st.no_ground:
        sys.stderr.write('ATTENTION : %d bâtiments sans GroundSurface (pas de pied de mur ni d\'emprise)\n' % st.no_ground)
    if st.bad_faces or st.degraded or st.area_mismatch:
        sys.stderr.write('ATTENTION : faces non triangulées %d, triangulation dégradée %d, aire discordante %d\n'
                         % (st.bad_faces, st.degraded, st.area_mismatch))
    return 0


if __name__ == '__main__':
    sys.exit(main())
