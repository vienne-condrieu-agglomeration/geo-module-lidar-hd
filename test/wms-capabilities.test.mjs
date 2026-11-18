import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWmsLayers, capabilitiesUrl } from '../src/js/wms-capabilities.js';

// GetCapabilities réel de l'espace de travail « craig » du GeoServer (deux couches en EPSG:2154)
const craig = fs.readFileSync(new URL('./fixtures/wms-capabilities-craig.xml', import.meta.url), 'utf8');
assert.deepEqual(parseWmsLayers(craig, 'EPSG:2154'), [
    { name: 'craig_ortho_historique_1940_1965', title: 'CRAIG Ortho Historique 1940-1965' },
    { name: 'ortho_pcrs_5cm', title: 'Orthophotoplan RTGE < 1:5000' }
]);
// projection absente : aucune couche
assert.deepEqual(parseWmsLayers(craig, 'EPSG:9999'), []);
// la casse de la projection ne compte pas
assert.equal(parseWmsLayers(craig, 'epsg:2154').length, 2);

// héritage : le groupe porte les CRS, ses couches les reçoivent ; le groupe sans <Name> n'est pas listé ;
// une couche qui déclare ses propres CRS les ajoute ; WMS 1.1.1 écrit <SRS>
const nested = '<WMS_Capabilities><Capability><Layer><Title>Racine</Title><CRS>EPSG:4326</CRS><CRS>EPSG:2154</CRS>' +
    '<Layer><Name>a</Name><Title>A &amp; B</Title></Layer>' +
    '<Layer><Name>b</Name><Title>B</Title><CRS>EPSG:3857</CRS></Layer>' +
    '<Layer><Title>Sous-groupe</Title><Layer><Name>c</Name><Title>C</Title></Layer></Layer>' +
    '</Layer></Capability></WMS_Capabilities>';
assert.deepEqual(parseWmsLayers(nested, 'EPSG:2154').map((l) => l.name), ['a', 'b', 'c']);
assert.equal(parseWmsLayers(nested, 'EPSG:2154')[0].title, 'A & B');
assert.deepEqual(parseWmsLayers(nested, 'EPSG:3857').map((l) => l.name), ['b']);
const old = '<WMT_MS_Capabilities><Capability><Layer><SRS>EPSG:2154 EPSG:4326</SRS><Layer><Name>x</Name><Title>X</Title></Layer></Layer></Capability></WMT_MS_Capabilities>';
assert.deepEqual(parseWmsLayers(old, 'EPSG:2154'), [{ name: 'x', title: 'X' }]);
// la projection d'une couche sœur ne fuit pas
const sib = '<Capability><Layer><Layer><Name>p</Name><CRS>EPSG:2154</CRS></Layer><Layer><Name>q</Name></Layer></Layer></Capability>';
assert.deepEqual(parseWmsLayers(sib, 'EPSG:2154').map((l) => l.name), ['p']);

// entrées invalides : jamais d'exception
for (const bad of [undefined, null, '', 'pas du xml', '<html><body>403</body></html>', '<ServiceExceptionReport><ServiceException>x</ServiceException></ServiceExceptionReport>']) {
    assert.deepEqual(parseWmsLayers(bad, 'EPSG:2154'), []);
}

assert.equal(capabilitiesUrl('https://h/geoserver/craig/wms'), 'https://h/geoserver/craig/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0');
assert.equal(capabilitiesUrl(' https://h/ortho?map=x '), 'https://h/ortho?map=x&SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0');
console.log('wms-capabilities : OK');
