"""Tests du convertisseur : python3 -I -m unittest discover -s scripts/roofer"""
import json
import math
import os
import struct
import unittest

import cityjsonseq_to_bld as c

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, '..', '..', 'test', 'fixtures')


def decode(blob):
    magic, nv, ni, npoly, nring, npts, ox, oy = c.HEADER.unpack_from(blob, 0)
    assert magic == b'BLD1'
    o = c.HEADER.size
    pos = struct.unpack_from('<%df' % (3 * nv), blob, o); o += 12 * nv
    idx = struct.unpack_from('<%dI' % ni, blob, o); o += 4 * ni
    foot = blob[o:o + nv]; o += nv + (-nv % 4)
    prings = struct.unpack_from('<%dI' % npoly, blob, o); o += 4 * npoly
    rlens = struct.unpack_from('<%dI' % nring, blob, o); o += 4 * nring
    pts = struct.unpack_from('<%df' % (2 * npts), blob, o); o += 8 * npts
    assert o == len(blob), 'octets en trop ou manquants'
    return dict(pos=pos, idx=idx, foot=foot, prings=prings, rlens=rlens, pts=pts, origin=(ox, oy))


class Triangulation(unittest.TestCase):
    def check(self, rings, expected, places=6):
        tris, area, degraded = c.triangulate_face(rings)
        coords = {p[0]: p[1:] for r in rings for p in r}
        self.assertFalse(degraded)
        self.assertAlmostEqual(area, expected, places=places)
        self.assertAlmostEqual(c.tri_area3d(tris, coords), expected, places=places)
        return tris

    def ring(self, pts, start=0):
        return [(start + i,) + p for i, p in enumerate(pts)]

    def test_square(self):
        self.assertEqual(len(self.check([self.ring([(0, 0, 0), (4, 0, 0), (4, 4, 0), (0, 4, 0)])], 16)), 2)

    def test_concave_L(self):
        L = [(0, 0, 5), (30, 0, 5), (30, 12, 5), (12, 12, 5), (12, 30, 5), (0, 30, 5)]
        self.check([self.ring(L)], 30 * 12 + 12 * 18)

    def test_hole(self):
        outer = self.ring([(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0)])
        hole = self.ring([(3, 3, 0), (3, 7, 0), (7, 7, 0), (7, 3, 0)], 4)
        self.check([outer, hole], 100 - 16)

    def test_hole_in_L_clockwise_face(self):
        # face vue de dessous (sens horaire) : même aire, triangles dans le sens d'origine
        outer = self.ring([(0, 0, 0), (0, 10, 0), (10, 10, 0), (10, 0, 0)])
        hole = self.ring([(3, 3, 0), (7, 3, 0), (7, 7, 0), (3, 7, 0)], 4)
        tris = self.check([outer, hole], 84)
        coords = {p[0]: p[1:] for r in (outer, hole) for p in r}
        for a, b, cc in tris:   # tous horaires (aire signée négative en xy)
            pa, pb, pc = coords[a], coords[b], coords[cc]
            self.assertLess((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]), 0)

    def test_vertical_wall_and_slanted(self):
        self.check([self.ring([(0, 0, 0), (5, 0, 0), (5, 0, 3), (0, 0, 3)])], 15)
        self.check([self.ring([(0, 0, 0), (5, 0, 0), (5, 4, 2), (0, 4, 2)])], 5 * math.hypot(4, 2))

    def test_collinear_vertices(self):
        self.check([self.ring([(0, 0, 0), (2, 0, 0), (4, 0, 0), (4, 4, 0), (2, 4, 0), (0, 4, 0)])], 16)

    def test_real_face_with_ten_holes(self):
        # face de toit réelle de roofer (BD TOPO BATIMENT0000000302565022, dalle 0846-6494) : 40 sommets et 10 trous.
        # Régression : un pont posé sur la mauvaise occurrence d'un sommet déjà relié donnait des triangles hors de la face.
        with open(os.path.join(FIX, 'face-reelle-10-trous.json'), encoding='utf-8') as fh:
            rings = [[tuple(p) for p in r] for r in json.load(fh)]
        self.assertEqual(len(rings), 11)
        for n in range(1, 11):   # de 1 à 10 trous
            self.check(rings[:n + 1], c.triangulate_face(rings[:n + 1])[1], places=1)   # toit plan à quelques mm près
        tris = self.check(rings, 703.6819, places=1)
        self.assertEqual(len(tris), 118)   # V + 2H - 2 avec V = 98 sommets et H = 10 trous

    def test_consecutive_duplicate_vertices(self):
        self.check([self.ring([(0, 0, 0), (4, 0, 0), (4, 0, 0), (4, 4, 0), (0, 4, 0), (0, 0, 0)])], 16)

    def test_degenerate_face(self):
        self.assertEqual(c.triangulate_face([self.ring([(0, 0, 0), (1, 1, 1), (2, 2, 2)])])[0], [])


