#!/usr/bin/env python3
"""Sert le dossier bld/ en HTTP avec CORS, pour le réglage buildingsUrl du module geo-lidar-hd.

    python3 -I serve.py [port]        (défaut 8777 ; écoute sur 127.0.0.1 seulement)

Lecture seule. En-têtes ajoutés : Access-Control-Allow-Origin (CORS) et Access-Control-Allow-Private-Network
(exigé par Chrome quand une page GEO publique appelle http://localhost).
"""
import functools
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bld')


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    if not os.path.isdir(ROOT):
        sys.exit('dossier bld/ absent : lancer d\'abord ./prepare.sh')
    print('Fichiers : %s' % ', '.join(sorted(os.listdir(ROOT))) or '(aucun)')
    print('buildingsUrl à saisir dans le Générateur : http://localhost:%d' % port)
    handler = functools.partial(Handler, directory=ROOT)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
