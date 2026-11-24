/**
 * crypto.js - Cryptographie identitaire ECDSA P-256 (Web Crypto API)
 * - Paire de clés publique/privée ECDSA P-256 extractible
 * - Empreinte SHA-256 de la clé publique (publicKeyHash) & tag #XXXX
 * - Signature et vérification de tous les paquets P2P et enregistrements d'annuaire
 */

const textEncoder = new TextEncoder();
const publicKeyCache = new Map(); // cacheKey -> { publicKey, hash, cleanJwk }

function ensureWebCrypto() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error(
      'Web Crypto API indisponible (utilisez HTTPS ou http://localhost).'
    );
  }
}

export function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function isValidPublicKeyHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim());
}

export function formatTag(publicKeyHash) {
  if (!publicKeyHash || typeof publicKeyHash !== 'string') return '#0000';
  return '#' + publicKeyHash.trim().slice(0, 4).toUpperCase();
}

export function sanitizePublicKeyJwk(jwk) {
  if (
    !jwk ||
    typeof jwk !== 'object' ||
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  ) {
    return null;
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x,
    y: jwk.y,
    ext: true
  };
}

export async function computePublicKeyHash(publicKey) {
  ensureWebCrypto();
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return bytesToHex(new Uint8Array(digest));
}

export async function importPublicKeyInfo(publicKeyJwk) {
  ensureWebCrypto();
  const cleanJwk = sanitizePublicKeyJwk(publicKeyJwk);
  if (!cleanJwk) return null;

  const cacheKey = `${cleanJwk.x}:${cleanJwk.y}`;
  if (publicKeyCache.has(cacheKey)) {
    return publicKeyCache.get(cacheKey);
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      cleanJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );
    const hash = await computePublicKeyHash(publicKey);
    const info = { publicKey, hash, cleanJwk };
    publicKeyCache.set(cacheKey, info);
    return info;
  } catch (err) {
    return null;
  }
}

export async function importPrivateKey(privateKeyJwk) {
  ensureWebCrypto();
  if (
    !privateKeyJwk ||
    typeof privateKeyJwk !== 'object' ||
    privateKeyJwk.kty !== 'EC' ||
    privateKeyJwk.crv !== 'P-256' ||
    typeof privateKeyJwk.d !== 'string'
  ) {
    throw new Error('Clé privée ECDSA P-256 invalide');
  }
  return crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
}

export async function generateIdentityKeys() {
  ensureWebCrypto();
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const rawPubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const publicKeyJwk = sanitizePublicKeyJwk(rawPubJwk);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyHash = await computePublicKeyHash(keyPair.publicKey);

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyJwk,
    privateKeyJwk,
    publicKeyHash,
    tag: formatTag(publicKeyHash)
  };
}

export async function signString(privateKey, message) {
  ensureWebCrypto();
  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    textEncoder.encode(message)
  );
  return bytesToBase64(new Uint8Array(sigBuffer));
}

export async function verifyString(publicKey, signatureB64, message) {
  ensureWebCrypto();
  if (!publicKey || typeof signatureB64 !== 'string' || typeof message !== 'string') {
    return false;
  }
  try {
    const sigBytes = base64ToBytes(signatureB64);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      textEncoder.encode(message)
    );
  } catch (err) {
    return false;
  }
}

export function buildDirectoryCanonicalString(record) {
  return (
    'DIRECTORY_V1:' +
    JSON.stringify([
      String(record.pseudo || '').trim(),
      String(record.publicKeyHash || '').toLowerCase(),
      Number(record.firstSeen),
      String(record.avatar || '')
    ])
  );
}

export async function signDirectoryRecord(privateKey, publicKeyJwk, publicKeyHash, { pseudo, avatar, firstSeen }) {
  const cleanPub = sanitizePublicKeyJwk(publicKeyJwk);
  const normalizedPseudo = String(pseudo || '').trim();
  const normalizedTs = Number(firstSeen);
  const normalizedAvatar = typeof avatar === 'string' ? avatar : '';
  const normalizedHash = String(publicKeyHash).toLowerCase();

  const canonical = buildDirectoryCanonicalString({
    pseudo: normalizedPseudo,
    publicKeyHash: normalizedHash,
    firstSeen: normalizedTs,
    avatar: normalizedAvatar
  });

  const signature = await signString(privateKey, canonical);

  return {
    pseudo: normalizedPseudo,
    publicKey: cleanPub,
    publicKeyHash: normalizedHash,
    tag: formatTag(normalizedHash),
    avatar: normalizedAvatar,
    firstSeen: normalizedTs,
    signature
  };
}

