/**
 * app.js - Contrôleur Principal de Snapchat P2P
 * Navigation 2 écrans (Chat & Caméra), zéro emoji (100% SVG),
 * gestion des demandes d'amis par pseudo, chat DM et snaps éphémères.
 */

import { storage } from './storage.js';
import { p2p } from './p2p.js';
import { camera } from './camera.js';
import { editor } from './editor.js';
import { viewer } from './viewer.js';

class SnapApp {
  constructor() {
    this.currentScreenIndex = 1; // 0 = Chat, 1 = Caméra (défaut au lancement)
    this.profile = null;
    this.currentDmPeer = null;
    this.dmConversations = new Map(); // uuid -> messages
    this.pendingFriendRequests = new Map(); // requestId -> requestData
    this.preselectedRecipientUuid = null;

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

    this.bindSwipeGestures();
    this.bindBottomNav();
    this.bindDesktopControls();
    this.bindModals();
    this.bindCameraControls();
    this.bindEditorControls();
    this.bindViewerEvents();
    this.bindDmEvents();
    this.bindFriendRequestEvents();
    this.bindKeyboardShortcuts();

    this.profile = await storage.getProfile();
    if (!this.profile) {
      this.showOnboardingModal();
    } else {
      await this.startAppWithProfile(this.profile);
    }
  }

  async startAppWithProfile(profile) {
    this.profile = profile;
    this.updateProfileUI();

    // Démarrage non-bloquant de la caméra pour ne jamais retarder le réseau P2P
    const videoEl = document.getElementById('camera-video');
    camera.init(videoEl).catch((err) => {
      console.warn('Caméra différée ou refusée:', err);
    });

    await p2p.init(this.profile);
    this.setupP2PListeners();

    if (this.profile.friends) {
      for (const friend of this.profile.friends) {
        const saved = await storage.getSavedChatMessages(friend.uuid);
        if (saved && saved.length > 0) {
          this.dmConversations.set(friend.uuid, [...saved]);
        }
      }
    }

    this.renderFriendsList();
    this.renderOnlinePeers();
    this.renderFriendRequests();
    this.showToast(`Connecté en tant que ${this.profile.nickname}`);
  }

