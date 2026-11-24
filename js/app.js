/**
 * app.js - Contrôleur Principal de Snapchat P2P
 * Navigation 2 écrans (Chat & Caméra), ECDSA P-256 + Annuaire Gossip + QR d'ajout direct,
 * sauvegarde automatique des messages et accusés Envoyé / Remis / Vu.
 */

import { storage } from './storage.js';
import { p2p } from './p2p.js';
import { camera } from './camera.js';
import { editor } from './editor.js';
import { viewer } from './viewer.js';
import { formatTag, isValidPublicKeyHash } from './crypto.js';

class SnapApp {
  constructor() {
    this.currentScreenIndex = 1; // 0 = Chat, 1 = Caméra (défaut au lancement)
    this.profile = null;
    this.currentDmPeer = null;
    this.dmConversations = new Map(); // publicKeyHash -> messages
    this.pendingFriendRequests = new Map(); // requestId -> requestData
    this.preselectedRecipientUuid = null;
    this.replyingTo = null; // { id, senderUuid, senderNickname, text }
    this.contextTargetMessage = null;
    this.contextTargetIsSnap = false;
    this.p2pListenersBound = false;
    this.currentShareUrl = '';
    this.showGossipDirectory = false;
    this.chatSearchQuery = '';

    // Swipe tactile
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.touchCurrentX = 0;
    this.isSwiping = false;

    this.unreadChatsCount = 0;
  }

  async init() {
    console.log('[App] Initialisation de Snapchat P2P...');
    await storage.init();

    // Capturer immédiatement un éventuel lien #add=<pseudo>:<publicKeyHash> et nettoyer l'URL
    await this.handleUrlAddHash();
    window.addEventListener('hashchange', () => {
      void this.handleUrlAddHash();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.currentDmPeer) {
        void this.markConversationRead(this.currentDmPeer.uuid);
      }
    });

    this.bindSwipeGestures();
    this.bindBottomNav();
    this.bindDesktopControls();
    this.bindModals();
    this.bindCameraControls();
    this.bindEditorControls();
    this.bindViewerEvents();
    this.bindDmEvents();
    this.bindChatListControls();
    this.bindContextMenuEvents();
    this.bindFriendRequestEvents();
    this.bindKeyboardShortcuts();

