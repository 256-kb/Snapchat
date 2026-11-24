/**
 * p2p.js - Couche réseau P2P hybride et ultra-résiliente :
 * 1. WebRTC Trystero (Stratégie Torrent + Nostr) via bundles locaux intégrés (compatible API v0.26+ et v0.20-).
 * 2. Synchronisation locale immédiate (/api/signal sur localhost) pour relier fenêtres normales et incognito.
 * 3. BroadcastChannel instantané pour les onglets du même profil.
 */

import { joinRoom as joinTorrentRoom, selfId as torrentSelfId } from './trystero-torrent.js';
import { joinRoom as joinNostrRoom, selfId as nostrSelfId } from './trystero-nostr.js';

const DEFAULT_LOBBY = 'snap-p2p-global-lobby';
const APP_ID = 'snap-p2p-app';

export class P2PNetwork {
  constructor() {
    this.currentRoomId = DEFAULT_LOBBY;
    this.myProfile = null;
    this.room = null;
    this.broadcastChannel = null;
    this.selfId = null;
    this.strategyName = 'torrent';

    // Map des pairs connectés : peerId/uuid -> { peerId, uuid, nickname, avatar, lastSeen }
    this.peers = new Map();
    this.uuidToPeerId = new Map();

    // Callbacks pour les événements
    this.listeners = {
      peerJoin: [],
      peerLeave: [],
      peersUpdate: [],
      chatMessage: [],
      typing: [],
      snap: [],
      snapOpened: [],
      friendRequest: [],
      friendResponse: [],
      roomChanged: []
    };

    this.actions = {};
    this.pingInterval = null;
    this.localPollInterval = null;
    this.lastSignalTime = 0;
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => {
        try {
          cb(data);
        } catch (e) {
          console.error(`Erreur listener ${event}:`, e);
        }
      });
    }
  }

  async init(myProfile, targetRoom = DEFAULT_LOBBY) {
    this.myProfile = myProfile;
    await this.connect(targetRoom);
  }

  async connect(roomId = DEFAULT_LOBBY) {
    if (this.room) {
      this.disconnect();
    }

    this.currentRoomId = roomId.trim() || DEFAULT_LOBBY;
    this.peers.clear();
    this.uuidToPeerId.clear();
    this.emit('roomChanged', this.currentRoomId);
    this.emit('peersUpdate', []);

    console.log(`[P2P] Connexion au salon: "${this.currentRoomId}"...`);

    // 1. Initialiser le canal BroadcastChannel
    this.setupBroadcastChannel();

    // 2. Initialiser le bus local (relais instantané pour Normal <-> Incognito sur localhost)
    this.setupLocalSignalBus();

    // 3. Initialiser Trystero WebRTC (Torrent d'abord, Nostr en secours)
    await this.setupTrystero();

    // 4. Lancer les diffusions d'identité répétées au démarrage
    this.startHeartbeat();
    this.broadcastIdentity();
    setTimeout(() => this.broadcastIdentity(), 800);
    setTimeout(() => this.broadcastIdentity(), 2000);
  }

  /**
   * Adapteur universel pour makeAction (gère Trystero 0.26+ Object et 0.20- Array)
   */
  createAction(actionName) {
    if (!this.room || !this.room.makeAction) {
      return { send: () => {}, on: () => {} };
    }
    try {
      const act = this.room.makeAction(actionName);
      if (Array.isArray(act)) {
        return {
          send: (data, target) => act[0](data, target),
          on: (cb) => act[1]((data, peerId) => cb(data, peerId))
        };
      } else if (act && typeof act === 'object') {
        return {
          send: async (data, target) => {
            try {
              if (target) {
                await act.send(data, { target });
              } else {
                await act.send(data);
              }
            } catch (err) {
              console.warn(`[P2P] Erreur envoi action ${actionName}:`, err);
            }
          },
          on: (cb) => {
            act.onMessage = (data, meta) => {
              const peerId = typeof meta === 'string' ? meta : (meta?.peerId || '');
              cb(data, peerId);
            };
          }
        };
      }
    } catch (e) {
      console.error(`[P2P] Erreur création action ${actionName}:`, e);
    }
    return { send: () => {}, on: () => {} };
  }

  async setupTrystero() {
    try {
      console.log('[P2P] Démarrage de Trystero Torrent...');
      this.selfId = torrentSelfId;
      this.room = joinTorrentRoom({ appId: APP_ID }, this.currentRoomId);
      this.strategyName = 'torrent';
      console.log(`[P2P] Connecté via Torrent WebRTC. Mon ID: ${this.selfId}`);
    } catch (e1) {
      console.warn('[P2P] Torrent indisponible, essai Nostr...', e1);
      try {
        this.selfId = nostrSelfId;
        this.room = joinNostrRoom({ appId: APP_ID }, this.currentRoomId);
        this.strategyName = 'nostr';
        console.log(`[P2P] Connecté via Nostr WebRTC. Mon ID: ${this.selfId}`);
      } catch (e2) {
        console.error('[P2P] Erreur initialisation Trystero:', e2);
      }
    }

    if (!this.room) return;

    this.setupActions();

    const onJoinHandler = (peerId) => {
      console.log(`[P2P] Pair WebRTC connecté: ${peerId}`);
      this.sendIdentityTo(peerId);
      setTimeout(() => this.sendIdentityTo(peerId), 500);
    };

    if (typeof this.room.onPeerJoin === 'function') {
      this.room.onPeerJoin(onJoinHandler);
    } else {
      this.room.onPeerJoin = onJoinHandler;
    }

    const onLeaveHandler = (peerId) => {
      console.log(`[P2P] Pair WebRTC déconnecté: ${peerId}`);
      this.removePeer(peerId);
    };

    if (typeof this.room.onPeerLeave === 'function') {
      this.room.onPeerLeave(onLeaveHandler);
    } else {
      this.room.onPeerLeave = onLeaveHandler;
    }
  }

  setupActions() {
    if (!this.room) return;

    // Action: Identité (Handshake)
    const identityAction = this.createAction('identity');
    this.actions.sendIdentity = identityAction.send;
    identityAction.on((data, peerId) => {
      this.handleReceivedIdentity(data, peerId);
    });

    // Action: Chat en direct
    const chatAction = this.createAction('chat');
    this.actions.sendChat = chatAction.send;
    chatAction.on((data, peerId) => {
      this.emit('chatMessage', { ...data, fromPeerId: peerId });
    });

    // Action: Indicateur de frappe
    const typingAction = this.createAction('typing');
    this.actions.sendTyping = typingAction.send;
    typingAction.on((data, peerId) => {
      this.emit('typing', { ...data, fromPeerId: peerId });
    });

    // Action: Snap éphémère (Photo ou Vidéo avec timer)
    const snapAction = this.createAction('snap');
    this.actions.sendSnap = snapAction.send;
    snapAction.on((data, peerId) => {
      this.emit('snap', { ...data, fromPeerId: peerId });
    });

    // Action: Accusé de lecture / destruction de Snap
    const snapReceiptAction = this.createAction('snap_receipt');
    this.actions.sendSnapReceipt = snapReceiptAction.send;
    snapReceiptAction.on((data, peerId) => {
      this.emit('snapOpened', { ...data, fromPeerId: peerId });
    });

    // Action: Demande d'ami par pseudo ou direct
    const friendReqAction = this.createAction('friend_request');
    this.actions.sendFriendReq = friendReqAction.send;
    friendReqAction.on((data, peerId) => {
      this.handleReceivedFriendRequest(data, peerId);
    });

    // Action: Réponse à demande d'ami (Accepté / Refusé)
    const friendRespAction = this.createAction('friend_response');
    this.actions.sendFriendResp = friendRespAction.send;
    friendRespAction.on((data, peerId) => {
      this.handleReceivedFriendResponse(data, peerId);
    });

    // Action: Heartbeat ping
    const pingAction = this.createAction('ping');
    this.actions.sendPing = pingAction.send;
    pingAction.on((data, peerId) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastSeen = Date.now();
      }
    });
  }

  setupBroadcastChannel() {
    if (!window.BroadcastChannel) return;
    try {
      if (this.broadcastChannel) {
        this.broadcastChannel.close();
      }
      const channelName = `snap_p2p_channel_${this.currentRoomId}`;
      this.broadcastChannel = new BroadcastChannel(channelName);

      this.broadcastChannel.onmessage = (event) => {
        const { type, data, senderUuid } = event.data || {};
        if (senderUuid === this.myProfile?.uuid) return;

        const fakePeerId = `bc_${senderUuid}`;
        this.dispatchIncomingPacket(type, data, fakePeerId);
      };
    } catch (e) {
      console.warn('[P2P] BroadcastChannel indisponible:', e);
    }
  }

  setupLocalSignalBus() {
    if (this.localPollInterval) {
      clearInterval(this.localPollInterval);
      this.localPollInterval = null;
    }

    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalhost) return;

    this.lastSignalTime = Date.now() / 1000 - 1;

    this.localPollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/signal?since=${this.lastSignalTime}`);
        if (!res.ok) return;
        const json = await res.json();
        this.lastSignalTime = json.time || Date.now() / 1000;

        if (Array.isArray(json.messages)) {
          json.messages.forEach((msg) => {
            if (!msg || !msg.type || !msg.senderUuid || msg.roomId !== this.currentRoomId) return;
            if (msg.senderUuid === this.myProfile?.uuid) return;

            const fakePeerId = `local_${msg.senderUuid}`;
            this.dispatchIncomingPacket(msg.type, msg.data, fakePeerId);
          });
        }
      } catch (err) {}
    }, 600);
  }

  postLocalSignal(type, data) {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalhost || !this.myProfile) return;

    fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: this.currentRoomId,
        senderUuid: this.myProfile.uuid,
        type,
        data,
        timestamp: Date.now()
      })
    }).catch(() => {});
  }

  dispatchIncomingPacket(type, data, peerId) {
    switch (type) {
      case 'identity':
        this.handleReceivedIdentity(data, peerId);
        break;
      case 'chat':
        this.emit('chatMessage', { ...data, fromPeerId: peerId });
        break;
      case 'typing':
        this.emit('typing', { ...data, fromPeerId: peerId });
        break;
      case 'snap':
        this.emit('snap', { ...data, fromPeerId: peerId });
        break;
      case 'snap_receipt':
        this.emit('snapOpened', { ...data, fromPeerId: peerId });
        break;
      case 'friend_request':
        this.handleReceivedFriendRequest(data, peerId);
        break;
      case 'friend_response':
        this.handleReceivedFriendResponse(data, peerId);
        break;
      case 'leave':
        this.removePeer(peerId);
        break;
    }
  }

  handleReceivedIdentity(data, peerId) {
    if (!data || !data.uuid || data.uuid === this.myProfile?.uuid) return;

    const peerInfo = {
      peerId,
      uuid: data.uuid,
      nickname: data.nickname || 'Anonyme',
      avatar: data.avatar || '',
      isTemporary: !!data.isTemporary,
      lastSeen: Date.now()
    };

    const isNew = !this.peers.has(peerId) && !this.uuidToPeerId.has(data.uuid);
    this.peers.set(peerId, peerInfo);
    this.uuidToPeerId.set(data.uuid, peerId);

    console.log(`[P2P] Identité reçue de "${peerInfo.nickname}" (${data.uuid.slice(0, 8)})`);

    if (isNew) {
      this.emit('peerJoin', peerInfo);
      this.sendIdentityTo(peerId);
    }

    this.emit('peersUpdate', this.getOnlinePeers());
  }

  handleReceivedFriendRequest(data, peerId) {
    if (!data || !this.myProfile) return;
    const matchUuid = data.targetUuid && data.targetUuid === this.myProfile.uuid;
    const matchPseudo = data.targetPseudo && data.targetPseudo.trim().toLowerCase() === this.myProfile.nickname.trim().toLowerCase();

    if (matchUuid || matchPseudo) {
      console.log(`[P2P] Demande d'ami reçue de: ${data.fromNickname}`);
      this.emit('friendRequest', { ...data, fromPeerId: peerId });
    }
  }

  handleReceivedFriendResponse(data, peerId) {
    if (!data || !this.myProfile) return;
    if (data.targetUuid === this.myProfile.uuid) {
      console.log(`[P2P] Réponse d'ami de ${data.fromNickname}: ${data.accepted ? 'Acceptée' : 'Refusée'}`);
      this.emit('friendResponse', { ...data, fromPeerId: peerId });
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      this.peers.delete(peerId);
      this.uuidToPeerId.delete(peer.uuid);
      this.emit('peerLeave', peer);
      this.emit('peersUpdate', this.getOnlinePeers());
    }
  }

  broadcastIdentity() {
    if (!this.myProfile) return;
    const packet = {
      uuid: this.myProfile.uuid,
      nickname: this.myProfile.nickname,
      avatar: this.myProfile.avatar,
      isTemporary: this.myProfile.isTemporary,
      timestamp: Date.now()
    };

    if (this.actions.sendIdentity) {
      this.actions.sendIdentity(packet);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'identity',
        data: packet,
        senderUuid: this.myProfile.uuid
      });
    }

    this.postLocalSignal('identity', packet);
  }

  sendIdentityTo(peerId) {
    if (!this.myProfile) return;
    const packet = {
      uuid: this.myProfile.uuid,
      nickname: this.myProfile.nickname,
      avatar: this.myProfile.avatar,
      isTemporary: this.myProfile.isTemporary,
      timestamp: Date.now()
    };

    if (this.actions.sendIdentity && peerId && !peerId.startsWith('bc_') && !peerId.startsWith('local_')) {
      this.actions.sendIdentity(packet, peerId);
    }
  }

  sendFriendRequest(targetPseudo, targetUuid = null) {
    if (!this.myProfile) return null;

    const requestPacket = {
      requestId: 'freq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      fromUuid: this.myProfile.uuid,
      fromNickname: this.myProfile.nickname,
      fromAvatar: this.myProfile.avatar,
      targetPseudo: targetPseudo ? targetPseudo.trim() : null,
      targetUuid: targetUuid || null,
      timestamp: Date.now()
    };

    if (this.actions.sendFriendReq) {
      const targetPeerId = targetUuid ? this.uuidToPeerId.get(targetUuid) : null;
      if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_')) {
        this.actions.sendFriendReq(requestPacket, targetPeerId);
      } else {
        this.actions.sendFriendReq(requestPacket);
      }
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'friend_request',
        data: requestPacket,
        senderUuid: this.myProfile.uuid
      });
    }

    this.postLocalSignal('friend_request', requestPacket);

    return requestPacket;
  }

  sendFriendResponse(requestId, targetUuid, accepted = true) {
    if (!this.myProfile) return null;

    const responsePacket = {
      requestId,
      fromUuid: this.myProfile.uuid,
      fromNickname: this.myProfile.nickname,
      fromAvatar: this.myProfile.avatar,
      targetUuid,
      accepted: !!accepted,
      timestamp: Date.now()
    };

    if (this.actions.sendFriendResp) {
      const targetPeerId = this.uuidToPeerId.get(targetUuid);
      if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_')) {
        this.actions.sendFriendResp(responsePacket, targetPeerId);
      } else {
        this.actions.sendFriendResp(responsePacket);
      }
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'friend_response',
        data: responsePacket,
        senderUuid: this.myProfile.uuid
      });
    }

    this.postLocalSignal('friend_response', responsePacket);

    return responsePacket;
  }

  sendMessage(targetUuid, text, ephemeral = true) {
    const messagePayload = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      senderUuid: this.myProfile.uuid,
      targetUuid,
      text,
      timestamp: Date.now(),
      ephemeral: !!ephemeral
    };

    const targetPeerId = this.uuidToPeerId.get(targetUuid);

    if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_') && this.actions.sendChat) {
      this.actions.sendChat(messagePayload, targetPeerId);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'chat',
        data: messagePayload,
        senderUuid: this.myProfile.uuid
      });
    }

    this.postLocalSignal('chat', messagePayload);

    return messagePayload;
  }

  sendTyping(targetUuid, isTyping) {
    const packet = {
      senderUuid: this.myProfile.uuid,
      targetUuid,
      isTyping
    };

    const targetPeerId = this.uuidToPeerId.get(targetUuid);
    if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_') && this.actions.sendTyping) {
      this.actions.sendTyping(packet, targetPeerId);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'typing',
        data: packet,
        senderUuid: this.myProfile.uuid
      });
    }

    this.postLocalSignal('typing', packet);
  }

  sendSnap(targetUuids, snapData) {
    const snapPayload = {
      id: 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      senderUuid: this.myProfile.uuid,
      senderNickname: this.myProfile.nickname,
      senderAvatar: this.myProfile.avatar,
      targetUuids: Array.isArray(targetUuids) ? targetUuids : [targetUuids],
      mediaType: snapData.mediaType || 'photo',
      mediaData: snapData.mediaData,
      timer: snapData.timer !== undefined ? snapData.timer : 5,
      bannerText: snapData.bannerText || '',
      bannerY: snapData.bannerY || 50,
      timestamp: Date.now()
    };

    snapPayload.targetUuids.forEach((targetUuid) => {
      const targetPeerId = this.uuidToPeerId.get(targetUuid);
      if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_') && this.actions.sendSnap) {
        this.actions.sendSnap(snapPayload, targetPeerId);
      }
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'snap',
        data: snapPayload,
        senderUuid: this.myProfile.uuid
      });
    }

    this.postLocalSignal('snap', snapPayload);

    return snapPayload;
  }

  sendSnapReceipt(snapId, senderUuid) {
    const receipt = {
      snapId,
      openerUuid: this.myProfile.uuid,
      senderUuid,
      openedAt: Date.now()
    };

    const targetPeerId = this.uuidToPeerId.get(senderUuid);
    if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_') && this.actions.sendSnapReceipt) {
      this.actions.sendSnapReceipt(receipt, targetPeerId);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'snap_receipt',
        data: receipt,
        senderUuid: this.myProfile.uuid
      });
    }

    this.postLocalSignal('snap_receipt', receipt);
  }

  getOnlinePeers() {
    return Array.from(this.peers.values());
  }

  isUserOnline(uuid) {
    return this.uuidToPeerId.has(uuid);
  }

  findPeerByPseudo(pseudo) {
    if (!pseudo) return null;
    const target = pseudo.trim().toLowerCase();
    for (const peer of this.peers.values()) {
      if (peer.nickname.trim().toLowerCase() === target) {
        return peer;
      }
    }
    return null;
  }

  startHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      this.broadcastIdentity();

      if (this.actions.sendPing) {
        this.actions.sendPing({ ping: Date.now() });
      }

      const now = Date.now();
      this.peers.forEach((peer, peerId) => {
        if (now - peer.lastSeen > 35000) {
          this.removePeer(peerId);
        }
      });
    }, 4000);
  }

  disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.localPollInterval) {
      clearInterval(this.localPollInterval);
      this.localPollInterval = null;
    }

    if (this.broadcastChannel && this.myProfile) {
      try {
        this.broadcastChannel.postMessage({
          type: 'leave',
          senderUuid: this.myProfile.uuid
        });
        this.broadcastChannel.close();
      } catch (e) {}
    }

    if (this.room) {
      try {
        this.room.leave();
      } catch (e) {}
      this.room = null;
    }

    this.peers.clear();
    this.uuidToPeerId.clear();
  }
}

export const p2p = new P2PNetwork();
