/**
 * storage.js - Stockage local persistant (IndexedDB + fallback localStorage)
 * - Sauvegarde automatique de toutes les conversations et statuts (Envoyé / Remis / Vu)
 * - Clé locale portable JSON complète (paire ECDSA P-256, amis, conversations, annuaire)
 * - Annuaire collectif Gossip dans IndexedDB avec résolution par firstSeen le plus ancien
 */

import {
  formatTag,
  generateIdentityKeys,
  importPrivateKey,
  importPublicKeyInfo,
  isValidPublicKeyHash,
  signDirectoryRecord,
  verifyDirectoryRecord
} from './crypto.js';

const DB_NAME = 'SnapP2P_DB';
const DB_VERSION = 2;
const STORE_USER_DATA = 'user_data';
const STORE_DIRECTORY = 'directory';
const STORAGE_KEY = 'snap_p2p_active_key';
const DIRECTORY_LS_KEY = 'snap_p2p_directory';
const PENDING_ADDS_LS_KEY = 'snap_p2p_pending_adds';

function cloneSanitizedMessage(message) {
  const copy = { ...message };
  // Un Snap ouvert doit toujours purger son média binaire persistant
  if (copy.type === 'snap' && copy.isOpened) {
    copy.mediaData = null;
  }
  return copy;
}

class StorageManager {
  constructor() {
    this.db = null;
    this.memoryProfile = null;
    this.activePrivateKey = null;
    this.directoryMap = new Map(); // publicKeyHash -> validated entry
    this._mutationChain = Promise.resolve();
    this._dirChain = Promise.resolve();
  }

