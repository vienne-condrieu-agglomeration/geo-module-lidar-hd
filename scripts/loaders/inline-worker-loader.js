/**
 * Loader webpack appliqué à itowns/lib/Parser/{LASParser,Potree2BinParser}.js.
 *
 * iTowns crée ses workers par `new Worker(new URL('../Worker/X.js', import.meta.url), {type:'module'})`.
 * Webpack 5 émettrait alors un fichier séparé, que GEO ne sert pas (le module n'est livré que
 * sous forme de main.js). On remplace cette expression par `self.__geoLidarHdWorker(<nom>)`,
 * fournie par extension.js, qui instancie le worker depuis un Blob.
 *
 * Volontairement strict (version d'iTowns figée) : si le motif change, le build échoue
 * plutôt que de livrer un module dont le worker serait introuvable.
 */
const PATTERN = /new Worker\([\s\S]*?new URL\('\.\.\/Worker\/(\w+)\.js', import\.meta\.url\)[\s\S]*?\}\)/;

module.exports = function (source) {
  // Scheduler.js : `new URL(url, import.meta.url)` ne sert qu'à extraire l'hôte d'une URL de source ;
  // webpack y voit un asset dynamique (avertissement). Résoudre contre la page revient au même.
  if (/Scheduler\.js$/.test(this.resourcePath)) {
    if (source.indexOf('import.meta.url') === -1) {
      throw new Error("inline-worker-loader : `import.meta.url` introuvable dans " + this.resourcePath);
    }
    return source.replace(/import\.meta\.url/g, 'document.baseURI');
  }
  const m = PATTERN.exec(source);
  if (!m) {
    throw new Error("inline-worker-loader : motif `new Worker(new URL(...))` introuvable dans " + this.resourcePath);
  }
  return source.replace(PATTERN, 'self.__geoLidarHdWorker(' + JSON.stringify(m[1]) + ')');
};
