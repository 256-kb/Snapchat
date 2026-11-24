/**
 * viewer.js - Visionneuse de Snap & Stories éphémères plein écran
 * - Affichage plein écran (photo ou vidéo) avec bandeau et annotations
 * - Compte à rebours circulaire en haut à droite (SVG ring + secondes)
 * - Purge mémoire immédiate à la fin du temps ou au clic
 * - Envoi de l'accusé de lecture P2P vers l'expéditeur
 * - Transition immédiate vers l'état "Ouvert"
 */

export class SnapViewer {
  constructor() {
    this.container = null;
    this.imgElement = null;
    this.videoElement = null;
    this.bannerElement = null;
    this.bannerText = null;
    this.authorAvatar = null;
    this.authorName = null;
    this.timerSvgRing = null;
    this.timerText = null;

    this.currentSnap = null;
    this.timerInterval = null;
    this.remainingSeconds = 0;
    this.totalDuration = 5;
    this.isOpen = false;

    // Callbacks
    this.onSnapFinished = null; // (snap, purged) => {}
  }

  init(elements) {
    this.container = elements.container;
    this.stage = elements.stage || document.getElementById('viewer-stage');
    this.imgElement = elements.img;
    this.videoElement = elements.video;
    this.bannerElement = elements.banner;
    this.bannerText = elements.bannerText;
    this.authorAvatar = elements.authorAvatar;
    this.authorName = elements.authorName;
    this.timerSvgRing = elements.timerSvgRing;
    this.timerText = elements.timerText;

    // Clic pour passer au suivant ou fermer
    this.container.addEventListener('click', () => {
      this.closeAndPurge();
    });
  }

  /**
   * Ouvre et lance la lecture d'un Snap
   */
  openSnap(snap) {
    if (this.isOpen) {
      this.closeAndPurge();
    }

    this.currentSnap = snap;
    this.isOpen = true;

    if (this.stage) {
      this.stage.classList.remove('landscape');
    }

    // Infos auteur
    if (this.authorName) {
      this.authorName.textContent = snap.senderNickname || 'Ami';
    }
    if (this.authorAvatar && snap.senderAvatar) {
      this.authorAvatar.src = snap.senderAvatar;
      this.authorAvatar.style.display = 'block';
    } else if (this.authorAvatar) {
      this.authorAvatar.style.display = 'none';
    }

    // Affichage média
    if (snap.mediaType === 'video') {
      this.imgElement.style.display = 'none';
      this.imgElement.src = '';
      this.videoElement.onloadedmetadata = () => {
        if (this.stage && this.videoElement.videoWidth > this.videoElement.videoHeight) {
          this.stage.classList.add('landscape');
        }
      };
      this.videoElement.style.display = 'block';
      this.videoElement.src = snap.mediaData;
      this.videoElement.currentTime = 0;
      this.videoElement.play().catch(() => {});
    } else {
      this.videoElement.style.display = 'none';
      this.videoElement.src = '';
      this.imgElement.onload = () => {
        if (this.stage && this.imgElement.naturalWidth > this.imgElement.naturalHeight) {
          this.stage.classList.add('landscape');
        }
      };
      this.imgElement.style.display = 'block';
      this.imgElement.src = snap.mediaData;
    }

    // Bandeau de texte incrusté (pour vidéos notamment)
    if (snap.bannerText && snap.bannerText.trim()) {
      this.bannerText.textContent = snap.bannerText;
      this.bannerElement.style.top = `${snap.bannerY || 50}%`;
      this.bannerElement.classList.remove('hidden');
      this.bannerElement.style.display = 'flex';
    } else {
      this.bannerElement.classList.add('hidden');
      this.bannerElement.style.display = 'none';
    }

    // Durée
    this.totalDuration = snap.timer !== undefined ? Number(snap.timer) : 5;
    this.remainingSeconds = this.totalDuration;

    // Afficher conteneur
    this.container.classList.remove('hidden');
    this.container.style.display = 'flex';

    // Démarrer compte à rebours
    this.startCountdown();
  }

  /**
   * Lance l'animation circulaire du compte à rebours
   */
  startCountdown() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    // Si durée infinie (0)
    if (this.totalDuration === 0) {
      if (this.timerText) this.timerText.textContent = '∞';
      if (this.timerSvgRing) this.timerSvgRing.style.strokeDashoffset = '0';
      return;
    }

    const circleCircumference = 2 * Math.PI * 18; // r = 18 dans le SVG
    if (this.timerSvgRing) {
      this.timerSvgRing.style.strokeDasharray = `${circleCircumference}`;
      this.timerSvgRing.style.strokeDashoffset = '0';
    }

    const startTime = Date.now();
    const durationMs = this.totalDuration * 1000;

    this.timerInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const remaining = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));

      if (this.timerText) {
        this.timerText.textContent = remaining > 0 ? `${remaining}` : '';
      }

      if (this.timerSvgRing) {
        const offset = circleCircumference * progress;
        this.timerSvgRing.style.strokeDashoffset = `${offset}`;
      }

      if (elapsed >= durationMs) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
        this.closeAndPurge();
      }
    }, 40);
  }

  /**
   * PURGE MÉMOIRE IMMÉDIATE et fermeture
   */
  closeAndPurge() {
    if (!this.isOpen) return;
    this.isOpen = false;

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    const snapToNotify = this.currentSnap;

    // Destruction de l'affichage vidéo
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.src = '';
      this.videoElement.load();
    }

    // Destruction de l'image
    if (this.imgElement) {
      this.imgElement.src = '';
    }

    // Purge des données en mémoire de l'objet snap
    if (this.currentSnap) {
      // Si c'était un blob objectURL, on révoque
      if (typeof this.currentSnap.mediaData === 'string' && this.currentSnap.mediaData.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(this.currentSnap.mediaData);
        } catch (e) {}
      }
      // Déréférencement mémoire
      this.currentSnap.mediaData = null;
      this.currentSnap.isOpened = true;
      this.currentSnap.openedAt = Date.now();
    }

    this.currentSnap = null;

    // Masquage du conteneur
    this.container.classList.add('hidden');
    this.container.style.display = 'none';

    // Notification de fin
    if (this.onSnapFinished && snapToNotify) {
      this.onSnapFinished(snapToNotify);
    }
  }
}

export const viewer = new SnapViewer();
