/**
 * p2p.js - Couche réseau P2P 100% sans serveur backend.
 * Utilise Trystero (Stratégie Nostr avec repli Torrent)
 * + Synchronisation BroadcastChannel instantanée pour les onglets locaux.
 * Gère l'échange d'identité, les demandes d'amis par pseudo, le chat et les snaps éphémères.
 */

const DEFAULT_LOBBY = 'snap-p2p-global-lobby';
const APP_ID = 'snap-p2p-v2';

const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr.mom'
];

export class P2PNetwork {
  constructor() {
    this.currentRoomId = DEFAULT_LOBBY;
    this.myProfile = null;
    this.room = null;
    this.broadcastChannel = null;
    this.strategyName = 'nostr';
    
    // Map des pairs connectés : peerId -> { peerId, uuid, nickname, avatar, lastSeen, isLocalTab }
    this.peers = new Map();
    // Indexation inverse : uuid -> peerId
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

    console.log(`[P2P] Connexion à la room: "${this.currentRoomId}"...`);

    this.setupBroadcastChannel();
    await this.setupTrystero();
    this.startHeartbeat();
    this.broadcastIdentity();
  }

  async setupTrystero() {
    try {
      let trysteroModule = null;
      try {
        console.log('[P2P] Chargement Trystero Nostr...');
        trysteroModule = await import('https://esm.sh/trystero@0.26.0/nostr');
        this.strategyName = 'nostr';
      } catch (e1) {
        console.warn('[P2P] Nostr indisponible, essai Torrent...', e1);
        trysteroModule = await import('https://esm.sh/trystero@0.26.0/torrent');
        this.strategyName = 'torrent';
      }

      const { joinRoom, selfId } = trysteroModule;
      this.selfId = selfId;

      const config = {
        appId: APP_ID,
        relayUrls: NOSTR_RELAYS
      };

      this.room = joinRoom(config, this.currentRoomId);
      console.log(`[P2P] Room rejointe via ${this.strategyName}. ID: ${this.selfId}`);

      this.setupActions();

      this.room.onPeerJoin((peerId) => {
        console.log(`[P2P] Pair connecté: ${peerId}`);
        this.sendIdentityTo(peerId);
      });

      this.room.onPeerLeave((peerId) => {
        console.log(`[P2P] Pair déconnecté: ${peerId}`);
        this.removePeer(peerId);
      });
    } catch (err) {
      console.error('[P2P] Erreur critique Trystero:', err);
    }
  }

