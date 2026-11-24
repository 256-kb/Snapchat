/**
 * camera.js - Moteur de capture Caméra & Vidéo Mobile-First
 * Gestion du flux WebRTC getUserMedia, bascule avant/arrière,
 * flash simulé, déclencheur photo (clic court) et enregistreur vidéo 10s (appui long).
 */

export class CameraEngine {
  constructor() {
    this.videoElement = null;
    this.stream = null;
    this.facingMode = 'user'; // 'user' ou 'environment'
    this.isFlashEnabled = false;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingStartTime = 0;
    this.recordingTimer = null;
    this.maxRecordingSeconds = 10;
    this.pressTimer = null;
    this.isPressing = false;
    this.hasCameraAccess = false;

    // Callbacks
    this.onMediaCaptured = null; // (result: { type: 'photo'|'video', dataUrl, duration }) => {}
    this.onRecordingProgress = null; // (percentage: 0..100) => {}
    this.onCameraStateChange = null; // (state) => {}
  }

  /**
   * Initialise le flux caméra sur l'élément vidéo spécifié
   */
  async init(videoElement) {
    this.videoElement = videoElement;
    return await this.startStream();
  }

  updateCameraUI(hasAccess) {
    if (this.videoElement) {
      this.videoElement.classList.toggle('mirrored', this.facingMode === 'user');
    }
    const placeholder = document.getElementById('camera-placeholder');
    if (placeholder) {
      placeholder.classList.toggle('hidden', !!hasAccess);
    }
  }

  /**
   * Démarre ou redémarre le flux vidéo avec les contraintes actuelles
   */
  async startStream() {
    this.stopStream();
    this.updateCameraUI(false);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('getUserMedia non supporté dans cet environnement.');
      this.hasCameraAccess = false;
      this.updateCameraUI(false);
      if (this.onCameraStateChange) this.onCameraStateChange({ hasAccess: false });
      return false;
    }

