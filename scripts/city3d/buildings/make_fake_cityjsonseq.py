#!/usr/bin/env python3
"""Fabrique une FAUSSE sortie roofer (CityJSONSeq) pour tester sans roofer : dalle 0846-6494, trois bâtiments.

    python3 -I make_fake_cityjsonseq.py SORTIE.city.jsonl

La structure est calquée sur la sortie réelle de roofer v1.0.0 observée sur des données synthétiques (première ligne
`transform`, un CityJSONFeature par bâtiment, Building + BuildingPart, Solid LoD 2.2, sémantique Ground/Wall/Roof,
faces à trous). Ce n'est PAS une vraie reconstruction : les géométries sont écrites à la main.

Bâtiments (coordonnées Lambert-93, sol à 100 m NGF) :
- B1 : toit à deux pans (faîtage selon x), 20 x 10 m, murs pignons à 5 sommets ;
- B2 : bâtiment en L avec cour intérieure (trou), toit à un pan dont la face de toit porte le trou ;
- B3 : toit à quatre pans (pyramide), 8 x 8 m.
"""
import json
import sys

X0, Y0 = 846000.0, 6493000.0    # coin sud-ouest de la dalle 0846-6494
GROUND = 100.0
SCALE = 0.001
TRANSLATE = (X0 + 100.0, Y0 + 100.0, GROUND)    # comme roofer : centre du jeu de données


class Feature(object):
    def __init__(self, name):
        self.name = name
        self.verts = []
        self.index = {}
        self.faces = []        # [[anneaux d'indices]]
        self.types = []        # type sémantique de chaque face
        self.footprint = None

    def v(self, x, y, z):
        key = (round((x - TRANSLATE[0]) / SCALE), round((y - TRANSLATE[1]) / SCALE), round((z - TRANSLATE[2]) / SCALE))
        if key not in self.index:
            self.index[key] = len(self.verts)
            self.verts.append(list(key))
        return self.index[key]

    def face(self, ty, *rings):
        self.faces.append([[self.v(*p) for p in r] for r in rings])
        self.types.append(ty)

    def walls(self, ring, roof_z):
        """Murs d'un anneau (sens du parcours : intérieur à gauche pour l'extérieur, à droite pour un trou)."""
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            self.face('WallSurface',
                      [(a[0], a[1], GROUND), (b[0], b[1], GROUND),
                       (b[0], b[1], roof_z(b[0], b[1])), (a[0], a[1], roof_z(a[0], a[1]))])

    def to_json(self):
        values = [{'GroundSurface': 0, 'WallSurface': 1, 'RoofSurface': 3}[ty] for ty in self.types]
        surfaces = [{'type': 'GroundSurface'},
                    {'on_footprint_edge': True, 'type': 'WallSurface'},
                    {'on_footprint_edge': False, 'type': 'WallSurface'},
                    {'rf_azimuth': 90.0, 'rf_slope': 0.0, 'type': 'RoofSurface'}]
        boundaries = [self.faces]
        return {
            'CityObjects': {
                self.name: {
                    'type': 'Building', 'children': [self.name + '-0'],
                    'attributes': {'rf_extrusion_mode': 'standard', 'rf_h_ground': GROUND},
                    'geometry': [{'type': 'MultiSurface', 'lod': '0', 'boundaries': [self.footprint]}],
                },
                self.name + '-0': {
                    'type': 'BuildingPart', 'parents': [self.name], 'attributes': {},
                    'geometry': [{'type': 'Solid', 'lod': '2.2', 'boundaries': boundaries,
                                  'semantics': {'surfaces': surfaces, 'values': [values]}}],
                },
            },
            'id': self.name, 'type': 'CityJSONFeature', 'vertices': self.verts,
        }


def ccw(ring):
    return ring


def cw(ring):
    return list(reversed(ring))