class Conversion(unittest.TestCase):
    def convert(self, name, tile='0846-6494'):
        msgs = []
        data, st = c.convert([os.path.join(FIX, name)], tile, log=msgs.append)
        return data, st, msgs

    def test_fake(self):
        data, st, msgs = self.convert('fake.city.jsonl')
        self.assertEqual((st.buildings, st.no_ground, st.bad_faces, st.degraded, st.area_mismatch), (3, 0, 0, 0, 0))
        self.assertEqual(msgs, [])
        d = decode(c.encode(data))
        self.assertEqual(d['origin'], (846000.0, 6493000.0))
        # positions locales à la dalle, altitudes NGF
        xs, ys, zs = d['pos'][0::3], d['pos'][1::3], d['pos'][2::3]
        self.assertAlmostEqual(min(xs), 120, places=3); self.assertAlmostEqual(max(xs), 208, places=3)
        self.assertAlmostEqual(min(ys), 120, places=3); self.assertAlmostEqual(max(ys), 150, places=3)
        self.assertAlmostEqual(min(zs), 100, places=3); self.assertAlmostEqual(max(zs), 109, places=3)
        # pieds de mur : exactement les sommets à 100 m
        for i, f in enumerate(d['foot']):
            self.assertEqual(f, 1 if abs(zs[i] - 100) < 1e-4 else 0)
        # pas de face de sol dessinée : aucun triangle n'a ses trois sommets au sol
        for t in range(0, len(d['idx']), 3):
            self.assertFalse(all(d['foot'][i] for i in d['idx'][t:t + 3]))
        self.assertEqual(max(d['idx']) + 1, len(d['foot']))
        # emprises : 3 polygones ; B2 = 2 anneaux (extérieur + cour)
        self.assertEqual(sorted(d['prings']), [1, 1, 2])
        self.assertEqual(sorted(d['rlens']), [4, 4, 4, 6])

    def test_fake_area_conserved(self):
        # aire totale du maillage (sans les faces de sol) calculée à la main, bâtiment par bâtiment
        b1 = 2 * 20 * math.hypot(5, 3) + 2 * 20 * 6 + 2 * (10 * 6 + 0.5 * 10 * 3)
        walls_b2 = 225 + 108 + 145.8 + 129.6 + 79.2 + 180 + 45.6 + 81 + 51.6 + 81
        b2 = (576 - 60) * math.sqrt(1.01) + walls_b2
        b3 = 4 * 8 * 5 + 4 * 0.5 * 8 * math.hypot(4, 3)
        data, _, _ = self.convert('fake.city.jsonl')
        d = decode(c.encode(data))
        total = 0.0
        for t in range(0, len(d['idx']), 3):
            p = [d['pos'][3 * i:3 * i + 3] for i in d['idx'][t:t + 3]]
            total += c.tri_area3d([(0, 1, 2)], dict(enumerate(p)))
        self.assertAlmostEqual(total, b1 + b2 + b3, places=2)

    def test_tile_filter(self):
        data, st, _ = self.convert('fake.city.jsonl', tile='0847-6494')
        self.assertEqual((st.buildings, st.outside), (0, 3))
        self.assertEqual(data['nVerts'], 0)

    def test_real_roofer_output(self):
        # sortie réelle de roofer v1.0.0 (extrusion « lod11_fallback » : pas de toit en pente, mais vraie structure)
        data, st, msgs = self.convert('roofer-v1.0.0-synthetique.city.jsonl')
        self.assertEqual((st.buildings, st.no_ground, st.bad_faces, st.area_mismatch), (2, 0, 0, 0))
        d = decode(c.encode(data))
        self.assertEqual(sorted(d['prings']), [1, 2])   # le deuxième bâtiment a une cour (face à trou)
        self.assertEqual(len(d['idx']) // 3, 10 + 24)   # B1 : 4 murs x 2 + 2 ; B2 : 8 murs x 2 + toit à trou (8 triangles)

    def test_missing_semantics_is_reported(self):
        import json, tempfile
        with open(os.path.join(FIX, 'fake.city.jsonl'), encoding='utf-8') as fh:
            lines = [json.loads(x) for x in fh]
        for f in lines[1:]:
            for o in f['CityObjects'].values():
                for g in o.get('geometry', []):
                    g.pop('semantics', None)
        with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False, encoding='utf-8') as out:
            out.write('\n'.join(json.dumps(x) for x in lines))
        try:
            msgs = []
            data, st = c.convert([out.name], '0846-6494', log=msgs.append)
        finally:
            os.unlink(out.name)
        self.assertEqual((st.buildings, st.no_ground), (3, 3))
        self.assertEqual(len(msgs), 3)
        d = decode(c.encode(data))
        self.assertEqual(sum(d['foot']), 0)       # rien n'est deviné
        self.assertEqual(d['prings'], ())

    def test_missing_transform_stops(self):
        import json, tempfile
        with open(os.path.join(FIX, 'fake.city.jsonl'), encoding='utf-8') as fh:
            lines = fh.read().splitlines()[1:]
        with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False, encoding='utf-8') as out:
            out.write('\n'.join(lines))
        try:
            with self.assertRaises(SystemExit):
                c.convert([out.name], '0846-6494')
        finally:
            os.unlink(out.name)

    def test_tile_name(self):
        self.assertEqual(c.tile_bbox('0846-6494'), [846000, 6493000, 847000, 6494000])
        with self.assertRaises(ValueError):
            c.tile_bbox('846-6494')

    def test_fixture_is_current(self):
        data, _, _ = self.convert('fake.city.jsonl')
        with open(os.path.join(FIX, 'fake.bld'), 'rb') as fh:
            self.assertEqual(fh.read(), c.encode(data), 'fake.bld périmé : relancer cityjsonseq_to_bld.py')


if __name__ == '__main__':
    unittest.main()