  updateProfileUI() {
    if (!this.profile) return;
    const avatarEl = document.getElementById('top-avatar-img');
    const pseudoEl = document.getElementById('top-user-pseudo');
    const profileModalAvatar = document.getElementById('profile-modal-avatar');
    const profileModalNickname = document.getElementById('profile-modal-nickname');
    const profileModalUuid = document.getElementById('profile-modal-uuid');

    if (avatarEl) avatarEl.src = this.profile.avatar;
    if (pseudoEl) pseudoEl.textContent = this.profile.nickname;
    if (profileModalAvatar) profileModalAvatar.src = this.profile.avatar;
    if (profileModalNickname) profileModalNickname.textContent = this.profile.nickname;
    if (profileModalUuid) profileModalUuid.textContent = `UUID: ${this.profile.uuid}`;
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
        row.innerHTML = `
          <input type="checkbox" class="send-recipient-checkbox" value="${target.uuid}" ${isPreselected ? 'checked' : ''}>
          <div style="display:flex;align-items:center;gap:10px;flex:1;overflow:hidden;">
            <img src="${target.avatar || storage.createDefaultAvatar(target.nickname)}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;">
            <div style="overflow:hidden;">
              <div style="font-weight:700;font-size:14px;white-space:nowrap;text-overflow:ellipsis;">${target.nickname}</div>
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
        this.dmConversations.get(uuid).push({
          id: sentSnap.id,
          type: 'snap',
          mediaType: snapPayload.mediaType,
          isOutgoing: true,
          isOpened: false,
          timestamp: Date.now()
        });
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

    viewer.onSnapFinished = (snap) => {
      if (snap.senderUuid && snap.id) {
        p2p.sendSnapReceipt(snap.id, snap.senderUuid);
      }

      if (snap.senderUuid && this.dmConversations.has(snap.senderUuid)) {
        const conv = this.dmConversations.get(snap.senderUuid);
        const targetSnap = conv.find((m) => m.id === snap.id);
        if (targetSnap) {
          targetSnap.isOpened = true;
          targetSnap.openedAt = Date.now();
        }
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

    backBtn.addEventListener('click', () => {
      dmView.classList.remove('active');
      document.getElementById('app-container').classList.remove('in-dm');
      this.currentDmPeer = null;
      this.renderFriendsList();
      this.renderOnlinePeers();
    });

    dmForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = dmInput.value.trim();
      if (!text || !this.currentDmPeer) return;

      const msg = p2p.sendMessage(this.currentDmPeer.uuid, text, true);

      if (!this.dmConversations.has(this.currentDmPeer.uuid)) {
        this.dmConversations.set(this.currentDmPeer.uuid, []);
      }
      this.dmConversations.get(this.currentDmPeer.uuid).push({
        ...msg,
        isOutgoing: true
      });

      dmInput.value = '';
      p2p.sendTyping(this.currentDmPeer.uuid, false);
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
      this.goToScreen(1); // Caméra
      this.showToast(`Prenez un Snap pour ${this.currentDmPeer.nickname}`);
    });
  }

  openDmWith(peer) {
    this.currentDmPeer = peer;
    const dmView = document.getElementById('dm-view');
    const appContainer = document.getElementById('app-container');
    const avatar = document.getElementById('dm-peer-avatar');
    const name = document.getElementById('dm-peer-name');
    const statusText = document.getElementById('dm-peer-status-text');
    const statusDot = document.getElementById('dm-peer-status-dot');

    avatar.src = peer.avatar || storage.createDefaultAvatar(peer.nickname);
    name.textContent = peer.nickname;

    const isOnline = p2p.isUserOnline(peer.uuid);
    statusText.textContent = isOnline ? 'En ligne' : 'Vu récemment';
    statusDot.style.background = isOnline ? 'var(--snap-green)' : 'var(--snap-gray-text)';

    // Réinitialiser le badge de notification
    this.unreadChatsCount = 0;
    const badge = document.getElementById('unread-chat-badge');
    if (badge) badge.classList.add('hidden');

    this.renderDmMessages();
    appContainer.classList.add('in-dm');
    dmView.classList.add('active');
    this.renderFriendsList();
    this.renderOnlinePeers();

    if (window.innerWidth >= 860) {
      setTimeout(() => document.getElementById('dm-input')?.focus(), 120);
    }
  }

  renderDmMessages() {
    const container = document.getElementById('dm-messages-container');
    container.innerHTML = '';

    if (!this.currentDmPeer) return;
    const messages = this.dmConversations.get(this.currentDmPeer.uuid) || [];

    if (messages.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;color:var(--snap-gray-text);font-size:12px;margin:auto;">
          C'est le début de votre discussion avec <strong>${this.currentDmPeer.nickname}</strong>.
          <br>Les messages et Snaps non enregistrés disparaissent après lecture !
        </div>`;
      return;
    }

