// Point d'entrée du worker de décodage LAZ d'iTowns. Compilé à part (webpack.worker.config.js)
// puis embarqué en texte dans main.js : le module ne livre ainsi qu'un seul fichier.
import '../../node_modules/itowns/lib/Worker/LASLoaderWorker.js';
