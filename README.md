# Snapchat P2P - Clone WebRTC Serverless

Clone complet, fonctionnel et visuel de Snapchat, **100 % P2P sans aucun serveur backend**, hébergeable sur **GitHub Pages**, Vercel ou tout hébergement statique.

---

## Fonctionnalités Principales

### 1. Interface & Ergonomie Mobile-First (2 Écrans)
- **Structure épurée à 2 écrans principaux** navigables par swipe tactile (touch events) ou barre de navigation fixe en bas (100dvh, gestion des safe-area-inset) :
  - **Gauche (Chat & Amis)** : Discussions récentes, liste d'amis, section *« Découvrir »* listant en temps réel les pairs en ligne dans le salon, bouton **« + Ami » par pseudo**, et bandeau des demandes d'amis reçues avec boutons Accepter / Refuser.
  - **Droite (Caméra - Écran par défaut au lancement)** : Flux vidéo plein écran (`navigator.mediaDevices.getUserMedia`), bascule caméra avant/arrière, **flash simulé** (flash blanc haute luminosité), **déclencheur photo/vidéo** (clic court = photo, appui long = vidéo jusqu'à 10s avec anneau de progression circulaire), et import de fichier média local.
- **Design Snapchat Sombre & Contrasté** : Jaune Snapchat `#FFFC00`, noir pur `#000000`, safe-area-inset pour iOS/Android, typographie sans-serif nette, angles soignés et icônes d'état authentiques.
- **Zéro Émoji — 100 % Icônes Vectorielles SVG** : Tous les symboles de l'interface (bulles de discussion, appareil photo, flash, bascule, dossier d'import, ajout d'ami, validation, fermeture, minuteur, crayon doodle, annulation, téléchargement, envoi) sont des tracés SVG nets et parfaitement adaptés à tous les écrans Retina et OLED.
- **Éditeur de Snap Post-Capture** :
  - Bandeau de texte Snapchat translucide noir **déplaçable verticalement au doigt/souris**.
  - Dessin libre (Doodle) avec sélecteur de couleurs, taille de trait et bouton Annuler.
  - Sélecteur de minuteur : 1s, 2s, 3s, 5s, 10s, ou ∞ illimité.
  - Bouton Télécharger & Bouton d'envoi vers un ou plusieurs amis.

### 2. Système d'Amis & Demandes par Pseudo
- **Ajout par Pseudo** : Bouton dédié **« + Ami »** permettant de saisir le pseudo d'un utilisateur distant.
- **Handshake de Demande d'Ami P2P** :
  - Dès l'envoi, le destinataire reçoit instantanément une notification visuelle et une carte de demande :
    - Bouton **Accepter** (vert avec coche SVG) : ajoute mutuellement les deux utilisateurs en amis dans leur clé locale respective et ouvre la discussion.
    - Bouton **Refuser** (gris avec croix SVG) : décline la demande.
- **Découvrir en direct** : Liste dynamique des pairs connectés dans le salon avec bouton d'ajout en un clic.

### 3. Système de Compte par « Clé Locale Portable »
- **Création / Connexion** : Écran d'accueil au 1er lancement permettant de créer un profil (pseudo + photo de profil compressée automatiquement en 128x128 WebP/JPEG Base64) OU d'importer une clé existante.
- **Persistance au choix** : Option **« Session temporaire »** (stockage uniquement en RAM, tout est détruit à la fermeture de l'onglet). Sinon, sauvegarde automatique dans IndexedDB (avec miroir localStorage).
- **Export / Import de Clé** :
  - **Exporter ma clé** : Génère un fichier `.json` et un code texte Base64 copiable (`SNAPKEY:...`) contenant l'UUID unique, le pseudo, l'avatar Base64, et la liste d'amis.
  - **Importer une clé** : Restaure instantanément son compte sur n'importe quel PC ou smartphone.

### 4. Réseau P2P & Handshake Automatique (Trystero)
- **Lobby Général + Salons Privés** : Connexion automatique au salon `snap-p2p-global-lobby`, avec possibilité d'entrer n'importe quel code pour basculer ou ouvrir un salon privé.
- **Handshake Automatique** : Dès qu'un pair rejoint le réseau, les clients s'échangent mutuellement leur paquet d'identité (UUID, pseudo, avatar) et mettent à jour leur interface en temps réel.
- **Dual-Sync Résilient** : WebRTC Trystero (stratégie Nostr avec repli Torrent) + `BroadcastChannel` local (découverte instantanée à 0 ms entre plusieurs onglets sur la même machine).

### 5. Messagerie & Snaps Éphémères
- **Chat temps réel** : Messages textes avec indicateur *« en train d'écrire... »*, bordures colorées, et option pour **enregistrer un message dans le chat** (par clic / appui long).
- **Visionneuse de Snap** :
  - Ouverture plein écran avec **compte à rebours circulaire SVG** en haut à droite.
  - À la fin du temps (ou au clic) : **purge immédiate de l'image/vidéo de la mémoire** (`URL.revokeObjectURL` et déréférencement).
  - Envoi automatique d'un accusé de lecture P2P à l'expéditeur et transition immédiate vers l'état *« Ouvert »*.

---

## Lancement Local

Pour tester l'application en local :

```bash
# Avec Python sur le port 3000
python -m http.server 3000

# Ou avec npx serve
npx serve -p 3000 .
```

Puis ouvrez votre navigateur sur `http://localhost:3000`.

> **Test multi-utilisateurs :**
> Ouvrez deux onglets (ou une fenêtre normale et une fenêtre de navigation privée) sur `http://localhost:3000`. Créez deux profils (ex: "Alice" et "Bob").
> 1. Cliquez sur **+ Ami** dans l'onglet d'Alice et tapez "Bob".
> 2. Bob reçoit instantanément la demande d'ami dans sa section dédiée et clique sur **Accepter**.
> 3. Alice et Bob sont désormais amis et peuvent s'envoyer des Snaps et des messages éphémères !

---

## Déploiement sur GitHub Pages

1. Créez un nouveau dépôt sur GitHub (ex: `snap-p2p`).
2. Poussez les fichiers :
   ```bash
   git init
   git add .
   git commit -m "feat: Snapchat P2P clone 100% SVG sans story"
   git branch -M main
   git remote add origin https://github.com/<votre-user>/snap-p2p.git
   git push -u origin main
   ```
3. Dans `Settings` > `Pages`, sélectionnez la branche `main` et le dossier `/ (root)`, puis cliquez sur **Save**.
4. Votre application est immédiatement en ligne à l'adresse : `https://<votre-user>.github.io/snap-p2p/`.
