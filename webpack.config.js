const path = require("path");
const webpack = require("webpack");
const MinimizerPlugin = require("minimizer-webpack-plugin");

// Bannière conservée dans main.js : licence et sources du module (le code tiers garde ses propres mentions)
const banner = [
  "geo-lidar-hd " + require("./package.json").version,
  "SPDX-License-Identifier: GPL-3.0-or-later",
  "Source : https://github.com/vienne-condrieu-agglomeration/geo-module-lidar-hd"
].join("\n");

// Webpack 5 (et non 4 comme les autres modules) : iTowns et three sont en ESM pur avec un champ
// "exports", ce que webpack 4 ne résout pas. Le build se fait en deux étapes (cf. package.json) :
// d'abord le worker LAZ (webpack.worker.config.js), ensuite ce bundle, qui l'embarque en texte.
module.exports = {
  entry: { main: path.join(__dirname, "/src/js/extension.js") },
  mode: "production",
  output: {
    path: path.join(__dirname, "/dist"),
    filename: "[name].js"
  },
  module: {
    rules: [
      { test: /\.css$/, use: ["style-loader", "css-loader"] },
      {
        test: /itowns[\\/]lib[\\/](Parser[\\/](LASParser|Potree2BinParser)|Core[\\/]Scheduler[\\/]Scheduler)\.js$/,
        use: path.join(__dirname, "scripts/loaders/inline-worker-loader.js")
      },
      { test: /build[\\/]las-worker\.js$/, type: "asset/source" },
      // CHANGELOG.md embarqué en texte brut (journal des nouveautés, voir src/js/changelog.js) : webpack 5, pas de raw-loader
      { test: /\.md$/, type: "asset/source" }
    ]
  },
  externals: {
    angular: "angular"
  },
  resolve: {
    extensions: [".js"]
  },
  performance: { hints: false },
  // Un seul main.js livré : on rabat les imports dynamiques d'iTowns (PMTiles, etc.) dans le bundle.
  plugins: [
    new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    new webpack.BannerPlugin({ banner: banner, entryOnly: true })
  ],
  // extractComments: false garde les mentions de licence des bibliothèques (three.js…) dans main.js, au lieu de les
  // extraire dans main.js.LICENSE.txt, qui n'est pas livré dans le ZIP
  optimization: { minimize: true, minimizer: [new MinimizerPlugin({ extractComments: false })] }
};
