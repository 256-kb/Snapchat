/**
 * storage.js - Gestion du stockage local (IndexedDB + localStorage)
 * et du système de "Clé Locale Portable" (Export / Import JSON et Base64).
 */

const DB_NAME = 'SnapP2P_DB';
const DB_VERSION = 1;
const STORE_NAME = 'user_data';
const STORAGE_KEY = 'snap_p2p_active_key';

class StorageManager {
  constructor() {
    this.db = null;
    this.memoryProfile = null; // Utilisé pour les sessions temporaires (RAM uniquement)
  }

  /**
   * Initialise IndexedDB avec promesse de sécurité
   */
  async init() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB non supporté, fallback sur localStorage.');
        resolve(false);
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
  }

  /**
   * Génère un UUID v4 aléatoire
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
   * Crée un avatar par défaut style Snapchat (dégradé jaune/noir avec silhouette vectorielle épurée)
   */
  createDefaultAvatar(nickname = 'Snap') {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    // Dégradé jaune Snapchat
    const grad = ctx.createLinearGradient(0, 0, 128, 128);
    grad.addColorStop(0, '#FFFC00');
    grad.addColorStop(1, '#FFB703');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(64, 64, 64, 0, Math.PI * 2);
    ctx.fill();

    // Contour noir net
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Initiales nettes sans emoji
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 54px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initial = (nickname.trim()[0] || 'S').toUpperCase();
    ctx.fillText(initial, 64, 67);

    return canvas.toDataURL('image/webp', 0.9);
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
          const tx = this.db.transaction([STORE_NAME], 'readonly');
          const store = tx.objectStore(STORE_NAME);
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
   * Sauvegarde le profil
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
          const tx = this.db.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
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
      console.warn('Erreur écriture localStorage:', e);
    }

    return profile;
  }

  /**
   * Ajoute ou met à jour un ami
   */
  async addFriend(friendData) {
    const profile = await this.getProfile();
    if (!profile) return null;

    if (!Array.isArray(profile.friends)) {
      profile.friends = [];
    }

    const existingIdx = profile.friends.findIndex((f) => f.uuid === friendData.uuid);
    const friendObj = {
      uuid: friendData.uuid,
      nickname: friendData.nickname || 'Ami',
      avatar: friendData.avatar || '',
      addedAt: Date.now()
    };

    if (existingIdx >= 0) {
      profile.friends[existingIdx] = { ...profile.friends[existingIdx], ...friendObj };
    } else {
      profile.friends.push(friendObj);
    }

    await this.saveProfile(profile, profile.isTemporary);
    return profile;
  }

  /**
   * Retire un ami
   */
  async removeFriend(friendUuid) {
    const profile = await this.getProfile();
    if (!profile || !profile.friends) return null;

    profile.friends = profile.friends.filter((f) => f.uuid !== friendUuid);
    await this.saveProfile(profile, profile.isTemporary);
    return profile;
  }

  /**
   * Vérifie si un utilisateur est ami
   */
  async isFriend(uuid) {
    const profile = await this.getProfile();
    if (!profile || !profile.friends) return false;
    return profile.friends.some((f) => f.uuid === uuid);
  }

  /**
   * Sauvegarde un message permanent
   */
  async saveChatMessage(peerUuid, message) {
    const profile = await this.getProfile();
    if (!profile) return;
    if (!profile.savedMessages) profile.savedMessages = {};
    if (!profile.savedMessages[peerUuid]) profile.savedMessages[peerUuid] = [];

    const exists = profile.savedMessages[peerUuid].some((m) => m.id === message.id);
    if (!exists) {
      profile.savedMessages[peerUuid].push(message);
      await this.saveProfile(profile, profile.isTemporary);
    }
  }

  /**
   * Supprime un message permanent
   */
  async unsaveChatMessage(peerUuid, messageId) {
    const profile = await this.getProfile();
    if (!profile || !profile.savedMessages || !profile.savedMessages[peerUuid]) return;

    profile.savedMessages[peerUuid] = profile.savedMessages[peerUuid].filter(
      (m) => m.id !== messageId
    );
    await this.saveProfile(profile, profile.isTemporary);
  }

  async getSavedChatMessages(peerUuid) {
    const profile = await this.getProfile();
    if (!profile || !profile.savedMessages) return [];
    return profile.savedMessages[peerUuid] || [];
  }

  /**
   * Export de la clé locale
   */
  async exportKey() {
    const profile = await this.getProfile();
    if (!profile) throw new Error('Aucun profil à exporter');

    const keyPayload = {
      version: 2,
      appName: 'SnapP2P',
      uuid: profile.uuid,
      nickname: profile.nickname,
      avatar: profile.avatar,
      friends: profile.friends || [],
      savedMessages: profile.savedMessages || {},
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
    a.href = url;
    a.download = `snap_key_${profile.nickname.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.json`;
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
      let cleaned = rawInput.trim();
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

    if (!payload.uuid || !payload.nickname) {
      throw new Error('Clé invalide: UUID ou pseudo manquant');
    }

    const newProfile = {
      uuid: payload.uuid,
      nickname: payload.nickname,
      avatar: payload.avatar || this.createDefaultAvatar(payload.nickname),
      friends: Array.isArray(payload.friends) ? payload.friends : [],
      savedMessages: payload.savedMessages || {},
      isTemporary: !!temporary,
      importedAt: Date.now()
    };

    await this.saveProfile(newProfile, temporary);
    return newProfile;
  }

  async purgeAccount() {
    this.memoryProfile = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}

    if (this.db) {
      try {
        await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const req = store.clear();
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
        });
      } catch (err) {}
    }
  }
}

export const storage = new StorageManager();
