/**
 * editor.js - Éditeur de Snap complet après capture
 * - Prévisualisation photo ou vidéo
 * - Bandeau de texte déplaçable verticalement (touch/drag)
 * - Dessin libre (Doodle) au doigt/souris avec sélecteur de couleurs et bouton Annuler
 * - Sélecteur de minuteur (1s à 10s ou ∞ illimité)
 * - Téléchargement local
 * - Envoi direct ciblé (Amis & Pairs en ligne)
 */

export class SnapEditor {
  constructor() {
    this.container = null;
    this.mediaType = 'photo';
    this.mediaData = null;
    this.previewImg = null;
    this.previewVideo = null;
    this.drawingCanvas = null;
    this.drawingCtx = null;
    this.textBanner = null;
    this.bannerInput = null;

    this.isDrawingMode = false;
    this.isDrawing = false;
    this.currentColor = '#FFFC00';
    this.brushSize = 6;
    this.strokeHistory = [];
    this.currentStroke = [];

    this.bannerText = '';
    this.bannerY = 50;
    this.isDraggingBanner = false;
    this.dragStartY = 0;
    this.initialBannerY = 50;

    this.timerOptions = [1, 2, 3, 5, 10, 0];
    this.currentTimerIndex = 3; // 5s par défaut

    this.onSendSnap = null;
    this.onClose = null;
  }

  init(elements) {
    this.container = elements.container;
    this.stage = elements.stage || document.getElementById('editor-stage') || elements.container;
    this.previewImg = elements.previewImg;
    this.previewVideo = elements.previewVideo;
    this.drawingCanvas = elements.drawingCanvas;
    this.drawingCtx = this.drawingCanvas.getContext('2d');
    this.textBanner = elements.textBanner;
    this.bannerInput = elements.bannerInput;

    this.setupDrawingListeners();
    this.setupBannerListeners();

    window.addEventListener('resize', () => {
      if (this.container && !this.container.classList.contains('hidden')) {
        this.resizeCanvas();
      }
    });
  }

  open(media) {
    this.mediaType = media.type;
    this.mediaData = media.dataUrl;
    this.strokeHistory = [];
    this.currentStroke = [];
    this.bannerText = '';
    this.bannerY = 50;
    this.isDrawingMode = false;
    this.currentTimerIndex = 3;

    // Réinitialiser l'état visuel du pinceau / texte
    document.getElementById('editor-pen-btn')?.classList.remove('active');
    document.getElementById('editor-color-palette')?.classList.add('hidden');
    if (this.drawingCanvas) {
      this.drawingCanvas.style.pointerEvents = 'none';
    }
    if (this.textBanner) {
      this.textBanner.classList.add('hidden');
    }
    if (this.bannerInput) {
      this.bannerInput.value = '';
    }
    if (this.stage) {
      this.stage.classList.remove('landscape');
    }

    // Afficher d'abord le conteneur pour mesurer les vraies dimensions du stage
    this.container.classList.remove('hidden');
    this.container.style.display = 'flex';

    if (this.mediaType === 'photo') {
      this.previewImg.onload = () => {
        if (this.stage && this.previewImg.naturalWidth > this.previewImg.naturalHeight) {
          this.stage.classList.add('landscape');
        }
        requestAnimationFrame(() => this.resizeCanvas());
      };
      this.previewImg.src = this.mediaData;
      this.previewImg.style.display = 'block';
      this.previewVideo.style.display = 'none';
      this.previewVideo.pause();
    } else {
      this.previewImg.style.display = 'none';
      this.previewVideo.onloadedmetadata = () => {
        if (this.stage && this.previewVideo.videoWidth > this.previewVideo.videoHeight) {
          this.stage.classList.add('landscape');
        }
        requestAnimationFrame(() => this.resizeCanvas());
      };
      this.previewVideo.src = this.mediaData;
      this.previewVideo.style.display = 'block';
      this.previewVideo.loop = true;
      this.previewVideo.play().catch(() => {});
    }

    this.resizeCanvas();
    this.updateBannerPosition();
    this.updateTimerDisplay();
  }

  close() {
    if (this.previewVideo) {
      this.previewVideo.pause();
      this.previewVideo.src = '';
    }
    if (this.previewImg) {
      this.previewImg.src = '';
    }
    this.container.classList.add('hidden');
    this.container.style.display = 'none';
    if (this.onClose) this.onClose();
  }

