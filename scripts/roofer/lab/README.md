# Essai local des bâtiments LoD2 (centre de Vienne, dalle 0846-6494)

Prépare un fichier `0846-6494.bld` et le sert en local avec CORS, pour essayer la case « Bâtiments LoD2 » de la maquette
dans un vrai GEO. Pipeline et format : [`../README.md`](../README.md) et `GUIDE-DEV.md` (section « Bâtiments LoD2 »).

| Fichier | Rôle |
|---|---|
| `prepare.sh` | télécharge le nuage LiDAR HD et les emprises BD TOPO de la dalle, lance roofer (Docker), convertit en `bld/0846-6494.bld` |
| `serve.py` | sert `bld/` sur `http://localhost:8777` avec CORS (lecture seule, écoute sur 127.0.0.1) |
| `work/`, `bld/` | produits, ignorés par git |

Prérequis : `docker`, `curl`, `python3`, ~1 Go d'espace libre, un accès à `data.geopf.fr` et à Docker Hub.

## 1. Préparer le fichier (une fois, ~2 min + téléchargement de ~290 Mo)

```bash
cd src/modules/geo-lidar-hd/scripts/roofer/lab
./prepare.sh
```

Résultat attendu en fin de script : `environ 1 471 bâtiments et 128 000 triangles (le résultat de roofer varie un peu d'une exécution à l'autre)` et un `bld/0846-6494.bld` d'environ
2,7 Mo. Les lignes « ignorés » (bâtiments sans géométrie, murs d'aire nulle) et l'« ATTENTION : 3 bâtiments sans
GroundSurface » sont normales : voir « Limites » du GUIDE-DEV. Relancer le script ne retélécharge rien ; supprimer `work/`
pour tout refaire.

## 2. Lancer le serveur

```bash
python3 -I serve.py            # port 8777 ; un autre port : python3 -I serve.py 9000
```

Le terminal affiche les fichiers servis. Le laisser ouvert pendant l'essai. Contrôle depuis un autre terminal :

```bash
curl -sI http://localhost:8777/0846-6494.bld
# attendu : HTTP/1.0 200 OK, Access-Control-Allow-Origin: *, Content-Length: ~2,7 Mo
```

## 3. Mettre le module dans GEO

```bash
cd ../../..                    # racine du module (src/modules/geo-lidar-hd)
npm run package                # build + ZIP daté
```

1. Générateur GEO, **ancienne interface** : Modules > + Module, importer le ZIP (nom daté, un ZIP déjà importé est refusé).
2. Dans la configuration du module, groupe « Données LiDAR HD », renseigner **URL des bâtiments LoD2 (prototype)** :
   `http://localhost:8777` (sans `/` final).
3. Enregistrer et republier l'application.

Le navigateur qui ouvre GEO doit tourner **sur la machine où tourne `serve.py`** (`localhost` désigne le poste du navigateur).
Si GEO est en https, Chrome et Edge acceptent `http://localhost` ; Firefox peut le bloquer comme contenu mixte, ce qui se
verrait dans la console.

## 4. Essayer sur le centre-ville de Vienne

1. Ouvrir l'application GEO, ouvrir l'onglet **LiDAR HD**, centrer la carte sur le centre de Vienne (Isère) et cliquer dans la
   dalle **0846-6494** (environ x 846 000–847 000, y 6 493 000–6 494 000 en Lambert-93). Pour un point de contrôle : le secteur
   du théâtre antique et de la cathédrale Saint-Maurice est dans cette dalle.
2. Attendre l'affichage des points, puis ouvrir **Maquette** dans la barre d'outils.
3. La case **Bâtiments LoD2** doit être présente et cochée : les bâtiments apparaissent avec toits en pente et murs gris, à la
   place des rampes. La décocher rend la maquette d'avant.

Ce qu'il faut vérifier, et noter :

| À regarder | Attendu |
|---|---|
| Curseur 100 → 0, puis « Animer » | les bâtiments s'aplatissent sur le terrain et remontent avec lui ; la végétation suit le MNS |
| Relief ×3, texture « Hauteur au sol » / « Grise » | les bâtiments suivent le relief et la texture choisis |
| Rues en pente | murs sans jour ni enfoncement visible au pied (le sol de roofer est plat, le pied est recalé sur le MNT) |
| Autour des bâtiments | pas de liséré de rampe gênant ; pas de morsure sur les trottoirs |
| Fluidité | rotation et zoom sans à-coups (~128 000 triangles de bâtiments) |
| Voisines (bouton « Voisines ») | seules les dalles ayant un `.bld` ont des bâtiments ; les autres restent comme avant, sans message |
| Profil et courbes | inchangés (le profil utilise le MNS d'origine, non masqué) |
| `buildingsUrl` vide | pas de case « Bâtiments LoD2 », comportement identique à la 1.1.2 |

Console du navigateur (F12) : un fichier absent ne doit rien afficher ; une erreur affiche une seule ligne
`[geo-lidar-hd] bâtiments LoD2 de la dalle … ignorés (URL) : …`. Onglet Réseau : un seul `0846-6494.bld` en 200 par dalle.

## En cas de problème

| Symptôme | Piste |
|---|---|
| Pas de case « Bâtiments LoD2 » | `buildingsUrl` vide ou ZIP ancien non remplacé ; republier l'application |
| Case présente, rien ne change, console « ignorés … Failed to fetch » | serveur arrêté, mauvaise URL, ou navigateur sur une autre machine |
| « … ignorés … origine … au lieu de … » | `.bld` produit pour une autre dalle que son nom |
| Murs moucheté ou bâtiments décalés | noter la capture et le niveau de zoom : défaut du rendu à corriger |
| `prepare.sh` : « réponse WFS tronquée » | le WFS a plafonné le nombre d'objets : paginer, voir `../README.md` |
| Docker : `permission denied` sur `work/out` | un ancien passage en root a laissé des fichiers : `sudo rm -rf work/out` |

Pour essayer une autre dalle : adapter `DALLE`, `BBOX`, `COPC` et `WFS` en tête de `prepare.sh` (l'URL du COPC est le champ
`url_npl` du WFS des dalles, voir `../README.md`), puis déposer le `.bld` dans `bld/`.
