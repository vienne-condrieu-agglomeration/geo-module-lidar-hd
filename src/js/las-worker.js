// Point d'entrée du worker de décodage LAZ. Compilé à part (webpack.worker.config.js) puis embarqué en texte dans
// main.js : le module ne livre ainsi qu'un seul fichier.
// Copie de node_modules/itowns/lib/Worker/LASLoaderWorker.js, à une différence près : le décodeur laz-perf.wasm est
// embarqué (base64 injecté par webpack, voir webpack.worker.config.js) au lieu d'être téléchargé depuis un CDN.
import { expose, Transfer } from 'threads/worker';
import { LazPerf } from 'laz-perf';
import LASLoader from '../../node_modules/itowns/lib/Loader/LASLoader.js';

/* global __LAZ_PERF_WASM_BASE64__ */
const loader = new LASLoader();

function embeddedWasm() {
    const bin = atob(__LAZ_PERF_WASM_BASE64__);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return bytes;
}
// Initialisation paresseuse : le décodeur n'est compilé qu'au premier découpage à lire.
function ensureDecoder() {
    if (!loader._wasmPromise) {
        loader._wasmPromise = LazPerf.create({ wasmBinary: embeddedWasm() });
    }
}
function transferable(attributes) {
    return Object.values(attributes).filter(ArrayBuffer.isView).map(a => a.buffer);
}
expose({
    async parseChunk(data, options) {
        ensureDecoder();
        const result = await loader.parseChunk(data, options);
        return Transfer(result, transferable(result.attributes));
    },
    async parseFile(data, options) {
        ensureDecoder();
        const result = await loader.parseFile(data, options);
        return Transfer(result, transferable(result.attributes));
    }
});
