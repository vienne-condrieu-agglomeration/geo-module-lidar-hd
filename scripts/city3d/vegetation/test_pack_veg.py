"""Tests de l'empaquetage .veg : python3 -I -m unittest discover -s scripts/city3d/vegetation"""
import os
import struct
import tempfile
import unittest
import zlib

import pack_veg as p


def decode(blob):
    magic, size, bands, flags, step, z_min, z_res, _, ox, oy = p.HEADER.unpack_from(blob, 0)
    body = blob[p.HEADER.size:]
    if flags & p.FLAG_DEFLATE:
        body = zlib.decompress(body)
    q = struct.unpack('<%dH' % (bands * size * size), body)
    grids = [[None if v == 0 else z_min + (v - 1) * z_res for v in q[b * size * size:(b + 1) * size * size]] for b in range(bands)]
    return dict(magic=magic, size=size, bands=bands, flags=flags, step=step, z_res=z_res, origin=(ox, oy), grids=grids)


class Pack(unittest.TestCase):
    def test_round_trip(self):
        top = [None, 100.0, 123.456, 1500.07]
        base = [None, None, 101.25, 1498.0]
        d = decode(p.pack([top, base], 2, 1.0, (846000.0, 6494000.0)))
        self.assertEqual((d['magic'], d['size'], d['bands'], d['step']), (b'VEG1', 2, 2, 1.0))
        self.assertEqual(d['origin'], (846000.0, 6494000.0))
        for orig, got in zip(top + base, d['grids'][0] + d['grids'][1]):
            if orig is None:
                self.assertIsNone(got)
            else:
                self.assertAlmostEqual(got, orig, delta=0.06)   # résolution 0,1 m

    def test_negative_altitudes(self):
        d = decode(p.pack([[-3.2, 0.0, 5.55, 8.0]], 2, 1.0, (0.0, 0.0)))
        self.assertAlmostEqual(d['grids'][0][0], -3.2, delta=0.06)

    def test_uncompressed_has_same_values(self):
        grids = [[100.0, None, 101.5, 99.0]]
        a, b = decode(p.pack(grids, 2, 1.0, (1.0, 2.0), compress=True)), decode(p.pack(grids, 2, 1.0, (1.0, 2.0), compress=False))
        self.assertEqual(a['grids'], b['grids'])
        self.assertEqual((a['flags'], b['flags']), (p.FLAG_DEFLATE, 0))

    def test_empty_grid(self):
        d = decode(p.pack([[None] * 4], 2, 1.0, (0.0, 0.0)))
        self.assertEqual(d['grids'][0], [None] * 4)

    def test_tile_bbox(self):
        self.assertEqual(p.tile_bbox('0846-6494'), [846000, 6493000, 847000, 6494000])
        with self.assertRaises(ValueError):
            p.tile_bbox('846-6494')

    def test_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            size = 4
            for name, vals in (('top.bin', [100.0] * 16), ('base.bin', [-9999.0] * 8 + [101.0] * 8)):
                with open(os.path.join(tmp, name), 'wb') as fh:
                    fh.write(struct.pack('<16f', *vals))
            out = os.path.join(tmp, 'x.veg')
            p.main(['--tile', '0846-6494', '--top', os.path.join(tmp, 'top.bin'), '--base', os.path.join(tmp, 'base.bin'),
                    '--size', str(size), '-o', out])
            with open(out, 'rb') as fh:
                d = decode(fh.read())
            self.assertEqual((d['size'], d['step'], d['origin']), (4, 250.0, (846000.0, 6494000.0)))   # 4 cellules sur 1000 m
            self.assertEqual(d['grids'][1][:8], [None] * 8)
            self.assertAlmostEqual(d['grids'][1][8], 101.0, delta=0.06)

    def test_wrong_grid_size_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = os.path.join(tmp, 'g.bin')
            with open(f, 'wb') as fh:
                fh.write(b'\0' * 12)
            with self.assertRaises(SystemExit):
                p.read_grid(f, 4)


if __name__ == '__main__':
    unittest.main()