    const loadedProfile = await storage.getProfile();
    if (!loadedProfile) {
      this.showOnboardingModal();
    } else {
      this.profile = await storage.ensureProfileCrypto(loadedProfile);
      await this.startAppWithProfile(this.profile);
    }
  }

  parseAddHash(rawHash = window.location.hash) {
    if (!rawHash || !rawHash.startsWith('#add=')) return null;
    const payload = rawHash.slice('#add='.length).trim();
    const sepIdx = payload.lastIndexOf(':');
    if (sepIdx <= 0) return null;

    let pseudo = '';
    try {
      pseudo = decodeURIComponent(payload.slice(0, sepIdx)).trim();
    } catch (e) {
      pseudo = payload.slice(0, sepIdx).trim();
    }

    const hash = payload.slice(sepIdx + 1).trim().toLowerCase();
    if (!pseudo || !isValidPublicKeyHash(hash)) return null;

    return {
      uuid: hash,
      publicKeyHash: hash,
      tag: formatTag(hash),
      nickname: pseudo,
      verified: true,
      addedVia: 'qr'
    };
  }

  async handleUrlAddHash() {
    const contact = this.parseAddHash(window.location.hash);
    if (!contact) return false;

    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) {}

    if (this.profile) {
      await this.processVerifiedUrlAdd(contact);
    } else {
      await storage.savePendingUrlAdd(contact);
    }
    return true;
  }

  async applyPendingUrlAdds() {
    const pending = await storage.getPendingUrlAdds();
    if (!pending || pending.length === 0) return;
    for (const contact of pending) {
      await this.processVerifiedUrlAdd(contact);
    }
    await storage.clearPendingUrlAdds();
  }

  async processVerifiedUrlAdd(contact) {
    if (!this.profile || !contact?.publicKeyHash) return;
    const myHash = (this.profile.publicKeyHash || this.profile.uuid || '').toLowerCase();
    if (contact.publicKeyHash.toLowerCase() === myHash) {
      this.showToast('C\'est votre propre lien de profil');
      return;
    }

    const dirEntry = storage.getDirectoryEntry(contact.publicKeyHash);
    this.profile = await storage.addFriend({
      ...contact,
      avatar: dirEntry?.avatar || contact.avatar || '',
      publicKey: dirEntry?.publicKey || contact.publicKey || null,
      verified: true,
      addedVia: 'qr'
    });

    this.renderFriendsList();
    this.renderOnlinePeers();
    this.renderDirectoryList();
    this.showToast(`${contact.nickname} (${contact.tag}) ajouté comme ami vérifié`);
  }

  async startAppWithProfile(profile) {
    this.profile = await storage.ensureProfileCrypto(profile);
    this.updateProfileUI();

    // Charger tout l'historique persisté depuis IndexedDB / profil
    this.dmConversations.clear();
    const allConversations = await storage.getAllConversations();
    for (const [peerUuid, msgs] of Object.entries(allConversations)) {
      if (Array.isArray(msgs)) {
        this.dmConversations.set(peerUuid.toLowerCase(), msgs.map((m) => ({ ...m })));
      }
    }

    // Appliquer les éventuels contacts ajoutés via URL #add= avant onboarding
    await this.applyPendingUrlAdds();

    // Démarrage non-bloquant de la caméra pour ne jamais retarder le réseau P2P
    const videoEl = document.getElementById('camera-video');
    camera.init(videoEl).catch((err) => {
      console.warn('Caméra différée ou refusée:', err);
    });

    if (!this.p2pListenersBound) {
      this.setupP2PListeners();
      this.p2pListenersBound = true;
    }
    await p2p.init(this.profile);

    this.renderFriendsList();
    this.renderOnlinePeers();
    this.renderDirectoryList();
    this.renderFriendRequests();
    this.showToast(`Connecté : ${this.profile.nickname} ${this.profile.tag}`);
  }

  updateProfileUI() {
    if (!this.profile) return;
    const hash = this.profile.publicKeyHash || this.profile.uuid || '';
    const tag = this.profile.tag || formatTag(hash);

    const avatarEl = document.getElementById('top-avatar-img');
    const pseudoEl = document.getElementById('top-user-pseudo');
    const topTagEl = document.getElementById('top-user-tag');
    const profileModalAvatar = document.getElementById('profile-modal-avatar');
    const profileModalNickname = document.getElementById('profile-modal-nickname');
    const profileModalTag = document.getElementById('profile-modal-tag');
    const profileModalUuid = document.getElementById('profile-modal-uuid');

    if (avatarEl) avatarEl.src = this.profile.avatar;
    if (pseudoEl) pseudoEl.textContent = this.profile.nickname;
    if (topTagEl) topTagEl.textContent = tag;
    if (profileModalAvatar) profileModalAvatar.src = this.profile.avatar;
    if (profileModalNickname) profileModalNickname.textContent = this.profile.nickname;
    if (profileModalTag) profileModalTag.textContent = tag;
    if (profileModalUuid) profileModalUuid.textContent = `Clé SHA-256: ${hash}`;

    this.renderProfileQrCode();
  }

  renderProfileQrCode() {
    if (!this.profile) return;
    const hash = this.profile.publicKeyHash || this.profile.uuid;
    const shareUrl = `https://256kb.xyz/Snapchat/#add=${encodeURIComponent(this.profile.nickname)}:${hash}`;
    this.currentShareUrl = shareUrl;

    const previewEl = document.getElementById('profile-qr-url-preview');
    if (previewEl) {
      previewEl.textContent = shareUrl;
    }

    const qrBox = document.getElementById('profile-qr-code');
    if (!qrBox) return;
    qrBox.innerHTML = '';

    if (typeof window.QRCode === 'function') {
      try {
        new window.QRCode(qrBox, {
          text: shareUrl,
          width: 176,
          height: 176,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel?.M || 0
        });
        return;
      } catch (err) {
        console.warn('Erreur génération QRCode:', err);
      }
    }

    const fallback = document.createElement('div');
    fallback.style.cssText = 'color:#111;font-size:12px;font-weight:700;text-align:center;padding:12px;';
    fallback.textContent = 'QR Code indisponible hors ligne — copiez le lien ci-dessous.';
    qrBox.appendChild(fallback);
  }

  /**
   * =========================================================================
   * NAVIGATION PAR SWIPE TACTILE, BARRE DU BAS & DESKTOP SPLIT-VIEW
   * =========================================================================
   */
  bindSwipeGestures() {
    const track = document.getElementById('screens-track');
    const container = document.getElementById('app-container');

    container.addEventListener('touchstart', (e) => {
      if (window.innerWidth >= 860) return;
      if (
        document.getElementById('dm-view').classList.contains('active') ||
        !document.getElementById('snap-editor-overlay').classList.contains('hidden') ||
        !document.getElementById('snap-viewer-overlay').classList.contains('hidden') ||
        document.querySelector('.modal-backdrop[style*="display: flex"]')
      ) {
        return;
      }

      this.isSwiping = true;
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
      this.touchCurrentX = this.touchStartX;
      track.style.transition = 'none';
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (!this.isSwiping || window.innerWidth >= 860) return;
      this.touchCurrentX = e.touches[0].clientX;
      const deltaX = this.touchCurrentX - this.touchStartX;
      const deltaY = e.touches[0].clientY - this.touchStartY;

      if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaX) < 10) {
        return;
      }

      const screenWidth = container.clientWidth;
      const baseOffsetPercent = -this.currentScreenIndex * 50;
      const dragPercent = (deltaX / screenWidth) * 50;
      const targetPercent = Math.max(-50, Math.min(0, baseOffsetPercent + dragPercent));

      track.style.transform = `translateX(${targetPercent}%)`;
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
      if (!this.isSwiping || window.innerWidth >= 860) return;
      this.isSwiping = false;
      track.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1)';

      const deltaX = this.touchCurrentX - this.touchStartX;
      const threshold = container.clientWidth * 0.18;

      if (deltaX < -threshold && this.currentScreenIndex < 1) {
        this.goToScreen(1); // Swipe vers la caméra
      } else if (deltaX > threshold && this.currentScreenIndex > 0) {
        this.goToScreen(0); // Swipe vers le chat
      } else {
        this.goToScreen(this.currentScreenIndex);
      }
    }, { passive: true });

    // Adaptation dynamique lors du redimensionnement PC <-> Mobile
    window.addEventListener('resize', () => {
      if (window.innerWidth >= 860) {
        track.style.transition = '';
        track.style.transform = '';
        const headerActions = document.querySelector('.header-actions');
        if (headerActions) {
          headerActions.style.opacity = '1';
          headerActions.style.pointerEvents = 'auto';
        }
      } else {
        this.goToScreen(this.currentScreenIndex);
      }
    });
  }

  bindBottomNav() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const index = parseInt(tab.dataset.index, 10);
        this.goToScreen(index);
      });
    });
  }

  bindDesktopControls() {
    const desktopCamBtn = document.getElementById('desktop-cam-btn');
    if (desktopCamBtn) {
      desktopCamBtn.addEventListener('click', () => {
        this.goToScreen(1);
      });
    }
  }

  bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;

      const ctxMenu = document.getElementById('msg-context-menu');
      if (ctxMenu && !ctxMenu.classList.contains('hidden')) {
        this.hideContextMenu();
        return;
      }

      const clearChatModal = document.getElementById('clear-chat-modal');
      if (clearChatModal && clearChatModal.style.display === 'flex') {
        clearChatModal.style.display = 'none';
        return;
      }

      if (viewer.isOpen) {
        viewer.closeAndPurge();
        return;
      }

      const openModals = Array.from(document.querySelectorAll('.modal-backdrop')).filter(
        (m) => m.style.display === 'flex' && m.id !== 'onboarding-modal'
      );
      if (openModals.length > 0) {
        openModals.forEach((m) => (m.style.display = 'none'));
        return;
      }

      const editorEl = document.getElementById('snap-editor-overlay');
      if (editorEl && !editorEl.classList.contains('hidden')) {
        editor.close();
        return;
      }

      if (this.replyingTo) {
        this.clearReplyTarget();
        return;
      }

      if (window.innerWidth >= 860 && document.getElementById('dm-view').classList.contains('active')) {
        this.goToScreen(1);
      }
    });
  }

  goToScreen(index) {
    this.currentScreenIndex = Math.max(0, Math.min(1, index));
    const isDesktop = window.innerWidth >= 860;
    const track = document.getElementById('screens-track');

    if (isDesktop) {
      track.style.transition = '';
      track.style.transform = '';
      // Sur PC, basculer vers la caméra ferme le DM actif pour révéler la scène caméra à droite
      if (this.currentScreenIndex === 1 && this.currentDmPeer) {
        document.getElementById('dm-view').classList.remove('active');
        document.getElementById('app-container').classList.remove('in-dm');
        this.currentDmPeer = null;
        this.clearReplyTarget();
        this.hideContextMenu();
        this.renderFriendsList();
        this.renderOnlinePeers();
      }
    } else {
      const targetPercent = -this.currentScreenIndex * 50;
      track.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1)';
      track.style.transform = `translateX(${targetPercent}%)`;
    }

    document.querySelectorAll('.nav-tab').forEach((tab) => {
      const tabIdx = parseInt(tab.dataset.index, 10);
      tab.classList.toggle('active', tabIdx === this.currentScreenIndex);
    });

    // Masquer les actions caméra (flash/flip) sur l'écran Chat mobile uniquement
    const headerActions = document.querySelector('.header-actions');
    if (headerActions) {
      const showCamActions = isDesktop || this.currentScreenIndex === 1;
      headerActions.style.opacity = showCamActions ? '1' : '0';
      headerActions.style.pointerEvents = showCamActions ? 'auto' : 'none';
      headerActions.style.transition = 'opacity 0.2s';
    }

    if (isDesktop || this.currentScreenIndex === 1) {
      if (camera.videoElement && camera.stream) {
        camera.videoElement.play().catch(() => {});
      }
    }
  }

  /**
   * =========================================================================
   * CAMÉRA & CAPTURE
   * =========================================================================
   */
  bindCameraControls() {
    const shutterBtn = document.getElementById('shutter-button');
    const flashBtn = document.getElementById('cam-flash-btn');
    const flipBtn = document.getElementById('cam-flip-btn');
    const fileImport = document.getElementById('camera-file-import');
    const quickChatBtn = document.getElementById('camera-quick-chat');
    const progressCircle = document.getElementById('shutter-progress');

    const onDown = (e) => {
      e.preventDefault();
      shutterBtn.classList.add('recording');
      camera.handleShutterDown();
    };

    const onUp = (e) => {
      e.preventDefault();
      shutterBtn.classList.remove('recording');
      camera.handleShutterUp();
    };

    shutterBtn.addEventListener('pointerdown', onDown);
    shutterBtn.addEventListener('pointerup', onUp);
    shutterBtn.addEventListener('pointerleave', onUp);

    camera.onRecordingProgress = (percent) => {
      const circumference = 2 * Math.PI * 42;
      const offset = circumference - (percent / 100) * circumference;
      progressCircle.style.strokeDashoffset = `${offset}`;
    };

    camera.onMediaCaptured = (media) => {
      editor.open(media);
    };

    flashBtn.addEventListener('click', () => {
      const active = camera.toggleFlash();
      flashBtn.classList.toggle('active', active);
      this.showToast(active ? 'Flash activé' : 'Flash désactivé');
    });

    flipBtn.addEventListener('click', async () => {
      await camera.flipCamera();
      this.showToast(camera.facingMode === 'user' ? 'Caméra selfie' : 'Caméra arrière');
    });

    fileImport.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      const isVideo = file.type.startsWith('video');

      reader.onload = () => {
        editor.open({
          type: isVideo ? 'video' : 'photo',
          dataUrl: reader.result,
          duration: 5
        });
      };
      reader.readAsDataURL(file);
      fileImport.value = '';
    });

    quickChatBtn.addEventListener('click', () => {
      this.goToScreen(0); // Aller sur l'écran Chat
    });
  }

  /**
   * =========================================================================
   * ÉDITEUR DE SNAP POST-CAPTURE
   * =========================================================================
   */
  bindEditorControls() {
    editor.init({
      container: document.getElementById('snap-editor-overlay'),
      stage: document.getElementById('editor-stage'),
      previewImg: document.getElementById('editor-preview-img'),
      previewVideo: document.getElementById('editor-preview-video'),
      drawingCanvas: document.getElementById('editor-drawing-canvas'),
      textBanner: document.getElementById('editor-text-banner'),
      bannerInput: document.getElementById('editor-banner-input')
    });

    document.getElementById('editor-discard-btn').addEventListener('click', () => {
      editor.close();
    });

    document.getElementById('editor-download-btn').addEventListener('click', async () => {
      await editor.downloadSnap();
      this.showToast('Snap enregistré dans vos fichiers');
    });

    document.getElementById('editor-text-btn').addEventListener('click', () => {
      editor.toggleTextBanner();
    });

    document.getElementById('editor-pen-btn').addEventListener('click', () => {
      editor.toggleDrawingMode();
    });

    document.getElementById('editor-undo-btn').addEventListener('click', () => {
      editor.undoStroke();
    });

    document.getElementById('editor-timer-btn').addEventListener('click', () => {
      const val = editor.cycleTimer();
      this.showToast(val === 0 ? 'Minuteur : Illimité ∞' : `Minuteur : ${val} secondes`);
    });

    const colorDots = document.querySelectorAll('.color-dot');
    colorDots.forEach((dot) => {
      dot.addEventListener('click', () => {
        colorDots.forEach((d) => d.classList.remove('active'));
        dot.classList.add('active');
        editor.setColor(dot.dataset.color);
      });
    });

    document.getElementById('editor-send-btn').addEventListener('click', () => {
      this.openSendSheet();
    });
  }

  openSendSheet() {
    const modal = document.getElementById('send-sheet-modal');
    const recipientsList = document.getElementById('send-recipients-list');
    recipientsList.innerHTML = '';

    const allTargets = new Map();

    if (this.profile.friends) {
      this.profile.friends.forEach((f) => allTargets.set(f.uuid, { ...f, isFriend: true }));
    }

    const onlinePeers = p2p.getOnlinePeers();
    onlinePeers.forEach((p) => {
      if (allTargets.has(p.uuid)) {
        allTargets.get(p.uuid).isOnline = true;
      } else {
        allTargets.set(p.uuid, { ...p, isOnline: true });
      }
    });

    if (allTargets.size === 0) {
      recipientsList.innerHTML = `
        <div style="font-size:12px;color:var(--snap-gray-text);padding:10px;">
          Aucun ami ou pair connecté dans cette room pour l'instant. Invitez un ami par pseudo !
        </div>`;
    } else {
      allTargets.forEach((target) => {
        const isPreselected = this.preselectedRecipientUuid === target.uuid;
        const row = document.createElement('label');
        row.className = 'checkbox-row';
        row.style.cssText = 'background:var(--snap-dark);padding:10px 14px;border-radius:14px;';
        const targetTag = target.tag || formatTag(target.uuid);
        row.innerHTML = `
          <input type="checkbox" class="send-recipient-checkbox" value="${target.uuid}" ${isPreselected ? 'checked' : ''}>
          <div style="display:flex;align-items:center;gap:10px;flex:1;overflow:hidden;">
            <img src="${target.avatar || storage.createDefaultAvatar(target.nickname)}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;">
            <div style="overflow:hidden;">
              <div class="user-nickname-row" style="font-weight:700;font-size:14px;">
                <span class="user-nickname-text">${this.escapeHtml(target.nickname)}</span>
                <span class="user-tag-badge">${targetTag}</span>
              </div>
              <div style="font-size:11px;color:${target.isOnline ? 'var(--snap-green)' : 'var(--snap-gray-text)'};">
                ${target.isOnline ? '● En ligne' : '○ Hors ligne'}
              </div>
            </div>
          </div>
        `;
        recipientsList.appendChild(row);
      });
    }

    modal.style.display = 'flex';

    document.getElementById('btn-close-send-sheet').onclick = () => {
      modal.style.display = 'none';
      this.preselectedRecipientUuid = null;
    };

    document.getElementById('btn-confirm-send-snap').onclick = async () => {
      const checkedBoxes = Array.from(document.querySelectorAll('.send-recipient-checkbox:checked'));
      const selectedUuids = checkedBoxes.map((cb) => cb.value);

      if (selectedUuids.length === 0) {
        this.showToast('Veuillez sélectionner au moins un destinataire');
        return;
      }

      modal.style.display = 'none';
      const snapPayload = await editor.prepareSnapPayload();

      const sentSnap = p2p.sendSnap(selectedUuids, snapPayload);

      selectedUuids.forEach((uuid) => {
        if (!this.dmConversations.has(uuid)) {
          this.dmConversations.set(uuid, []);
        }
        const snapEntry = {
          id: sentSnap.id,
          type: 'snap',
          mediaType: snapPayload.mediaType,
          isOutgoing: true,
          isOpened: false,
          timestamp: Date.now()
        };
        this.dmConversations.get(uuid).push(snapEntry);
        void storage.upsertConversationMessage(uuid, snapEntry);
      });

      this.showToast(`Snap envoyé à ${selectedUuids.length} ami(s)`);
      this.renderFriendsList();

      if (this.currentDmPeer && selectedUuids.includes(this.currentDmPeer.uuid)) {
        this.renderDmMessages();
      }

      editor.close();
      this.preselectedRecipientUuid = null;
    };
  }

  /**
   * =========================================================================
   * VISIONNEUSE DE SNAP
   * =========================================================================
   */
  bindViewerEvents() {
    viewer.init({
      container: document.getElementById('snap-viewer-overlay'),
      stage: document.getElementById('viewer-stage'),
      img: document.getElementById('viewer-img'),
      video: document.getElementById('viewer-video'),
      banner: document.getElementById('viewer-banner'),
      bannerText: document.getElementById('viewer-banner-text'),
      authorAvatar: document.getElementById('viewer-author-avatar'),
      authorName: document.getElementById('viewer-author-name'),
      timerSvgRing: document.getElementById('viewer-timer-ring'),
      timerText: document.getElementById('viewer-timer-number')
    });

    viewer.onSnapFinished = async (snap) => {
      if (snap.senderUuid && snap.id) {
        p2p.sendSnapReceipt(snap.id, snap.senderUuid);
      }

      if (snap.senderUuid && this.dmConversations.has(snap.senderUuid)) {
        const conv = this.dmConversations.get(snap.senderUuid);
        const targetSnap = conv.find((m) => m.id === snap.id);
        if (targetSnap) {
          targetSnap.isOpened = true;
          targetSnap.mediaData = null;
          targetSnap.openedAt = Date.now();
        }
        await storage.setConversationMessages(snap.senderUuid, conv);
      }

      this.renderFriendsList();
      if (this.currentDmPeer) {
        this.renderDmMessages();
      }
    };
  }

  /**
   * =========================================================================
   * GESTION DU CHAT DM PRIVÉ
   * =========================================================================
   */
  bindDmEvents() {
    const dmView = document.getElementById('dm-view');
    const backBtn = document.getElementById('dm-back-btn');
    const dmForm = document.getElementById('dm-form');
    const dmInput = document.getElementById('dm-input');
    const quickSnapBtn = document.getElementById('dm-quick-snap-btn');
    const replyCancelBtn = document.getElementById('dm-reply-cancel-btn');

    backBtn.addEventListener('click', () => {
      dmView.classList.remove('active');
      document.getElementById('app-container').classList.remove('in-dm');
      this.currentDmPeer = null;
      this.clearReplyTarget();
      this.hideContextMenu();
      this.renderFriendsList();
      this.renderOnlinePeers();
    });

    if (replyCancelBtn) {
      replyCancelBtn.addEventListener('click', () => {
        this.clearReplyTarget();
        dmInput.focus();
      });
    }

    dmForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = dmInput.value.trim();
      if (!text || !this.currentDmPeer) return;

      const peerUuid = this.currentDmPeer.uuid;
      const replyToPayload = this.replyingTo ? { ...this.replyingTo } : null;
      const msg = p2p.sendMessage(peerUuid, text, false, replyToPayload);

      if (!this.dmConversations.has(peerUuid)) {
        this.dmConversations.set(peerUuid, []);
      }
      const outgoingEntry = {
        ...msg,
        isOutgoing: true,
        status: 'sent'
      };
      this.dmConversations.get(peerUuid).push(outgoingEntry);
      await storage.upsertConversationMessage(peerUuid, outgoingEntry);

      dmInput.value = '';
      this.clearReplyTarget();
      p2p.sendTyping(peerUuid, false);
      this.renderDmMessages();
      this.renderFriendsList();
    });

    let typingTimeout = null;
    dmInput.addEventListener('input', () => {
      if (!this.currentDmPeer) return;
      p2p.sendTyping(this.currentDmPeer.uuid, true);
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        if (this.currentDmPeer) {
          p2p.sendTyping(this.currentDmPeer.uuid, false);
        }
      }, 1500);
    });

    quickSnapBtn.addEventListener('click', () => {
      this.preselectedRecipientUuid = this.currentDmPeer.uuid;
      dmView.classList.remove('active');
      document.getElementById('app-container').classList.remove('in-dm');
      this.clearReplyTarget();
      this.hideContextMenu();
      this.goToScreen(1); // Caméra
      this.showToast(`Prenez un Snap pour ${this.currentDmPeer.nickname}`);
    });

    const clearChatBtn = document.getElementById('dm-clear-chat-btn');
    if (clearChatBtn) {
      clearChatBtn.addEventListener('click', () => {
        if (!this.currentDmPeer) return;
        const clearModal = document.getElementById('clear-chat-modal');
        const subtitle = document.getElementById('clear-chat-subtitle');
        if (subtitle) {
          subtitle.textContent = `Choisissez comment supprimer votre discussion avec ${this.currentDmPeer.nickname} :`;
        }
        if (clearModal) clearModal.style.display = 'flex';
      });
    }
  }

  /**
   * Menu contextuel sur message (Clic droit PC / Appui long Mobile)
   */
  bindContextMenuEvents() {
    const menu = document.getElementById('msg-context-menu');
    const replyBtn = document.getElementById('ctx-reply-btn');
    const saveBtn = document.getElementById('ctx-save-btn');
    const copyBtn = document.getElementById('ctx-copy-btn');
    const deleteMeBtn = document.getElementById('ctx-delete-me-btn');
    const deleteAllBtn = document.getElementById('ctx-delete-all-btn');

    if (!menu) return;

    menu.querySelectorAll('.ctx-reaction-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const emoji = btn.dataset.emoji;
        if (this.contextTargetMessage && emoji) {
          await this.toggleReaction(this.contextTargetMessage, emoji);
        }
        this.hideContextMenu();
      });
    });

    replyBtn.addEventListener('click', () => {
      if (this.contextTargetMessage) {
        this.setReplyTarget(this.contextTargetMessage);
      }
      this.hideContextMenu();
    });

    saveBtn.addEventListener('click', async () => {
      if (this.contextTargetMessage && !this.contextTargetIsSnap) {
        await this.toggleMessageSave(this.contextTargetMessage);
        this.renderDmMessages();
      }
      this.hideContextMenu();
    });

    copyBtn.addEventListener('click', async () => {
      if (this.contextTargetMessage && this.contextTargetMessage.text) {
        try {
          await navigator.clipboard.writeText(this.contextTargetMessage.text);
          this.showToast('Message copié');
        } catch (err) {
          this.showToast('Impossible de copier automatiquement');
        }
      }
      this.hideContextMenu();
    });

    if (deleteMeBtn) {
      deleteMeBtn.addEventListener('click', async () => {
        if (this.contextTargetMessage) {
          await this.deleteMessage(this.contextTargetMessage, 'me');
        }
        this.hideContextMenu();
      });
    }

    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', async () => {
        if (this.contextTargetMessage && this.contextTargetMessage.isOutgoing) {
          await this.deleteMessage(this.contextTargetMessage, 'all');
        }
        this.hideContextMenu();
      });
    }

    // Fermer le menu si clic ou scroll en dehors
    document.addEventListener('pointerdown', (e) => {
      if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
        this.hideContextMenu();
      }
    });

    const msgContainer = document.getElementById('dm-messages-container');
    if (msgContainer) {
      msgContainer.addEventListener('scroll', () => this.hideContextMenu(), { passive: true });
    }
  }

  showContextMenu(clientX, clientY, message, isSnap = false) {
    const menu = document.getElementById('msg-context-menu');
    const saveBtn = document.getElementById('ctx-save-btn');
    const saveLabel = document.getElementById('ctx-save-label');
    const copyBtn = document.getElementById('ctx-copy-btn');
    const deleteAllBtn = document.getElementById('ctx-delete-all-btn');
    if (!menu || !message || message.type === 'system') return;

    this.contextTargetMessage = message;
    this.contextTargetIsSnap = isSnap;

    menu.querySelectorAll('.ctx-reaction-btn').forEach((btn) => {
      const emoji = btn.dataset.emoji;
      const hasReacted =
        Array.isArray(message.reactions?.[emoji]) &&
        message.reactions[emoji].includes(this.profile?.uuid);
      btn.classList.toggle('active', hasReacted);
    });

    if (isSnap) {
      saveBtn.classList.add('hidden');
      copyBtn.classList.add('hidden');
    } else {
      saveBtn.classList.remove('hidden');
      copyBtn.classList.remove('hidden');
      saveLabel.textContent = message.saved ? 'Désenregistrer du chat' : 'Enregistrer dans le chat';
    }

    if (deleteAllBtn) {
      deleteAllBtn.classList.toggle('hidden', !message.isOutgoing);
    }

    menu.classList.remove('hidden');
    menu.style.left = '0px';
    menu.style.top = '0px';

    const rect = menu.getBoundingClientRect();
    const pad = 10;
    const left = Math.max(pad, Math.min(clientX, window.innerWidth - rect.width - pad));
    const top = Math.max(pad, Math.min(clientY, window.innerHeight - rect.height - pad));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  hideContextMenu() {
    const menu = document.getElementById('msg-context-menu');
    if (menu) {
      menu.classList.add('hidden');
    }
    this.contextTargetMessage = null;
    this.contextTargetIsSnap = false;
  }

  setReplyTarget(message) {
    if (!this.currentDmPeer || !message) return;

    const isSelf = !!message.isOutgoing;
    const senderUuid = isSelf ? this.profile.uuid : this.currentDmPeer.uuid;
    const senderNickname = isSelf ? 'MOI' : this.currentDmPeer.nickname;
    const previewText =
      message.type === 'snap'
        ? message.mediaType === 'video'
          ? 'Snap Vidéo'
          : 'Snap Photo'
        : message.text || '';

    this.replyingTo = {
      id: message.id,
      senderUuid,
      senderNickname,
      text: previewText
    };

    const replyBar = document.getElementById('dm-reply-bar');
    const accent = document.getElementById('dm-reply-accent');
    const author = document.getElementById('dm-reply-author');
    const textEl = document.getElementById('dm-reply-text');

    if (accent) accent.classList.toggle('self', isSelf);
    if (author) {
      author.classList.toggle('self', isSelf);
      author.textContent = `Réponse à ${senderNickname}`;
    }
    if (textEl) textEl.textContent = previewText;
    if (replyBar) replyBar.classList.remove('hidden');

    document.getElementById('dm-input')?.focus();
  }

  clearReplyTarget() {
    this.replyingTo = null;
    const replyBar = document.getElementById('dm-reply-bar');
    if (replyBar) replyBar.classList.add('hidden');
  }

  async toggleMessageSave(message) {
    if (!this.currentDmPeer || !message) return;
    message.saved = !message.saved;
    if (message.saved) {
      await storage.saveChatMessage(this.currentDmPeer.uuid, message);
      this.showToast('Message enregistré dans le chat');
    } else {
      await storage.unsaveChatMessage(this.currentDmPeer.uuid, message.id);
      this.showToast('Message désenregistré');
    }
  }

  applyReactionUpdate(message, emoji, reactorUuid, active) {
    if (!message || !emoji || !reactorUuid) return;
    if (!message.reactions || typeof message.reactions !== 'object') {
      message.reactions = {};
    }

    const list = Array.isArray(message.reactions[emoji]) ? [...message.reactions[emoji]] : [];
    const idx = list.indexOf(reactorUuid);

    if (active && idx === -1) {
      list.push(reactorUuid);
    } else if (!active && idx !== -1) {
      list.splice(idx, 1);
    }

    if (list.length > 0) {
      message.reactions[emoji] = list;
    } else {
      delete message.reactions[emoji];
    }
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async toggleReaction(message, emoji, peerUuid = this.currentDmPeer?.uuid) {
    if (!peerUuid || !message || !message.id || !this.profile?.uuid || message.type === 'system') return;

    const existing = message.reactions?.[emoji] || [];
    const shouldAdd = !existing.includes(this.profile.uuid);

    this.applyReactionUpdate(message, emoji, this.profile.uuid, shouldAdd);
    await storage.upsertConversationMessage(peerUuid, message);

    p2p.sendReaction(peerUuid, message.id, emoji, shouldAdd);

    if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
      this.renderDmMessages();
    }
  }

  async deleteMessage(message, scope = 'me', peerUuid = this.currentDmPeer?.uuid) {
    if (!peerUuid || !message || !message.id || message.type === 'system') return;
    if (scope === 'all' && !message.isOutgoing) return;

    const conv = this.dmConversations.get(peerUuid);
    if (!conv) return;

    const idx = conv.findIndex((m) => m.id === message.id);
    if (idx === -1) return;

    if (message.type === 'snap') {
      message.mediaData = null;
    }

    if (this.replyingTo && this.replyingTo.id === message.id) {
      this.clearReplyTarget();
    }

    if (scope === 'all') {
      conv[idx] = {
        id: 'sys_del_' + message.id,
        type: 'system',
        text: 'Vous avez supprimé un message',
        timestamp: Date.now()
      };
      await storage.setConversationMessages(peerUuid, conv);
      p2p.sendDeleteMessage(peerUuid, message.id);
      this.showToast('Message supprimé pour tout le monde');
    } else {
      conv.splice(idx, 1);
      await storage.setConversationMessages(peerUuid, conv);
      this.showToast('Message supprimé pour vous');
    }

    if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
      this.renderDmMessages();
    }
    this.renderFriendsList();
  }

  async clearConversation(peerUuid, scope = 'me') {
    if (!peerUuid) return;

    const conv = this.dmConversations.get(peerUuid) || [];
    conv.forEach((m) => {
      if (m.type === 'snap') m.mediaData = null;
    });

    if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
      this.clearReplyTarget();
      this.hideContextMenu();
    }

    if (scope === 'all') {
      const notice = {
        id: 'sys_clear_' + Date.now(),
        type: 'system',
        text: 'Vous avez supprimé la discussion pour tout le monde',
        timestamp: Date.now()
      };
      this.dmConversations.set(peerUuid, [notice]);
      await storage.clearChatMessages(peerUuid, notice);
      p2p.sendClearChat(peerUuid);
      this.showToast('Discussion supprimée pour tout le monde');
    } else {
      this.dmConversations.set(peerUuid, []);
      await storage.clearChatMessages(peerUuid, null);
      this.showToast('Discussion supprimée uniquement pour vous');
    }

    if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
      this.renderDmMessages();
    }
    this.renderFriendsList();
  }

  createReactionsElement(message) {
    if (!message?.reactions || typeof message.reactions !== 'object') return null;
    const entries = Object.entries(message.reactions).filter(
      ([, users]) => Array.isArray(users) && users.length > 0
    );
    if (entries.length === 0) return null;

    const bar = document.createElement('div');
    bar.className = 'chat-reactions';

    entries.forEach(([emoji, users]) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `chat-reaction-pill ${users.includes(this.profile?.uuid) ? 'reacted' : ''}`;
      pill.title = 'Cliquer pour ajouter / retirer cette réaction';

      const emojiSpan = document.createElement('span');
      emojiSpan.textContent = emoji;
      pill.appendChild(emojiSpan);

      if (users.length > 1) {
        const countSpan = document.createElement('span');
        countSpan.className = 'chat-reaction-count';
        countSpan.textContent = String(users.length);
        pill.appendChild(countSpan);
      }

      pill.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.toggleReaction(message, emoji);
      });

      bar.appendChild(pill);
    });

    return bar;
  }

  attachMessageInteractions(el, message, isSnap, onShortClick) {
    let longPressTimer = null;
    let startX = 0;
    let startY = 0;
    let didLongPress = false;

    // Clic droit sur PC
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      this.showContextMenu(e.clientX, e.clientY, message, isSnap);
    });

    // Appui long tactile sur mobile (>= 420ms)
    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        didLongPress = false;
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        longPressTimer = setTimeout(() => {
          didLongPress = true;
          if (navigator.vibrate) navigator.vibrate(25);
          this.showContextMenu(startX, startY, message, isSnap);
        }, 420);
      },
      { passive: true }
    );

    el.addEventListener(
      'touchmove',
      (e) => {
        if (!longPressTimer || e.touches.length !== 1) return;
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dx > 10 || dy > 10) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      },
      { passive: true }
    );

    const cancelTouch = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    el.addEventListener('touchend', cancelTouch, { passive: true });
    el.addEventListener('touchcancel', cancelTouch, { passive: true });

    el.addEventListener('click', (e) => {
      if (didLongPress) {
        didLongPress = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Ne pas déclencher l'action clic si l'utilisateur vient de surligner du texte à la souris
      const selection = window.getSelection()?.toString();
      if (selection && selection.length > 0) return;

      if (onShortClick) onShortClick(e);
    });
  }

  openDmWith(peer) {
    this.currentDmPeer = peer;
    this.clearReplyTarget();
    this.hideContextMenu();

    const dmView = document.getElementById('dm-view');
    const appContainer = document.getElementById('app-container');
    const avatar = document.getElementById('dm-peer-avatar');
    const name = document.getElementById('dm-peer-name');
    const tagEl = document.getElementById('dm-peer-tag');
    const statusText = document.getElementById('dm-peer-status-text');
    const statusDot = document.getElementById('dm-peer-status-dot');

    avatar.src = peer.avatar || storage.createDefaultAvatar(peer.nickname);
    name.textContent = peer.nickname;
    if (tagEl) {
      tagEl.textContent = peer.tag || formatTag(peer.publicKeyHash || peer.uuid);
    }

    const isOnline = p2p.isUserOnline(peer.uuid);
    statusText.textContent = isOnline ? 'En ligne' : 'Vu récemment';
    statusDot.style.background = isOnline ? 'var(--snap-green)' : 'var(--snap-gray-text)';

    // Réinitialiser le badge de notification
    this.unreadChatsCount = 0;
    const badge = document.getElementById('unread-chat-badge');
    if (badge) badge.classList.add('hidden');

    void this.markConversationRead(peer.uuid);

    this.renderDmMessages();
    appContainer.classList.add('in-dm');
    dmView.classList.add('active');
    this.renderFriendsList();
    this.renderOnlinePeers();

    if (window.innerWidth >= 860) {
      setTimeout(() => document.getElementById('dm-input')?.focus(), 120);
    }
  }

  async markConversationRead(peerUuid) {
    if (!peerUuid) return;
    const conv = this.dmConversations.get(peerUuid);
    if (!conv || conv.length === 0) return;

    const unreadIds = [];
    for (const m of conv) {
      if (!m.isOutgoing && m.type !== 'snap' && m.type !== 'system' && !m.readAckSent && m.id) {
        m.readAckSent = true;
        unreadIds.push(m.id);
      }
    }

    if (unreadIds.length > 0) {
      await storage.setConversationMessages(peerUuid, conv);
      p2p.sendMessageReceipt(peerUuid, unreadIds, 'read');
      this.renderFriendsList();
    }
  }

  renderDmMessages() {
    const container = document.getElementById('dm-messages-container');
    container.innerHTML = '';

    if (!this.currentDmPeer) return;
    const messages = this.dmConversations.get(this.currentDmPeer.uuid) || [];

    if (messages.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.style.cssText = 'text-align:center;color:var(--snap-gray-text);font-size:12px;margin:auto;';
      emptyEl.appendChild(document.createTextNode('C\'est le début de votre discussion avec '));
      const strong = document.createElement('strong');
      strong.textContent = this.currentDmPeer.nickname;
      emptyEl.appendChild(strong);
      emptyEl.appendChild(document.createTextNode('.'));
      emptyEl.appendChild(document.createElement('br'));
      emptyEl.appendChild(
        document.createTextNode('Clic droit (PC) ou appui long (mobile) sur un message pour réagir, répondre ou supprimer !')
      );
      container.appendChild(emptyEl);
      return;
    }

    messages.forEach((m) => {
      if (m.type === 'system') {
        const notice = document.createElement('div');
        notice.className = 'dm-system-notice';
        notice.textContent = m.text || 'Message supprimé';
        container.appendChild(notice);
        return;
      }

      const wrapper = document.createElement('div');
      wrapper.className = `chat-msg-wrapper ${m.isOutgoing ? 'outgoing' : 'incoming'}`;

      if (m.type === 'snap') {
        const snapCard = document.createElement('div');
        snapCard.className = `dm-snap-card ${m.isOutgoing ? 'outgoing' : 'incoming'}`;
        if (m.id) snapCard.dataset.msgId = m.id;

        const isOpened = m.isOpened;
        const iconClass = isOpened
          ? 'opened'
          : m.mediaType === 'video'
          ? 'video'
          : 'photo';
        const iconSymbol = isOpened ? '◻' : m.mediaType === 'video' ? '▶' : '■';

        let statusLabel = '';
        if (m.isOutgoing) {
          statusLabel = isOpened ? 'Ouvert' : 'Délivré';
        } else {
          statusLabel = isOpened ? 'Ouvert' : 'Nouveau Snap • Toucher pour voir';
        }

        snapCard.innerHTML = `
          <div class="dm-snap-icon-big ${iconClass}">
            ${iconSymbol}
          </div>
          <div>
            <div style="font-weight:700;font-size:14px;">
              ${m.mediaType === 'video' ? 'Snap Vidéo' : 'Snap Photo'}
            </div>
            <div style="font-size:11px;color:var(--snap-gray-text);">
              ${statusLabel}
            </div>
          </div>
        `;

        this.attachMessageInteractions(snapCard, m, true, () => {
          if (!m.isOutgoing && !isOpened && m.mediaData) {
            viewer.openSnap(m);
          }
        });

        wrapper.appendChild(snapCard);
      } else {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${m.isOutgoing ? 'outgoing' : 'incoming'} ${m.saved ? 'saved' : ''}`;
        if (m.id) bubble.dataset.msgId = m.id;
        bubble.title = 'Clic droit / Appui long : Réagir, Répondre, Supprimer • Clic : Enregistrer';

        // En-tête auteur + heure (style Snapchat Web)
        const meta = document.createElement('div');
        meta.className = 'chat-msg-meta';
        const senderSpan = document.createElement('span');
        senderSpan.className = `chat-msg-sender ${m.isOutgoing ? 'self' : 'peer'}`;
        senderSpan.textContent = m.isOutgoing ? 'MOI' : this.currentDmPeer.nickname;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-msg-time';
        if (m.timestamp) {
          timeSpan.textContent = new Date(m.timestamp).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit'
          });
        }
        meta.appendChild(senderSpan);
        meta.appendChild(timeSpan);
        bubble.appendChild(meta);

        // Bloc citation si le message est une réponse
        if (m.replyTo && m.replyTo.text) {
          const quoteBox = document.createElement('div');
          const isQuoteSelf = m.replyTo.senderUuid === this.profile.uuid;
          quoteBox.className = `chat-quote-box ${isQuoteSelf ? 'quote-self' : ''}`;

          const quoteAuthor = document.createElement('div');
          quoteAuthor.className = 'chat-quote-author';
          quoteAuthor.textContent = isQuoteSelf ? 'MOI' : (m.replyTo.senderNickname || this.currentDmPeer.nickname);

          const quoteText = document.createElement('div');
          quoteText.className = 'chat-quote-text';
          quoteText.textContent = m.replyTo.text;

          quoteBox.appendChild(quoteAuthor);
          quoteBox.appendChild(quoteText);

          // Cliquer sur la citation fait défiler vers le message original
          quoteBox.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!m.replyTo.id) return;
            const targetEl = container.querySelector(`[data-msg-id="${m.replyTo.id}"]`);
            if (targetEl) {
              targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
              targetEl.classList.add('highlight-flash');
              setTimeout(() => targetEl.classList.remove('highlight-flash'), 1200);
            }
          });

          bubble.appendChild(quoteBox);
        }

        // Corps du message
        const bodyEl = document.createElement('div');
        bodyEl.className = 'chat-msg-body';
        bodyEl.textContent = m.text;
        bubble.appendChild(bodyEl);

        // Statut Envoyé / Remis / Vu sur les messages sortants
        if (m.isOutgoing) {
          const st = m.status || 'sent';
          const statusEl = document.createElement('div');
          statusEl.className = `chat-msg-status status-${st}`;

          if (st === 'read' || st === 'delivered') {
            statusEl.innerHTML = `
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="18 6 9 17 4 12"></polyline>
                <polyline points="22 10 13 21 11 19"></polyline>
              </svg>
              <span>${st === 'read' ? 'Vu' : 'Remis'}</span>
            `;
          } else {
            statusEl.innerHTML = `
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>Envoyé</span>
            `;
          }
          bubble.appendChild(statusEl);
        }

        this.attachMessageInteractions(bubble, m, false, async () => {
          await this.toggleMessageSave(m);
          bubble.classList.toggle('saved', m.saved);
        });

        wrapper.appendChild(bubble);
      }

      const reactionsEl = this.createReactionsElement(m);
      if (reactionsEl) {
        wrapper.appendChild(reactionsEl);
      }

      container.appendChild(wrapper);
    });

    container.scrollTop = container.scrollHeight;
  }

  /**
   * =========================================================================
   * GESTION DES DEMANDES D'AMIS PAR PSEUDO & ACCEPTATION
   * =========================================================================
   */
  bindFriendRequestEvents() {
    const addModal = document.getElementById('add-friend-modal');
    const openBtn = document.getElementById('btn-add-friend-modal');
    const closeBtn = document.getElementById('btn-close-add-friend-modal');
    const form = document.getElementById('add-friend-form');
    const input = document.getElementById('input-friend-pseudo');

    openBtn.addEventListener('click', () => {
      addModal.style.display = 'flex';
      input.focus();
    });

    closeBtn.addEventListener('click', () => {
      addModal.style.display = 'none';
      input.value = '';
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = input.value.trim();
      if (!query) return;

      const myHash = (this.profile.publicKeyHash || this.profile.uuid || '').toLowerCase();
      const myTag = (this.profile.tag || formatTag(myHash)).toUpperCase();
      const myNickTag = `${this.profile.nickname.toLowerCase()}${myTag.toLowerCase()}`;
      if (
        query.toLowerCase() === this.profile.nickname.toLowerCase() ||
        query.toLowerCase() === myNickTag ||
        query.toLowerCase() === myHash
      ) {
        this.showToast('Vous ne pouvez pas vous ajouter vous-même');
        return;
      }

      const matchedPeer = p2p.findPeerByPseudo(query);
      const dirPeer = storage.resolvePeerInDirectory(query);
      const targetUuid = matchedPeer?.uuid || dirPeer?.publicKeyHash || null;

      // Vérifier si déjà ami
      const isAlreadyFriend = this.profile.friends?.some((f) => {
        if (targetUuid && (f.publicKeyHash || f.uuid || '').toLowerCase() === targetUuid) {
          return true;
        }
        return f.nickname.toLowerCase() === query.toLowerCase();
      });
      if (isAlreadyFriend) {
        this.showToast(`${query} est déjà dans vos amis`);
        addModal.style.display = 'none';
        input.value = '';
        return;
      }

      p2p.sendFriendRequest(query, targetUuid);

      addModal.style.display = 'none';
      input.value = '';
      this.showToast(`Demande d'ami envoyée à ${query}`);
    });
  }

  renderFriendRequests() {
    const section = document.getElementById('friend-requests-section');
    const list = document.getElementById('friend-requests-list');

    if (this.pendingFriendRequests.size === 0) {
      section.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    section.classList.remove('hidden');
    list.innerHTML = '';

    this.pendingFriendRequests.forEach((req) => {
      const reqTag = req.fromTag || formatTag(req.fromUuid);
      const card = document.createElement('div');
      card.className = 'friend-request-card';
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;overflow:hidden;">
          <img src="${req.fromAvatar || storage.createDefaultAvatar(req.fromNickname)}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;">
          <div style="overflow:hidden;">
            <div class="user-nickname-row" style="font-weight:700;font-size:14px;">
              <span class="user-nickname-text">${this.escapeHtml(req.fromNickname)}</span>
              <span class="user-tag-badge">${reqTag}</span>
            </div>
            <div style="font-size:11px;color:var(--snap-yellow);">Demande d'ami signée reçue</div>
          </div>
        </div>
        <div class="friend-req-actions">
          <button class="btn-req-accept" data-req-id="${req.requestId}">
            <svg class="svg-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span>Accepter</span>
          </button>
          <button class="btn-req-refuse" data-req-id="${req.requestId}">
            <span>Refuser</span>
          </button>
        </div>
      `;

      card.querySelector('.btn-req-accept').onclick = async () => {
        p2p.sendFriendResponse(req.requestId, req.fromUuid, true);
        await storage.addFriend({
          uuid: req.fromUuid,
          publicKeyHash: req.fromUuid,
          tag: reqTag,
          nickname: req.fromNickname,
          avatar: req.fromAvatar,
          publicKey: req.fromPublicKey || null,
          verified: true
        });
        this.profile = await storage.getProfile();
        this.pendingFriendRequests.delete(req.requestId);
        this.renderFriendRequests();
        this.renderFriendsList();
        this.renderOnlinePeers();
        this.renderDirectoryList();
        this.showToast(`${req.fromNickname} (${reqTag}) ajouté à vos amis !`);
      };

      card.querySelector('.btn-req-refuse').onclick = () => {
        p2p.sendFriendResponse(req.requestId, req.fromUuid, false);
        this.pendingFriendRequests.delete(req.requestId);
        this.renderFriendRequests();
        this.showToast('Demande refusée');
      };

      list.appendChild(card);
    });
  }

  /**
   * =========================================================================
   * ÉCOUTEURS D'ÉVÉNEMENTS P2P
   * =========================================================================
   */
  setupP2PListeners() {
    p2p.on('peerJoin', (peer) => {
      this.showToast(`${peer.nickname} a rejoint le salon`);
      this.renderOnlinePeers();
      this.renderFriendsList();
    });

    p2p.on('peerLeave', () => {
      this.renderOnlinePeers();
      this.renderFriendsList();
    });

    p2p.on('peersUpdate', () => {
      this.renderOnlinePeers();
      this.renderFriendsList();
    });

    p2p.on('roomChanged', (roomId) => {
      const topRoom = document.getElementById('top-room-name');
      const chatRoom = document.getElementById('chat-room-name');
      if (topRoom) topRoom.textContent = roomId;
      if (chatRoom) chatRoom.textContent = roomId;
    });

    p2p.on('chatMessage', async (msg) => {
      const senderUuid = msg.senderUuid;
      if (!this.dmConversations.has(senderUuid)) {
        this.dmConversations.set(senderUuid, []);
      }

      const isActivelyReading =
        this.currentDmPeer &&
        this.currentDmPeer.uuid === senderUuid &&
        document.visibilityState === 'visible';

      const incomingEntry = {
        ...msg,
        isOutgoing: false,
        readAckSent: !!isActivelyReading
      };
      this.dmConversations.get(senderUuid).push(incomingEntry);
      await storage.upsertConversationMessage(senderUuid, incomingEntry);

      // Envoyer accusé "Remis" immédiat + "Vu" si la discussion est active à l'écran
      if (msg.id) {
        p2p.sendMessageReceipt(senderUuid, [msg.id], 'delivered');
        if (isActivelyReading) {
          p2p.sendMessageReceipt(senderUuid, [msg.id], 'read');
        }
      }

      if (this.currentDmPeer && this.currentDmPeer.uuid === senderUuid) {
        this.renderDmMessages();
      } else {
        const peer = p2p.peers.get(msg.fromPeerId);
        const name = peer?.nickname || storage.getDirectoryEntry(senderUuid)?.pseudo || 'Un ami';
        this.showToast(`Nouveau message de ${name}`);
        this.incrementChatBadge();
      }
      this.renderFriendsList();
    });

    p2p.on('messageReceipt', async (data) => {
      const peerUuid = data.senderUuid;
      const conv = this.dmConversations.get(peerUuid);
      if (!conv || !Array.isArray(data.messageIds)) return;

      const statusRank = { sent: 1, delivered: 2, read: 3 };
      const nextRank = statusRank[data.status] || 0;
      if (nextRank === 0) return;

      let updated = false;
      for (const m of conv) {
        if (m.isOutgoing && data.messageIds.includes(m.id)) {
          const curRank = statusRank[m.status || 'sent'] || 1;
          if (nextRank > curRank) {
            m.status = data.status;
            if (data.status === 'delivered') m.deliveredAt = data.timestamp || Date.now();
            if (data.status === 'read') m.readAt = data.timestamp || Date.now();
            updated = true;
          }
        }
      }

      if (updated) {
        await storage.setConversationMessages(peerUuid, conv);
        if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
          this.renderDmMessages();
        }
        this.renderFriendsList();
      }
    });

    p2p.on('typing', (data) => {
      if (this.currentDmPeer && this.currentDmPeer.uuid === data.senderUuid) {
        const bar = document.getElementById('dm-typing-bar');
        const nameSpan = document.getElementById('dm-typing-name');
        nameSpan.textContent = this.currentDmPeer.nickname;
        bar.classList.toggle('hidden', !data.isTyping);
      }
    });

    p2p.on('snap', async (snapData) => {
      const senderUuid = snapData.senderUuid;

      if (!this.dmConversations.has(senderUuid)) {
        this.dmConversations.set(senderUuid, []);
      }

      const incomingSnap = {
        ...snapData,
        type: 'snap',
        isOutgoing: false,
        isOpened: false
      };
      this.dmConversations.get(senderUuid).push(incomingSnap);
      await storage.upsertConversationMessage(senderUuid, incomingSnap);

      this.showToast(`Nouveau Snap reçu de ${snapData.senderNickname || 'un ami'}`);
      this.incrementChatBadge();
      this.renderFriendsList();

      if (this.currentDmPeer && this.currentDmPeer.uuid === senderUuid) {
        this.renderDmMessages();
      }
    });

    p2p.on('snapOpened', async (receipt) => {
      const targetUuid = receipt.openerUuid;
      if (this.dmConversations.has(targetUuid)) {
        const conv = this.dmConversations.get(targetUuid);
        const snap = conv.find((m) => m.id === receipt.snapId);
        if (snap) {
          snap.isOpened = true;
          snap.openedAt = receipt.openedAt;
          await storage.setConversationMessages(targetUuid, conv);
        }
      }
      this.renderFriendsList();
      if (this.currentDmPeer && this.currentDmPeer.uuid === targetUuid) {
        this.renderDmMessages();
      }
    });

    p2p.on('messageReaction', async (data) => {
      const peerUuid = data.senderUuid;
      const conv = this.dmConversations.get(peerUuid);
      if (!conv) return;

      const targetMsg = conv.find((m) => m.id === data.messageId);
      if (!targetMsg || targetMsg.type === 'system') return;

      this.applyReactionUpdate(targetMsg, data.emoji, data.senderUuid, data.active);
      await storage.upsertConversationMessage(peerUuid, targetMsg);

      if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
        this.renderDmMessages();
      }
    });

    p2p.on('messageDelete', async (data) => {
      const peerUuid = data.senderUuid;
      const conv = this.dmConversations.get(peerUuid);
      if (!conv) return;

      const idx = conv.findIndex((m) => m.id === data.messageId);
      if (idx === -1) return;

      const targetMsg = conv[idx];
      if (targetMsg.isOutgoing) return;

      if (targetMsg.type === 'snap') {
        targetMsg.mediaData = null;
      }

      if (this.replyingTo && this.replyingTo.id === data.messageId) {
        this.clearReplyTarget();
      }

      const peerName =
        data.senderNickname ||
        p2p.peers.get(data.fromPeerId)?.nickname ||
        storage.getDirectoryEntry(peerUuid)?.pseudo ||
        (this.currentDmPeer?.uuid === peerUuid ? this.currentDmPeer.nickname : null) ||
        'Un ami';

      conv[idx] = {
        id: 'sys_del_' + data.messageId,
        type: 'system',
        text: `${peerName} a supprimé un message`,
        timestamp: Date.now()
      };
      await storage.setConversationMessages(peerUuid, conv);

      if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
        this.renderDmMessages();
      }
      this.renderFriendsList();
    });

    p2p.on('chatClear', async (data) => {
      const peerUuid = data.senderUuid;
      const conv = this.dmConversations.get(peerUuid) || [];
      conv.forEach((m) => {
        if (m.type === 'snap') m.mediaData = null;
      });

      const peerName =
        data.senderNickname ||
        p2p.peers.get(data.fromPeerId)?.nickname ||
        storage.getDirectoryEntry(peerUuid)?.pseudo ||
        (this.currentDmPeer?.uuid === peerUuid ? this.currentDmPeer.nickname : null) ||
        'Votre ami';

      const notice = {
        id: 'sys_clear_' + Date.now(),
        type: 'system',
        text: `${peerName} a supprimé la discussion`,
        timestamp: Date.now()
      };

      this.dmConversations.set(peerUuid, [notice]);
      await storage.clearChatMessages(peerUuid, notice);

      if (this.currentDmPeer && this.currentDmPeer.uuid === peerUuid) {
        this.clearReplyTarget();
        this.hideContextMenu();
        this.renderDmMessages();
      } else {
        this.showToast(`${peerName} a supprimé votre discussion`);
      }
      this.renderFriendsList();
    });

    p2p.on('directoryUpdate', async () => {
      this.profile = await storage.getProfile();
      this.renderDirectoryList();
      this.renderFriendsList();
      this.renderOnlinePeers();
    });

    // Demande d'ami reçue
    p2p.on('friendRequest', (req) => {
      this.pendingFriendRequests.set(req.requestId, req);
      this.renderFriendRequests();
      this.showToast(`Demande d'ami reçue de ${req.fromNickname} (${req.fromTag || ''})`);
    });

    // Réponse à une demande d'ami
    p2p.on('friendResponse', async (resp) => {
      if (resp.accepted) {
        await storage.addFriend({
          uuid: resp.fromUuid,
          publicKeyHash: resp.fromUuid,
          tag: resp.fromTag || formatTag(resp.fromUuid),
          nickname: resp.fromNickname,
          avatar: resp.fromAvatar,
          publicKey: resp.fromPublicKey || null,
          verified: true
        });
        this.profile = await storage.getProfile();
        this.renderFriendsList();
        this.renderOnlinePeers();
        this.renderDirectoryList();
        this.showToast(`${resp.fromNickname} (${resp.fromTag || ''}) a accepté votre demande d'ami !`);
      } else {
        this.showToast(`${resp.fromNickname} a décliné la demande`);
      }
    });
  }

  /**
   * =========================================================================
   * RENDU DES LISTES (AMIS & PAIRS EN LIGNE)
   * =========================================================================
   */
  bindChatListControls() {
    const searchInput = document.getElementById('chat-search-input');
    const toggleGossipBtn = document.getElementById('btn-toggle-gossip');

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.chatSearchQuery = e.target.value.trim().toLowerCase();
        this.renderUnifiedList();
      });
    }

    if (toggleGossipBtn) {
      toggleGossipBtn.addEventListener('click', () => {
        this.showGossipDirectory = !this.showGossipDirectory;
        toggleGossipBtn.classList.toggle('active', this.showGossipDirectory);
        this.renderUnifiedList();
      });
    }
  }

  getVerifiedBadgeHtml(isVerified) {
    if (!isVerified) return '';
    return `
      <span class="verified-badge" title="Identité vérifiée ECDSA">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          <polyline points="9 12 11 14 15 10"></polyline>
        </svg>
      </span>
    `;
  }

  renderFriendsList() {
    this.renderUnifiedList();
  }

  renderOnlinePeers() {
    this.renderUnifiedList();
  }

  renderDirectoryList() {
    this.renderUnifiedList();
  }

  renderUnifiedList() {
    const container = document.getElementById('unified-chats-container');
    const countBadge = document.getElementById('directory-count-badge');
    if (!container || !this.profile) return;

    const myHash = (this.profile.publicKeyHash || this.profile.uuid || '').toLowerCase();
    const dirEntries = storage
      .getDirectoryEntries()
      .filter((e) => e.publicKeyHash.toLowerCase() !== myHash);

    if (countBadge) {
      countBadge.textContent = String(dirEntries.length);
    }

    const onlinePeers = p2p.getOnlinePeers();
    const onlineMap = new Map();
    onlinePeers.forEach((p) => {
      const id = (p.publicKeyHash || p.uuid || '').toLowerCase();
      if (id && id !== myHash) onlineMap.set(id, p);
    });

    const merged = new Map();

    // 1. Amis sauvegardés
    (this.profile.friends || []).forEach((f) => {
      const id = (f.publicKeyHash || f.uuid || '').toLowerCase();
      if (!id || id === myHash) return;
      const online = onlineMap.get(id);
      const dir = storage.getDirectoryEntry(id);
      merged.set(id, {
        uuid: id,
        publicKeyHash: id,
        tag: f.tag || online?.tag || dir?.tag || formatTag(id),
        nickname: online?.nickname || dir?.pseudo || f.nickname || 'Ami',
        avatar: online?.avatar || dir?.avatar || f.avatar || '',
        publicKey: f.publicKey || online?.publicKey || dir?.publicKey || null,
        verified: !!(f.verified || online?.verified || dir),
        isFriend: true,
        isOnline: !!online,
        addedAt: f.addedAt || 0,
        firstSeen: dir?.firstSeen || online?.firstSeen || 0
      });
    });

    // 2. Conversations actives ou passées (même avec des pairs non-amis)
    this.dmConversations.forEach((msgs, rawId) => {
      const id = String(rawId || '').toLowerCase();
      if (!id || id === myHash || !Array.isArray(msgs) || msgs.length === 0) return;
      if (merged.has(id)) return;
      const online = onlineMap.get(id);
      const dir = storage.getDirectoryEntry(id);
      const lastNamedMsg = [...msgs].reverse().find((m) => m.senderNickname);
      merged.set(id, {
        uuid: id,
        publicKeyHash: id,
        tag: online?.tag || dir?.tag || formatTag(id),
        nickname: online?.nickname || dir?.pseudo || lastNamedMsg?.senderNickname || 'Utilisateur',
        avatar: online?.avatar || dir?.avatar || '',
        publicKey: online?.publicKey || dir?.publicKey || null,
        verified: !!(online?.verified || dir),
        isFriend: false,
        isOnline: !!online,
        addedAt: 0,
        firstSeen: dir?.firstSeen || online?.firstSeen || 0
      });
    });

    // 3. Pairs actuellement en ligne dans le salon
    onlineMap.forEach((online, id) => {
      if (merged.has(id)) {
        merged.get(id).isOnline = true;
        return;
      }
      const dir = storage.getDirectoryEntry(id);
      merged.set(id, {
        uuid: id,
        publicKeyHash: id,
        tag: online.tag || dir?.tag || formatTag(id),
        nickname: online.nickname || dir?.pseudo || 'Anonyme',
        avatar: online.avatar || dir?.avatar || '',
        publicKey: online.publicKey || dir?.publicKey || null,
        verified: !!(online.verified || dir),
        isFriend: false,
        isOnline: true,
        addedAt: 0,
        firstSeen: online.firstSeen || dir?.firstSeen || 0
      });
    });

    // 4. Annuaire Gossip hors-ligne : masqué par défaut pour ne pas encombrer,
    // affiché uniquement lors d'une recherche ou si le bouton "Annuaire" est activé
    if (this.showGossipDirectory || this.chatSearchQuery.length > 0) {
      dirEntries.forEach((entry) => {
        const id = entry.publicKeyHash.toLowerCase();
        if (merged.has(id)) return;
        merged.set(id, {
          uuid: id,
          publicKeyHash: id,
          tag: entry.tag,
          nickname: entry.pseudo,
          avatar: entry.avatar || '',
          publicKey: entry.publicKey,
          verified: true,
          isFriend: false,
          isOnline: onlineMap.has(id),
          addedAt: 0,
          firstSeen: entry.firstSeen || 0
        });
      });
    }

    // Filtrage + calcul activité dernier message
    let list = Array.from(merged.values()).map((entry) => {
      const conv = this.dmConversations.get(entry.uuid) || [];
      const lastMsg = conv[conv.length - 1] || null;
      return {
        ...entry,
        conv,
        lastMsg,
        lastActivityTs: lastMsg ? (lastMsg.timestamp || 0) : 0
      };
    });

    if (this.chatSearchQuery) {
      const q = this.chatSearchQuery;
      list = list.filter(
        (e) =>
          e.nickname.toLowerCase().includes(q) ||
          e.tag.toLowerCase().includes(q) ||
          e.uuid.includes(q)
      );
    }

    // Tri : derniers chats en premier, puis en ligne, puis amis
    list.sort((a, b) => {
      if (b.lastActivityTs !== a.lastActivityTs) {
        return b.lastActivityTs - a.lastActivityTs;
      }
      if (a.isOnline !== b.isOnline) {
        return a.isOnline ? -1 : 1;
      }
      if (a.isFriend !== b.isFriend) {
        return a.isFriend ? -1 : 1;
      }
      return (b.addedAt || b.firstSeen || 0) - (a.addedAt || a.firstSeen || 0);
    });

    if (list.length === 0) {
      container.innerHTML = `
        <div class="user-status-msg" style="padding:12px 6px;">
          ${this.chatSearchQuery ? 'Aucun résultat pour cette recherche.' : 'Aucune discussion ni pair en ligne. Utilisez "+ Ami" ou le QR Code !'}
        </div>`;
      return;
    }

    container.innerHTML = '';
    list.forEach((entry) => {
      const lastMsg = entry.lastMsg;
      let lastActivityText = entry.conv.length === 0 ? 'Démarrer un chat' : '';
      let iconHtml = '<span class="snap-icon opened"></span>';

      if (lastMsg) {
        if (lastMsg.type === 'snap') {
          if (!lastMsg.isOpened && !lastMsg.isOutgoing) {
            iconHtml = `<span class="snap-icon ${lastMsg.mediaType === 'video' ? 'video-unopened' : 'photo-unopened'}"></span>`;
            lastActivityText = 'Nouveau Snap';
          } else {
            iconHtml = '<span class="snap-icon opened"></span>';
            lastActivityText = lastMsg.isOutgoing ? (lastMsg.isOpened ? 'Ouvert' : 'Remis') : 'Snap ouvert';
          }
        } else if (lastMsg.type === 'system') {
          iconHtml = '<span class="snap-icon opened"></span>';
          lastActivityText = lastMsg.text ? lastMsg.text.slice(0, 26) : 'Message supprimé';
        } else if (lastMsg.isOutgoing) {
          const st = lastMsg.status || 'sent';
          if (st === 'read') {
            iconHtml = '<span class="snap-icon chat-read"></span>';
            lastActivityText = 'Vu';
          } else if (st === 'delivered') {
            iconHtml = '<span class="snap-icon chat-delivered"></span>';
            lastActivityText = 'Remis';
          } else {
            iconHtml = '<span class="snap-icon chat-delivered"></span>';
            lastActivityText = 'Envoyé';
          }
        } else {
          if (!lastMsg.readAckSent) {
            iconHtml = '<span class="snap-icon chat-unread"></span>';
            lastActivityText = 'Nouveau Chat';
          } else {
            iconHtml = '<span class="snap-icon chat-read"></span>';
            lastActivityText = lastMsg.text ? lastMsg.text.slice(0, 24) : 'Message';
          }
        }
      }

      const item = document.createElement('div');
      const isActive = this.currentDmPeer && this.currentDmPeer.uuid === entry.uuid;
      item.className = `user-item ${isActive ? 'active-chat' : ''}`;
      item.innerHTML = `
        <div class="user-left">
          <div class="user-avatar-wrap">
            <img src="${entry.avatar || storage.createDefaultAvatar(entry.nickname)}" alt="Avatar">
            ${entry.isOnline ? '<span class="status-indicator"></span>' : ''}
          </div>
          <div class="user-text-info">
            <div class="user-nickname user-nickname-row">
              <span class="user-nickname-text">${this.escapeHtml(entry.nickname)}</span>
              <span class="user-tag-badge">${entry.tag}</span>
              ${this.getVerifiedBadgeHtml(entry.verified)}
            </div>
            <div class="user-status-msg">${iconHtml} <span>${this.escapeHtml(lastActivityText)}</span></div>
          </div>
        </div>
        <div class="user-badges-actions">
          <span class="status-pill ${entry.isOnline ? 'online' : 'offline'}">
            ${entry.isOnline ? 'En ligne' : 'Hors ligne'}
          </span>
          ${
            entry.isFriend
              ? '<span class="friend-pill">Ami</span>'
              : '<button type="button" class="btn-friend">+ Ajouter</button>'
          }
        </div>
      `;

      const addBtn = item.querySelector('.btn-friend');
      if (addBtn) {
        addBtn.onclick = async (e) => {
          e.stopPropagation();
          if (entry.isOnline) {
            p2p.sendFriendRequest(`${entry.nickname}${entry.tag}`, entry.uuid);
            this.showToast(`Demande d'ami envoyée à ${entry.nickname} (${entry.tag})`);
          } else {
            await storage.addFriend({
              uuid: entry.uuid,
              publicKeyHash: entry.uuid,
              tag: entry.tag,
              nickname: entry.nickname,
              avatar: entry.avatar,
              publicKey: entry.publicKey,
              verified: true,
              addedVia: 'gossip'
            });
            this.profile = await storage.getProfile();
            this.showToast(`${entry.nickname} (${entry.tag}) ajouté aux amis`);
          }
          this.renderUnifiedList();
        };
      }

      item.onclick = () => {
        this.openDmWith({
          uuid: entry.uuid,
          publicKeyHash: entry.uuid,
          tag: entry.tag,
          nickname: entry.nickname,
          avatar: entry.avatar,
          verified: entry.verified
        });
      };

      container.appendChild(item);
    });
  }

  incrementChatBadge() {
    this.unreadChatsCount++;
    const badge = document.getElementById('unread-chat-badge');
    badge.textContent = `${this.unreadChatsCount}`;
    badge.classList.remove('hidden');
  }

  /**
   * =========================================================================
   * GESTION DES MODALES (PROFIL, CLÉ, ONBOARDING, SALON)
   * =========================================================================
   */
  bindModals() {
    document.getElementById('top-avatar-btn').addEventListener('click', () => {
      this.renderProfileQrCode();
      document.getElementById('profile-modal').style.display = 'flex';
    });

    document.getElementById('btn-close-profile-modal').addEventListener('click', () => {
      document.getElementById('profile-modal').style.display = 'none';
    });

    document.getElementById('profile-file-avatar').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const b64 = await storage.compressAvatar(file);
      this.profile.avatar = b64;
      this.profile = await storage.resignOwnProfile(this.profile);
      await p2p.refreshKeys(this.profile);
      this.updateProfileUI();
      p2p.broadcastIdentity();
      this.showToast('Avatar mis à jour et re-signé');
    });

    document.getElementById('btn-copy-qr-url')?.addEventListener('click', async () => {
      if (!this.currentShareUrl) return;
      try {
        await navigator.clipboard.writeText(this.currentShareUrl);
        this.showToast('Lien QR copié dans le presse-papier');
      } catch (err) {
        this.showToast('Copiez le lien affiché sous le QR Code');
      }
    });

    document.getElementById('btn-export-key').addEventListener('click', async () => {
      const { base64Code } = await storage.exportKey();
      await storage.downloadKeyFile();

      try {
        await navigator.clipboard.writeText(base64Code);
        this.showToast('Profil complet (.json) téléchargé et code copié');
      } catch (err) {
        this.showToast('Fichier .json du profil complet téléchargé');
      }
    });

    document.getElementById('btn-import-key-modal').addEventListener('click', () => {
      document.getElementById('profile-modal').style.display = 'none';
      document.getElementById('import-key-modal').style.display = 'flex';
    });

    document.getElementById('btn-close-import-modal').addEventListener('click', () => {
      document.getElementById('import-key-modal').style.display = 'none';
    });

    document.getElementById('btn-confirm-import-key').addEventListener('click', async () => {
      const textVal = document.getElementById('import-key-text').value.trim();
      const fileInput = document.getElementById('import-key-file');
      const isTemp = document.getElementById('import-temp-session').checked;

      let keyToImport = textVal;

      if (!keyToImport && fileInput.files[0]) {
        keyToImport = await fileInput.files[0].text();
      }

      if (!keyToImport) {
        this.showToast('Veuillez coller un code ou choisir un fichier');
        return;
      }

      try {
        const imported = await storage.importKey(keyToImport, isTemp);
        document.getElementById('import-key-modal').style.display = 'none';
        document.getElementById('onboarding-modal').style.display = 'none';
        await this.startAppWithProfile(imported);
        this.showToast('Compte restauré avec succès');
      } catch (err) {
        alert('Erreur lors de l\'import de clé: ' + err.message);
      }
    });

    document.getElementById('btn-purge-account').addEventListener('click', async () => {
      if (confirm('Voulez-vous vraiment effacer votre compte et vos données locales ?')) {
        await storage.purgeAccount();
        location.reload();
      }
    });

    const handleRoomChange = async () => {
      const newRoom = prompt('Entrez le nom du salon privé (ou laissez vide pour le lobby global) :');
      if (newRoom !== null) {
        await p2p.connect(newRoom);
        this.showToast(`Connecté au salon : ${p2p.currentRoomId}`);
      }
    };

    document.getElementById('top-room-pill').addEventListener('click', handleRoomChange);
    document.getElementById('btn-change-room').addEventListener('click', handleRoomChange);
    document.getElementById('btn-create-room').addEventListener('click', handleRoomChange);

    document.getElementById('btn-join-room-code').addEventListener('click', async () => {
      const code = document.getElementById('input-room-code').value.trim();
      if (code) {
        await p2p.connect(code);
        document.getElementById('profile-modal').style.display = 'none';
        this.showToast(`Salon ${code} rejoint`);
      }
    });

    const clearChatModal = document.getElementById('clear-chat-modal');
    if (clearChatModal) {
      document.getElementById('btn-close-clear-chat-modal')?.addEventListener('click', () => {
        clearChatModal.style.display = 'none';
      });

      clearChatModal.addEventListener('click', (e) => {
        if (e.target === clearChatModal) {
          clearChatModal.style.display = 'none';
        }
      });

      document.getElementById('btn-clear-chat-me')?.addEventListener('click', async () => {
        const peerUuid = this.currentDmPeer?.uuid;
        clearChatModal.style.display = 'none';
        if (peerUuid) {
          await this.clearConversation(peerUuid, 'me');
        }
      });

      document.getElementById('btn-clear-chat-all')?.addEventListener('click', async () => {
        const peerUuid = this.currentDmPeer?.uuid;
        clearChatModal.style.display = 'none';
        if (peerUuid) {
          await this.clearConversation(peerUuid, 'all');
        }
      });
    }
  }

  showOnboardingModal() {
    const modal = document.getElementById('onboarding-modal');
    modal.style.display = 'flex';

    let avatarData = storage.createDefaultAvatar('Alex');
    const preview = document.getElementById('onboarding-avatar-preview');
    preview.src = avatarData;

    document.getElementById('onboarding-file-avatar').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        avatarData = await storage.compressAvatar(file);
        preview.src = avatarData;
      }
    });

    document.getElementById('onboarding-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pseudo = document.getElementById('onboarding-pseudo').value.trim();
      const isTemp = document.getElementById('onboarding-temp-session').checked;

      if (!pseudo) return;

      const newProfile = await storage.createProfile({
        nickname: pseudo,
        avatar: avatarData,
        temporary: isTemp
      });

      modal.style.display = 'none';
      await this.startAppWithProfile(newProfile);
    });

    document.getElementById('btn-onboarding-import').addEventListener('click', () => {
      modal.style.display = 'none';
      document.getElementById('import-key-modal').style.display = 'flex';
    });
  }

  showToast(message, duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <svg class="svg-icon-xs" viewBox="0 0 24 24" fill="var(--snap-yellow)">
        <circle cx="12" cy="12" r="10"></circle>
      </svg>
    `;
    const span = document.createElement('span');
    span.textContent = String(message ?? '');
    toast.appendChild(span);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      toast.style.transition = 'all 0.25s ease-out';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new SnapApp();
  app.init();
  window.snapApp = app;
});
