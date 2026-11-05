const path = require("path");

// Étape 1 du build : bundle du worker LAZ -> build/las-worker.js (consommé en texte par webpack.config.js).
module.exports = {
  entry: { "las-worker": path.join(__dirname, "/src/js/las-worker.js") },
  mode: "production",
  target: "webworker",
  output: {
    path: path.join(__dirname, "/build"),
    filename: "[name].js"
  },
  optimization: { minimize: true }
};
