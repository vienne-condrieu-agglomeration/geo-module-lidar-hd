import assert from 'node:assert/strict';
import { city3dUrls } from '../src/js/city3d.js';

const off = { buildings: '', vegetation: '' };
// sans URL de base, tout est désactivé, quels que soient les interrupteurs
assert.deepEqual(city3dUrls(undefined), off);
assert.deepEqual(city3dUrls({}), off);
assert.deepEqual(city3dUrls({ city3dUrl: '' }), off);
assert.deepEqual(city3dUrls({ city3dUrl: '   ' }), off);
assert.deepEqual(city3dUrls({ city3dUrl: '', buildingsEnabled: true, treesEnabled: true }), off);
assert.deepEqual(city3dUrls({ city3dUrl: null }), off);
// avec une base : un sous-dossier par fonction, interrupteurs absents = activés
const on = { buildings: 'http://localhost:8777/buildings', vegetation: 'http://localhost:8777/vegetation' };
assert.deepEqual(city3dUrls({ city3dUrl: 'http://localhost:8777' }), on);
assert.deepEqual(city3dUrls({ city3dUrl: 'http://localhost:8777', buildingsEnabled: true, treesEnabled: true }), on);
// barres obliques finales et espaces ignorés
assert.deepEqual(city3dUrls({ city3dUrl: '  http://localhost:8777///  ' }), on);
assert.deepEqual(city3dUrls({ city3dUrl: 'https://cdn.example.org/ville3d/' }), { buildings: 'https://cdn.example.org/ville3d/buildings', vegetation: 'https://cdn.example.org/ville3d/vegetation' });
// un interrupteur décoché désactive sa fonction seulement
assert.deepEqual(city3dUrls({ city3dUrl: 'http://x', buildingsEnabled: false }), { buildings: '', vegetation: 'http://x/vegetation' });
assert.deepEqual(city3dUrls({ city3dUrl: 'http://x', treesEnabled: false }), { buildings: 'http://x/buildings', vegetation: '' });
assert.deepEqual(city3dUrls({ city3dUrl: 'http://x', buildingsEnabled: false, treesEnabled: false }), off);
// les anciens réglages n'ont plus d'effet
assert.deepEqual(city3dUrls({ buildingsUrl: 'http://old/b', vegetationUrl: 'http://old/v' }), off);
console.log('city3d : OK');
