import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOURS, MAP_TARGET } from '../src/js/tours.js';

const source = readFileSync(new URL('../src/js/extension.js', import.meta.url), 'utf8');
for (const [name, steps] of Object.entries(TOURS)) {
    assert.ok(steps.length > 0, name);
    for (const step of steps) {
        assert.ok(step.title && step.text, name + ' : étape sans texte');
        if (step.sel === MAP_TARGET) { continue; }
        for (const m of step.sel.matchAll(/\.([a-z-]+)/g)) {
            assert.ok(source.includes(m[1]), name + ' : classe absente du gabarit : ' + m[1]);
        }
        const attr = step.sel.match(/\[aria-label="([^"]+)"\]/);
        if (attr) { assert.ok(source.includes('aria-label="' + attr[1] + '"'), name + ' : ' + attr[1]); }
    }
}
for (const name of ['profile', 'mnt', 'profileDraw', 'mntDraw', 'style', 'maq', 'filters']) {
    assert.ok(source.includes(name), 'visite non lancée : ' + name);
}
console.log('tours : OK');