    messages.forEach((m) => {
      if (m.type === 'snap') {
        const snapCard = document.createElement('div');
        snapCard.className = `dm-snap-card ${m.isOutgoing ? 'outgoing' : 'incoming'}`;

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

        if (!m.isOutgoing && !isOpened && m.mediaData) {
          snapCard.onclick = () => {
            viewer.openSnap(m);
          };
        }

        container.appendChild(snapCard);
      } else {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${m.isOutgoing ? 'outgoing' : 'incoming'} ${m.saved ? 'saved' : ''}`;
        bubble.textContent = m.text;

        bubble.title = 'Toucher pour enregistrer dans le chat';
        bubble.onclick = async () => {
          m.saved = !m.saved;
          bubble.classList.toggle('saved', m.saved);
          if (m.saved) {
            await storage.saveChatMessage(this.currentDmPeer.uuid, m);
            this.showToast('Message enregistré dans le chat');
          } else {
            await storage.unsaveChatMessage(this.currentDmPeer.uuid, m.id);
            this.showToast('Message désenregistré');
          }
        };

        container.appendChild(bubble);
      }
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
      const pseudo = input.value.trim();
      if (!pseudo) return;

      if (pseudo.toLowerCase() === this.profile.nickname.toLowerCase()) {
        this.showToast('Vous ne pouvez pas vous ajouter vous-même');
        return;
      }

      // Vérifier si déjà ami
      const isAlreadyFriend = this.profile.friends?.some(
        (f) => f.nickname.toLowerCase() === pseudo.toLowerCase()
      );
      if (isAlreadyFriend) {
        this.showToast(`${pseudo} est déjà dans vos amis`);
        addModal.style.display = 'none';
        input.value = '';
        return;
      }

      // Recherche si le pair est actuellement connecté dans la room
      const matchedPeer = p2p.findPeerByPseudo(pseudo);
      p2p.sendFriendRequest(pseudo, matchedPeer ? matchedPeer.uuid : null);

      addModal.style.display = 'none';
      input.value = '';
      this.showToast(`Demande d'ami envoyée à ${pseudo}`);
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
      const card = document.createElement('div');
      card.className = 'friend-request-card';
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;overflow:hidden;">
          <img src="${req.fromAvatar || storage.createDefaultAvatar(req.fromNickname)}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;">
          <div style="overflow:hidden;">
            <div style="font-weight:700;font-size:14px;white-space:nowrap;text-overflow:ellipsis;">${req.fromNickname}</div>
            <div style="font-size:11px;color:var(--snap-yellow);">Demande d'ami reçue</div>
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
          nickname: req.fromNickname,
          avatar: req.fromAvatar
        });
        this.profile = await storage.getProfile();
        this.pendingFriendRequests.delete(req.requestId);
        this.renderFriendRequests();
        this.renderFriendsList();
        this.renderOnlinePeers();
        this.showToast(`${req.fromNickname} ajouté à vos amis !`);
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

    p2p.on('chatMessage', (msg) => {
      const senderUuid = msg.senderUuid;
      if (!this.dmConversations.has(senderUuid)) {
        this.dmConversations.set(senderUuid, []);
      }
      this.dmConversations.get(senderUuid).push({
        ...msg,
        isOutgoing: false
      });

      if (this.currentDmPeer && this.currentDmPeer.uuid === senderUuid) {
        this.renderDmMessages();
      } else {
        const peer = p2p.peers.get(msg.fromPeerId);
        const name = peer?.nickname || 'Un ami';
        this.showToast(`Nouveau message de ${name}`);
        this.incrementChatBadge();
      }
      this.renderFriendsList();
    });

    p2p.on('typing', (data) => {
      if (this.currentDmPeer && this.currentDmPeer.uuid === data.senderUuid) {
        const bar = document.getElementById('dm-typing-bar');
        const nameSpan = document.getElementById('dm-typing-name');
        nameSpan.textContent = this.currentDmPeer.nickname;
        bar.classList.toggle('hidden', !data.isTyping);
      }
    });

    p2p.on('snap', (snapData) => {
      const senderUuid = snapData.senderUuid;

      if (!this.dmConversations.has(senderUuid)) {
        this.dmConversations.set(senderUuid, []);
      }

      this.dmConversations.get(senderUuid).push({
        ...snapData,
        type: 'snap',
        isOutgoing: false,
        isOpened: false
      });

      this.showToast(`Nouveau Snap reçu de ${snapData.senderNickname || 'un ami'}`);
      this.incrementChatBadge();
      this.renderFriendsList();

      if (this.currentDmPeer && this.currentDmPeer.uuid === senderUuid) {
        this.renderDmMessages();
      }
    });

    p2p.on('snapOpened', (receipt) => {
      const targetUuid = receipt.openerUuid;
      if (this.dmConversations.has(targetUuid)) {
        const conv = this.dmConversations.get(targetUuid);
        const snap = conv.find((m) => m.id === receipt.snapId);
        if (snap) {
          snap.isOpened = true;
          snap.openedAt = receipt.openedAt;
        }
      }
      this.renderFriendsList();
      if (this.currentDmPeer && this.currentDmPeer.uuid === targetUuid) {
        this.renderDmMessages();
      }
    });

    // Demande d'ami reçue
    p2p.on('friendRequest', (req) => {
      this.pendingFriendRequests.set(req.requestId, req);
      this.renderFriendRequests();
      this.showToast(`Demande d'ami reçue de ${req.fromNickname}`);
    });

    // Réponse à une demande d'ami
    p2p.on('friendResponse', async (resp) => {
      if (resp.accepted) {
        await storage.addFriend({
          uuid: resp.fromUuid,
          nickname: resp.fromNickname,
          avatar: resp.fromAvatar
        });
        this.profile = await storage.getProfile();
        this.renderFriendsList();
        this.renderOnlinePeers();
        this.showToast(`${resp.fromNickname} a accepté votre demande d'ami !`);
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
  renderFriendsList() {
    const container = document.getElementById('friends-list-container');
    if (!this.profile.friends || this.profile.friends.length === 0) {
      container.innerHTML = `
        <div class="user-status-msg" style="padding:10px 4px;">
          Aucun ami sauvegardé dans votre clé. Cliquez sur "+ Ami" ci-dessus !
        </div>`;
      return;
    }

    container.innerHTML = '';
    this.profile.friends.forEach((friend) => {
      const isOnline = p2p.isUserOnline(friend.uuid);
      const conv = this.dmConversations.get(friend.uuid) || [];
      const lastMsg = conv[conv.length - 1];

      let lastActivityText = isOnline ? 'En ligne' : 'Hors ligne';
      let iconHtml = '<span class="snap-icon opened"></span>';

      if (lastMsg) {
        if (lastMsg.type === 'snap') {
          if (!lastMsg.isOpened && !lastMsg.isOutgoing) {
            iconHtml = `<span class="snap-icon ${lastMsg.mediaType === 'video' ? 'video-unopened' : 'photo-unopened'}"></span>`;
            lastActivityText = 'Nouveau Snap';
          } else {
            iconHtml = '<span class="snap-icon opened"></span>';
            lastActivityText = lastMsg.isOutgoing ? 'Délivré' : 'Snap ouvert';
          }
        } else {
          iconHtml = '<span class="snap-icon chat-unread"></span>';
          lastActivityText = lastMsg.text ? lastMsg.text.slice(0, 24) : 'Message';
        }
      }

      const item = document.createElement('div');
      const isActive = this.currentDmPeer && this.currentDmPeer.uuid === friend.uuid;
      item.className = `user-item ${isActive ? 'active-chat' : ''}`;
      item.innerHTML = `
        <div class="user-left">
          <div class="user-avatar-wrap">
            <img src="${friend.avatar || storage.createDefaultAvatar(friend.nickname)}" alt="Avatar">
            ${isOnline ? '<span class="status-indicator"></span>' : ''}
          </div>
          <div class="user-text-info">
            <div class="user-nickname">${friend.nickname}</div>
            <div class="user-status-msg">${iconHtml} <span>${lastActivityText}</span></div>
          </div>
        </div>
      `;

      item.onclick = () => {
        this.openDmWith(friend);
      };

      container.appendChild(item);
    });
  }

  renderOnlinePeers() {
    const container = document.getElementById('online-peers-container');
    const peers = p2p.getOnlinePeers();

    if (peers.length === 0) {
      container.innerHTML = `
        <div class="user-status-msg" style="padding:10px 4px;">
          Aucun autre pair pour le moment dans ce salon. Ouvrez un 2ème onglet pour tester !
        </div>`;
      return;
    }

    container.innerHTML = '';
    peers.forEach((peer) => {
      const isFriend = this.profile.friends?.some((f) => f.uuid === peer.uuid);

      const item = document.createElement('div');
      const isActive = this.currentDmPeer && this.currentDmPeer.uuid === peer.uuid;
      item.className = `user-item ${isActive ? 'active-chat' : ''}`;
      item.innerHTML = `
        <div class="user-left">
          <div class="user-avatar-wrap">
            <img src="${peer.avatar || storage.createDefaultAvatar(peer.nickname)}" alt="Avatar">
            <span class="status-indicator"></span>
          </div>
          <div class="user-text-info">
            <div class="user-nickname">${peer.nickname}</div>
            <div class="user-status-msg">● En ligne dans la room</div>
          </div>
        </div>
        <div class="user-actions">
          <button class="btn-friend ${isFriend ? 'is-friend' : ''}">
            ${isFriend ? 'Ami' : '+ Ajouter'}
          </button>
        </div>
      `;

      const btnFriend = item.querySelector('.btn-friend');
      btnFriend.onclick = async (e) => {
        e.stopPropagation();
        if (isFriend) {
          await storage.removeFriend(peer.uuid);
          this.profile = await storage.getProfile();
          this.showToast(`${peer.nickname} retiré des amis`);
        } else {
          // Envoyer une demande d'ami
          p2p.sendFriendRequest(peer.nickname, peer.uuid);
          this.showToast(`Demande d'ami envoyée à ${peer.nickname}`);
        }
        this.renderOnlinePeers();
        this.renderFriendsList();
      };

      item.onclick = () => {
        this.openDmWith(peer);
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
      await storage.saveProfile(this.profile, this.profile.isTemporary);
      this.updateProfileUI();
      p2p.broadcastIdentity();
      this.showToast('Avatar mis à jour');
    });

    document.getElementById('btn-export-key').addEventListener('click', async () => {
      const { base64Code } = await storage.exportKey();
      await storage.downloadKeyFile();

      try {
        await navigator.clipboard.writeText(base64Code);
        this.showToast('Clé téléchargée et code copié dans le presse-papier');
      } catch (err) {
        this.showToast('Fichier .json de clé téléchargé');
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

      const newProfile = {
        uuid: storage.generateUUID(),
        nickname: pseudo,
        avatar: avatarData || storage.createDefaultAvatar(pseudo),
        friends: [],
        savedMessages: {},
        createdAt: Date.now()
      };

      await storage.saveProfile(newProfile, isTemp);
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
      <span>${message}</span>
    `;
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