  resizeCanvas() {
    const target = this.drawingCanvas.parentElement || this.stage || this.container;
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.drawingCanvas.width = rect.width;
      this.drawingCanvas.height = rect.height;
      this.redrawAllStrokes();
    }
  }

  setupDrawingListeners() {
    const canvas = this.drawingCanvas;

    const startDraw = (e) => {
      if (!this.isDrawingMode) return;
      this.isDrawing = true;
      const pos = this.getPointerPos(e);
      this.currentStroke = {
        color: this.currentColor,
        size: this.brushSize,
        points: [pos]
      };
      this.drawingCtx.beginPath();
      this.drawingCtx.strokeStyle = this.currentColor;
      this.drawingCtx.lineWidth = this.brushSize;
      this.drawingCtx.lineCap = 'round';
      this.drawingCtx.lineJoin = 'round';
      this.drawingCtx.moveTo(pos.x, pos.y);
    };

    const draw = (e) => {
      if (!this.isDrawing || !this.isDrawingMode) return;
      e.preventDefault();
      const pos = this.getPointerPos(e);
      this.currentStroke.points.push(pos);

      this.drawingCtx.lineTo(pos.x, pos.y);
      this.drawingCtx.stroke();
    };

    const stopDraw = () => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      if (this.currentStroke && this.currentStroke.points.length > 0) {
        this.strokeHistory.push(this.currentStroke);
      }
      this.currentStroke = null;
    };

    canvas.addEventListener('pointerdown', startDraw);
    canvas.addEventListener('pointermove', draw);
    canvas.addEventListener('pointerup', stopDraw);
    canvas.addEventListener('pointercancel', stopDraw);
  }

  getPointerPos(e) {
    const rect = this.drawingCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  redrawAllStrokes() {
    this.drawingCtx.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
    this.strokeHistory.forEach((stroke) => {
      if (stroke.points.length < 1) return;
      this.drawingCtx.beginPath();
      this.drawingCtx.strokeStyle = stroke.color;
      this.drawingCtx.lineWidth = stroke.size;
      this.drawingCtx.lineCap = 'round';
      this.drawingCtx.lineJoin = 'round';

      this.drawingCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        this.drawingCtx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      this.drawingCtx.stroke();
    });
  }

  undoStroke() {
    if (this.strokeHistory.length > 0) {
      this.strokeHistory.pop();
      this.redrawAllStrokes();
    }
  }

  toggleDrawingMode() {
    this.isDrawingMode = !this.isDrawingMode;
    const btn = document.getElementById('editor-pen-btn');
    const colorPicker = document.getElementById('editor-color-palette');

    if (this.isDrawingMode) {
      btn?.classList.add('active');
      colorPicker?.classList.remove('hidden');
      this.drawingCanvas.style.pointerEvents = 'auto';
    } else {
      btn?.classList.remove('active');
      colorPicker?.classList.add('hidden');
      this.drawingCanvas.style.pointerEvents = 'none';
    }
    return this.isDrawingMode;
  }

  setColor(color) {
    this.currentColor = color;
  }

  setupBannerListeners() {
    const banner = this.textBanner;
    if (!banner) return;

    const onPointerDown = (e) => {
      if (e.target === this.bannerInput) return;
      this.isDraggingBanner = true;
      this.dragStartY = e.clientY;
      this.initialBannerY = this.bannerY;
      banner.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e) => {
      if (!this.isDraggingBanner) return;
      const deltaY = e.clientY - this.dragStartY;
      const parentHeight = (this.stage && this.stage.clientHeight) || this.container.clientHeight || window.innerHeight;
      const percentDelta = (deltaY / parentHeight) * 100;
      let newY = this.initialBannerY + percentDelta;

      newY = Math.max(12, Math.min(88, newY));
      this.bannerY = newY;
      this.updateBannerPosition();
    };

    const onPointerUp = (e) => {
      if (this.isDraggingBanner) {
        this.isDraggingBanner = false;
        try {
          banner.releasePointerCapture(e.pointerId);
        } catch (err) {}
      }
    };

    banner.addEventListener('pointerdown', onPointerDown);
    banner.addEventListener('pointermove', onPointerMove);
    banner.addEventListener('pointerup', onPointerUp);
    banner.addEventListener('pointercancel', onPointerUp);

    if (this.bannerInput) {
      this.bannerInput.addEventListener('input', () => {
        this.bannerText = this.bannerInput.value;
      });
      banner.addEventListener('click', () => {
        this.bannerInput.focus();
      });
    }
  }

  updateBannerPosition() {
    if (this.textBanner) {
      this.textBanner.style.top = `${this.bannerY}%`;
    }
  }

  toggleTextBanner() {
    if (this.textBanner.classList.contains('hidden')) {
      this.textBanner.classList.remove('hidden');
      this.bannerInput.focus();
    } else if (!this.bannerText.trim()) {
      this.textBanner.classList.add('hidden');
    } else {
      this.bannerInput.focus();
    }
  }

  cycleTimer() {
    this.currentTimerIndex = (this.currentTimerIndex + 1) % this.timerOptions.length;
    this.updateTimerDisplay();
    return this.getSelectedTimer();
  }

  getSelectedTimer() {
    return this.timerOptions[this.currentTimerIndex];
  }

  updateTimerDisplay() {
    const timerBtn = document.getElementById('editor-timer-btn');
    if (timerBtn) {
      const val = this.getSelectedTimer();
      timerBtn.querySelector('.timer-val').textContent = val === 0 ? '∞' : `${val}s`;
    }
  }

  async downloadSnap() {
    if (this.mediaType === 'photo') {
      const compositeDataUrl = await this.renderFinalPhoto();
      const a = document.createElement('a');
      a.href = compositeDataUrl;
      a.download = `snap_${Date.now()}.jpg`;
      a.click();
    } else {
      const a = document.createElement('a');
      a.href = this.mediaData;
      a.download = `snap_video_${Date.now()}.webm`;
      a.click();
    }
  }

  async renderFinalPhoto() {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        ctx.drawImage(img, 0, 0);

        // Calcul du rectangle réel rendu par object-fit: contain dans le canvas de dessin
        const cw = this.drawingCanvas.width || 1;
        const ch = this.drawingCanvas.height || 1;
        const imgAspect = img.width / img.height;
        const boxAspect = cw / ch;
        let rw = cw;
        let rh = ch;
        let ox = 0;
        let oy = 0;

        if (imgAspect > boxAspect) {
          rw = cw;
          rh = cw / imgAspect;
          oy = (ch - rh) / 2;
        } else {
          rh = ch;
          rw = ch * imgAspect;
          ox = (cw - rw) / 2;
        }

        const scaleX = canvas.width / rw;
        const scaleY = canvas.height / rh;

        if (this.strokeHistory.length > 0) {
          this.strokeHistory.forEach((stroke) => {
            if (stroke.points.length < 1) return;
            ctx.beginPath();
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = stroke.size * scaleX;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            ctx.moveTo((stroke.points[0].x - ox) * scaleX, (stroke.points[0].y - oy) * scaleY);
            for (let i = 1; i < stroke.points.length; i++) {
              ctx.lineTo((stroke.points[i].x - ox) * scaleX, (stroke.points[i].y - oy) * scaleY);
            }
            ctx.stroke();
          });
        }

        const text = this.bannerText.trim();
        if (text) {
          const bannerInBoxY = (this.bannerY / 100) * ch;
          const bannerYPixels = Math.max(30, Math.min(canvas.height - 30, (bannerInBoxY - oy) * scaleY));
          const bannerHeight = Math.max(50, canvas.height * 0.06);

          ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.fillRect(0, bannerYPixels - bannerHeight / 2, canvas.width, bannerHeight);

          ctx.fillStyle = '#FFFFFF';
          const fontSize = Math.round(bannerHeight * 0.52);
          ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, canvas.width / 2, bannerYPixels);
        }

        resolve(canvas.toDataURL('image/jpeg', 0.9));
      };
      img.src = this.mediaData;
    });
  }

  async prepareSnapPayload() {
    let finalMediaData = this.mediaData;

    if (this.mediaType === 'photo') {
      finalMediaData = await this.renderFinalPhoto();
    }

    return {
      mediaType: this.mediaType,
      mediaData: finalMediaData,
      timer: this.getSelectedTimer(),
      // Pour la photo, le texte est déjà incrusté dans l'image; pour la vidéo, on le garde en overlay
      bannerText: this.mediaType === 'video' ? this.bannerText : '',
      bannerY: this.bannerY
    };
  }
}

export const editor = new SnapEditor();