  /**
   * Initialise IndexedDB (v2 : user_data + directory) et charge le cache annuaire
   */
  async init() {
    await new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB non supporté, fallback sur localStorage.');
        resolve(false);
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_USER_DATA)) {
            db.createObjectStore(STORE_USER_DATA, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_DIRECTORY)) {
            db.createObjectStore(STORE_DIRECTORY, { keyPath: 'publicKeyHash' });
          }
        };
        req.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(true);
        };
        req.onerror = () => {
          console.warn('Erreur ouverture IndexedDB, fallback sur localStorage.');
          resolve(false);
        };
      } catch (err) {
        console.warn('Exception IndexedDB, fallback localStorage:', err);
        resolve(false);
      }
    });

    await this.loadDirectoryFromStorage();
    return true;
  }

  enqueueProfileMutation(fn) {
    const run = this._mutationChain.then(() => fn());
    this._mutationChain = run.catch((err) => {
      console.error('[Storage] Erreur file mutation profil:', err);
    });
    return run;
  }

  enqueueDirectoryOp(fn) {
    const run = this._dirChain.then(() => fn());
    this._dirChain = run.catch((err) => {
      console.error('[Storage] Erreur file annuaire:', err);
    });
    return run;
  }

  /**
   * Génère un UUID v4 aléatoire (fallback utilitaire uniquement pour IDs de paquets)
   */
  generateUUID() {
    if (crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Compresse et rogne n'importe quelle image en 128x128 WebP ou JPEG Base64
   */
  async compressAvatar(source) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');

        const size = Math.min(img.width, img.height);
        const offsetX = (img.width - size) / 2;
        const offsetY = (img.height - size) / 2;

        ctx.drawImage(img, offsetX, offsetY, size, size, 0, 0, 128, 128);

        let dataUrl = canvas.toDataURL('image/webp', 0.85);
        if (!dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error("Impossible de charger l'image d'avatar"));

      if (typeof source === 'string') {
        img.src = source;
      } else if (source instanceof Blob) {
        img.src = URL.createObjectURL(source);
      } else {
        reject(new Error('Format de source image non reconnu'));
      }
    });
  }

  /**
   * Avatar vectoriel initial par défaut (sans emoji)
   */
  createDefaultAvatar(nickname = 'Snap') {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 128, 128);
    grad.addColorStop(0, '#FFFC00');
    grad.addColorStop(1, '#FFB703');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(64, 64, 64, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#000000';
    ctx.font = 'bold 54px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initial = (nickname.trim()[0] || 'S').toUpperCase();
    ctx.fillText(initial, 64, 67);

    return canvas.toDataURL('image/webp', 0.9);
  }

  /**
   * Crée un tout nouveau profil complet équipé d'une paire ECDSA P-256
   */
  async createProfile({ nickname, avatar = '', temporary = false }) {
    const cleanNick = String(nickname || '').trim() || 'SnapUser';
    const finalAvatar = avatar || this.createDefaultAvatar(cleanNick);
    const createdAt = Date.now();
    const keys = await generateIdentityKeys();

    const dirRecord = await signDirectoryRecord(
      keys.privateKey,
      keys.publicKeyJwk,
      keys.publicKeyHash,
      { pseudo: cleanNick, avatar: finalAvatar, firstSeen: createdAt }
    );

    const profile = {
      uuid: keys.publicKeyHash,
      publicKeyHash: keys.publicKeyHash,
      tag: keys.tag,
      publicKeyJwk: keys.publicKeyJwk,
      privateKeyJwk: keys.privateKeyJwk,
      nickname: cleanNick,
      avatar: finalAvatar,
      firstSeen: createdAt,
      createdAt,
      profileSignature: dirRecord.signature,
      friends: [],
      conversations: {},
      savedMessages: {},
      isTemporary: !!temporary
    };

    this.activePrivateKey = keys.privateKey;
    await this.saveProfile(profile, temporary);
    return profile;
  }

  /**
   * S'assure qu'un profil existant (ex: v1/v2 hérité ou importé) possède bien
   * une paire ECDSA P-256 valide, un tag #XXXX, une signature de profil et conversations.
   */
  async ensureProfileCrypto(profile) {
    if (!profile) return null;

    let changed = false;
    let privateKey = null;

    if (profile.privateKeyJwk && profile.publicKeyJwk) {
      try {
        privateKey = await importPrivateKey(profile.privateKeyJwk);
        const pubInfo = await importPublicKeyInfo(profile.publicKeyJwk);
        if (!pubInfo) throw new Error('Public key invalid');
        if (profile.publicKeyHash !== pubInfo.hash || profile.uuid !== pubInfo.hash) {
          profile.publicKeyHash = pubInfo.hash;
          profile.uuid = pubInfo.hash;
          profile.publicKeyJwk = pubInfo.cleanJwk;
          changed = true;
        }
      } catch (err) {
        console.warn('[Storage] Paire ECDSA corrompue, régénération:', err);
        privateKey = null;
      }
    }

    if (!privateKey) {
      const keys = await generateIdentityKeys();
      privateKey = keys.privateKey;
      profile.publicKeyJwk = keys.publicKeyJwk;
      profile.privateKeyJwk = keys.privateKeyJwk;
      profile.publicKeyHash = keys.publicKeyHash;
      profile.uuid = keys.publicKeyHash;
      changed = true;
    }

    const expectedTag = formatTag(profile.publicKeyHash);
    if (profile.tag !== expectedTag) {
      profile.tag = expectedTag;
      changed = true;
    }

    if (!Number.isSafeInteger(profile.firstSeen) || profile.firstSeen <= 0) {
      profile.firstSeen = Number.isSafeInteger(profile.createdAt) && profile.createdAt > 0
        ? profile.createdAt
        : Date.now();
      profile.createdAt = profile.firstSeen;
      changed = true;
    }

    // Fusionner savedMessages hérités vers conversations si nécessaire
    if (!profile.conversations || typeof profile.conversations !== 'object') {
      profile.conversations = {};
      changed = true;
    }
    if (profile.savedMessages && typeof profile.savedMessages === 'object') {
      for (const [peerId, msgs] of Object.entries(profile.savedMessages)) {
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        if (!Array.isArray(profile.conversations[peerId])) {
          profile.conversations[peerId] = msgs.map((m) => cloneSanitizedMessage({ ...m, saved: true }));
          changed = true;
        } else {
          const existingIds = new Set(profile.conversations[peerId].map((m) => m.id));
          for (const m of msgs) {
            if (!existingIds.has(m.id)) {
              profile.conversations[peerId].push(cloneSanitizedMessage({ ...m, saved: true }));
              changed = true;
            }
          }
          profile.conversations[peerId].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        }
      }
    }

    if (!Array.isArray(profile.friends)) {
      profile.friends = [];
      changed = true;
    }

    // Vérifier ou régénérer la signature auto-signée du profil pour l'annuaire Gossip
    const candidateRecord = {
      pseudo: profile.nickname,
      publicKey: profile.publicKeyJwk,
      publicKeyHash: profile.publicKeyHash,
      avatar: profile.avatar || '',
      firstSeen: profile.firstSeen,
      signature: profile.profileSignature
    };
    const verifiedSelf = profile.profileSignature
      ? await verifyDirectoryRecord(candidateRecord)
      : null;

    if (!verifiedSelf) {
      const signed = await signDirectoryRecord(
        privateKey,
        profile.publicKeyJwk,
        profile.publicKeyHash,
        {
          pseudo: profile.nickname,
          avatar: profile.avatar || '',
          firstSeen: profile.firstSeen
        }
      );
      profile.profileSignature = signed.signature;
      changed = true;
    }

    this.activePrivateKey = privateKey;

    if (changed) {
      await this.saveProfile(profile, profile.isTemporary);
    }

    return profile;
  }

  async resignOwnProfile(profile) {
    if (!profile) return null;
    const privKey = this.activePrivateKey || (await importPrivateKey(profile.privateKeyJwk));
    this.activePrivateKey = privKey;
    const signed = await signDirectoryRecord(
      privKey,
      profile.publicKeyJwk,
      profile.publicKeyHash,
      {
        pseudo: profile.nickname,
        avatar: profile.avatar || '',
        firstSeen: profile.firstSeen
      }
    );
    profile.profileSignature = signed.signature;
    await this.saveProfile(profile, profile.isTemporary);
    return profile;
  }

  getSelfDirectoryRecord(profile) {
    if (!profile || !profile.publicKeyJwk || !profile.profileSignature) return null;
    return {
      pseudo: profile.nickname,
      publicKey: profile.publicKeyJwk,
      publicKeyHash: profile.publicKeyHash,
      tag: profile.tag || formatTag(profile.publicKeyHash),
      avatar: profile.avatar || '',
      firstSeen: profile.firstSeen,
      signature: profile.profileSignature
    };
  }

  /**
   * Récupère le profil actif (RAM ou Persistant)
   */
  async getProfile() {
    if (this.memoryProfile) {
      return this.memoryProfile;
    }

    if (this.db) {
      try {
        const profile = await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_USER_DATA], 'readonly');
          const store = tx.objectStore(STORE_USER_DATA);
          const req = store.get('profile');
          req.onsuccess = () => resolve(req.result ? req.result.data : null);
          req.onerror = () => resolve(null);
        });
        if (profile) return profile;
      } catch (err) {
        console.warn('Erreur lecture IndexedDB:', err);
      }
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('Erreur lecture localStorage:', e);
    }

    return null;
  }

  /**
   * Sauvegarde le profil complet dans IndexedDB (+ backup localStorage si possible)
   */
  async saveProfile(profile, temporary = false) {
    profile.isTemporary = !!temporary;
    profile.updatedAt = Date.now();

    if (temporary) {
      this.memoryProfile = profile;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {}
      return profile;
    }

    this.memoryProfile = null;

    if (this.db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction([STORE_USER_DATA], 'readwrite');
          const store = tx.objectStore(STORE_USER_DATA);
          const req = store.put({ id: 'profile', data: profile });
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      } catch (err) {
        console.warn('Erreur écriture IndexedDB:', err);
      }
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch (e) {
      // Si l'historique dépasse ~5Mo dans localStorage, sauvegarder un résumé sans bloquer IndexedDB
      try {
        const compact = { ...profile, conversations: {} };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
      } catch (e2) {
        console.warn('localStorage plein (IndexedDB utilisé):', e2);
      }
    }

    return profile;
  }

  /**
   * Ajoute ou met à jour un ami (vérifié si ajouté par QR/clé publique)
   */
  async addFriend(friendData) {
    return this.enqueueProfileMutation(async () => {
      const profile = await this.getProfile();
      if (!profile) return null;

      if (!Array.isArray(profile.friends)) {
        profile.friends = [];
      }

      const id = (friendData.publicKeyHash || friendData.uuid || '').toLowerCase();
      if (!id) return profile;

      const existingIdx = profile.friends.findIndex(
        (f) => (f.publicKeyHash || f.uuid || '').toLowerCase() === id
      );
      const existing = existingIdx >= 0 ? profile.friends[existingIdx] : null;
      const dirEntry = this.directoryMap.get(id);

      const friendObj = {
        uuid: id,
        publicKeyHash: id,
        tag: friendData.tag || existing?.tag || formatTag(id),
        nickname: friendData.nickname || dirEntry?.pseudo || existing?.nickname || 'Ami',
        avatar: friendData.avatar || dirEntry?.avatar || existing?.avatar || '',
        publicKey: friendData.publicKey || dirEntry?.publicKey || existing?.publicKey || null,
        verified: !!(friendData.verified || existing?.verified || friendData.publicKey || dirEntry),
        addedVia: friendData.addedVia || existing?.addedVia || 'p2p',
        addedAt: existing?.addedAt || Date.now()
      };

      if (existingIdx >= 0) {
        profile.friends[existingIdx] = friendObj;
      } else {
        profile.friends.push(friendObj);
      }

      await this.saveProfile(profile, profile.isTemporary);
      return profile;
    });
  }

  async removeFriend(friendUuid) {
    return this.enqueueProfileMutation(async () => {
      const profile = await this.getProfile();
      if (!profile || !profile.friends) return null;

      const norm = String(friendUuid || '').toLowerCase();
      profile.friends = profile.friends.filter(
        (f) => (f.publicKeyHash || f.uuid || '').toLowerCase() !== norm
      );
      await this.saveProfile(profile, profile.isTemporary);
      return profile;
    });
  }

  async isFriend(uuid) {
    const profile = await this.getProfile();
    if (!profile || !profile.friends) return false;
    const norm = String(uuid || '').toLowerCase();
    return profile.friends.some((f) => (f.publicKeyHash || f.uuid || '').toLowerCase() === norm);
  }

  /**
   * Gestion de l'historique automatique complet des conversations
   */
  async getAllConversations() {
    const profile = await this.getProfile();
    if (!profile) return {};
    return profile.conversations || {};
  }

  async getConversationMessages(peerUuid) {
    const profile = await this.getProfile();
    if (!profile || !profile.conversations) return [];
    return profile.conversations[peerUuid] || [];
  }

  async upsertConversationMessage(peerUuid, message) {
    return this.enqueueProfileMutation(async () => {
      const profile = await this.getProfile();
      if (!profile || !peerUuid || !message) return;

      if (!profile.conversations || typeof profile.conversations !== 'object') {
        profile.conversations = {};
      }
      if (!Array.isArray(profile.conversations[peerUuid])) {
        profile.conversations[peerUuid] = [];
      }

      const cleanMsg = cloneSanitizedMessage(message);
      const list = profile.conversations[peerUuid];
      const existingIdx = cleanMsg.id ? list.findIndex((m) => m.id === cleanMsg.id) : -1;

      if (existingIdx >= 0) {
        list[existingIdx] = cleanMsg;
      } else {
        list.push(cleanMsg);
      }

      if (cleanMsg.saved) {
        if (!profile.savedMessages) profile.savedMessages = {};
        if (!Array.isArray(profile.savedMessages[peerUuid])) profile.savedMessages[peerUuid] = [];
        const sIdx = profile.savedMessages[peerUuid].findIndex((m) => m.id === cleanMsg.id);
        if (sIdx >= 0) profile.savedMessages[peerUuid][sIdx] = cleanMsg;
        else profile.savedMessages[peerUuid].push(cleanMsg);
      }

      await this.saveProfile(profile, profile.isTemporary);
    });
  }

  async setConversationMessages(peerUuid, messages) {
    return this.enqueueProfileMutation(async () => {
      const profile = await this.getProfile();
      if (!profile || !peerUuid) return;

      if (!profile.conversations || typeof profile.conversations !== 'object') {
        profile.conversations = {};
      }

      const sanitizedList = Array.isArray(messages)
        ? messages.map((m) => cloneSanitizedMessage(m))
        : [];
      profile.conversations[peerUuid] = sanitizedList;

      if (!profile.savedMessages) profile.savedMessages = {};
      const onlySaved = sanitizedList.filter((m) => m.saved);
      if (onlySaved.length > 0) {
        profile.savedMessages[peerUuid] = onlySaved;
      } else {
        delete profile.savedMessages[peerUuid];
      }

      await this.saveProfile(profile, profile.isTemporary);
    });
  }

  async saveChatMessage(peerUuid, message) {
    return this.upsertConversationMessage(peerUuid, { ...message, saved: true });
  }

  async unsaveChatMessage(peerUuid, messageId) {
    return this.enqueueProfileMutation(async () => {
      const profile = await this.getProfile();
      if (!profile) return;

      if (profile.conversations && Array.isArray(profile.conversations[peerUuid])) {
        const msg = profile.conversations[peerUuid].find((m) => m.id === messageId);
        if (msg) msg.saved = false;
      }

      if (profile.savedMessages && Array.isArray(profile.savedMessages[peerUuid])) {
        profile.savedMessages[peerUuid] = profile.savedMessages[peerUuid].filter(
          (m) => m.id !== messageId
        );
      }
      await this.saveProfile(profile, profile.isTemporary);
    });
  }

  async clearChatMessages(peerUuid, systemNotice = null) {
    return this.enqueueProfileMutation(async () => {
      const profile = await this.getProfile();
      if (!profile || !peerUuid) return;

      if (!profile.conversations) profile.conversations = {};
      if (systemNotice) {
        profile.conversations[peerUuid] = [cloneSanitizedMessage(systemNotice)];
      } else {
        delete profile.conversations[peerUuid];
      }

      if (profile.savedMessages && profile.savedMessages[peerUuid]) {
        delete profile.savedMessages[peerUuid];
      }
      await this.saveProfile(profile, profile.isTemporary);
    });
  }

  async getSavedChatMessages(peerUuid) {
    return this.getConversationMessages(peerUuid);
  }

  /**
   * =========================================================================
   * ANNUAIRE COLLECTIF (GOSSIP) DANS INDEXEDDB
   * =========================================================================
   */
  async loadDirectoryFromStorage() {
    this.directoryMap.clear();
    let rawEntries = [];

    if (this.db && this.db.objectStoreNames.contains(STORE_DIRECTORY)) {
      try {
        rawEntries = await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_DIRECTORY], 'readonly');
          const store = tx.objectStore(STORE_DIRECTORY);
          const req = store.getAll();
          req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
          req.onerror = () => resolve([]);
        });
      } catch (err) {
        console.warn('Erreur lecture directory IndexedDB:', err);
      }
    } else {
      try {
        const raw = localStorage.getItem(DIRECTORY_LS_KEY);
        if (raw) rawEntries = JSON.parse(raw);
      } catch (e) {}
    }

    for (const raw of rawEntries) {
      const verified = await verifyDirectoryRecord(raw);
      if (!verified) continue;
      const pseudoKey = verified.pseudo.toLowerCase();
      let conflictWinner = null;

      for (const existing of this.directoryMap.values()) {
        if (existing.pseudo.toLowerCase() === pseudoKey) {
          conflictWinner = existing;
          break;
        }
      }

      if (conflictWinner && conflictWinner.publicKeyHash !== verified.publicKeyHash) {
        const incomingOlder =
          verified.firstSeen < conflictWinner.firstSeen ||
          (verified.firstSeen === conflictWinner.firstSeen &&
            verified.publicKeyHash < conflictWinner.publicKeyHash);
        if (!incomingOlder) continue;
        this.directoryMap.delete(conflictWinner.publicKeyHash);
      }

      this.directoryMap.set(verified.publicKeyHash, verified);
    }
  }

  async persistDirectoryPut(entry) {
    if (this.db && this.db.objectStoreNames.contains(STORE_DIRECTORY)) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction([STORE_DIRECTORY], 'readwrite');
          const store = tx.objectStore(STORE_DIRECTORY);
          const req = store.put(entry);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      } catch (err) {
        console.warn('Erreur put directory IndexedDB:', err);
      }
    } else {
      try {
        localStorage.setItem(
          DIRECTORY_LS_KEY,
          JSON.stringify(Array.from(this.directoryMap.values()))
        );
      } catch (e) {}
    }
  }

  async persistDirectoryDelete(publicKeyHash) {
    if (this.db && this.db.objectStoreNames.contains(STORE_DIRECTORY)) {
      try {
        await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_DIRECTORY], 'readwrite');
          const store = tx.objectStore(STORE_DIRECTORY);
          const req = store.delete(publicKeyHash);
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
        });
      } catch (err) {}
    } else {
      try {
        localStorage.setItem(
          DIRECTORY_LS_KEY,
          JSON.stringify(Array.from(this.directoryMap.values()))
        );
      } catch (e) {}
    }
  }

  /**
   * Valide et insère une entrée d'annuaire (Gossip) en garantissant :
   * 1. Signature ECDSA valide par sa propre clé publique
   * 2. En cas de doublon de pseudo, l'entrée avec le firstSeen le plus ancien reste prioritaire
   */
  async upsertDirectoryEntry(rawEntry) {
    const verified = await verifyDirectoryRecord(rawEntry);
    if (!verified) {
      return { accepted: false, reason: 'invalid_signature' };
    }

    return this.enqueueDirectoryOp(async () => {
      const pseudoKey = verified.pseudo.toLowerCase();
      let duplicateEntry = null;

      for (const existing of this.directoryMap.values()) {
        if (
          existing.publicKeyHash !== verified.publicKeyHash &&
          existing.pseudo.toLowerCase() === pseudoKey
        ) {
          duplicateEntry = existing;
          break;
        }
      }

      if (duplicateEntry) {
        const incomingWins =
          verified.firstSeen < duplicateEntry.firstSeen ||
          (verified.firstSeen === duplicateEntry.firstSeen &&
            verified.publicKeyHash < duplicateEntry.publicKeyHash);

        if (!incomingWins) {
          return {
            accepted: false,
            reason: 'duplicate_pseudo_older_exists',
            winner: duplicateEntry
          };
        }

        // Le pair entrant a un firstSeen plus ancien : il remplace l'entrée plus récente
        this.directoryMap.delete(duplicateEntry.publicKeyHash);
        await this.persistDirectoryDelete(duplicateEntry.publicKeyHash);
      }

      const prevSameKey = this.directoryMap.get(verified.publicKeyHash);
      if (prevSameKey) {
        // Toujours préserver le firstSeen le plus ancien signé, ou mettre à jour si signature égale/plus fraîche avec même firstSeen
        if (
          prevSameKey.firstSeen < verified.firstSeen ||
          (prevSameKey.firstSeen === verified.firstSeen &&
            prevSameKey.signature === verified.signature)
        ) {
          return { accepted: true, changed: false, entry: prevSameKey };
        }
      }

      const storedEntry = {
        pseudo: verified.pseudo,
        publicKey: verified.publicKey,
        publicKeyHash: verified.publicKeyHash,
        tag: verified.tag,
        avatar: verified.avatar,
        firstSeen: verified.firstSeen,
        signature: verified.signature
      };

      this.directoryMap.set(storedEntry.publicKeyHash, storedEntry);
      await this.persistDirectoryPut(storedEntry);

      // Enrichir l'ami s'il avait été ajouté via QR Code sans avatar préalable
      await this.enqueueProfileMutation(async () => {
        const profile = await this.getProfile();
        if (!profile || !Array.isArray(profile.friends)) return;
        const friend = profile.friends.find(
          (f) => (f.publicKeyHash || f.uuid || '').toLowerCase() === storedEntry.publicKeyHash
        );
        if (friend) {
          let dirty = false;
          if (!friend.avatar && storedEntry.avatar) {
            friend.avatar = storedEntry.avatar;
            dirty = true;
          }
          if (!friend.publicKey && storedEntry.publicKey) {
            friend.publicKey = storedEntry.publicKey;
            friend.verified = true;
            dirty = true;
          }
          if (dirty) {
            await this.saveProfile(profile, profile.isTemporary);
          }
        }
      });

      return { accepted: true, changed: true, entry: storedEntry };
    });
  }

  async syncDirectoryBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { added: 0 };
    let changedCount = 0;
    for (const raw of entries) {
      const res = await this.upsertDirectoryEntry(raw);
      if (res.accepted && res.changed) changedCount++;
    }
    return { added: changedCount };
  }

  getDirectoryEntries() {
    return Array.from(this.directoryMap.values()).sort(
      (a, b) => (a.firstSeen || 0) - (b.firstSeen || 0)
    );
  }

  getDirectoryEntry(publicKeyHash) {
    if (!publicKeyHash) return null;
    return this.directoryMap.get(String(publicKeyHash).toLowerCase()) || null;
  }

  resolvePeerInDirectory(query) {
    if (!query) return null;
    const clean = String(query).trim();
    const lower = clean.toLowerCase();

    if (isValidPublicKeyHash(lower)) {
      return this.directoryMap.get(lower) || null;
    }

    // Format "Pseudo#XXXX"
    const hashPos = clean.lastIndexOf('#');
    if (hashPos > 0) {
      const qNick = clean.slice(0, hashPos).trim().toLowerCase();
      const qTag = ('#' + clean.slice(hashPos + 1).trim()).toUpperCase();
      for (const entry of this.directoryMap.values()) {
        if (entry.pseudo.toLowerCase() === qNick && entry.tag === qTag) {
          return entry;
        }
      }
    }

    // Correspondance pseudo : grâce au tri firstSeen croissant et résolution, le plus ancien est prioritaire
    const matches = [];
    for (const entry of this.directoryMap.values()) {
      if (entry.pseudo.toLowerCase() === lower) {
        matches.push(entry);
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => a.firstSeen - b.firstSeen);
    return matches[0];
  }

  /**
   * File d'attente persistante si un lien #add= est ouvert avant la création du compte
   */
  async savePendingUrlAdd(contact) {
    let existing = await this.getPendingUrlAdds();
    const filtered = existing.filter((c) => c.publicKeyHash !== contact.publicKeyHash);
    filtered.push(contact);

    if (this.db) {
      try {
        await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_USER_DATA], 'readwrite');
          const store = tx.objectStore(STORE_USER_DATA);
          const req = store.put({ id: 'pending_url_adds', data: filtered });
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
        });
      } catch (err) {}
    }
    try {
      localStorage.setItem(PENDING_ADDS_LS_KEY, JSON.stringify(filtered));
    } catch (e) {}
  }

  async getPendingUrlAdds() {
    if (this.db) {
      try {
        const list = await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_USER_DATA], 'readonly');
          const store = tx.objectStore(STORE_USER_DATA);
          const req = store.get('pending_url_adds');
          req.onsuccess = () => resolve(Array.isArray(req.result?.data) ? req.result.data : []);
          req.onerror = () => resolve([]);
        });
        if (list.length > 0) return list;
      } catch (err) {}
    }
    try {
      const raw = localStorage.getItem(PENDING_ADDS_LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
  }

  async clearPendingUrlAdds() {
    if (this.db) {
      try {
        await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_USER_DATA], 'readwrite');
          const store = tx.objectStore(STORE_USER_DATA);
          const req = store.delete('pending_url_adds');
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
        });
      } catch (err) {}
    }
    try {
      localStorage.removeItem(PENDING_ADDS_LS_KEY);
    } catch (e) {}
  }

  /**
   * =========================================================================
   * EXPORT & IMPORT COMPLET DU PROFIL (.json + SNAPKEY:...)
   * =========================================================================
   */
  async exportKey() {
    const profile = await this.getProfile();
    if (!profile) throw new Error('Aucun profil à exporter');

    const keyPayload = {
      version: 3,
      appName: 'SnapP2P',
      uuid: profile.publicKeyHash || profile.uuid,
      publicKeyHash: profile.publicKeyHash || profile.uuid,
      tag: profile.tag || formatTag(profile.publicKeyHash || profile.uuid),
      publicKeyJwk: profile.publicKeyJwk || null,
      privateKeyJwk: profile.privateKeyJwk || null,
      nickname: profile.nickname,
      avatar: profile.avatar,
      firstSeen: profile.firstSeen || profile.createdAt || Date.now(),
      createdAt: profile.createdAt || profile.firstSeen || Date.now(),
      profileSignature: profile.profileSignature || null,
      friends: profile.friends || [],
      conversations: profile.conversations || {},
      savedMessages: profile.savedMessages || {},
      directory: this.getDirectoryEntries(),
      exportedAt: Date.now()
    };

    const jsonString = JSON.stringify(keyPayload, null, 2);
    const base64Code = 'SNAPKEY:' + btoa(unescape(encodeURIComponent(jsonString)));

    return {
      jsonString,
      base64Code,
      profile
    };
  }

  async downloadKeyFile() {
    const { jsonString, profile } = await this.exportKey();
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTag = (profile.tag || '').replace('#', '');
    a.href = url;
    a.download = `snap_profile_${profile.nickname.replace(/[^a-zA-Z0-9_-]/g, '_')}_${safeTag}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async importKey(rawInput, temporary = false) {
    let payload = null;

    if (typeof rawInput === 'object' && rawInput !== null) {
      payload = rawInput;
    } else if (typeof rawInput === 'string') {
      const cleaned = rawInput.trim();
      if (cleaned.startsWith('SNAPKEY:')) {
        const b64 = cleaned.substring('SNAPKEY:'.length);
        const json = decodeURIComponent(escape(atob(b64)));
        payload = JSON.parse(json);
      } else {
        payload = JSON.parse(cleaned);
      }
    } else {
      throw new Error('Format de clé non valide');
    }

    if ((!payload.uuid && !payload.publicKeyHash) || !payload.nickname) {
      throw new Error('Clé invalide: identifiant ou pseudo manquant');
    }

    const baseProfile = {
      uuid: payload.publicKeyHash || payload.uuid,
      publicKeyHash: payload.publicKeyHash || payload.uuid,
      tag: payload.tag || formatTag(payload.publicKeyHash || payload.uuid),
      publicKeyJwk: payload.publicKeyJwk || null,
      privateKeyJwk: payload.privateKeyJwk || null,
      nickname: payload.nickname,
      avatar: payload.avatar || this.createDefaultAvatar(payload.nickname),
      firstSeen: payload.firstSeen || payload.createdAt || Date.now(),
      createdAt: payload.createdAt || payload.firstSeen || Date.now(),
      profileSignature: payload.profileSignature || null,
      friends: Array.isArray(payload.friends) ? payload.friends : [],
      conversations:
        payload.conversations && typeof payload.conversations === 'object'
          ? payload.conversations
          : {},
      savedMessages:
        payload.savedMessages && typeof payload.savedMessages === 'object'
          ? payload.savedMessages
          : {},
      isTemporary: !!temporary,
      importedAt: Date.now()
    };

    const hydrated = await this.ensureProfileCrypto(baseProfile);
    await this.saveProfile(hydrated, temporary);

    if (Array.isArray(payload.directory)) {
      await this.syncDirectoryBatch(payload.directory);
    }

    return hydrated;
  }

  async purgeAccount() {
    this.memoryProfile = null;
    this.activePrivateKey = null;
    this.directoryMap.clear();

    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(DIRECTORY_LS_KEY);
      localStorage.removeItem(PENDING_ADDS_LS_KEY);
    } catch (e) {}

    if (this.db) {
      const clearStore = (storeName) =>
        new Promise((resolve) => {
          if (!this.db.objectStoreNames.contains(storeName)) {
            resolve(true);
            return;
          }
          try {
            const tx = this.db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            const req = store.clear();
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
          } catch (err) {
            resolve(false);
          }
        });
      await clearStore(STORE_USER_DATA);
      await clearStore(STORE_DIRECTORY);
    }
  }
}

export const storage = new StorageManager();