def building_gable():
    f = Feature('B1')
    x0, y0, x1, y1, ym = X0 + 120, Y0 + 120, X0 + 140, Y0 + 130, Y0 + 125
    e, r = 106.0, 109.0
    f.face('GroundSurface', *[[(x0, y1, GROUND), (x1, y1, GROUND), (x1, y0, GROUND), (x0, y0, GROUND)]])
    f.face('WallSurface', [(x0, y0, GROUND), (x1, y0, GROUND), (x1, y0, e), (x0, y0, e)])          # sud
    f.face('WallSurface', [(x1, y0, GROUND), (x1, y1, GROUND), (x1, y1, e), (x1, ym, r), (x1, y0, e)])   # pignon est
    f.face('WallSurface', [(x1, y1, GROUND), (x0, y1, GROUND), (x0, y1, e), (x1, y1, e)])          # nord
    f.face('WallSurface', [(x0, y1, GROUND), (x0, y0, GROUND), (x0, y0, e), (x0, ym, r), (x0, y1, e)])   # pignon ouest
    f.face('RoofSurface', [(x0, y0, e), (x1, y0, e), (x1, ym, r), (x0, ym, r)])                      # pan sud
    f.face('RoofSurface', [(x0, ym, r), (x1, ym, r), (x1, y1, e), (x0, y1, e)])                      # pan nord
    f.footprint = [[f.v(x0, y0, GROUND), f.v(x1, y0, GROUND), f.v(x1, y1, GROUND), f.v(x0, y1, GROUND)]]
    return f


def building_l_courtyard():
    f = Feature('B2')
    ox, oy = X0 + 160, Y0 + 120
    outer = [(ox + 0, oy + 0), (ox + 30, oy + 0), (ox + 30, oy + 12), (ox + 12, oy + 12), (ox + 12, oy + 30), (ox + 0, oy + 30)]
    hole = [(ox + 16, oy + 3), (ox + 16, oy + 9), (ox + 26, oy + 9), (ox + 26, oy + 3)]    # cour : anneau horaire
    roof_z = lambda x, y: 106.0 + 0.1 * (x - ox)                                              # un pan, pente 10 % vers l'est
    z3 = lambda ring, zf: [(x, y, zf(x, y)) for x, y in ring]
    f.face('GroundSurface', z3(cw(outer), lambda x, y: GROUND), z3(ccw(hole), lambda x, y: GROUND))
    f.walls(outer, roof_z)
    f.walls(hole, roof_z)
    f.face('RoofSurface', z3(outer, roof_z), z3(hole, roof_z))
    f.footprint = [[f.v(x, y, GROUND) for x, y in outer], [f.v(x, y, GROUND) for x, y in hole]]
    return f


def building_hip():
    f = Feature('B3')
    x0, y0 = X0 + 200, Y0 + 120
    s = 8.0
    e, r = 105.0, 108.0
    c = (x0 + s / 2, y0 + s / 2, r)
    sq = [(x0, y0), (x0 + s, y0), (x0 + s, y0 + s), (x0, y0 + s)]
    f.face('GroundSurface', *[[(x, y, GROUND) for x, y in cw(sq)]])
    f.walls(sq, lambda x, y: e)
    for i in range(4):
        a, b = sq[i], sq[(i + 1) % 4]
        f.face('RoofSurface', [(a[0], a[1], e), (b[0], b[1], e), c])
    f.footprint = [[f.v(x, y, GROUND) for x, y in sq]]
    return f


def main(out):
    meta = {'CityObjects': {}, 'metadata': {
                'geographicalExtent': [X0 + 120, Y0 + 120, 0.0, X0 + 208, Y0 + 150, 0.0],
                'identifier': '0', 'referenceSystem': 'https://www.opengis.net/def/crs/EPSG/0/2154'},
            'transform': {'scale': [SCALE] * 3, 'translate': list(TRANSLATE)}, 'type': 'CityJSON', 'version': '2.0',
            'vertices': []}
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(meta, sort_keys=True) + '\n')
        for b in (building_gable(), building_l_courtyard(), building_hip()):
            fh.write(json.dumps(b.to_json(), sort_keys=True) + '\n')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage : make_fake_cityjsonseq.py SORTIE.city.jsonl')
    main(sys.argv[1])
