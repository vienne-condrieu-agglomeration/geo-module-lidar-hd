// Lecture d'un GetCapabilities WMS (1.1.1 ou 1.3.0) : liste des couches nommées qui acceptent une projection donnée.
// Analyseur minimal (sans DOMParser, pour rester testable sous Node) : il suit l'imbrication des <Layer> et applique
// l'héritage des projections (<CRS> en 1.3.0, <SRS> en 1.1.1), qui descendent du groupe parent vers ses couches.

function _decode(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

// -> [{ name, title }] dans l'ordre du document ; vide si le texte n'est pas un GetCapabilities exploitable.
export function parseWmsLayers(xml, crs) {
    var wanted = String(crs || 'EPSG:2154').toUpperCase();
    var out = [];
    var stack = [];   // une entrée par <Layer> ouvert : { name, title, crs: [] héritées, parents }
    var path = [];    // noms des éléments ouverts
    var opened = 0;   // rang d'ouverture des <Layer> : restitue l'ordre du document
    var re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;
    var m;
    while ((m = re.exec(String(xml || '')))) {
        if (m[3] !== undefined) {
            var tag = m[3].replace(/^.*:/, ''), closing = m[2] === '/', selfClose = m[5] === '/';
            if (closing) {
                if (tag === 'Layer' && stack.length) {
                    var l = stack.pop();
                    if (l.name && l.crs.indexOf(wanted) !== -1) { out.push({ name: l.name, title: l.title || l.name, order: l.order }); }
                }
                path.pop();
            } else if (!selfClose) {
                if (tag === 'Layer') {
                    var parent = stack[stack.length - 1];
                    stack.push({ name: '', title: '', crs: parent ? parent.crs.slice() : [], order: opened++ });
                }
                path.push(tag);
            }
        } else if (m[6] !== undefined || m[1] !== undefined) {
            var text = _decode(m[6] !== undefined ? m[6] : m[1]);
            if (!text || !stack.length) { continue; }
            var cur = stack[stack.length - 1], here = path[path.length - 1], up = path[path.length - 2];
            if (up !== 'Layer') { continue; }   // texte d'un enfant direct du <Layer> courant seulement
            if (here === 'Name') { cur.name = text; }
            else if (here === 'Title') { cur.title = text; }
            else if (here === 'CRS' || here === 'SRS') {
                text.split(/\s+/).forEach(function (c) { cur.crs.push(c.toUpperCase()); });
            }
        }
    }
    // L'ordre de fermeture met les enfants avant leur parent : on rend l'ordre du document (ouverture).
    return out.sort(function (a, b) { return a.order - b.order; }).map(function (x) { return { name: x.name, title: x.title }; });
}

// URL du GetCapabilities d'un service WMS, que l'adresse saisie porte déjà une chaîne de requête ou non.
export function capabilitiesUrl(base) {
    var b = String(base || '').trim();
    return b + (b.indexOf('?') === -1 ? '?' : '&') + 'SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0';
}
