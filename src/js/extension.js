import angular from "angular";
import pluginConf from '../plugin.geoext.json';
import {
    Vector2, Vector3, Vector4, Matrix4, Texture, LinearFilter, MOUSE, TOUCH,
    Group, Mesh, SphereGeometry, MeshBasicMaterial, BufferGeometry, Float32BufferAttribute, DoubleSide,
    LineSegments, Line, LineBasicMaterial, DataTexture, RedFormat, FloatType, NearestFilter, BufferAttribute, ShaderMaterial,
    InstancedMesh, IcosahedronGeometry, CylinderGeometry, Quaternion
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import proj4 from 'proj4';
import {
    View, CopcSource, CopcLayer, LASParser, Fetcher, PNTS_MODE, MAIN_LOOP_EVENTS
} from 'itowns';
// Worker de décodage LAZ, compilé à part (webpack.worker.config.js) et embarqué en texte.
import workerSource from '../../build/las-worker.js';
import { createRasterReader } from './raster.js';
import { createDiskCache } from './disk-cache.js';
import { parseBld, maskSurface } from './buildings.js';
import { parseVeg, detectTrees, removeCanopy } from './vegetation.js';
import { city3dUrls } from './city3d.js';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { TOURS, MAP_TARGET } from './tours.js';
import { CATALOG as _CRS_CATALOG, DEFAULT_LIST as _CRS_DEFAULT, parseCrsList, pickDefault } from './crs.js';
import { parcelLimits, buildingSpans, snapTargets, nearestSnap } from './profile-cadastre.js';
import { createChangelog } from './changelog.js';
import changelogMd from '../../CHANGELOG.md';

// iTowns ne connaît que 4326/3857/4978. Les dalles LiDAR HD sont en EPSG:2154 ; les autres projections sont proposées
// pour le pointage et les exports. Le catalogue est dans crs.js.
_CRS_CATALOG.forEach(function (c) { if (c.def) { proj4.defs(c.code, c.def); } });

// iTowns crée son worker par `new Worker(new URL(...))`, ce qui produirait un fichier à part que GEO
// ne sert pas. Le loader de build (scripts/loaders/inline-worker-loader.js) redirige vers cette fonction.
var _workerBlobUrl = null;
self.__geoLidarHdWorker = function (name) {
    if (name !== 'LASLoaderWorker') {
        throw new Error('[geo-lidar-hd] worker non embarqué : ' + name);
    }
    if (!_workerBlobUrl) {
        _workerBlobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    }
    return new Worker(_workerBlobUrl);
};

// data.geopf.fr applique une limitation de débit (HTTP 429) : iTowns lance de nombreuses requêtes Range
// en parallèle pour streamer l'octree. On remplace le fetcher binaire (copie d'iTowns embarquée dans ce
// bundle, donc sans effet hors module) par une version à concurrence limitée qui rejoue sur 429/503.
var _MAX_PARALLEL = 3, _MAX_ATTEMPTS = 8;
var _active = 0, _waiting = [];
function _release() { _active--; var next = _waiting.shift(); if (next) { next(); } }
function _fetchWithRetry(url, options, attempt) {
    return fetch(url, options).then(function (r) {
        if ((r.status === 429 || r.status === 503) && attempt < _MAX_ATTEMPTS) {
            var retryAfter = parseFloat(r.headers.get('retry-after'));
            var delay = (retryAfter > 0 ? retryAfter * 1000 : 400 * Math.pow(2, attempt)) + Math.random() * 250;
            return new Promise(function (res) { setTimeout(res, delay); })
                .then(function () { return _fetchWithRetry(url, options, attempt + 1); });
        }
        if (!r.ok) { throw new Error('Error loading ' + url + ': status ' + r.status); }
        return r.arrayBuffer();
    });
}
// Cache mémoire des plages COPC déjà lues (copies : le décodeur « consomme » le buffer qu'on lui passe).
// Évite de retélécharger quand le profil exact est relancé (largeur, actualisation) et limite les 429.
var _CACHE_MAX = 250 * 1024 * 1024;
var _rangeCache = new Map(), _rangeCacheBytes = 0;
function _rangeKey(url, options) {
    var h = options && options.headers, r = h && (h.range || h.Range);
    return r ? url + '|' + r : null;
}
function _clearRangeCache() { _rangeCache.clear(); _rangeCacheBytes = 0; }
// Cache persistant (API Cache) : plages COPC et rasters survivent au rechargement de la page. 2 Go au plus, 7 jours.
var _diskCache = createDiskCache(typeof caches !== 'undefined' ? caches : null, { maxBytes: 2 * 1024 * 1024 * 1024, ttlMs: 7 * 24 * 3600 * 1000 });
function _remember(key, buf) {
    if (buf.byteLength < _CACHE_MAX / 4) {
        _rangeCache.set(key, buf.slice(0)); _rangeCacheBytes += buf.byteLength;
        var it = _rangeCache.keys();
        while (_rangeCacheBytes > _CACHE_MAX) {
            var k = it.next().value;
            if (k === undefined) { break; }
            _rangeCacheBytes -= _rangeCache.get(k).byteLength; _rangeCache.delete(k);
        }
    }
}
// Lecture avec trois niveaux : mémoire, disque (navigateur), réseau (concurrence limitée, reprises sur 429).
// `key` null : pas de cache (réponse non reproductible). `storable` : refuse de retenir une réponse invalide.
function _cachedFetch(url, options, key, storable) {
    if (key && _rangeCache.has(key)) {
        var hit = _rangeCache.get(key);
        _rangeCache.delete(key); _rangeCache.set(key, hit);   // plus récemment utilisé
        return Promise.resolve(hit.slice(0));
    }
    return (key ? _diskCache.get(key) : Promise.resolve(null)).then(function (disk) {
        if (disk) { _remember(key, disk); return disk; }
        return new Promise(function (resolve, reject) {
            function run() {
                _active++;
                _fetchWithRetry(url, options || {}, 0).then(function (buf) {
                    if (key && (!storable || storable(buf))) { _remember(key, buf); _diskCache.put(key, buf); }
                    resolve(buf);
                }, reject).then(_release, _release);
            }
            if (_active < _MAX_PARALLEL) { run(); } else { _waiting.push(run); }
        });
    });
}
Fetcher.arrayBuffer = function (url, options) { return _cachedFetch(url, options, _rangeKey(url, options)); };

// Lecteur des rasters MNT / MNS / MNH des dalles (voir raster.js). Il passe par la lecture à trois niveaux ci-dessus :
// même concurrence limitée et mêmes reprises sur 429 que le nuage de points.
// Le WMS de l'IGN répond parfois par une erreur ponctuelle (400, 500…) à une requête qui réussit au coup suivant : sans reprise, la dalle
// concernée restait sans MNT ou sans MNS, donc absente de la maquette. Trois reprises espacées, sauf si la vue a changé entre-temps.
// Le WMS répond parfois 200 avec un message d'erreur XML : jamais mis en cache, il resterait sept jours.
function _notXml(buf) { return !/^<(\?xml|service|html)/i.test(new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)))); }
function _rasterFetch(url, attempt) {
    return _cachedFetch(url, undefined, 'GET|' + url, _notXml).catch(function (err) {
        if ((attempt || 0) >= 3) { throw err; }
        return new Promise(function (res) { setTimeout(res, 600 * Math.pow(2, attempt || 0) + Math.random() * 300); })
            .then(function () { return _rasterFetch(url, (attempt || 0) + 1); });
    });
}
var _rasters = createRasterReader(function (url) { return _rasterFetch(url, 0); });

// Icônes Lucide (https://lucide.dev, licence ISC), en SVG inline : elles prennent la couleur du texte.
var _ICONS = {
    'sliders-horizontal': '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
    'focus': '<circle cx="12" cy="12" r="3"/><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
    'chart-line': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
    'maximize-2': '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
    'minimize-2': '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
    'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'minus': '<path d="M5 12h14"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'rotate-cw': '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'map': '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
    'hand': '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    'touchpad': '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M2 14h20"/><path d="M12 20v-6"/>',
    'download': '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    'funnel': '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'layers': '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    'ruler': '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
    'mouse-pointer-click': '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    'chevron-up-small': '<path d="m18 15-6-6-6 6"/>',
    'mountain': '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
    'unfold-vertical': '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3 3-3-3"/><path d="m15 5-3-3-3 3"/>',
    'fold-vertical': '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/>',
    'land-plot': '<path d="m12 8 6-3-6-3v10"/><path d="m8 11.99-5.5 3.14a1 1 0 0 0 0 1.74l8.5 4.86a2 2 0 0 0 2 0l8.5-4.86a1 1 0 0 0 0-1.74L16 12"/><path d="m6.49 12.85 11.02 6.3"/><path d="M17.51 12.85 6.5 19.15"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'grid-3x3': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    'pencil-ruler': '<path d="M13 7 8.7 2.7a2.41 2.41 0 0 0-3.4 0L2.7 5.3a2.41 2.41 0 0 0 0 3.4L7 13"/><path d="m8 6 2-2"/><path d="m18 16 2-2"/><path d="m17 11 4.3 4.3c.94.94.94 2.46 0 3.4l-2.6 2.6c-.94.94-2.46.94-3.4 0L11 17"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'
};
function _icon(name) {
    return '<svg class="geo-lidar-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + _ICONS[name] + '</svg>';
}

angular
    .module(pluginConf.code.moduleName, pluginConf.code.dependencies)
    .run(['geoApplication', 'acfExtensionService', '$rootScope', '$timeout', '$injector',
          function (geoApplication, acfExtensionService, $rootScope, $timeout, $injector) {

        // ============================================================
        // Configuration (remplie depuis le générateur GEO)
        // ============================================================
        var _wfsUrl      = 'https://data.geopf.fr/wfs';
        var _pointBudget = 2000000;
        var _lazPerfUrl  = 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.6/lib';
        var _toolName    = 'LiDAR HD';
        // Journal des nouveautés : lien dans la fenêtre d'aide, point rouge sur le bouton « ? » tant que non lu
        var changelog = createChangelog({
            name: pluginConf.name, title: pluginConf.displayName, version: pluginConf.version,
            markdown: changelogMd, prefix: 'geo-lidar'
        });
        var _orthoWmsUrl = 'https://data.geopf.fr/wms-r/wms';   // vide = pas de coloration par orthophoto
        var _orthoMaxSize = 4096;                               // résolution maximale de l'orthophoto (px)
        var _buildingsUrl = '';                                 // dossier des <dalle>.bld = <city3dUrl>/buildings si buildingsEnabled ; vide = désactivé
        // Marge (m) dont on élargit les emprises pour masquer les bâtiments du MNS : 1 m, puis 0,1 m par mètre de hauteur au-delà
        // de 12 m, au plus 3 m (les grands bâtiments dépassent plus leur emprise BD TOPO ; voir marginFor dans buildings.js).
        var _BLD_MARGIN   = { base: 1, from: 12, perMeter: 0.1, cap: 3 };
        var _vegetationUrl = '';                                // dossier des <dalle>.veg = <city3dUrl>/vegetation si treesEnabled ; vide = désactivé

        var _WFS_TYPENAME = 'IGNF_LIDAR-HD_METADONNEE:metadata';
        // Demi-largeurs proposées pour le couloir du profil (m) : de 20 cm à 50 m d'épaisseur.
        var _PROFILE_WIDTHS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 25];
        var _registered   = false;
        var _widgetId     = null;
        var _panelWidthPct = 50;

        // État du panneau ouvert (un seul à la fois)
        var _currentScope = null;
        var _view         = null;   // itowns.View (EPSG:2154)
        var _controls     = null;   // OrbitControls (three) : rotation / pan / zoom autour du centre de la dalle
        var _wheelEl      = null;
        var _wheelHandler = null;
        var _layer        = null;   // itowns.CopcLayer de la dalle cliquée
        var _main         = null;   // dalle cliquée
        var _tiles        = [];     // dalles affichées : la dalle cliquée puis ses voisines, chacune avec sa couche
        var _tileId       = null;   // id de la dalle affichée (évite de recharger la même)
        var _neighbours   = true;   // réglage du générateur : valeur par défaut du bouton « Voisines »
        var _aroundOn     = true;   // charger les 8 dalles voisines en arrière-plan (choix de l'utilisateur)
        var _aroundSeq    = 0;      // invalide un chargement de voisines en cours quand on les désactive
        var _budgetTotal  = 2000000;   // budget de points partagé entre les dalles affichées
        var _CRS_LIST     = parseCrsList(_CRS_DEFAULT).items;   // réglage « crsList » du Générateur
        // Dernière dalle chargée : rechargée à la réouverture du panneau (GEO détruit le module à la fermeture), tant que
        // la fermeture date de moins de _REOPEN_TTL ; le cache de plages COPC est gardé aussi longtemps.
        var _REOPEN_TTL   = 5 * 60 * 1000;
        var _lastLonLat   = null, _closedAt = 0, _cacheTimer = null;
        var _loadSeq      = 0;      // invalide les réponses des clics précédents

        // Calque OpenLayers sur la carte GEO : marqueur + emprise de la dalle
        var _olLayer = null;

        geoApplication.executeWhenInitialized(function () {
            var config = geoApplication.getConfigurationByExtensionKey(pluginConf.name);
            if (config && config.length > 0) {
                var props = config[0].properties;
                _wfsUrl      = (props.wfsUrl || _wfsUrl).trim();
                _pointBudget = parseInt(props.pointBudget, 10) || _pointBudget;
                _lazPerfUrl  = (props.lazPerfUrl || _lazPerfUrl).trim().replace(/\/+$/, '');
                _toolName    = props.toolName || _toolName;
                var crs = parseCrsList(props.crsList);
                _CRS_LIST = crs.items;
                if (crs.unknown.length) { console.warn('[geo-lidar-hd] projections inconnues ignorées :', crs.unknown.join(', ')); }
                if (crs.fallback && props.crsList) { console.warn('[geo-lidar-hd] aucune projection valide dans crsList : liste par défaut.'); }
                var maxSize = parseInt(props.orthoMaxSize, 10);
                if ([1024, 2048, 4096].indexOf(maxSize) !== -1) { _orthoMaxSize = maxSize; }
                _neighbours = props.neighbourTiles !== false;
                if (props.orthoWmsUrl !== undefined && props.orthoWmsUrl !== null) {
                    _orthoWmsUrl = String(props.orthoWmsUrl).trim();
                }
                // Données 3D de la ville : un dossier de base (city3dUrl) et un interrupteur par fonction (voir city3d.js).
                var urls3d = city3dUrls(props);
                _buildingsUrl = urls3d.buildings; _vegetationUrl = urls3d.vegetation;
            }
            if (!_registered) {
                _registered = true;
                _injectStyles();
                _registerWidget();
            }
        });

        // ============================================================
        // Panneau natif GEO (registerWidgetExtension), élargi à la demande
        // ============================================================
        function _registerWidget() {
            acfExtensionService.registerWidgetExtension({
                type:         'rightPanel',
                key:          pluginConf.name,
                extensionKey: pluginConf.name,
                name:         _toolName,
                icon:         'geo-lidar-icon',
                active:       false,
                widthPolicy:  'custom',
                enable:       function () { return true; },
                template:     _buildTemplate(),
                controller:   _buildController(),
                configure:    function (ext) {
                    _widgetId = ext && ext.id ? ext.id : pluginConf.name;
                    _requestPanelWidthSoon();
                }
            });

            $rootScope.$on('activeRightTabChanged', function (event, tabId) {
                if (tabId === pluginConf.name || tabId === _widgetId) { _requestPanelWidthSoon(); }
            });
        }

        function _requestPanelWidth() {
            $rootScope.$broadcast('EXTENSION_WIDGET_ACTION', {
                action:   'setPanelSize',
                widgetId: _widgetId || pluginConf.name,
                width:    _panelWidthPct
            });
            window.dispatchEvent(new Event('resize'));   // iTowns se redimensionne sur 'resize'
        }

        function _requestPanelWidthSoon() {
            [0, 100, 300].forEach(function (delay) { setTimeout(_requestPanelWidth, delay); });
        }

        // ============================================================
        // Template et contrôleur Angular
        // ============================================================
        function _buildTemplate() {
            return [
                '<div class="geo-lidar-widget" ng-class="{\'geo-lidar-widget--tall\': profile.tall && profile.open && !profile.drawing}">',
                '  <div class="geo-lidar-view"></div>',
                '  <div class="geo-lidar-toolbar">',
                '    <label class="geo-lidar-tb-select"><span>Couleurs</span>',
                '      <select ng-model="style.mode" ng-options="m.id as m.label for m in modes" ng-change="applyStyle(true)"></select>',
                '    </label>',
                '    <i class="geo-lidar-sep"></i>',
                '    <button class="geo-lidar-tb" ng-class="{\'geo-lidar-on\': ui.neighbours}" ng-click="toggleNeighbours()" aria-pressed="{{ ui.neighbours }}"',
                '            title="Dalles voisines : charger aussi les 8 dalles qui entourent la dalle cliquée (9 km² au total, plus lourd pour le poste et le réseau)">' + _icon('grid-3x3') + '<span>Voisines</span></button>',
                '    <button class="geo-lidar-tb" ng-class="{\'geo-lidar-on\': ui.panelOpen}" ng-click="togglePanel(\'style\')" ng-disabled="!tile"',
                '            title="Style du nuage : taille des points, classes visibles…">' + _icon('sliders-horizontal') + '<span>Style</span></button>',
                '    <button class="geo-lidar-tb" ng-class="{\'geo-lidar-on\': ui.filtersOpen || filtersActive()}" ng-click="togglePanel(\'filters\')" ng-disabled="!tile"',
                '            title="Filtres : tranche d\'altitude, classes affichées (sol seul, bâti…)">' + _icon('funnel') + '<span>Filtres</span></button>',
                '    <button class="geo-lidar-tb" ng-class="{\'geo-lidar-on\': ui.maqOpen}" ng-click="togglePanel(\'maq\')" ng-disabled="!tile"',
                '            title="Maquette 3D : le terrain et la surface (MNT / MNS) en maillage habillé de l\'orthophoto, du terrain nu à la surface">' + _icon('layers') + '<span>Maquette</span><i class="geo-lidar-dot" ng-if="maq.on && !ui.maqOpen"></i></button>',
                '    <button class="geo-lidar-tb geo-lidar-tb--profile" ng-class="{\'geo-lidar-on\': profile.drawing || profile.open}" ng-click="toggleProfile()" ng-disabled="!tile || mnt.state === \'running\'"',
                '            title="{{ mnt.state === \'running\' ? \'Indisponible pendant l\\\'export du terrain\' : profile.drawing ? \'Annuler le tracé\' : profile.open ? \'Masquer le profil (il reste en mémoire)\' : \'Tracer un profil en travers sur la carte GEO, ou retrouver le dernier\' }}">' + _icon('chart-line') + '<span>Profil</span></button>',
                '    <button class="geo-lidar-tb geo-lidar-tb--terrain" ng-class="{\'geo-lidar-on\': mnt.open}" ng-click="toggleMnt()" aria-label="Exporter le terrain"',
                '            title="{{ mnt.drawing ? \'Annuler le tracé\' : mnt.open ? \'Masquer l\\\'export (l\\\'emprise reste en mémoire)\' : \'Exporter le terrain (MNT) d\\\'une zone en DXF, sous forme de faces 3D, ou retrouver la dernière emprise\' }}">' + _icon('mountain') + '<span>Terrain</span></button>',
                '    <i class="geo-lidar-sep"></i>',
                '    <button class="geo-lidar-tb geo-lidar-tb--icon" ng-click="toggleWide()" title="{{ wide ? \'Réduire le panneau\' : \'Agrandir le panneau\' }}" aria-label="Agrandir ou réduire">',
                '      <span ng-if="!wide">' + _icon('maximize-2') + '</span><span ng-if="wide">' + _icon('minimize-2') + '</span></button>',
                '    <button class="geo-lidar-tb geo-lidar-tb--icon" ng-class="{\'geo-lidar-on\': ui.helpOpen}" ng-click="ui.helpOpen = !ui.helpOpen" title="Aide à la navigation" aria-label="Aide">' + _icon('circle-help') + '<i class="geo-lidar-dot geo-lidar-dot--new" ng-if="changelogNew()"></i></button>',
                '  </div>',
                '  <div class="geo-lidar-panel geo-lidar-panel--style" ng-if="ui.panelOpen && tile">',
                '    <div class="geo-lidar-panel-title">Style du nuage',
                '      <button class="geo-lidar-x" ng-click="startTour(\'style\')" title="Visite guidée du style du nuage" aria-label="Visite guidée du style du nuage">' + _icon('circle-help') + '</button></div>',
                '    <div class="geo-lidar-row"><span>Forme</span>',
                '      <select ng-model="style.shape" ng-change="applyStyle()"><option value="0">Cercle</option><option value="1">Carré</option></select></div>',
                '    <div class="geo-lidar-row geo-lidar-row--size"><span>Taille</span>',
                '      <input type="range" min="1" max="8" step="0.5" ng-model="style.size" ng-change="applyStyle()"><em>{{ style.size }}</em></div>',
                '    <div class="geo-lidar-row geo-lidar-row--attenuated"><span>Atténuation</span>',
                '      <input type="checkbox" ng-model="style.attenuated" ng-change="applyStyle()"></div>',
                '    <div class="geo-lidar-row" ng-if="style.attenuated"><span>Taille min</span>',
                '      <input type="range" min="1" max="10" step="1" ng-model="style.minSize" ng-change="applyStyle()"><em>{{ style.minSize }}</em></div>',
                '    <div class="geo-lidar-row" ng-if="style.attenuated"><span>Taille max</span>',
                '      <input type="range" min="2" max="20" step="1" ng-model="style.maxSize" ng-change="applyStyle()"><em>{{ style.maxSize }}</em></div>',
                '    <div class="geo-lidar-row geo-lidar-row--gamma"><span>Gamma</span>',
                '      <input type="range" min="0.5" max="3" step="0.1" ng-model="style.gamma" ng-change="applyStyle()"><em>{{ style.gamma }}</em></div>',
                '    <div class="geo-lidar-row"><span>Luminosité mini</span>',
                '      <input type="range" min="0" max="1" step="0.05" ng-model="style.ambient" ng-change="applyStyle()"><em>{{ style.ambient }}</em></div>',
                '    <div class="geo-lidar-row geo-lidar-row--opacity"><span>Opacité</span>',
                '      <input type="range" min="0.1" max="1" step="0.05" ng-model="style.opacity" ng-change="applyStyle()"><em>{{ style.opacity }}</em></div>',
                '    <div class="geo-lidar-row geo-lidar-row--sse"><span>Seuil SSE</span>',
                '      <input type="range" min="1" max="10" step="0.5" ng-model="style.sse" ng-change="applyStyle()"><em>{{ style.sse }}</em></div>',
                '    <div class="geo-lidar-row geo-lidar-row--budget"><span>Budget (M pts)</span>',
                '      <input type="range" min="0.5" max="10" step="0.5" ng-model="style.budget" ng-change="applyStyle()"><em>{{ style.budget }}</em></div>',
                '    <div class="geo-lidar-row geo-lidar-row--bg"><span>Fond</span>',
                '      <select ng-model="style.bg" ng-change="applyStyle()"><option value="light">Clair</option><option value="dark">Sombre</option></select></div>',
                '    <div class="geo-lidar-row geo-lidar-row--cache" ng-if="diskCache"><span>Cache disque</span>',
                '      <em>{{ diskCache.text }}</em>',
                '      <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="clearDiskCache()" ng-disabled="!diskCache.count" title="Supprime les données LiDAR et rasters conservées par le navigateur : elles seront retéléchargées au prochain chargement">Vider</button></div>',
                '  </div>',
                '  <div class="geo-lidar-panel geo-lidar-panel--mnt" ng-if="mnt.open && !mnt.drawing">',
                '    <div class="geo-lidar-panel-title">Export du terrain',
                '      <button class="geo-lidar-x" ng-click="closeMnt()" title="Fermer" aria-label="Fermer">' + _icon('x') + '</button>',
                '      <button class="geo-lidar-x" ng-click="startTour(\'mnt\')" title="Visite guidée de l\'export du terrain" aria-label="Visite guidée de l\'export du terrain">' + _icon('circle-help') + '</button></div>',
                '    <div class="geo-lidar-mnt-text" ng-if="!mnt.zone && mnt.state !== \'search\'">Tracez sur la carte GEO le polygone à exporter.</div>',
                '    <div class="geo-lidar-row"><button class="geo-lidar-btn geo-lidar-btn--small geo-lidar-mnt-retrace" ng-click="startMntDraw()" ng-disabled="mnt.drawing || mnt.state === \'running\' || mnt.state === \'search\'">{{ mnt.zone ? "Retracer l\'emprise" : "Tracer l\'emprise" }}</button></div>',
                '    <div class="geo-lidar-mnt-text" ng-if="mnt.state === \'search\'">Recherche des dalles concernées…</div>',
                '    <div class="geo-lidar-mnt-text" ng-if="mnt.zone && mnt.state !== \'search\'">Emprise : <b>{{ mntAreaText() }}</b> · {{ mnt.zone.found }} dalle(s) LiDAR HD</div>',
                '    <div class="geo-lidar-mnt-text geo-lidar-mnt-hint" ng-if="mnt.zone && mnt.state !== \'running\'">Ajustez l\'emprise sur la carte : glissez un sommet pour le déplacer, un segment pour en ajouter un, Alt + clic pour en supprimer un.</div>',
                '    <div class="geo-lidar-mnt-text geo-lidar-mnt-warn" ng-if="mnt.zone && mnt.zone.missing && mnt.state !== \'search\'">{{ mnt.zone.missing }} dalle(s) de l\'emprise sans MNT publié : le maillage aura des trous.</div>',
                '    <div class="geo-lidar-row geo-lidar-row--crs"><span>Projection</span>',
                '      <select ng-model="mnt.crs" ng-options="c.code as c.label for c in mntCrs" ng-disabled="mnt.state === \'running\'"></select></div>',
                '    <div class="geo-lidar-mnt-text geo-lidar-mnt-warn" ng-if="mnt.crs === \'EPSG:4326\'">WGS84 : X = longitude, Y = latitude (en degrés), Z en mètres. Peu adapté à AutoCAD ou Covadis, qui préfèrent un système en mètres.</div>',
                '    <div ng-if="mnt.zone && mnt.zone.found && mnt.state !== \'search\'">',
                '    <div class="geo-lidar-tabs" role="tablist" aria-label="Type d\'export">',
                '      <button role="tab" ng-class="{\'geo-lidar-on\': mnt.tab === \'mnt\'}" aria-selected="{{ mnt.tab === \'mnt\' }}" ng-click="mnt.tab = \'mnt\'">Terrain (MNT)</button>',
                '      <button role="tab" ng-class="{\'geo-lidar-on\': mnt.tab === \'pts\'}" aria-selected="{{ mnt.tab === \'pts\' }}" ng-click="mnt.tab = \'pts\'">Points du nuage</button>',
                '    </div>',
                '    <div role="tabpanel" ng-show="mnt.tab === \'mnt\'">',
                '    <div class="geo-lidar-mnt-text">Fichier DXF en faces 3D : le sol nu (ni bâti, ni ponts, ni végétation), altitudes NGF (IGN69).</div>',
                '    <div class="geo-lidar-row geo-lidar-row--mesh"><span>Maillage</span>',
                '      <select ng-model="mnt.k" ng-options="r.k as r.label for r in mntRes" ng-disabled="mnt.state === \'running\'"></select></div>',
                '    <div class="geo-lidar-row geo-lidar-row--cad"><span>Cadastre</span>',
                '      <input type="checkbox" ng-model="mntCad.on" ng-disabled="mnt.state === \'running\'" title="Ajouter au DXF les couches du cadastre (PCI Vecteur, Etalab)"></div>',
                '    <div ng-if="mntCad.on">',
                '      <div class="geo-lidar-classes">',
                '        <label><input type="checkbox" ng-model="mntCad.parcelles" ng-disabled="mnt.state === \'running\'"> Parcelles</label>',
                '        <label><input type="checkbox" ng-model="mntCad.batiments" ng-disabled="mnt.state === \'running\'"> Bâtiments</label>',
                '        <label><input type="checkbox" ng-model="mntCad.sections" ng-disabled="mnt.state === \'running\'"> Sections</label>',
                '        <label ng-if="mntCad.parcelles"><input type="checkbox" ng-model="mntCad.numeros" ng-disabled="mnt.state === \'running\'"> Numéros</label>',
                '      </div>',
                '      <div class="geo-lidar-row"><span>Surélever</span>',
                '        <input type="checkbox" ng-model="mntCad.lift" ng-disabled="mnt.state === \'running\'" title="Placer le cadastre au-dessus du point le plus haut du MNT, pour qu\'il reste visible en 3D"></div>',
                '      <div class="geo-lidar-row" ng-if="mntCad.lift"><span>Au-dessus du MNT</span>',
                '        <span><input class="geo-lidar-num" type="number" min="0" max="1000" step="1" ng-model="mntCad.liftM" ng-disabled="mnt.state === \'running\'"> m</span></div>',
                '      <div class="geo-lidar-mnt-text geo-lidar-mnt-hint">Cadastre PCI Vecteur (DGFiP) diffusé par Etalab, Licence Ouverte : tracé indicatif, sans valeur de bornage. {{ mntCad.lift ? \'Altitude : point le plus haut du MNT + \' + (mntCad.liftM || 0) + \' m.\' : \'Altitude : Z = 0.\' }}</div>',
                '    </div>',
                '    <div class="geo-lidar-row geo-lidar-row--ortho"><span>Orthophoto</span>',
                '      <input type="checkbox" ng-model="mntOrtho.on" ng-disabled="mnt.state === \'running\' || mnt.crs === \'EPSG:4326\'" title="Livrer aussi l\'orthophoto IGN de l\'emprise, en GeoTIFF géoréférencé dans la projection choisie"></div>',
                '    <div ng-if="mntOrtho.on && mnt.crs !== \'EPSG:4326\'">',
                '      <div class="geo-lidar-row"><span>Résolution</span>',
                '        <select ng-model="mntOrtho.res" ng-options="r.res as r.label for r in mntOrthoRes" ng-disabled="mnt.state === \'running\'"></select></div>',
                '      <div class="geo-lidar-mnt-text" ng-if="mnt.zone && mnt.zone.found">{{ mntOrthoEstimate().images }} image(s) GeoTIFF de {{ mntOrthoEstimate().w | number }} × {{ mntOrthoEstimate().h | number }} px, environ <b>{{ mntOrthoEstimate().size }}</b>, dans une archive ZIP séparée du DXF. Elles couvrent le rectangle englobant l\'emprise.</div>',
                '      <div class="geo-lidar-mnt-text geo-lidar-mnt-warn" ng-if="mntOrthoEstimate().tooBig">Trop volumineux pour une archive ZIP : choisissez une résolution plus grossière ou une emprise plus petite.</div>',
                '    </div>',
                '    <div class="geo-lidar-mnt-text geo-lidar-mnt-hint" ng-if="mnt.crs === \'EPSG:4326\'">Orthophoto indisponible en WGS84 : choisissez une projection en mètres.</div>',
                '    <div class="geo-lidar-mnt-text" ng-if="mnt.zone && mnt.zone.found && mnt.state !== \'search\' && mnt.state !== \'running\'">Environ {{ mntFaces() | number }} faces, fichier d\'environ <b>{{ mntSizeText() }}</b>.</div>',
                '    <div class="geo-lidar-mnt-text geo-lidar-mnt-warn" ng-if="mntTooBig()">Fichier très volumineux, et ce navigateur ne sait pas écrire directement sur le disque : il sera construit en mémoire. Préférez un maillage plus grossier ou une emprise plus petite.</div>',
                '    <div class="geo-lidar-row geo-lidar-mnt-actions">',
                '      <button class="geo-lidar-btn geo-lidar-export--mnt" ng-if="mnt.state !== \'running\'" ng-click="exportMnt()" ng-disabled="!mnt.zone || !mnt.zone.found || mnt.state === \'search\' || (mntOrtho.on && mnt.crs !== \'EPSG:4326\' && mntOrthoEstimate().tooBig)">' + _icon('download') + 'Exporter en DXF</button>',
                '    </div>',
                '    </div>',
                '    <div role="tabpanel" ng-show="mnt.tab === \'pts\'">',
                '    <div class="geo-lidar-mnt-text">Fichier DXF des points (entités POINT, un calque par classe), sur la même emprise.</div>',
                '    <div class="geo-lidar-classes geo-lidar-classes--pts">',
                '      <label ng-repeat="c in mntPtsClasses"><input type="checkbox" ng-model="mntPts.classes[c.id]" ng-disabled="mnt.state === \'running\'"> {{ c.label }}</label>',
                '    </div>',
                '    <div class="geo-lidar-row geo-lidar-row--thin"><span>Densité</span>',
                '      <select ng-model="mntPts.thin" ng-options="t.n as t.label for t in mntPtsThin" ng-disabled="mnt.state === \'running\'"></select></div>',
                '    <div class="geo-lidar-mnt-text" ng-if="mnt.state !== \'running\'">Au plus {{ mntPtsEstimate().points | number }} points (toutes classes), fichier d\'au plus <b>{{ mntPtsEstimate().size }}</b>.</div>',
                '    <div class="geo-lidar-mnt-text geo-lidar-mnt-warn" ng-if="mntPtsTooBig()">Fichier très volumineux, et ce navigateur ne sait pas écrire directement sur le disque : il sera construit en mémoire. Allégez la densité, retirez des classes ou réduisez l\'emprise.</div>',
                '    <div class="geo-lidar-row geo-lidar-mnt-actions">',
                '      <button class="geo-lidar-btn geo-lidar-export--pts" ng-if="mnt.state !== \'running\'" ng-click="exportMntPoints()" ng-disabled="!mntPtsSelected()">' + _icon('download') + 'Exporter les points en DXF</button>',
                '    </div>',
                '    </div>',
                '    </div>',
                // Déroulement de l'export, commun aux deux onglets : reste visible si l'on change d'onglet.
                '    <div class="geo-lidar-mnt-text" ng-if="mnt.state === \'running\'">{{ mnt.msg }}</div>',
                '    <div class="geo-lidar-bar geo-lidar-mnt-bar" ng-if="mnt.state === \'running\'"><div ng-style="{width: mnt.pct + \'%\'}"></div></div>',
                '    <div class="geo-lidar-mnt-text" ng-class="{\'geo-lidar-mnt-warn\': mnt.state === \'error\'}" ng-if="mnt.state === \'done\' || mnt.state === \'error\'">{{ mnt.msg }}</div>',
                '    <div class="geo-lidar-row geo-lidar-mnt-actions" ng-if="mnt.state === \'running\'">',
                '      <button class="geo-lidar-btn geo-lidar-btn--ghost" ng-click="cancelMnt()">' + _icon('x') + 'Annuler</button>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-panel geo-lidar-panel--maq" ng-if="ui.maqOpen && tile">',
                '    <div class="geo-lidar-panel-title">Maquette 3D <span class="geo-lidar-note">MNS / MNT</span>',
                '      <button class="geo-lidar-x" ng-click="togglePanel(\'maq\')" title="Fermer le panneau (la maquette reste affichée)" aria-label="Fermer">' + _icon('x') + '</button>',
                '      <button class="geo-lidar-x" ng-click="startTour(\'maq\')" title="Visite guidée de la maquette 3D" aria-label="Visite guidée de la maquette 3D">' + _icon('circle-help') + '</button></div>',
                '    <div class="geo-lidar-row geo-lidar-row--maq"><span>Afficher</span>',
                '      <input type="checkbox" ng-model="maq.on" ng-change="applyMaq(true)" title="Afficher la maquette à la place du nuage de points"></div>',
                '    <div class="geo-lidar-mnt-text geo-lidar-mnt-hint" ng-if="maq.on && maq.state === \'loading\'">Lecture des rasters MNT / MNS de l\'IGN… les dalles apparaissent au fur et à mesure.</div>',
                '    <div ng-if="maq.on">',
                '      <div class="geo-lidar-maq-slider"><span>Terrain nu</span>',
                '        <input type="range" min="0" max="100" step="1" ng-model="maq.t" ng-change="applyMaq()" title="Glisser du terrain nu (MNT) à la surface (MNS) : bâtiments et arbres montent ou s\'effacent">',
                '        <span>Surface</span></div>',
                '      <div class="geo-lidar-presets">',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="maqPreset(0)">Terrain nu</button>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="maqPreset(100)">Surface</button>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-class="{\'geo-lidar-btn--on\': maq.anim}" ng-click="maqAnimate()" title="Faire glisser le curseur de la surface au terrain nu, puis retour">{{ maq.anim ? \'Arrêter\' : \'Animer\' }}</button>',
                '      </div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-tex"><span>Texture</span>',
                '        <select ng-model="maq.color" ng-change="applyMaq()"><option value="ortho">Orthophoto IGN</option><option value="height">Hauteur au sol</option><option value="grey">Grise (relief seul)</option></select></div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-relief"><span>Relief</span>',
                '        <input type="range" min="1" max="3" step="0.5" ng-model="maq.exag" ng-change="applyMaq()" title="Exagération verticale"><em>×{{ maq.exag }}</em></div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-bld" ng-if="bldEnabled"><span>Bâtiments LoD2</span>',
                '        <input type="checkbox" ng-model="maq.buildings" ng-change="applyMaq()" title="Superposer les bâtiments reconstruits (LoD2) et retirer les bâtiments bruités du MNS"></div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-veg" ng-if="vegEnabled"><span>Arbres</span>',
                '        <input type="checkbox" ng-model="maq.trees" ng-change="applyMaq()" title="Remplacer les cônes de la végétation du MNS par des arbres en volumes simples"></div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-pts"><span>Nuage de points</span>',
                '        <input type="checkbox" ng-model="maq.points" ng-change="applyMaq()" title="Garder le nuage de points affiché avec la maquette"></div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-vid" ng-if="vidOk"><span>Vidéo</span>',
                '        <select ng-model="vid.dur" ng-disabled="vid.state === \'rec\'" ng-options="d as (d + \' s\') for d in [10, 20, 30]" title="Durée d\'un tour complet autour du centre de la vue"></select>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-if="vid.state !== \'rec\'" ng-click="maqVideo()" title="Exporter une vidéo : enregistre un tour complet de la maquette autour du centre choisi (fichier MP4)">Exporter</button>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-if="vid.state === \'rec\'" ng-click="maqVideoCancel()">Annuler</button></div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-vidq" ng-if="vidOk"><span>Qualité</span>',
                '        <select ng-model="vid.q" ng-disabled="vid.state === \'rec\'" ng-options="o.v as o.l for o in [{v: \'hd\', l: \'Full HD (1920 px)\'}, {v: 1, l: \'Taille de la vue\'}, {v: \'4k\', l: \'4K (3840 px)\'}]" title="Résolution de la vidéo : Full HD = 1920 px de large, 4K = 3840 px, quelle que soit la taille du panneau (la 4K donne un fichier plus lourd et peut être moins fluide)"></select></div>',
                '      <div class="geo-lidar-row geo-lidar-row--maq-orbit" ng-if="vidOk"><span>Centre</span>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-class="{\'geo-lidar-btn--on\': vid.pt === \'picking\'}" ng-disabled="vid.state === \'rec\'" ng-click="maqOrbitPick()" title="Cliquer ensuite sur la maquette : la vidéo tournera autour de ce point (il n\'apparaît pas dans la vidéo)">{{ vid.pt === \'picking\' ? \'Cliquez sur la maquette…\' : (vid.pt === \'set\' ? \'Changer le point\' : \'Choisir le point\') }}</button>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-if="vid.pt === \'set\'" ng-disabled="vid.state === \'rec\'" ng-click="maqOrbitClear()" title="Revenir au centre de la vue">Effacer</button></div>',
                '      <div class="geo-lidar-bar geo-lidar-mnt-bar" ng-if="vid.state === \'rec\'"><div ng-style="{width: vid.pct + \'%\'}"></div></div>',
                '      <div class="geo-lidar-mnt-text" ng-class="{\'geo-lidar-mnt-warn\': vid.state === \'error\'}" ng-if="vid.msg">{{ vid.msg }}</div>',
                '      <div class="geo-lidar-mnt-text geo-lidar-mnt-hint">Maille de 1 m pour la dalle cliquée, 2 m pour les voisines. Pointage d\'altitude indisponible tant que le nuage est masqué ; le profil reste utilisable.</div>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-panel geo-lidar-panel--filters" ng-if="ui.filtersOpen && tile">',
                '    <div class="geo-lidar-panel-title">Filtres d\'affichage <span class="geo-lidar-note">3D et profil</span>',
                '      <button class="geo-lidar-x" ng-click="startTour(\'filters\')" title="Visite guidée des filtres" aria-label="Visite guidée des filtres">' + _icon('circle-help') + '</button></div>',
                '    <div class="geo-lidar-tabs">',
                '      <button ng-class="{\'geo-lidar-on\': ui.filterTab === \'alt\'}" ng-click="ui.filterTab = \'alt\'">Altitude<i class="geo-lidar-dot" ng-if="style.altOn"></i></button>',
                '      <button ng-class="{\'geo-lidar-on\': ui.filterTab === \'hag\'}" ng-click="ui.filterTab = \'hag\'">Hauteur au sol<i class="geo-lidar-dot" ng-if="style.hagOn || style.mode === \'HEIGHT\'"></i></button>',
                '    </div>',
                '    <div ng-if="ui.filterTab === \'alt\'">',
                '      <div class="geo-lidar-row geo-lidar-row--f-alt"><span>Filtrer</span>',
                '        <input type="checkbox" ng-model="style.altOn" ng-change="applyAltitude()" ng-disabled="!ui.altAvailable" title="Ne garder qu\'une tranche d\'altitude (NGF)"></div>',
                '      <div class="geo-lidar-row geo-lidar-row--f-altmin" ng-if="style.altOn"><span>Min (m)</span>',
                '        <input type="range" min="{{ style.altLo }}" max="{{ style.altHi }}" step="1" ng-model="style.altMin" ng-change="applyAltitude(\'min\')"><em>{{ style.altMin }}</em></div>',
                '      <div class="geo-lidar-row" ng-if="style.altOn"><span>Max (m)</span>',
                '        <input type="range" min="{{ style.altLo }}" max="{{ style.altHi }}" step="1" ng-model="style.altMax" ng-change="applyAltitude(\'max\')"><em>{{ style.altMax }}</em></div>',
                '      <div class="geo-lidar-row" ng-if="style.altOn"><span></span>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="resetAltitude()">Tout afficher</button></div>',
                '    </div>',
                '    <div ng-if="ui.filterTab === \'hag\'">',
                '      <div class="geo-lidar-mnt-text geo-lidar-mnt-hint" ng-if="!ui.groundReady">Disponible une fois le MNT de la dalle chargé…</div>',
                '      <div class="geo-lidar-row geo-lidar-row--f-hagcolor"><span>Colorer</span>',
                '        <input type="checkbox" ng-checked="style.mode === \'HEIGHT\'" ng-click="toggleHagColor()" ng-disabled="!ui.groundReady" title="Colorer les points selon leur hauteur au-dessus du sol"></div>',
                '      <div class="geo-lidar-row geo-lidar-row--f-hagmax" ng-if="style.mode === \'HEIGHT\'"><span>Rouge à (m)</span>',
                '        <input type="range" min="2" max="80" step="1" ng-model="style.hagColorMax" ng-change="applyStyle()" title="Hauteur à partir de laquelle les points sont rouges"><em>{{ style.hagColorMax }}</em></div>',
                '      <div class="geo-lidar-row geo-lidar-row--f-hag"><span>Filtrer</span>',
                '        <input type="checkbox" ng-model="style.hagOn" ng-change="applyHag()" ng-disabled="!ui.groundReady" title="Ne garder qu\'une tranche de hauteur au-dessus du sol"></div>',
                '      <div class="geo-lidar-row" ng-if="style.hagOn"><span>De (m)</span>',
                '        <input type="range" min="{{ style.hagLo }}" max="{{ style.hagHi }}" step="0.5" ng-model="style.hagFrom" ng-change="applyHag(\'from\')"><em>{{ style.hagFrom }}</em></div>',
                '      <div class="geo-lidar-row" ng-if="style.hagOn"><span>Jusqu\'à (m)</span>',
                '        <input type="range" min="{{ style.hagLo }}" max="{{ style.hagHi }}" step="0.5" ng-model="style.hagTo" ng-change="applyHag(\'to\')"><em>{{ style.hagTo }}</em></div>',
                '      <div class="geo-lidar-presets geo-lidar-presets--hag" ng-if="style.hagOn">',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="hagPreset(\'low\')" title="Ne garder que les 2 premiers mètres au-dessus du sol">≤ 2 m</button>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="hagPreset(\'high\')" title="Ne garder que ce qui dépasse 2 m : canopée, toitures">&gt; 2 m</button>',
                '        <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="hagPreset(\'all\')">Tout afficher</button>',
                '      </div>',
                '    </div>',
                '    <div class="geo-lidar-panel-title">Classes visibles</div>',
                '    <div class="geo-lidar-presets geo-lidar-presets--classes">',
                '      <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="classPreset(\'all\')">Tout</button>',
                '      <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="classPreset(\'ground\')">Sol seul</button>',
                '      <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="classPreset(\'built\')">Bâti</button>',
                '      <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="classPreset(\'nov\')">Sans végétation</button>',
                '    </div>',
                '    <div class="geo-lidar-classes geo-lidar-classes--filters">',
                '      <label ng-repeat="c in classes"><input type="checkbox" ng-model="c.visible" ng-change="applyClasses()">',
                '        <i class="geo-lidar-swatch" ng-style="{background: c.color}"></i>{{ c.name }}</label>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-help" ng-if="ui.helpOpen">',
                '    <div class="geo-lidar-help-title">Navigation 3D</div>',
                '    <div class="geo-lidar-help-body">',
                '      <h4>Souris</h4>',
                '      <ul><li><b>Clic gauche + glisser</b> : pivoter autour de la dalle</li>',
                '          <li><b>Clic droit + glisser</b> (ou Maj + clic gauche) : déplacer la vue</li>',
                '          <li><b>Molette</b> : zoomer vers le curseur</li>',
                '          <li><b>Clic sur un point</b> : son altitude et ses coordonnées</li>',
                '          <li><b>Flèches du clavier</b> : déplacer la vue</li></ul>',
                '      <h4>Trackpad</h4>',
                '      <ul><li><b>Pincement</b> : zoomer</li>',
                '          <li><b>Bouton ' + _icon('touchpad') + '</b> (barre de droite) : le défilement à deux doigts fait alors pivoter et incliner la vue ; à désactiver pour retrouver le zoom</li>',
                '          <li><b>Bouton ' + _icon('hand') + '</b> : le glisser à un doigt <i>déplace</i> le centre de la vue au lieu de la faire pivoter (recliquer pour pivoter à nouveau)</li>',
                '          <li><b>Boutons ' + _icon('rotate-ccw') + _icon('rotate-cw') + _icon('chevron-up') + _icon('chevron-down') + '</b> : pivoter / incliner par pas, sans glisser</li></ul>',
                '      <h4>Boutons</h4>',
                '      <ul><li><b>+ / −</b> zoom · ' + _icon('map') + ' vue de dessus · ' + _icon('focus') + ' retour à la vue initiale</li>',
                '          <li><b>Style</b> : couleurs, taille des points, classes visibles…</li></ul>',
                '      <p class="geo-lidar-help-note">Cliquez ailleurs sur la carte GEO pour charger une autre dalle.</p>',
                '    </div>',
                '    <div class="geo-lidar-help-actions">',
                '      <button class="geo-lidar-help-link" ng-click="openChangelog()" title="Voir les nouveautés de ce module">{{ changelogLabel }}<i class="geo-lidar-dot geo-lidar-dot--new" ng-if="changelogNew()"></i></button>',
                '      <button class="geo-lidar-btn geo-lidar-btn--ghost" ng-click="neverShowHelp()">Ne plus afficher</button>',
                '      <button class="geo-lidar-btn" ng-click="ui.helpOpen = false">Compris</button>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-nav" ng-if="tile">',
                '    <button ng-click="nav(\'in\')" title="Zoom avant" aria-label="Zoom avant">' + _icon('plus') + '</button>',
                '    <button ng-click="nav(\'out\')" title="Zoom arrière" aria-label="Zoom arrière">' + _icon('minus') + '</button>',
                '    <i class="geo-lidar-sep"></i>',
                '    <button ng-click="nav(\'left\')" title="Pivoter vers la gauche" aria-label="Pivoter à gauche">' + _icon('rotate-ccw') + '</button>',
                '    <button ng-click="nav(\'right\')" title="Pivoter vers la droite" aria-label="Pivoter à droite">' + _icon('rotate-cw') + '</button>',
                '    <button ng-click="nav(\'up\')" title="Incliner vers la vue de dessus" aria-label="Incliner vers le haut">' + _icon('chevron-up') + '</button>',
                '    <button ng-click="nav(\'down\')" title="Incliner vers l\'horizontale" aria-label="Incliner vers le bas">' + _icon('chevron-down') + '</button>',
                '    <button ng-click="nav(\'top\')" title="Vue de dessus" aria-label="Vue de dessus">' + _icon('map') + '</button>',
                '    <button ng-click="resetCamera()" title="Recadrer sur la dalle" aria-label="Recadrer">' + _icon('focus') + '</button>',
                '    <i class="geo-lidar-sep"></i>',
                '    <button ng-class="{\'geo-lidar-on\': drag === \'pan\'}" ng-click="toggleDrag()" aria-label="Mode déplacement"',
                '            title="Déplacer : le glisser à un doigt (ou clic gauche) déplace le centre de la vue au lieu de la faire pivoter. Recliquer pour pivoter à nouveau.">' + _icon('hand') + '</button>',
                '    <button ng-class="{\'geo-lidar-on\': wheel === \'orbit\'}" ng-click="toggleWheel()" aria-label="Mode trackpad"',
                '            title="Trackpad : le défilement à deux doigts fait pivoter la vue (le pincement zoome). Cliquer pour activer/désactiver.">' + _icon('touchpad') + '</button>',
                '  </div>',
                '  <div class="geo-lidar-profile" ng-show="profile.open" ng-click="profileClick($event)">',
                '    <div class="geo-lidar-profile-head">',
                '      <strong>Profil en travers</strong>',
                '      <span class="geo-lidar-badge" ng-class="{\'geo-lidar-badge--ok\': profile.exact.state === \'done\', \'geo-lidar-badge--run\': profile.exact.state === \'running\'}"',
                '            title="Aperçu : points affichés en 3D (niveau de détail courant). Pleine densité : tous les points du couloir, relus dans le fichier COPC.">{{ profileBadge() }}</span>',
                '      <span class="geo-lidar-chips" ng-if="profile.info">',
                '        <span class="geo-lidar-chip" title="Longueur du tracé"><em>Longueur</em><b>{{ profile.info.length | number:0 }} m</b></span>',
                '        <span class="geo-lidar-chip" title="Points du couloir affichés"><em>Points</em><b>{{ profile.info.count | number }}</b></span>',
                '        <span class="geo-lidar-chip" ng-if="profile.info.count" title="Altitude des points affichés (NGF)"><em>Altitude</em><b>{{ profile.info.zmin | number:1 }} à {{ profile.info.zmax | number:1 }} m</b></span>',
                '      </span>',
                '      <button class="geo-lidar-x" ng-click="startTour(\'profile\')" title="Visite guidée de l\'outil de profil" aria-label="Visite guidée de l\'outil de profil">' + _icon('circle-help') + '</button>',
                '      <button class="geo-lidar-x" ng-click="profile.tall = !profile.tall" title="{{ profile.tall ? \'Réduire le profil\' : \'Agrandir le profil sur toute la hauteur\' }}" aria-label="Agrandir ou réduire le profil" aria-pressed="{{ !!profile.tall }}">',
                '        <span ng-if="!profile.tall">' + _icon('unfold-vertical') + '</span><span ng-if="profile.tall">' + _icon('fold-vertical') + '</span></button>',
                '      <button class="geo-lidar-x" ng-click="closeProfile()" title="Fermer le profil" aria-label="Fermer">' + _icon('x') + '</button>',
                '    </div>',
                '    <div class="geo-lidar-profile-prog" ng-if="profile.exact.state === \'running\'"><div ng-style="{width: profile.exact.pct + \'%\'}"></div></div>',
                // Bandeau d'infos de hauteur fixe : mesure, survol ou consigne, sous forme de pastilles
                '    <div class="geo-lidar-profile-read">',
                '      <span class="geo-lidar-chips" ng-if="profile.measure">',
                '        <span class="geo-lidar-chip geo-lidar-chip--meas" title="Distance le long du tracé entre A et B"><em>Distance</em><b>{{ profile.measure.ds | number:2 }} m</b></span>',
                '        <span class="geo-lidar-chip geo-lidar-chip--meas" title="Différence d\'altitude B - A"><em>Dénivelé</em><b>{{ profile.measure.dz > 0 ? \'+\' : \'\' }}{{ profile.measure.dz | number:2 }} m</b></span>',
                '        <span class="geo-lidar-chip geo-lidar-chip--meas"><em>Pente</em><b>{{ profile.measure.slope === null ? \'—\' : (profile.measure.slope | number:1) + \' %\' }}</b><em>{{ profile.measure.angle | number:1 }}°</em></span>',
                '        <span class="geo-lidar-chip geo-lidar-chip--meas"><em>3D</em><b>{{ profile.measure.dist3d | number:2 }} m</b></span>',
                '        <span class="geo-lidar-chip" ng-if="profile.measure.hA !== null && profile.measure.hB !== null" title="Hauteur de A et de B au-dessus du sol"><i class="geo-lidar-sw geo-lidar-sw--a"></i><b>{{ profile.measure.hA | number:1 }}</b><i class="geo-lidar-sw geo-lidar-sw--b"></i><b>{{ profile.measure.hB | number:1 }} m</b><em>du sol</em></span>',
                '        <span class="geo-lidar-note geo-lidar-read-note">clic : recommencer</span>',
                '      </span>',
                '      <span class="geo-lidar-chips" ng-if="!profile.measure && profile.hover">',
                '        <span class="geo-lidar-chip"><em>Distance</em><b>{{ profile.hover.s | number:1 }} m</b></span>',
                '        <span class="geo-lidar-chip geo-lidar-chip--snap" ng-if="profile.hover.snap" title="Le curseur est accroché à cet élément du cadastre">' + _icon('land-plot') + '<em>{{ profile.hover.snap }}</em></span>',
                '        <span class="geo-lidar-chip" ng-if="profile.hover.z !== null"><em>Altitude</em><b>{{ profile.hover.z | number:2 }} m</b><em>{{ profile.hover.cls }}</em></span>',
                '        <span class="geo-lidar-chip" ng-if="profile.hover.hag !== null" title="Hauteur du point au-dessus du sol (MNT)"><em>Du sol</em><b>{{ profile.hover.hag | number:1 }} m</b></span>',
                '        <span class="geo-lidar-chip" ng-if="profile.hover.zg !== null"><i class="geo-lidar-sw geo-lidar-sw--g"></i><em>Sol</em><b>{{ profile.hover.zg | number:2 }} m</b></span>',
                '        <span class="geo-lidar-chip" ng-if="profile.hover.zs !== null"><i class="geo-lidar-sw geo-lidar-sw--s"></i><em>Surface</em><b>{{ profile.hover.zs | number:2 }} m</b></span>',
                '        <span class="geo-lidar-chip geo-lidar-chip--hl" ng-if="profile.hover.hs !== null" title="Hauteur de la surface (MNS) au-dessus du sol (MNT) : bâti, végétation"><em>Hauteur</em><b>{{ profile.hover.hs | number:1 }} m</b></span>',
                '        <span class="geo-lidar-note geo-lidar-read-note" ng-if="profile.measuring">cliquez le second point</span>',
                '      </span>',
                '      <span ng-if="!profile.measure && !profile.hover" class="geo-lidar-note geo-lidar-read-hint">',
                '        <span ng-if="profile.exact.state === \'running\'">Lecture du fichier COPC à pleine densité… l\'aperçu s\'affine au fil de l\'eau.</span>',
                '        <span ng-if="profile.exact.state === \'done\' || profile.exact.state === \'partial\'">Survolez le graphique pour lire sol, surface et hauteurs ; cliquez deux points pour mesurer. Molette : zoom.',
                '          <span ng-if="profile.exact.state === \'partial\'">{{ profile.exact.failed }} nœud(s) non lu(s) : « Actualiser » pour réessayer.</span></span>',
                '        <span ng-if="profile.exact.state !== \'running\' && profile.exact.state !== \'done\' && profile.exact.state !== \'partial\'">Aperçu sur les points affichés en 3D : survolez le graphique (mesures en pleine densité).</span>',
                '      </span>',
                '    </div>',
                '    <div class="geo-lidar-profile-plot">',
                '      <canvas class="geo-lidar-profile-canvas" title="Molette : zoomer (Maj : distance seule, Alt : altitude seule) · glisser : déplacer"></canvas>',
                '      <button class="geo-lidar-btn geo-lidar-btn--small geo-lidar-profile-reset" ng-if="profile.zoomed" ng-click="resetProfileZoom()" title="Revenir à la vue entière du profil">' + _icon('maximize-2') + 'Vue entière</button>',
                '      <div class="geo-lidar-profile-empty" ng-if="profile.info && !profile.info.count">Aucun point chargé dans ce couloir : cadrez la zone du tracé dans la vue 3D, puis « Actualiser ».</div>',
                '    </div>',
                // Barre de contrôles sous le graphique : affichage à gauche, actions et export à droite
                '    <div class="geo-lidar-profile-cadnote" ng-if="profile.open && profile.cad" title="Cadastre PCI Vecteur (DGFiP) diffusé par Etalab, Licence Ouverte : tracé indicatif, sans valeur juridique."><b ng-if="profile.cadMsg">{{ profile.cadMsg }} </b>Cadastre PCI Vecteur (DGFiP), Etalab, Licence Ouverte : tracé indicatif, sans valeur juridique.</div>',
                '    <div class="geo-lidar-profile-opts" ng-if="profile.open">',   // ng-if : le curseur est créé après un digest, comme dans le panneau Style
                '      <div class="geo-lidar-opts-group">',
                '        <label class="geo-lidar-opts-color"><span class="geo-lidar-opts-lbl">Couleurs</span> <select aria-label="Couleurs du profil" title="Couleurs du profil" ng-model="profile.color" ng-options="m.id as m.label for m in profileModes" ng-change="profileRedraw()"></select></label>',
                '        <label class="geo-lidar-opts-width" title="Épaisseur totale du couloir, centrée sur le tracé"><span class="geo-lidar-opts-lbl">Épaisseur</span> <b>{{ profile.halfWidth * 2 | number:1 }} m</b> <input aria-label="Épaisseur du couloir" type="range" min="0" max="' + (_PROFILE_WIDTHS.length - 1) + '" step="1" ng-model="profile.widthIdx" ng-change="profileWidthChanged()"></label>',
                '        <button class="geo-lidar-tb geo-lidar-tb--small geo-lidar-tb--scale" ng-class="{\'geo-lidar-on\': profile.equal}" ng-click="profile.equal = !profile.equal; profileRender()" title="Même échelle en distance et en altitude (bâtiments et pentes non déformés)">' + _icon('ruler') + '<span>1:1</span></button>',
                '        <button class="geo-lidar-tb geo-lidar-tb--small geo-lidar-tb--curves" aria-label="Courbes MNT et MNS" ng-class="{\'geo-lidar-on\': profile.curves}" ng-click="profile.curves = !profile.curves; profileRender()" title="Courbes du sol (MNT) et de la surface (MNS) le long du tracé, d\'après les rasters de l\'IGN">' + _icon('chart-line') + '<span>MNT / MNS</span></button>',
                '        <button class="geo-lidar-tb geo-lidar-tb--small geo-lidar-tb--cad" aria-label="Afficher le cadastre" aria-pressed="{{ !!profile.cad }}" ng-class="{\'geo-lidar-on\': profile.cad}" ng-click="profile.cad = !profile.cad; profileCadChanged()" title="Cadastre : limites de parcelles traversées et longueurs situées dans un bâtiment. Le curseur et les mesures s\'y accrochent">' + _icon('land-plot') + '<span>Cadastre</span></button>',
                '      </div>',
                '      <div class="geo-lidar-opts-group geo-lidar-opts-group--end">',
                '        <button class="geo-lidar-tb geo-lidar-tb--small geo-lidar-tb--stop" ng-if="profile.exact.state === \'running\'" ng-click="stopExact()" aria-label="Arrêter" title="Arrêter la lecture à pleine densité (l\'aperçu reste affiché)">' + _icon('x') + '<span>Arrêter</span></button>',
                '        <span class="geo-lidar-opts-group geo-lidar-opts-actions">',
                '        <button class="geo-lidar-tb geo-lidar-tb--small geo-lidar-tb--square" ng-click="refreshProfile()" title="Actualiser : recalculer d\'après les points actuellement affichés" aria-label="Actualiser">' + _icon('refresh-cw') + '</button>',
                '        <button class="geo-lidar-tb geo-lidar-tb--small geo-lidar-tb--square" ng-click="newProfile()" title="Nouveau tracé : tracer un autre profil sur la carte GEO" aria-label="Nouveau tracé">' + _icon('pencil-ruler') + '</button>',
                '        <button class="geo-lidar-tb geo-lidar-tb--small geo-lidar-tb--square" ng-click="frameProfile()" title="Voir en 3D : cadrer la vue 3D sur le tracé (face au plan de coupe)" aria-label="Voir en 3D">' + _icon('focus') + '</button>',
                '        </span>',
                '        <span class="geo-lidar-menu-wrap">',
                '          <button class="geo-lidar-tb geo-lidar-tb--small" ng-class="{\'geo-lidar-on\': ui.exportOpen}" ng-click="ui.exportOpen = !ui.exportOpen" ng-disabled="!profile.info || !profile.info.count" aria-label="Exporter le profil" title="Exporter le profil (image, tableau, DXF)">' + _icon('download') + '<span>Exporter</span>' + _icon('chevron-up-small') + '</button>',
                '          <div class="geo-lidar-menu" ng-if="ui.exportOpen">',
                '            <button ng-click="exportPng(); ui.exportOpen = false" title="Enregistrer le graphique en image PNG"><b>PNG</b><span>image du graphique</span></button>',
                '            <button ng-click="exportCsv(); ui.exportOpen = false" title="Exporter les points affichés en CSV (x, y en Lambert-93, altitude, distance, classe)"><b>CSV</b><span>points du couloir</span></button>',
                '            <button ng-click="exportDxf(false); ui.exportOpen = false" title="Dessin de la coupe en DXF (distance / altitude à l\'échelle 1:1, en mètres) : terrain, courbes MNT et MNS, sommets, pentes, points"><b>DXF coupe</b><span>dessin à l\'échelle 1:1</span></button>',
                '            <button ng-click="exportDxf(true); ui.exportOpen = false" title="Points affichés en DXF 3D géoréférencé (altitude NGF), un calque par classe"><b>DXF 3D</b><span>points géoréférencés</span></button>',
                '            <label class="geo-lidar-menu-crs">Projection du DXF 3D <select ng-model="profile.dxfCrs" ng-options="c.code as c.label for c in mntCrs" ng-change="dxfCrsChanged()"></select></label>',
                '          </div>',
                '        </span>',
                '      </div>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-menu-bg" ng-if="ui.exportOpen" ng-click="ui.exportOpen = false"></div>',
                '  <div class="geo-lidar-pick" ng-if="pick">',
                '    <button class="geo-lidar-x" ng-click="clearPick()" title="Effacer le point" aria-label="Effacer le point">' + _icon('x') + '</button>',
                '    <div>Altitude <b>{{ pick.z | number:2 }} m</b> <span class="geo-lidar-note">NGF · {{ pick.cls }}</span></div>',
                '    <div class="geo-lidar-pick-xy">{{ ui.pickCrs === \'EPSG:4326\' ? \'Lon\' : \'X\' }} {{ pick.x }} · {{ ui.pickCrs === \'EPSG:4326\' ? \'Lat\' : \'Y\' }} {{ pick.y }}</div>',
                '    <div class="geo-lidar-pick-opts">',
                '      <select ng-model="ui.pickCrs" ng-options="c.code as c.name for c in pickCrsList" ng-change="pickCrsChanged()" title="Système de coordonnées affiché"></select>',
                '      <button class="geo-lidar-btn geo-lidar-btn--small" ng-click="copyPick()" title="Copier X, Y et l\'altitude dans le presse-papiers">{{ pick.copied ? \'Copié\' : \'Copier\' }}</button>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-info" ng-if="tile && !profile.open">',
                '    <div class="geo-lidar-info-badge">',
                '      <button class="geo-lidar-info-btn" ng-class="{\'geo-lidar-on\': ui.infoOpen}" ng-click="toggleInfo()" title="{{ infoTitle() }}" aria-label="{{ infoTitle() }}">' + _icon('info') + '</button>',
                '      <svg class="geo-lidar-around-ring" ng-if="aroundBusy()" viewBox="0 0 44 44" aria-hidden="true">',
                '        <circle class="geo-lidar-around-track" cx="22" cy="22" r="20.5"></circle>',
                '        <circle class="geo-lidar-around-arc" cx="22" cy="22" r="20.5" pathLength="100" ng-attr-stroke-dasharray="{{ aroundArc() }} 100"></circle>',
                '      </svg>',
                '    </div>',
                '    <div class="geo-lidar-info-body" ng-if="ui.infoOpen">',
                '    <strong>Dalle {{ tile.name }}</strong><br>',
                '    {{ tile.points | number }} points<br>',
                '    <span ng-if="tile.date">Acquisition : {{ acquisitionLabel() }}<br></span>',
                '    <span ng-if="tile.dateEdition" title="Date de mise à disposition du nuage de points classifié, dont sont dérivés le MNT et le MNS">Publication : {{ frDate(tile.dateEdition) }}<br></span>',
                '    <span ng-if="tile.mission">Mission {{ tile.mission }}<br></span>',
                '    <span ng-if="around">{{ aroundLabel() }}<br></span>',
                '    <a ng-href="{{ tile.url }}" target="_blank" rel="noopener">Télécharger le COPC</a>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-center" ng-if="!tile && !status && !loading">',
                '    <span class="geo-lidar-center-icon">' + _icon('mouse-pointer-click') + '</span>',
                '    <strong>Cliquez sur la carte GEO</strong>',
                '    <span>pour afficher le nuage de points LiDAR HD de la dalle correspondante.</span>',
                '  </div>',
                '  <div class="geo-lidar-legend" ng-class="{\'geo-lidar-up\': profile.open}" ng-if="style.mode === \'HEIGHT\' && ui.groundReady">',
                '    <strong>Hauteur au-dessus du sol</strong>',
                '    <div class="geo-lidar-legend-bar"></div>',
                '    <div class="geo-lidar-legend-scale"><span>0 m</span><span>{{ style.hagColorMax }} m et +</span></div>',
                '  </div>',
                '  <div class="geo-lidar-drawmask" ng-if="profile.drawing || mnt.drawing">',
                '    <div class="geo-lidar-drawcard">',
                '      <span class="geo-lidar-drawarrow">' + _icon('arrow-left') + '</span>',
                '      <strong>{{ mnt.drawing ? "Tracez l\'emprise sur la carte GEO" : "Tracez le profil sur la carte GEO" }}</strong>',
                '      <span>La vue 3D est désactivée pendant le tracé : cliquez sur la <b>carte, à gauche de ce panneau</b>.</span>',
                '      <span ng-if="mnt.drawing">Un clic par sommet (au moins 3), double-clic ou Entrée pour terminer, Échap pour annuler.</span>',
                '      <span ng-if="profile.drawing">Un clic par nœud, double-clic ou Entrée pour terminer, Échap pour annuler.</span>',
                '      <span class="geo-lidar-drawcard-actions">',
                '        <button class="geo-lidar-btn geo-lidar-btn--ghost" ng-click="cancelDraw()">Annuler le tracé</button>',
                '        <button class="geo-lidar-btn geo-lidar-btn--ghost" ng-click="startTour(mnt.drawing ? \'mntDraw\' : \'profileDraw\')" title="Visite guidée de cet outil">' + _icon('circle-help') + 'Visite guidée</button>',
                '      </span>',
                '    </div>',
                '  </div>',
                '  <div class="geo-lidar-center geo-lidar-center--warn" ng-class="{\'geo-lidar-center--up\': profile.open}" ng-if="status">',
                '    <span class="geo-lidar-center-icon">' + _icon('triangle-alert') + '</span>',
                '    <span>{{ status }}</span>',
                '  </div>',
                '  <div class="geo-lidar-center" ng-class="{\'geo-lidar-center--up\': profile.open}" ng-if="loading">',
                '    <div class="geo-lidar-spinner"></div>',
                '    <strong class="geo-lidar-loading-text">{{ loading.text }}</strong>',
                '    <div class="geo-lidar-bar" ng-if="loading.pct !== null"><div ng-style="{width: loading.pct + \'%\'}"></div></div>',
                '  </div>',
                '</div>'
            ].join('\n');
        }

        // Le panneau recouvre la partie droite de la carte GEO : on décale le centre de la vue d'autant, pour que ce qui
        // était au centre de la carte le soit du rectangle resté visible à gauche. Le décalage est mémorisé en pixels
        // (indépendant du zoom) et retiré à la fermeture. Si GEO redimensionne la carte au lieu de la recouvrir,
        // la partie cachée est nulle et rien ne bouge. Rotation de la carte non gérée.
        var _mapShiftPx = 0;
        function _updateMapShift(root) {
            var map = _getOlMap();
            if (!map || !map.getView) { return; }
            var target = 0;
            if (root) {
                var el = map.getTargetElement && map.getTargetElement();
                var mr = el && el.getBoundingClientRect(), r = root.getBoundingClientRect();
                if (mr && mr.width > 0 && r.width > 0) {
                    var hidden = Math.min(mr.width, Math.max(0, mr.right - r.left));
                    if (hidden < mr.width - 120) { target = hidden / 2; }   // panneau plein écran : rien de visible à centrer
                }
            }
            var delta = target - _mapShiftPx;
            console.info('[geo-lidar-hd] recentrage de la carte : décalage visé ' + Math.round(target) + ' px, appliqué ' + Math.round(_mapShiftPx) + ' px');
            if (Math.abs(delta) < 1) { return; }
            var view = map.getView(), c = view.getCenter(), res = view.getResolution();
            if (!c || !res) { return; }
            _mapShiftPx = target;
            view.cancelAnimations();
            view.animate({ center: [c[0] + delta * res, c[1]], duration: 250 });
        }

        // La barre d'outils se replie sur deux lignes quand le panneau est étroit : les panneaux déroulants (Style,
        // Filtres, Export du terrain) et la fiche du point pointé se placent sous elle grâce à --geo-lidar-top.
        function _watchToolbar($element, $scope) {
            var obs = null, timers = [];
            $timeout(function () {
                var root = $element[0] && $element[0].querySelector('.geo-lidar-widget');
                var bar  = root && root.querySelector('.geo-lidar-toolbar');
                if (!bar) { return; }
                var prof = root.querySelector('.geo-lidar-profile');
                function place() {
                    var r = root.getBoundingClientRect(), b = bar.getBoundingClientRect();
                    root.style.setProperty('--geo-lidar-top', Math.round(b.bottom - r.top + 8) + 'px');
                    // les messages d'état et la légende se posent au-dessus du panneau de profil, quelle que soit sa hauteur
                    var ph = prof ? prof.getBoundingClientRect().height : 0;
                    root.style.setProperty('--geo-lidar-up', Math.round(ph + 16) + 'px');
                    _updateMapShift(root);
                }
                place();
                // À l'ouverture, le panneau glisse ou s'élargit après coup (transition CSS, setPanelSize de GEO) : un
                // simple changement de position n'est pas vu par le ResizeObserver, d'où quelques mesures différées.
                [100, 300, 600, 1000, 1600, 2500].forEach(function (d) { timers.push(setTimeout(function () { _updateMapShift(root); }, d)); });
                var mapEl = (_getOlMap() || {}).getTargetElement && _getOlMap().getTargetElement();
                if (window.ResizeObserver) {
                    obs = new window.ResizeObserver(place); obs.observe(bar); obs.observe(root); if (prof) { obs.observe(prof); }
                    if (mapEl) { obs.observe(mapEl); }   // GEO redimensionne la carte à l'ouverture du panneau
                }
                else { window.addEventListener('resize', place); obs = { disconnect: function () { window.removeEventListener('resize', place); } }; }
            });
            $scope.$on('$destroy', function () {
                timers.forEach(clearTimeout);
                if (obs) { obs.disconnect(); obs = null; }
                _updateMapShift(null);   // la carte retrouve son centre d'origine
            });
        }

        function _buildController() {
            return ['$scope', '$element', function ($scope, $element) {
                _currentScope  = $scope;
                _panelWidthPct = 50;
                _watchToolbar($element, $scope);

                $scope.loading   = null;
                $scope.tile      = null;
                $scope.frDate    = _frDate;
                $scope.acquisitionLabel = function () {
                    var t = $scope.tile;
                    if (!t) { return ''; }
                    return t.dateStart && t.dateStart !== t.date
                        ? 'du ' + _frDate(t.dateStart) + ' au ' + _frDate(t.date)
                        : _frDate(t.date);
                };
                $scope.around    = null;               // avancement des dalles voisines : { state, loaded, total }
                $scope.status    = null;
                $scope.wide      = false;
                $scope.pick      = null;               // point cliqué dans le nuage : altitude, classe, coordonnées
                $scope.pickCrsList = _CRS_LIST;
                $scope.ui        = { pickCrs: _readPickCrs(), panelOpen: false, filtersOpen: false, classesOpen: false, modeUserSet: false, orthoReady: false, groundReady: false, heightOn: false, prevMode: null, filterTab: 'alt', exportOpen: false, maqOpen: false, hasColor: false, helpOpen: false, helpAuto: false, infoOpen: _readInfoOpen() };
                _aroundOn = _readNeighbours();
                $scope.ui.neighbours = _aroundOn;      // bouton « Voisines » : choix mémorisé, sinon réglage du générateur
                // Réglages de rendu : conservés d'une dalle à l'autre tant que le panneau reste ouvert.
                $scope.style     = { mode: 'CLASSIFICATION', shape: '0', size: 2, attenuated: true, minSize: 3, maxSize: 10,
                                     gamma: 1, ambient: 0, opacity: 1, sse: 2, budget: _pointBudget / 1e6, bg: 'light',
                                     altOn: false, altLo: 0, altHi: 1, altMin: 0, altMax: 1,
                                     hagColorMax: 30, hagOn: false, hagLo: -2, hagHi: 60, hagFrom: -2, hagTo: 60 };
                // Cache disque : taille affichée dans le panneau Style, et bouton pour le vider.
                $scope.diskCache = null;
                function _refreshDiskCache() {
                    _diskCache.stats().then(function (st) {
                        $scope.$evalAsync(function () {
                            $scope.diskCache = st ? { count: st.count, text: _fmtBytes(st.bytes) + ' / ' + _fmtBytes(st.max) } : null;
                        });
                    });
                }
                function _fmtBytes(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' Go' : Math.round(n / 1048576) + ' Mo'; }
                $scope.clearDiskCache = function () { _clearRangeCache(); _diskCache.clear().then(_refreshDiskCache); };
                $scope.$watch('ui.panelOpen', function (open) { if (open) { _refreshDiskCache(); } });
                $scope.wheel     = _readWheelPref();   // 'zoom' (molette) ou 'orbit' (deux doigts = rotation)
                $scope.drag      = 'rotate';           // glisser à un doigt : 'rotate' ou 'pan'
                $scope.classes   = [];
                $scope.modes     = _modeList($scope.ui);
                // Profil en travers : ligne tracée sur la carte GEO, graphique calculé sur les points chargés.
                $scope.profile   = { open: false, drawing: false, halfWidth: 5, widthIdx: _PROFILE_WIDTHS.indexOf(5), color: 'CLASSIFICATION', equal: false,
                                     zoomed: false, curves: true, tall: false, cad: false, cadMsg: '', dxfCrs: _readDxfCrs(), info: null, hover: null, exact: { state: 'idle', pct: 0 }, measure: null, measuring: false };
                $scope.profileModes = _profileModeList($scope.ui);
                // Export du terrain (MNT) en DXF : emprise tracée sur la carte GEO, maillage en faces 3D.
                $scope.mntCrs = _CRS_LIST;
                $scope.dxfCrsChanged = function () { _saveDxfCrs($scope.profile.dxfCrs); };
                $scope.mntRes = _MNT_RES;
                // Maquette 3D : t = curseur terrain nu (0) -> surface (100), exag = exagération verticale
                $scope.vid = { dur: 20, q: 'hd', state: 'idle', pct: 0, msg: '', pt: 'none' };   // pt : 'none' | 'picking' | 'set' (point d'orbite)   // export vidéo de la maquette (tour autour du centre de la vue)
                $scope.vidOk = _videoSupported();
                $scope.maq = { on: false, touched: false, t: 100, exag: 1, color: 'ortho', points: false, buildings: true, trees: true, anim: false, state: 'idle' };
                $scope.vegEnabled = !!_vegetationUrl;   // la case « Arbres » n'existe que si city3dUrl est renseigné et treesEnabled non décoché
                $scope.bldEnabled = !!_buildingsUrl;   // la case « Bâtiments LoD2 » n'existe que si city3dUrl est renseigné et buildingsEnabled non décoché
                $scope.mntPts = { classes: { 2: true }, thin: 1 };   // sol seul par défaut
                $scope.mntCad = { on: false, parcelles: true, batiments: true, sections: false, numeros: true, lift: false, liftM: 10 };
                $scope.mntOrtho = { on: false, res: 0.2 };
                $scope.mntOrthoRes = _ORTHO_RES;
                $scope.mntOrthoEstimate = function () { return _orthoPlan($scope.mnt.crs, $scope.mntOrtho.res); };
                $scope.mntPtsClasses = _PTS_CLASSES.map(function (id) { return { id: id, label: _CLASS_NAMES[id] || ('Classe ' + id) }; });
                $scope.mntPtsThin = _PTS_THIN;
                $scope.mnt = { open: false, drawing: false, state: 'idle', zone: null, crs: _CRS_LIST[0].code, k: 1, pct: 0, msg: '', tab: 'mnt' };

                var _pointerClickSub = null;

                $scope.applyStyle = function (modeChanged) {
                    if (modeChanged) { $scope.ui.modeUserSet = true; }
                    _syncModes();
                    _applyStyle();
                };
                $scope.filtersActive = function () {
                    return !!($scope.style.altOn || $scope.style.hagOn || $scope.classes.some(function (c) { return !c.visible; }));
                };
                $scope.applyClasses = function () { _applyClasses(); _renderProfile(); };
                // Tranche d'altitude : Min ne dépasse jamais Max (et inversement) ; le profil suit le même filtre.
                $scope.applyAltitude = function (which) {
                    var st = $scope.style;
                    st.altMin = Number(st.altMin); st.altMax = Number(st.altMax);
                    if (st.altMin > st.altMax) { if (which === 'min') { st.altMax = st.altMin; } else { st.altMin = st.altMax; } }
                    _applyStyle();
                    _renderProfile();
                };
                $scope.resetAltitude = function () {
                    var st = $scope.style;
                    st.altMin = st.altLo; st.altMax = st.altHi;
                    _applyStyle();
                    _renderProfile();
                };
                // Hauteur au-dessus du sol : De ne dépasse jamais Jusqu'à (et inversement) ; le profil suit le même filtre.
                $scope.applyHag = function (which) {
                    var st = $scope.style;
                    st.hagFrom = Number(st.hagFrom); st.hagTo = Number(st.hagTo);
                    if (st.hagFrom > st.hagTo) { if (which === 'from') { st.hagTo = st.hagFrom; } else { st.hagFrom = st.hagTo; } }
                    _applyStyle();
                    _renderProfile();
                };
                // Case « Colorer » de l'onglet Hauteur au sol : bascule le mode de couleur et se souvient du précédent.
                $scope.toggleHagColor = function () {
                    var st = $scope.style, ui = $scope.ui;
                    if (st.mode === 'HEIGHT') { st.mode = _modeAvailable(ui.prevMode, ui) ? ui.prevMode : 'CLASSIFICATION'; }
                    else { ui.prevMode = st.mode; st.mode = 'HEIGHT'; }
                    ui.modeUserSet = true;
                    _syncModes();
                    _applyStyle();
                };
                $scope.hagPreset = function (name) {
                    var st = $scope.style;
                    if (name === 'low')        { st.hagFrom = st.hagLo; st.hagTo = 2; }      // les deux premiers mètres : sol, buissons, bas des murs
                    else if (name === 'high')  { st.hagFrom = 2; st.hagTo = st.hagHi; }      // tout ce qui dépasse : canopée, toitures
                    else                       { st.hagFrom = st.hagLo; st.hagTo = st.hagHi; }
                    _applyStyle();
                    _renderProfile();
                };
                // Préréglages de classification : « sol seul », « bâti »…
                $scope.classPreset = function (name) {
                    var show = {
                        all:    function () { return true; },
                        ground: function (c) { return c.id === 2; },
                        built:  function (c) { return c.id === 6 || c.id === 17; },
                        nov:    function (c) { return [3, 4, 5].indexOf(c.id) === -1; }
                    }[name];
                    $scope.classes.forEach(function (c) { c.visible = show(c); });
                    _applyClasses();
                    _renderProfile();
                };
                // Style, Filtres et Maquette partagent le même emplacement : un seul ouvert à la fois.
                $scope.togglePanel = function (name) {
                    var ui = $scope.ui, was = { style: ui.panelOpen, filters: ui.filtersOpen, maq: ui.maqOpen }[name];
                    ui.panelOpen = ui.filtersOpen = ui.maqOpen = false;
                    if (was) { return; }
                    if (name === 'style') { ui.panelOpen = true; }
                    else if (name === 'filters') { ui.filtersOpen = true; }
                    else {
                        ui.maqOpen = true;
                        if (!$scope.maq.touched) { $scope.maq.touched = true; $scope.maq.on = true; _maquetteUpdate(); }   // première ouverture : on l'affiche
                    }
                };
                $scope.applyMaq = function (toggled) {
                    if (toggled && !$scope.maq.on) { _maqStopAnim(); }
                    _maquetteUpdate();
                };
                $scope.maqPreset = function (t) { _maqStopAnim(); $scope.maq.t = t; _applyMaquette(); };
                $scope.maqAnimate = function () { _maqPlay(); };
                $scope.maqVideo = function () { _maqRecord(); };
                $scope.maqVideoCancel = function () { _vidAbort(); };
                $scope.maqOrbitPick = function () { _orbitPicking ? _orbitPickStop() : _orbitPickStart(); };
                $scope.maqOrbitClear = function () { _orbitClear(); };
                $scope.toggleMnt = function () {
                    if ($scope.mnt.state === 'running') { return; }   // ne pas interrompre un export en cours
                    if (_mntDraw) { _abortMntDraw(); return; }
                    if ($scope.mnt.open) { _suspendMnt(); return; }
                    if (_drawInteraction) {
                        var back = _drawReturn === 'mnt';
                        _abortProfileDraw();
                        if (back) { return; }   // le retour à Terrain vient d'avoir lieu
                    }
                    var left = _prof ? _suspendProfile() : false;   // un seul outil à la fois : l'autre garde son tracé en mémoire
                    $scope.mnt.open = true;
                    _syncMntModify();
                    if (_restoreMnt()) { return; }
                    if (!$scope.mnt.zone && $scope.mnt.state === 'idle') {   // comme le profil : tracé direct
                        $scope.startMntDraw();
                        if (left) { _drawReturn = 'profile'; }
                    }
                };
                $scope.closeMnt = function () { _closeMnt(); };
                $scope.startMntDraw = function () {
                    if ($scope.wide) { $scope.toggleWide(); }   // la carte doit rester visible pour tracer
                    _startMntDraw();
                };
                $scope.startTour = function (kind) { _startTour(kind, $element); };
                $scope.cancelDraw = function () { _abortMntDraw(); _abortProfileDraw(); };
                $scope.exportMnt = function () { _exportMnt(); };
                $scope.cancelMnt = function () { _stopMnt(); };
                $scope.exportMntPoints = function () { _exportMntPoints(); };
                $scope.mntPtsSelected = function () {
                    return _PTS_CLASSES.some(function (c) { return $scope.mntPts.classes[c]; });
                };
                $scope.mntPtsEstimate = function () { return _ptsEstimate($scope.mnt.zone, $scope.mntPts.thin); };
                $scope.mntPtsTooBig = function () {
                    var z = $scope.mnt.zone;
                    return !!(z && z.found && !window.showSaveFilePicker && $scope.mnt.state !== 'running' &&
                              _ptsEstimate(z, $scope.mntPts.thin).bytes > _MNT_MEMORY_WARN);
                };
                $scope.mntAreaText = function () { return _mntAreaText($scope.mnt.zone); };
                $scope.mntFaces = function () { return _mntEstimate($scope.mnt.zone, $scope.mnt.k).faces; };
                $scope.mntSizeText = function () { return _fmtBytes(_mntEstimate($scope.mnt.zone, $scope.mnt.k).bytes); };
                $scope.mntTooBig = function () {
                    var z = $scope.mnt.zone;
                    return !!(z && z.found && !window.showSaveFilePicker && $scope.mnt.state !== 'running' &&
                              _mntEstimate(z, $scope.mnt.k).bytes > _MNT_MEMORY_WARN);
                };
                $scope.toggleProfile = function () {
                    if ($scope.mnt.state === 'running') { return; }   // ne pas interrompre un export en cours
                    if (_drawInteraction) { _abortProfileDraw(); return; }
                    if (_mntDraw) {
                        var back = _drawReturn === 'profile';
                        _abortMntDraw();
                        if (back) { return; }   // le retour au profil vient d'avoir lieu
                    }
                    if (_prof) { _suspendProfile(); return; }
                    var left = $scope.mnt.open ? _suspendMnt() : false;   // un seul outil à la fois : l'autre garde son emprise en mémoire
                    if (_restoreProfile()) { return; }
                    $scope.newProfile();
                    if (left) { _drawReturn = 'mnt'; }
                };
                $scope.newProfile = function () {
                    if ($scope.wide) { $scope.toggleWide(); }   // la carte doit rester visible pour tracer
                    _startProfileDraw();
                };
                $scope.toggleNeighbours = function () {
                    $scope.ui.neighbours = !$scope.ui.neighbours;
                    _saveNeighbours($scope.ui.neighbours);
                    _setNeighbours($scope.ui.neighbours);
                };
                $scope.aroundLabel = function () {
                    var a = $scope.around;
                    if (!a) { return ''; }
                    if (a.state === 'search') { return 'Recherche des dalles voisines…'; }
                    if (a.state === 'error')  { return 'Dalles voisines indisponibles'; }
                    if (a.state === 'loading') { return 'Dalles voisines : ' + a.settled + ' / ' + a.total + '…'; }
                    var failed = a.failed ? ' — ' + a.failed + (a.failed > 1 ? ' non chargées' : ' non chargée') : '';
                    if (a.empty) { failed += ' — ' + a.empty + ' sans point affiché'; }
                    if (!a.loaded) { return (failed ? 'Aucune dalle voisine chargée' : 'Aucune dalle voisine disponible') + failed; }
                    return '+ ' + a.loaded + (a.loaded > 1 ? ' dalles voisines' : ' dalle voisine') +
                           (a.loaded < 8 ? ' (sur 8)' : '') + failed;
                };
                $scope.aroundBusy = function () {
                    var a = $scope.around;
                    return !!a && (a.state === 'search' || a.state === 'loading');
                };
                // Longueur de l'arc de l'anneau, en % : jamais nulle pour que l'anneau reste visible au début du chargement.
                $scope.aroundArc = function () {
                    var a = $scope.around;
                    return a && a.total ? Math.max(12, Math.round(100 * a.settled / a.total)) : 12;
                };
                $scope.infoTitle = function () {
                    var base = $scope.ui.infoOpen ? 'Masquer les informations de la dalle' : 'Informations sur la dalle';
                    var around = $scope.aroundLabel();
                    return around ? base + ' — ' + around : base;
                };
                $scope.clearPick = function () { _clearPick(); };
                $scope.pickCrsChanged = function () { _savePickCrs($scope.ui.pickCrs); _formatPick(); };
                $scope.copyPick = function () { _copyPick(); };
                $scope.closeProfile = function () { _closeProfile(); };
                $scope.refreshProfile = function () { _computeProfile(); };
                $scope.profileRender = function () { _resetProfileZoom(); _renderProfile(); };
                $scope.profileRedraw = function () { _drawProfile(); };
                $scope.profileCadChanged = function () { _loadProfileCadastre(); _drawProfile(); };
                $scope.resetProfileZoom = function () { _resetProfileZoom(); _drawProfile(); };
                $scope.stopExact = function () { _stopExact(false); };
                $scope.frameProfile = function () { _frameProfile(); _refreshProfileSoon(); };
                // Un clic dans le profil, hors du menu d'export, referme ce menu.
                $scope.profileClick = function (ev) {
                    if ($scope.ui.exportOpen && !(ev.target.closest && ev.target.closest('.geo-lidar-menu-wrap'))) { $scope.ui.exportOpen = false; }
                };
                $scope.exportPng = function () { _exportPng(); };
                $scope.exportCsv = function () { _exportCsv(); };
                $scope.exportDxf = function (points3d) { if (points3d) { _exportDxfPoints(); } else { _exportDxfSection(); } };
                $scope.profileBadge = function () {
                    var e = $scope.profile.exact;
                    return e.state === 'running' ? 'Affinage ' + e.pct + ' %' :
                           e.state === 'done' ? 'Pleine densité' :
                           e.state === 'partial' ? 'Pleine densité (incomplète)' : 'Aperçu';
                };
                $scope.profileWidthChanged = function () {
                    $scope.profile.halfWidth = _PROFILE_WIDTHS[Number($scope.profile.widthIdx)] || 5;
                    _drawBand(); _refreshProfileSoon();
                };
                $scope.resetCamera = function () { _frameLayer(); };
                $scope.nav = function (action) {
                    switch (action) {
                        case 'left':    _orbit(-0.26, 0); break;
                        case 'right':   _orbit(0.26, 0);  break;
                        case 'up':      _orbit(0, -0.17); break;   // vers la vue de dessus
                        case 'down':    _orbit(0, 0.17);  break;   // vers l'horizontale
                        case 'in':      _dolly(0.7);      break;
                        case 'out':     _dolly(1 / 0.7);  break;
                        case 'top':     _topView();       break;
                    }
                };
                $scope.toggleInfo = function () { $scope.ui.infoOpen = !$scope.ui.infoOpen; _saveInfoOpen($scope.ui.infoOpen); };
                $scope.changelogLabel = (changelog.current ? 'v' + changelog.current + ' · ' : '') + 'Nouveautés';
                $scope.changelogNew   = function () { return changelog.hasNew(); };
                $scope.openChangelog  = function () { changelog.open(); };
                $scope.neverShowHelp = function () { _dismissHelp(); $scope.ui.helpOpen = false; };
                $scope.toggleDrag = function () {
                    $scope.drag = $scope.drag === 'pan' ? 'rotate' : 'pan';
                    _setDragMode($scope.drag);
                };
                $scope.toggleWheel = function () {
                    $scope.wheel = $scope.wheel === 'orbit' ? 'zoom' : 'orbit';
                    _saveWheelPref($scope.wheel);
                };
                $scope.toggleWide = function () {
                    $scope.wide = !$scope.wide;
                    _panelWidthPct = $scope.wide ? 100 : 50;
                    _requestPanelWidthSoon();
                };

                // Le conteneur doit être dans le DOM (et dimensionné) avant de créer le View WebGL.
                // Module masqué puis rouvert : le nouveau panneau reprend l'état de l'ancien (réglages, dalle, outils).
                if (_parked) {
                    var _old = _parked.scope;
                    Object.keys(_old).forEach(function (k) {
                        if (k.charAt(0) !== '$' && typeof _old[k] !== 'function') { $scope[k] = _old[k]; }
                    });
                    _panelWidthPct = $scope.wide ? 100 : 50;
                }

                $timeout(function () {
                    var viewerDiv = $element[0].querySelector('.geo-lidar-view');
                    if (!viewerDiv) { return; }
                    _bindProfileCanvas($element[0].querySelector('.geo-lidar-profile-canvas'));
                    var parked = _parked;
                    _parked = null;
                    if (parked && _viewAlive()) {
                        _unparkView(parked, viewerDiv);
                    } else {
                        if (parked) {   // contexte WebGL perdu pendant le masquage : on repart de la dernière dalle
                            console.warn('[geo-lidar-hd] vue 3D perdue pendant le masquage : rechargement de la dalle.');
                            _disposeParked(parked);
                        }
                        try {
                            _createView(viewerDiv);
                        } catch (e) {
                            console.error('[geo-lidar-hd] initialisation 3D impossible :', e);
                            _setStatus('WebGL indisponible ou initialisation 3D impossible (voir console).');
                            return;
                        }
                        if (_cacheTimer) { clearTimeout(_cacheTimer); _cacheTimer = null; }
                        if (_lastLonLat && (parked || Date.now() - _closedAt < _REOPEN_TTL)) { _loadAt(_lastLonLat); }   // réouverture : même dalle
                    }
                    if (geoApplication.map && geoApplication.map.on) {
                        _pointerClickSub = geoApplication.map.on('pointerClick', function (event) {
                            _locateFromMapClick(event.coordinates, event.crs);
                        });
                    }
                });

                $scope.$on('$destroy', function () {
                    if (_pointerClickSub) { _pointerClickSub.unsubscribe(); _pointerClickSub = null; }
                    _stopTour();
                    // Le module est seulement masqué : la vue et son état restent en mémoire jusqu'à sa réouverture.
                    if (_parked) { _parked.scope = $scope; return; }   // refermé avant la fin de sa réouverture
                    if (_view && _viewAlive()) { _parkView($scope, $element); return; }
                    _loadSeq++;                 // ignore toute réponse encore en vol
                    _stopStreamWatch();
                    _stopAroundWatch();
                    _unbindProfileCanvas();
                    _cancelProfileDraw();
                    _cancelMntDraw();
                    _profMemo = _mntMemo = _drawReturn = null;   // la mémoire des outils ne survit pas à la fermeture de la vue
                    _cadFiles.clear();
                    _maqStopAnim(); _vidAbort(); _orbitClear();
                    _stopMnt(true);
                    if (_mntModify) { try { _mntModify.map.removeInteraction(_mntModify.interaction); } catch (e) { /* carte détruite */ } _mntModify = null; }
                    _disposeView();
                    Object.keys(_maqGeo).forEach(function (k) { _maqGeo[k].dispose(); delete _maqGeo[k]; });
                    _closedAt = Date.now();
                    if (_cacheTimer) { clearTimeout(_cacheTimer); }
                    _cacheTimer = setTimeout(function () { _cacheTimer = null; _lastLonLat = null; _clearRangeCache(); }, _REOPEN_TTL);
                    _clearMapOverlay();
                    _tileId = null;
                    _currentScope = null;
                });
            }];
        }

        // Message d'erreur / d'information : remplace tout indicateur de chargement en cours.
        function _setStatus(message) {
            _stopStreamWatch();
            if (_currentScope) {
                $timeout(function () {
                    if (_currentScope) { _currentScope.status = message; _currentScope.loading = null; }
                });
            }
        }

        // Indicateur de chargement : spinner + libellé d'étape, et barre si pct (0-100) est connu.
        function _setLoading(text, pct) {
            if (_currentScope) {
                $timeout(function () {
                    if (_currentScope) {
                        _currentScope.status  = null;
                        _currentScope.loading = { text: text, pct: pct === undefined ? null : pct };
                    }
                });
            }
        }

        // Suit l'arrivée des points après l'ajout de la couche : iTowns les streame par nœuds d'octree.
        // Terminé quand le compteur de points ne bouge plus (le scheduler iTowns n'est jamais vraiment vide).
        var _watchTimer = null;
        function _stopStreamWatch() {
            if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
        }
        function _watchStreaming(layer, tile, seq) {
            _stopStreamWatch();
            var target = Math.min(_pointBudget, tile.points || _pointBudget);
            var last = -1, stable = 0;
            _watchTimer = setInterval(function () {
                if (seq !== _loadSeq || !_view || !_currentScope) { _stopStreamWatch(); return; }
                var n = layer.displayedCount || 0;
                stable = (n === last) ? stable + 1 : 0;
                last = n;
                if (stable >= 5) {   // 5 x 400 ms sans nouveau point
                    _stopStreamWatch();
                    $timeout(function () { if (_currentScope) { _currentScope.loading = null; } });
                    _refreshProfileSoon();   // le niveau de détail est stabilisé : l'aperçu gagne en densité
                    _loadNeighbours(seq);
                    return;
                }
                _setLoading('Chargement des points… ' + (n / 1e6).toFixed(1) + ' M',
                            Math.min(99, Math.round(100 * n / target)));
            }, 400);
        }

        // ============================================================
        // Vue iTowns (Lambert-93)
        // ============================================================
        var _UP = new Vector3(0, 0, 1);
        var _WHEEL_KEY = 'geo-lidar-hd-wheel';
        var _HELP_KEY  = 'geo-lidar-hd-help-dismissed';

        // « Ne plus afficher » est mémorisé dans le navigateur (localStorage peut être indisponible).
        function _isHelpDismissed() {
            try { return window.localStorage.getItem(_HELP_KEY) === '1'; } catch (e) { return false; }
        }
        function _dismissHelp() {
            try { window.localStorage.setItem(_HELP_KEY, '1'); } catch (e) { /* ignoré */ }
        }

        function _readWheelPref() {
            try { return window.localStorage.getItem(_WHEEL_KEY) === 'orbit' ? 'orbit' : 'zoom'; } catch (e) { return 'zoom'; }
        }
        function _saveWheelPref(v) {
            try { window.localStorage.setItem(_WHEEL_KEY, v); } catch (e) { /* ignoré */ }
        }

        function _createView(viewerDiv) {
            LASParser.enableLazPerf(_lazPerfUrl);
            _view = new View('EPSG:2154', viewerDiv, { disableFocusOnStart: true });
            _view.mainLoop.gfxEngine.renderer.setClearColor(_BG.light);
            _view.addFrameRequester(MAIN_LOOP_EVENTS.BEFORE_RENDER, _applyBudget);

            // Orbit (plutôt que PlanarControls, dont la rotation exige Ctrl + glisser : inutilisable au trackpad).
            // Gauche = pivoter, droit / Maj + gauche = déplacer, molette ou pincement = zoom sur le curseur.
            var camera = _view.camera.camera3D;
            camera.up.copy(_UP);
            _controls = new OrbitControls(camera, viewerDiv);
            _controls.enableDamping = false;            // iTowns ne rend qu'à la demande (notifyChange)
            _controls.zoomToCursor = true;
            _controls.screenSpacePanning = true;
            _controls.maxPolarAngle = Math.PI * 0.495;  // reste au-dessus du sol
            // Flèches du clavier = déplacer (la vue doit avoir le focus : on le prend au clic).
            _controls.listenToKeyEvents(viewerDiv);
            viewerDiv.addEventListener('pointerdown', function () { viewerDiv.focus({ preventScroll: true }); });
            _controls.addEventListener('change', function () { if (_p3d) { _scale3d(); } _scalePick(); if (_view) { _view.notifyChange(camera); } });
            _bindPick(viewerDiv);

            // Mode « deux doigts = rotation » : le défilement à deux doigts d'un trackpad (sans Ctrl) pivote la
            // vue ; le pincement (qui arrive avec ctrlKey) continue de zoomer. Écouteur en capture sur le parent
            // pour passer avant celui d'OrbitControls.
            _wheelEl = viewerDiv.parentElement || viewerDiv;
            _wheelHandler = function (e) {
                if (!_currentScope || _currentScope.wheel !== 'orbit' || e.ctrlKey || e.target === _profCanvas) { return; }
                e.preventDefault();
                e.stopPropagation();
                var k = (e.deltaMode === 1 ? 16 : 1) * 0.004;
                _orbit(-e.deltaX * k, e.deltaY * k);
            };
            _wheelEl.addEventListener('wheel', _wheelHandler, { capture: true, passive: false });
        }

        // Geste à un doigt / clic gauche : pivoter (défaut) ou déplacer le centre du point de vue. Le mode
        // « déplacer » rend la translation possible au trackpad, où le clic droit et Maj + glisser sont pénibles.
        function _setDragMode(mode) {
            if (!_controls) { return; }
            _controls.mouseButtons.LEFT = mode === 'pan' ? MOUSE.PAN : MOUSE.ROTATE;
            _controls.touches.ONE       = mode === 'pan' ? TOUCH.PAN : TOUCH.ROTATE;
        }

        // ------------------------------------------------------------
        // Visites guidées par outil (Driver.js, MIT), lancées à la demande. Le voile bloque les clics sur la page pendant
        // la visite : l'état de l'outil (tracé en cours compris) ne peut pas changer, et sa fermeture rend la main.
        // Étapes : tours.js. Une étape dont l'élément est absent ou masqué, par exemple pendant un export, est ignorée.
        // ------------------------------------------------------------
        var _tour = null;

        function _stopTour() {
            if (_tour) { _tour.destroy(); }
        }

        // Démonstration de la visite des Filtres : chaque étape active ses réglages en repartant de l'état d'origine, ce qui
        // fonctionne aussi avec « Précédent ». L'état d'origine est rétabli à la fin de la visite, quelle qu'en soit la fin.
        function _filtersDemo(sc) {
            var st = sc.style, ui = sc.ui;
            var saved = { altOn: st.altOn, altMin: st.altMin, altMax: st.altMax, hagOn: st.hagOn, hagFrom: st.hagFrom, hagTo: st.hagTo,
                          mode: st.mode, prevMode: ui.prevMode, modeUserSet: ui.modeUserSet };
            var classes = sc.classes.map(function (c) { return c.visible; });
            var currentMode = st.mode;
            function reset() {
                st.altOn = saved.altOn; st.altMin = saved.altMin; st.altMax = saved.altMax;
                st.hagOn = saved.hagOn; st.hagFrom = saved.hagFrom; st.hagTo = saved.hagTo;
                st.mode = saved.mode; ui.prevMode = saved.prevMode; ui.modeUserSet = saved.modeUserSet;
                sc.classes.forEach(function (c, i) { c.visible = classes[i]; });
            }
            function refresh() {
                if (st.mode !== currentMode) { currentMode = st.mode; _syncModes(); }
                _applyClasses();
                _applyStyle();
                _renderProfile();
            }
            return {
                apply: function (d) {
                    reset();
                    if (d.alt && ui.altAvailable) { st.altOn = true; }
                    if (d.hagColor && ui.groundReady && st.mode !== 'HEIGHT') { ui.prevMode = st.mode; st.mode = 'HEIGHT'; ui.modeUserSet = true; }
                    if (d.hag && ui.groundReady) { st.hagOn = true; }
                    if (d.hagPreset === 'high' && ui.groundReady) { st.hagFrom = 2; st.hagTo = st.hagHi; }
                    if (d.classes === 'ground') { sc.classes.forEach(function (c) { c.visible = c.id === 2; }); }
                    refresh();
                },
                restore: function () { reset(); refresh(); }
            };
        }

        function _startTour(kind, $element) {
            var sc = _currentScope, root = $element[0], list = TOURS[kind];
            if (_tour || !sc || !list || !root) { return; }
            // Onglet du panneau visité : rétabli à la fin de la visite.
            var holder = kind === 'filters' ? sc.ui : sc.mnt, key = kind === 'filters' ? 'filterTab' : 'tab';
            var startTab = holder[key];
            function setTab(tab) {
                if (holder[key] !== tab) { sc.$apply(function () { holder[key] = tab; }); }
            }
            function target(st) {
                if (st.sel !== MAP_TARGET) { return root.querySelector(st.sel); }
                var map = _getOlMap();
                return map && map.getTargetElement ? map.getTargetElement() : null;
            }
            var demo = kind === 'filters' ? _filtersDemo(sc) : null;
            var steps = list.filter(function (st) {
                if (st.needs === 'alt' && !sc.ui.altAvailable) { return false; }
                if (st.needs === 'ground' && !sc.ui.groundReady) { return false; }
                if (st.lazy) { return true; }
                var el = target(st);
                return !!el && (!!st.tab || el.getClientRects().length > 0);   // st.tab : l'onglet peut être encore masqué
            }).map(function (st) {
                return {
                    element: function () {
                        if (st.tab) { setTab(st.tab); }
                        if (demo && st.demo) { sc.$apply(function () { demo.apply(st.demo); }); }
                        return target(st);
                    },
                    popover: { title: st.title, description: st.text, side: st.side }
                };
            });
            if (!steps.length) { return; }
            // Hors du digest du clic : une étape peut changer d'onglet.
            setTimeout(function () {
                if (_tour || _currentScope !== sc) { return; }
                _tour = driver({
                    steps: steps,
                    popoverClass: 'geo-lidar-tour',
                    showProgress: true,
                    progressText: '{{current}} / {{total}}',
                    nextBtnText: 'Suivant ›',
                    prevBtnText: '‹ Précédent',
                    doneBtnText: 'Terminer',
                    onDestroyed: function () {
                        _tour = null;
                        if (demo) { demo.restore(); }
                        if (_currentScope === sc) { sc.$evalAsync(function () { holder[key] = startTab; }); }
                    }
                });
                _tour.drive();
            }, 0);
        }

        // ------------------------------------------------------------
        // Module masqué : GEO détruit le panneau, mais pas la vue. Son élément (canvas WebGL compris) est rangé hors écran
        // et reprend sa place à la réouverture. iTowns ne dessine qu'à la demande : masquée, la vue ne consomme donc que sa
        // mémoire. Les chargements et un export en cours continuent, et l'ancien scope reste _currentScope pour les recevoir.
        // Le tracé de l'outil ouvert passe par la mémoire des outils et est recalculé au retour.
        // ------------------------------------------------------------
        var _parked = null;   // { el, scope, tool }
        var _parkHolder = null;

        function _viewAlive() {
            try { return !!_view && !_view.mainLoop.gfxEngine.renderer.getContext().isContextLost(); }
            catch (e) { return false; }
        }

        function _parkView($scope, $element) {
            _abortMntDraw();
            _abortProfileDraw();
            var tool = null;
            if (_prof) { _suspendProfile(); tool = 'profile'; }
            if ($scope.mnt.open && !_mntJob) { _suspendMnt(); tool = 'mnt'; }
            _unbindProfileCanvas();
            _maqStopAnim(); _vidAbort(); _orbitClear();
            _removeKind('probe');
            if (_olLayer) { _olLayer.setVisible(false); }
            if (_wheelEl && _wheelHandler) { _wheelEl.removeEventListener('wheel', _wheelHandler, { capture: true }); }
            var el = $element[0].querySelector('.geo-lidar-view'), r = el.getBoundingClientRect();
            if (!_parkHolder) {
                _parkHolder = document.createElement('div');
                _parkHolder.id = 'geo-lidar-parked';
                _parkHolder.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none';
                document.body.appendChild(_parkHolder);
            }
            // taille conservée : la vue ne doit pas se retrouver à 0 × 0 si la fenêtre change pendant le masquage
            _parkHolder.style.width = Math.max(1, r.width) + 'px';
            _parkHolder.style.height = Math.max(1, r.height) + 'px';
            _parkHolder.appendChild(el);
            _parked = { el: el, scope: $scope, tool: tool };
        }

        function _unparkView(parked, placeholder) {
            placeholder.parentNode.replaceChild(parked.el, placeholder);
            _wheelEl = parked.el.parentElement || parked.el;
            if (_wheelHandler) { _wheelEl.addEventListener('wheel', _wheelHandler, { capture: true, passive: false }); }
            if (_olLayer) { _olLayer.setVisible(true); }
            // le panneau s'élargit après coup (transition CSS, setPanelSize de GEO)
            [0, 100, 300, 800].forEach(function (d) {
                setTimeout(function () { if (_view && !_parked) { _view.resize(); _view.notifyChange(_view.camera.camera3D); } }, d);
            });
            if (parked.tool === 'profile') { _restoreProfile(); }
            if (parked.tool === 'mnt') { _restoreMnt(); }
        }

        function _disposeParked(parked) {
            _loadSeq++;
            _stopStreamWatch();
            _stopAroundWatch();
            _stopMnt(true);
            _profMemo = _mntMemo = _drawReturn = null;
            _disposeView();
            Object.keys(_maqGeo).forEach(function (k) { _maqGeo[k].dispose(); delete _maqGeo[k]; });
            if (parked.el.parentNode) { parked.el.parentNode.removeChild(parked.el); }
            _clearMapOverlay();
            _tileId = null;
        }

        function _disposeView() {
            try {
                if (_wheelEl && _wheelHandler) { _wheelEl.removeEventListener('wheel', _wheelHandler, { capture: true }); }
                if (_controls) { _controls.dispose(); }
                _unbindPick();
                _dispose3dProfile();
                _removeTiles();
                if (_view) { _view.dispose(); }
            } catch (e) { console.warn('[geo-lidar-hd] nettoyage de la vue :', e); }
            _wheelEl = null; _wheelHandler = null;
            _layer = null; _main = null; _tiles = []; _controls = null; _view = null;
        }

        // Caméra en surplomb oblique au sud de la dalle, regard vers le centre des points.
        // On cadre sur les bornes réelles du header LAS : root.bbox est le cube COPC (arête ~1 km),
        // bien plus haut que les données, et viserait un point en l'air.
        function _frameLayer() {
            if (!_layer || !_layer.source || !_layer.source.header || !_controls) { return; }
            var h      = _layer.source.header;
            var min    = new Vector3().fromArray(h.min);
            var max    = new Vector3().fromArray(h.max);
            var size   = max.clone().sub(min);
            var center = min.clone().add(max).multiplyScalar(0.5);
            var camera = _view.camera.camera3D;
            camera.far = 12 * size.length();
            camera.position.set(center.x, center.y - 0.9 * size.x, max.z + 0.35 * size.x);
            _controls.target.copy(center);
            _controls.minDistance = 0.01 * size.x;
            _controls.maxDistance = 6 * size.x;
            camera.updateProjectionMatrix();
            _controls.update();
            _view.notifyChange(camera);
        }

        // Navigation par boutons (indispensable au trackpad) : mêmes déplacements que la souris, par pas.
        function _orbit(dAz, dPolar) {
            if (!_controls || !_view) { return; }
            var cam = _view.camera.camera3D;
            var off = cam.position.clone().sub(_controls.target);
            if (dAz) { off.applyAxisAngle(_UP, dAz); }
            if (dPolar) {
                var r = off.length();
                var polar = Math.acos(Math.max(-1, Math.min(1, off.z / r)));
                var np = Math.max(0.02, Math.min(_controls.maxPolarAngle, polar + dPolar));
                var axis = new Vector3().crossVectors(_UP, off).normalize();   // +angle = caméra plus basse
                if (axis.lengthSq() > 0) { off.applyAxisAngle(axis, np - polar); }
            }
            cam.position.copy(_controls.target).add(off);
            _controls.update();
            _view.notifyChange(cam);
        }

        function _dolly(factor) {
            if (!_controls || !_view) { return; }
            var cam = _view.camera.camera3D;
            var off = cam.position.clone().sub(_controls.target);
            var d = Math.max(_controls.minDistance, Math.min(_controls.maxDistance, off.length() * factor));
            cam.position.copy(_controls.target).add(off.setLength(d));
            _controls.update();
            _view.notifyChange(cam);
        }

        function _topView() {
            if (!_controls || !_view) { return; }
            var cam = _view.camera.camera3D;
            var r = cam.position.distanceTo(_controls.target);
            cam.position.set(_controls.target.x, _controls.target.y - r * Math.sin(0.02), _controls.target.z + r * Math.cos(0.02));
            _controls.update();
            _view.notifyChange(cam);
        }

        // ============================================================
        // Style du nuage (équivalent du panneau « Layer Controls » de l'exemple iTowns)
        // ============================================================
        var _BG = { light: 0xdfe3e8, dark: 0x1b1f24 };

        var _CLASS_NAMES = {
            0: 'Jamais classé', 1: 'Non classé', 2: 'Sol', 3: 'Végétation basse', 4: 'Végétation moyenne',
            5: 'Végétation haute', 6: 'Bâtiment', 7: 'Bruit bas', 9: 'Eau', 10: 'Voie ferrée', 11: 'Chaussée',
            13: 'Fil de garde', 14: 'Conducteur', 15: 'Pylône', 16: 'Connecteur', 17: 'Tablier de pont',
            18: 'Bruit haut', 64: 'Sursol pérenne', 65: 'Artefact', 66: 'Points virtuels', 67: 'Divers'
        };

        function _modeList(ui) {
            var list = [];
            if (ui.orthoReady) { list.push({ id: 'ORTHO', label: 'Orthophoto IGN' }); }
            if (ui.hasColor)   { list.push({ id: 'COLOR', label: 'RVB (données)' }); }
            return list.concat([
                { id: 'CLASSIFICATION', label: 'Classification' },
                { id: 'ELEVATION',      label: 'Altitude' }
            ].concat(ui.heightOn ? [{ id: 'HEIGHT', label: 'Hauteur au sol' }] : [], [
                { id: 'INTENSITY',      label: 'Intensité' },
                { id: 'RETURN_NUMBER',  label: 'N° de retour' },
                { id: 'SCAN_ANGLE',     label: 'Angle de scan' }
            ]));
        }

        function _profileModeList(ui) {
            var list = [{ id: 'CLASSIFICATION', label: 'Classification' }, { id: 'ELEVATION', label: 'Altitude' }];
            if (ui.orthoReady) { list.unshift({ id: 'ORTHO', label: 'Orthophoto IGN' }); }
            return list;
        }

        function _modeAvailable(mode, ui) {
            if (mode === 'HEIGHT') { return !!ui.groundReady; }   // se choisit dans Filtres, absent de la liste tant qu'inactif
            return _modeList(ui).some(function (m) { return m.id === mode; });
        }

        // La liste « Couleurs » montre « Hauteur au sol » seulement quand ce mode est actif (case du panneau Filtres).
        function _syncModes() {
            var sc = _currentScope;
            if (!sc) { return; }
            sc.ui.heightOn = sc.style.mode === 'HEIGHT';
            sc.modes = _modeList(sc.ui);
        }

        function _buildClasses(scheme) {
            return Object.keys(scheme).filter(function (k) { return /^\d+$/.test(k); })
                .map(Number).sort(function (a, b) { return a - b; })
                .map(function (id) {
                    var e = scheme[id];
                    return { id: id, name: _CLASS_NAMES[id] || e.name, visible: e.visible !== false,
                             color: '#' + e.color.getHexString() };
                });
        }

        function _applyClasses() {
            if (!_layer || !_currentScope) { return; }
            _tiles.forEach(function (t) {
                var scheme = t.layer.material.classificationScheme;
                _currentScope.classes.forEach(function (c) { if (scheme[c.id]) { scheme[c.id].visible = c.visible; } });
                t.layer.material.recomputeVisibilityTexture();
            });
            _view.notifyChange(_layer);
        }

        function _applyStyle() {
            if (!_layer || !_view || !_currentScope) { return; }
            var st = _currentScope.style;
            _budgetTotal = Math.round(Number(st.budget) * 1e6);   // commun à toutes les dalles (voir _applyBudget)
            _tiles.forEach(function (t) {
                var layer = t.layer, m = layer.material;
                // Une dalle voisine dont l'orthophoto n'est pas encore arrivée reste en classification.
                var ortho = st.mode === 'ORTHO' && !!layer.orthoSize;
                var hagColor = st.mode === 'HEIGHT' && !!layer.groundSize;   // idem : sans MNT lu, retour à la classification
                m.mode = ortho ? PNTS_MODE.COLOR : PNTS_MODE[(st.mode === 'ORTHO' || st.mode === 'HEIGHT') ? 'CLASSIFICATION' : st.mode];
                if (m.uniforms.useOrtho) { m.uniforms.useOrtho.value = ortho; }
                if (m.uniforms.useHagColor) {
                    m.uniforms.useHagColor.value = hagColor;
                    m.uniforms.hagColorMax.value = Number(st.hagColorMax);
                    m.uniforms.hagOn.value = !!st.hagOn && !!layer.groundSize;
                    m.uniforms.hagRange.value.set(Number(st.hagFrom), Number(st.hagTo));
                }
                m.shape            = Number(st.shape);
                m.sizeAttenuation  = !!st.attenuated;
                m.minAttenuatedSize = Number(st.minSize);
                m.maxAttenuatedSize = Number(st.maxSize);
                m.gamma            = Number(st.gamma);
                m.ambientBoost     = Number(st.ambient);
                layer.pointSize     = Number(st.size);       // recopiés dans le matériau à chaque frame par iTowns
                layer.opacity       = Number(st.opacity);
                layer.sseThreshold  = Number(st.sse);
                if (m.uniforms.altOn) {
                    m.uniforms.altOn.value = !!st.altOn;
                    m.uniforms.altRange.value.set(Number(st.altMin), Number(st.altMax));
                }
            });
            _view.mainLoop.gfxEngine.renderer.setClearColor(_BG[st.bg] !== undefined ? _BG[st.bg] : _BG.light);
            _applyClasses();
            _applyMaquette();
            _view.notifyChange(_layer);
        }

        // Coloration par l'orthophoto IGN : le LiDAR HD classifié n'a pas de RVB. On ajoute au vertex shader
        // d'iTowns une texture plaquée sur l'emprise de la dalle (échantillonnée à la position XY de chaque point).
        // Retourne false si le shader d'iTowns n'a pas la forme attendue (le mode Orthophoto est alors absent).
        function _patchOrthoShader(material) {
            var vs = material.vertexShader;
            var marker = '    if (texture2D(visibilityTexture, uv).r == 0.) {';
            if (!_orthoWmsUrl || vs.indexOf(marker) === -1 || vs.indexOf('uniform float size;') === -1) { return false; }
            material.vertexShader = vs
                .replace('uniform float size;', 'uniform float size;\nuniform sampler2D orthoTex;\nuniform vec4 orthoBox;\nuniform bool useOrtho;')
                .replace(marker, '    if (useOrtho && !picking) {\n' +
                    '        vec4 ow = modelMatrix * vec4(position, 1.0);\n' +
                    '        vec2 ouv = clamp((ow.xy - orthoBox.xy) / orthoBox.zw, 0.0, 1.0);\n' +
                    '        vColor = vec4(texture2D(orthoTex, ouv).rgb, 1.0);\n' +
                    '    }\n' + marker);
            material.uniforms.orthoTex  = { value: new Texture() };
            material.uniforms.orthoBox  = { value: new Vector4(0, 0, 1, 1) };
            material.uniforms.useOrtho  = { value: false };
            return true;
        }

        // Filtre d'altitude : tranche [altRange.x, altRange.y] (Lambert-93 / NGF) ; les points hors tranche sont rendus
        // transparents, comme les classes décochées. Retourne false si le shader d'iTowns a changé de forme.
        function _patchAltitudeShader(material) {
            var vs = material.vertexShader;
            var marker = '#define USE_COLOR_ALPHA\n#include <morphcolor_vertex>';
            if (vs.indexOf(marker) === -1 || vs.indexOf('uniform float size;') === -1) { return false; }
            material.vertexShader = vs
                .replace('uniform float size;', 'uniform float size;\nuniform bool altOn;\nuniform vec2 altRange;')
                .replace(marker, '    if (altOn && !picking) {\n' +
                    '        float zw = (modelMatrix * vec4(position, 1.0)).z;\n' +
                    '        if (zw < altRange.x || zw > altRange.y) { vColor.a = 0.; }\n' +
                    '    }\n' + marker);
            material.uniforms.altOn    = { value: false };
            material.uniforms.altRange = { value: new Vector2(-1e6, 1e6) };
            return true;
        }

        // Hauteur au-dessus du sol : le MNT de la dalle devient une texture flottante (1 canal) échantillonnée dans le
        // vertex shader, à la position XY de chaque point (texelFetch, plus proche maille). Elle sert à colorer par
        // hauteur (rampe bleu → vert → jaune → rouge) et à masquer les points hors d'une tranche de hauteur, comme le
        // filtre d'altitude. Pixels sans donnée : -99999 (le point garde sa couleur et reste affiché).
        // Précision : les coordonnées monde passent en float32 dans le shader (~0,25 m à 6,5e6 en Y) : la maille du MNT
        // choisie peut être voisine de la bonne, sans effet visible sauf sur des pentes très raides.
        // Retourne false si le shader d'iTowns n'a pas la forme attendue.
        function _patchGroundShader(material) {
            var vs = material.vertexShader;
            var colorMarker = '    if (texture2D(visibilityTexture, uv).r == 0.) {';
            var alphaMarker = '#define USE_COLOR_ALPHA\n#include <morphcolor_vertex>';
            if (vs.indexOf(colorMarker) === -1 || vs.indexOf(alphaMarker) === -1 || vs.indexOf('uniform float size;') === -1) { return false; }
            var decl = 'uniform float size;\n' +
                'uniform highp sampler2D groundTex;\n' +
                'uniform vec4 groundInfo;\n' +          // centre du pixel (0,0) : x, y ; pas ; taille en pixels
                'uniform bool useHagColor;\nuniform float hagColorMax;\nuniform bool hagOn;\nuniform vec2 hagRange;\n' +
                'float groundZ(vec2 xy) {\n' +
                '    vec2 c = vec2((xy.x - groundInfo.x) / groundInfo.z, (groundInfo.y - xy.y) / groundInfo.z);\n' +
                '    ivec2 ic = ivec2(floor(c + 0.5));\n' +
                '    int n = int(groundInfo.w);\n' +
                '    if (ic.x < 0 || ic.y < 0 || ic.x >= n || ic.y >= n) { return -99999.0; }\n' +
                '    return texelFetch(groundTex, ic, 0).r;\n' +
                '}\n' +
                'vec3 hagRamp(float t) {\n' +
                '    vec3 c0 = vec3(0.13, 0.20, 0.55); vec3 c1 = vec3(0.10, 0.65, 0.80); vec3 c2 = vec3(0.30, 0.78, 0.30);\n' +
                '    vec3 c3 = vec3(0.96, 0.85, 0.20); vec3 c4 = vec3(0.85, 0.15, 0.15);\n' +
                '    float s = t * 4.0;\n' +
                '    if (s < 1.0) { return mix(c0, c1, s); }\n' +
                '    if (s < 2.0) { return mix(c1, c2, s - 1.0); }\n' +
                '    if (s < 3.0) { return mix(c2, c3, s - 2.0); }\n' +
                '    return mix(c3, c4, min(s - 3.0, 1.0));\n' +
                '}';
            material.vertexShader = vs
                .replace('uniform float size;', decl)
                .replace(colorMarker, '    if (useHagColor && !picking) {\n' +
                    '        vec4 hw = modelMatrix * vec4(position, 1.0);\n' +
                    '        float gz = groundZ(hw.xy);\n' +
                    '        if (gz > -9000.0) { vColor = vec4(hagRamp(clamp((hw.z - gz) / hagColorMax, 0.0, 1.0)), 1.0); }\n' +
                    '    }\n' + colorMarker)
                .replace(alphaMarker, '    if (hagOn && !picking) {\n' +
                    '        vec4 hf = modelMatrix * vec4(position, 1.0);\n' +
                    '        float gf = groundZ(hf.xy);\n' +
                    '        if (gf > -9000.0 && (hf.z - gf < hagRange.x || hf.z - gf > hagRange.y)) { vColor.a = 0.; }\n' +
                    '    }\n' + alphaMarker);
            var blank = new DataTexture(new Float32Array([-99999]), 1, 1, RedFormat, FloatType);
            blank.minFilter = blank.magFilter = NearestFilter; blank.generateMipmaps = false; blank.needsUpdate = true;
            material.uniforms.groundTex    = { value: blank };
            material.uniforms.groundInfo   = { value: new Vector4(0, 0, 1, 0) };
            material.uniforms.useHagColor  = { value: false };
            material.uniforms.hagColorMax  = { value: 30 };
            material.uniforms.hagOn        = { value: false };
            material.uniforms.hagRange     = { value: new Vector2(-1e6, 1e6) };
            return true;
        }

        // Lit le MNT de la dalle (1 m puis 0,5 m ; `sizes` limite les passes, ex. [1000] pour une dalle voisine) et le
        // branche sur la couche quand les deux sont prêts (dans l'ordre d'arrivée qu'on veut, comme l'orthophoto).
        function _startGround(tile, seq, sizes) {
            if (!tile.rasters || !tile.rasters.mnt) { return; }
            _rasters.loadProgressive(tile, 'mnt', function (grid) {
                tile.groundGrid = grid;
                _attachGround(tile, seq);
            }, function () { return seq !== _loadSeq; }, sizes).catch(function (err) {
                console.warn('[geo-lidar-hd] MNT de la dalle ' + tile.name + ' indisponible (hauteur au sol) :', err);
            });
        }

        function _attachGround(tile, seq) {
            var layer = tile.layer, g = tile.groundGrid;
            if (!g || !layer || seq !== _loadSeq || !_view || !layer.material.uniforms.groundTex ||
                (layer.groundSize || 0) >= g.size) { return; }
            var first = !layer.groundSize;
            layer.groundSize = g.size;
            // Copie pour la carte graphique : les trous (NaN) deviennent -99999, sans toucher aux grilles du lecteur.
            var d = new Float32Array(g.data.length), mn = Infinity, k, v;
            for (k = 0; k < d.length; k++) {
                v = g.data[k];
                if (v === v) { d[k] = v; if (v < mn) { mn = v; } } else { d[k] = -99999; }
            }
            tile.groundMin = mn;
            if (tile.groundTex) { tile.groundTex.dispose(); }
            var tex = tile.groundTex = new DataTexture(d, g.size, g.size, RedFormat, FloatType);
            tex.minFilter = tex.magFilter = NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            layer.material.uniforms.groundTex.value = tex;
            layer.material.uniforms.groundInfo.value.set(g.x0, g.y0, g.step, g.size);
            _maquetteUpdate();
            if (_prof) {
                _prof.hag = null; _prof.curves = null; _drawProfileSoon();
                _ensureProfileRasters();
                if (_currentScope && _currentScope.style.hagOn) { _refreshProfileSoon(); }
            }
            if (!first) { _view.notifyChange(layer); return; }
            var sc = _currentScope;
            if (!sc) { return; }
            $timeout(function () {
                if (!_currentScope) { return; }
                _groundBounds(sc.style, false);
                if (tile === _main) {
                    sc.ui.groundReady = true;
                    sc.modes = _modeList(sc.ui);
                }
                _applyStyle();
            });
        }

        // MNS (surface : sol + bâti + végétation) d'une dalle, lu à la demande pour le profil : il ne sert qu'aux courbes
        // et au survol, sans texture (contrairement au MNT de la hauteur au sol).
        function _startSurface(tile, seq, sizes) {
            if (!tile.rasters || !tile.rasters.mns) { return; }
            _rasters.loadProgressive(tile, 'mns', function (grid) {
                tile.surfGrid = grid;
                if (_prof) { _prof.curves = null; _drawProfileSoon(); }
                _maquetteUpdate();
            }, function () { return seq !== _loadSeq; }, sizes).catch(function (err) {
                console.warn('[geo-lidar-hd] MNS de la dalle ' + tile.name + ' indisponible (courbes du profil) :', err);
            });
        }

        // Bâtiments LoD2 de la dalle (<city3dUrl>/buildings/<dalle>.bld), lus une fois quand la maquette les demande. Fichier absent
        // (404) : silence, la dalle reste comme sans le réglage. Les autres échecs sont signalés une fois dans la console.
        function _startBuildings(tile, seq) {
            tile.bldLoading = true;
            var url = _buildingsUrl + '/' + encodeURIComponent(tile.name) + '.bld';
            fetch(url).then(function (r) {
                if (r.status === 404) { return null; }
                if (!r.ok) { throw new Error('HTTP ' + r.status); }
                return r.arrayBuffer();
            }).then(function (buf) {
                tile.bldLoading = false;
                if (seq !== _loadSeq || !_view || _tiles.indexOf(tile) === -1) { return; }
                if (!buf) { tile.bldMissing = true; return; }
                var bld = parseBld(buf);
                if (Math.abs(bld.origin[0] - tile.bbox[0]) > 0.01 || Math.abs(bld.origin[1] - tile.bbox[1]) > 0.01) {
                    throw new Error('origine ' + bld.origin.join(', ') + ' au lieu de ' + tile.bbox[0] + ', ' + tile.bbox[1]);
                }
                tile.bld = bld;
                _maquetteUpdate();
            }).catch(function (err) {
                tile.bldLoading = false; tile.bldMissing = true;
                console.warn('[geo-lidar-hd] bâtiments LoD2 de la dalle ' + tile.name + ' ignorés (' + url + ') :', err);
            });
        }

        // Canopée de la dalle (<city3dUrl>/vegetation/<dalle>.veg), lue une fois quand la maquette la demande. Même règle que pour les
        // bâtiments : fichier absent (404) = silence, autre échec = une ligne dans la console, la dalle reste comme avant.
        function _startVegetation(tile, seq) {
            tile.vegLoading = true;
            var url = _vegetationUrl + '/' + encodeURIComponent(tile.name) + '.veg';
            fetch(url).then(function (r) {
                if (r.status === 404) { return null; }
                if (!r.ok) { throw new Error('HTTP ' + r.status); }
                return r.arrayBuffer();
            }).then(function (buf) {
                return buf ? parseVeg(buf) : null;
            }).then(function (veg) {
                tile.vegLoading = false;
                if (seq !== _loadSeq || !_view || _tiles.indexOf(tile) === -1) { return; }
                if (!veg) { tile.vegMissing = true; return; }
                if (Math.abs(veg.x0 - tile.bbox[0]) > 0.01 || Math.abs(veg.y0 - tile.bbox[3]) > 0.01 || Math.abs(veg.size * veg.step - 1000) > 0.01) {
                    throw new Error('grille ' + veg.x0 + ', ' + veg.y0 + ' (' + (veg.size * veg.step) + ' m) au lieu de la dalle ' + tile.bbox.join(', '));
                }
                tile.veg = veg;
                _maquetteUpdate();
            }).catch(function (err) {
                tile.vegLoading = false; tile.vegMissing = true;
                console.warn('[geo-lidar-hd] arbres de la dalle ' + tile.name + ' ignorés (' + url + ') :', err);
            });
        }

        // Pour les dalles que touche le tracé : MNS à lire, MNT des dalles voisines (1 m) à affiner en 0,5 m.
        function _ensureProfileRasters() {
            if (!_prof) { return; }
            _tiles.forEach(function (t) {
                if (!_tileHitsProfile(t)) { return; }
                if (!t.surfGrid && !t.surfLoading) { t.surfLoading = true; _startSurface(t, _loadSeq); }
                if (t.groundGrid && t.groundGrid.size < 2000 && !t.groundUpgrading) { t.groundUpgrading = true; _startGround(t, _loadSeq); }
                if (t.surfGrid && t.surfGrid.size < 2000 && !t.surfUpgrading) { t.surfUpgrading = true; _startSurface(t, _loadSeq); }
            });
        }

        // Valeur d'un raster (kind : 'mnt' ou 'mns') au point (x, y) en Lambert-93, toutes dalles confondues :
        // interpolation bilinéaire, plus proche maille en bord de dalle ; NaN si la dalle ou le raster manque.
        function _rasterAt(kind, x, y) {
            for (var i = 0; i < _tiles.length; i++) {
                var t = _tiles[i], b = t.bbox, g = kind === 'mns' ? t.surfGrid : t.groundGrid;
                if (g && b && x >= b[0] && x < b[2] && y > b[1] && y <= b[3]) {
                    var v = g.sample(x, y);
                    return v === v ? v : g.nearest(x, y);
                }
            }
            return NaN;
        }

        // Altitude du sol (MNT) au point (x, y) en Lambert-93, toutes dalles confondues ; NaN si inconnue.
        function _groundAt(x, y) {
            for (var i = 0; i < _tiles.length; i++) {
                var t = _tiles[i], b = t.bbox;
                // les nœuds d'une dalle : x de X0 inclus à X0 + 1000 exclu, y de Y0 - 1000 exclu à Y0 inclus
                if (t.groundGrid && b && x >= b[0] && x < b[2] && y > b[1] && y <= b[3]) { return t.groundGrid.nearest(x, y); }
            }
            return NaN;
        }

        // Bornes du filtre de hauteur : du sol (-2 m, bruit sous le MNT) au plus haut point au-dessus du plus bas
        // sol connu, entre 10 et 150 m. Un curseur resté en butée suit la nouvelle borne.
        function _groundBounds(st, reset) {
            var hi = -Infinity;
            _tiles.forEach(function (t) {
                if (t.groundMin === undefined || !isFinite(t.groundMin)) { return; }
                hi = Math.max(hi, Math.ceil(t.layer.source.header.max[2] - t.groundMin));
            });
            if (hi === -Infinity) { return; }
            hi = Math.min(150, Math.max(10, hi));
            if (reset || Number(st.hagTo) >= st.hagHi) { st.hagTo = hi; }
            st.hagLo = -2; st.hagHi = hi;
            if (reset || Number(st.hagFrom) <= st.hagLo) { st.hagFrom = st.hagLo; }
        }

        // ============================================================
        // Maquette 3D (« déshabiller la ville ») : le MNS et le MNT de chaque dalle en maillage régulier, habillé de
        // l'orthophoto. Les altitudes viennent des deux textures flottantes, lues dans le vertex shader : un uniforme
        // fait glisser chaque sommet du terrain nu (0) à la surface (1), donc sans recalcul côté processeur. Maille de
        // 1 m pour la dalle cliquée, de 2 m pour les voisines ; coordonnées locales à la dalle (float32 sans tremblement).
        // ============================================================
        var _maqGeo = {};
        var _maqZRef = 0;   // référence commune de l'exagération du relief (voir _maquetteUpdate)
        var _MAQ_VS = [
            'uniform sampler2D tTex; uniform vec4 tInfo;',
            'uniform sampler2D sTex; uniform vec4 sInfo;',
            'uniform float mixT; uniform float exag; uniform float zRef;',
            'varying vec3 vLocal; varying float vOk; varying float vH;',
            'float texN(sampler2D tex, int n, ivec2 ic) { return texelFetch(tex, clamp(ic, ivec2(0), ivec2(n - 1)), 0).r; }',
            // altitude au point p (local, en m) : bilinéaire ; un pixel sans donnée voisin ramène au plus proche pixel
            'float sampleZ(sampler2D tex, vec4 info, vec2 p) {',
            '    int n = int(info.w);',
            '    if (n < 2) { return -99999.0; }',
            '    vec2 c = vec2((p.x - info.x) / info.z, (info.y - p.y) / info.z);',
            '    vec2 f = floor(c); vec2 w = c - f; ivec2 i0 = ivec2(f);',
            '    float a = texN(tex, n, i0); float b = texN(tex, n, i0 + ivec2(1, 0));',
            '    float cc = texN(tex, n, i0 + ivec2(0, 1)); float d = texN(tex, n, i0 + ivec2(1, 1));',
            '    if (a < -9000.0 || b < -9000.0 || cc < -9000.0 || d < -9000.0) { return texN(tex, n, ivec2(floor(c + 0.5))); }',
            '    return mix(mix(a, b, w.x), mix(cc, d, w.x), w.y);',
            '}',
            'void main() {',
            '    float zt = sampleZ(tTex, tInfo, position.xy);',
            '    float zs = sampleZ(sTex, sInfo, position.xy);',
            '    float z = 0.0; vH = 0.0; vOk = 1.0;',
            '    if (zt > -9000.0 && zs > -9000.0) { z = mix(zt, max(zs, zt), mixT); vH = z - zt; }',
            '    else if (zt > -9000.0) { z = zt; }',
            '    else if (zs > -9000.0) { z = zs; }',
            '    else { vOk = 0.0; }',
            '    z = zRef + (z - zRef) * exag;',
            '    vLocal = vec3(position.xy, z);',
            '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, z, 1.0);',
            '}'
        ].join('\n');
        var _MAQ_FS = [
            'uniform sampler2D oTex; uniform float useOrtho; uniform int colorMode; uniform float hagMax;',
            'varying vec3 vLocal; varying float vOk; varying float vH;',
            'vec3 ramp(float t) {',
            '    vec3 c0 = vec3(0.13, 0.20, 0.55); vec3 c1 = vec3(0.10, 0.65, 0.80); vec3 c2 = vec3(0.30, 0.78, 0.30);',
            '    vec3 c3 = vec3(0.96, 0.85, 0.20); vec3 c4 = vec3(0.85, 0.15, 0.15);',
            '    float s = t * 4.0;',
            '    if (s < 1.0) { return mix(c0, c1, s); }',
            '    if (s < 2.0) { return mix(c1, c2, s - 1.0); }',
            '    if (s < 3.0) { return mix(c2, c3, s - 2.0); }',
            '    return mix(c3, c4, min(s - 3.0, 1.0));',
            '}',
            'void main() {',
            '    if (vOk < 0.5) { discard; }',
            '    vec3 base = vec3(0.66, 0.68, 0.64);',
            '    if (colorMode == 1) { base = ramp(clamp(vH / hagMax, 0.0, 1.0)); }',
            '    else if (useOrtho > 0.5) { base = texture2D(oTex, clamp(vLocal.xy / 1000.0, 0.0, 1.0)).rgb; }',
            // relief : ombrage par les dérivées de la position (normale de la facette), soleil au nord-ouest
            '    vec3 n = normalize(cross(dFdx(vLocal), dFdy(vLocal)));',
            '    if (n.z < 0.0) { n = -n; }',
            '    float l = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.70))), 0.0, 1.0);',
            '    gl_FragColor = vec4(base * (0.42 + 0.78 * l), 1.0);',
            '}'
        ].join('\n');

        // Bâtiments LoD2 (fichiers .bld) : maillage par dalle superposé à la maquette. Le vertex shader est celui de la
        // maquette (mêmes fonctions d'échantillonnage du MNT, mêmes uniformes) avec une autre fonction main : un pied de mur
        // (aFoot = 1) prend l'altitude du MNT comme le terrain ; les autres sommets vont de l'altitude du MNT à l'altitude du
        // toit (position.z, NGF) selon mixT, comme le MNS dans la maquette. Les murs sont grisés (normale presque horizontale)
        // au lieu d'y étirer l'orthophoto ; le reste du fragment shader est celui de la maquette.
        var _BLD_VS = _MAQ_VS.slice(0, _MAQ_VS.indexOf('void main() {'))
            .replace('varying vec3 vLocal;', 'attribute float aFoot;\nvarying vec3 vLocal;') + [
            'void main() {',
            '    float zt = sampleZ(tTex, tInfo, position.xy);',
            '    float z = 0.0; vH = 0.0; vOk = 1.0;',
            '    if (zt > -9000.0) { z = aFoot > 0.5 ? zt : mix(zt, max(position.z, zt), mixT); vH = z - zt; }',
            '    else { vOk = 0.0; }',
            '    z = zRef + (z - zRef) * exag;',
            '    vLocal = vec3(position.xy, z);',
            '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, z, 1.0);',
            '}'
        ].join('\n');
        // Sur un mur, n.z vaut 0 au bruit numérique près : le retournement « n.z < 0 » de la maquette changerait au hasard
        // le sens de la normale d'un pixel à l'autre (éclairage moucheté). On ne le garde que pour les faces non verticales ;
        // pour un mur, la normale issue des dérivées regarde déjà vers la caméra.
        var _BLD_FS = _MAQ_FS
            .replace('    if (n.z < 0.0) { n = -n; }', '    if (n.z < 0.0 && abs(n.z) >= 0.3) { n = -n; }')
            .replace('    float l = clamp(', '    if (abs(n.z) < 0.3) { base = vec3(0.74, 0.73, 0.70); }\n    float l = clamp(');
        if (_BLD_FS.split('abs(n.z)').length !== 3) { console.warn('[geo-lidar-hd] shader de la maquette modifié : murs des bâtiments non adaptés'); }

        // Arbres 3D (fichiers .veg) : un houppier (icosphère aplatie) et un tronc (cylindre) par arbre, en instances, par dalle. Le
        // vertex shader reprend les fonctions d'échantillonnage du MNT de la maquette et ses uniformes : l'arbre part du sol à
        // l'altitude du MNT et monte selon le curseur (comme les bâtiments), suit le relief exagéré, et prend la couleur de
        // l'orthophoto à son pied (éclaircie, avec une variation d'un arbre à l'autre). Éclairage par les dérivées de la position,
        // comme la maquette ; la normale n'est pas retournée pour les faces presque verticales (voir _BLD_FS).
        var _TREE_VS = _MAQ_VS.slice(0, _MAQ_VS.indexOf('void main() {'))
            .replace('varying vec3 vLocal;', 'uniform sampler2D oTex; varying vec3 vCol; varying vec3 vLocal;') + [
            'void main() {',
            '    vec4 wp = instanceMatrix * vec4(position, 1.0);',
            '    vec2 c = instanceMatrix[3].xy;',
            '    vec2 xy = c + (wp.xy - c) * mixT;',   // le houppier rétrécit aussi avec le curseur : à 0 (terrain nu) l'arbre a disparu
            '    float zt = sampleZ(tTex, tInfo, c);',
            '    float z = wp.z; vH = 0.0; vOk = 1.0;',
            '    if (zt > -9000.0) { z = zt + (wp.z - zt) * mixT; vH = max(z - zt, 0.0); }',
            '    z = zRef + (z - zRef) * exag;',
            '    vLocal = vec3(xy, z);',
            '    vec2 uv = clamp(c / 1000.0, 0.0, 1.0);',
            '    vec3 o = (texture2D(oTex, uv + vec2(0.0015, 0.0)).rgb + texture2D(oTex, uv - vec2(0.0015, 0.0)).rgb +',
            '              texture2D(oTex, uv + vec2(0.0, 0.0015)).rgb + texture2D(oTex, uv - vec2(0.0, 0.0015)).rgb) * 0.25;',
            '    float rnd = fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);',
            '    vCol = mix(o * 1.45, vec3(0.20, 0.38, 0.18), 0.35) * (0.85 + 0.30 * rnd);',
            '    gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, z, 1.0);',
            '}'
        ].join('\n');
        var _TREE_FS = [
            'uniform float uTrunk; uniform float useOrtho; uniform int colorMode; uniform float hagMax;',
            'varying vec3 vLocal; varying float vOk; varying float vH; varying vec3 vCol;',
            'vec3 ramp(float t) {',
            '    vec3 c0 = vec3(0.13, 0.20, 0.55); vec3 c1 = vec3(0.10, 0.65, 0.80); vec3 c2 = vec3(0.30, 0.78, 0.30);',
            '    vec3 c3 = vec3(0.96, 0.85, 0.20); vec3 c4 = vec3(0.85, 0.15, 0.15);',
            '    float s = t * 4.0;',
            '    if (s < 1.0) { return mix(c0, c1, s); }',
            '    if (s < 2.0) { return mix(c1, c2, s - 1.0); }',
            '    if (s < 3.0) { return mix(c2, c3, s - 2.0); }',
            '    return mix(c3, c4, min(s - 3.0, 1.0));',
            '}',
            'void main() {',
            '    vec3 base = uTrunk > 0.5 ? vec3(0.36, 0.28, 0.22) : vCol;',
            '    if (colorMode == 1) { base = ramp(clamp(vH / hagMax, 0.0, 1.0)); }',
            '    else if (useOrtho < 0.5 && uTrunk < 0.5) { base = vec3(0.50, 0.62, 0.46); }',
            '    vec3 n = normalize(cross(dFdx(vLocal), dFdy(vLocal)));',
            '    if (n.z < 0.0 && abs(n.z) >= 0.3) { n = -n; }',
            '    float l = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.70))), 0.0, 1.0);',
            '    gl_FragColor = vec4(base * (0.42 + 0.78 * l), 1.0);',
            '}'
        ].join('\n');

        // Grille de n × n mailles sur 1000 m : x, y locaux (0 à 1000), z = 0 (donné par le vertex shader).
        function _maqGeometry(n) {
            if (_maqGeo[n]) { return _maqGeo[n]; }
            var step = 1000 / n, v = n + 1, pos = new Float32Array(3 * v * v), idx = new Uint32Array(6 * n * n), i, j, k = 0, q = 0;
            for (j = 0; j < v; j++) { for (i = 0; i < v; i++) { pos[k++] = i * step; pos[k++] = j * step; pos[k++] = 0; } }
            for (j = 0; j < n; j++) {
                for (i = 0; i < n; i++) {
                    var a = j * v + i, b = a + 1, c = a + v, d = c + 1;
                    idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
                }
            }
            var g = new BufferGeometry();
            g.setAttribute('position', new BufferAttribute(pos, 3));
            g.setIndex(new BufferAttribute(idx, 1));
            return (_maqGeo[n] = g);
        }

        // Texture flottante (1 canal) d'un raster : les trous (NaN) deviennent -99999. Renvoie aussi le minimum.
        function _floatTexture(g) {
            var d = new Float32Array(g.data.length), mn = Infinity, k, v;
            for (k = 0; k < d.length; k++) {
                v = g.data[k];
                if (v === v) { d[k] = v; if (v < mn) { mn = v; } } else { d[k] = -99999; }
            }
            var tex = new DataTexture(d, g.size, g.size, RedFormat, FloatType);
            tex.minFilter = tex.magFilter = NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            return { tex: tex, min: mn };
        }

        function _maqHidesPoints() {
            var m = _currentScope && _currentScope.maq;
            return !!(m && m.on && !m.points);
        }

        // Crée ou met à jour le maillage de chaque dalle dont le MNT, le MNS (et l'orthophoto) sont prêts ; lance la lecture
        // du MNS des dalles qui ne l'ont pas. Appelé à chaque arrivée d'un raster, d'une dalle ou d'un réglage de la maquette.
        function _maquetteUpdate() {
            var sc = _currentScope, m = sc && sc.maq;
            if (!_view || !m) { return; }
            var ready = 0, total = 0;
            // Référence de l'exagération du relief : UNE seule pour toutes les dalles (la plus basse). Avec le minimum de chaque dalle,
            // deux dalles voisines s'écartaient verticalement à leur jonction dès que le relief dépassait ×1 (fentes blanches).
            var zRef = Infinity;
            _tiles.forEach(function (t) { if (t.bbox && isFinite(t.groundMin) && t.groundMin < zRef) { zRef = t.groundMin; } });
            if (!isFinite(zRef)) { zRef = 0; }
            _maqZRef = zRef;
            _tiles.forEach(function (t) {
                if (!t.bbox) { return; }
                total++;
                if (!m.on) {
                    if (t.maqMesh) { t.maqMesh.visible = false; }
                    if (t.bldMesh) { t.bldMesh.visible = false; }
                    if (t.treeMesh) { t.treeMesh.visible = false; t.trunkMesh.visible = false; }
                    return;
                }
                if (!t.surfGrid && !t.surfLoading) { t.surfLoading = true; _startSurface(t, _loadSeq, [1000]); }
                var wantBld = !!(_buildingsUrl && m.buildings);
                if (wantBld && !t.bld && !t.bldLoading && !t.bldMissing) { _startBuildings(t, _loadSeq); }
                var wantVeg = !!(_vegetationUrl && m.trees);
                if (wantVeg && !t.veg && !t.vegLoading && !t.vegMissing) { _startVegetation(t, _loadSeq); }
                if (!t.groundGrid || !t.groundTex || !t.surfGrid) { return; }
                // Texture du MNS : si les bâtiments LoD2 sont là, une COPIE du MNS dont les emprises (élargies) prennent
                // l'altitude du MNT ; surfGrid reste intact (le profil l'utilise). Refaite à chaque passe de résolution
                // du MNS ou du MNT, à l'arrivée des bâtiments et quand la case est cochée ou décochée.
                var masked = wantBld && !!t.bld, trees = wantVeg && !!t.veg;
                // Les arbres s'ajoutent après les bâtiments : on retire aussi la canopée de la copie du MNS (cellules de végétation
                // à plus de 2 m du sol, d'après les points classés végétation), et on détecte les arbres avec le MNT courant.
                var surfKey = t.surfGrid.size + (masked ? 'b' + t.groundGrid.size : '') + (trees ? 'v' + t.groundGrid.size : '');
                if (!t.surfTex || t.surfTexKey !== surfKey) {
                    var surfSource = t.surfGrid;
                    if (masked) {
                        try { surfSource = maskSurface(t.surfGrid, t.groundGrid, t.bld, _BLD_MARGIN).grid; }
                        catch (err) {   // la maquette doit rester celle d'avant : on abandonne les bâtiments de cette dalle
                            console.warn('[geo-lidar-hd] masquage des bâtiments de la dalle ' + t.name + ' impossible :', err);
                            t.bld = null; t.bldMissing = true; masked = false;
                        }
                    }
                    t.treeData = null;
                    if (trees) {
                        try {
                            var det = detectTrees(t.veg, t.groundGrid, [t.bbox[0], t.bbox[1]]);
                            surfSource = removeCanopy(surfSource, t.groundGrid, t.veg, det.canopy).grid;
                            t.treeData = det;
                        } catch (err2) {   // idem : la dalle reste sans arbres
                            console.warn('[geo-lidar-hd] arbres de la dalle ' + t.name + ' impossibles :', err2);
                            t.veg = null; t.vegMissing = true; trees = false;
                        }
                    }
                    surfKey = t.surfGrid.size + (masked ? 'b' + t.groundGrid.size : '') + (trees ? 'v' + t.groundGrid.size : '');
                    if (t.surfTex) { t.surfTex.dispose(); }
                    t.surfTex = _floatTexture(surfSource).tex; t.surfTexKey = surfKey;
                }
                var mesh = t.maqMesh;
                if (!mesh) {
                    var mat = new ShaderMaterial({
                        vertexShader: _MAQ_VS, fragmentShader: _MAQ_FS, side: DoubleSide,
                        uniforms: {
                            tTex: { value: t.groundTex }, tInfo: { value: new Vector4() },
                            sTex: { value: t.surfTex }, sInfo: { value: new Vector4() },
                            oTex: { value: t.orthoTex || new Texture() }, useOrtho: { value: 0 }, colorMode: { value: 0 }, hagMax: { value: 30 },
                            mixT: { value: 1 }, exag: { value: 1 }, zRef: { value: 0 }
                        }
                    });
                    mesh = t.maqMesh = new Mesh(_maqGeometry(t === _main ? 1000 : 500), mat);
                    mesh.frustumCulled = false;   // les sommets sont déplacés par le shader : la boîte englobante serait fausse
                    mesh.name = 'geo-lidar-maquette-' + t.name;
                    mesh.position.set(t.bbox[0], t.bbox[1], 0);
                    _view.scene.add(mesh);
                }
                var u = mesh.material.uniforms, tg = t.groundGrid, sg = t.surfGrid;
                u.tTex.value = t.groundTex; u.tInfo.value.set(tg.x0 - t.bbox[0], tg.y0 - t.bbox[1], tg.step, tg.size);
                u.sTex.value = t.surfTex;   u.sInfo.value.set(sg.x0 - t.bbox[0], sg.y0 - t.bbox[1], sg.step, sg.size);
                if (t.orthoTex) { u.oTex.value = t.orthoTex; }
                u.zRef.value = zRef;
                mesh.visible = true;
                mesh.updateMatrixWorld(true);   // scene.matrixWorldAutoUpdate est désactivé par iTowns
                // Bâtiments LoD2 : un maillage à côté de celui de la maquette, dont le matériau PARTAGE ses objets uniforms
                // (curseur, relief, texture, orthophoto, MNT) pour que « Animer » et les réglages le suivent.
                if (masked && t.bld.nVerts > 0 && !t.bldMesh) {
                    var bg = new BufferGeometry();
                    bg.setAttribute('position', new BufferAttribute(t.bld.positions, 3));
                    bg.setAttribute('aFoot', new BufferAttribute(t.bld.foot, 1));
                    bg.setIndex(new BufferAttribute(t.bld.indices, 1));
                    var bmat = new ShaderMaterial({
                        vertexShader: _BLD_VS, fragmentShader: _BLD_FS, side: DoubleSide,
                        uniforms: {
                            tTex: u.tTex, tInfo: u.tInfo, oTex: u.oTex, useOrtho: u.useOrtho, colorMode: u.colorMode, hagMax: u.hagMax,
                            mixT: u.mixT, exag: u.exag, zRef: u.zRef
                        }
                    });
                    var bmesh = t.bldMesh = new Mesh(bg, bmat);
                    bmesh.frustumCulled = false;   // sommets déplacés par le shader
                    bmesh.name = 'geo-lidar-batiments-' + t.name;
                    bmesh.position.set(t.bbox[0], t.bbox[1], 0);
                    _view.scene.add(bmesh);
                }
                if (t.bldMesh) {
                    t.bldMesh.visible = masked;
                    t.bldMesh.updateMatrixWorld(true);
                }
                // Arbres 3D : deux maillages en instances (houppiers, troncs) qui partagent eux aussi les uniforms de la maquette.
                if (trees && t.treeData && t.treeKey !== surfKey) {
                    _disposeTrees(t);
                    var td = t.treeData, n = td.n;
                    if (n > 0) {
                        var shared = { tTex: u.tTex, tInfo: u.tInfo, oTex: u.oTex, useOrtho: u.useOrtho, colorMode: u.colorMode, hagMax: u.hagMax, mixT: u.mixT, exag: u.exag, zRef: u.zRef };
                        var crownMat = new ShaderMaterial({ vertexShader: _TREE_VS, fragmentShader: _TREE_FS, side: DoubleSide, uniforms: Object.assign({ uTrunk: { value: 0 } }, shared) });
                        var trunkMat = new ShaderMaterial({ vertexShader: _TREE_VS, fragmentShader: _TREE_FS, side: DoubleSide, uniforms: Object.assign({ uTrunk: { value: 1 } }, shared) });
                        var trunkGeo = new CylinderGeometry(0.22, 0.3, 1, 6);
                        trunkGeo.rotateX(Math.PI / 2); trunkGeo.translate(0, 0, 0.5);   // axe vertical (z), de 0 à 1
                        var crowns = new InstancedMesh(new IcosahedronGeometry(1, 1), crownMat, n), trunks = new InstancedMesh(trunkGeo, trunkMat, n);
                        var m4 = new Matrix4(), qi = new Quaternion(), pv = new Vector3(), sv = new Vector3();
                        for (var ti = 0; ti < n; ti++) {
                            var tx = td.trees[6 * ti], ty = td.trees[6 * ti + 1], gz = td.trees[6 * ti + 2], zb = td.trees[6 * ti + 3], zt = td.trees[6 * ti + 4], tr = td.trees[6 * ti + 5];
                            var half = Math.max(0.5, (zt - zb) / 2);   // demi-hauteur du houppier ; le tronc va du sol à sa base
                            crowns.setMatrixAt(ti, m4.compose(pv.set(tx, ty, zt - half), qi, sv.set(tr, tr, half)));
                            trunks.setMatrixAt(ti, m4.compose(pv.set(tx, ty, gz), qi, sv.set(1, 1, Math.max(0.001, zb - gz - 0.2))));
                        }
                        [crowns, trunks].forEach(function (im, idx) {
                            im.frustumCulled = false;   // sommets déplacés par le shader
                            im.name = 'geo-lidar-arbres-' + (idx ? 'troncs-' : 'houppiers-') + t.name;
                            im.position.set(t.bbox[0], t.bbox[1], 0);
                            _view.scene.add(im);
                        });
                        t.treeMesh = crowns; t.trunkMesh = trunks;
                    }
                    t.treeKey = surfKey;
                }
                if (t.treeMesh) {
                    t.treeMesh.visible = t.trunkMesh.visible = trees;
                    t.treeMesh.updateMatrixWorld(true); t.trunkMesh.updateMatrixWorld(true);
                }
                ready++;
            });
            var state = !m.on ? 'idle' : (total && ready === total ? 'ready' : 'loading');
            if (m.state !== state) { $timeout(function () { if (_currentScope) { _currentScope.maq.state = state; } }); }
            _applyMaquette();
        }

        // Réglages de la maquette (curseur, relief, texture) et visibilité du nuage de points.
        function _applyMaquette() {
            var sc = _currentScope, m = sc && sc.maq;
            if (!_view || !m) { return; }
            var hmax = Number(sc.style.hagColorMax) || 30;
            _tiles.forEach(function (t) {
                if (t.layer) { t.layer.visible = !(m.on && !m.points); }
                if (!t.maqMesh) { return; }
                var u = t.maqMesh.material.uniforms;
                u.mixT.value = Math.max(0, Math.min(1, Number(m.t) / 100));
                u.exag.value = Number(m.exag) || 1;
                u.colorMode.value = m.color === 'height' ? 1 : 0;
                u.useOrtho.value = (m.color === 'ortho' && t.orthoTex) ? 1 : 0;
                u.hagMax.value = hmax;
                t.maqMesh.visible = !!m.on;
                if (t.bldMesh) { t.bldMesh.visible = !!(m.on && m.buildings && t.bld); }
                if (t.treeMesh) { t.treeMesh.visible = t.trunkMesh.visible = !!(m.on && m.trees && t.veg); }
            });
            _orbitPlace();
            _view.notifyChange(_view.camera.camera3D);
        }

        // « Animer » : le curseur va de la surface au terrain nu puis revient, en 6 s.
        var _maqAnim = 0;
        function _maqStopAnim() {
            if (_maqAnim) { window.cancelAnimationFrame(_maqAnim); _maqAnim = 0; }
            if (_currentScope && _currentScope.maq.anim) { _currentScope.maq.anim = false; }
        }
        function _maqPlay() {
            var sc = _currentScope;
            if (!sc) { return; }
            if (sc.maq.anim) { _maqStopAnim(); return; }
            sc.maq.anim = true;
            var t0 = null;
            (function step(now) {
                if (!_currentScope || !_currentScope.maq.anim) { _maqAnim = 0; return; }
                if (t0 === null) { t0 = now; }
                var k = Math.min(1, (now - t0) / 6000);
                var f = k < 0.5 ? 1 - 2 * k : 2 * k - 1;            // 1 -> 0 -> 1
                _currentScope.maq.t = Math.round(100 * f * f * (3 - 2 * f));   // lissé aux deux bouts
                _applyMaquette();
                _currentScope.$applyAsync();
                if (k >= 1) { _maqAnim = 0; _currentScope.maq.anim = false; _currentScope.maq.t = 100; _applyMaquette(); return; }
                _maqAnim = window.requestAnimationFrame(step);
            })(window.performance.now());
        }

        // Export vidéo : rendu IMAGE PAR IMAGE. La caméra avance d'un pas fixe (un tour complet = durée × 30 images), on attend que
        // la vue soit dessinée, puis l'image du canvas part à l'encodeur WebCodecs (H.264 en MP4, le plus répandu ; sinon VP9 puis VP8 en WebM)
        // avec son horodatage exact ; mp4-muxer ou webm-muxer écrit le fichier. La vidéo fait donc 30 images par seconde quelle que soit la lenteur du poste (un enregistrement en direct
        // par MediaRecorder donnait 3 à 4 images par seconde en 4K) ; l'export prend simplement plus de temps. Tout ce qui est réglé dans la
        // maquette est dans la vidéo ; les contrôles sont désactivés pendant l'export et la caméra revient à sa position de départ.
        // Point d'orbite choisi sur la maquette : on clique, le rayon de la souris est suivi pas à pas jusqu'à la surface affichée (MNT
        // et MNS des dalles, curseur et relief exagéré compris) ; un repère cyan le montre, masqué pendant l'enregistrement. Le point est
        // gardé en altitudes vraies (sol et surface) pour suivre le curseur et le relief. Sans point, la vidéo tourne autour du centre de la vue.
        var _orbitPt = null, _orbitBall = null, _orbitPicking = false;
        function _maqDisplayZ(x, y, parts) {
            for (var i = 0; i < _tiles.length; i++) {
                var t = _tiles[i], b = t.bbox;
                if (!b || !t.groundGrid || !t.surfGrid || x < b[0] || x > b[2] || y < b[1] || y > b[3]) { continue; }
                var zg = t.groundGrid.sample(x, y), zs = t.surfGrid.sample(x, y);
                if (zg !== zg) { zg = t.groundGrid.nearest(x, y); }
                if (zs !== zs) { zs = t.surfGrid.nearest(x, y); }
                if (parts) { parts.zg = zg; parts.zs = zs; }
                return _orbitZ(zg, zs);
            }
            return NaN;
        }
        // Altitude affichée d'un point de sol zg / surface zs : curseur terrain nu -> surface, puis relief exagéré autour de la référence commune.
        function _orbitZ(zg, zs) {
            var m = _currentScope && _currentScope.maq, k = m ? Math.max(0, Math.min(1, Number(m.t) / 100)) : 1, ex = m ? (Number(m.exag) || 1) : 1, z;
            if (zg === zg && zs === zs) { z = zg + (Math.max(zs, zg) - zg) * k; }
            else if (zg === zg) { z = zg; } else if (zs === zs) { z = zs; } else { return NaN; }
            return _maqZRef + (z - _maqZRef) * ex;
        }
        function _orbitPoint() { return new Vector3(_orbitPt.x, _orbitPt.y, _orbitZ(_orbitPt.zg, _orbitPt.zs)); }
        function _orbitPlace() {
            if (!_orbitPt || !_orbitBall || !_view) { return; }
            var z = _orbitZ(_orbitPt.zg, _orbitPt.zs);
            if (z === z) { _orbitBall.position.set(_orbitPt.x, _orbitPt.y, z); }
            var m = _currentScope && _currentScope.maq;
            _orbitBall.visible = !!(m && m.on) && !_vid;
            _scalePick();
        }
        function _orbitPickStart() {
            var sc = _currentScope;
            if (!sc || !_pickEl || _vid) { return; }
            _orbitPicking = true;
            _pickEl.style.cursor = 'crosshair';
            _vidSet({ pt: 'picking', msg: '' });
        }
        function _orbitPickStop() {
            _orbitPicking = false;
            if (_pickEl) { _pickEl.style.cursor = ''; }
            _vidSet({ pt: _orbitPt ? 'set' : 'none' });
        }
        function _orbitSetFromClick(cx, cy) {
            if (!_view || !_pickEl) { return; }
            var cam = _view.camera.camera3D, rect = _pickEl.getBoundingClientRect();
            cam.updateMatrixWorld();
            var inv = new Matrix4().copy(cam.projectionMatrix).invert();
            var far = new Vector3((cx - rect.left) / rect.width * 2 - 1, 1 - (cy - rect.top) / rect.height * 2, 0.5).applyMatrix4(inv).applyMatrix4(cam.matrixWorld);
            var o = cam.position.clone(), dir = far.sub(o).normalize();
            var maxD = o.distanceTo(_controls.target) * 4 + 2000, d = 0, prevD = 0, hit = null, p = new Vector3();
            while (d < maxD) {
                p.copy(o).addScaledVector(dir, d);
                var z = _maqDisplayZ(p.x, p.y);
                if (z === z && p.z <= z) {
                    var lo = prevD, hi = d;   // affinage par dichotomie entre le dernier pas au-dessus et le premier en dessous
                    for (var it = 0; it < 14; it++) {
                        var mid = (lo + hi) / 2;
                        p.copy(o).addScaledVector(dir, mid);
                        var zm = _maqDisplayZ(p.x, p.y);
                        if (zm === zm && p.z <= zm) { hi = mid; } else { lo = mid; }
                    }
                    hit = o.clone().addScaledVector(dir, hi);
                    break;
                }
                prevD = d;
                d += Math.max(1, d / 400);
            }
            if (!hit) { _vidSet({ msg: 'Aucun point de la maquette à cet endroit : cliquez sur le terrain.' }); return; }
            var parts = {};
            _maqDisplayZ(hit.x, hit.y, parts);
            _orbitPt = { x: hit.x, y: hit.y, zg: parts.zg, zs: parts.zs };
            if (!_orbitBall) {
                _orbitBall = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true }));
                _orbitBall.renderOrder = 1001;
                _view.scene.add(_orbitBall);
            }
            _orbitPickStop();
            _orbitPlace();
            _view.notifyChange(cam);
        }
        function _orbitClear() {
            _orbitPicking = false;
            if (_pickEl) { _pickEl.style.cursor = ''; }
            _orbitPt = null;
            _disposeObj(_orbitBall); _orbitBall = null;
            if (_view && _controls) { _view.notifyChange(_view.camera.camera3D); }
            _vidSet({ pt: 'none' });
        }

        var _vid = null;   // export en cours : { cancelled, restore, start, target, after, pending, encoder }
        var _VID_FPS = 30;
        function _videoSupported() { return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function'; }
        function _vidSet(patch) {
            var sc = _currentScope;
            if (!sc) { return; }
            Object.keys(patch).forEach(function (k) { sc.vid[k] = patch[k]; });
            sc.$applyAsync();
        }
        function _vidAbort() {
            var job = _vid;
            if (!job) { return; }
            job.cancelled = true;
            _vidFinish(job);
            _vidSet({ state: 'idle', pct: 0, msg: '' });
        }
        function _vidFinish(job) {
            if (_vid !== job) { return; }
            _vid = null;
            job.pending = null;
            try { if (_view && job.after) { _view.removeFrameRequester(MAIN_LOOP_EVENTS.AFTER_RENDER, job.after); } } catch (e) { /* vue détruite */ }
            try { if (job.restore) { job.restore(); } } catch (e) { console.warn('[geo-lidar-hd] retour à la définition normale :', e); }
            try {
                if (_controls) { _controls.enabled = true; }
                if (_view && _controls && job.start) {
                    _controls.target.copy(job.target);
                    _view.camera.camera3D.position.copy(job.start); _controls.update(); _view.notifyChange(_view.camera.camera3D);
                }
                _orbitPlace();
            } catch (e) { console.warn('[geo-lidar-hd] retour de la caméra après la vidéo :', e); }
        }
        // Certains navigateurs (Firefox) encodent en H.264 mais ne donnent pas la description du flux (SPS/PPS, decoderConfig) dont un fichier MP4
        // a besoin : on le vérifie une fois avec une toute petite image, et sans elle on écrit un WebM (VP9, VP8) à la place.
        var _avcProbe = null;
        function _vidAvcUsable() {
            if (_avcProbe) { return _avcProbe; }
            return (_avcProbe = new Promise(function (resolve) {
                var done = false;
                function end(v) { if (!done) { done = true; resolve(v); } }
                try {
                    var c = document.createElement('canvas'); c.width = c.height = 128;
                    c.getContext('2d').fillRect(0, 0, 128, 128);
                    var enc = new window.VideoEncoder({
                        output: function (chunk, meta) { end(!!(meta && meta.decoderConfig && meta.decoderConfig.description)); },
                        error: function () { end(false); }
                    });
                    enc.configure({ codec: 'avc1.64001f', width: 128, height: 128, bitrate: 1e6, framerate: _VID_FPS, avc: { format: 'avc' } });
                    var f = new window.VideoFrame(c, { timestamp: 0 });
                    enc.encode(f, { keyFrame: true }); f.close();
                    enc.flush().then(function () { end(false); }, function () { end(false); });   // sortie déjà reçue, sinon : pas de H.264
                    window.setTimeout(function () { end(false); }, 4000);
                } catch (e) { end(false); }
            }));
        }
        // Premier codec utilisable pour cette taille : H.264 (MP4, lu partout ; plusieurs niveaux car l'encodeur refuse un niveau trop bas pour
        // la taille), sinon VP9 puis VP8 (WebM).
        function _vidCodec(w, h, bps) {
            return _vidAvcUsable().then(function (avcOk) {
                var cands = (avcOk ? [
                    { enc: 'avc1.640034', mux: 'avc', ext: 'mp4', mime: 'video/mp4' }, { enc: 'avc1.640033', mux: 'avc', ext: 'mp4', mime: 'video/mp4' },
                    { enc: 'avc1.64002a', mux: 'avc', ext: 'mp4', mime: 'video/mp4' }
                ] : []).concat([
                    { enc: 'vp09.00.51.08', mux: 'V_VP9', ext: 'webm', mime: 'video/webm' }, { enc: 'vp8', mux: 'V_VP8', ext: 'webm', mime: 'video/webm' }
                ]);
                return cands.reduce(function (chain, c) {
                    return chain.then(function (found) {
                        if (found) { return found; }
                        var conf = { codec: c.enc, width: w, height: h, bitrate: bps, framerate: _VID_FPS, latencyMode: 'realtime' };
                        if (c.mux === 'avc') { conf.avc = { format: 'avc' }; }   // format attendu par un fichier MP4
                        return window.VideoEncoder.isConfigSupported(conf)
                            .then(function (r) { return r && r.supported ? { enc: r.config, mux: c.mux, name: c.enc, ext: c.ext, mime: c.mime, noAvc: !avcOk } : null; }, function () { return null; });
                    });
                }, Promise.resolve(null));
            });
        }
        function _vidDelay(ms) { return new Promise(function (res) { window.setTimeout(res, ms); }); }
        // Dessine la vue TOUT DE SUITE (on avance nous-mêmes la boucle d'iTowns d'un pas, sans attendre un requestAnimationFrame) puis exécute fn
        // dans la même tâche : le contenu du canvas WebGL n'est valable qu'à ce moment-là. Une erreur du rendu remonte telle quelle.
        function _vidRenderThen(job, fn) {
            return new Promise(function (resolve, reject) {
                try {
                    job.pending = function () { try { fn(); resolve(); } catch (e) { reject(e); } };
                    _view.notifyChange(_view.camera.camera3D, true);
                    _view.mainLoop.step(_view, window.performance.now());
                    if (job.pending) { job.pending = null; reject(new Error('la vue ne s\'est pas dessinée (rendu iTowns non exécuté)')); }
                } catch (e) { job.pending = null; reject(e); }
            });
        }
        function _maqRecord() {
            var sc = _currentScope;
            if (!sc || !_view || !_controls || _vid) { return; }
            if (!_videoSupported()) { _vidSet({ state: 'error', msg: 'Ce navigateur ne sait pas encoder de vidéo (WebCodecs absent).' }); return; }
            _maqStopAnim();
            var cam = _view.camera.camera3D, oldTarget = _controls.target.clone(), target = oldTarget.clone();
            if (_orbitPt) {   // orbite autour du point choisi : même direction de la caméra vers lui, même distance qu'avant
                var pz = _orbitPoint();
                if (pz.z === pz.z) { target = pz; }
            }
            var off0 = cam.position.clone().sub(target);
            if (target !== oldTarget) { off0.setLength(cam.position.distanceTo(oldTarget)); }
            var seconds = Math.max(5, Number(sc.vid.dur) || 20), total = Math.round(seconds * _VID_FPS);
            // Résolution : iTowns dessine à 1 pixel par pixel d'écran ; pour Full HD (1920 px de large) ou 4K (3 840 px), on augmente la
            // définition du canvas (sans changer sa taille à l'écran) pendant l'export.
            var rd = _view.mainLoop.gfxEngine.renderer, oldPR = rd.getPixelRatio(), cssSize = rd.getSize(new Vector2());
            var q = sc.vid.q, wide = q === '4k' ? 3840 : (q === 'hd' ? 1920 : 0), pr = Math.max(1, wide ? wide / Math.max(1, cssSize.x) : 1);
            function setPR(v) { rd.setPixelRatio(v); rd.setSize(cssSize.x, cssSize.y); }
            var job = _vid = { cancelled: false, start: cam.position.clone(), target: oldTarget, pending: null, encoder: null,
                restore: function () { if (rd.getPixelRatio() !== oldPR) { setPR(oldPR); } } };
            job.after = function () { var f = job.pending; if (f) { job.pending = null; f(); } };
            _view.addFrameRequester(MAIN_LOOP_EVENTS.AFTER_RENDER, job.after);
            _controls.enabled = false;
            if (_orbitBall) { _orbitBall.visible = false; }   // le repère n'apparaît pas dans la vidéo
            _vidSet({ state: 'rec', pct: 0, msg: 'Préparation de la vidéo…' });
            setPR(pr);
            cam.position.copy(target).add(off0);   // position de départ tout de suite, sans saut
            _controls.target.copy(target); _controls.update();
            var W = rd.domElement.width - (rd.domElement.width % 2), H = rd.domElement.height - (rd.domElement.height % 2);
            var bps = Math.round(Math.max(10e6, Math.min(50e6, W * H * _VID_FPS * 0.12)));
            var failure = null, muxer = null, encoder = null, fmt = null, mp4Ready = false, outN = 0, i = 0, t0 = 0, lastUi = 0;
            _vidCodec(W, H, bps).then(function (cfg) {
                if (!cfg) { throw new Error('aucun codec vidéo (H.264, VP9, VP8) disponible dans ce navigateur pour ' + W + ' × ' + H); }
                fmt = cfg;
                muxer = cfg.ext === 'mp4'
                    ? new Mp4Muxer({ target: new Mp4Target(), video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' })   // moov en tête : lecture immédiate
                    : new WebmMuxer({ target: new WebmTarget(), video: { codec: cfg.mux, width: W, height: H, frameRate: _VID_FPS }, firstTimestampBehavior: 'offset' })   // Firefox : la 1re image encodée n'est pas à 0;
                encoder = job.encoder = new VideoEncoder({ output: function (chunk, meta) {
                        try {
                            if (fmt.ext === 'mp4' && !(meta && meta.decoderConfig) && !mp4Ready) { throw new Error('l\'encodeur H.264 de ce navigateur ne fournit pas la description du flux'); }
                            if (meta && meta.decoderConfig) { mp4Ready = true; }
                            // Firefox ne renseigne pas la durée et ne garantit pas des horodatages croissants : sans images B (mode realtime),
                            // l'ordre de sortie est l'ordre d'affichage, on pose donc nous-mêmes l'horodatage image par image
                            var data = new Uint8Array(chunk.byteLength);
                            chunk.copyTo(data);
                            if (outN < 4) { console.info('[geo-lidar-hd] vidéo : sortie ' + outN + ' ' + chunk.type + ' ts=' + chunk.timestamp); }
                            muxer.addVideoChunkRaw(data, chunk.type, Math.round(outN * 1e6 / _VID_FPS), Math.round(1e6 / _VID_FPS), meta);
                            outN++;
                        } catch (e) { failure = failure || e; }
                    }, error: function (e) { failure = e; } });
                encoder.configure(cfg.enc);
                console.info('[geo-lidar-hd] vidéo : ' + W + ' × ' + H + ', ' + cfg.name + ', ' + (bps / 1e6).toFixed(0) + ' Mbit/s, ' + total + ' images');
                t0 = window.performance.now();
                return _vidDelay(400);   // la vue se redessine une première fois à la nouvelle définition
            }).then(function nextFrame() {
                if (_vid !== job || job.cancelled) { return false; }
                if (failure) { throw failure; }
                if (i >= total) { return true; }
                if (encoder.encodeQueueSize > 6) { return _vidDelay(20).then(nextFrame); }   // l'encodeur n'a pas suivi : on attend
                cam.position.copy(target).add(off0.clone().applyAxisAngle(_UP, -2 * Math.PI * i / total));
                _controls.target.copy(target); _controls.update();
                return _vidRenderThen(job, function () {
                    var frame = new VideoFrame(rd.domElement, { timestamp: Math.round(i * 1e6 / _VID_FPS), duration: Math.round(1e6 / _VID_FPS) });
                    encoder.encode(frame, { keyFrame: i % (_VID_FPS * 2) === 0 });
                    frame.close();
                }).then(function () {
                    i++;
                    var now = window.performance.now();
                    if (now - lastUi > 400) {
                        lastUi = now;
                        var left = Math.round((now - t0) / i * (total - i) / 1000);
                        _vidSet({ pct: Math.round(100 * i / total), msg: 'Image ' + i + ' / ' + total + ' — encore ' + (left >= 90 ? Math.round(left / 60) + ' min' : left + ' s') });
                    }
                    return _vidDelay(0).then(nextFrame);   // rend la main à l'interface (annulation, progression)
                });
            }).then(function (complete) {
                if (!complete) { return null; }
                _vidSet({ pct: 100, msg: 'Finalisation du fichier…' });
                return encoder.flush().then(function () {
                    if (failure) { throw failure; }
                    muxer.finalize();
                    var blob = new Blob([muxer.target.buffer], { type: fmt.mime }), d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
                    _downloadBlob(blob, 'maquette-' + (_main ? _main.name : 'dalle') + '-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + '.' + fmt.ext);
                    _vidSet({ state: 'done', pct: 100, msg: 'Vidéo enregistrée (' + (blob.size / 1048576).toFixed(1).replace('.', ',') + ' Mo, ' + fmt.ext.toUpperCase() + ', ' + W + ' × ' + H + ', ' + _VID_FPS + ' images/s)' + (fmt.noAvc ? ' ; MP4 indisponible dans ce navigateur, d\'où le WebM.' : '.') });
                });
            }).catch(function (err) {
                console.warn('[geo-lidar-hd] export vidéo :', err);
                if (_vid === job) { _vidSet({ state: 'error', pct: 0, msg: 'Export vidéo impossible : ' + (err && err.message ? err.message : err) }); }
            }).then(function () {
                try { if (encoder && encoder.state !== 'closed') { encoder.close(); } } catch (e) { /* déjà fermé */ }
                _vidFinish(job);
            });
        }

        // Emprise d'une dalle LiDAR HD d'après son nom « XXXX-YYYY » = coin nord-ouest en km (Lambert-93).
        function _tileBbox(name) {
            var m = /^(\d{4})-(\d{4})$/.exec(name || '');
            if (!m) { return null; }
            var x = parseInt(m[1], 10) * 1000, y = parseInt(m[2], 10) * 1000;
            return [x, y - 1000, x + 1000, y];
        }

        // Télécharge l'orthophoto de la dalle, par passes successives (jusqu'à orthoMaxSize) : 1024 px (~0,7 s côté
        // WMS IGN, le mode Orthophoto devient disponible presque tout de suite), 2048 px (~3 s, ~0,5 m/px) puis
        // 4096 px (~14 s, ~0,24 m/px, un pixel par point). Chaque passe remplace la précédente.
        // Lancé dès que le WFS a répondu, en parallèle de la lecture du COPC.
        var _ORTHO_SIZES = [1024, 2048, 4096];
        function _startOrtho(tile, seq, maxSize) {
            if (!_orthoWmsUrl || !_view || !tile.bbox) { return; }
            var bb = tile.bbox;
            var maxTex = Math.min(maxSize || 4096, _view.mainLoop.gfxEngine.renderer.capabilities.maxTextureSize || 2048);
            _ORTHO_SIZES.filter(function (n) { return n <= maxTex && n <= _orthoMaxSize; }).forEach(function (size) {
                var url = _orthoWmsUrl + (_orthoWmsUrl.indexOf('?') === -1 ? '?' : '&') +
                    'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=EPSG:2154' +
                    '&BBOX=' + bb.join(',') + '&WIDTH=' + size + '&HEIGHT=' + size + '&FORMAT=image/jpeg';
                // Un <img> ne rejoue pas seul sur 429 (limitation de débit du WMS) : on réessaie avec attente croissante.
                (function load(attempt) {
                    var img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = function () {
                        if (size > (tile.orthoSize || 0)) {   // la passe fine peut arriver avant la grossière
                            tile.orthoImg = img;
                            tile.orthoSize = size;
                        }
                        _attachOrtho(tile, seq);
                    };
                    img.onerror = function () {
                        if (attempt >= 4 || seq !== _loadSeq) {
                            console.warn('[geo-lidar-hd] orthophoto ' + size + ' indisponible : ' + url);
                            return;
                        }
                        setTimeout(function () { load(attempt + 1); }, 700 * Math.pow(2, attempt) + Math.random() * 300);
                    };
                    img.src = attempt ? url + '&retry=' + attempt : url;
                })(0);
            });
        }

        // Branche l'orthophoto sur la couche : nécessite à la fois l'image et la couche prête (dans l'ordre
        // d'arrivée que l'on veut, d'où l'appel depuis les deux côtés). Rappelée pour remplacer par la passe fine.
        function _attachOrtho(tile, seq) {
            var layer = tile.layer;
            if (!tile.orthoImg || !layer || seq !== _loadSeq || !_view || !layer.material.uniforms.orthoBox ||
                (layer.orthoSize || 0) >= tile.orthoSize) { return; }
            var first = !layer.orthoSize;
            layer.orthoSize = tile.orthoSize;
            if (tile.orthoTex) { tile.orthoTex.dispose(); }
            var tex = tile.orthoTex = new Texture(tile.orthoImg);
            tex.minFilter = tex.magFilter = LinearFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            var bb = tile.bbox;
            layer.material.uniforms.orthoTex.value = tex;
            layer.material.uniforms.orthoBox.value.set(bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]);
            _maquetteUpdate();
            if (!first) { _view.notifyChange(layer); return; }
            if (tile !== _main) { _applyStyle(); return; }   // dalle voisine : elle rejoint le mode Orthophoto s'il est actif
            $timeout(function () {
                if (!_currentScope) { return; }
                var sc = _currentScope;
                sc.ui.orthoReady = true;
                sc.modes = _modeList(sc.ui);
                sc.profileModes = _profileModeList(sc.ui);
                if (!sc.ui.modeUserSet) { sc.style.mode = 'ORTHO'; }
                _applyStyle();
            });
        }

        // Retire toutes les dalles de la vue (couches iTowns et textures d'orthophoto).
        function _removeTiles() {
            _tiles.forEach(_disposeTile);
            _tiles = []; _layer = null; _main = null;
        }

        // Retire les maillages d'arbres d'une dalle et libère leurs ressources (géométries, matériaux, tampons d'instances).
        function _disposeTrees(t) {
            [t.treeMesh, t.trunkMesh].forEach(function (im) {
                if (!im) { return; }
                if (im.parent) { im.parent.remove(im); }
                im.geometry.dispose(); im.material.dispose(); im.dispose();
            });
            t.treeMesh = t.trunkMesh = null; t.treeKey = null;
        }

        function _disposeTile(t) {
            try { if (_view) { _view.removeLayer(t.layer.id); } t.layer.delete(); } catch (e) { /* déjà retirée */ }
            if (t.orthoTex) { t.orthoTex.dispose(); }
            if (t.groundTex) { t.groundTex.dispose(); }
            if (t.surfTex) { t.surfTex.dispose(); }
            if (t.maqMesh) { if (t.maqMesh.parent) { t.maqMesh.parent.remove(t.maqMesh); } t.maqMesh.material.dispose(); t.maqMesh = null; }
            if (t.bldMesh) { if (t.bldMesh.parent) { t.bldMesh.parent.remove(t.bldMesh); } t.bldMesh.geometry.dispose(); t.bldMesh.material.dispose(); t.bldMesh = null; }
            t.bld = null;
            _disposeTrees(t);
            t.veg = null; t.treeData = null;
            t.layer = null; t.orthoTex = null; t.orthoPix = null; t.groundTex = null; t.groundGrid = null; t.surfGrid = null; t.surfTex = null;
        }

        // Budget de points commun aux dalles. iTowns l'applique par couche (les nœuds les moins importants à l'écran
        // sont masqués) : on neutralise le sien (budget infini) et on fait le même tri sur les nœuds de toutes les
        // dalles, juste avant le rendu. La dalle regardée de près garde ainsi l'essentiel du budget.
        function _applyBudget() {
            var all = [], total = 0, i, k, n;
            for (k = 0; k < _tiles.length; k++) {
                var layer = _tiles[k].layer, kids = layer.group ? layer.group.children : [];
                for (i = 0; i < kids.length; i++) {
                    if (kids[i].visible) { kids[i].userData.tile = _tiles[k]; all.push(kids[i]); total += kids[i].geometry.attributes.position.count; }
                }
            }
            if (total <= _budgetTotal) { return; }
            all.sort(function (p1, p2) { return p2.userData.node.sse - p1.userData.node.sse; });
            for (k = 0; k < _tiles.length; k++) { _tiles[k].layer.displayedCount = 0; }
            var shown = 0, hit = false;
            for (i = 0; i < all.length; i++) {
                n = all[i].geometry.attributes.position.count;
                if (hit || shown + n > _budgetTotal) { all[i].visible = false; hit = true; }
                else { shown += n; all[i].userData.tile.layer.displayedCount += n; }
            }
        }

        // Ajoute la couche COPC d'une dalle à la vue. Résout avec la couche, ou null si un clic plus récent a pris la main.
        function _addTileLayer(tile, seq) {
            var source = new CopcSource({ url: tile.url });
            // id unique : la couche d'un clic précédent peut encore être en cours d'ajout
            var layer  = new CopcLayer('lidar-hd-' + seq + '-' + tile.name, {
                source:       source,
                crs:          _view.referenceCrs,
                sseThreshold: 2,
                pointBudget:  Infinity   // budget commun à toutes les dalles : voir _applyBudget
            });
            return _view.addLayer(layer).then(function () {
                if (seq !== _loadSeq || !_view) {
                    try { _view.removeLayer(layer.id); layer.delete(); } catch (e) { /* déjà nettoyé */ }
                    return null;
                }
                tile.layer = layer;
                _tiles.push(tile);
                _patchOctreeLoad(layer.root);
                tile.orthoOk = _patchOrthoShader(layer.material);
                tile.altOk   = _patchAltitudeShader(layer.material);
                tile.groundOk = _patchGroundShader(layer.material);
                return layer;
            });
        }

        // Bornes de la tranche d'altitude : celles de l'ensemble des dalles affichées. Un curseur resté en butée
        // suit la nouvelle borne quand une dalle voisine l'élargit ; `reset` remet les deux curseurs aux bornes.
        function _altBounds(st, reset) {
            var lo = Infinity, hi = -Infinity;
            _tiles.forEach(function (t) {
                var h = t.layer.source.header;
                lo = Math.min(lo, Math.floor(h.min[2])); hi = Math.max(hi, Math.ceil(h.max[2]));
            });
            if (lo > hi) { return; }
            if (reset || Number(st.altMin) <= st.altLo) { st.altMin = lo; }
            if (reset || Number(st.altMax) >= st.altHi) { st.altMax = hi; }
            st.altLo = lo; st.altHi = hi;
        }

        function _showTile(tile) {
            if (!_view) { return Promise.resolve(); }
            var seq = _loadSeq;

            _clearPick();   // le point appartient aux dalles précédentes
            _removeTiles();
            _removeKind('around');
            if (_currentScope) { var sc0 = _currentScope; sc0.$applyAsync(function () { sc0.around = null; }); }

            return _addTileLayer(tile, seq).then(function (layer) {
                if (!layer) { return; }   // un clic plus récent a pris la main
                _layer = layer;
                _main  = tile;
                var pdrf = layer.source.header && layer.source.header.pointDataRecordFormat;
                var hasColor = [2, 3, 5, 7, 8, 10].indexOf(pdrf) !== -1;
                $timeout(function () {
                    if (!_currentScope || _main !== tile) { return; }
                    var sc = _currentScope;
                    sc.ui.hasColor   = hasColor;
                    sc.ui.orthoReady = !!(tile.orthoOk && tile.orthoImg);
                    sc.ui.groundReady = !!layer.groundSize;   // le MNT peut déjà être là, sinon _attachGround le signale
                    sc.modes = _modeList(sc.ui);
                    sc.profileModes = _profileModeList(sc.ui);
                    // Mode initial : les couleurs des données si elles existent, sinon la classification.
                    // (L'orthophoto prend le relais dès qu'elle est chargée, sauf choix explicite de l'utilisateur.)
                    if (!sc.ui.modeUserSet || !_modeAvailable(sc.style.mode, sc.ui)) {
                        sc.style.mode = hasColor ? 'COLOR' : 'CLASSIFICATION';
                    }
                    _syncModes();
                    if (!sc.classes.length) { sc.classes = _buildClasses(layer.material.classificationScheme); }
                    sc.tile   = tile;
                    sc.status = null;
                    // Tranche d'altitude : bornes propres à la dalle (valeurs remises aux bornes, case conservée)
                    sc.ui.altAvailable = tile.altOk;
                    _altBounds(sc.style, true);
                    _groundBounds(sc.style, true);
                    // Aide à la navigation : ouverte d'office au premier affichage d'une dalle (une fois par
                    // ouverture du panneau), sauf si l'utilisateur a choisi « Ne plus afficher ».
                    if (!sc.ui.helpAuto && !_isHelpDismissed()) { sc.ui.helpAuto = true; sc.ui.helpOpen = true; }
                    _applyStyle();
                });
                if (tile.orthoOk) { _attachOrtho(tile, seq); }
                if (tile.groundOk) { _attachGround(tile, seq); }
                _frameLayer();
                _setLoading('Chargement des points…', 0);
                _watchStreaming(layer, tile, seq);
            });
        }

        // ------------------------------------------------------------
        // Dalles voisines : les 8 dalles autour de la dalle cliquée, ajoutées une à une en arrière-plan
        // ------------------------------------------------------------
        function _setAround(a) {
            var sc = _currentScope;
            if (sc) { sc.$applyAsync(function () { sc.around = a; }); }
        }

        // Suit l'arrivée des points des voisines : l'ajout d'une couche ne dit pas que ses points sont affichés.
        // Une dalle est considérée chargée quand son compteur de points ne bouge plus. À zéro point, l'attente est
        // plus longue si la dalle est dans le champ de la caméra : ses premiers points peuvent tarder.
        // Une fois toutes les dalles stabilisées, un recalcul complet (celui d'un déplacement de caméra) est forcé, car
        // des nœuds peuvent rester masqués après les recalculs partiels et le budget, puis les compteurs sont relus.
        var _AROUND_WATCH_MS = 400, _AROUND_STABLE_TICKS = 5, _AROUND_EMPTY_TICKS = 25;
        var _aroundTimer = null;
        function _stopAroundWatch() {
            if (_aroundTimer) { clearInterval(_aroundTimer); _aroundTimer = null; }
        }

        function _loadNeighbours(seq) {
            var main = _main;
            if (!_aroundOn || !main || !main.bbox || main.aroundAsked || seq !== _loadSeq) { return; }
            main.aroundAsked = true;
            var bb = main.bbox, gen = _aroundSeq;
            // Un clic plus récent ou la désactivation des voisines a pris la main.
            function stale() { return seq !== _loadSeq || !_view || _main !== main || gen !== _aroundSeq; }
            _setAround({ state: 'search', loaded: 0, total: 0 });
            // Une seule requête WFS : l'emprise de la dalle élargie de 500 m touche ses 8 voisines.
            var url = _wfsUrl + '?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0' +
                '&TYPENAMES=' + encodeURIComponent(_WFS_TYPENAME) +
                '&OUTPUTFORMAT=application%2Fjson&SRSNAME=EPSG:4326&COUNT=30' +
                '&BBOX=' + [bb[0] - 500, bb[1] - 500, bb[2] + 500, bb[3] + 500].join(',') + ',EPSG:2154';
            fetch(url).then(function (r) {
                if (!r.ok) { throw new Error('WFS HTTP ' + r.status); }
                return r.json();
            }).then(function (fc) {
                if (stale()) { return; }
                var seen = {}, cx = bb[0] + 500, cy = bb[1] + 500;
                seen[main.name] = true;
                var list = (fc.features || []).map(_tileFromFeature).filter(function (t) {
                    if (!t.url || !t.bbox || seen[t.name]) { return false; }
                    t.dist = Math.abs(t.bbox[0] + 500 - cx) + Math.abs(t.bbox[1] + 500 - cy);
                    if (t.dist > 2000) { return false; }
                    seen[t.name] = true;
                    return true;
                }).sort(function (a, b) { return a.dist - b.dist; });   // les 4 dalles qui partagent un côté, puis les coins
                _drawAround(list);
                var i = 0, loaded = 0, failed = 0, settled = 0, empty = 0;
                var allStarted = false, refreshed = false, watched = [], added = [];
                function refreshAll() { _view.notifyChange(_view.camera.camera3D); }
                function publish() {
                    var stable = allStarted && settled === list.length && !watched.length;
                    if (stable && !refreshed && added.length) {
                        refreshed = true;
                        refreshAll();
                        watched = added.map(function (a) { return { layer: a.layer, tile: a.tile, last: -1, stable: 0 }; });
                        stable = false;
                    }
                    if (stable) {
                        _stopAroundWatch();
                        if (added.length) { refreshAll(); }   // dernier recalcul : les nœuds arrivés pendant le contrôle
                    }
                    _setAround({ state: stable ? 'done' : 'loading', loaded: loaded, failed: failed, empty: empty, settled: settled, total: list.length });
                }
                _stopAroundWatch();
                _aroundTimer = setInterval(function () {
                    if (stale()) { _stopAroundWatch(); return; }
                    var before = watched.length;
                    watched = watched.filter(function (w) {
                        var n = w.layer.displayedCount || 0;
                        var inView = !w.layer.root || w.layer.root.visible !== false;
                        w.stable = (n === w.last) ? w.stable + 1 : 0;
                        w.last = n;
                        if (w.stable < (n > 0 || !inView ? _AROUND_STABLE_TICKS : _AROUND_EMPTY_TICKS)) { return true; }
                        if (!refreshed) { settled++; }
                        else if (!n && inView) {
                            empty++;
                            console.warn('[geo-lidar-hd] dalle voisine ' + w.tile.name + ' : aucun point affiché après le recalcul');
                        }
                        return false;
                    });
                    if (watched.length !== before) { publish(); }
                }, _AROUND_WATCH_MS);
                (function next() {
                    if (stale()) { return; }
                    if (i >= list.length) { allStarted = true; publish(); return; }
                    publish();
                    var t = list[i++];
                    _startOrtho(t, seq, 2048);   // 2048 px au plus : 8 textures de 4096 px pèseraient ~500 Mo
                    _startGround(t, seq, [1000]);   // une passe à 1 m (4 Mo) : 8 MNT à 0,5 m pèseraient 130 Mo
                    _addTileLayer(t, seq).then(function (layer) {
                        if (!layer) { return; }
                        if (stale()) {   // couche arrivée trop tard : on la retire aussitôt
                            _tiles = _tiles.filter(function (x) { return x !== t; });
                            _disposeTile(t);
                            return;
                        }
                        loaded++;
                        added.push({ layer: layer, tile: t });
                        watched.push({ layer: layer, tile: t, last: -1, stable: 0 });
                        if (_currentScope) { _altBounds(_currentScope.style, false); }
                        _applyStyle();
                        if (t.orthoOk) { _attachOrtho(t, seq); }
                        if (t.groundOk) { _attachGround(t, seq); }
                        if (_prof && _tileHitsProfile(t)) { _refreshProfileSoon(); _ensureProfileRasters(); }
                    }, function (err) {
                        console.warn('[geo-lidar-hd] dalle voisine ' + t.name + ' non chargée :', err);
                        failed++;
                        settled++;
                    }).then(next);
                })();
            }).catch(function (err) {
                console.warn('[geo-lidar-hd] dalles voisines indisponibles :', err);
                if (!stale()) { _setAround({ state: 'error', loaded: 0, total: 0 }); }
            });
        }

        // Bouton « Voisines » : charge les voisines de la dalle affichée, ou les retire pour ne garder qu'elle.
        function _setNeighbours(on) {
            _aroundOn = on;
            if (on) {
                if (!_watchTimer) { _loadNeighbours(_loadSeq); }   // sinon lancé à la fin du chargement de la dalle cliquée
                return;
            }
            var main = _main;
            _aroundSeq++;
            _stopAroundWatch();
            _tiles.filter(function (t) { return t !== main; }).forEach(_disposeTile);
            _tiles = main ? [main] : [];
            _removeKind('around');
            _setAround(null);
            if (!main) { return; }
            main.aroundAsked = false;
            if (_currentScope) { _altBounds(_currentScope.style, false); }
            _applyStyle();
            _refreshProfileSoon();
        }

        // Fiche de la dalle repliée par défaut (bouton i) ; le choix de l'utilisateur est mémorisé.
        var _INFO_KEY = 'geo-lidar-hd-info-open';
        function _readInfoOpen() {
            var v = null;
            try { v = window.localStorage.getItem(_INFO_KEY); } catch (e) { /* stockage indisponible */ }
            return v === '1';
        }
        function _saveInfoOpen(on) {
            try { window.localStorage.setItem(_INFO_KEY, on ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
        }

        // Choix mémorisé dans le navigateur ; à défaut, le réglage du générateur.
        var _AROUND_KEY = 'geo-lidar-hd-neighbours';
        function _readNeighbours() {
            var v = null;
            try { v = window.localStorage.getItem(_AROUND_KEY); } catch (e) { /* stockage indisponible */ }
            return v === '1' ? true : v === '0' ? false : _neighbours;
        }
        function _saveNeighbours(on) {
            try { window.localStorage.setItem(_AROUND_KEY, on ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
        }

        // ============================================================
        // Pointage : clic dans le nuage -> altitude, classe et coordonnées du point
        // ============================================================
        // Le pointage d'iTowns est limité à 65 535 points : on projette nous-mêmes à l'écran les points affichés
        // (ceux des nœuds visibles, classes et tranche d'altitude comprises) et on garde le plus proche de la caméra
        // parmi ceux à moins de _PICK_NEAR pixels du clic ; à défaut, parmi ceux à moins de _PICK_RADIUS pixels
        // (un point isolé au premier plan, à côté du curseur, ne l'emporte pas sur la surface visée).
        var _PICK_NEAR = 3, _PICK_RADIUS = 6;
        var _PICK_KEY = 'geo-lidar-hd-pick-crs';
        var _pickEl = null, _pickDown = null, _pickBall = null;

        function _readPickCrs() {
            var v = null;
            try { v = window.localStorage.getItem(_PICK_KEY); } catch (e) { /* stockage indisponible */ }
            return pickDefault(_CRS_LIST, v);
        }
        function _savePickCrs(v) {
            try { window.localStorage.setItem(_PICK_KEY, v); } catch (e) { /* stockage indisponible */ }
        }

        // Projection du « DXF 3D » du profil : mémorisée d'une session à l'autre, Lambert-93 par défaut.
        var _DXF_CRS_KEY = 'geo-lidar-hd-dxf-crs';
        function _readDxfCrs() {
            var v = null;
            try { v = window.localStorage.getItem(_DXF_CRS_KEY); } catch (e) { /* stockage indisponible */ }
            return pickDefault(_CRS_LIST, v);
        }
        function _saveDxfCrs(v) {
            try { window.localStorage.setItem(_DXF_CRS_KEY, v); } catch (e) { /* stockage indisponible */ }
        }

        function _pickPoint(clientX, clientY) {
            if (!_view || !_layer || !_currentScope || !_pickEl || _maqHidesPoints()) { return null; }
            var cam = _view.camera.camera3D, rect = _pickEl.getBoundingClientRect();
            var mx = clientX - rect.left, my = clientY - rect.top, W = rect.width, H = rect.height;
            cam.updateMatrixWorld();
            var vp = new Matrix4().copy(cam.matrixWorld).invert().premultiply(cam.projectionMatrix), mvp = new Matrix4();
            var vis = _classLut(_layer.material.classificationScheme).vis, st = _currentScope.style;
            var zLo = st.altOn ? Number(st.altMin) : -Infinity, zHi = st.altOn ? Number(st.altMax) : Infinity;
            var hagOn = !!st.hagOn, hFrom = Number(st.hagFrom), hTo = Number(st.hagTo);
            var R = _PICK_RADIUS, r2 = R * R, n2 = _PICK_NEAR * _PICK_NEAR, nodes = _shownNodes();
            var near = null, nearW = Infinity, far = null, farW = Infinity;
            for (var i = 0; i < nodes.length; i++) {
                var pts = nodes[i];
                if (!pts.visible || !pts.geometry || !pts.geometry.attributes.position) { continue; }
                var pos = pts.geometry.attributes.position, cls = pts.geometry.attributes.classification;
                var a = pos.array, ca = cls && cls.array, count = Math.min(pos.count, pts.geometry.drawRange.count);
                var m = pts.matrixWorld.elements, e = mvp.multiplyMatrices(vp, pts.matrixWorld).elements;
                for (var k = 0; k < count; k++) {
                    var px = a[3 * k], py = a[3 * k + 1], pz = a[3 * k + 2];
                    var w = e[3] * px + e[7] * py + e[11] * pz + e[15];
                    if (w <= 0 || (w >= nearW && w >= farW)) { continue; }   // derrière la caméra, ou plus loin que les candidats
                    var dx = ((e[0] * px + e[4] * py + e[8] * pz + e[12]) / w * 0.5 + 0.5) * W - mx;
                    if (dx > R || dx < -R) { continue; }
                    var dy = (0.5 - (e[1] * px + e[5] * py + e[9] * pz + e[13]) / w * 0.5) * H - my;
                    var d2 = dx * dx + dy * dy;
                    if (d2 > r2 || w >= (d2 <= n2 ? nearW : farW)) { continue; }
                    var c = ca ? ca[k] : 1, z = m[2] * px + m[6] * py + m[10] * pz + m[14];
                    if (!vis[c] || z < zLo || z > zHi) { continue; }
                    var wx = m[0] * px + m[4] * py + m[8] * pz + m[12], wy = m[1] * px + m[5] * py + m[9] * pz + m[13];
                    if (hagOn) {   // point masqué par le filtre de hauteur : on ne le pointe pas
                        var gz = _groundAt(wx, wy);
                        if (gz === gz && (z - gz < hFrom || z - gz > hTo)) { continue; }
                    }
                    var hit = { x: wx, y: wy, z: z, c: c };
                    if (d2 <= n2) { near = hit; nearW = w; } else { far = hit; farW = w; }
                }
            }
            return near || far;
        }

        // Nœuds d'octree présents dans la scène, toutes dalles confondues.
        function _shownNodes() {
            var all = [];
            _tiles.forEach(function (t) {
                var kids = t.layer.group ? t.layer.group.children : [];
                for (var i = 0; i < kids.length; i++) { kids[i].userData.tile = t; all.push(kids[i]); }
            });
            return all;
        }

        // Un clic (sans glisser) pointe ; un glisser reste une rotation ou un déplacement de la vue.
        function _onPickDown(e) {
            _pickDown = e.button === 0 && e.isPrimary !== false ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
        }
        function _onPickUp(e) {
            var d = _pickDown;
            _pickDown = null;
            if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || Date.now() - d.t > 600) { return; }
            if (_orbitPicking) { _orbitSetFromClick(e.clientX, e.clientY); return; }
            var hit = _pickPoint(e.clientX, e.clientY);
            if (hit) { _setPick(hit); }
        }
        function _bindPick(viewerDiv) {
            _pickEl = viewerDiv;
            viewerDiv.addEventListener('pointerdown', _onPickDown);
            viewerDiv.addEventListener('pointerup', _onPickUp);
        }
        function _unbindPick() {
            if (_pickEl) {
                _pickEl.removeEventListener('pointerdown', _onPickDown);
                _pickEl.removeEventListener('pointerup', _onPickUp);
            }
            _disposeObj(_pickBall);
            _pickEl = null; _pickDown = null; _pickBall = null;
        }

        // Taille apparente constante du repère (iTowns ne met pas à jour les matrices de la scène : on le fait ici).
        function _scalePick() {
            if (_orbitBall && _view) {
                _orbitBall.scale.setScalar(Math.max(0.1, _view.camera.camera3D.position.distanceTo(_orbitBall.position) * 0.006));
                _orbitBall.updateMatrixWorld(true);
            }
            if (!_pickBall || !_view) { return; }
            _pickBall.scale.setScalar(Math.max(0.1, _view.camera.camera3D.position.distanceTo(_pickBall.position) * 0.006));
            _pickBall.updateMatrixWorld(true);
        }

        function _setPick(hit) {
            if (!_view || !_currentScope) { return; }
            if (!_pickBall) {
                _pickBall = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true }));
                _pickBall.renderOrder = 1000;
                _view.scene.add(_pickBall);
            }
            _pickBall.position.set(hit.x, hit.y, hit.z);
            _scalePick();
            _view.notifyChange(_view.camera.camera3D);
            var o = window.ol && _ensureOlLayer();
            if (o) {
                _replaceFeature(o.source, 'pick',
                    new window.ol.Feature({ geometry: new window.ol.geom.Point(_toMapCoord([hit.x, hit.y], o.map)), kind: 'pick' }));
            }
            var sc = _currentScope;
            sc.$applyAsync(function () {
                sc.pick = { l93: [hit.x, hit.y], z: hit.z, cls: _CLASS_NAMES[hit.c] || ('Classe ' + hit.c), copied: false };
                _formatPick();
            });
        }

        // Coordonnées du point dans le système choisi (réglage crsList)
        function _formatPick() {
            var sc = _currentScope, pk = sc && sc.pick;
            if (!pk) { return; }
            var xy = sc.ui.pickCrs === 'EPSG:2154' ? pk.l93 : proj4('EPSG:2154', sc.ui.pickCrs, pk.l93);
            var digits = sc.ui.pickCrs === 'EPSG:4326' ? 8 : 2;   // 1e-8 ° ~ 1 mm
            pk.x = xy[0].toFixed(digits); pk.y = xy[1].toFixed(digits); pk.copied = false;
        }

        function _copyPick() {
            var sc = _currentScope, pk = sc && sc.pick;
            if (!pk || !navigator.clipboard || !navigator.clipboard.writeText) { return; }
            navigator.clipboard.writeText(pk.x + ' ' + pk.y + ' ' + pk.z.toFixed(2)).then(function () {
                sc.$applyAsync(function () { if (sc.pick === pk) { pk.copied = true; } });
            }, function (e) { console.warn('[geo-lidar-hd] copie impossible :', e); });
        }

        function _clearPick() {
            _disposeObj(_pickBall);
            _pickBall = null;
            _removeKind('pick');
            if (_view) { _view.notifyChange(_view.camera.camera3D); }
            if (_currentScope && _currentScope.pick) { var sc = _currentScope; sc.$applyAsync(function () { sc.pick = null; }); }
        }

        // ============================================================
        // Clic carte GEO -> dalle (WFS) -> nuage
        // ============================================================
        function _locateFromMapClick(coordinates, crs) {
            if (!coordinates || _mapClickBlocked()) { return; }   // clics du tracé de profil : pas de rechargement
            if (!crs || crs === 'EPSG:4326') { _loadAt(coordinates); return; }
            geoApplication.transform(coordinates, crs, 'EPSG:4326').subscribe(
                function (lonLat) { _loadAt(lonLat); },
                function (err) { console.error('[geo-lidar-hd] transform a échoué :', err); }
            );
        }

        function _loadAt(lonLat) {
            var seq = ++_loadSeq;
            _orbitClear();
            _setLoading('Recherche de la dalle LiDAR HD…');
            _placeMarker(lonLat);

            _fetchTile(lonLat).then(function (feature) {
                if (seq !== _loadSeq) { return null; }
                if (!feature) {
                    _setStatus('Aucune dalle LiDAR HD à cet endroit (couverture IGN incomplète).');
                    return null;
                }
                var tile = _tileFromFeature(feature);
                if (!tile.url) { _setStatus('Dalle sans fichier COPC (url_npl absent).'); return null; }
                _drawFootprint(feature.geometry);
                if (tile.id === _tileId && _layer) { _setStatus(null); return null; }   // même dalle
                _closeProfile();   // le tracé appartient à la dalle précédente
                _startOrtho(tile, seq);
                _startGround(tile, seq);
                _setLoading('Lecture de l\'en-tête du fichier COPC…');
                return _showTile(tile).then(function () { if (seq === _loadSeq) { _tileId = tile.id; _lastLonLat = lonLat; } });
            }).catch(function (err) {
                if (seq !== _loadSeq) { return; }
                console.error('[geo-lidar-hd] chargement impossible :', err);
                _setStatus('Chargement impossible (réseau ou limitation du serveur IGN). Recliquez sur la carte pour réessayer.');
            });
        }

        // Date WFS (« 2023-09-27Z ») -> « 2023-09-27 » ; vide si absente
        function _isoDate(v) { return (v || '').replace(/Z$/, ''); }

        // Date ISO -> « 27/09/2023 » pour l'affichage
        function _frDate(iso) {
            var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
            return m ? m[3] + '/' + m[2] + '/' + m[1] : (iso || '');
        }

        function _tileFromFeature(feature) {
            var p = feature.properties || {}, name = p.coordonnees_nw || feature.id;
            return {
                id:     feature.id,
                name:   name,
                url:    p.url_npl,
                points: p.nombre_points,
                date:   _isoDate(p.date_fin_acquisition),
                dateStart: _isoDate(p.date_debut_acquisition),
                dateEdition: _isoDate(p.date_edition),
                mission: p.code_mission || '',
                bbox:   _tileBbox(name),
                rasters: { mnt: p.url_mnt, mns: p.url_mns, mnh: p.url_mnh },
                geom:   feature.geometry
            };
        }

        // BBOX réduit au point cliqué. Le WFS IGN attend ici lon,lat suivi du CRS (vérifié : l'ordre
        // lat,lon renvoie 0 entité) ; on retente en lat,lon au cas où le serveur changerait de convention.
        function _fetchTile(lonLat) {
            function query(a, b) {
                var url = _wfsUrl + '?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0' +
                    '&TYPENAMES=' + encodeURIComponent(_WFS_TYPENAME) +
                    '&OUTPUTFORMAT=application%2Fjson&SRSNAME=EPSG:4326&COUNT=1' +
                    '&BBOX=' + a + ',' + b + ',' + a + ',' + b + ',EPSG:4326';
                return fetch(url).then(function (r) {
                    if (!r.ok) { throw new Error('WFS HTTP ' + r.status); }
                    return r.json();
                }).then(function (fc) { return (fc.features && fc.features[0]) || null; });
            }
            return query(lonLat[0], lonLat[1]).then(function (f) { return f || query(lonLat[1], lonLat[0]); });
        }

        // ============================================================
        // Marqueur + emprise de la dalle sur la carte GEO (calque OpenLayers dédié)
        // ============================================================
        function _getOlMap() {
            try { return $injector.get('acfMapService').getMapViewImmediate().getNativeMap(); }
            catch (e) { console.warn('[geo-lidar-hd] carte GEO introuvable :', e); return null; }
        }

        function _ensureOlLayer() {
            var map = _getOlMap();
            if (!map || !window.ol) { return null; }
            if (!_olLayer) {
                _olLayer = new window.ol.layer.Vector({
                    source: new window.ol.source.Vector(),
                    zIndex: 1000,
                    style: function (f) {
                        var ol = window.ol, kind = f.get('kind');
                        var dot = function (color, radius) {
                            return new ol.style.Circle({ radius: radius, fill: new ol.style.Fill({ color: color }),
                                                         stroke: new ol.style.Stroke({ color: '#fff', width: 2 }) });
                        };
                        if (kind === 'marker') { return new ol.style.Style({ image: dot('#e5484d', 7) }); }
                        if (kind === 'probe')  { return new ol.style.Style({ image: dot('#2f81f7', 6), zIndex: 10 }); }
                        if (kind === 'pick')   { return new ol.style.Style({ image: dot('#ffb020', 6), zIndex: 11 }); }
                        if (kind === 'band') {
                            return new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(47,129,247,0.14)' }),
                                                        stroke: new ol.style.Stroke({ color: 'rgba(47,129,247,0.5)', width: 1 }) });
                        }
                        if (kind === 'zone') {
                            return [
                                new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#fff', width: 4 }) }),
                                new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(255,176,32,0.14)' }),
                                                     stroke: new ol.style.Stroke({ color: '#ffb020', width: 2 }) })
                            ];
                        }
                        if (kind === 'around') {
                            return new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(229,72,77,0.7)', width: 1, lineDash: [4, 5] }) });
                        }
                        if (kind === 'profile') {
                            return [
                                new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#fff', width: 5 }) }),
                                new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#2f81f7', width: 3 }) }),
                                new ol.style.Style({
                                    geometry: function (g) { return new ol.geom.MultiPoint(g.getGeometry().getCoordinates()); },
                                    image: dot('#2f81f7', 5)
                                })
                            ];
                        }
                        return new ol.style.Style({
                            stroke: new ol.style.Stroke({ color: '#e5484d', width: 2, lineDash: [8, 6] }),
                            fill:   new ol.style.Fill({ color: 'rgba(229,72,77,0.08)' }) });
                    }
                });
                map.addLayer(_olLayer);
            }
            return { map: map, source: _olLayer.getSource() };
        }

        function _replaceFeature(source, kind, feature) {
            source.getFeatures().filter(function (f) { return f.get('kind') === kind; })
                .forEach(function (f) { source.removeFeature(f); });
            source.addFeature(feature);
        }

        function _placeMarker(lonLat) {
            var o = _ensureOlLayer();
            if (!o) { return; }
            var ol = window.ol;
            var geom = new ol.geom.Point(lonLat).transform('EPSG:4326', o.map.getView().getProjection());
            _replaceFeature(o.source, 'marker', new ol.Feature({ geometry: geom, kind: 'marker' }));
        }

        function _drawFootprint(geometry) {
            var o = _ensureOlLayer();
            if (!o || !geometry) { return; }
            var ol = window.ol;
            var geom = new ol.format.GeoJSON().readGeometry(geometry)
                .transform('EPSG:4326', o.map.getView().getProjection());
            _replaceFeature(o.source, 'footprint', new ol.Feature({ geometry: geom, kind: 'footprint' }));
        }

        function _drawAround(list) {
            var o = _ensureOlLayer();
            if (!o) { return; }
            var ol = window.ol, fmt = new ol.format.GeoJSON();
            _removeKind('around');
            list.forEach(function (t) {
                if (!t.geom) { return; }
                var geom = fmt.readGeometry(t.geom).transform('EPSG:4326', o.map.getView().getProjection());
                o.source.addFeature(new ol.Feature({ geometry: geom, kind: 'around' }));
            });
        }

        function _clearMapOverlay() {
            var map = _olLayer && _getOlMap();
            if (map) { map.removeLayer(_olLayer); }
            _olLayer = null;
        }

        // ============================================================
        // Profil en travers — aperçu sur les points déjà chargés dans la vue 3D
        // ============================================================
        // Le tracé se fait sur la carte GEO (ol.interaction.Draw, deux clics). Le couloir (± halfWidth autour
        // de la ligne) est extrait des nœuds d'octree actuellement affichés par iTowns, donc à la densité du
        // niveau de détail courant : c'est un aperçu, pas un relevé.
        var _PROFILE_MAX_POINTS = 1500000;
        var _drawInteraction = null;
        var _suppressMapClickUntil = 0;   // le 'singleclick' du dernier clic de tracé arrive ~250 ms après drawend
        var _prof        = null;          // { A, B, L, ... } : ligne en Lambert-93 puis points du couloir
        var _profCanvas  = null;
        var _profBase    = null;          // graphique sans curseur, recopié à chaque mouvement de souris
        var _profMap     = null;
        var _profTimer   = null;
        var _profHandlers = null;

        function _mapClickBlocked() { return !!_drawInteraction || !!_mntDraw || Date.now() < _suppressMapClickUntil; }

        function _toMapCoord(xy, map) {
            var ll = proj4('EPSG:2154', 'EPSG:4326', xy);
            return window.ol.proj.transform(ll, 'EPSG:4326', map.getView().getProjection());
        }

        function _setProfileState(patch) {
            $timeout(function () {
                if (_currentScope) { angular.extend(_currentScope.profile, patch); }
            });
        }

        function _startProfileDraw() {
            var map = _getOlMap();
            if (!map || !window.ol || !_layer) { return; }
            _cancelProfileDraw();
            var ol = window.ol;
            var draw = new ol.interaction.Draw({
                type: 'LineString', minPoints: 2,   // un clic par nœud ; double-clic (ou Entrée) pour terminer
                style: [
                    new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#fff', width: 5 }) }),
                    new ol.style.Style({
                        stroke: new ol.style.Stroke({ color: '#2f81f7', width: 3, lineDash: [8, 6] }),
                        image:  new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#2f81f7' }),
                                                      stroke: new ol.style.Stroke({ color: '#fff', width: 2 }) })
                    })
                ]
            });
            draw.on('drawend', function (e) {
                _suppressMapClickUntil = Date.now() + 700;
                var coords = e.feature.getGeometry().getCoordinates();
                _drawReturn = null;
                setTimeout(_cancelProfileDraw, 0);   // retirer l'interaction hors de son propre gestionnaire
                _setProfileLine(coords, map);
            });
            map.addInteraction(draw);
            _drawInteraction = draw;
            _profMap = map;
            _syncModify();   // pas d'ajustement de l'ancien tracé pendant qu'on en dessine un autre
            // Entrée termine le tracé (avec au moins 2 nœuds), Échap l'abandonne.
            _drawKeyHandler = function (e) {
                if (_tour) { return; }   // la visite guidée garde le clavier : Échap ne ferme qu'elle
                if (e.key === 'Escape') { _abortProfileDraw(); }
                else if (e.key === 'Enter') { try { draw.finishDrawing(); } catch (err) { /* tracé incomplet */ } }
            };
            document.addEventListener('keydown', _drawKeyHandler);
            _setProfileState({ drawing: true });
        }

        var _drawKeyHandler = null;
        function _cancelProfileDraw() {
            if (_drawKeyHandler) { document.removeEventListener('keydown', _drawKeyHandler); _drawKeyHandler = null; }
            if (_drawInteraction) {
                try { _profMap.removeInteraction(_drawInteraction); } catch (e) { /* carte déjà détruite */ }
                _drawInteraction = null;
            }
            _syncModify();
            _setProfileState({ drawing: false });
        }

        // Abandon du tracé par l'utilisateur : retour à l'outil Terrain s'il vient d'être quitté pour ce tracé.
        function _abortProfileDraw() {
            if (!_drawInteraction) { return; }
            _cancelProfileDraw();
            var back = _drawReturn;
            _drawReturn = null;
            if (back === 'mnt') { _restoreMnt(); }
        }

        // Mémoire des outils, pendant la session de la page : passer de Profil à Terrain, ou l'inverse, garde le tracé
        // de l'outil quitté, que son bouton restaure. La croix du panneau, elle, l'efface (_closeProfile, _closeMnt).
        var _profMemo = null;     // coordonnées du tracé, dans la projection de la carte
        var _mntMemo = null;      // { feature, mnt, zone }
        var _drawReturn = null;   // outil à rétablir si le tracé en cours est abandonné : 'profile' ou 'mnt'

        function _kindFeature(kind) {
            return _olLayer ? _olLayer.getSource().getFeatures().filter(function (f) { return f.get('kind') === kind; })[0] || null : null;
        }

        function _suspendProfile() {
            var f = _kindFeature('profile');
            var coords = f ? f.getGeometry().getCoordinates() : null;
            _closeProfile();
            _profMemo = coords;
            return !!coords;
        }

        // Le profil est recalculé, sans déplacer la vue 3D. Le zoom du graphique et les mesures ne sont pas conservés.
        function _restoreProfile() {
            var coords = _profMemo, map = _getOlMap();
            _profMemo = null;
            return !!(coords && map && _setProfileLine(coords, map, true));
        }

        function _suspendMnt() {
            var f = _kindFeature('zone'), zone = _currentScope && _currentScope.mnt.zone;
            var memo = f && zone ? { feature: f, mnt: _mnt, zone: zone } : null;
            _closeMnt();
            _mntMemo = memo;
            return !!memo;
        }

        function _restoreMnt() {
            var memo = _mntMemo, o = memo && _ensureOlLayer();
            _mntMemo = null;
            if (!o) { return false; }
            _replaceFeature(o.source, 'zone', memo.feature);
            if (_currentScope) { _currentScope.mnt.open = true; }
            if (memo.mnt) {
                _mnt = memo.mnt;
                _setMnt({ open: true, drawing: false, state: 'ready', msg: '', zone: memo.zone });
            } else {   // quitté pendant la recherche des dalles : on la relance
                _setMnt({ open: true, drawing: false });
                _prepareMnt(memo.feature.getGeometry().clone().transform(o.map.getView().getProjection(), 'EPSG:4326').getCoordinates()[0]);
            }
            _syncMntModify();
            return true;
        }

        // Ajustement du tracé : ses sommets se déplacent sur la carte GEO (ol.interaction.Modify ; un glisser sur
        // un segment y insère un sommet, Alt + clic en supprime un). Le profil est recalculé au relâcher.
        var _modify = null;   // { map, interaction, feature }
        function _syncModify() {
            _syncMntModify();   // l'ajustement de l'emprise se met en pause pendant un tracé de profil
            var feature = null;
            if (_prof && !_drawInteraction && !_mntDraw && _olLayer) {
                feature = _olLayer.getSource().getFeatures().filter(function (f) { return f.get('kind') === 'profile'; })[0] || null;
            }
            if (_modify && _modify.feature === feature) { return; }
            if (_modify) {
                try { _modify.map.removeInteraction(_modify.interaction); } catch (e) { /* carte déjà détruite */ }
                _modify = null;
            }
            var map = feature && _getOlMap(), ol = window.ol;
            if (!map || !ol || !ol.interaction.Modify) { return; }
            var mod = new ol.interaction.Modify({ features: new ol.Collection([feature]) });
            var before = JSON.stringify(feature.getGeometry().getCoordinates());
            mod.on('modifystart', function () { ['band', 'probe'].forEach(_removeKind); });
            mod.on('modifyend', function () {
                _suppressMapClickUntil = Date.now() + 700;
                var coords = feature.getGeometry().getCoordinates();
                if (JSON.stringify(coords) === before) { _drawBand(); return; }   // simple clic sur un sommet
                setTimeout(function () {   // hors du gestionnaire : le tracé (et cette interaction) sont remplacés
                    if (!_modify || _modify.feature !== feature || !_prof) { return; }
                    if (!_setProfileLine(coords, map, true)) {   // tracé devenu trop court : retour au précédent
                        feature.getGeometry().setCoordinates(_prof.P.map(function (q) { return _toMapCoord(q, map); }));
                        _drawBand();
                    }
                }, 0);
            });
            map.addInteraction(mod);
            _modify = { map: map, interaction: mod, feature: feature };
        }

        // keepView : ajustement d'un tracé existant (la caméra 3D n'est pas recadrée). Renvoie false si le tracé est refusé.
        function _setProfileLine(coords, map, keepView) {
            var ol = window.ol, projCode = map.getView().getProjection();
            var pts;
            try {
                pts = coords.map(function (c) {
                    return proj4('EPSG:4326', 'EPSG:2154', ol.proj.transform(c, projCode, 'EPSG:4326'));
                });
            } catch (e) {
                console.error('[geo-lidar-hd] conversion du tracé impossible :', e);
                return false;
            }
            // nœuds confondus (double-clic) écartés ; il faut au moins deux nœuds distincts
            var P = [], keep = [];
            pts.forEach(function (q, i) {
                if (!P.length || Math.hypot(q[0] - P[P.length - 1][0], q[1] - P[P.length - 1][1]) >= 0.5) { P.push(q); keep.push(coords[i]); }
            });
            if (P.length < 2) { return false; }
            var segs = [], L = 0;
            for (var i = 0; i < P.length - 1; i++) {
                var len = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
                segs.push({ x: P[i][0], y: P[i][1], ux: (P[i + 1][0] - P[i][0]) / len, uy: (P[i + 1][1] - P[i][1]) / len, len: len, cum: L });
                L += len;
            }
            if (!(L >= 1)) { return false; }
            coords = keep;
            _prof = { P: P, segs: segs, L: L, n: 0 };
            var o = _ensureOlLayer();
            if (o) {
                _replaceFeature(o.source, 'profile',
                    new ol.Feature({ geometry: new ol.geom.LineString(coords), kind: 'profile' }));
                _removeKind('probe');
            }
            _syncModify();
            _drawBand();
            _setProfileState({ open: true, hover: null, info: null, zoomed: false });
            if (!keepView) { _frameProfile(); }
            $timeout(_computeProfile, 30);   // laisse le panneau s'afficher : le canvas doit avoir une taille
            _ensureProfileRasters();
            _loadProfileCadastre();
            return true;
        }

        // Bords gauche et droit du couloir (± w autour du tracé), un point par sommet, en Lambert-93.
        function _bandSides(w) {
            var P = _prof.P, segs = _prof.segs, left = [], right = [];
            for (var i = 0; i < P.length; i++) {
                var n1 = segs[Math.max(0, i - 1)], n2 = segs[Math.min(segs.length - 1, i)];
                var ax = -n1.uy, ay = n1.ux, bx = -n2.uy, by = n2.ux;               // normales des deux segments voisins
                var k = Math.max(0.3, 1 + ax * bx + ay * by);                       // onglet limité dans les angles aigus
                var ox = (ax + bx) / k * w, oy = (ay + by) / k * w;
                left.push([P[i][0] + ox, P[i][1] + oy]);
                right.push([P[i][0] - ox, P[i][1] - oy]);
            }
            return { left: left, right: right };
        }

        // Bande de ± halfWidth autour du tracé, pour voir sur la carte ce que le profil englobe.
        function _drawBand() {
            var o = _prof && _ensureOlLayer();
            if (!o || !_currentScope) { return; }
            var b = _bandSides(Number(_currentScope.profile.halfWidth) || 5);
            var ring = b.left.concat(b.right.reverse()).map(function (q) { return _toMapCoord(q, o.map); });
            ring.push(ring[0]);
            _replaceFeature(o.source, 'band',
                new window.ol.Feature({ geometry: new window.ol.geom.Polygon([ring]), kind: 'band' }));
        }

        function _removeKind(kind) {
            if (!_olLayer) { return; }
            var src = _olLayer.getSource();
            src.getFeatures().filter(function (f) { return f.get('kind') === kind; })
                .forEach(function (f) { src.removeFeature(f); });
        }

        function _closeProfile() {
            if (_profTimer) { clearTimeout(_profTimer); _profTimer = null; }
            _stopExact(true);
            _cancelProfileDraw();
            _dispose3dProfile();
            _prof = null;
            _profMemo = null;
            _syncModify();
            ['profile', 'band', 'probe'].forEach(_removeKind);
            _setProfileState({ open: false, info: null, hover: null, measure: null, measuring: false, zoomed: false, cadMsg: '' });
        }

        function _refreshProfileSoon() {
            if (!_prof) { return; }
            if (_profTimer) { clearTimeout(_profTimer); }
            _profTimer = setTimeout(function () { _profTimer = null; _computeProfile(); }, 150);   // puis exact, après 300 ms de plus
        }

        // LUT des 256 classes : couleur (celle du panneau de style) et visibilité (cases « Classes visibles »).
        function _classLut(scheme) {
            var lut = { rgb: new Uint8Array(768), vis: new Uint8Array(256) };
            for (var i = 0; i < 256; i++) {
                var e = scheme[i] || scheme.DEFAULT;
                var hex = e && e.color ? e.color.getHex() : 0x808080;
                lut.rgb[3 * i] = hex >> 16 & 255; lut.rgb[3 * i + 1] = hex >> 8 & 255; lut.rgb[3 * i + 2] = hex & 255;
                lut.vis[i] = e && e.visible === false ? 0 : 1;
            }
            return lut;
        }

        // Pixels de l'orthophoto, ramenés à 2048 px au plus (≈ 0,5 m/px : suffisant pour un profil, 16 Mo au lieu de 64).
        function _orthoPixels(tile) {
            if (!tile || !tile.orthoImg || !tile.bbox) { return null; }
            if (tile.orthoPix && tile.orthoPix.img === tile.orthoImg) { return tile.orthoPix; }
            try {
                var size = Math.min(2048, tile.orthoImg.naturalWidth || 2048);
                var c = document.createElement('canvas');
                c.width = c.height = size;
                var g = c.getContext('2d', { willReadFrequently: true });
                g.drawImage(tile.orthoImg, 0, 0, size, size);
                tile.orthoPix = { img: tile.orthoImg, size: size, data: g.getImageData(0, 0, size, size).data };
                return tile.orthoPix;
            } catch (e) {
                console.warn('[geo-lidar-hd] orthophoto illisible pour le profil :', e);
                return null;
            }
        }

        // Récolte des points du couloir : abscisse curviligne s, altitude z, classe, couleur d'orthophoto.
        // Toutes les classes sont conservées ; la visibilité (cases « Classes visibles ») s'applique au dessin.
        function _newOut() { return { S: [], Z: [], C: [], RGB: [], X: [], Y: [], truncated: false }; }

        function _corridorCtx(sc) {
            var half = Number(sc.profile.halfWidth) || 5;
            var ctx = { segs: _prof.segs, nseg: _prof.segs.length, half: half, half2: half * half,
                        rgb: !!_orthoPixels(_main),   // couleurs d'orthophoto : chaque point prend celle de sa dalle
                        minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
            _prof.P.forEach(function (q) {
                ctx.minX = Math.min(ctx.minX, q[0] - half); ctx.maxX = Math.max(ctx.maxX, q[0] + half);
                ctx.minY = Math.min(ctx.minY, q[1] - half); ctx.maxY = Math.max(ctx.maxY, q[1] + half);
            });
            return ctx;
        }

        // L'emprise de la dalle touche-t-elle le rectangle englobant du tracé (élargi du couloir) ?
        function _tileHitsProfile(tile) {
            var bb = tile.bbox, half = (_currentScope && Number(_currentScope.profile.halfWidth)) || 5, p = _prof;
            if (!bb || !p) { return false; }
            return p.P.some(function (q, i) {
                var r = p.P[Math.max(0, i - 1)];
                return Math.max(q[0], r[0]) + half >= bb[0] && Math.min(q[0], r[0]) - half <= bb[2] &&
                       Math.max(q[1], r[1]) + half >= bb[1] && Math.min(q[1], r[1]) - half <= bb[3];
            });
        }

        // Le segment [(x,y), + len·(ux,uy)] traverse-t-il le rectangle ? (méthode des dalles)
        function _segHitsBox(sg, x0, y0, x1, y1) {
            var tmin = 0, tmax = sg.len, t1, t2, t;
            if (Math.abs(sg.ux) < 1e-12) { if (sg.x < x0 || sg.x > x1) { return false; } }
            else {
                t1 = (x0 - sg.x) / sg.ux; t2 = (x1 - sg.x) / sg.ux;
                if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
                tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
                if (tmin > tmax) { return false; }
            }
            if (Math.abs(sg.uy) < 1e-12) { if (sg.y < y0 || sg.y > y1) { return false; } }
            else {
                t1 = (y0 - sg.y) / sg.uy; t2 = (y1 - sg.y) / sg.uy;
                if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
                tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
                if (tmin > tmax) { return false; }
            }
            return true;
        }

        // Le nœud d'octree (emprise Lambert-93) touche-t-il le couloir ? Hauteur ignorée : le couloir est vertical.
        function _nodeHitsCorridor(node, ctx) {
            var b = node.bbox, h = ctx.half;
            for (var g = 0; g < ctx.nseg; g++) {
                if (_segHitsBox(ctx.segs[g], b.min.x - h, b.min.y - h, b.max.x + h, b.max.y + h)) { return true; }
            }
            return false;
        }

        // Ajoute à `out` les points d'un tableau de positions locales qui tombent dans le couloir.
        // m : matrice 4×4 (colonnes) local → Lambert-93 ; tile : dalle des points (orthophoto).
        function _scanPoints(ctx, out, pos, cls, count, m, tile) {
            var segs = ctx.segs, nseg = ctx.nseg, ortho = ctx.rgb ? _orthoPixels(tile) : null, bb = tile && tile.bbox;
            for (var k = 0; k < count; k++) {
                var px = pos[3 * k], py = pos[3 * k + 1], pz = pos[3 * k + 2];
                var x = m[0] * px + m[4] * py + m[8] * pz + m[12];
                var y = m[1] * px + m[5] * py + m[9] * pz + m[13];
                if (x < ctx.minX || x > ctx.maxX || y < ctx.minY || y > ctx.maxY) { continue; }
                // segment le plus proche (un point proche d'un coude n'est compté qu'une fois)
                var bestG = -1, bestD = Infinity, bestS = 0, bestT = 0;
                for (var g = 0; g < nseg; g++) {
                    var sg = segs[g], dx = x - sg.x, dy = y - sg.y;
                    var t = dx * sg.ux + dy * sg.uy, tc = t < 0 ? 0 : (t > sg.len ? sg.len : t);
                    var ex = dx - sg.ux * tc, ey = dy - sg.uy * tc, dd = ex * ex + ey * ey;
                    if (dd < bestD) { bestD = dd; bestG = g; bestS = sg.cum + tc; bestT = t; }
                }
                if (bestD > ctx.half2) { continue; }
                if ((bestG === 0 && bestT < 0) || (bestG === nseg - 1 && bestT > segs[nseg - 1].len)) { continue; }   // pas de bouts arrondis aux extrémités
                out.S.push(bestS); out.Z.push(m[2] * px + m[6] * py + m[10] * pz + m[14]); out.C.push(cls ? cls[k] : 1); out.X.push(x); out.Y.push(y);
                if (ctx.rgb && !ortho) { out.RGB.push(150, 150, 150); }   // orthophoto de cette dalle pas encore arrivée
                else if (ortho) {
                    var u = Math.min(ortho.size - 1, Math.max(0, Math.floor((x - bb[0]) / (bb[2] - bb[0]) * ortho.size)));
                    var v = Math.min(ortho.size - 1, Math.max(0, Math.floor((bb[3] - y) / (bb[3] - bb[1]) * ortho.size)));
                    var o = 4 * (v * ortho.size + u);
                    out.RGB.push(ortho.data[o], ortho.data[o + 1], ortho.data[o + 2]);
                }
                if (out.S.length >= _PROFILE_MAX_POINTS) { out.truncated = true; return; }
            }
        }

        // Publie les points récoltés dans _prof (mode : 'preview' | 'exact') et redessine.
        function _setProfileData(out, mode) {
            var p = _prof;
            if (!p) { return; }
            p.n = out.S.length;
            p.s = Float32Array.from(out.S);
            p.z = Float32Array.from(out.Z);
            p.c = Uint8Array.from(out.C);
            p.rgb = out.RGB.length ? Uint8Array.from(out.RGB) : null;
            p.x = Float64Array.from(out.X);   // Lambert-93 : double précision (float32 donnerait ~6 cm d'erreur)
            p.y = Float64Array.from(out.Y);
            p.mode = mode;
            p.truncated = out.truncated;
            _renderProfile();
        }

        // Aperçu : points déjà affichés par iTowns (niveau de détail courant), puis lancement de la version exacte.
        function _computeProfile() {
            var sc = _currentScope;
            if (!sc || !_prof || !_layer) { return; }
            _stopExact(true);
            _prof.m = null;
            _clear3dMeasure();
            var ctx = _corridorCtx(sc), out = _newOut();
            var nodes = _shownNodes();
            for (var i = 0; i < nodes.length && !out.truncated; i++) {
                var pts = nodes[i];
                if (!pts.visible || !pts.geometry || !pts.geometry.attributes.position) { continue; }
                var tb = pts.tightbbox;   // emprise du nœud (Lambert-93) : écarte vite ceux hors du couloir
                if (tb && (tb.max.x < ctx.minX || tb.min.x > ctx.maxX || tb.max.y < ctx.minY || tb.min.y > ctx.maxY)) { continue; }
                var cls = pts.geometry.attributes.classification;
                _scanPoints(ctx, out, pts.geometry.attributes.position.array, cls && cls.array,
                    Math.min(pts.geometry.attributes.position.count, pts.geometry.drawRange.count), pts.matrixWorld.elements,
                    pts.userData.tile);
            }
            _setProfileData(out, 'preview');
            _prof.nPreview = _prof.n;
            _setProfileState({ measure: null });
            _startExactSoon(300);
        }

        // ------------------------------------------------------------
        // Version exacte : relecture des nœuds COPC qui touchent le couloir (à pleine densité)
        // ------------------------------------------------------------
        var _exactToken = 0, _exactTimer = null, _EXACT_PARALLEL = 4;

        function _startExactSoon(delay) {
            if (_exactTimer) { clearTimeout(_exactTimer); }
            _exactTimer = setTimeout(function () { _exactTimer = null; _startExact(); }, delay);
        }

        // arrêt : abandonne la lecture en cours (les nœuds déjà reçus restent dans le cache de plages)
        function _stopExact(silent) {
            if (_exactTimer) { clearTimeout(_exactTimer); _exactTimer = null; }
            var was = _exactRunning;
            _exactToken++;
            _exactRunning = false;
            if (!silent && was) { _setProfileState({ exact: { state: 'stopped', pct: 0 } }); }
            else if (silent) { _setProfileState({ exact: { state: 'idle', pct: 0 } }); }
        }
        var _exactRunning = false;

        // Évite que iTowns et le profil chargent en même temps la même page de hiérarchie (enfants créés en double).
        function _patchOctreeLoad(root) {
            var proto = Object.getPrototypeOf(root);
            if (!proto || proto.__geoLidarPatched || typeof proto.loadOctree !== 'function') { return; }
            var orig = proto.loadOctree;
            proto.loadOctree = function () {
                var self = this;
                if (!self.__octreeP) { self.__octreeP = orig.call(self).catch(function (e) { self.__octreeP = null; throw e; }); }
                return self.__octreeP;
            };
            proto.__geoLidarPatched = true;
        }

        function _nodePoints(node) {
            // nœud déjà affiché par iTowns : on réutilise ses points, sinon lecture + décodage (sans l'ajouter à la scène)
            var obj = node.obj;
            if (obj && obj.geometry && obj.geometry.attributes.position) {
                var cls = obj.geometry.attributes.classification;
                return Promise.resolve({ pos: obj.geometry.attributes.position.array, cls: cls && cls.array,
                                         count: obj.geometry.attributes.position.count, m: obj.matrixWorld.elements });
            }
            return node.load().then(function (geo) {
                var o = geo.userData.origin || node.bbox.min, cls = geo.attributes.classification;
                return { pos: geo.attributes.position.array, cls: cls && cls.array, count: geo.attributes.position.count,
                         m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, o.x, o.y, o.z, 1] };
            });
        }

        function _startExact() {
            var sc = _currentScope, main = _main, p = _prof;
            if (!sc || !main || !p || !_view) { return; }
            var token = ++_exactToken;
            _exactRunning = true;
            var ctx = _corridorCtx(sc), out = _newOut();
            // Une racine d'octree par dalle traversée ; chaque nœud garde sa dalle (orthophoto des points).
            var queue = [];
            _tiles.forEach(function (t) {
                if (t.layer.root && _tileHitsProfile(t)) { t.layer.root.__tile = t; queue.push(t.layer.root); }
            });
            var active = 0, done = 0, total = Math.max(1, queue.length), failed = 0, lastPaint = Date.now(), finished = false;
            function alive() { return token === _exactToken && _prof === p && _main === main; }
            function progress(state) {
                _setProfileState({ exact: { state: state, pct: Math.min(99, Math.round(100 * done / total)), failed: failed } });
            }
            function process(node) {
                return Promise.resolve(node.octreeIsLoaded ? null : node.loadOctree()).then(function () {
                    if (!alive()) { return; }
                    node.children.forEach(function (ch) {
                        if (_nodeHitsCorridor(ch, ctx)) { ch.__tile = node.__tile; queue.push(ch); total++; }
                    });
                    if (!(node.numPoints > 0) || !_nodeHitsCorridor(node, ctx)) { return; }
                    return _nodePoints(node).then(function (d) {
                        if (alive()) { _scanPoints(ctx, out, d.pos, d.cls, d.count, d.m, node.__tile); }
                    });
                });
            }
            function after(err) {
                active--; done++;
                if (err) { failed++; console.warn('[geo-lidar-hd] nœud COPC non lu pour le profil :', err); }
                if (!alive()) { return; }
                if (out.S.length > (p.nPreview || 0) && Date.now() - lastPaint > 700) {   // aperçu affiné au fil de l'eau
                    lastPaint = Date.now();
                    _setProfileData(out, 'refining');
                }
                pump();
            }
            function pump() {
                if (!alive()) { return; }
                while (active < _EXACT_PARALLEL && queue.length && !out.truncated) {
                    active++;
                    process(queue.shift()).then(function () { after(null); }, after);
                }
                if (!finished && active === 0 && (!queue.length || out.truncated)) {
                    finished = true;
                    _exactRunning = false;
                    _setProfileData(out, 'exact');
                    _setProfileState({ exact: { state: failed ? 'partial' : 'done', pct: 100, failed: failed } });
                } else if (!finished) { progress('running'); }
            }
            progress('running');
            pump();
        }

        function _niceStep(range, target) {
            var raw = range / Math.max(1, target), pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
            return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
        }

        function _elevationColor(t) {   // bleu → vert → jaune → rouge
            var h = (1 - Math.max(0, Math.min(1, t))) * 240 / 60, i = Math.floor(h), f = h - i, q = Math.round(255 * f);
            switch (i) {
                case 4: return [0, q, 255];
                case 3: return [0, 255, 255 - q];
                case 2: return [q, 255, 0];
                case 1: return [255, 255 - q, 0];
                default: return [255, 0, 0];
            }
        }

        // Pente du terrain entre deux sommets consécutifs du tracé. Altitude du sol à un sommet : médiane des points
        // classés « sol » (classe 2) du couloir à moins de 25 cm du sommet le long du tracé (fenêtre élargie jusqu'à
        // 4 m tant qu'il y en a moins de 3) ; sans sol à proximité (eau, bâti, couloir très fin), pas de pente pour les segments voisins.
        function _computeSlopes(p) {
            var nodes = p.segs.map(function (sg) { return { s: sg.cum, d: [], z: [], zg: null }; });
            nodes.push({ s: p.L, d: [], z: [], zg: null });
            for (var i = 0; i < p.n; i++) {
                if (p.c[i] !== 2) { continue; }
                for (var k = 0; k < nodes.length; k++) {
                    var dd = Math.abs(p.s[i] - nodes[k].s);
                    if (dd <= 4) { nodes[k].d.push(dd); nodes[k].z.push(p.z[i]); }
                }
            }
            nodes.forEach(function (nd) {
                [0.25, 0.5, 1, 2, 4].some(function (r) {
                    var zs = [];
                    for (var j = 0; j < nd.d.length; j++) { if (nd.d[j] <= r) { zs.push(nd.z[j]); } }
                    if (zs.length < 3) { return false; }
                    zs.sort(function (a, b) { return a - b; });
                    nd.zg = zs[zs.length >> 1];
                    return true;
                });
            });
            p.nodes = nodes.map(function (nd) { return { s: nd.s, z: nd.zg }; });
            p.slopes = p.segs.map(function (sg, g) {
                var a = nodes[g].zg, b = nodes[g + 1].zg;
                return a === null || b === null ? null : { dz: b - a, pct: 100 * (b - a) / sg.len };
            });
        }

        // Courbes du sol (MNT) et de la surface (MNS) le long du tracé : un échantillon tous les 25 cm au plus (8000 au
        // total), calculées à la demande et recalculées quand un raster arrive (p.curves remis à null).
        function _profCurves(p) {
            if (p.curves) { return p.curves; }
            var L = p.L, step = Math.max(0.25, L / 8000), n = Math.floor(L / step) + 1;
            var zg = new Float32Array(n), zs = new Float32Array(n), lo = Infinity, hi = -Infinity, hasG = false, hasS = false;
            for (var i = 0; i < n; i++) {
                var q = _pointAt(Math.min(L, i * step)), a = _rasterAt('mnt', q[0], q[1]), b = _rasterAt('mns', q[0], q[1]);
                zg[i] = a; zs[i] = b;
                if (a === a) { hasG = true; lo = Math.min(lo, a); hi = Math.max(hi, a); }
                if (b === b) { hasS = true; lo = Math.min(lo, b); hi = Math.max(hi, b); }
            }
            return (p.curves = { step: step, n: n, zg: zg, zs: zs, lo: lo, hi: hi, hasG: hasG, hasS: hasS });
        }

        // Sol, surface et hauteur (surface - sol) à l'abscisse s ; null pour une valeur inconnue.
        function _curveAt(p, s) {
            var c = _profCurves(p), i = Math.max(0, Math.min(c.n - 1, Math.round(s / c.step)));
            var g = c.zg[i], f = c.zs[i];
            return { s: s, zg: g === g ? g : null, zs: f === f ? f : null, hs: g === g && f === f ? f - g : null };
        }

        function _curvesOn() { return !!(_currentScope && _currentScope.profile.curves); }

        function _slopeLabel(sl) { return (sl.pct > 0 ? '+' : '') + sl.pct.toFixed(1).replace('.', ',') + ' %'; }

        // Statistiques sur les points affichés, pentes, plan de coupe 3D, puis dessin du graphique.
        function _renderProfile() {
            var p = _prof;
            if (!_profCanvas || !p || !_currentScope || !p.s || !_layer) { return; }
            // statistiques sur les classes visibles (cases « Classes visibles » du panneau Style)
            p.lut = _classLut(_layer.material.classificationScheme);
            var stl = _currentScope.style;
            p.zf = stl.altOn ? [Number(stl.altMin), Number(stl.altMax)] : null;   // tranche d'altitude du panneau Style
            p.hf = stl.hagOn ? [Number(stl.hagFrom), Number(stl.hagTo)] : null;   // tranche de hauteur au-dessus du sol
            var nv = 0, zmn = Infinity, zmx = -Infinity;
            for (var q0 = 0; q0 < p.n; q0++) {
                if (!_pointShown(p, q0)) { continue; }
                nv++; if (p.z[q0] < zmn) { zmn = p.z[q0]; } if (p.z[q0] > zmx) { zmx = p.z[q0]; }
            }
            p.nv = nv; p.zmin = nv ? zmn : 0; p.zmax = nv ? zmx : 1;
            if (_curvesOn()) {   // l'échelle englobe aussi les courbes (la surface dépasse souvent les points d'un aperçu)
                var cu = _profCurves(p);
                if (isFinite(cu.lo)) { p.zmin = nv ? Math.min(zmn, cu.lo) : cu.lo; p.zmax = nv ? Math.max(zmx, cu.hi) : cu.hi; }
            }
            _computeSlopes(p);
            _update3dProfile();
            _setProfileState({ info: { count: nv, length: p.L, zmin: p.zmin, zmax: p.zmax, truncated: p.truncated } });
            _drawProfile();
        }

        // Dessine le graphique dans _profBase (axes + points) puis l'affiche ; _prof.plot garde la mise à l'échelle
        // pour retrouver le point sous la souris. _prof.view : fenêtre du zoom (null = vue entière).
        function _drawProfile() {
            var cv = _profCanvas, p = _prof;
            if (!cv || !p || !_currentScope || !p.s || !p.lut) { return; }
            var rect = cv.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 20) { return; }
            var dpr = window.devicePixelRatio || 1;
            var W = Math.round(rect.width * dpr), H = Math.round((_profForcedH || rect.height) * dpr);
            cv.width = W; cv.height = H;
            if (!_profBase) { _profBase = document.createElement('canvas'); }
            _profBase.width = W; _profBase.height = H;
            var g = _profBase.getContext('2d');
            g.fillStyle = '#14181d';
            g.fillRect(0, 0, W, H);

            var mL = Math.round(48 * dpr), mR = Math.round(12 * dpr), mT = Math.round(10 * dpr), mB = Math.round(24 * dpr);
            var w = W - mL - mR, h = H - mT - mB;
            var zlo = p.zmin, zhi = p.zmax, pad = Math.max(1, (zhi - zlo) * 0.06);
            zlo -= pad; zhi += pad;
            var s0 = 0, zr = zhi - zlo, kx = w / p.L, kz = h / zr, wUse = w;
            if (_currentScope.profile.equal) {   // même échelle en x et en z (bâtiments et pentes non déformés)
                var k = Math.min(kx, kz);
                if (kz > k) { var mid = (zlo + zhi) / 2; zr = h / k; zlo = mid - zr / 2; zhi = mid + zr / 2; }
                kx = kz = k; wUse = p.L * k;
            }
            // vue entière, rapportée à toute la surface du graphique : référence et butée du zoom
            p.base = { s0: 0, s1: w / kx, z0: zlo, z1: zlo + h / kz };
            if (p.view) {
                s0 = p.view.s0; zlo = p.view.z0; zhi = p.view.z1; zr = zhi - zlo;
                kx = w / (p.view.s1 - p.view.s0); kz = h / zr; wUse = w;
            }
            var s1 = s0 + wUse / kx;
            p.plot = { mL: mL, mT: mT, w: wUse, h: h, kx: kx, kz: kz, s0: s0, zlo: zlo, dpr: dpr };
            function digits(step) { return step >= 1 ? 0 : step >= 0.1 ? 1 : 2; }

            // grille et graduations
            g.font = Math.round(10 * dpr) + 'px sans-serif';
            g.lineWidth = 1;
            var xs = _niceStep(s1 - s0, wUse / (90 * dpr)), zs = _niceStep(zr, h / (38 * dpr)), t, X, Y, first = true;
            g.textBaseline = 'top'; g.textAlign = 'center';
            for (t = Math.max(0, Math.ceil(s0 / xs - 1e-6) * xs); t <= Math.min(p.L, s1) + 1e-6; t += xs) {
                X = Math.round(mL + (t - s0) * kx) + 0.5;
                g.strokeStyle = 'rgba(255,255,255,0.08)';
                g.beginPath(); g.moveTo(X, mT); g.lineTo(X, mT + h); g.stroke();
                g.fillStyle = '#9aa0a6';
                g.fillText(t.toFixed(digits(xs)) + (first ? ' m' : ''), X, mT + h + 4 * dpr);
                first = false;
            }
            g.textBaseline = 'middle'; g.textAlign = 'right';
            for (t = Math.ceil(zlo / zs) * zs; t <= zhi; t += zs) {
                Y = Math.round(mT + h - (t - zlo) * kz) + 0.5;
                g.strokeStyle = 'rgba(255,255,255,0.08)';
                g.beginPath(); g.moveTo(mL, Y); g.lineTo(mL + wUse, Y); g.stroke();
                g.fillStyle = '#9aa0a6';
                g.fillText(t.toFixed(digits(zs)), mL - 5 * dpr, Y);
            }

            // nœuds de la polyligne (hors extrémités) : repères verticaux
            if (p.segs.length > 1) {
                g.save(); g.setLineDash([4 * dpr, 4 * dpr]); g.strokeStyle = 'rgba(47,129,247,0.85)'; g.lineWidth = dpr;
                for (var q = 1; q < p.segs.length; q++) {
                    X = Math.round(mL + (p.segs[q].cum - s0) * kx) + 0.5;
                    if (X < mL || X > mL + wUse) { continue; }
                    g.beginPath(); g.moveTo(X, mT); g.lineTo(X, mT + h); g.stroke();
                }
                g.restore();
            }

            // voile entre le sol (MNT) et la surface (MNS), sous les points ; les traits sont dessinés après les points
            var curvePlot = { mL: mL, mT: mT, h: h, w: wUse, kx: kx, kz: kz, s0: s0, zlo: zlo, dpr: dpr };
            _drawProfileCadastre(g, p, curvePlot, 'spans');
            if (_curvesOn()) { _drawCurves(g, p, curvePlot, 'fill'); }

            // points : tampon de pixels (rapide même à plusieurs centaines de milliers de points), puis recopie
            var pw = Math.max(1, Math.ceil(wUse)), ph = Math.max(1, h);
            var img = g.createImageData(pw, ph), px = img.data, ps = Math.max(1, Math.round(1.5 * dpr));
            var mode = _currentScope.profile.color;
            if (mode === 'ORTHO' && !p.rgb) { mode = 'CLASSIFICATION'; }
            var zspan = Math.max(1e-6, p.zmax - p.zmin), lut = p.lut;
            for (var i = 0; i < p.n; i++) {
                if (!_pointShown(p, i)) { continue; }
                var cx = Math.floor((p.s[i] - s0) * kx), cy = Math.floor(ph - (p.z[i] - zlo) * kz);
                if (cx <= -ps || cx >= pw || cy < 0 || cy >= ph + ps) { continue; }
                var r, gg, b;
                if (mode === 'ORTHO')          { r = p.rgb[3 * i]; gg = p.rgb[3 * i + 1]; b = p.rgb[3 * i + 2]; }
                else if (mode === 'ELEVATION') { var col = _elevationColor((p.z[i] - p.zmin) / zspan); r = col[0]; gg = col[1]; b = col[2]; }
                else { var ci = 3 * p.c[i]; r = lut.rgb[ci]; gg = lut.rgb[ci + 1]; b = lut.rgb[ci + 2]; }
                for (var oy = 0; oy < ps; oy++) {
                    var yy = cy - oy;
                    if (yy < 0 || yy >= ph) { continue; }
                    for (var ox = 0; ox < ps; ox++) {
                        var xx = cx + ox;
                        if (xx < 0 || xx >= pw) { continue; }
                        var o = 4 * (yy * pw + xx);
                        px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = 255;
                    }
                }
            }
            var layer = document.createElement('canvas');
            layer.width = pw; layer.height = ph;
            layer.getContext('2d').putImageData(img, 0, 0);
            g.drawImage(layer, mL, mT);
            if (_curvesOn()) { _drawCurves(g, p, curvePlot, 'lines'); }
            _drawProfileCadastre(g, p, curvePlot, 'limits');

            // pentes du terrain entre sommets : corde entre les altitudes du sol, valeur en haut du segment
            if (p.slopes) {
                g.save();
                g.beginPath(); g.rect(mL, mT, wUse, h); g.clip();
                g.font = 'bold ' + Math.round(11 * dpr) + 'px sans-serif';
                g.textBaseline = 'middle'; g.textAlign = 'center';
                p.slopes.forEach(function (sl, gi) {
                    if (!sl) { return; }
                    var a = p.nodes[gi], bn = p.nodes[gi + 1];
                    var xa = mL + (a.s - s0) * kx, xb = mL + (bn.s - s0) * kx;
                    var ya = mT + h - (a.z - zlo) * kz, yb = mT + h - (bn.z - zlo) * kz;
                    g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = dpr; g.setLineDash([5 * dpr, 4 * dpr]);
                    g.beginPath(); g.moveTo(xa, ya); g.lineTo(xb, yb); g.stroke(); g.setLineDash([]);
                    g.fillStyle = '#fff';
                    [[xa, ya], [xb, yb]].forEach(function (c) { g.fillRect(c[0] - 2.5 * dpr, c[1] - 2.5 * dpr, 5 * dpr, 5 * dpr); });
                    var va = Math.max(mL, xa), vb = Math.min(mL + wUse, xb);   // partie visible du segment
                    var txt = _slopeLabel(sl), tw = g.measureText(txt).width + 10 * dpr;
                    if (vb - va < tw + 4 * dpr) { return; }
                    var tx = (va + vb) / 2, ty = mT + 11 * dpr;
                    g.fillStyle = 'rgba(20,24,29,0.85)';
                    g.fillRect(tx - tw / 2, ty - 8 * dpr, tw, 16 * dpr);
                    g.fillStyle = '#fff';
                    g.fillText(txt, tx, ty);
                });
                g.restore();
            }
            _paintProfile(null);
        }

        var _CAD_LIMIT_COLOR = '#c58bff', _CAD_SNAP_PX = 8;   // _CAD_SNAP_PX : distance d'accroche du curseur
        var _CAD_SNAP_LABELS = { limit: 'Limite de parcelle', building: 'Bord de bâti' };

        // Cadastre sur le graphique, à l'écran seulement, sans masquer les points : voile très léger sur les longueurs en
        // bâtiment (sous les points) ; par-dessus, ruban plein au bas du graphique et pointillés aux limites de parcelles.
        function _drawProfileCadastre(g, p, pl, part) {
            if (_profExporting || !_currentScope.profile.cad || !p.cad) { return; }
            var d = pl.dpr, i, X0 = pl.mL, X1 = pl.mL + pl.w, rh = 7 * d, ry = pl.mT + pl.h - rh;
            function X(s) { return pl.mL + (s - pl.s0) * pl.kx; }
            g.save();
            g.beginPath(); g.rect(pl.mL, pl.mT, pl.w, pl.h); g.clip();
            if (part === 'spans') {
                g.fillStyle = 'rgba(255,255,255,0.045)';
                for (i = 0; i < p.cad.spans.length; i++) {
                    var a = X(p.cad.spans[i][0]), b = X(p.cad.spans[i][1]);
                    if (b >= X0 && a <= X1) { g.fillRect(a, pl.mT, Math.max(d, b - a), pl.h); }
                }
                g.restore();
                return;
            }
            // ruban : fond discret, bâti plein
            g.fillStyle = 'rgba(10,12,16,0.75)';
            g.fillRect(X0, ry, pl.w, rh);
            g.fillStyle = '#ff5ac8';
            for (i = 0; i < p.cad.spans.length; i++) {
                var a2 = X(p.cad.spans[i][0]), b2 = X(p.cad.spans[i][1]);
                if (b2 >= X0 && a2 <= X1) { g.fillRect(a2, ry + d, Math.max(d, b2 - a2), rh - 2 * d); }
            }
            // limites : tirets violets sur la hauteur (lisibles sur les points et l'orthophoto, grâce au liseré sombre)
            [['rgba(10,12,16,0.8)', 3, []], [_CAD_LIMIT_COLOR, 1.5, [7 * d, 4 * d]]].forEach(function (st) {
                g.strokeStyle = st[0]; g.lineWidth = st[1] * d; g.setLineDash(st[2]);
                g.beginPath();
                p.cad.limits.forEach(function (s) {
                    var x = Math.round(X(s)) + 0.5;
                    if (x >= X0 && x <= X1) { g.moveTo(x, pl.mT); g.lineTo(x, ry); }
                });
                g.stroke();
            });
            g.setLineDash([]);
            g.strokeStyle = _CAD_LIMIT_COLOR; g.lineWidth = 2 * d;
            g.beginPath();
            p.cad.limits.forEach(function (s) {
                var x = Math.round(X(s)) + 0.5;
                if (x >= X0 && x <= X1) { g.moveTo(x, ry - 3 * d); g.lineTo(x, ry + rh); }
            });
            g.stroke();
            g.restore();
            // légende : sous les courbes si elles sont affichées
            var c = _curvesOn() ? _profCurves(p) : null, rows = c ? (c.hasS ? 1 : 0) + (c.hasG ? 1 : 0) : 0;
            g.save();
            g.font = Math.round(10 * d) + 'px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'right';
            var lx = pl.mL + pl.w - 6 * d, ly = pl.mT + 36 * d + rows * 13 * d;
            ['Limite de parcelle', 'Bâti (cadastre)'].forEach(function (txt, idx) {
                var yy = ly + idx * 13 * d, tw = g.measureText(txt).width;
                g.fillStyle = 'rgba(20,24,29,0.75)'; g.fillRect(lx - tw - 28 * d, yy - 7 * d, tw + 34 * d, 14 * d);
                g.fillStyle = '#c8c8c8'; g.fillText(txt, lx, yy);
                if (idx === 0) {
                    g.strokeStyle = _CAD_LIMIT_COLOR; g.lineWidth = 1.5 * d; g.setLineDash([3 * d, 2 * d]);
                    g.beginPath(); g.moveTo(lx - tw - 14 * d, yy - 5 * d); g.lineTo(lx - tw - 14 * d, yy + 5 * d); g.stroke();
                    g.setLineDash([]);
                } else {
                    g.fillStyle = '#ff5ac8'; g.fillRect(lx - tw - 22 * d, yy - 3 * d, 16 * d, 6 * d);
                }
            });
            g.restore();
        }

        // Courbes du sol (orange) et de la surface (bleu clair) ; une valeur manquante interrompt le trait.
        function _drawCurves(g, p, pl, part) {
            var c = _profCurves(p), d = pl.dpr;
            if (!c.hasG && !c.hasS) { return; }
            var i0 = Math.max(0, Math.floor(pl.s0 / c.step) - 1), i1 = Math.min(c.n - 1, Math.ceil((pl.s0 + pl.w / pl.kx) / c.step) + 1);
            function X(i) { return pl.mL + (Math.min(p.L, i * c.step) - pl.s0) * pl.kx; }
            function Y(z) { return pl.mT + pl.h - (z - pl.zlo) * pl.kz; }
            g.save();
            g.beginPath(); g.rect(pl.mL, pl.mT, pl.w, pl.h); g.clip();
            // voile entre sol et surface, par tronçons où les deux valeurs existent
            g.fillStyle = 'rgba(90,209,255,0.14)';
            var i = i0, j, k;
            while (part === 'fill' && i <= i1) {
                if (!(c.zg[i] === c.zg[i] && c.zs[i] === c.zs[i])) { i++; continue; }
                j = i;
                while (j + 1 <= i1 && c.zg[j + 1] === c.zg[j + 1] && c.zs[j + 1] === c.zs[j + 1]) { j++; }
                g.beginPath();
                for (k = i; k <= j; k++) { if (k === i) { g.moveTo(X(k), Y(c.zs[k])); } else { g.lineTo(X(k), Y(c.zs[k])); } }
                for (k = j; k >= i; k--) { g.lineTo(X(k), Y(c.zg[k])); }
                g.closePath(); g.fill();
                i = j + 1;
            }
            // traits : un liseré sombre dessous pour rester lisibles sur les points ; sol en orange, surface en bleu clair
            [['zs', c.hasS, '#5ad1ff'], ['zg', c.hasG, '#ff9f1c']].forEach(function (cv) {
                if (part !== 'lines' || !cv[1]) { return; }
                var arr = c[cv[0]];
                [['rgba(10,12,16,0.85)', 3.6], [cv[2], 1.6]].forEach(function (st) {
                    var pen = false;
                    g.strokeStyle = st[0]; g.lineWidth = st[1] * d; g.lineJoin = 'round';
                    g.beginPath();
                    for (var q = i0; q <= i1; q++) {
                        if (arr[q] !== arr[q]) { pen = false; continue; }
                        if (pen) { g.lineTo(X(q), Y(arr[q])); } else { g.moveTo(X(q), Y(arr[q])); pen = true; }
                    }
                    g.stroke();
                });
            });
            g.restore();
            if (part !== 'lines') { return; }
            // légende en haut à droite
            g.save();
            g.font = Math.round(10 * d) + 'px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'right';
            var lx = pl.mL + pl.w - 6 * d, ly = pl.mT + 36 * d;
            [['MNS (surface)', '#5ad1ff', c.hasS], ['MNT (sol)', '#ff9f1c', c.hasG]].forEach(function (e, idx) {
                if (!e[2]) { return; }
                var yy = ly + idx * 13 * d, tw = g.measureText(e[0]).width;
                g.fillStyle = 'rgba(20,24,29,0.75)'; g.fillRect(lx - tw - 28 * d, yy - 7 * d, tw + 34 * d, 14 * d);
                g.fillStyle = '#c8c8c8'; g.fillText(e[0], lx, yy);
                g.strokeStyle = e[1]; g.lineWidth = 2 * d;
                g.beginPath(); g.moveTo(lx - tw - 22 * d, yy); g.lineTo(lx - tw - 6 * d, yy); g.stroke();
            });
            g.restore();
        }

        // ------------------------------------------------------------
        // Zoom du graphique : molette (autour du curseur), glisser pour déplacer la fenêtre
        // ------------------------------------------------------------
        var _profRaf = 0, _profDrag = null, _profDragged = false;
        var _PROFILE_PLOT_H = 216;   // hauteur normale du graphique, en px (voir .geo-lidar-profile-plot)
        var _profForcedH = 0;        // hauteur imposée au dessin : l'image exportée ne dépend pas du profil agrandi
        var _profExporting = false;  // export PNG en cours : le cadastre reste à l'écran seulement

        function _drawProfileSoon() {
            if (_profRaf) { return; }
            _profRaf = window.requestAnimationFrame(function () { _profRaf = 0; _drawProfile(); });
        }

        function _resetProfileZoom() {
            if (_prof) { _prof.view = null; }
            _setProfileState({ zoomed: false });
        }

        // Fenêtre demandée, ramenée dans la vue entière ; redevient la vue entière dès qu'elle la couvre.
        function _setProfileView(v) {
            var p = _prof, b = p && p.base;
            if (!b) { return; }
            var sr = v.s1 - v.s0, zr = v.z1 - v.z0, bs = b.s1 - b.s0, bz = b.z1 - b.z0;
            if (sr >= bs - 1e-9 && zr >= bz - 1e-9) { p.view = null; }
            else {
                if (sr > bs) { sr = bs; }
                if (zr > bz) { zr = bz; }
                v.s0 = Math.min(b.s1 - sr, Math.max(b.s0, v.s0)); v.s1 = v.s0 + sr;
                v.z0 = Math.min(b.z1 - zr, Math.max(b.z0, v.z0)); v.z1 = v.z0 + zr;
                p.view = v;
            }
            if (_currentScope && _currentScope.profile.zoomed !== !!p.view) { _setProfileState({ zoomed: !!p.view }); }
            _drawProfileSoon();
        }

        function _onProfileWheel(e) {
            var p = _prof;
            if (!p || !p.plot || !p.base || !p.n || !_currentScope) { return; }
            e.preventDefault();
            var pl = p.plot, r = _profCanvas.getBoundingClientRect(), cur = p.view || p.base;
            var delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : 1);
            var f = Math.exp(Math.max(-1, Math.min(1, delta * 0.002)));
            // Maj : distance seule ; Alt : altitude seule (sauf à l'échelle 1:1, où les deux axes restent liés)
            var equal = !!_currentScope.profile.equal;
            var fs = !equal && e.altKey ? 1 : f, fz = !equal && e.shiftKey ? 1 : f;
            if (f < 1 && ((cur.s1 - cur.s0) * fs < 0.5 || (cur.z1 - cur.z0) * fz < 0.2)) { return; }   // zoom maximal
            var sc = pl.s0 + ((e.clientX - r.left) * pl.dpr - pl.mL) / pl.kx;
            var zc = pl.zlo + (pl.mT + pl.h - (e.clientY - r.top) * pl.dpr) / pl.kz;
            _setProfileView({ s0: sc - (sc - cur.s0) * fs, s1: sc + (cur.s1 - sc) * fs,
                              z0: zc - (zc - cur.z0) * fz, z1: zc + (cur.z1 - zc) * fz });
        }

        function _onProfileDown(e) {
            _profDragged = false;
            if (e.button !== 0 || !_prof || !_prof.plot) { return; }
            var v = _prof.view;
            _profDrag = { x: e.clientX, y: e.clientY, moved: false, view: v && { s0: v.s0, s1: v.s1, z0: v.z0, z1: v.z1 } };
            window.addEventListener('mousemove', _onProfileDrag);
            window.addEventListener('mouseup', _onProfileUp);
        }

        function _onProfileDrag(e) {
            var d = _profDrag, p = _prof;
            if (!d || !p || !p.plot) { return; }
            var dx = e.clientX - d.x, dy = e.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) < 4) { return; }
            d.moved = true;
            if (!d.view) { return; }   // vue entière : rien à déplacer
            var ds = -dx * p.plot.dpr / p.plot.kx, dz = dy * p.plot.dpr / p.plot.kz;
            _setProfileView({ s0: d.view.s0 + ds, s1: d.view.s1 + ds, z0: d.view.z0 + dz, z1: d.view.z1 + dz });
        }

        function _onProfileUp() {
            window.removeEventListener('mousemove', _onProfileDrag);
            window.removeEventListener('mouseup', _onProfileUp);
            _profDragged = !!(_profDrag && _profDrag.moved);   // le clic qui suit un glisser n'est pas une mesure
            _profDrag = null;
        }

        // ------------------------------------------------------------
        // Le profil dans la vue 3D : plan de coupe translucide le long du tracé + repères (survol, mesure)
        // ------------------------------------------------------------
        var _p3d = null;   // { group, curtain, edges, probe, mA, mB, line }

        // iTowns désactive la mise à jour automatique des matrices de la scène : on met à jour celles de notre groupe.
        function _refresh3d() {
            if (_p3d) { _p3d.group.updateMatrixWorld(true); }
            if (_view) { _view.notifyChange(_view.camera.camera3D); }
        }

        function _ensure3d() {
            if (_p3d || !_view) { return _p3d; }
            var group = new Group();
            group.name = 'geo-lidar-profile';
            function ball(color) {
                var m = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: color, depthTest: false, transparent: true }));
                m.renderOrder = 999; m.visible = false; group.add(m);
                return m;
            }
            _p3d = { group: group, curtain: null, edges: null, axis: null, probe: ball(0xffffff), mA: ball(0x2f81f7), mB: ball(0xffb020), line: null };
            _view.scene.add(group);
            return _p3d;
        }

        function _disposeObj(o) {
            if (!o) { return; }
            if (o.parent) { o.parent.remove(o); }
            if (o.geometry) { o.geometry.dispose(); }
            if (o.material) { o.material.dispose(); }
        }

        function _dispose3dProfile() {
            if (!_p3d) { return; }
            var t = _p3d;
            _p3d = null;
            [t.curtain, t.edges, t.axis, t.line, t.probe, t.mA, t.mB].forEach(_disposeObj);
            if (t.group.parent) { t.group.parent.remove(t.group); }
            if (_view) { _refresh3d(); }
        }

        // Plan de coupe sur le tracé (axe du profil, en bleu franc) et volume du couloir (deux parois à ± la
        // demi-épaisseur, arêtes plus claires), de l'altitude mini à maxi des points affichés. Géométrie locale à l'origine du tracé (coordonnées Lambert-93 absolues : float32 sur GPU jitterait).
        function _update3dProfile() {
            var p = _prof;
            if (!p || !_view || !p.P || !_currentScope) { return; }
            var t = _ensure3d();
            _disposeObj(t.curtain); _disposeObj(t.edges); _disposeObj(t.axis); t.curtain = t.edges = t.axis = null;
            if (!p.nv) { _refresh3d(); return; }
            var o = p.P[0], zlo = p.zmin - 2, zhi = p.zmax + 2, pos = [], idx = [], edges = [], axis = [];
            var sides = _bandSides(Number(_currentScope.profile.halfWidth) || 5);
            [p.P, sides.left, sides.right].forEach(function (side, w) {
                var base = pos.length / 3, seg = w === 0 ? axis : edges;
                side.forEach(function (q, i) {
                    var x = q[0] - o[0], y = q[1] - o[1];
                    pos.push(x, y, zlo, x, y, zhi);
                    seg.push(x, y, zlo, x, y, zhi);   // arête verticale à chaque nœud
                    if (i < side.length - 1) {
                        var b = base + 2 * i, nx = side[i + 1][0] - o[0], ny = side[i + 1][1] - o[1];
                        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
                        seg.push(x, y, zlo, nx, ny, zlo, x, y, zhi, nx, ny, zhi);
                    }
                });
            });
            [0, p.P.length - 1].forEach(function (i) {   // fermeture du couloir aux deux bouts
                var a = sides.left[i], b = sides.right[i];
                edges.push(a[0] - o[0], a[1] - o[1], zlo, b[0] - o[0], b[1] - o[1], zlo,
                         a[0] - o[0], a[1] - o[1], zhi, b[0] - o[0], b[1] - o[1], zhi);
            });
            var g1 = new BufferGeometry();
            g1.setAttribute('position', new Float32BufferAttribute(pos, 3)); g1.setIndex(idx);
            t.curtain = new Mesh(g1, new MeshBasicMaterial({ color: 0x2f81f7, transparent: true, opacity: 0.1, side: DoubleSide, depthWrite: false }));
            var g2 = new BufferGeometry(), g3 = new BufferGeometry();
            g2.setAttribute('position', new Float32BufferAttribute(edges, 3));
            g3.setAttribute('position', new Float32BufferAttribute(axis, 3));
            t.edges = new LineSegments(g2, new LineBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.6 }));
            t.axis  = new LineSegments(g3, new LineBasicMaterial({ color: 0x2f81f7 }));
            [t.curtain, t.edges, t.axis].forEach(function (m) { m.position.set(o[0], o[1], 0); t.group.add(m); });
            _refresh3d();
        }

        // Cadre la vue 3D sur le tracé : caméra de côté (face au plan de coupe), à ~1,5 fois la longueur. L'aperçu ne voit
        // que ce qui est affiché, donc le tracé doit être dans le champ ; sans cela le plan serait hors cadre.
        function _frameProfile() {
            var p = _prof;
            if (!p || !_view || !_controls || !_layer || !_layer.source || !_layer.source.header) { return; }
            var a = p.P[0], b = p.P[p.P.length - 1], h = _layer.source.header;
            var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
            var z = p.nv ? (p.zmin + p.zmax) / 2 : (h.min[2] + h.max[2]) / 2;
            var chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
            var nx = chord > 1 ? -(b[1] - a[1]) / chord : 0, ny = chord > 1 ? (b[0] - a[0]) / chord : -1;
            if (ny > 0) { nx = -nx; ny = -ny; }   // côté sud : la vue par défaut regarde vers le nord
            var d = Math.max(180, 1.5 * p.L), cam = _view.camera.camera3D;
            cam.position.set(mx + nx * d * 0.95, my + ny * d * 0.95, z + d * 0.3);
            _controls.target.set(mx, my, z);
            cam.updateProjectionMatrix();
            _controls.update();
            _view.notifyChange(cam);
        }

        // Taille apparente constante des repères quelle que soit la distance de la caméra.
        function _scale3d() {
            if (!_p3d || !_view) { return; }
            var cam = _view.camera.camera3D;
            [_p3d.probe, _p3d.mA, _p3d.mB].forEach(function (b) {
                if (b.visible) { b.scale.setScalar(Math.max(0.2, cam.position.distanceTo(b.position) * 0.008)); }
            });
            _p3d.group.updateMatrixWorld(true);
        }

        function _set3dBall(ball, s, z) {
            if (!ball || !_prof) { return; }
            var xy = _pointAt(s);
            ball.position.set(xy[0], xy[1], z);
            ball.visible = true;
            _scale3d();
            if (_view) { _refresh3d(); }
        }

        function _clear3dMeasure() {
            if (!_p3d) { return; }
            _p3d.mA.visible = false; _p3d.mB.visible = false;
            _disposeObj(_p3d.line); _p3d.line = null;
            if (_view) { _refresh3d(); }
        }

        function _set3dMeasure(m) {
            var t = _ensure3d();
            if (!t || !m || !m.a) { return; }
            _set3dBall(t.mA, m.a.s, m.a.z);
            _disposeObj(t.line); t.line = null;
            if (m.b) {
                _set3dBall(t.mB, m.b.s, m.b.z);
                var g = new BufferGeometry(), a = t.mA.position, b = t.mB.position;
                g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, b.x - a.x, b.y - a.y, b.z - a.z], 3));
                t.line = new Line(g, new LineBasicMaterial({ color: 0xffb020, depthTest: false }));
                t.line.renderOrder = 998; t.line.position.copy(a);
                t.group.add(t.line);
            } else { t.mB.visible = false; }
            if (_view) { _refresh3d(); }
        }

        // ============================================================
        // Export du terrain (MNT) en DXF : faces 3D sur une emprise tracée sur la carte GEO
        // ============================================================
        // Les MNT de l'IGN forment une grille continue de 0,5 m : les nœuds sont aux multiples de 0,5 m en Lambert-93
        // (une dalle porte x de X0 à X0 + 999,5 et y de Y0 - 999,5 à Y0, avec (X0, Y0) = coin NO), donc deux dalles
        // voisines se raccordent sans trou ni doublon. Le maillage garde les nœuds multiples de k × 0,5 m.
        var _MNT_RES = [
            { k: 1, label: '50 cm (résolution du MNT)', short: '50cm' },
            { k: 2, label: '1 m', short: '1m' },
            { k: 4, label: '2 m', short: '2m' }
        ];
        var _MNT_FACE_BYTES = 205;      // taille moyenne d'une entité 3DFACE en ASCII
        var _MNT_MEMORY_WARN = 1.5e9;   // au-delà, sans écriture directe sur disque, tout passe par la mémoire
        var _MNT_LAYER = 'MNT_TERRAIN';
        var _MNT_CHUNK = 4e6;           // caractères accumulés avant chaque écriture
        var _MNT_MAX_TILES = 2500;
        var _mntDraw = null, _mntMap = null, _mntKeyHandler = null;
        var _mnt = null;                // emprise courante : { ring (Lambert-93), bbox, tiles }
        var _mntJob = null;             // export en cours : { cancelled, faces, chars, failed, sink }
        var _mntSeq = 0;

        function _setMnt(patch) {
            $timeout(function () { if (_currentScope) { angular.extend(_currentScope.mnt, patch); } });
        }

        function _fmtBytes(b) {
            return b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' Go' : Math.max(1, Math.round(b / 1e6)) + ' Mo';
        }

        function _mntAreaText(z) {
            if (!z) { return ''; }
            return z.area >= 1e6 ? (z.area / 1e6).toFixed(2).replace('.', ',') + ' km²'
                                 : (z.area / 1e4).toFixed(1).replace('.', ',') + ' ha';
        }

        // Nombre de faces (2 par maille) et taille du fichier attendus, au prorata des dalles réellement disponibles.
        function _mntEstimate(z, k) {
            if (!z || !z.expected) { return { faces: 0, bytes: 0 }; }
            var step = 0.5 * (Number(k) || 1), cover = Math.min(1, z.have / z.expected);
            var faces = Math.round(z.area * cover / (step * step) * 2);
            return { faces: faces, bytes: faces * _MNT_FACE_BYTES };
        }

        // --- géométrie de l'emprise (Lambert-93, anneau fermé de [x, y]) ---
        function _ringArea(r) {
            var a = 0;
            for (var i = 0; i < r.length - 1; i++) { a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; }
            return Math.abs(a) / 2;
        }

        function _pointInRing(x, y, r) {
            var inside = false;
            for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
                var xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
                if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) { inside = !inside; }
            }
            return inside;
        }

        // Le segment AB touche-t-il le rectangle r = [xmin, ymin, xmax, ymax] ? (Liang-Barsky)
        function _segHitsRect(ax, ay, bx, by, r) {
            var t0 = 0, t1 = 1, dx = bx - ax, dy = by - ay;
            var p = [-dx, dx, -dy, dy], q = [ax - r[0], r[2] - ax, ay - r[1], r[3] - ay];
            for (var i = 0; i < 4; i++) {
                if (p[i] === 0) { if (q[i] < 0) { return false; } continue; }
                var t = q[i] / p[i];
                if (p[i] < 0) { if (t > t1) { return false; } if (t > t0) { t0 = t; } }
                else          { if (t < t0) { return false; } if (t < t1) { t1 = t; } }
            }
            return true;
        }

        function _ringHitsRect(ring, r) {
            if (_pointInRing(r[0], r[1], ring)) { return true; }   // rectangle à l'intérieur de l'emprise
            for (var i = 0; i < ring.length - 1; i++) {
                if (_segHitsRect(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1], r)) { return true; }
            }
            return false;
        }

        // --- tracé de l'emprise sur la carte GEO (polygone) ---
        function _startMntDraw() {
            var map = _getOlMap();
            if (!map || !window.ol || _mntJob) { return; }
            _cancelProfileDraw();
            _cancelMntDraw();
            var ol = window.ol;
            var draw = new ol.interaction.Draw({
                type: 'Polygon',   // un clic par sommet ; double-clic (ou Entrée) pour terminer
                style: [
                    new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#fff', width: 5 }) }),
                    new ol.style.Style({
                        stroke: new ol.style.Stroke({ color: '#ffb020', width: 3, lineDash: [8, 6] }),
                        fill:   new ol.style.Fill({ color: 'rgba(255,176,32,0.12)' }),
                        image:  new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#ffb020' }),
                                                      stroke: new ol.style.Stroke({ color: '#fff', width: 2 }) })
                    })
                ]
            });
            draw.on('drawend', function (e) {
                _suppressMapClickUntil = Date.now() + 700;
                var geom = e.feature.getGeometry();
                var o = _ensureOlLayer();
                if (o) { _replaceFeature(o.source, 'zone', new ol.Feature({ geometry: geom.clone(), kind: 'zone' })); }
                _mntPrevZone = null;
                _drawReturn = null;
                var ring = geom.clone().transform(map.getView().getProjection(), 'EPSG:4326').getCoordinates()[0];
                setTimeout(_cancelMntDraw, 0);   // retirer l'interaction hors de son propre gestionnaire
                _prepareMnt(ring);
            });
            map.addInteraction(draw);
            _mntDraw = draw;
            _mntMap = map;
            _syncModify();   // pas d'ajustement du tracé de profil pendant le dessin
            _mntKeyHandler = function (e) {
                if (_tour) { return; }   // la visite guidée garde le clavier : Échap ne ferme qu'elle
                if (e.key === 'Escape') { _abortMntDraw(); }
                else if (e.key === 'Enter') { try { draw.finishDrawing(); } catch (err) { /* moins de 3 sommets */ } }
            };
            document.addEventListener('keydown', _mntKeyHandler);
            // Retracé : l'ancienne emprise s'efface pendant le dessin et revient si le tracé est abandonné.
            _mntPrevZone = _olLayer ? _olLayer.getSource().getFeatures().filter(function (f) { return f.get('kind') === 'zone'; })[0] || null : null;
            _removeKind('zone');
            _syncMntModify();
            if (_currentScope) { _currentScope.mnt.drawing = true; }   // sans attendre : le panneau d'export ne doit pas apparaître avant le message
        }

        var _mntPrevZone = null;
        function _cancelMntDraw() {
            if (_mntKeyHandler) { document.removeEventListener('keydown', _mntKeyHandler); _mntKeyHandler = null; }
            if (_mntDraw) {
                try { _mntMap.removeInteraction(_mntDraw); } catch (e) { /* carte déjà détruite */ }
                _mntDraw = null;
                if (_mntPrevZone && _olLayer) { _olLayer.getSource().addFeature(_mntPrevZone); }
                _mntPrevZone = null;
            }
            _syncModify();
            _syncMntModify();
            if (_currentScope && _currentScope.mnt.drawing) { _setMnt({ drawing: false }); }
        }

        // Abandon du tracé par l'utilisateur : sans emprise, le panneau d'export n'a plus d'objet et se ferme.
        function _abortMntDraw() {
            if (!_mntDraw) { return; }
            _cancelMntDraw();
            var back = _drawReturn;
            _drawReturn = null;
            if (_currentScope && !_currentScope.mnt.zone) { _closeMnt(); }
            if (back === 'profile') { _restoreProfile(); }
        }

        // Ajustement de l'emprise : comme pour le profil, ses sommets se déplacent sur la carte GEO (ol.interaction.Modify ;
        // un glisser sur un segment y insère un sommet, Alt + clic en supprime un). Les dalles, la surface et la taille
        // estimée sont recalculées au relâcher. Inactif pendant un tracé et pendant un export.
        var _mntModify = null;   // { map, interaction, feature }
        function _syncMntModify() {
            var feature = null;
            if (_olLayer && !_mntDraw && !_drawInteraction && !_mntJob && _currentScope && _currentScope.mnt.open) {
                feature = _olLayer.getSource().getFeatures().filter(function (f) { return f.get('kind') === 'zone'; })[0] || null;
            }
            if (_mntModify && _mntModify.feature === feature) { return; }
            if (_mntModify) {
                try { _mntModify.map.removeInteraction(_mntModify.interaction); } catch (e) { /* carte déjà détruite */ }
                _mntModify = null;
            }
            var map = feature && _getOlMap(), ol = window.ol;
            if (!map || !ol || !ol.interaction.Modify) { return; }
            var mod = new ol.interaction.Modify({ features: new ol.Collection([feature]) });
            var before = JSON.stringify(feature.getGeometry().getCoordinates());
            mod.on('modifyend', function () {
                _suppressMapClickUntil = Date.now() + 700;
                var coords = feature.getGeometry().getCoordinates();
                if (JSON.stringify(coords) === before) { return; }   // simple clic sur un sommet
                before = JSON.stringify(coords);
                setTimeout(function () {   // hors du gestionnaire de l'interaction
                    if (!_mntModify || _mntModify.feature !== feature || _mntJob) { return; }
                    _prepareMnt(feature.getGeometry().clone().transform(map.getView().getProjection(), 'EPSG:4326').getCoordinates()[0]);
                }, 0);
            });
            map.addInteraction(mod);
            _mntModify = { map: map, interaction: mod, feature: feature };
        }

        // Emprise tracée : anneau en Lambert-93, dalles attendues, puis dalles réellement publiées par le WFS.
        function _prepareMnt(ringLL) {
            var seq = ++_mntSeq;
            var ring = ringLL.map(function (ll) { return proj4('EPSG:4326', 'EPSG:2154', ll); });
            var bb = [Infinity, Infinity, -Infinity, -Infinity];
            ring.forEach(function (q) {
                bb = [Math.min(bb[0], q[0]), Math.min(bb[1], q[1]), Math.max(bb[2], q[0]), Math.max(bb[3], q[1])];
            });
            var area = _ringArea(ring);
            _mnt = null;
            if (area < 4) { _setMnt({ state: 'error', zone: null, msg: 'Emprise trop petite : tracez un polygone plus grand.' }); return; }
            var tx0 = Math.floor(bb[0] / 1000), tx1 = Math.floor(bb[2] / 1000);
            var ty0 = Math.floor(bb[1] / 1000) + 1, ty1 = Math.ceil(bb[3] / 1000);
            var nRect = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
            if (nRect > _MNT_MAX_TILES) {
                _setMnt({ state: 'error', zone: null, msg: 'Emprise trop étendue (' + nRect + ' dalles dans son rectangle englobant).' });
                return;
            }
            var expected = {}, nExp = 0;
            for (var tx = tx0; tx <= tx1; tx++) {
                for (var ty = ty0; ty <= ty1; ty++) {
                    var r = [tx * 1000, (ty - 1) * 1000, (tx + 1) * 1000, ty * 1000];
                    if (_ringHitsRect(ring, r)) { expected[r[0] + '|' + r[3]] = true; nExp++; }
                }
            }
            _setMnt({ state: 'search', msg: '', zone: { area: area, found: 0, have: 0, expected: nExp, missing: 0 } });
            var m = 2;   // marge de sécurité : une maille de bord peut s'appuyer sur la dalle voisine
            var url = _wfsUrl + '?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0' +
                '&TYPENAMES=' + encodeURIComponent(_WFS_TYPENAME) +
                '&OUTPUTFORMAT=application%2Fjson&SRSNAME=EPSG:4326&COUNT=' + (nRect * 3 + 20) +
                '&BBOX=' + [bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m].join(',') + ',EPSG:2154';
            fetch(url).then(function (res) {
                if (!res.ok) { throw new Error('WFS HTTP ' + res.status); }
                return res.json();
            }).then(function (fc) {
                if (seq !== _mntSeq) { return; }
                if (fc.numberMatched > (fc.features || []).length) { throw new Error('résultat tronqué'); }
                var byKey = {};
                (fc.features || []).map(_tileFromFeature).forEach(function (t) {
                    if (!t.bbox || !t.rasters.mnt) { return; }
                    if (!_ringHitsRect(ring, [t.bbox[0] - m, t.bbox[1] - m, t.bbox[2] + m, t.bbox[3] + m])) { return; }
                    var key = t.bbox[0] + '|' + t.bbox[3];
                    if (!byKey[key] || t.date > byKey[key].date) { byKey[key] = t; }   // plusieurs millésimes : le plus récent
                });
                var tiles = Object.keys(byKey).map(function (k) { return byKey[k]; });
                var have = Object.keys(expected).filter(function (k) { return byKey[k]; }).length;
                _mnt = { seq: seq, ring: ring, bbox: bb, tiles: tiles };
                _setMnt({ state: 'ready', msg: '',
                          zone: { area: area, found: tiles.length, have: have, expected: nExp, missing: nExp - have } });
            }).catch(function (err) {
                if (seq !== _mntSeq) { return; }
                console.error('[geo-lidar-hd] recherche des dalles MNT :', err);
                _setMnt({ state: 'error', zone: null,
                          msg: 'Recherche des dalles impossible (réseau ou limitation du serveur IGN). Retracez l\'emprise pour réessayer.' });
            });
        }

        function _closeMnt() {
            _cancelMntDraw();
            _stopMnt(true);
            _mntSeq++;
            _mnt = null;
            _mntMemo = null;
            _removeKind('zone');
            if (_currentScope) { _currentScope.mnt.open = false; }   // l'ajustement ne dépend plus d'un panneau fermé
            _syncMntModify();
            _setMnt({ open: false, state: 'idle', zone: null, msg: '', drawing: false });
        }

        function _stopMnt(silent) {
            if (!_mntJob) { return; }
            _mntJob.cancelled = true;
            if (!silent) { _setMnt({ state: _mnt ? 'ready' : 'idle', msg: 'Export annulé.' }); }
        }

        // Destination du fichier : écriture directe sur disque quand le navigateur le permet (aucun Go en mémoire),
        // sinon un Blob assemblé en mémoire puis téléchargé. À appeler directement depuis le clic (geste utilisateur).
        function _openMntSink(name) {
            function inMemory() {
                var parts = [];
                return {
                    streaming: false,
                    write: function (s) { parts.push(new Blob([s])); return Promise.resolve(); },   // le Blob libère la chaîne
                    close: function () { _downloadBlob(new Blob(parts, { type: 'application/dxf' }), name); parts = []; return Promise.resolve(); },
                    abort: function () { parts = []; return Promise.resolve(); }
                };
            }
            if (!window.showSaveFilePicker) { return Promise.resolve(inMemory()); }
            return window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Fichier DXF', accept: { 'application/dxf': ['.dxf'] } }] })
                .then(function (handle) { return handle.createWritable(); })
                .then(function (w) {
                    return { streaming: true,
                             write: function (s) { return w.write(s); },
                             close: function () { return w.close(); },
                             abort: function () { return w.abort(); } };
                }, function (err) {
                    if (err && err.name === 'AbortError') { throw err; }   // choix du fichier annulé
                    return inMemory();                                     // sélecteur indisponible (iframe, politique…)
                });
        }

        function _exportMnt() {
            var sc = _currentScope, m = _mnt;
            if (!sc || !m || !m.tiles.length || _mntJob) { return; }
            var crs = sc.mnt.crs, k = Number(sc.mnt.k) || 1;
            var ci = _CRS_LIST.filter(function (c) { return c.code === crs; })[0] || _CRS_LIST[0];
            var ri = _MNT_RES.filter(function (r) { return r.k === k; })[0] || _MNT_RES[0];
            var cc = sc.mntCad, cad = null;
            if (cc && cc.on && (cc.parcelles || cc.batiments || cc.sections)) {
                cad = { parcelles: !!cc.parcelles, batiments: !!cc.batiments, sections: !!cc.sections,
                        numeros: !!cc.parcelles && cc.numeros !== false,
                        lift: !!cc.lift, liftM: Math.max(0, Number(cc.liftM) || 0) };
            }
            var ortho = sc.mntOrtho && sc.mntOrtho.on && crs !== 'EPSG:4326' ? { res: Number(sc.mntOrtho.res) || 0.2 } : null;
            if (ortho && _orthoPlan(crs, ortho.res).tooBig) { return; }
            var job = { cancelled: false, faces: 0, chars: 0, failed: 0, sink: null, cadItems: 0, cadFailed: 0, orthoImages: 0, orthoFailed: 0 };
            _mntJob = job;
            _syncMntModify();   // emprise figée pendant l'export
            _setMnt({ state: 'running', pct: 0, msg: 'Choix du fichier…' });
            _openMntSink('terrain_mnt_' + ci.short + '_' + ri.short + '.dxf').then(function (sink) {
                job.sink = sink;
                if (job.cancelled) { return null; }
                _setMnt({ msg: 'Préparation…' });
                return _runMnt(job, m, crs, k, sink, cad);
            }).then(function () {
                var sink = job.sink;
                if (!sink) { return null; }
                if (job.cancelled) { return sink.abort(); }
                return sink.close().then(function () {
                    return ortho ? _exportOrtho(job, m, ci, ortho) : null;
                }).then(function () {
                    if (job.cancelled) { return; }
                    _setMnt({ state: 'done', pct: 100, msg: 'Terminé : ' + job.faces.toLocaleString('fr-FR') + ' faces, ' +
                        _fmtBytes(job.chars) + (job.sink.streaming ? ' écrits dans le fichier choisi.' : ' (téléchargement lancé).') +
                        (job.cadItems ? ' Cadastre : ' + job.cadItems.toLocaleString('fr-FR') + ' entités.' : '') +
                        (job.cadFailed ? ' Cadastre incomplet (' + job.cadFailed + ' fichier(s) indisponible(s)).' : '') +
                        (ortho ? (job.orthoImages ? ' Orthophoto : ' + job.orthoImages + ' image(s) dans une archive ZIP (téléchargement lancé).' : ' Orthophoto indisponible.') : '') +
                        (job.orthoFailed ? ' ' + job.orthoFailed + ' image(s) de l\'orthophoto manquante(s).' : '') +
                        (job.failed ? ' ' + job.failed + ' dalle(s) illisible(s) : trous dans le maillage.' : '') });
                });
            }).catch(function (err) {
                if (job.sink) { try { job.sink.abort(); } catch (e) { /* déjà fermé */ } }
                if (err && err.name === 'AbortError') { _setMnt({ state: 'ready', msg: '' }); return; }   // sélecteur de fichier fermé
                console.error('[geo-lidar-hd] export MNT :', err);
                _setMnt({ state: 'error', msg: 'Export impossible : ' + (err && err.message || err) });
            }).then(function () {
                _mntJob = null;
                _syncMntModify();
                _rasters.clear();
            });
        }

        // Maillage et écriture. Les lignes de nœuds sont parcourues du nord au sud ; chaque paire de lignes donne une
        // bande de mailles, dont seules celles dont le centre est dans l'emprise sont écrites (2 triangles chacune, la
        // diagonale suivant la pente la plus douce). Un triangle dont un sommet est sans donnée est ignoré.
        // Mémoire : seules les rangées de dalles de la bande courante (et la suivante) sont gardées.
        function _runMnt(job, m, crsCode, k, sink, cad) {
            var step = 0.5 * k, ring = m.ring, bb = m.bbox, NODES = 2000;
            var i0 = Math.ceil(bb[0] / step), i1 = Math.floor(bb[2] / step);
            var j0 = Math.ceil(bb[1] / step), j1 = Math.floor(bb[3] / step);
            var nI = i1 - i0 + 1;
            if (nI < 2 || j1 - j0 < 1) { return Promise.reject(new Error('emprise trop petite pour ce maillage.')); }
            var conv = crsCode === 'EPSG:2154' ? null : proj4('EPSG:2154', crsCode);
            var dxy = crsCode === 'EPSG:4326' ? 9 : 3;   // 1e-9 ° ~ 0,1 mm ; 1 mm en mètres
            var tilesByTy = {}, maxCols = 0;
            m.tiles.forEach(function (t) {
                var ty = t.bbox[3] / 1000;
                (tilesByTy[ty] = tilesByTy[ty] || []).push(t);
                maxCols = Math.max(maxCols, tilesByTy[ty].length);
            });
            var prefetch = maxCols <= 8;   // lire la rangée suivante pendant le calcul de la courante (~16 Mo par dalle)
            var grids = {}, loading = {}, ensured = '', zMax = -Infinity;

            function tyOf(j) { return Math.ceil(j * step / 1000); }

            function loadTileRow(ty) {
                if (loading[ty]) { return loading[ty]; }
                return (loading[ty] = Promise.all((tilesByTy[ty] || []).map(function (t) {
                    var key = t.bbox[0] + '|' + t.bbox[3];
                    return _rasters.load(t, 'mnt', NODES).then(function (g) { grids[key] = g; }, function (err) {
                        job.failed++; grids[key] = null;
                        console.warn('[geo-lidar-hd] MNT de la dalle ' + t.name + ' illisible :', err);
                    });
                })));
            }

            // Charge les rangées de dalles utiles à la bande (j, j - 1) et libère les autres ; renvoie une Promise
            // seulement quand il faut attendre.
            function ensure(j) {
                var a = tyOf(j), b = tyOf(j - 1), id = a + '|' + b;
                if (id === ensured) { return null; }
                ensured = id;
                var keep = {};
                keep[a] = keep[b] = true;
                if (prefetch && tilesByTy[b - 1]) { keep[b - 1] = true; }
                Object.keys(loading).forEach(function (ty) {
                    if (keep[ty]) { return; }
                    (tilesByTy[ty] || []).forEach(function (t) { delete grids[t.bbox[0] + '|' + t.bbox[3]]; });
                    delete loading[ty];
                });
                var waits = [loadTileRow(a)];
                if (b !== a) { waits.push(loadTileRow(b)); }
                if (keep[b - 1] && b - 1 !== a) { loadTileRow(b - 1); }   // sans attendre
                return Promise.all(waits);
            }

            // Ligne de nœuds j (y = j × pas) : altitudes, coordonnées déjà converties et formatées en texte.
            var rowCache = {};
            function getRow(j) {
                if (rowCache[j]) { return rowCache[j]; }
                var y = j * step, ty = Math.ceil(y / 1000);
                var Z = new Float32Array(nI), SX = new Array(nI), SY = new Array(nI), SZ = new Array(nI);
                var lastKey = null, g = null;
                for (var n = 0; n < nI; n++) {
                    var x = (i0 + n) * step, z = NaN;
                    var key = Math.floor(x / 1000) * 1000 + '|' + ty * 1000;
                    if (key !== lastKey) { lastKey = key; g = grids[key] || null; }
                    if (g) {
                        var col = Math.round((x - g.x0) / 0.5), row = Math.round((g.y0 - y) / 0.5);
                        if (col >= 0 && col < NODES && row >= 0 && row < NODES) { z = g.data[row * NODES + col]; }
                    }
                    Z[n] = z;
                    if (z === z) {
                        if (z > zMax) { zMax = z; }
                        var xy = conv ? conv.forward([x, y]) : [x, y];
                        SX[n] = xy[0].toFixed(dxy); SY[n] = xy[1].toFixed(dxy); SZ[n] = z.toFixed(2);
                    }
                }
                return (rowCache[j] = { Z: Z, SX: SX, SY: SY, SZ: SZ });
            }

            // Abscisses où l'emprise coupe la ligne y = yc, triées (entrées et sorties alternées).
            function crossings(yc) {
                var xs = [];
                for (var a = 0, b = ring.length - 1; a < ring.length; b = a++) {
                    var ya = ring[a][1], yb = ring[b][1];
                    if ((ya > yc) !== (yb > yc)) { xs.push(ring[a][0] + (yc - ya) * (ring[b][0] - ring[a][0]) / (yb - ya)); }
                }
                return xs.sort(function (p, q) { return p - q; });
            }

            var buf = [], bufLen = 0, HEAD = '0\r\n3DFACE\r\n8\r\n' + _MNT_LAYER + '\r\n';
            function tri(ra, na, rb, nb, rc, nc) {
                var s = HEAD +
                    '10\r\n' + ra.SX[na] + '\r\n20\r\n' + ra.SY[na] + '\r\n30\r\n' + ra.SZ[na] + '\r\n' +
                    '11\r\n' + rb.SX[nb] + '\r\n21\r\n' + rb.SY[nb] + '\r\n31\r\n' + rb.SZ[nb] + '\r\n' +
                    '12\r\n' + rc.SX[nc] + '\r\n22\r\n' + rc.SY[nc] + '\r\n32\r\n' + rc.SZ[nc] + '\r\n' +
                    '13\r\n' + rc.SX[nc] + '\r\n23\r\n' + rc.SY[nc] + '\r\n33\r\n' + rc.SZ[nc] + '\r\n';   // 4e coin = 3e
                buf.push(s); bufLen += s.length; job.faces++;
            }

            function processRow(j) {
                var xs = crossings((j - 0.5) * step);
                if (xs.length < 2) { return; }
                var rt = getRow(j), rb = getRow(j - 1);
                for (var q = 0; q + 1 < xs.length; q += 2) {
                    var ia = Math.max(i0, Math.ceil(xs[q] / step - 0.5)), ib = Math.min(i1 - 1, Math.ceil(xs[q + 1] / step - 0.5) - 1);
                    for (var i = ia; i <= ib; i++) {
                        var n = i - i0, zA = rt.Z[n], zB = rt.Z[n + 1], zC = rb.Z[n], zD = rb.Z[n + 1];
                        var useAD;   // diagonale A-D (NO-SE) ou B-C (NE-SO)
                        if (zA !== zA || zD !== zD) { useAD = false; }
                        else if (zB !== zB || zC !== zC) { useAD = true; }
                        else { useAD = Math.abs(zA - zD) <= Math.abs(zB - zC); }
                        if (useAD) {
                            if (zA === zA && zB === zB && zD === zD) { tri(rt, n, rt, n + 1, rb, n + 1); }
                            if (zA === zA && zD === zD && zC === zC) { tri(rt, n, rb, n + 1, rb, n); }
                        } else {
                            if (zA === zA && zB === zB && zC === zC) { tri(rt, n, rt, n + 1, rb, n); }
                            if (zB === zB && zD === zD && zC === zC) { tri(rt, n + 1, rb, n + 1, rb, n); }
                        }
                    }
                }
                delete rowCache[j + 1];
            }

            function flush() {
                if (!bufLen) { return Promise.resolve(); }
                var s = buf.join('');
                buf = []; bufLen = 0; job.chars += s.length;
                return sink.write(s);
            }

            return new Promise(function (resolve, reject) {
                var j = j1, total = j1 - j0, lastProgress = 0;
                function progress() {
                    var now = Date.now();
                    if (job.cancelled || now - lastProgress < 250) { return; }
                    lastProgress = now;
                    _setMnt({ pct: Math.round((j1 - j) / total * 100),
                              msg: 'Écriture : ' + job.faces.toLocaleString('fr-FR') + ' faces, ' + _fmtBytes(job.chars + bufLen) });
                }
                function loop() {
                    var t0 = Date.now();
                    try {
                        while (j > j0) {
                            if (job.cancelled) { resolve(); return; }
                            var wait = ensure(j);
                            if (wait) {
                                _setMnt({ msg: 'Lecture des dalles du MNT (IGN)…' });
                                wait.then(loop, reject);
                                return;
                            }
                            processRow(j);
                            j--;
                            if (bufLen >= _MNT_CHUNK) { flush().then(function () { progress(); loop(); }, reject); return; }
                            if (Date.now() - t0 > 50) { progress(); setTimeout(loop, 0); return; }   // laisse respirer l'interface
                        }
                    } catch (err) { reject(err); return; }
                    // le cadastre est écrit à la fin : l'altitude du point le plus haut du MNT n'est connue qu'alors
                    flush().then(function () { return cadData ? _writeCadastre(job, cadData, cad, zMax, sink) : null; })
                        .then(function () { return job.cancelled ? null : sink.write(_DXF_FOOT); }).then(resolve, reject);
                }
                var cadData = null;
                (cad ? _loadCadastre(job, m, crsCode, cad) : Promise.resolve(null)).then(function (data) {
                    cadData = data;
                    if (job.cancelled) { resolve(); return null; }
                    var layers = [[_MNT_LAYER, 3]].concat(data ? data.layers : []);
                    return sink.write(_dxfHead(layers)).then(loop);
                }).catch(reject);
            });
        }

        // ------------------------------------------------------------
        // Orthophoto de l'emprise : GeoTIFF géoréférencés (WMS-R IGN, déjà servi dans la projection choisie), livrés dans
        // une archive ZIP à côté du DXF : un DXF R12 ne peut pas contenir d'image. Découpage en images de 4000 px au plus
        // (le serveur plafonne à 5010). Archive sans compression, assemblée en Blob au fil des images.
        // ------------------------------------------------------------
        var _ORTHO_RES = [
            { res: 0.2, label: '20 cm (résolution de l\'orthophoto)' },
            { res: 0.5, label: '50 cm' },
            { res: 1,   label: '1 m' }
        ];
        var _ORTHO_PX = 4000, _ORTHO_MAX_BYTES = 3.5e9;   // 3 octets par pixel ; archive ZIP classique limitée à 4 Go
        var _orthoPlanMemo = null;

        // Grille d'images couvrant le rectangle englobant de l'emprise, dans la projection de sortie.
        function _orthoPlan(crsCode, res) {
            var m = _mnt;
            res = Number(res) || 0.2;
            if (!m || !m.ring || crsCode === 'EPSG:4326') { return { images: 0, w: 0, h: 0, size: '', tooBig: false, cols: 0, rows: 0 }; }
            var key = m.seq + '|' + crsCode + '|' + res;
            if (_orthoPlanMemo && _orthoPlanMemo.key === key) { return _orthoPlanMemo.plan; }
            var conv = crsCode === 'EPSG:2154' ? null : proj4('EPSG:2154', crsCode);
            var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            m.ring.forEach(function (q) {
                var c = conv ? conv.forward(q) : q;
                x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
            });
            x0 = Math.floor(x0 / res) * res; y1 = Math.ceil(y1 / res) * res;
            var w = Math.max(1, Math.ceil((x1 - x0) / res)), h = Math.max(1, Math.ceil((y1 - y0) / res));
            var cols = Math.ceil(w / _ORTHO_PX), rows = Math.ceil(h / _ORTHO_PX), bytes = w * h * 3;
            var plan = { key: key, x0: x0, y1: y1, res: res, w: w, h: h, cols: cols, rows: rows, images: cols * rows,
                         bytes: bytes, size: _fmtBytes(bytes), tooBig: bytes > _ORTHO_MAX_BYTES };
            _orthoPlanMemo = { key: key, plan: plan };
            return plan;
        }

        var _crcTable = null;
        function _crc32(u8) {
            if (!_crcTable) {
                _crcTable = new Uint32Array(256);
                for (var n = 0; n < 256; n++) {
                    var c = n;
                    for (var k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
                    _crcTable[n] = c >>> 0;
                }
            }
            var crc = -1;
            for (var i = 0; i < u8.length; i++) { crc = _crcTable[(crc ^ u8[i]) & 255] ^ (crc >>> 8); }
            return (crc ^ -1) >>> 0;
        }

        // Archive ZIP sans compression : add(nom, Uint8Array) puis blob().
        function _zipBuilder() {
            var parts = [], central = [], offset = 0, enc = new TextEncoder(), d = new Date();
            var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
            var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
            return {
                add: function (name, u8) {
                    var nm = enc.encode(name), crc = _crc32(u8), h = new DataView(new ArrayBuffer(30));
                    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
                    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
                    h.setUint32(18, u8.length, true); h.setUint32(22, u8.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
                    parts.push(h.buffer, nm, u8);
                    var c = new DataView(new ArrayBuffer(46));
                    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
                    c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
                    c.setUint32(20, u8.length, true); c.setUint32(24, u8.length, true); c.setUint16(28, nm.length, true);
                    c.setUint32(42, offset, true);
                    central.push(c.buffer, nm);
                    offset += 30 + nm.length + u8.length;
                },
                blob: function () {
                    var size = 0, i;
                    for (i = 0; i < central.length; i++) { size += central[i].byteLength; }
                    var e = new DataView(new ArrayBuffer(22)), n = central.length / 2;
                    e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true); e.setUint16(10, n, true);
                    e.setUint32(12, size, true); e.setUint32(16, offset, true);
                    return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
                }
            };
        }

        function _exportOrtho(job, m, ci, ortho) {
            var plan = _orthoPlan(ci.code, ortho.res), zip = _zipBuilder(), enc = new TextEncoder();
            var resTxt = ortho.res < 1 ? Math.round(ortho.res * 100) + 'cm' : ortho.res + 'm';
            var base = 'orthophoto_' + ci.short + '_' + resTxt;
            var jobs = [], r, c;
            for (r = 0; r < plan.rows; r++) { for (c = 0; c < plan.cols; c++) { jobs.push([r, c]); } }
            var chain = Promise.resolve();
            jobs.forEach(function (rc, idx) {
                chain = chain.then(function () {
                    if (job.cancelled) { return null; }
                    var r = rc[0], c = rc[1];
                    var w = Math.min(_ORTHO_PX, plan.w - c * _ORTHO_PX), h = Math.min(_ORTHO_PX, plan.h - r * _ORTHO_PX);
                    var bx0 = plan.x0 + c * _ORTHO_PX * plan.res, by1 = plan.y1 - r * _ORTHO_PX * plan.res;
                    var bbox = [bx0, by1 - h * plan.res, bx0 + w * plan.res, by1];
                    var url = _orthoWmsUrl + (_orthoWmsUrl.indexOf('?') === -1 ? '?' : '&') +
                        'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=' + ci.code +
                        '&BBOX=' + bbox.map(function (v) { return v.toFixed(3); }).join(',') +
                        '&WIDTH=' + w + '&HEIGHT=' + h + '&FORMAT=image/geotiff';
                    _setMnt({ pct: Math.round(100 * idx / jobs.length), msg: 'Orthophoto : image ' + (idx + 1) + ' / ' + jobs.length + '…' });
                    return _fetchWithRetry(url, {}, 0).then(function (buf) {
                        var u8 = new Uint8Array(buf);
                        if (u8[0] !== 0x49 && u8[0] !== 0x4d) { throw new Error('réponse du serveur inattendue'); }   // pas un TIFF : message d'erreur XML
                        zip.add(base + '_' + (r + 1) + '_' + (c + 1) + '.tif', u8);
                        job.orthoImages++;
                    }).catch(function (err) {
                        job.orthoFailed++;
                        console.warn('[geo-lidar-hd] image d\'orthophoto ' + (r + 1) + '/' + (c + 1) + ' indisponible :', err);
                    });
                });
            });
            return chain.then(function () {
                if (job.cancelled || !job.orthoImages) { return null; }
                var info = 'Orthophoto IGN (ORTHOIMAGERY.ORTHOPHOTOS), GeoTIFF géoréférencés en ' + ci.label + '.\r\n' +
                    'Résolution : ' + resTxt + ' - ' + plan.cols + ' colonne(s) x ' + plan.rows + ' ligne(s) d\'images (nom : _ligne_colonne).\r\n' +
                    'À attacher dans le même système de coordonnées que le DXF du terrain.\r\n' +
                    'Source : IGN, Géoplateforme (Licence Ouverte).\r\n';
                zip.add('LISEZMOI.txt', enc.encode(info));
                _downloadBlob(zip.blob(), base + '.zip');
                return null;
            });
        }

        // ------------------------------------------------------------
        // Cadastre PCI Vecteur (Etalab) ajouté au DXF du terrain : un GeoJSON par commune et par couche, lu sur le
        // stockage S3 d'Etalab (le lien « latest » de cadastre.data.gouv.fr redirige sans en-tête CORS : bloqué
        // depuis un navigateur). La dernière version est cherchée dans le listing du bucket.
        // ------------------------------------------------------------
        var _CAD_S3 = 'https://cadastre.s3.rbx.io.cloud.ovh.net/';
        var _CAD_DATES_FALLBACK = ['2026-09-01'];
        var _CAD_LAYERS = {
            parcelles: { file: 'parcelles', name: 'CADASTRE_PARCELLES', color: 2 },
            batiments: { file: 'batiments', name: 'CADASTRE_BATIMENTS', color: 1 },
            sections:  { file: 'sections',  name: 'CADASTRE_SECTIONS',  color: 6 }
        };
        var _CAD_TEXT_LAYER = 'CADASTRE_NUMEROS', _CAD_TEXT_H = 1.5;   // hauteur du texte en mètres
        var _cadDates = null;

        function _cadastreDates() {
            if (_cadDates) { return _cadDates; }
            return fetch(_CAD_S3 + '?prefix=etalab-cadastre/&delimiter=/').then(function (r) {
                if (!r.ok) { throw new Error('HTTP ' + r.status); }
                return r.text();
            }).then(function (xml) {
                var re = /etalab-cadastre\/(\d{4}-\d{2}-\d{2})\//g, mt, d = [];
                while ((mt = re.exec(xml))) { if (d.indexOf(mt[1]) < 0) { d.push(mt[1]); } }
                if (!d.length) { throw new Error('aucune version'); }
                return (_cadDates = Promise.resolve(d.sort().reverse()));
            }).catch(function (err) {
                console.warn('[geo-lidar-hd] versions du cadastre Etalab introuvables, version par défaut :', err);
                return _CAD_DATES_FALLBACK;
            });
        }

        // GeoJSON d'une couche communale : les trois versions les plus récentes sont essayées (la plus récente peut
        // être en cours de publication). null si le fichier n'existe pas. Décompression gzip native du navigateur.
        function _cadastreFile(dates, dep, insee, file) {
            var i = 0;
            function next() {
                if (i >= Math.min(3, dates.length)) { return Promise.resolve(null); }
                var url = _CAD_S3 + 'etalab-cadastre/' + dates[i++] + '/geojson/communes/' + dep + '/' + insee + '/cadastre-' + insee + '-' + file + '.json.gz';
                return fetch(url).then(function (r) {
                    if (r.status === 404) { return next(); }
                    if (!r.ok) { throw new Error('HTTP ' + r.status); }
                    return r.arrayBuffer().then(function (buf) {
                        var u8 = new Uint8Array(buf);
                        if (u8[0] === 0x1f && u8[1] === 0x8b) {   // gzip (sinon déjà décompressé en route)
                            if (typeof DecompressionStream === 'undefined') { throw new Error('navigateur sans DecompressionStream'); }
                            return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
                        }
                        return JSON.parse(new TextDecoder().decode(u8));
                    });
                });
            }
            return next();
        }

        // Communes touchées par une géométrie (GeoJSON, lon/lat), d'après l'API Carto de l'IGN.
        function _cadastreCommunes(geom) {
            return fetch('https://apicarto.ign.fr/api/cadastre/commune?geom=' + encodeURIComponent(JSON.stringify(geom))).then(function (r) {
                if (!r.ok) { throw new Error('API Carto HTTP ' + r.status); }
                return r.json();
            }).then(function (fc) {
                return (fc.features || []).map(function (f) { return f.properties || {}; }).filter(function (c) { return c.code_insee; });
            });
        }

        function _cadastreDep(c) {
            return c.code_dep || String(c.code_insee).slice(0, String(c.code_insee).indexOf('97') === 0 ? 3 : 2);
        }

        // Fichiers communaux lus pour le profil : conservés le temps que la vue reste ouverte, pour qu'un tracé voisin
        // ne les relise pas. Les fichiers les plus anciens sont oubliés au-delà de _CAD_FILES_MAX (ils pèsent lourd).
        var _CAD_FILES_MAX = 6;
        var _cadFiles = new Map();
        function _cadastreFileCached(dates, dep, insee, file) {
            var key = insee + '|' + file, hit = _cadFiles.get(key);
            if (hit) {
                _cadFiles.delete(key); _cadFiles.set(key, hit);   // plus récemment utilisé
                return hit;
            }
            var pr = _cadastreFile(dates, dep, insee, file).then(function (fc) {
                if (!fc) { _cadFiles.delete(key); }   // fichier absent : on pourra réessayer
                return fc;
            }, function (err) {
                _cadFiles.delete(key);
                throw err;
            });
            _cadFiles.set(key, pr);
            while (_cadFiles.size > _CAD_FILES_MAX) { _cadFiles.delete(_cadFiles.keys().next().value); }
            return pr;
        }

        // Cadastre du tracé de profil, à la demande (case « Cadastre ») : limites de parcelles traversées et longueurs en
        // bâtiment, gardées dans _prof.cad. Un tracé modifié crée un nouveau _prof : son cadastre est recalculé.
        function _loadProfileCadastre() {
            var p = _prof;
            if (!p || !_currentScope || !_currentScope.profile.cad || p.cad || p.cadLoading) { return; }
            p.cadLoading = true;
            _setProfileState({ cadMsg: 'Lecture du cadastre…' });
            var toLL = proj4('EPSG:2154', 'EPSG:4326'), toL93 = proj4('EPSG:4326', 'EPSG:2154');
            var ll = p.P.map(function (q) { return toLL.forward(q); });
            var lons = ll.map(function (c) { return c[0]; }), lats = ll.map(function (c) { return c[1]; });
            var m = 0.0003, lon0 = Math.min.apply(null, lons) - m, lon1 = Math.max.apply(null, lons) + m;
            var lat0 = Math.min.apply(null, lats) - m, lat1 = Math.max.apply(null, lats) + m;
            var geom = { type: 'Polygon', coordinates: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]] };
            var found = { parcelles: [], batiments: [] }, read = 0, failed = 0;

            function collect(fc, key) {
                (fc.features || []).forEach(function (f) {
                    var g = f.geometry;
                    var polys = !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
                    polys.forEach(function (poly) {
                        var hit = poly[0].some(function (c) { return c[0] >= lon0 && c[0] <= lon1 && c[1] >= lat0 && c[1] <= lat1; });
                        if (!hit) {   // aucun sommet dans le rectangle : le polygone peut encore l'englober ou le traverser
                            var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                            poly[0].forEach(function (c) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); });
                            if (x1 < lon0 || x0 > lon1 || y1 < lat0 || y0 > lat1) { return; }
                        }
                        found[key].push(poly.map(function (r) { return r.map(function (c) { return toL93.forward(c); }); }));
                    });
                });
            }

            _cadastreCommunes(geom).then(function (communes) {
                return _cadastreDates().then(function (dates) {
                    var chain = Promise.resolve();
                    communes.forEach(function (c) {
                        ['parcelles', 'batiments'].forEach(function (key) {
                            chain = chain.then(function () {
                                if (_prof !== p) { return null; }   // tracé remplacé ou profil fermé
                                return _cadastreFileCached(dates, _cadastreDep(c), c.code_insee, _CAD_LAYERS[key].file).then(function (fc) {
                                    if (fc) { read++; collect(fc, key); } else { failed++; }
                                }, function (err) {
                                    failed++;
                                    console.warn('[geo-lidar-hd] cadastre ' + c.code_insee + ' ' + key + ' indisponible :', err);
                                });
                            });
                        });
                    });
                    return chain;
                });
            }).catch(function (err) {
                failed++;
                console.warn('[geo-lidar-hd] cadastre du profil indisponible :', err);
            }).then(function () {
                if (_prof !== p) { return; }
                p.cadLoading = false;
                p.cad = { limits: parcelLimits(p.segs, found.parcelles), spans: buildingSpans(p.segs, found.batiments) };
                p.cad.snaps = snapTargets(p.cad.limits, p.cad.spans, p.L);
                var msg = !read ? 'Cadastre indisponible.' : failed ? 'Cadastre incomplet.' :
                          !p.cad.limits.length && !p.cad.spans.length ? 'Aucune limite ni bâtiment sur ce tracé.' : '';
                _setProfileState({ cadMsg: msg });
                _drawProfileSoon();
            });
        }

        function _segCross(a, b, c, d) {
            function o(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
            var o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
            return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0));
        }

        // Deux anneaux fermés se recouvrent-ils ? (sommet dans l'autre, ou arêtes qui se croisent)
        function _ringsOverlap(a, b) {
            var i, j;
            for (i = 0; i < a.length; i++) { if (_pointInRing(a[i][0], a[i][1], b)) { return true; } }
            for (i = 0; i < b.length; i++) { if (_pointInRing(b[i][0], b[i][1], a)) { return true; } }
            for (i = 0; i < a.length - 1; i++) {
                for (j = 0; j < b.length - 1; j++) { if (_segCross(a[i], a[i + 1], b[j], b[j + 1])) { return true; } }
            }
            return false;
        }

        // Entités du cadastre qui touchent l'emprise, déjà dans la projection de sortie :
        // { layers: [[nom, couleur ACI]], items: [{ layer, rings: [[x, y]...], label, cx, cy }] }
        function _loadCadastre(job, m, crsCode, cad) {
            var ring = m.ring, bb = m.bbox, items = [], usedLayers = {};
            var toLL = proj4('EPSG:2154', 'EPSG:4326'), toL93 = proj4('EPSG:4326', 'EPSG:2154');
            var toOut = crsCode === 'EPSG:2154' ? null : proj4('EPSG:2154', crsCode);
            var corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(function (c) { return toLL.forward(c); });
            var lon0 = Math.min.apply(null, corners.map(function (c) { return c[0]; })) - 0.0003;
            var lon1 = Math.max.apply(null, corners.map(function (c) { return c[0]; })) + 0.0003;
            var lat0 = Math.min.apply(null, corners.map(function (c) { return c[1]; })) - 0.0003;
            var lat1 = Math.max.apply(null, corners.map(function (c) { return c[1]; })) + 0.0003;
            var geom = { type: 'Polygon', coordinates: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]] };
            var wanted = ['parcelles', 'batiments', 'sections'].filter(function (k) { return cad[k]; });

            function outPt(p) { return toOut ? toOut.forward(p) : p; }

            function collect(fc, key) {
                var def = _CAD_LAYERS[key];
                (fc.features || []).forEach(function (f) {
                    var g = f.geometry;
                    if (!g) { return; }
                    var polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
                    polys.forEach(function (poly) {
                        var outer = poly[0], x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, i;
                        for (i = 0; i < outer.length; i++) {
                            x0 = Math.min(x0, outer[i][0]); x1 = Math.max(x1, outer[i][0]);
                            y0 = Math.min(y0, outer[i][1]); y1 = Math.max(y1, outer[i][1]);
                        }
                        if (x1 < lon0 || x0 > lon1 || y1 < lat0 || y0 > lat1) { return; }
                        if (!_ringsOverlap(outer.map(function (c) { return toL93.forward(c); }), ring)) { return; }
                        var rings = poly.map(function (r) { return r.map(function (c) { return outPt(toL93.forward(c)); }); });
                        var item = { layer: def.name, rings: rings };
                        if (key === 'parcelles' && cad.numeros && f.properties && f.properties.numero) {
                            var o = rings[0], sx = 0, sy = 0, n = o.length - 1 || 1;
                            for (i = 0; i < n; i++) { sx += o[i][0]; sy += o[i][1]; }
                            item.label = String((f.properties.section || '') + String(f.properties.numero)).replace(/[^\x20-\x7e]/g, '');
                            item.cx = sx / n; item.cy = sy / n;
                        }
                        usedLayers[def.name] = def.color;
                        items.push(item);
                    });
                });
            }

            _setMnt({ msg: 'Cadastre : recherche des communes…' });
            return _cadastreCommunes(geom).then(function (communes) {
                return _cadastreDates().then(function (dates) {
                    var chain = Promise.resolve();
                    communes.forEach(function (c) {
                        var dep = _cadastreDep(c);
                        wanted.forEach(function (key) {
                            chain = chain.then(function () {
                                if (job.cancelled) { return null; }
                                _setMnt({ msg: 'Cadastre : ' + (c.nom_com || c.code_insee) + ' (' + key + ')…' });
                                return _cadastreFile(dates, dep, c.code_insee, _CAD_LAYERS[key].file).then(function (fc2) {
                                    if (fc2) { collect(fc2, key); } else { job.cadFailed++; }
                                }, function (err) {
                                    job.cadFailed++;
                                    console.warn('[geo-lidar-hd] cadastre ' + c.code_insee + ' ' + key + ' indisponible :', err);
                                });
                            });
                        });
                    });
                    return chain;
                });
            }).catch(function (err) {
                job.cadFailed++;
                console.warn('[geo-lidar-hd] cadastre indisponible :', err);
            }).then(function () {
                var layers = Object.keys(usedLayers).map(function (n) { return [n, usedLayers[n]]; });
                if (cad.numeros && items.some(function (it) { return it.label; })) { layers.push([_CAD_TEXT_LAYER, 7]); }
                return { items: items, layers: layers };
            });
        }

        // Écrit le cadastre : polylignes 3D fermées (Z constant) et numéros de parcelle en texte centré.
        function _writeCadastre(job, data, cad, zMax, sink) {
            var z = cad.lift && zMax > -Infinity ? zMax + cad.liftM : 0;
            var zs = z.toFixed(2), dxy = _currentScope && _currentScope.mnt.crs === 'EPSG:4326' ? 9 : 3;
            var th = dxy === 9 ? _CAD_TEXT_H / 111000 : _CAD_TEXT_H;
            var i = 0;
            function fmt(v) { return v.toFixed(dxy); }
            function chunk() {
                var buf = [], len = 0;
                while (i < data.items.length && len < _MNT_CHUNK && !job.cancelled) {
                    var it = data.items[i++];
                    it.rings.forEach(function (r) {
                        if (r.length < 3) { return; }
                        var s = '0\r\nPOLYLINE\r\n8\r\n' + it.layer + '\r\n66\r\n1\r\n10\r\n0\r\n20\r\n0\r\n30\r\n0\r\n70\r\n9\r\n';
                        for (var k = 0; k < r.length - 1; k++) {   // le dernier sommet répète le premier : polyligne fermée par son drapeau
                            s += '0\r\nVERTEX\r\n8\r\n' + it.layer + '\r\n10\r\n' + fmt(r[k][0]) + '\r\n20\r\n' + fmt(r[k][1]) + '\r\n30\r\n' + zs + '\r\n70\r\n32\r\n';
                        }
                        s += '0\r\nSEQEND\r\n8\r\n' + it.layer + '\r\n';
                        buf.push(s); len += s.length;
                    });
                    if (it.label) {
                        var t = '0\r\nTEXT\r\n8\r\n' + _CAD_TEXT_LAYER + '\r\n10\r\n' + fmt(it.cx) + '\r\n20\r\n' + fmt(it.cy) + '\r\n30\r\n' + zs +
                                '\r\n40\r\n' + th.toFixed(dxy === 9 ? 7 : 2) + '\r\n1\r\n' + it.label + '\r\n72\r\n1\r\n11\r\n' + fmt(it.cx) + '\r\n21\r\n' + fmt(it.cy) + '\r\n31\r\n' + zs + '\r\n';
                        buf.push(t); len += t.length;
                    }
                    job.cadItems++;
                }
                if (!buf.length) { return Promise.resolve(); }
                var str = buf.join('');
                job.chars += str.length;
                return sink.write(str).then(function () { return i < data.items.length && !job.cancelled ? chunk() : null; });
            }
            _setMnt({ msg: 'Écriture du cadastre…' });
            return chunk();
        }

        // ------------------------------------------------------------
        // Points du nuage sur l'emprise du MNT : second DXF (entités POINT, un calque par classe), même projection.
        // Chaque dalle est lue à part, hors de la vue : COPC nœud par nœud, seuls les nœuds qui touchent l'emprise.
        // ------------------------------------------------------------
        var _PTS_CLASSES = [2, 3, 4, 5, 6, 9, 17, 64, 1, 67];
        var _PTS_THIN = [
            { n: 1, label: 'Pleine densité' }, { n: 2, label: '1 point sur 2' },
            { n: 5, label: '1 point sur 5' }, { n: 10, label: '1 point sur 10' }
        ];
        var _PTS_BYTES = 95;        // taille moyenne d'une entité POINT en ASCII
        var _PTS_PARALLEL = 3;      // nœuds COPC lus en parallèle dans une dalle

        // Majorant : tous les points des dalles, au prorata de la surface de l'emprise (les classes ne sont pas connues d'avance).
        function _ptsEstimate(z, thin) {
            if (!z || !_mnt || !_mnt.tiles.length) { return { points: 0, bytes: 0, size: '' }; }
            var total = _mnt.tiles.reduce(function (a, t) { return a + (Number(t.points) || 0); }, 0);
            var share = Math.min(1, z.area / (_mnt.tiles.length * 1e6));
            var points = Math.round(total * share / (Number(thin) || 1));
            return { points: points, bytes: points * _PTS_BYTES, size: _fmtBytes(points * _PTS_BYTES) };
        }

        function _exportMntPoints() {
            var sc = _currentScope, m = _mnt;
            if (!sc || !m || !m.tiles.length || _mntJob) { return; }
            var ids = _PTS_CLASSES.filter(function (c) { return sc.mntPts.classes[c]; });
            if (!ids.length) { return; }
            var thin = Number(sc.mntPts.thin) || 1;
            var ci = _CRS_LIST.filter(function (c) { return c.code === sc.mnt.crs; })[0] || _CRS_LIST[0];
            var job = { cancelled: false, points: 0, chars: 0, failed: 0, sink: null };
            _mntJob = job;
            _syncMntModify();   // emprise figée pendant l'export
            _setMnt({ state: 'running', pct: 0, msg: 'Choix du fichier…' });
            _openMntSink('nuage_points_' + ci.short + (thin > 1 ? '_1sur' + thin : '') + '.dxf').then(function (sink) {
                job.sink = sink;
                if (job.cancelled) { return null; }
                _setMnt({ msg: 'Préparation…' });
                return _runMntPoints(job, m, ci, ids, thin, sink);
            }).then(function () {
                var sink = job.sink;
                if (!sink) { return null; }
                if (job.cancelled) { return sink.abort(); }
                return sink.close().then(function () {
                    _setMnt({ state: 'done', pct: 100, msg: 'Terminé : ' + job.points.toLocaleString('fr-FR') + ' points, ' +
                        _fmtBytes(job.chars) + (sink.streaming ? ' écrits dans le fichier choisi.' : ' (téléchargement lancé).') +
                        (job.failed ? ' ' + job.failed + ' dalle(s) ou nœud(s) illisible(s) : points manquants.' : '') });
                });
            }).catch(function (err) {
                if (job.sink) { try { job.sink.abort(); } catch (e) { /* déjà fermé */ } }
                if (err && err.name === 'AbortError') { _setMnt({ state: 'ready', msg: '' }); return; }   // sélecteur de fichier fermé
                console.error('[geo-lidar-hd] export des points :', err);
                _setMnt({ state: 'error', msg: 'Export impossible : ' + (err && err.message || err) });
            }).then(function () {
                _mntJob = null;
                _syncMntModify();
                _clearRangeCache();
            });
        }

        function _runMntPoints(job, m, ci, ids, thin, sink) {
            var ring = m.ring, bb = m.bbox;
            var conv = ci.code === 'EPSG:2154' ? null : proj4('EPSG:2154', ci.code);
            var dxy = ci.code === 'EPSG:4326' ? 9 : 3;
            var want = {}, layerOf = {}, buf = [], bufLen = 0, counter = 0, lastMsg = 0, tileIdx = 0;
            ids.forEach(function (c) { want[c] = true; layerOf[c] = 'LIDAR_CLASSE_' + (c < 10 ? '0' : '') + c; });

            function flush() {
                if (!buf.length) { return Promise.resolve(); }
                var str = buf.join('');
                buf = []; bufLen = 0; job.chars += str.length;
                return sink.write(str);
            }

            function hits(node) {
                var b = node.bbox;
                return _ringHitsRect(ring, [b.min.x, b.min.y, b.max.x, b.max.y]);
            }

            // Points d'un nœud décodé : classes retenues, dans le polygone, un sur `thin`
            function scan(geo) {
                var pos = geo.attributes.position.array, n = geo.attributes.position.count, o = geo.userData.origin;
                var cl = geo.attributes.classification, cls = cl && cl.array;
                for (var k = 0; k < n; k++) {
                    var c = cls ? cls[k] : 1;
                    if (!want[c]) { continue; }
                    var x = pos[3 * k] + o.x, y = pos[3 * k + 1] + o.y;
                    if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3] || !_pointInRing(x, y, ring)) { continue; }
                    if (thin > 1 && (counter++ % thin) !== 0) { continue; }
                    var xy = conv ? conv.forward([x, y]) : [x, y];
                    var e = '0\r\nPOINT\r\n8\r\n' + layerOf[c] + '\r\n10\r\n' + xy[0].toFixed(dxy) + '\r\n20\r\n' + xy[1].toFixed(dxy) +
                            '\r\n30\r\n' + (pos[3 * k + 2] + o.z).toFixed(2) + '\r\n';
                    buf.push(e); bufLen += e.length; job.points++;
                }
            }

            function progress(nodesDone, nodesTotal) {
                if (Date.now() - lastMsg < 250) { return; }
                lastMsg = Date.now();
                var frac = (tileIdx - 1 + nodesDone / Math.max(1, nodesTotal)) / m.tiles.length;
                _setMnt({ pct: Math.min(99, Math.round(100 * frac)),
                          msg: 'Dalle ' + tileIdx + ' / ' + m.tiles.length + ' : ' + job.points.toLocaleString('fr-FR') + ' points' });
            }

            // Une dalle : couche COPC hors vue, parcours de l'octree en profondeur limitée par le parallélisme
            function doTile(t) {
                var layer;
                try {
                    layer = new CopcLayer('lidar-pts-' + t.name + '-' + Date.now(), {
                        source: new CopcSource({ url: t.url }), crs: 'EPSG:2154', pointBudget: Infinity
                    });
                } catch (err) { job.failed++; console.warn('[geo-lidar-hd] dalle ' + t.name + ' illisible :', err); return Promise.resolve(); }
                return layer.whenReady.then(function () {
                    return new Promise(function (resolve) {
                        var queue = [layer.root], active = 0, done = 0, total = 1;
                        function pump() {
                            if (job.cancelled) { queue.length = 0; }
                            while (active < _PTS_PARALLEL && queue.length) {
                                active++;
                                visit(queue.shift()).then(finish, function (err) {
                                    job.failed++;
                                    console.warn('[geo-lidar-hd] nœud COPC non lu (dalle ' + t.name + ') :', err);
                                    finish();
                                });
                            }
                            if (!active && !queue.length) { resolve(); }
                        }
                        function finish() { active--; done++; progress(done, total); pump(); }
                        function visit(node) {
                            return Promise.resolve(node.octreeIsLoaded ? null : node.loadOctree()).then(function () {
                                node.children.forEach(function (ch) { if (hits(ch)) { queue.push(ch); total++; } });
                                if (!(node.numPoints > 0) || !hits(node)) { return null; }
                                return node.load().then(function (geo) {
                                    scan(geo);
                                    return bufLen >= _MNT_CHUNK ? flush() : null;
                                });
                            });
                        }
                        pump();
                    });
                }).catch(function (err) {
                    job.failed++;
                    console.warn('[geo-lidar-hd] dalle ' + t.name + ' illisible :', err);
                }).then(function () { try { layer.delete(); } catch (e) { /* jamais ajoutée à une vue */ } });
            }

            return sink.write(_dxfHead(ids.map(function (c) { return [layerOf[c], _DXF_CLASS_COLORS[c] || 8]; }))).then(function () {
                var chain = Promise.resolve();
                m.tiles.forEach(function (t) {
                    chain = chain.then(function () {
                        if (job.cancelled) { return null; }
                        tileIdx++;
                        return doTile(t).then(flush);
                    });
                });
                return chain;
            }).then(function () { return job.cancelled ? null : flush().then(function () { return sink.write(_DXF_FOOT); }); });
        }

        // ------------------------------------------------------------
        // Export du profil : image du graphique, points du couloir en CSV
        // ------------------------------------------------------------
        function _downloadBlob(blob, name) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = name;
            document.body.appendChild(a); a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) { a.parentNode.removeChild(a); } }, 1000);
        }

        function _exportBase() {
            var sc = _currentScope;
            return 'profil_' + (sc && sc.tile ? sc.tile.name : 'dalle') + (_prof && _prof.mode === 'exact' ? '_pleine-densite' : '_apercu');
        }

        function _exportPng() {
            if (!_profCanvas || !_prof || !_prof.plot) { return; }
            var tall = _currentScope && _currentScope.profile.tall;
            var redraw = tall || (_currentScope && _currentScope.profile.cad && _prof.cad);
            if (tall) { _profForcedH = _PROFILE_PLOT_H; }
            _profExporting = true;
            if (redraw) { _drawProfile(); }
            _paintProfile(null);
            _profCanvas.toBlob(function (blob) { if (blob) { _downloadBlob(blob, _exportBase() + '.png'); } }, 'image/png');
            _profForcedH = 0;
            _profExporting = false;
            if (redraw) { _drawProfile(); }   // même tâche : l'image exportée n'est jamais affichée
        }

        // Points affichés (classes et tranche d'altitude du panneau Style) : x;y en Lambert-93 (EPSG:2154), z en NGF.
        function _exportCsv() {
            var p = _prof;
            if (!p || !p.n || !p.x) { return; }
            var rows = ['x_l93;y_l93;z_m;distance_m;classe;nom_classe'];
            for (var i = 0; i < p.n; i++) {
                if (!_pointShown(p, i)) { continue; }
                rows.push(p.x[i].toFixed(2) + ';' + p.y[i].toFixed(2) + ';' + p.z[i].toFixed(2) + ';' + p.s[i].toFixed(2) + ';' +
                          p.c[i] + ';' + (_CLASS_NAMES[p.c[i]] || ''));
            }
            _downloadBlob(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }), _exportBase() + '.csv');
        }

        // ------------------------------------------------------------
        // Export DXF (ASCII, format R12 : lu par AutoCAD, Covadis, QGIS…). Unité : le mètre.
        // ------------------------------------------------------------
        // decimals : décimales conservées (3 = millimètre ; 9 pour des degrés).
        function _dxf(decimals) {
            var layers = [], parts = [], buf = [], f = Math.pow(10, decimals || 3);
            function n(v) { return String(Math.round(v * f) / f); }
            function nz(v) { return String(Math.round(v * 1000) / 1000); }   // l'altitude reste en mètres, au millimètre
            function flush() { if (buf.length) { parts.push(buf.join('\r\n') + '\r\n'); buf = []; } }
            function put(a) { for (var i = 0; i < a.length; i++) { buf.push(a[i]); } if (buf.length > 60000) { flush(); } }
            return {
                layer: function (name, color) { layers.push([name, color]); },
                point: function (l, x, y, z) { put(['0', 'POINT', '8', l, '10', n(x), '20', n(y), '30', nz(z)]); },
                line: function (l, x1, y1, z1, x2, y2, z2) {
                    put(['0', 'LINE', '8', l, '10', n(x1), '20', n(y1), '30', nz(z1), '11', n(x2), '21', n(y2), '31', nz(z2)]);
                },
                // pts : [x, y] (polyligne 2D) ou [x, y, z] avec is3d
                polyline: function (l, pts, is3d) {
                    if (pts.length < 2) { return; }
                    put(['0', 'POLYLINE', '8', l, '66', '1', '10', '0', '20', '0', '30', '0', '70', is3d ? '8' : '0']);
                    pts.forEach(function (q) {
                        put(['0', 'VERTEX', '8', l, '10', n(q[0]), '20', n(q[1]), '30', nz(is3d ? q[2] : 0), '70', is3d ? '32' : '0']);
                    });
                    put(['0', 'SEQEND', '8', l]);
                },
                // align : 0 gauche, 1 centré, 2 droite (texte ASCII : pas d'accents en R12)
                text: function (l, x, y, h, str, align) {
                    var a = ['0', 'TEXT', '8', l, '10', n(x), '20', n(y), '30', '0', '40', n(h), '1', str];
                    if (align) { a.push('72', String(align), '11', n(x), '21', n(y), '31', '0'); }
                    put(a);
                },
                blob: function () {
                    flush();
                    return new Blob([_dxfHead(layers)].concat(parts, [_DXF_FOOT]), { type: 'application/dxf' });
                }
            };
        }

        // En-tête (tables LTYPE, LAYER, STYLE) et début de la section ENTITIES ; layers : [[nom, couleur ACI], ...].
        function _dxfHead(layers) {
            var head = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC',
                '0', 'SECTION', '2', 'TABLES',
                '0', 'TABLE', '2', 'LTYPE', '70', '1',
                '0', 'LTYPE', '2', 'CONTINUOUS', '70', '64', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0', '0', 'ENDTAB',
                '0', 'TABLE', '2', 'LAYER', '70', String(layers.length)];
            layers.forEach(function (ly) { head.push('0', 'LAYER', '2', ly[0], '70', '0', '62', String(ly[1]), '6', 'CONTINUOUS'); });
            head.push('0', 'ENDTAB',
                '0', 'TABLE', '2', 'STYLE', '70', '1',
                '0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0.0', '41', '1.0', '50', '0.0', '71', '0', '42', '0.2', '3', 'txt', '4', '', '0', 'ENDTAB',
                '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
            return head.join('\r\n') + '\r\n';
        }
        var _DXF_FOOT = '0\r\nENDSEC\r\n0\r\nEOF\r\n';

        // Ligne de terrain : altitude médiane des points « sol » (classe 2) par pas de 25 cm au moins le long du tracé.
        // Sans aucun point classé sol dans le couloir : point le plus bas affiché de chaque pas.
        function _groundLine(p) {
            var bin = Math.max(0.25, p.L / 4000), nb = Math.floor(p.L / bin) + 1, cells = new Array(nb), ground = false, i, k;
            for (i = 0; i < p.n && !ground; i++) { ground = p.c[i] === 2; }
            for (i = 0; i < p.n; i++) {
                if (ground ? p.c[i] !== 2 : !_pointShown(p, i)) { continue; }
                k = Math.min(nb - 1, Math.floor(p.s[i] / bin));
                (cells[k] || (cells[k] = [])).push(p.z[i]);
            }
            var pts = [];
            for (k = 0; k < nb; k++) {
                var c = cells[k];
                if (!c) { continue; }
                c.sort(function (a, b) { return a - b; });
                pts.push([Math.min(p.L, (k + 0.5) * bin), ground ? c[c.length >> 1] : c[0]]);
            }
            return { pts: pts, ground: ground };
        }

        var _DXF_SECTION_MAX_POINTS = 200000;

        // Dessin de la coupe : X = distance le long du tracé, Y = altitude, à l'échelle 1:1.
        function _exportDxfSection() {
            var p = _prof, sc = _currentScope;
            if (!p || !p.n || !p.nv || !p.lut || !sc) { return; }
            var d = _dxf(), L = p.L, th = Math.min(2, Math.max(0.15, L / 150));
            d.layer('PROFIL_CADRE', 8); d.layer('PROFIL_TERRAIN', 30); d.layer('PROFIL_SOMMETS', 5);
            d.layer('PROFIL_PENTES', 2); d.layer('PROFIL_NUAGE', 9); d.layer('PROFIL_MNT', 40); d.layer('PROFIL_MNS', 4);
            function fx(v, step) { return v.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2); }

            // cadre gradué
            var zs = _niceStep(Math.max(1, p.zmax - p.zmin), 6), xs = _niceStep(L, 10);
            var zb = Math.floor(p.zmin / zs) * zs, zt = Math.ceil(p.zmax / zs) * zs, t;
            if (zt <= zb) { zt = zb + zs; }
            d.polyline('PROFIL_CADRE', [[0, zb], [L, zb], [L, zt], [0, zt], [0, zb]]);
            for (t = zb; t <= zt + 1e-6; t += zs) {
                if (t > zb + 1e-6 && t < zt - 1e-6) { d.line('PROFIL_CADRE', 0, t, 0, L, t, 0); }
                d.text('PROFIL_CADRE', -th, t - th / 2, th, fx(t, zs), 2);
            }
            for (t = 0; t <= L + 1e-6; t += xs) {
                d.line('PROFIL_CADRE', t, zb, 0, t, zb - th / 2, 0);
                d.text('PROFIL_CADRE', t, zb - 2 * th, th, fx(t, xs), 1);
            }
            var gl = _groundLine(p);
            d.text('PROFIL_CADRE', 0, zt + 3.5 * th, th,
                'Profil LiDAR HD IGN - dalle ' + (sc.tile ? sc.tile.name : '') + ' - longueur ' + L.toFixed(2) + ' m - epaisseur ' +
                (2 * (Number(sc.profile.halfWidth) || 5)).toFixed(2) + ' m - distances et altitudes (NGF-IGN69) en metres, echelle 1:1 - ' +
                (p.mode === 'exact' ? 'pleine densite' : 'apercu') + (gl.ground ? '' : ' - terrain : points bas (aucun point classe sol)'), 0);

            // sommets du tracé et pentes du terrain entre sommets
            (p.nodes || []).forEach(function (nd, i) {
                d.line('PROFIL_SOMMETS', nd.s, zb, 0, nd.s, zt, 0);
                d.text('PROFIL_SOMMETS', nd.s, zt + 0.5 * th, th, 'S' + (i + 1) + (nd.z === null ? '' : ' z=' + nd.z.toFixed(2)), 1);
            });
            (p.slopes || []).forEach(function (sl, g) {
                if (!sl) { return; }
                var a = p.nodes[g], b = p.nodes[g + 1];
                d.line('PROFIL_PENTES', a.s, a.z, 0, b.s, b.z, 0);
                d.text('PROFIL_PENTES', (a.s + b.s) / 2, Math.max(a.z, b.z) + th, th, (sl.pct > 0 ? '+' : '') + sl.pct.toFixed(1) + ' %', 1);
            });

            d.polyline('PROFIL_TERRAIN', gl.pts);
            // courbes du sol (MNT) et de la surface (MNS) de l'IGN, si le profil les affiche : un tronçon par suite de valeurs connues
            if (_curvesOn()) {
                var cu = _profCurves(p);
                [['PROFIL_MNT', cu.zg, cu.hasG], ['PROFIL_MNS', cu.zs, cu.hasS]].forEach(function (cv) {
                    if (!cv[2]) { return; }
                    var run = [];
                    for (var q = 0; q <= cu.n; q++) {
                        if (q < cu.n && cv[1][q] === cv[1][q]) { run.push([Math.min(L, q * cu.step), cv[1][q]]); continue; }
                        if (run.length > 1) { d.polyline(cv[0], run); }
                        run = [];
                    }
                });
            }
            // points du couloir (classes et tranche d'altitude affichées), éclaircis au-delà de 200 000
            var step = Math.ceil(p.nv / _DXF_SECTION_MAX_POINTS), seen = 0;
            for (var i = 0; i < p.n; i++) {
                if (!_pointShown(p, i)) { continue; }
                if (seen++ % step === 0) { d.point('PROFIL_NUAGE', p.s[i], p.z[i], 0); }
            }
            _downloadBlob(d.blob(), _exportBase() + '_coupe.dxf');
        }

        // Points affichés en 3D géoréférencé (Lambert-93, altitude NGF), un calque par classe, plus le tracé.
        var _DXF_CLASS_COLORS = { 2: 32, 3: 92, 4: 94, 5: 96, 6: 1, 9: 5, 17: 6 };
        function _exportDxfPoints() {
            var p = _prof, sc = _currentScope;
            if (!p || !p.n || !p.nv || !p.x || !p.lut || !sc) { return; }
            var crs = sc.profile.dxfCrs, ci = _CRS_LIST.filter(function (c) { return c.code === crs; })[0] || _CRS_LIST[0];
            var conv = ci.code === 'EPSG:2154' ? null : proj4('EPSG:2154', ci.code);
            function xy(x, y) { return conv ? conv.forward([x, y]) : [x, y]; }
            var d = _dxf(ci.code === 'EPSG:4326' ? 9 : 3), names = {}, i, q;
            for (i = 0; i < p.n; i++) {
                if (_pointShown(p, i) && !names[p.c[i]]) { names[p.c[i]] = 'LIDAR_CLASSE_' + (p.c[i] < 10 ? '0' : '') + p.c[i]; }
            }
            d.layer('PROFIL_TRACE', 5);
            Object.keys(names).forEach(function (c) { d.layer(names[c], _DXF_CLASS_COLORS[c] || 8); });
            d.polyline('PROFIL_TRACE', p.P.map(function (q, k) {
                var nd = p.nodes && p.nodes[k];
                var t = xy(q[0], q[1]);
                return [t[0], t[1], nd && nd.z !== null ? nd.z : p.zmin];
            }), true);
            for (i = 0; i < p.n; i++) {
                if (_pointShown(p, i)) { q = xy(p.x[i], p.y[i]); d.point(names[p.c[i]], q[0], q[1], p.z[i]); }
            }
            _downloadBlob(d.blob(), _exportBase() + '_points3d_' + ci.short + '.dxf');
        }

        // Point affiché ? Classe visible et, si le filtre est actif, altitude dans la tranche (comme dans la vue 3D).
        function _pointShown(p, i) {
            if (p.lut.vis[p.c[i]] !== 1 || (p.zf && (p.z[i] < p.zf[0] || p.z[i] > p.zf[1]))) { return false; }
            if (p.hf) {   // sol inconnu (hauteur NaN) : le point reste affiché
                var h = _profHag(p)[i];
                if (h === h && (h < p.hf[0] || h > p.hf[1])) { return false; }
            }
            return true;
        }

        // Hauteur au-dessus du sol de chaque point du profil (calculée une fois, à la demande).
        function _profHag(p) {
            if (!p.hag) {
                var a = new Float32Array(p.n);
                for (var i = 0; i < p.n; i++) { var g = _groundAt(p.x[i], p.y[i]); a[i] = g === g ? p.z[i] - g : NaN; }
                p.hag = a;
            }
            return p.hag;
        }

        // Affiche le graphique de base, plus le repère du point survolé et la mesure en cours.
        function _paintProfile(hit, cp) {
            var cv = _profCanvas, p = _prof;
            if (!cv || !_profBase || !p || !p.plot) { return; }
            var g = cv.getContext('2d'), pl = p.plot, d = pl.dpr;
            function xy(h) { return [pl.mL + (h.s - pl.s0) * pl.kx, pl.mT + pl.h - (h.z - pl.zlo) * pl.kz]; }
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.drawImage(_profBase, 0, 0);
            g.save();
            g.beginPath(); g.rect(pl.mL, pl.mT, pl.w, pl.h); g.clip();   // repères hors de la fenêtre du zoom masqués
            if (p.m && p.m.a) {
                var a = xy(p.m.a), b = p.m.b && xy(p.m.b);
                if (b) {
                    g.strokeStyle = '#ffb020'; g.lineWidth = 2 * d; g.setLineDash([6 * d, 4 * d]);
                    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
                    g.strokeStyle = 'rgba(255,176,32,0.45)'; g.lineWidth = d;   // écarts horizontal et vertical
                    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
                }
                [[a, '#2f81f7'], [b, '#ffb020']].forEach(function (e) {
                    if (!e[0]) { return; }
                    g.fillStyle = '#fff'; g.strokeStyle = e[1]; g.lineWidth = 2.5 * d;
                    g.beginPath(); g.arc(e[0][0], e[0][1], 5 * d, 0, 2 * Math.PI); g.fill(); g.stroke();
                });
            }
            if (cp) {   // repère sur les courbes (hit ou non) : trait vertical et un point sur chaque courbe
                var cx = pl.mL + (cp.s - pl.s0) * pl.kx;
                g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = d;
                g.beginPath(); g.moveTo(cx, pl.mT); g.lineTo(cx, pl.mT + pl.h); g.stroke();
                [[cp.zs, '#5ad1ff'], [cp.zg, '#ff9f1c']].forEach(function (e) {
                    if (e[0] === null) { return; }
                    g.fillStyle = e[1]; g.strokeStyle = '#fff'; g.lineWidth = 1.5 * d;
                    g.beginPath(); g.arc(cx, pl.mT + pl.h - (e[0] - pl.zlo) * pl.kz, 3.5 * d, 0, 2 * Math.PI); g.fill(); g.stroke();
                });
            }
            if (!hit) { g.restore(); return; }
            var h = xy(hit);
            g.strokeStyle = hit.snap ? _CAD_LIMIT_COLOR : 'rgba(255,255,255,0.7)'; g.lineWidth = (hit.snap ? 2.5 : 1) * d;
            g.beginPath(); g.moveTo(h[0], pl.mT); g.lineTo(h[0], pl.mT + pl.h); g.stroke();
            g.fillStyle = '#fff'; g.strokeStyle = hit.snap ? _CAD_LIMIT_COLOR : '#2f81f7'; g.lineWidth = 2 * d;
            g.beginPath(); g.arc(h[0], h[1], 4 * d, 0, 2 * Math.PI); g.fill(); g.stroke();
            g.restore();
        }

        // Point visible du couloir le plus proche du curseur (à 14 px au plus), ou null.
        function _nearestPoint(e) {
            var p = _prof;
            if (!p || !p.plot || !p.n) { return null; }
            var r = _profCanvas.getBoundingClientRect(), pl = p.plot;
            var mx = (e.clientX - r.left) * pl.dpr, my = (e.clientY - r.top) * pl.dpr;
            var best = -1, lim = 14 * pl.dpr, bestD = lim * lim;
            for (var i = 0; i < p.n; i++) {
                var dx = pl.mL + (p.s[i] - pl.s0) * pl.kx - mx;
                if (dx > lim || dx < -lim || !_pointShown(p, i)) { continue; }
                var dy = pl.mT + pl.h - (p.z[i] - pl.zlo) * pl.kz - my, dd = dx * dx + dy * dy;
                if (dd < bestD) { bestD = dd; best = i; }
            }
            if (best < 0) { return null; }
            var gz = _groundAt(p.x[best], p.y[best]);   // hauteur au-dessus du sol ; null si le MNT manque
            return { s: p.s[best], z: p.z[best], c: p.c[best], hag: gz === gz ? p.z[best] - gz : null };
        }

        // Point visé par le curseur : cadastre affiché et à moins de _CAD_SNAP_PX d'une limite ou d'un bord de bâti, il s'y
        // accroche en distance. L'altitude reste celle du nuage à cet endroit (±0,5 m), au plus près du curseur, ce qui
        // permet de viser le sol comme un toit ; sans point, celle du sol (MNT). Sinon, point le plus proche du curseur.
        function _profileHit(e) {
            var hit = _nearestPoint(e), p = _prof;
            if (!p || !p.plot || !p.cad || !_currentScope || !_currentScope.profile.cad) { return hit; }
            var r = _profCanvas.getBoundingClientRect(), pl = p.plot;
            var mx = (e.clientX - r.left) * pl.dpr, my = (e.clientY - r.top) * pl.dpr;
            if (mx < pl.mL || mx > pl.mL + pl.w) { return hit; }
            var t = nearestSnap(p.cad.snaps, pl.s0 + (mx - pl.mL) / pl.kx, _CAD_SNAP_PX * pl.dpr / pl.kx);
            if (!t) { return hit; }
            var best = -1, bestD = Infinity;
            for (var i = 0; i < p.n; i++) {
                if (Math.abs(p.s[i] - t.s) > 0.5 || !_pointShown(p, i)) { continue; }
                var dy = Math.abs(pl.mT + pl.h - (p.z[i] - pl.zlo) * pl.kz - my);
                if (dy < bestD) { bestD = dy; best = i; }
            }
            var q = _pointAt(t.s), gz = _groundAt(q[0], q[1]), hasGround = gz === gz;
            if (best < 0 && !hasGround) { return hit; }
            var z = best >= 0 ? p.z[best] : gz;
            return { s: t.s, z: z, c: best >= 0 ? p.c[best] : null, hag: hasGround ? z - gz : null, snap: _CAD_SNAP_LABELS[t.type] };
        }

        // Position (Lambert-93) du tracé à l'abscisse s
        function _pointAt(s) {
            var segs = _prof.segs, gi = 0;
            while (gi < segs.length - 1 && s > segs[gi + 1].cum) { gi++; }
            var sg = segs[gi], t = Math.min(sg.len, Math.max(0, s - sg.cum));
            return [sg.x + sg.ux * t, sg.y + sg.uy * t];
        }

        // Survol : repère sur le graphique et sur la carte GEO (au pied du point sur le tracé).
        function _onProfileMove(e) {
            if (_profDrag && _profDrag.moved) { return; }   // déplacement de la fenêtre du zoom en cours
            var p = _prof, hit = _profileHit(e), cp = null;
            if (p && p.plot && _curvesOn()) {
                var r = _profCanvas.getBoundingClientRect(), pl = p.plot, mx = (e.clientX - r.left) * pl.dpr;
                var sm = hit ? hit.s : pl.s0 + (mx - pl.mL) / pl.kx;   // sans point proche : abscisse sous le curseur
                if (sm >= 0 && sm <= p.L && mx >= pl.mL && mx <= pl.mL + pl.w) {
                    cp = _curveAt(p, sm);
                    if (cp.zg === null && cp.zs === null) { cp = null; }
                }
            }
            if (!hit && !cp) { _onProfileLeave(); return; }
            var s = hit ? hit.s : cp.s;
            _paintProfile(hit, cp);
            if (hit) { _set3dBall(_ensure3d().probe, hit.s, hit.z); }
            else if (_p3d) { _p3d.probe.visible = false; if (_view) { _refresh3d(); } }
            var o = _profMap && window.ol && _ensureOlLayer();
            if (o) {
                _replaceFeature(o.source, 'probe',
                    new window.ol.Feature({ geometry: new window.ol.geom.Point(_toMapCoord(_pointAt(s), o.map)), kind: 'probe' }));
            }
            var hv = { s: s, snap: hit && hit.snap || null, z: hit ? hit.z : null,
                       cls: !hit ? null : hit.c === null ? 'Sol (MNT)' : (_CLASS_NAMES[hit.c] || ('Classe ' + hit.c)),
                       hag: hit ? hit.hag : null, zg: cp ? cp.zg : null, zs: cp ? cp.zs : null, hs: cp ? cp.hs : null };
            if (_currentScope) { _currentScope.$applyAsync(function () { _currentScope.profile.hover = hv; }); }
        }

        function _onProfileLeave() {
            _paintProfile(null);
            _removeKind('probe');
            if (_p3d) { _p3d.probe.visible = false; if (_view) { _refresh3d(); } }
            if (_currentScope) { _currentScope.$applyAsync(function () { _currentScope.profile.hover = null; }); }
        }

        // Mesure : deux clics sur le graphique (points du nuage), un troisième recommence. Réservée à la pleine
        // densité : sur l'aperçu, la densité variable fausserait les écarts.
        function _onProfileClick(e) {
            var p = _prof;
            if (_profDragged) { _profDragged = false; return; }
            if (!p || p.mode !== 'exact') { return; }
            var hit = _profileHit(e);
            if (!hit) { return; }
            if (!p.m || p.m.b) { _clear3dMeasure(); p.m = { a: hit, b: null }; } else { p.m.b = hit; }
            _set3dMeasure(p.m);
            var meas = null;
            if (p.m.b) {
                var ds = p.m.b.s - p.m.a.s, dz = p.m.b.z - p.m.a.z;
                meas = { ds: Math.abs(ds), dz: dz, dist3d: Math.hypot(ds, dz), hA: p.m.a.hag, hB: p.m.b.hag,
                         slope: Math.abs(ds) > 0.01 ? 100 * dz / Math.abs(ds) : null,
                         angle: Math.abs(ds) > 0.01 ? Math.atan2(dz, Math.abs(ds)) * 180 / Math.PI : (dz >= 0 ? 90 : -90) };
            }
            _paintProfile(null);
            if (_currentScope) { _currentScope.$applyAsync(function () { _currentScope.profile.measure = meas; _currentScope.profile.measuring = !!(p.m && !p.m.b); }); }
        }

        function _bindProfileCanvas(cv) {
            if (!cv) { return; }
            _profCanvas = cv;
            var onResize = function () { _drawProfile(); };
            cv.addEventListener('mousemove', _onProfileMove);
            cv.addEventListener('mouseleave', _onProfileLeave);
            cv.addEventListener('click', _onProfileClick);
            cv.addEventListener('wheel', _onProfileWheel, { passive: false });
            cv.addEventListener('mousedown', _onProfileDown);
            window.addEventListener('resize', onResize);
            // Agrandissement du profil, panneau élargi : le graphique se redessine à sa nouvelle taille.
            var obs = null, lastW = 0, lastH = 0;
            if (window.ResizeObserver && cv.parentElement) {
                obs = new window.ResizeObserver(function (entries) {
                    var c = entries[0].contentRect;
                    if (c.width === lastW && c.height === lastH) { return; }
                    lastW = c.width; lastH = c.height;
                    _drawProfileSoon();
                });
                obs.observe(cv.parentElement);
            }
            _profHandlers = { onResize: onResize, obs: obs };
        }

        function _unbindProfileCanvas() {
            if (_profCanvas) {
                _profCanvas.removeEventListener('mousemove', _onProfileMove);
                _profCanvas.removeEventListener('mouseleave', _onProfileLeave);
                _profCanvas.removeEventListener('click', _onProfileClick);
                _profCanvas.removeEventListener('wheel', _onProfileWheel);
                _profCanvas.removeEventListener('mousedown', _onProfileDown);
            }
            _onProfileUp();
            if (_profRaf) { window.cancelAnimationFrame(_profRaf); _profRaf = 0; }
            _stopExact(false);
            if (_profHandlers) {
                window.removeEventListener('resize', _profHandlers.onResize);
                if (_profHandlers.obs) { _profHandlers.obs.disconnect(); }
            }
            if (_profTimer) { clearTimeout(_profTimer); _profTimer = null; }
            _profCanvas = null; _profBase = null; _profHandlers = null; _prof = null;
        }

        // ============================================================
        // Styles (préfixe geo-lidar-)
        // ============================================================
        // Icône Lucide « scan-box » (https://lucide.dev/icons/scan-box, licence ISC), appliquée en masque CSS :
        // elle prend la couleur du texte de l'onglet (actif/survol) comme les icônes natives GEO.
        var _SCAN_BOX = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M12 12v5.5%22/%3E%3Cpath d=%22M17 3h2a2 2 0 012 2v2%22/%3E%3Cpath d=%22M21 17v2a2 2 0 01-2 2h-2%22/%3E%3Cpath d=%22M3 7V5a2 2 0 012-2h2%22/%3E%3Cpath d=%22M7 21H5a2 2 0 01-2-2v-2%22/%3E%3Cpath d=%22M7.264 9.252 12 12l4.737-2.748%22/%3E%3Cpath d=%22M7.995 8.514A2 2 0 007 10.244v3.516a2 2 0 00.996 1.73l3 1.74a2 2 0 002.008 0l3-1.74A2 2 0 0017 13.76v-3.517a2 2 0 00-.995-1.73l-3-1.742a2 2 0 00-1.892-.064z%22/%3E%3C/svg%3E";

        function _injectStyles() {
            if (document.getElementById('geo-lidar-styles')) { return; }
            var style = document.createElement('style');
            style.id = 'geo-lidar-styles';
            style.textContent = [
                // Le masque est sur ::before : l'élément hôte est aussi le .launcher-icon de GEO (taille imposée
                // par le thème). 1em suit le font-size du contexte (barre latérale 30px, en-tête du panneau…).
                '.geo-lidar-icon::before{content:"";display:block;width:1em;height:1em;margin:0 auto;background-color:currentColor;',
                '  -webkit-mask:url("' + _SCAN_BOX + '") center/contain no-repeat;mask:url("' + _SCAN_BOX + '") center/contain no-repeat}',
                // Les panneaux (Style, Filtres, Export du terrain) s'arrêtent à gauche de la barre verticale de commandes :
                // 8 px de marge + 42 px de large + 8 px d'espace.
                '.geo-lidar-panel{position:absolute;top:var(--geo-lidar-top,60px);right:58px;width:270px;max-height:calc(100% - var(--geo-lidar-top,60px) - 80px);overflow-y:auto;',
                '  background:#1e1e1e;color:#c8c8c8;border-radius:4px;font-size:12px;z-index:10}',
                '.geo-lidar-panel-title{padding:7px 10px;font-weight:bold;color:#eee;background:#141414}',
                '.geo-lidar-clickable{cursor:pointer}',
                '.geo-lidar-row{display:flex;align-items:center;gap:8px;padding:4px 10px}',
                '.geo-lidar-row>span{flex:0 0 100px}',
                '.geo-lidar-row input[type=range]{flex:1;min-width:0}',
                '.geo-lidar-row em{flex:0 0 34px;font-style:normal;color:#2cc9ff;text-align:right}',
                '.geo-lidar-row--cache em{flex:1 1 auto;text-align:left}',
                '.geo-lidar-row select{flex:1;color:#000}',
                '.geo-lidar-presets{display:flex;flex-wrap:wrap;gap:4px;padding:6px 10px 2px}',
                '.geo-lidar-btn.geo-lidar-btn--small{padding:2px 8px;font-size:12px;border-radius:6px;background:rgba(255,255,255,.12);color:#e6e8eb}',
                '.geo-lidar-row--maq-vid .geo-lidar-btn,.geo-lidar-row--maq-orbit .geo-lidar-btn{white-space:nowrap;flex:0 0 auto}',
                '.geo-lidar-btn.geo-lidar-btn--small:hover{background:rgba(255,255,255,.22)}',
                '.geo-lidar-panel--filters{width:290px}',
                '.geo-lidar-panel--mnt{width:340px}',
                '.geo-lidar-panel--maq{width:310px}',
                '.geo-lidar-maq-slider{display:flex;align-items:center;gap:8px;padding:8px 10px 2px}',
                '.geo-lidar-maq-slider>span{flex:none;font-size:11px;color:#9aa0a6}',
                '.geo-lidar-maq-slider input{flex:1;min-width:0}',
                // Légende de la coloration par hauteur au sol (curseur = hauteur du rouge)
                '.geo-lidar-legend{position:absolute;left:8px;bottom:96px;z-index:10;width:190px;padding:8px 10px;background:rgba(27,31,36,.9);border-radius:8px;font-size:12px}',
                '.geo-lidar-legend-bar{height:10px;margin:6px 0 2px;border-radius:5px;background:linear-gradient(90deg,#21338c,#1aa6cc 25%,#4dc74d 50%,#f5d933 75%,#d92626)}',
                '.geo-lidar-legend-scale{display:flex;justify-content:space-between;color:#aeb4bb;font-size:11px}',
                // Onglets du panneau Filtres (Altitude / Hauteur au sol) ; le point signale un filtre ou une coloration actifs
                '.geo-lidar-tabs{display:flex;gap:2px;padding:6px 8px 0;background:#141414}',
                '.geo-lidar-tabs button{flex:1;padding:6px 4px;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;',
                '  background:#262626;color:#aeb4bb;font-size:12px;cursor:pointer}',
                '.geo-lidar-tabs button:hover{color:#fff}',
                '.geo-lidar-tabs button.geo-lidar-on{background:#1e1e1e;color:#fff;border-bottom-color:#2f81f7}',
                '.geo-lidar-tb--icon{position:relative}',
                '.geo-lidar-dot--new{background:#d93025}',
                '.geo-lidar-tb--icon .geo-lidar-dot--new{position:absolute;top:3px;right:3px;margin:0;width:8px;height:8px}',
                '.geo-lidar-help-link{margin-right:auto;background:none;border:0;padding:0;cursor:pointer;color:#2cc9ff;font:inherit;font-size:12px}',
                '.geo-lidar-help-link:hover{text-decoration:underline}',
                '.geo-lidar-dot{display:inline-block;width:6px;height:6px;margin-left:5px;border-radius:50%;background:#2f81f7;vertical-align:1px}',
                // Couche posée sur la vue 3D pendant un tracé sur la carte : consigne visible, clics 3D (pointage) bloqués
                '.geo-lidar-drawmask{position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:64px 60px 16px 12px;',
                '  background:rgba(20,24,30,.72);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);cursor:not-allowed}',
                '.geo-lidar-drawcard{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:300px;padding:18px 20px;',
                '  text-align:center;line-height:1.45;color:#e6e8eb;background:rgba(27,31,36,.95);border:2px solid #ffb020;border-radius:12px;cursor:default}',
                '.geo-lidar-drawcard strong{font-size:16px;color:#ffb020}',
                '.geo-lidar-drawcard b{color:#fff}',
                '.geo-lidar-drawcard-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}',
                '.geo-lidar-opts-actions{gap:6px 8px}',
                '.driver-popover.geo-lidar-tour{color:#2d2d2d;font-size:13px;line-height:1.45;max-width:320px;font-family:inherit}',
                '.driver-popover.geo-lidar-tour .driver-popover-title{font-size:15px;font-weight:600}',
                '.driver-popover.geo-lidar-tour .driver-popover-description{color:#444}',
                '.driver-popover.geo-lidar-tour .driver-popover-navigation-btns button{text-shadow:none;font-size:12px}',
                '.geo-lidar-drawarrow .geo-lidar-i{width:44px;height:44px;color:#ffb020;animation:geo-lidar-nudge 1s ease-in-out infinite}',
                '@keyframes geo-lidar-nudge{50%{transform:translateX(-8px)}}',
                '.geo-lidar-panel-title .geo-lidar-x{float:right;margin:-3px -4px 0 0}',
                '.geo-lidar-mnt-text{padding:5px 10px;line-height:1.45;color:#aeb4bb}',
                '.geo-lidar-mnt-text b{color:#2cc9ff}',
                '.geo-lidar-mnt-warn,.geo-lidar-mnt-text.geo-lidar-mnt-warn{color:#ffb020}',
                '.geo-lidar-mnt-bar{margin:2px 10px 6px}',
                '.geo-lidar-mnt-hint{font-size:11px;color:#8b929a}',
                '.geo-lidar-dxf-crs{color:#000;border-radius:8px;padding:4px 6px;max-width:150px}',
                '.geo-lidar-panel--mnt .geo-lidar-row select{min-width:0}',
                '.geo-lidar-num{width:64px;color:#000;border-radius:6px;padding:3px 6px}',
                '.geo-lidar-panel--mnt .geo-lidar-tabs{margin-top:6px}',
                '.geo-lidar-panel--mnt .geo-lidar-classes{display:grid;grid-template-columns:1fr 1fr;column-gap:8px}',
                '.geo-lidar-mnt-actions{justify-content:flex-end;padding:8px 10px}',
                '.geo-lidar-classes{padding:4px 10px 8px}',
                '.geo-lidar-classes label{display:flex;align-items:center;gap:6px;margin:2px 0;font-weight:normal}',
                '.geo-lidar-swatch{display:inline-block;width:12px;height:12px;border-radius:2px;border:1px solid #666}',
                '.geo-lidar-help{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:20;width:min(430px,calc(100% - 32px));',
                '  max-height:calc(100% - 32px);overflow-y:auto;background:#1e1e1e;color:#d4d4d4;border-radius:6px;font-size:13px;',
                '  box-shadow:0 6px 28px rgba(0,0,0,.45)}',
                '.geo-lidar-help-title{padding:10px 14px;font-weight:bold;font-size:15px;color:#fff;background:#141414;border-radius:6px 6px 0 0}',
                '.geo-lidar-help-body{padding:6px 14px 2px}',
                '.geo-lidar-help-body h4{margin:10px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#2cc9ff}',
                '.geo-lidar-help-body ul{margin:0;padding-left:18px}',
                '.geo-lidar-help-body li{margin:3px 0}',
                '.geo-lidar-help-note{margin:10px 0 4px;color:#9aa0a6}',
                '.geo-lidar-help-actions{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px}',
                '.geo-lidar-btn.geo-lidar-btn--ghost{background:transparent;border:1px solid #666;color:#d4d4d4}',
                // Boutons de commande : verre dépoli sombre, icônes Lucide, état actif en bleu
                '.geo-lidar-i{width:18px;height:18px;flex:none;vertical-align:-4px}',
                '.geo-lidar-help-body .geo-lidar-i{width:15px;height:15px;vertical-align:-3px;margin:0 1px}',
                '.geo-lidar-sep{display:block;flex:none;background:rgba(255,255,255,.14)}',
                '.geo-lidar-nav{position:absolute;right:8px;bottom:8px;z-index:10;display:flex;flex-direction:column;align-items:center;gap:2px;',
                '  padding:4px;background:rgba(20,24,30,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
                '  border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.3)}',
                '.geo-lidar-nav .geo-lidar-sep{width:20px;height:1px;margin:3px 0}',
                '.geo-lidar-nav button{display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:0;',
                '  border-radius:8px;color:#e6e8eb;background:transparent;cursor:pointer;transition:background .15s,color .15s}',
                '.geo-lidar-nav button:hover{background:rgba(255,255,255,.14)}',
                '.geo-lidar-nav button:active{background:rgba(255,255,255,.22)}',
                '.geo-lidar-nav button.geo-lidar-on{background:#2f81f7;color:#fff}',
                // Le conteneur de GEO défile dès 4 px de trop, alors que le module occupe exactement sa hauteur (#4). Le sélecteur ne vise que ce module.
                '.side-panel-extension.geo_lidar_hd .extensions-content.scroll-extension{overflow:hidden;overflow:clip}',
                '.geo-lidar-widget{position:relative;width:100%;height:100%;min-height:0;background:#1b1f24;color:#e6e8eb;font-size:13px}',
                '.geo-lidar-view{position:absolute;inset:0;isolation:isolate}',  // iTowns y ajoute des calques en z-index:1
                '.geo-lidar-toolbar,.geo-lidar-info,.geo-lidar-center{z-index:10}',
                '.geo-lidar-toolbar{position:absolute;top:8px;left:8px;display:flex;gap:2px;align-items:center;flex-wrap:wrap;max-width:calc(100% - 16px);',
                '  padding:4px;background:rgba(20,24,30,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
                '  border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.3)}',
                '.geo-lidar-toolbar .geo-lidar-sep{width:1px;height:20px;margin:0 4px}',
                '.geo-lidar-tb-select{display:flex;gap:8px;align-items:center;margin:0 2px 0 8px;font-weight:normal;color:#9aa0a6}',
                '.geo-lidar-toolbar select{color:#e6e8eb;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);',
                '  border-radius:8px;padding:5px 8px;font-size:13px}',
                '.geo-lidar-toolbar select option{color:#000}',
                '.geo-lidar-tb{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:0;border-radius:8px;',
                '  color:#e6e8eb;background:transparent;font-size:13px;cursor:pointer;transition:background .15s,color .15s}',
                '.geo-lidar-tb--icon{width:34px;padding:0;justify-content:center}',
                '.geo-lidar-tb>span{display:inline-flex;align-items:center}',
                '.geo-lidar-tb:hover{background:rgba(255,255,255,.14)}',
                '.geo-lidar-tb.geo-lidar-on{background:#2f81f7;color:#fff}',
                '.geo-lidar-tb[disabled]{opacity:.4;cursor:default;background:transparent}',
                '.geo-lidar-btn{display:inline-flex;align-items:center;gap:6px;background:#2f81f7;color:#fff;border:0;border-radius:8px;',
                '  padding:5px 12px;cursor:pointer}',
                '.geo-lidar-btn[disabled]{opacity:.45;cursor:default}',
                '.geo-lidar-info{position:absolute;left:8px;bottom:8px;display:flex;align-items:flex-end;gap:8px}',
                '.geo-lidar-info-body{padding:6px 10px;background:rgba(27,31,36,.85);border-radius:6px}',
                '.geo-lidar-info-badge{position:relative;flex:none;width:34px;height:34px}',
                '.geo-lidar-around-ring{position:absolute;top:-5px;left:-5px;width:44px;height:44px;pointer-events:none;',
                '  animation:geo-lidar-spin 1.4s linear infinite}',
                '.geo-lidar-around-track,.geo-lidar-around-arc{fill:none;stroke-width:3}',
                '.geo-lidar-around-track{stroke:rgba(20,24,30,.55)}',
                '.geo-lidar-around-arc{stroke:#2f81f7;stroke-linecap:round;transition:stroke-dasharray .3s}',
                '@media (prefers-reduced-motion:reduce){.geo-lidar-around-ring{animation:none}}',
                '.geo-lidar-info-btn{display:flex;flex:none;align-items:center;justify-content:center;width:34px;height:34px;padding:0;',
                '  border:1px solid rgba(255,255,255,.1);border-radius:50%;color:#e6e8eb;background:rgba(20,24,30,.78);cursor:pointer;',
                '  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 4px 16px rgba(0,0,0,.3);transition:background .15s}',
                '.geo-lidar-info-btn:hover{background:rgba(60,66,76,.9)}',
                '.geo-lidar-info-btn.geo-lidar-on{background:#2f81f7;color:#fff}',
                '.geo-lidar-info a{color:#79b8ff}',
                '.geo-lidar-pick{position:absolute;left:8px;top:var(--geo-lidar-top,60px);z-index:11;padding:8px 30px 8px 10px;background:rgba(27,31,36,.92);border-radius:8px;line-height:1.5}',
                '.geo-lidar-pick>.geo-lidar-x{position:absolute;top:4px;right:4px}',
                '.geo-lidar-pick b{color:#ffb020;font-size:15px}',
                '.geo-lidar-pick-xy{font-variant-numeric:tabular-nums}',
                '.geo-lidar-pick-opts{display:flex;gap:6px;align-items:center;margin-top:4px}',
                '.geo-lidar-pick-opts select{color:#000}',
                '.geo-lidar-spinner{width:28px;height:28px;margin:0 auto;border:3px solid rgba(255,255,255,.25);',
                '  border-top-color:#fff;border-radius:50%;animation:geo-lidar-spin .8s linear infinite}',
                '@keyframes geo-lidar-spin{to{transform:rotate(360deg)}}',
                '.geo-lidar-bar{height:6px;margin-top:8px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden}',
                '.geo-lidar-bar>div{height:100%;background:#2f81f7;transition:width .3s}',
                '.geo-lidar-btn--on{background:#e5484d}',
                '.geo-lidar-profile{position:absolute;left:8px;right:58px;bottom:8px;z-index:12;background:rgba(27,31,36,.95);',
                '  border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,.4)}',
                '.geo-lidar-profile-head{display:flex;align-items:center;gap:10px;padding:6px 10px;background:#141414;border-radius:6px 6px 0 0}',
                '.geo-lidar-profile-head .geo-lidar-chip{background:rgba(255,255,255,.06);padding:2px 8px}',
                '.geo-lidar-profile-sum{flex:1;color:#9aa0a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
                '.geo-lidar-badge{padding:1px 8px;border-radius:9px;background:#8a6d00;color:#ffe08a;font-size:11px}',
                '.geo-lidar-x{display:inline-flex;border:0;background:transparent;color:#d4d4d4;cursor:pointer;padding:2px;border-radius:6px}',
                '.geo-lidar-x:hover{background:rgba(255,255,255,.14)}',
                '.geo-lidar-profile-plot{position:relative;height:216px}',
                '.geo-lidar-widget--tall .geo-lidar-profile{top:var(--geo-lidar-top,60px);display:flex;flex-direction:column}',
                '.geo-lidar-widget--tall .geo-lidar-profile>*{flex:none}',
                '.geo-lidar-widget--tall .geo-lidar-profile>.geo-lidar-profile-plot{flex:1 1 0;min-height:0;height:auto}',
                '.geo-lidar-widget--tall .geo-lidar-profile-canvas{position:absolute;inset:0}',
                '.geo-lidar-widget--tall .geo-lidar-panel{z-index:13}',   // Style, Filtres… restent au-dessus du profil agrandi
                '.geo-lidar-profile-canvas{display:block;width:100%;height:100%;cursor:crosshair}',
                '.geo-lidar-profile-reset{position:absolute;top:6px;right:8px}',
                '.geo-lidar-profile-reset .geo-lidar-i{width:14px;height:14px}',
                '.geo-lidar-profile-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
                '  padding:0 24px;text-align:center;color:#c8c8c8;pointer-events:none}',
                // Pastilles d'information (en-tête, bandeau de lecture) : libellé discret, valeur en gras, chiffres alignés
                '.geo-lidar-chips{display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}',
                '.geo-lidar-chips::-webkit-scrollbar{display:none}',
                '.geo-lidar-chip{display:inline-flex;align-items:baseline;gap:5px;flex:none;padding:3px 9px;border-radius:999px;',
                '  background:rgba(255,255,255,.08);font-variant-numeric:tabular-nums;white-space:nowrap}',
                '.geo-lidar-chip em{font-style:normal;font-size:11px;color:#9aa0a6}',
                '.geo-lidar-chip b{color:#fff;font-weight:600}',
                '.geo-lidar-chip--meas b{color:#ffb020}',
                '.geo-lidar-chip--hl{background:rgba(90,209,255,.16)}',
                '.geo-lidar-chip--hl b{color:#5ad1ff}',
                '.geo-lidar-sw{display:inline-block;align-self:center;width:12px;height:3px;border-radius:2px}',
                '.geo-lidar-sw--g{background:#ff9f1c}.geo-lidar-sw--s{background:#5ad1ff}',
                '.geo-lidar-sw--a,.geo-lidar-sw--b{width:9px;height:9px;border-radius:50%;background:#fff}',
                '.geo-lidar-sw--a{border:2px solid #2f81f7}.geo-lidar-sw--b{border:2px solid #ffb020}',
                // Bandeau de lecture : hauteur fixe pour que le graphique ne bouge pas quand le contenu change
                '.geo-lidar-profile-read{display:flex;align-items:center;height:34px;padding:0 10px;overflow:hidden;white-space:nowrap;',
                '  color:#e6e8eb;background:rgba(255,255,255,.04)}',
                '.geo-lidar-read-note{flex:0 1 auto;min-width:0;margin-left:6px;overflow:hidden;text-overflow:ellipsis;font-size:11px}',
                '.geo-lidar-tb--square{width:30px;padding:0 !important;justify-content:center}',
                '.geo-lidar-read-hint{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis}',
                // Barre de contrôles sous le graphique : affichage à gauche, actions et export à droite
                // Une seule ligne : selon la largeur du panneau, les libellés disparaissent, les infobulles restent.
                '.geo-lidar-profile-opts{display:flex;flex-wrap:nowrap;align-items:center;gap:6px 12px;padding:6px 10px;border-top:1px solid rgba(255,255,255,.08);container-type:inline-size}',
                '.geo-lidar-opts-group{display:flex;flex-wrap:nowrap;flex:0 1 auto;min-width:0;align-items:center;gap:6px 8px}',
                '.geo-lidar-opts-group--end{flex:none;margin-left:auto}',
                '.geo-lidar-opts-group .geo-lidar-tb{flex:none;white-space:nowrap}',
                '@container (max-width:950px){.geo-lidar-opts-group--end .geo-lidar-tb>span{display:none}}',
                '@container (max-width:850px){.geo-lidar-opts-lbl{display:none}}',
                '@container (max-width:710px){.geo-lidar-tb--curves>span,.geo-lidar-tb--cad>span{display:none}.geo-lidar-profile-opts select{max-width:100px}}',
                '@container (max-width:570px){.geo-lidar-profile-opts b,.geo-lidar-tb--scale .geo-lidar-i{display:none}.geo-lidar-profile-opts select{max-width:76px}.geo-lidar-profile-opts input[type=range]{flex:0 1 44px;min-width:32px}.geo-lidar-profile-opts,.geo-lidar-opts-group{column-gap:5px}}',
                '.geo-lidar-chip--snap{color:#c58bff}',
                '.geo-lidar-chip--snap .geo-lidar-i{width:13px;height:13px;margin-right:4px}',
                '.geo-lidar-profile-cadnote{padding:2px 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;color:#9aa0a6;border-top:1px solid rgba(255,255,255,.08)}',
                '.geo-lidar-profile-cadnote b{color:#ff8ad8;font-weight:600}',
                '.geo-lidar-profile-opts label{display:flex;flex:0 1 auto;min-width:0;align-items:center;gap:6px;margin:0;font-weight:normal;color:#aeb4bb;white-space:nowrap}',
                '.geo-lidar-profile-opts label b{color:#fff;font-weight:600}',
                '.geo-lidar-profile-opts select{min-width:0;color:#000;border-radius:6px}',
                '.geo-lidar-profile-opts input[type=range]{flex:0 1 90px;width:90px;min-width:44px}',
                '.geo-lidar-profile-opts .geo-lidar-i{width:16px;height:16px}',
                '.geo-lidar-tb.geo-lidar-tb--small{height:30px;padding:0 9px;font-size:12px;border-radius:8px;background:rgba(255,255,255,.07)}',
                '.geo-lidar-tb.geo-lidar-tb--small:hover{background:rgba(255,255,255,.16)}',
                '.geo-lidar-tb.geo-lidar-tb--small.geo-lidar-on{background:#2f81f7;color:#fff}',
                '.geo-lidar-tb.geo-lidar-tb--small[disabled]{background:rgba(255,255,255,.04)}',
                '.geo-lidar-tb--stop{color:#ffb4b4}',
                // Menu « Exporter » : s'ouvre vers le haut ; le fond transparent referme au clic ailleurs
                '.geo-lidar-menu-wrap{position:relative}',
                '.geo-lidar-menu{position:absolute;right:0;bottom:calc(100% + 6px);z-index:2;min-width:230px;padding:6px;background:#1e2227;',
                '  border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.5)}',
                '.geo-lidar-menu button{display:flex;align-items:baseline;gap:10px;width:100%;padding:6px 8px;border:0;border-radius:6px;',
                '  background:transparent;color:#e6e8eb;text-align:left;cursor:pointer}',
                '.geo-lidar-menu button:hover{background:rgba(255,255,255,.12)}',
                '.geo-lidar-menu button b{flex:0 0 78px;font-weight:600}',
                '.geo-lidar-menu button span{color:#9aa0a6;font-size:11px}',
                '.geo-lidar-menu-crs{display:block !important;margin:4px 0 0 !important;padding:7px 8px 2px;border-top:1px solid rgba(255,255,255,.1);font-size:11px}',
                '.geo-lidar-menu-crs select{display:block;width:100%;margin-top:4px}',
                '.geo-lidar-menu-bg{position:absolute;inset:0;z-index:11}',
                '.geo-lidar-note{color:#9aa0a6}',
                '.geo-lidar-badge--run{background:#1f5fbf;color:#cfe3ff}',
                '.geo-lidar-badge--ok{background:#1e6b3a;color:#c9f2d6}',
                '.geo-lidar-profile-prog{height:3px;background:rgba(255,255,255,.12)}',
                '.geo-lidar-profile-prog>div{height:100%;background:#2f81f7;transition:width .3s}',
                '.geo-lidar-measure b{color:#ffb020}',
                '.geo-lidar-up{bottom:var(--geo-lidar-up,380px) !important}',
                // Messages d'état (invitation, chargement, erreur) : carte centrée dans la vue 3D, sans gêner la souris
                '.geo-lidar-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;',
                '  align-items:center;gap:8px;width:max-content;max-width:min(380px,calc(100% - 32px));min-width:220px;padding:18px 24px;',
                '  line-height:1.45;text-align:center;color:#e6e8eb;pointer-events:none;',
                '  background:rgba(20,24,30,.78);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
                '  border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.3)}',
                '.geo-lidar-center strong{font-size:14px;font-weight:600}',
                '.geo-lidar-center>span:not(.geo-lidar-center-icon){color:#aeb4bb}',
                '.geo-lidar-center-icon .geo-lidar-i{width:34px;height:34px;color:#2cc9ff}',
                '.geo-lidar-center--warn>span:not(.geo-lidar-center-icon){color:#e6e8eb}',
                '.geo-lidar-center--warn .geo-lidar-center-icon .geo-lidar-i{color:#ffb020}',
                '.geo-lidar-center .geo-lidar-bar{align-self:stretch;margin-top:2px}',
                '.geo-lidar-center--up{top:calc((100% - var(--geo-lidar-up,380px)) / 2)}'
            ].join('');
            document.head.appendChild(style);
        }
    }]);