export async function verifyDirectoryRecord(record) {
  try {
    if (!record || typeof record !== 'object') return null;

    const pseudo = typeof record.pseudo === 'string' ? record.pseudo.trim() : '';
    const firstSeen = Number(record.firstSeen);
    const avatar = typeof record.avatar === 'string' ? record.avatar : '';
    const signature = typeof record.signature === 'string' ? record.signature : '';

    if (!pseudo || pseudo.length > 40 || !signature) return null;
    if (!Number.isSafeInteger(firstSeen) || firstSeen <= 0 || firstSeen > Date.now() + 300000) {
      return null;
    }

    const keyInfo = await importPublicKeyInfo(record.publicKey);
    if (!keyInfo) return null;

    if (record.publicKeyHash && String(record.publicKeyHash).toLowerCase() !== keyInfo.hash) {
      return null;
    }

    const canonical = buildDirectoryCanonicalString({
      pseudo,
      publicKeyHash: keyInfo.hash,
      firstSeen,
      avatar
    });

    const isValid = await verifyString(keyInfo.publicKey, signature, canonical);
    if (!isValid) return null;

    return {
      pseudo,
      publicKey: keyInfo.cleanJwk,
      publicKeyHash: keyInfo.hash,
      tag: formatTag(keyInfo.hash),
      avatar,
      firstSeen,
      signature
    };
  } catch (err) {
    return null;
  }
}

export async function signPacketEnvelope(privateKey, publicKeyJwk, publicKeyHash, type, payloadObj) {
  const normalizedHash = String(publicKeyHash).toLowerCase();
  const cleanPub = sanitizePublicKeyJwk(publicKeyJwk);
  const payloadJson = JSON.stringify(payloadObj);
  const signedData = `${type}:${normalizedHash}:${payloadJson}`;
  const sig = await signString(privateKey, signedData);

  return {
    __signed: true,
    type,
    senderHash: normalizedHash,
    publicKey: cleanPub,
    payloadJson,
    sig
  };
}

export async function verifyPacketEnvelope(envelope, expectedType = null) {
  try {
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      envelope.__signed !== true ||
      typeof envelope.type !== 'string' ||
      typeof envelope.payloadJson !== 'string' ||
      typeof envelope.sig !== 'string' ||
      typeof envelope.senderHash !== 'string'
    ) {
      return null;
    }

    if (expectedType && envelope.type !== expectedType) {
      return null;
    }

    const claimedHash = envelope.senderHash.trim().toLowerCase();
    if (!isValidPublicKeyHash(claimedHash)) return null;

    const keyInfo = await importPublicKeyInfo(envelope.publicKey);
    if (!keyInfo || keyInfo.hash !== claimedHash) {
      return null;
    }

    const signedData = `${envelope.type}:${claimedHash}:${envelope.payloadJson}`;
    const validSig = await verifyString(keyInfo.publicKey, envelope.sig, signedData);
    if (!validSig) {
      return null;
    }

    const payload = JSON.parse(envelope.payloadJson);
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    // Empêcher l'usurpation d'identité dans la charge utile signée
    const senderFields = ['uuid', 'publicKeyHash', 'senderUuid', 'fromUuid', 'openerUuid'];
    for (const field of senderFields) {
      if (payload[field] !== undefined && payload[field] !== null) {
        if (String(payload[field]).toLowerCase() !== claimedHash) {
          return null;
        }
      }
    }

    return {
      type: envelope.type,
      senderHash: claimedHash,
      tag: formatTag(claimedHash),
      publicKey: keyInfo.cleanJwk,
      payload
    };
  } catch (err) {
    return null;
  }
}