  setupActions() {
    if (!this.room) return;

    // Action: Identité (Handshake)
    const [sendIdentity, getIdentity] = this.room.makeAction('identity');
    this.actions.sendIdentity = sendIdentity;
    getIdentity((data, peerId) => {
      this.handleReceivedIdentity(data, peerId, false);
    });

    // Action: Chat en direct
    const [sendChat, getChat] = this.room.makeAction('chat');
    this.actions.sendChat = sendChat;
    getChat((data, peerId) => {
      this.emit('chatMessage', { ...data, fromPeerId: peerId });
    });

    // Action: Indicateur de frappe
    const [sendTyping, getTyping] = this.room.makeAction('typing');
    this.actions.sendTyping = sendTyping;
    getTyping((data, peerId) => {
      this.emit('typing', { ...data, fromPeerId: peerId });
    });

    // Action: Snap éphémère (Photo ou Vidéo avec timer)
    const [sendSnap, getSnap] = this.room.makeAction('snap');
    this.actions.sendSnap = sendSnap;
    getSnap((data, peerId) => {
      this.emit('snap', { ...data, fromPeerId: peerId });
    });

    // Action: Accusé de lecture / destruction de Snap
    const [sendSnapReceipt, getSnapReceipt] = this.room.makeAction('snap_receipt');
    this.actions.sendSnapReceipt = sendSnapReceipt;
    getSnapReceipt((data, peerId) => {
      this.emit('snapOpened', { ...data, fromPeerId: peerId });
    });

    // Action: Demande d'ami par pseudo ou direct
    const [sendFriendReq, getFriendReq] = this.room.makeAction('friend_request');
    this.actions.sendFriendReq = sendFriendReq;
    getFriendReq((data, peerId) => {
      this.handleReceivedFriendRequest(data, peerId);
    });

    // Action: Réponse à demande d'ami (Accepté / Refusé)
    const [sendFriendResp, getFriendResp] = this.room.makeAction('friend_response');
    this.actions.sendFriendResp = sendFriendResp;
    getFriendResp((data, peerId) => {
      this.handleReceivedFriendResponse(data, peerId);
    });

    // Action: Heartbeat ping
    const [sendPing, getPing] = this.room.makeAction('ping');
    this.actions.sendPing = sendPing;
    getPing((data, peerId) => {
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
      const channelName = `snap_p2p_${this.currentRoomId}`;
      this.broadcastChannel = new BroadcastChannel(channelName);

      this.broadcastChannel.onmessage = (event) => {
        const { type, data, senderUuid } = event.data || {};
        if (senderUuid === this.myProfile?.uuid) return;

        const fakePeerId = `local_${senderUuid}`;

        switch (type) {
          case 'identity':
            this.handleReceivedIdentity(data, fakePeerId, true);
            break;
          case 'chat':
            this.emit('chatMessage', { ...data, fromPeerId: fakePeerId });
            break;
          case 'typing':
            this.emit('typing', { ...data, fromPeerId: fakePeerId });
            break;
          case 'snap':
            this.emit('snap', { ...data, fromPeerId: fakePeerId });
            break;
          case 'snap_receipt':
            this.emit('snapOpened', { ...data, fromPeerId: fakePeerId });
            break;
          case 'friend_request':
            this.handleReceivedFriendRequest(data, fakePeerId);
            break;
          case 'friend_response':
            this.handleReceivedFriendResponse(data, fakePeerId);
            break;
          case 'leave':
            this.removePeer(fakePeerId);
            break;
        }
      };
    } catch (e) {
      console.warn('[P2P] BroadcastChannel non disponible:', e);
    }
  }

  handleReceivedIdentity(data, peerId, isLocalTab = false) {
    if (!data || !data.uuid || data.uuid === this.myProfile?.uuid) return;

    const peerInfo = {
      peerId,
      uuid: data.uuid,
      nickname: data.nickname || 'Anonyme',
      avatar: data.avatar || '',
      isTemporary: !!data.isTemporary,
      lastSeen: Date.now(),
      isLocalTab
    };

    const isNew = !this.peers.has(peerId);
    this.peers.set(peerId, peerInfo);
    this.uuidToPeerId.set(data.uuid, peerId);

    if (isNew) {
      this.emit('peerJoin', peerInfo);
      if (!isLocalTab && this.actions.sendIdentity) {
        this.sendIdentityTo(peerId);
      }
    }

    this.emit('peersUpdate', this.getOnlinePeers());
  }

  handleReceivedFriendRequest(data, peerId) {
    if (!data || !this.myProfile) return;
    // Si la demande est ciblée par UUID ou par Pseudo (insensible à la casse)
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
      console.log(`[P2P] Réponse demande d'ami reçue de ${data.fromNickname}: ${data.accepted ? 'Acceptée' : 'Refusée'}`);
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
  }

  sendIdentityTo(peerId) {
    if (!this.myProfile || !this.actions.sendIdentity) return;
    const packet = {
      uuid: this.myProfile.uuid,
      nickname: this.myProfile.nickname,
      avatar: this.myProfile.avatar,
      isTemporary: this.myProfile.isTemporary,
      timestamp: Date.now()
    };
    this.actions.sendIdentity(packet, peerId);
  }

  /**
   * Envoie une demande d'ami par pseudo ou par UUID
   */
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

    // Si on a un targetUuid connu et en ligne, cibler directement
    const targetPeerId = targetUuid ? this.uuidToPeerId.get(targetUuid) : null;

    if (targetPeerId && !targetPeerId.startsWith('local_') && this.actions.sendFriendReq) {
      this.actions.sendFriendReq(requestPacket, targetPeerId);
    } else if (this.actions.sendFriendReq) {
      // Sinon diffusion générale (match par pseudo)
      this.actions.sendFriendReq(requestPacket);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'friend_request',
        data: requestPacket,
        senderUuid: this.myProfile.uuid
      });
    }

    return requestPacket;
  }

  /**
   * Répond à une demande d'ami (Accepter ou Refuser)
   */
  sendFriendResponse(requestId, targetUuid, accepted = true) {
    if (!this.myProfile) return;

    const responsePacket = {
      requestId,
      fromUuid: this.myProfile.uuid,
      fromNickname: this.myProfile.nickname,
      fromAvatar: this.myProfile.avatar,
      targetUuid,
      accepted: !!accepted,
      timestamp: Date.now()
    };

    const targetPeerId = this.uuidToPeerId.get(targetUuid);

    if (targetPeerId && !targetPeerId.startsWith('local_') && this.actions.sendFriendResp) {
      this.actions.sendFriendResp(responsePacket, targetPeerId);
    } else if (this.actions.sendFriendResp) {
      this.actions.sendFriendResp(responsePacket);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'friend_response',
        data: responsePacket,
        senderUuid: this.myProfile.uuid
      });
    }

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

    if (targetPeerId && !targetPeerId.startsWith('local_') && this.actions.sendChat) {
      this.actions.sendChat(messagePayload, targetPeerId);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'chat',
        data: messagePayload,
        senderUuid: this.myProfile.uuid
      });
    }

    return messagePayload;
  }

  sendTyping(targetUuid, isTyping) {
    const packet = {
      senderUuid: this.myProfile.uuid,
      targetUuid,
      isTyping
    };

    const targetPeerId = this.uuidToPeerId.get(targetUuid);
    if (targetPeerId && !targetPeerId.startsWith('local_') && this.actions.sendTyping) {
      this.actions.sendTyping(packet, targetPeerId);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'typing',
        data: packet,
        senderUuid: this.myProfile.uuid
      });
    }
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
      if (targetPeerId && !targetPeerId.startsWith('local_') && this.actions.sendSnap) {
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
    if (targetPeerId && !targetPeerId.startsWith('local_') && this.actions.sendSnapReceipt) {
      this.actions.sendSnapReceipt(receipt, targetPeerId);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'snap_receipt',
        data: receipt,
        senderUuid: this.myProfile.uuid
      });
    }
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
      if (this.actions.sendPing) {
        this.actions.sendPing({ ping: Date.now() });
      }

      const now = Date.now();
      this.peers.forEach((peer, peerId) => {
        if (now - peer.lastSeen > 35000) {
          this.removePeer(peerId);
        }
      });
    }, 12000);
  }

  disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
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