    const constraints = {
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: true
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.videoElement) {
        this.videoElement.srcObject = this.stream;
        await this.videoElement.play();
      }
      this.hasCameraAccess = true;
      this.updateCameraUI(true);
      if (this.onCameraStateChange) this.onCameraStateChange({ hasAccess: true, facingMode: this.facingMode });
      return true;
    } catch (err) {
      console.warn('Erreur accès caméra ou micro, essai vidéo seule...', err);
      // Réessayer sans audio si permission micro refusée
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: this.facingMode } },
          audio: false
        });
        if (this.videoElement) {
          this.videoElement.srcObject = this.stream;
          await this.videoElement.play();
        }
        this.hasCameraAccess = true;
        this.updateCameraUI(true);
        if (this.onCameraStateChange) this.onCameraStateChange({ hasAccess: true, facingMode: this.facingMode });
        return true;
      } catch (err2) {
        console.warn('Accès caméra définitivement indisponible (ou environnement restreint):', err2);
        this.hasCameraAccess = false;
        this.updateCameraUI(false);
        if (this.onCameraStateChange) this.onCameraStateChange({ hasAccess: false, error: err2.message });
        return false;
      }
    }
  }

  /**
   * Arrête le flux vidéo actuel
   */
  stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }
  }

  /**
   * Bascule entre caméra avant et arrière
   */
  async flipCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    return await this.startStream();
  }

  /**
   * Active ou désactive le flash simulé
   */
  toggleFlash() {
    this.isFlashEnabled = !this.isFlashEnabled;
    return this.isFlashEnabled;
  }

  /**
   * Déclenche l'effet de flash blanc plein écran
   */
  triggerFlashEffect() {
    return new Promise((resolve) => {
      const flashEl = document.getElementById('flash-overlay');
      if (!flashEl) {
        resolve();
        return;
      }
      flashEl.style.opacity = '1';
      flashEl.style.display = 'block';
      setTimeout(() => {
        flashEl.style.opacity = '0';
        setTimeout(() => {
          flashEl.style.display = 'none';
          resolve();
        }, 150);
      }, 120);
    });
  }

  /**
   * Capture une photo instantanée
   */
  async takePhoto() {
    if (this.isFlashEnabled) {
      await this.triggerFlashEffect();
    }

    // Si on a un flux vidéo actif
    if (this.videoElement && this.videoElement.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      const w = this.videoElement.videoWidth;
      const h = this.videoElement.videoHeight;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      // Effet miroir pour la caméra selfie
      if (this.facingMode === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }

      ctx.drawImage(this.videoElement, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

      if (this.onMediaCaptured) {
        this.onMediaCaptured({
          type: 'photo',
          dataUrl,
          duration: 5
        });
      }
      return dataUrl;
    } else {
      // Fallback: génération d'une scène photographique stylée (mock)
      const dataUrl = this.generateMockPhoto();
      if (this.onMediaCaptured) {
        this.onMediaCaptured({
          type: 'photo',
          dataUrl,
          duration: 5
        });
      }
      return dataUrl;
    }
  }

  /**
   * Démarre l'enregistrement vidéo (MediaRecorder)
   */
  startVideoRecording() {
    if (this.isRecording) return;
    this.isRecording = true;
    this.recordedChunks = [];
    this.recordingStartTime = Date.now();

    // Vibreur tactile si supporté
    if (navigator.vibrate) navigator.vibrate(40);

    let streamToRecord = this.stream;
    let isCanvasStream = false;

    // Si pas de flux caméra physique, créer un flux canvas animé pour tester
    if (!streamToRecord) {
      const mockCanvas = this.createMockRecordingCanvas();
      streamToRecord = mockCanvas.captureStream(30);
      isCanvasStream = true;
    }

    try {
      const options = { mimeType: 'video/webm;codecs=vp8,opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm';
      }
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = '';
      }

      this.mediaRecorder = options.mimeType
        ? new MediaRecorder(streamToRecord, options)
        : new MediaRecorder(streamToRecord);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result;
          const duration = Math.min(
            this.maxRecordingSeconds,
            Math.max(1, Math.round((Date.now() - this.recordingStartTime) / 1000))
          );
          if (this.onMediaCaptured) {
            this.onMediaCaptured({
              type: 'video',
              dataUrl,
              duration
            });
          }
        };
        reader.readAsDataURL(blob);
      };

      this.mediaRecorder.start(100);

      // Gestion de la barre circulaire de progression (0 à 10s)
      this.recordingTimer = setInterval(() => {
        const elapsed = (Date.now() - this.recordingStartTime) / 1000;
        const percent = Math.min(100, (elapsed / this.maxRecordingSeconds) * 100);

        if (this.onRecordingProgress) {
          this.onRecordingProgress(percent);
        }

        // Arrêt automatique à 10 secondes
        if (elapsed >= this.maxRecordingSeconds) {
          this.stopVideoRecording();
        }
      }, 50);
    } catch (err) {
      console.error('Erreur démarrage enregistrement vidéo:', err);
      this.isRecording = false;
    }
  }

  /**
   * Arrête l'enregistrement vidéo
   */
  stopVideoRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;

    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }

    if (this.onRecordingProgress) {
      this.onRecordingProgress(0);
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
  }

  /**
   * Gestionnaire d'appui sur le déclencheur central
   * Clic court (< 350ms) = photo
   * Maintien (> 350ms) = vidéo (jusqu'à 10s)
   */
  handleShutterDown() {
    this.isPressing = true;
    this.pressTimer = setTimeout(() => {
      if (this.isPressing) {
        this.startVideoRecording();
      }
    }, 350);
  }

  handleShutterUp() {
    const wasPressing = this.isPressing;
    this.isPressing = false;

    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }

    if (this.isRecording) {
      this.stopVideoRecording();
    } else if (wasPressing) {
      // Clic court => Prendre une photo
      this.takePhoto();
    }
  }

  /**
   * Génère une photo mock esthétique style Snapchat si la webcam n'est pas disponible
   */
  generateMockPhoto() {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext('2d');

    // Fond dégradé vibrant
    const grad = ctx.createLinearGradient(0, 0, 720, 1280);
    grad.addColorStop(0, '#1a1a24');
    grad.addColorStop(0.5, '#2e1065');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 720, 1280);

    // Cercles néon
    ctx.save();
    ctx.fillStyle = 'rgba(255, 252, 0, 0.2)';
    ctx.beginPath();
    ctx.arc(360, 450, 180, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(233, 39, 84, 0.25)';
    ctx.beginPath();
    ctx.arc(420, 600, 140, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Logo stylisé au centre (fantôme / caméra vectorielle)
    ctx.save();
    ctx.fillStyle = '#FFFC00';
    ctx.beginPath();
    ctx.arc(360, 480, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(360, 480, 35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('SNAP P2P CAPTURE', 360, 650);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '24px sans-serif';
    ctx.fillText(new Date().toLocaleTimeString('fr-FR'), 360, 700);

    return canvas.toDataURL('image/jpeg', 0.9);
  }

  /**
   * Crée un canvas animé pour simuler un flux vidéo si pas de caméra
   */
  createMockRecordingCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 1136;
    const ctx = canvas.getContext('2d');

    let frame = 0;
    const anim = () => {
      frame++;
      const grad = ctx.createLinearGradient(0, 0, 640, 1136);
      grad.addColorStop(0, `hsl(${frame % 360}, 70%, 20%)`);
      grad.addColorStop(1, '#000000');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 1136);

      ctx.fillStyle = '#FFFC00';
      ctx.font = 'bold 40px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('VIDÉO EN DIRECT P2P', 320, 500);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '30px sans-serif';
      ctx.fillText(`Enregistrement... ${(frame / 30).toFixed(1)}s`, 320, 570);

      if (this.isRecording) {
        requestAnimationFrame(anim);
      }
    };
    anim();
    return canvas;
  }
}

export const camera = new CameraEngine();
