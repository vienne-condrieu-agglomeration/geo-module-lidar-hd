const path = require("path");
const fs = require("fs");
const webpack = require("webpack");

// Étape 1 du build : bundle du worker LAZ -> build/las-worker.js (consommé en texte par webpack.config.js).
// Le décodeur laz-perf.wasm (~210 Ko) est embarqué en base64 : plus de téléchargement depuis un CDN au démarrage.
const wasm = fs.readFileSync(path.join(__dirname, "node_modules/laz-perf/lib/web/laz-perf.wasm"));

module.exports = {
  entry: { "las-worker": path.join(__dirname, "/src/js/las-worker.js") },
  mode: "production",
  target: "webworker",
  output: {
    path: path.join(__dirname, "/build"),
    filename: "[name].js"
  },
  plugins: [
    new webpack.DefinePlugin({ __LAZ_PERF_WASM_BASE64__: JSON.stringify(wasm.toString("base64")) })
  ],
  performance: { hints: false },
  optimization: { minimize: true }
};
