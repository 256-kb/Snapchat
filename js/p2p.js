/**
 * p2p.js - Couche réseau P2P hybride signée cryptographiquement (ECDSA P-256) :
 * 1. WebRTC Trystero (Torrent + Nostr) via bundles locaux intégrés.
 * 2. Bus local (/api/signal sur localhost) pour relier fenêtres normales et privées.
 * 3. BroadcastChannel instantané pour les onglets du même navigateur.
 * 4. Chaque paquet envoyé est signé (ECDSA P-256) et toute signature invalide est rejetée silencieusement.
 * 5. Synchronisation automatique de l'annuaire collectif (Gossip) et accusés Remis / Vu.
 */

import { joinRoom as joinTorrentRoom, selfId as torrentSelfId } from './trystero-torrent.js';
import { joinRoom as joinNostrRoom, selfId as nostrSelfId } from './trystero-nostr.js';
import {
  formatTag,
  importPrivateKey,
  signPacketEnvelope,
  verifyPacketEnvelope
} from './crypto.js';
import { storage } from './storage.js';

const DEFAULT_LOBBY = 'snap-p2p-global-lobby';
const APP_ID = 'snap-p2p-app';

export class P2PNetwork {
  constructor() {
    this.currentRoomId = DEFAULT_LOBBY;
    this.myProfile = null;
    this.privateKey = null;
    this.signedLeaveEnvelope = null;
    this.room = null;
    this.broadcastChannel = null;
    this.selfId = null;
    this.strategyName = 'torrent';

    // Map des pairs connectés : peerId -> { peerId, uuid, publicKeyHash, tag, publicKey, nickname, avatar, firstSeen, lastSeen }
    this.peers = new Map();
    this.uuidToPeerId = new Map();

    // Throttle Gossip par pair pour éviter les boucles de synchro
    this.lastGossipSentToPeer = new Map();
    this.lastGlobalGossipAt = 0;

    // Callbacks événements applicatifs
    this.listeners = {
      peerJoin: [],
      peerLeave: [],
      peersUpdate: [],
      chatMessage: [],
      typing: [],
      snap: [],
      snapOpened: [],
      messageReceipt: [],
      messageReaction: [],
      messageDelete: [],
      chatClear: [],
      friendRequest: [],
      friendResponse: [],
      directoryUpdate: [],
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
    this.privateKey =
      storage.activePrivateKey || (await importPrivateKey(myProfile.privateKeyJwk));
    await this.connect(targetRoom);
  }

  async refreshKeys(myProfile) {
    this.myProfile = myProfile;
    this.privateKey =
      storage.activePrivateKey || (await importPrivateKey(myProfile.privateKeyJwk));
    this.signedLeaveEnvelope = await this.signPayload('leave', {
      uuid: this.getMyHash(),
      senderUuid: this.getMyHash()
    });
  }

  getMyHash() {
    return (this.myProfile?.publicKeyHash || this.myProfile?.uuid || '').toLowerCase();
  }

  async connect(roomId = DEFAULT_LOBBY) {
    if (this.room || this.broadcastChannel || this.localPollInterval) {
      this.disconnect();
    }

    this.currentRoomId = roomId.trim() || DEFAULT_LOBBY;
    this.peers.clear();
    this.uuidToPeerId.clear();
    this.lastGossipSentToPeer.clear();
    this.emit('roomChanged', this.currentRoomId);
    this.emit('peersUpdate', []);

    if (this.myProfile && this.privateKey) {
      this.signedLeaveEnvelope = await this.signPayload('leave', {
        uuid: this.getMyHash(),
        senderUuid: this.getMyHash()
      });
    }

    console.log(`[P2P] Connexion sécurisée ECDSA P-256 au salon: "${this.currentRoomId}"...`);

    this.setupBroadcastChannel();
    this.setupLocalSignalBus();
    await this.setupTrystero();

    this.startHeartbeat();
    await this.broadcastIdentity();
    setTimeout(() => this.broadcastIdentity(), 900);
    setTimeout(() => {
      this.broadcastIdentity();
      this.broadcastGossipSync();
    }, 2200);
  }

  async signPayload(type, payloadObj) {
    if (!this.myProfile || !this.privateKey) return null;
    const myHash = this.getMyHash();
    return signPacketEnvelope(
      this.privateKey,
      this.myProfile.publicKeyJwk,
      myHash,
      type,
      payloadObj
    );
  }

  /**
   * Adapteur universel pour makeAction (Trystero 0.26+ Object / 0.20- Array)
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
              const peerId = typeof meta === 'string' ? meta : meta?.peerId || '';
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
      this.sendIdentityTo(peerId);
      setTimeout(() => this.sendIdentityTo(peerId), 600);
    };

    if (typeof this.room.onPeerJoin === 'function') {
      this.room.onPeerJoin(onJoinHandler);
    } else {
      this.room.onPeerJoin = onJoinHandler;
    }

    const onLeaveHandler = (peerId) => {
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

    const register = (actionName, actionKey, expectedType) => {
      const act = this.createAction(actionName);
      this.actions[actionKey] = act.send;
      act.on((envelope, peerId) => {
        this.handleIncomingEnvelope(expectedType, envelope, peerId);
      });
    };

    register('identity', 'sendIdentity', 'identity');
    register('chat', 'sendChat', 'chat');
    register('typing', 'sendTyping', 'typing');
    register('snap', 'sendSnap', 'snap');
    register('snap_receipt', 'sendSnapReceipt', 'snap_receipt');
    register('msg_receipt', 'sendMsgReceipt', 'msg_receipt');
    register('reaction', 'sendReaction', 'reaction');
    register('delete_msg', 'sendDeleteMsg', 'delete_msg');
    register('clear_chat', 'sendClearChat', 'clear_chat');
    register('friend_request', 'sendFriendReq', 'friend_request');
    register('friend_response', 'sendFriendResp', 'friend_response');
    register('gossip_sync', 'sendGossipSync', 'gossip_sync');
    register('ping', 'sendPing', 'ping');
  }

  /**
   * Canal BroadcastChannel (onglets même origine)
   */
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
        const myHash = this.getMyHash();
        if (senderUuid && myHash && senderUuid.toLowerCase() === myHash) return;

        const fakePeerId = `bc_${(senderUuid || data?.senderHash || 'peer').slice(0, 12)}`;
        this.handleIncomingEnvelope(type, data, fakePeerId);
      };
    } catch (e) {
      console.warn('BroadcastChannel indisponible:', e);
    }
  }

  /**
   * Bus signalisation local (relais localhost pour fenêtres privées / normales)
   */
  setupLocalSignalBus() {
    const isLocalhost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalhost) return;

    this.lastSignalTime = Date.now() / 1000 - 2;
    if (this.localPollInterval) clearInterval(this.localPollInterval);

    this.localPollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/signal?since=${this.lastSignalTime}`);
        if (!res.ok) return;
        const json = await res.json();
        if (json.time) {
          this.lastSignalTime = json.time;
        }
        const myHash = this.getMyHash();
        if (Array.isArray(json.messages)) {
          json.messages.forEach((msg) => {
            if (!msg || msg.roomId !== this.currentRoomId) return;
            if (msg.senderUuid && myHash && msg.senderUuid.toLowerCase() === myHash) return;
            const fakePeerId = `local_${(msg.senderUuid || 'peer').slice(0, 12)}`;
            this.handleIncomingEnvelope(msg.type, msg.data, fakePeerId);
          });
        }
      } catch (err) {}
    }, 600);
  }

  postLocalSignal(type, envelope) {
    const isLocalhost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalhost || !this.myProfile || !envelope) return;

    fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: this.currentRoomId,
        senderUuid: this.getMyHash(),
        type,
        data: envelope,
        timestamp: Date.now()
      })
    }).catch(() => {});
  }

  /**
   * Validation cryptographique STRICTE de chaque paquet reçu.
   * Tout paquet sans signature valide (ou forgé / altéré / usurpé) est rejeté silencieusement.
   */
  async handleIncomingEnvelope(expectedType, envelope, peerId) {
    const verified = await verifyPacketEnvelope(envelope, expectedType || null);
    if (!verified) {
      // Rejet silencieux strict des signatures invalides ou absentes
      return;
    }

    const myHash = this.getMyHash();
    if (!myHash || verified.senderHash === myHash) {
      return;
    }

    const { type, payload, senderHash, tag, publicKey } = verified;

    // Rafraîchir lastSeen du pair vérifié si connu
    const knownPeerId = this.uuidToPeerId.get(senderHash) || peerId;
    const peerObj = this.peers.get(knownPeerId);
    if (peerObj) {
      peerObj.lastSeen = Date.now();
    }

    // Filtrage strict par destinataire sur les actions privées 1-to-1
    const dmTargetedTypes = [
      'chat',
      'typing',
      'reaction',
      'delete_msg',
      'clear_chat',
      'msg_receipt',
      'snap_receipt'
    ];
    if (dmTargetedTypes.includes(type)) {
      if (payload.targetUuid && String(payload.targetUuid).toLowerCase() !== myHash) {
        return;
      }
    }

    if (type === 'snap') {
      if (
        !Array.isArray(payload.targetUuids) ||
        !payload.targetUuids.some((id) => String(id).toLowerCase() === myHash)
      ) {
        return;
      }
    }

    switch (type) {
      case 'identity':
        await this.handleReceivedIdentity(payload, peerId, verified);
        break;
      case 'chat':
        this.emit('chatMessage', {
          ...payload,
          senderUuid: senderHash,
          senderTag: tag,
          fromPeerId: knownPeerId
        });
        break;
      case 'typing':
        this.emit('typing', {
          ...payload,
          senderUuid: senderHash,
          fromPeerId: knownPeerId
        });
        break;
      case 'snap':
        this.emit('snap', {
          ...payload,
          senderUuid: senderHash,
          senderTag: tag,
          fromPeerId: knownPeerId
        });
        break;
      case 'snap_receipt':
        this.emit('snapOpened', {
          ...payload,
          openerUuid: senderHash,
          fromPeerId: knownPeerId
        });
        break;
      case 'msg_receipt':
        this.emit('messageReceipt', {
          ...payload,
          senderUuid: senderHash,
          fromPeerId: knownPeerId
        });
        break;
      case 'reaction':
        this.emit('messageReaction', {
          ...payload,
          senderUuid: senderHash,
          fromPeerId: knownPeerId
        });
        break;
      case 'delete_msg':
        this.emit('messageDelete', {
          ...payload,
          senderUuid: senderHash,
          fromPeerId: knownPeerId
        });
        break;
      case 'clear_chat':
        this.emit('chatClear', {
          ...payload,
          senderUuid: senderHash,
          fromPeerId: knownPeerId
        });
        break;
      case 'friend_request':
        this.handleReceivedFriendRequest(payload, knownPeerId, verified);
        break;
      case 'friend_response':
        this.handleReceivedFriendResponse(payload, knownPeerId, verified);
        break;
      case 'gossip_sync':
        await this.handleReceivedGossipSync(payload, senderHash, knownPeerId);
        break;
      case 'ping':
        // Déjà rafraîchi lastSeen ci-dessus après vérification de signature
        break;
      case 'leave':
        this.removePeer(peerId);
        this.removePeerByUuid(senderHash);
        break;
    }
  }

  async handleReceivedIdentity(data, peerId, verifiedMeta) {
    const senderHash = verifiedMeta.senderHash;
    if (!data || senderHash === this.getMyHash()) return;

    // Enregistrer dans l'annuaire collectif Gossip si la signature d'identité est valide
    const candidateRecord = data.directoryRecord || {
      pseudo: data.nickname || 'Anonyme',
      publicKey: verifiedMeta.publicKey,
      publicKeyHash: senderHash,
      avatar: data.avatar || '',
      firstSeen: data.firstSeen || data.timestamp || Date.now(),
      signature: data.profileSignature || ''
    };

    const dirRes = await storage.upsertDirectoryEntry(candidateRecord);

    const peerInfo = {
      peerId,
      uuid: senderHash,
      publicKeyHash: senderHash,
      tag: verifiedMeta.tag,
      publicKey: verifiedMeta.publicKey,
      nickname: data.nickname || 'Anonyme',
      avatar: data.avatar || '',
      firstSeen: candidateRecord.firstSeen || Date.now(),
      verified: dirRes.accepted || dirRes.reason === 'duplicate_pseudo_older_exists',
      isTemporary: !!data.isTemporary,
      lastSeen: Date.now()
    };

    const existingPeerId = this.uuidToPeerId.get(senderHash);
    const isNew = !this.peers.has(peerId) && !existingPeerId;

    // Nettoyer l'ancien peerId si le pair est joignable sous un transport plus récent (WebRTC > bc > local)
    if (existingPeerId && existingPeerId !== peerId) {
      const prev = this.peers.get(existingPeerId);
      if (prev && (!existingPeerId.startsWith('bc_') && !existingPeerId.startsWith('local_'))) {
        // Garder le peerId WebRTC direct en priorité pour uuidToPeerId
        this.peers.set(existingPeerId, { ...peerInfo, peerId: existingPeerId });
      } else {
        this.peers.delete(existingPeerId);
        this.peers.set(peerId, peerInfo);
        this.uuidToPeerId.set(senderHash, peerId);
      }
    } else {
      this.peers.set(peerId, peerInfo);
      this.uuidToPeerId.set(senderHash, peerId);
    }

    if (dirRes.changed) {
      this.emit('directoryUpdate', storage.getDirectoryEntries());
    }

    if (isNew) {
      this.emit('peerJoin', peerInfo);
      await this.sendIdentityTo(peerId);
      await this.sendGossipSyncTo(senderHash, peerId);
    } else {
      // Synchro Gossip périodique avec pairs existants
      const lastSync = this.lastGossipSentToPeer.get(senderHash) || 0;
      if (Date.now() - lastSync > 20000) {
        await this.sendGossipSyncTo(senderHash, peerId);
      }
    }

    this.emit('peersUpdate', this.getOnlinePeers());
  }

  async handleReceivedGossipSync(data, senderHash) {
    if (!data || !Array.isArray(data.entries)) return;
    const entries = data.entries.slice(0, 60);
    const { added } = await storage.syncDirectoryBatch(entries);
    if (added > 0) {
      this.emit('directoryUpdate', storage.getDirectoryEntries());
      this.emit('peersUpdate', this.getOnlinePeers());
    }
  }

  handleReceivedFriendRequest(data, peerId, verifiedMeta) {
    if (!data || !this.myProfile) return;
    const myHash = this.getMyHash();
    const myTag = (this.myProfile.tag || formatTag(myHash)).toUpperCase();
    const myNick = this.myProfile.nickname.trim().toLowerCase();

    const targetUuidMatch = data.targetUuid && String(data.targetUuid).toLowerCase() === myHash;
    const targetPseudoClean = (data.targetPseudo || '').trim();
    const hashSep = targetPseudoClean.lastIndexOf('#');
    let pseudoMatch = false;

    if (hashSep > 0) {
      const qNick = targetPseudoClean.slice(0, hashSep).trim().toLowerCase();
      const qTag = ('#' + targetPseudoClean.slice(hashSep + 1).trim()).toUpperCase();
      pseudoMatch = qNick === myNick && qTag === myTag;
    } else if (targetPseudoClean) {
      pseudoMatch = targetPseudoClean.toLowerCase() === myNick;
    }

    if (targetUuidMatch || pseudoMatch) {
      this.emit('friendRequest', {
        ...data,
        fromUuid: verifiedMeta.senderHash,
        fromTag: verifiedMeta.tag,
        fromPublicKey: verifiedMeta.publicKey,
        fromPeerId: peerId
      });
    }
  }

  handleReceivedFriendResponse(data, peerId, verifiedMeta) {
    if (!data || !this.myProfile) return;
    if (String(data.targetUuid || '').toLowerCase() === this.getMyHash()) {
      this.emit('friendResponse', {
        ...data,
        fromUuid: verifiedMeta.senderHash,
        fromTag: verifiedMeta.tag,
        fromPublicKey: verifiedMeta.publicKey,
        fromPeerId: peerId
      });
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      this.peers.delete(peerId);
      if (this.uuidToPeerId.get(peer.uuid) === peerId) {
        this.uuidToPeerId.delete(peer.uuid);
      }
      this.emit('peerLeave', peer);
      this.emit('peersUpdate', this.getOnlinePeers());
    }
  }

  removePeerByUuid(uuid) {
    const targetHash = String(uuid || '').toLowerCase();
    const peerId = this.uuidToPeerId.get(targetHash);
    if (peerId) {
      this.removePeer(peerId);
    }
  }

  buildIdentityPayload() {
    const myHash = this.getMyHash();
    const selfRecord = storage.getSelfDirectoryRecord(this.myProfile);
    return {
      uuid: myHash,
      publicKeyHash: myHash,
      tag: this.myProfile.tag || formatTag(myHash),
      nickname: this.myProfile.nickname,
      avatar: this.myProfile.avatar,
      firstSeen: this.myProfile.firstSeen || this.myProfile.createdAt,
      profileSignature: this.myProfile.profileSignature,
      directoryRecord: selfRecord,
      isTemporary: !!this.myProfile.isTemporary,
      timestamp: Date.now()
    };
  }

  async broadcastIdentity() {
    if (!this.myProfile || !this.privateKey) return;
    const envelope = await this.signPayload('identity', this.buildIdentityPayload());
    if (!envelope) return;

    if (this.actions.sendIdentity) {
      this.actions.sendIdentity(envelope);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'identity',
        data: envelope,
        senderUuid: this.getMyHash()
      });
    }

    this.postLocalSignal('identity', envelope);
  }

  async sendIdentityTo(peerId) {
    if (!this.myProfile || !this.privateKey) return;
    const envelope = await this.signPayload('identity', this.buildIdentityPayload());
    if (!envelope) return;

    if (
      this.actions.sendIdentity &&
      peerId &&
      !peerId.startsWith('bc_') &&
      !peerId.startsWith('local_')
    ) {
      this.actions.sendIdentity(envelope, peerId);
    } else if (peerId && peerId.startsWith('bc_') && this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'identity',
        data: envelope,
        senderUuid: this.getMyHash()
      });
    } else if (peerId && peerId.startsWith('local_')) {
      this.postLocalSignal('identity', envelope);
    }
  }

  async sendGossipSyncTo(targetUuid = null, targetPeerId = null) {
    if (!this.myProfile || !this.privateKey) return;

    const myHash = this.getMyHash();
    if (targetUuid) {
      this.lastGossipSentToPeer.set(targetUuid, Date.now());
    } else {
      this.lastGlobalGossipAt = Date.now();
    }

    const selfRec = storage.getSelfDirectoryRecord(this.myProfile);
    const dirEntries = storage.getDirectoryEntries();
    const combined = [];
    if (selfRec) combined.push(selfRec);
    for (const entry of dirEntries) {
      if (entry.publicKeyHash !== myHash) {
        combined.push(entry);
      }
      if (combined.length >= 60) break;
    }

    const envelope = await this.signPayload('gossip_sync', {
      senderUuid: myHash,
      entries: combined,
      timestamp: Date.now()
    });
    if (!envelope) return;

    if (
      this.actions.sendGossipSync &&
      targetPeerId &&
      !targetPeerId.startsWith('bc_') &&
      !targetPeerId.startsWith('local_')
    ) {
      this.actions.sendGossipSync(envelope, targetPeerId);
    } else if (!targetPeerId && this.actions.sendGossipSync) {
      this.actions.sendGossipSync(envelope);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'gossip_sync',
        data: envelope,
        senderUuid: myHash
      });
    }

    this.postLocalSignal('gossip_sync', envelope);
  }

  async broadcastGossipSync() {
    if (Date.now() - this.lastGlobalGossipAt < 10000) return;
    await this.sendGossipSyncTo(null, null);
  }

  sendFriendRequest(targetPseudo, targetUuid = null) {
    if (!this.myProfile) return null;
    const myHash = this.getMyHash();

    const requestPacket = {
      requestId: 'freq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      fromUuid: myHash,
      fromTag: this.myProfile.tag || formatTag(myHash),
      fromNickname: this.myProfile.nickname,
      fromAvatar: this.myProfile.avatar,
      targetPseudo: targetPseudo ? targetPseudo.trim() : null,
      targetUuid: targetUuid ? String(targetUuid).toLowerCase() : null,
      timestamp: Date.now()
    };

    void (async () => {
      const envelope = await this.signPayload('friend_request', requestPacket);
      if (!envelope) return;

      if (this.actions.sendFriendReq) {
        const targetPeerId = requestPacket.targetUuid
          ? this.uuidToPeerId.get(requestPacket.targetUuid)
          : null;
        if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_')) {
          this.actions.sendFriendReq(envelope, targetPeerId);
        } else {
          this.actions.sendFriendReq(envelope);
        }
      }

      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({
          type: 'friend_request',
          data: envelope,
          senderUuid: myHash
        });
      }

      this.postLocalSignal('friend_request', envelope);
    })();

    return requestPacket;
  }

  sendFriendResponse(requestId, targetUuid, accepted = true) {
    if (!this.myProfile) return null;
    const myHash = this.getMyHash();
    const normTarget = String(targetUuid).toLowerCase();

    const responsePacket = {
      requestId,
      fromUuid: myHash,
      fromTag: this.myProfile.tag || formatTag(myHash),
      fromNickname: this.myProfile.nickname,
      fromAvatar: this.myProfile.avatar,
      targetUuid: normTarget,
      accepted: !!accepted,
      timestamp: Date.now()
    };

    void (async () => {
      const envelope = await this.signPayload('friend_response', responsePacket);
      if (!envelope) return;

      if (this.actions.sendFriendResp) {
        const targetPeerId = this.uuidToPeerId.get(normTarget);
        if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_')) {
          this.actions.sendFriendResp(envelope, targetPeerId);
        } else {
          this.actions.sendFriendResp(envelope);
        }
      }

      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({
          type: 'friend_response',
          data: envelope,
          senderUuid: myHash
        });
      }

      this.postLocalSignal('friend_response', envelope);
    })();

    return responsePacket;
  }

  async sendSignedDirectPacket(targetUuid, actionKey, signalType, payload) {
    const normTarget = String(targetUuid || '').toLowerCase();
    const envelope = await this.signPayload(signalType, payload);
    if (!envelope) return;

    const myHash = this.getMyHash();
    const targetPeerId = this.uuidToPeerId.get(normTarget);
    const sendFn = this.actions[actionKey];

    if (targetPeerId && !targetPeerId.startsWith('bc_') && !targetPeerId.startsWith('local_') && sendFn) {
      sendFn(envelope, targetPeerId);
    }

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: signalType,
        data: envelope,
        senderUuid: myHash
      });
    }

    this.postLocalSignal(signalType, envelope);
  }

  sendMessage(targetUuid, text, ephemeral = false, replyTo = null) {
    const myHash = this.getMyHash();
    const normTarget = String(targetUuid).toLowerCase();
    const messagePayload = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      senderUuid: myHash,
      senderTag: this.myProfile.tag || formatTag(myHash),
      targetUuid: normTarget,
      text,
      replyTo: replyTo || null,
      timestamp: Date.now(),
      ephemeral: !!ephemeral,
      status: 'sent'
    };

    void this.sendSignedDirectPacket(normTarget, 'sendChat', 'chat', messagePayload);
    return messagePayload;
  }

  sendMessageReceipt(targetUuid, messageIds, status = 'delivered') {
    if (!this.myProfile || !targetUuid) return null;
    const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean);
    if (ids.length === 0) return null;

    const myHash = this.getMyHash();
    const normTarget = String(targetUuid).toLowerCase();
    const receipt = {
      senderUuid: myHash,
      targetUuid: normTarget,
      messageIds: ids,
      status: status === 'read' ? 'read' : 'delivered',
      timestamp: Date.now()
    };

    void this.sendSignedDirectPacket(normTarget, 'sendMsgReceipt', 'msg_receipt', receipt);
    return receipt;
  }

  sendTyping(targetUuid, isTyping) {
    if (!this.myProfile || !targetUuid) return;
    const myHash = this.getMyHash();
    const normTarget = String(targetUuid).toLowerCase();
    const packet = {
      senderUuid: myHash,
      targetUuid: normTarget,
      isTyping: !!isTyping
    };

    void this.sendSignedDirectPacket(normTarget, 'sendTyping', 'typing', packet);
  }

  sendReaction(targetUuid, messageId, emoji, active) {
    if (!this.myProfile || !targetUuid) return null;
    const myHash = this.getMyHash();
    const normTarget = String(targetUuid).toLowerCase();
    const payload = {
      id: 'react_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      senderUuid: myHash,
      targetUuid: normTarget,
      messageId,
      emoji,
      active: !!active,
      timestamp: Date.now()
    };

    void this.sendSignedDirectPacket(normTarget, 'sendReaction', 'reaction', payload);
    return payload;
  }

  sendDeleteMessage(targetUuid, messageId) {
    if (!this.myProfile || !targetUuid) return null;
    const myHash = this.getMyHash();
    const normTarget = String(targetUuid).toLowerCase();
    const payload = {
      senderUuid: myHash,
      senderNickname: this.myProfile.nickname,
      targetUuid: normTarget,
      messageId,
      timestamp: Date.now()
    };

    void this.sendSignedDirectPacket(normTarget, 'sendDeleteMsg', 'delete_msg', payload);
    return payload;
  }

  sendClearChat(targetUuid) {
    if (!this.myProfile || !targetUuid) return null;
    const myHash = this.getMyHash();
    const normTarget = String(targetUuid).toLowerCase();
    const payload = {
      senderUuid: myHash,
      senderNickname: this.myProfile.nickname,
      targetUuid: normTarget,
      timestamp: Date.now()
    };

    void this.sendSignedDirectPacket(normTarget, 'sendClearChat', 'clear_chat', payload);
    return payload;
  }

  sendSnap(targetUuids, snapData) {
    const myHash = this.getMyHash();
    const normalizedTargets = (Array.isArray(targetUuids) ? targetUuids : [targetUuids]).map((u) =>
      String(u).toLowerCase()
    );

    const snapPayload = {
      id: 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      senderUuid: myHash,
      senderTag: this.myProfile.tag || formatTag(myHash),
      senderNickname: this.myProfile.nickname,
      senderAvatar: this.myProfile.avatar,
      targetUuids: normalizedTargets,
      mediaType: snapData.mediaType || 'photo',
      mediaData: snapData.mediaData,
      timer: snapData.timer !== undefined ? snapData.timer : 5,
      bannerText: snapData.bannerText || '',
      bannerY: snapData.bannerY || 50,
      timestamp: Date.now()
    };

    void (async () => {
      const envelope = await this.signPayload('snap', snapPayload);
      if (!envelope) return;

      normalizedTargets.forEach((targetUuid) => {
        const targetPeerId = this.uuidToPeerId.get(targetUuid);
        if (
          targetPeerId &&
          !targetPeerId.startsWith('bc_') &&
          !targetPeerId.startsWith('local_') &&
          this.actions.sendSnap
        ) {
          this.actions.sendSnap(envelope, targetPeerId);
        }
      });

      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({
          type: 'snap',
          data: envelope,
          senderUuid: myHash
        });
      }

      this.postLocalSignal('snap', envelope);
    })();

    return snapPayload;
  }

  sendSnapReceipt(snapId, senderUuid) {
    if (!this.myProfile || !senderUuid) return;
    const myHash = this.getMyHash();
    const normTarget = String(senderUuid).toLowerCase();
    const receipt = {
      snapId,
      openerUuid: myHash,
      senderUuid: myHash,
      targetUuid: normTarget,
      openedAt: Date.now()
    };

    void this.sendSignedDirectPacket(normTarget, 'sendSnapReceipt', 'snap_receipt', receipt);
  }

  getOnlinePeers() {
    // Dédoublonner par publicKeyHash au cas où WebRTC + bc/local coexistent
    const byUuid = new Map();
    for (const peer of this.peers.values()) {
      const existing = byUuid.get(peer.uuid);
      if (!existing || (!peer.peerId.startsWith('bc_') && !peer.peerId.startsWith('local_'))) {
        byUuid.set(peer.uuid, peer);
      }
    }
    return Array.from(byUuid.values());
  }

  isUserOnline(uuid) {
    if (!uuid) return false;
    return this.uuidToPeerId.has(String(uuid).toLowerCase());
  }

  findPeerByPseudo(pseudo) {
    if (!pseudo) return null;
    const clean = pseudo.trim();
    const lower = clean.toLowerCase();
    const online = this.getOnlinePeers();

    // Correspondance hash exact
    const byHash = online.find((p) => p.uuid === lower);
    if (byHash) return byHash;

    // Correspondance Pseudo#XXXX
    const hashSep = clean.lastIndexOf('#');
    if (hashSep > 0) {
      const qNick = clean.slice(0, hashSep).trim().toLowerCase();
      const qTag = ('#' + clean.slice(hashSep + 1).trim()).toUpperCase();
      const byTag = online.find(
        (p) => p.nickname.trim().toLowerCase() === qNick && p.tag === qTag
      );
      if (byTag) return byTag;
    }

    // Correspondance pseudo avec priorité au firstSeen le plus ancien
    const matches = online.filter((p) => p.nickname.trim().toLowerCase() === lower);
    if (matches.length === 0) return null;
    matches.sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
    return matches[0];
  }

  startHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(async () => {
      await this.broadcastIdentity();

      if (this.actions.sendPing && this.myProfile) {
        const myHash = this.getMyHash();
        const pingEnvelope = await this.signPayload('ping', {
          uuid: myHash,
          senderUuid: myHash,
          ts: Date.now()
        });
        if (pingEnvelope) {
          this.actions.sendPing(pingEnvelope);
        }
      }

      if (this.peers.size > 0) {
        await this.broadcastGossipSync();
      }

      const now = Date.now();
      this.peers.forEach((peer, peerId) => {
        if (now - peer.lastSeen > 35000) {
          this.removePeer(peerId);
        }
      });
    }, 5000);
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
        if (this.signedLeaveEnvelope) {
          this.broadcastChannel.postMessage({
            type: 'leave',
            data: this.signedLeaveEnvelope,
            senderUuid: this.getMyHash()
          });
        }
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
