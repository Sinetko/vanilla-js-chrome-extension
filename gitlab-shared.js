const DEFAULT_BASE_URL = 'https://gitlab.com';
const DEFAULT_PROJECT_PATH = 'applications/repository';
const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const REQUEST_TIMEOUT_MS = 15000;
const DETAIL_FETCH_CONCURRENCY = 6;
const KEK_SALT_STORAGE = 'tokenKekSaltB64';
const WRAPPED_DATA_KEY_STORAGE = 'tokenWrappedKey';
const PBKDF2_ITERATIONS = 100000;
const BIOMETRIC_CREDENTIAL_ID_STORAGE = 'biometricCredentialId';
const WRAPPED_DATA_KEY_BIOMETRIC_STORAGE = 'tokenWrappedKeyBiometric';
// Non-secret domain separator fed into the WebAuthn PRF extension — just
// distinguishes this app's use of the credential from any other consumer
// of the same PRF-capable credential. Doesn't need to be random or secret.
const PRF_EVAL_SALT = new TextEncoder().encode('gitlab-mr-dashboard-token-key-v1');

// Plausible-looking, entirely unused storage entries, regenerated whenever
// the real ones are. This is pure noise for whoever pokes through
// chrome.storage.local by hand — it adds zero cryptographic strength and
// stops nothing that actually attempts decryption (the real keys are the
// ones fetchMrDetails/attemptUnlock/etc. name explicitly, and reading the
// source instantly tells them apart). Its only value is making a casual
// "which key is the real one?" skim slower and less certain.
const DECOY_STORAGE_KEYS = [
  'tokenWrappedKeyLegacy',
  'tokenBackupKey',
  'authCacheKey',
  'sessionSeedKey',
];

const DEFAULT_NOTIFICATION_PREFS = {
  newMr: true,
  newCommits: true,
  readyForReview: true,
  approved: true,
  merged: true,
  pipelineFailed: true,
  newConflict: true,
};

// ---------------------------------------------------------------------------
// Settings: read/write the whole config object. The token is encrypted at
// rest (see "Token security" below) — getSettings() returns it decrypted,
// saveSettings() encrypts it before it ever touches chrome.storage.
// ---------------------------------------------------------------------------

async function getSettings() {
  const result = await chrome.storage.local.get([
    'baseUrl',
    'projectPaths',
    'projectPath', // legacy single-repo field, migrated below
    'activeProjectPath',
    'tokenEncrypted',
    'token', // legacy plaintext field, migrated below
    'username',
    'pollIntervalMinutes',
    'theme',
    'notifications',
    'soundEnabled',
    'soundChoice',
    'pinLockEnabled',
  ]);

  const projectPaths =
    Array.isArray(result.projectPaths) && result.projectPaths.length
      ? result.projectPaths
      : [result.projectPath || DEFAULT_PROJECT_PATH];

  const activeProjectPath = projectPaths.includes(result.activeProjectPath)
    ? result.activeProjectPath
    : projectPaths[0];

  const pinLockEnabled = Boolean(result.pinLockEnabled);

  // When PIN-lock is on, the token is wrapped with a PIN-derived key that
  // only the popup ever asks the user for — getSettings() itself can't
  // decrypt it on its own. Note the plaintext token is never cached
  // anywhere, even in session storage — only the already-unwrapped data
  // key is (see attemptUnlock()) — so every call here re-decrypts
  // tokenEncrypted from that cached key instead of reading a stored
  // plaintext copy.
  let token;
  if (pinLockEnabled) {
    token = await decryptTokenWithSessionKey();
  } else {
    token = result.tokenEncrypted ? await decryptToken(result.tokenEncrypted) : result.token || '';
  }

  return {
    baseUrl: (result.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    projectPaths,
    activeProjectPath,
    token,
    pinLockEnabled,
    username: result.username || '',
    pollIntervalMinutes: result.pollIntervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES,
    theme: result.theme || 'system',
    notifications: { ...DEFAULT_NOTIFICATION_PREFS, ...(result.notifications || {}) },
    soundEnabled: result.soundEnabled !== false,
    soundChoice: result.soundChoice || 'chime.wav',
  };
}

async function saveSettings(settings) {
  const toStore = { ...settings };
  if ('token' in toStore) {
    const token = toStore.token;
    delete toStore.token;

    const { pinLockEnabled } = await chrome.storage.local.get('pinLockEnabled');
    if (pinLockEnabled) {
      // The PIN itself is never stored, so the only way to re-encrypt here
      // is with the data key already unwrapped by this session's unlock.
      // Reaching this without having unlocked shouldn't happen in the UI
      // (the lock screen gates everything else), but fail loudly if it does
      // rather than silently keep the old encrypted token.
      const reencrypted = await reencryptTokenWithSessionKey(token);
      if (!reencrypted) {
        throw new Error('Unlock with your PIN before changing the token.');
      }
    } else {
      toStore.tokenEncrypted = token ? await encryptToken(token) : null;
    }
  }
  await chrome.storage.local.set(toStore);
  await chrome.storage.local.remove('token'); // drop any legacy plaintext copy
}

// ---------------------------------------------------------------------------
// Token security: the token is AES-GCM encrypted with a random "data key".
// That data key is never stored in the clear — it's itself AES-GCM wrapped
// with a "wrapping key" derived (PBKDF2) from this device/browser/install's
// fingerprint, which is never stored at all — only recomputed on demand.
// So chrome.storage.local only ever holds: the wrapped data key, a
// (non-secret) PBKDF2 salt, and the encrypted token.
//
// Optionally (Settings → Lock), a user PIN is mixed directly into that same
// derivation — the wrapping key becomes PBKDF2(fingerprint + pin, salt)
// instead of PBKDF2(fingerprint, salt). This is real key material, not a
// separate pass/fail check: get the PIN wrong and AES-GCM's auth tag simply
// fails to verify, so there is no unwrapped key and nothing to fall back to.
// The PIN itself is never written anywhere.
//
// Because the PIN only ever exists in the popup's memory for the moment
// it's typed, and a service worker can't prompt for it, the background
// poller cannot derive this key on its own once PIN-lock is on. Instead, a
// successful unlock in the popup (attemptUnlock) caches only the
// now-unwrapped raw data key in chrome.storage.session — memory-only,
// cleared when Chrome fully closes. The plaintext token itself is never
// cached anywhere, not even there: the background poller (and any later
// popup open, same browser session) re-decrypts tokenEncrypted from that
// cached key on every read via getSettings()/decryptTokenWithSessionKey(),
// instead of storing a second, redundant plaintext copy. That's what makes
// "enter PIN once per browser restart, then unattended until next restart"
// possible at all.
//
// Net effect: with PIN-lock off, this is unattended and automatic exactly
// as before (protects against the storage blob being copied to another
// device — the fingerprint won't reproduce there). With PIN-lock on, the
// token is additionally unrecoverable from a cold chrome.storage.local
// snapshot without the PIN, full stop — the only thing that ever exists in
// the clear in session memory after unlocking is the AES key, and even
// that requires one more decrypt step to reach the actual token.
// ---------------------------------------------------------------------------

// Every component here must exist identically in BOTH the popup (Window)
// and the background script (ServiceWorkerGlobalScope) — encrypt happens in
// one, decrypt in the other, and any mismatch permanently "loses" the
// token. That's why this deliberately avoids screen.* (doesn't exist at all
// in a service worker — would throw) and navigator.deviceMemory (spec-only
// extends Window's Navigator, not WorkerNavigator — would be undefined in
// one context and a number in the other). navigator.userAgentData is safe:
// the User-Agent Client Hints spec defines it on both Navigator and
// WorkerNavigator, and its high-entropy values (CPU architecture, bitness,
// OS version) are genuinely hardware-specific rather than just
// software/locale signals.
async function getDeviceFingerprint() {
  const parts = [
    navigator.userAgent,
    navigator.platform || '',
    navigator.language || '',
    navigator.hardwareConcurrency || '',
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    chrome.runtime.id,
  ];

  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const hints = await navigator.userAgentData.getHighEntropyValues([
        'architecture',
        'bitness',
        'model',
        'platformVersion',
      ]);
      parts.push(
        hints.architecture || '',
        hints.bitness || '',
        hints.model || '',
        hints.platformVersion || ''
      );
    }
  } catch {
    // Unsupported/blocked on this Chrome build — fine, just less entropy;
    // both contexts run the same build, so this stays consistent either way.
  }

  return parts.join('|');
}

async function deriveWrappingKey(saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(await getDeviceFingerprint()),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function getOrCreateKekSalt() {
  const stored = await chrome.storage.local.get(KEK_SALT_STORAGE);
  if (stored[KEK_SALT_STORAGE]) return base64ToBytes(stored[KEK_SALT_STORAGE]);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  await chrome.storage.local.set({ [KEK_SALT_STORAGE]: bytesToBase64(salt) });
  return salt;
}

let cachedDataKey = null; // memoized for this popup session / service-worker wake-up

async function getOrCreateDataKey() {
  if (cachedDataKey) return cachedDataKey;

  const saltBytes = await getOrCreateKekSalt();
  const wrappingKey = await deriveWrappingKey(saltBytes);

  const { [WRAPPED_DATA_KEY_STORAGE]: wrapped } = await chrome.storage.local.get(
    WRAPPED_DATA_KEY_STORAGE
  );

  if (wrapped) {
    const rawKey = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(wrapped.iv) },
      wrappingKey,
      base64ToBytes(wrapped.data)
    );
    cachedDataKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    return cachedDataKey;
  }

  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const rawKey = await crypto.subtle.exportKey('raw', dataKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey);
  await chrome.storage.local.set({
    [WRAPPED_DATA_KEY_STORAGE]: {
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(wrappedKey)),
    },
  });
  await refreshDecoyKeys();

  cachedDataKey = dataKey;
  return dataKey;
}

async function encryptToken(token) {
  if (!token) return null;
  const key = await getOrCreateDataKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token)
  );
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decryptToken(encrypted) {
  if (!encrypted) return '';
  try {
    const key = await getOrCreateDataKey();
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(encrypted.iv) },
      key,
      base64ToBytes(encrypted.data)
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    return ''; // corrupt ciphertext or fingerprint mismatch — treat as "no token"
  }
}

// ---------------------------------------------------------------------------
// PIN-lock (mandatory — see popup.js's pin-setup screen, shown right after
// the first token save and on any state that somehow lacks one). Everything
// below is self-contained on purpose, deliberately bypassing
// getOrCreateDataKey()'s caching/create-if-missing logic above — that logic
// is tuned for the unattended fingerprint-only path used before a PIN
// exists. These functions only run from explicit user action in the popup
// (initial setup, unlock, change PIN) and always mint or unwrap a key for
// one specific PIN, so mixing the two would risk the wrong key getting
// cached.
// ---------------------------------------------------------------------------

async function deriveWrappingKeyWithPin(saltBytes, pin) {
  const material = `${await getDeviceFingerprint()}::pin::${pin}`;
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(material),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Tries to unwrap the data key with this PIN and decrypt the stored token.
// Only the now-unwrapped raw data key is cached into session storage for
// the rest of this browser session — the plaintext token itself is never
// written anywhere, not even there; it's returned once here and otherwise
// re-derived on demand via decryptTokenWithSessionKey(). Returns null on a
// wrong PIN or if there's nothing to unlock yet; returns '' (not null) for
// a *correct* PIN when there's simply no token saved — that's a valid
// unlock, just of an empty state, and must stay distinguishable from a
// wrong password so a cleared token can never permanently strand someone
// behind the lock screen.
async function attemptUnlock(pin) {
  const stored = await chrome.storage.local.get([WRAPPED_DATA_KEY_STORAGE, 'tokenEncrypted', KEK_SALT_STORAGE]);
  const wrapped = stored[WRAPPED_DATA_KEY_STORAGE];
  if (!wrapped || !stored[KEK_SALT_STORAGE]) return null;

  const saltBytes = base64ToBytes(stored[KEK_SALT_STORAGE]);
  const wrappingKey = await deriveWrappingKeyWithPin(saltBytes, pin);

  let rawKeyBuf;
  try {
    rawKeyBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(wrapped.iv) },
      wrappingKey,
      base64ToBytes(wrapped.data)
    );
  } catch {
    return null; // wrong PIN — the auth tag just doesn't verify
  }

  await chrome.storage.session.set({
    unlockedDataKeyRaw: bytesToBase64(new Uint8Array(rawKeyBuf)),
  });

  if (!stored.tokenEncrypted) return '';

  const dataKey = await crypto.subtle.importKey('raw', rawKeyBuf, 'AES-GCM', false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(stored.tokenEncrypted.iv) },
    dataKey,
    base64ToBytes(stored.tokenEncrypted.data)
  );
  return new TextDecoder().decode(plainBuf);
}

// Mints a brand-new data key wrapped under this PIN, then re-encrypts
// `token` under it — used for both first-time setup (often with an empty
// token, since the password is created before GitLab is even configured)
// and changing an existing password. Used by Settings → Security and the
// mandatory setup screen, never by the background poller (which has no way
// to ask for a PIN).
async function rewrapWithPin(token, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await chrome.storage.local.set({ [KEK_SALT_STORAGE]: bytesToBase64(salt) });

  const wrappingKey = await deriveWrappingKeyWithPin(salt, pin);
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const rawKey = await crypto.subtle.exportKey('raw', dataKey);

  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrappingKey, rawKey);
  await chrome.storage.local.set({
    [WRAPPED_DATA_KEY_STORAGE]: {
      iv: bytesToBase64(wrapIv),
      data: bytesToBase64(new Uint8Array(wrappedKey)),
    },
  });
  await refreshDecoyKeys();

  let tokenEncrypted = null;
  if (token) {
    const tokenIv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: tokenIv },
      dataKey,
      new TextEncoder().encode(token)
    );
    tokenEncrypted = { iv: bytesToBase64(tokenIv), data: bytesToBase64(new Uint8Array(ciphertext)) };
  }
  await chrome.storage.local.set({ tokenEncrypted, pinLockEnabled: true });

  await chrome.storage.session.set({
    // exportKey() returns a plain ArrayBuffer, not a Uint8Array — has to be
    // wrapped before bytesToBase64() can .forEach() over it.
    unlockedDataKeyRaw: bytesToBase64(new Uint8Array(rawKey)),
  });

  // Changing the password mints a brand-new data key — if biometric unlock
  // was already enrolled, its wrapped copy pointed at the *old* data key
  // and would now decrypt to garbage. Re-wrap it under the same new key so
  // both unlock methods keep working. This does trigger a second biometric
  // prompt right after setting the password — that's the cost of keeping
  // it in sync rather than silently breaking it.
  const { [BIOMETRIC_CREDENTIAL_ID_STORAGE]: credentialId } = await chrome.storage.local.get(
    BIOMETRIC_CREDENTIAL_ID_STORAGE
  );
  if (credentialId) {
    await wrapDataKeyForBiometric(rawKey);
  }
}

// Whether this browser session has unlocked at all — independent of
// whether a token has actually been saved yet. Needed because "password
// set, session unlocked, no token yet" (mid-onboarding) must not show the
// lock screen again, while "password set, session NOT unlocked" (after a
// Chrome restart) must.
async function isSessionUnlocked() {
  const { unlockedDataKeyRaw } = await chrome.storage.session.get('unlockedDataKeyRaw');
  return Boolean(unlockedDataKeyRaw);
}

// Re-encrypts the token using the raw data key this session already
// unwrapped via attemptUnlock() — no PIN re-entry needed for an ordinary
// token edit while unlocked. Returns false if this session was never
// unlocked (nothing cached to re-encrypt with).
async function reencryptTokenWithSessionKey(token) {
  const { unlockedDataKeyRaw } = await chrome.storage.session.get('unlockedDataKeyRaw');
  if (!unlockedDataKeyRaw) return false;

  const dataKey = await crypto.subtle.importKey('raw', base64ToBytes(unlockedDataKeyRaw), 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dataKey,
    new TextEncoder().encode(token || '')
  );
  await chrome.storage.local.set({
    tokenEncrypted: token ? { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) } : null,
  });
  return true;
}

// The read counterpart of reencryptTokenWithSessionKey(): decrypts
// tokenEncrypted using only the raw data key already cached in session
// storage. This is what lets the plaintext token stay out of storage
// entirely while PIN-lock is on — only this AES key sits in session
// memory; the token itself is derived fresh every time it's needed and
// never written back anywhere.
async function decryptTokenWithSessionKey() {
  const { unlockedDataKeyRaw } = await chrome.storage.session.get('unlockedDataKeyRaw');
  if (!unlockedDataKeyRaw) return '';

  const { tokenEncrypted } = await chrome.storage.local.get('tokenEncrypted');
  if (!tokenEncrypted) return '';

  try {
    const dataKey = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(unlockedDataKeyRaw),
      'AES-GCM',
      false,
      ['decrypt']
    );
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(tokenEncrypted.iv) },
      dataKey,
      base64ToBytes(tokenEncrypted.data)
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Biometric unlock (Touch ID / Windows Hello), via WebAuthn's PRF extension
// — an *additional* unlock method on top of the mandatory password, never a
// replacement for it. The password remains the durable fallback (a
// different device, a browser without a platform authenticator, PRF
// support that varies by OS/Chrome version). Only usable from the popup —
// navigator.credentials doesn't exist in the service worker, so the
// background poller only ever reads whatever a popup unlock already cached
// in chrome.storage.session, exactly as with the password.
//
// PRF gives a *stable, high-entropy secret* tied to (credential, salt),
// computed inside the authenticator's secure hardware — unlike a plain
// WebAuthn assertion (which only proves "the user verified", not usable as
// key material). It's imported directly as an AES-GCM key (no PBKDF2
// needed — it's already 32 bytes of real entropy, not a guessable
// password) and wraps its own copy of the SAME data key the password
// wraps, so either method decrypts the identical token.
// ---------------------------------------------------------------------------

async function isBiometricSupported() {
  return Boolean(
    window.PublicKeyCredential &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.())
  );
}

async function isBiometricEnrolled() {
  const { [BIOMETRIC_CREDENTIAL_ID_STORAGE]: credentialId } = await chrome.storage.local.get(
    BIOMETRIC_CREDENTIAL_ID_STORAGE
  );
  return Boolean(credentialId);
}

async function getPrfSecret(credentialIdB64) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: base64ToBytes(credentialIdB64), type: 'public-key' }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_EVAL_SALT } } },
      timeout: 60000,
    },
  });
  const prfOutput = assertion.getClientExtensionResults().prf?.results?.first;
  if (!prfOutput) throw new Error('Biometric unlock is not usable — no PRF result returned.');
  return new Uint8Array(prfOutput);
}

function deriveBiometricWrappingKey(prfSecretBytes) {
  return crypto.subtle.importKey('raw', prfSecretBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function wrapDataKeyForBiometric(rawDataKeyBytes) {
  const { [BIOMETRIC_CREDENTIAL_ID_STORAGE]: credentialIdB64 } = await chrome.storage.local.get(
    BIOMETRIC_CREDENTIAL_ID_STORAGE
  );
  const prfSecret = await getPrfSecret(credentialIdB64);
  const wrappingKey = await deriveBiometricWrappingKey(prfSecret);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawDataKeyBytes);
  await chrome.storage.local.set({
    [WRAPPED_DATA_KEY_BIOMETRIC_STORAGE]: {
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(wrapped)),
    },
  });
}

// Creates the platform credential and wraps this session's already-unlocked
// data key under it. Throws if PRF isn't supported (feature-detected via
// getClientExtensionResults().prf.enabled) or if this session isn't
// unlocked yet (nothing to wrap).
async function enrollBiometric() {
  const { unlockedDataKeyRaw } = await chrome.storage.session.get('unlockedDataKeyRaw');
  if (!unlockedDataKeyRaw) {
    throw new Error('Unlock with your password before enrolling biometric unlock.');
  }

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'GitLab MR Dashboard' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'gitlab-mr-dashboard',
        displayName: 'GitLab MR Dashboard',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
      },
      extensions: { prf: {} },
      timeout: 60000,
    },
  });

  if (!credential.getClientExtensionResults().prf?.enabled) {
    throw new Error(
      'This browser/device does not support biometric unlock (no PRF extension) — use the password instead.'
    );
  }

  await chrome.storage.local.set({
    [BIOMETRIC_CREDENTIAL_ID_STORAGE]: bytesToBase64(new Uint8Array(credential.rawId)),
  });

  await wrapDataKeyForBiometric(base64ToBytes(unlockedDataKeyRaw));
}

async function removeBiometric() {
  await chrome.storage.local.remove([
    BIOMETRIC_CREDENTIAL_ID_STORAGE,
    WRAPPED_DATA_KEY_BIOMETRIC_STORAGE,
  ]);
}

// Mirrors attemptUnlock(pin), but via a Touch ID/Windows Hello prompt
// instead of a typed password. Returns null if biometric isn't enrolled,
// the prompt fails/is cancelled, or the PRF secret no longer unwraps
// anything (e.g. the credential was reset on the OS side).
async function attemptUnlockWithBiometric() {
  const stored = await chrome.storage.local.get([
    BIOMETRIC_CREDENTIAL_ID_STORAGE,
    WRAPPED_DATA_KEY_BIOMETRIC_STORAGE,
    'tokenEncrypted',
  ]);
  const credentialIdB64 = stored[BIOMETRIC_CREDENTIAL_ID_STORAGE];
  const wrapped = stored[WRAPPED_DATA_KEY_BIOMETRIC_STORAGE];
  if (!credentialIdB64 || !wrapped || !stored.tokenEncrypted) return null;

  let rawKeyBuf;
  try {
    const prfSecret = await getPrfSecret(credentialIdB64);
    const wrappingKey = await deriveBiometricWrappingKey(prfSecret);
    rawKeyBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(wrapped.iv) },
      wrappingKey,
      base64ToBytes(wrapped.data)
    );
  } catch {
    return null; // cancelled, failed, or the PRF output no longer matches
  }

  const dataKey = await crypto.subtle.importKey('raw', rawKeyBuf, 'AES-GCM', false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(stored.tokenEncrypted.iv) },
    dataKey,
    base64ToBytes(stored.tokenEncrypted.data)
  );
  const token = new TextDecoder().decode(plainBuf);

  await chrome.storage.session.set({
    unlockedDataKeyRaw: bytesToBase64(new Uint8Array(rawKeyBuf)),
  });

  return token;
}

// See DECOY_STORAGE_KEYS above — random noise shaped like real
// {iv, ciphertext} blobs, regenerated whenever real key material is
// (re)created. Obfuscation only; never read back by anything.
async function refreshDecoyKeys() {
  const decoys = {};
  for (const key of DECOY_STORAGE_KEYS) {
    decoys[key] = {
      iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
      data: bytesToBase64(crypto.getRandomValues(new Uint8Array(48))),
    };
  }
  await chrome.storage.local.set(decoys);
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// GitLab API access
// ---------------------------------------------------------------------------

async function gitlabFetch(baseUrl, token, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${baseUrl}/api/v4${path}`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`GitLab API timed out after ${REQUEST_TIMEOUT_MS}ms: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After');
    throw new Error(
      `GitLab API rate limit hit${retryAfter ? ` — retry after ${retryAfter}s` : ''}: ${path}`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitLab API ${res.status}: ${path} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAllPages(baseUrl, token, path) {
  const results = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}per_page=100&page=${page}`;
    const chunk = await gitlabFetch(baseUrl, token, url);
    results.push(...chunk);
    if (chunk.length < 100) break;
    page += 1;
    if (page > 20) break;
  }
  return results;
}

// Runs `fn` over `items` with at most `limit` in flight at once — protects
// against hitting GitLab's rate limit when a project has many open MRs and
// every one needs 2-3 follow-up requests (approvals, commit, discussions).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// MR status helpers
// ---------------------------------------------------------------------------

function isPipelineFailed(mr) {
  return Boolean(mr.pipeline && mr.pipeline.status === 'failed');
}

function hasMergeConflicts(mr) {
  return Boolean(mr.has_conflicts === true || mr.merge_status === 'cannot_be_merged');
}

function isDraft(mr) {
  return Boolean(
    mr.draft === true ||
      mr.work_in_progress === true ||
      /^\s*(draft|wip)\s*:/i.test(mr.title || '')
  );
}

// No comments and no approvals yet — nobody has looked at it at all. Drafts
// are excluded: they aren't meant to be reviewed until marked ready.
function isUntouched(mr, approvedByCount, draft) {
  return !draft && mr.user_notes_count === 0 && approvedByCount === 0;
}

// A discussion is unresolved if it's a real thread (not a standalone note)
// and at least one of its resolvable notes hasn't been resolved yet.
function countUnresolvedDiscussions(discussions) {
  if (!Array.isArray(discussions)) return 0;
  return discussions.filter(
    (discussion) =>
      !discussion.individual_note &&
      (discussion.notes || []).some((note) => note.resolvable && !note.resolved)
  ).length;
}

// `mr.labels` is an array of plain strings by default, or of
// {name, color, text_color} objects when fetched with with_labels_details=true.
function normalizeLabels(mr) {
  if (!Array.isArray(mr.labels)) return [];
  return mr.labels.map((label) =>
    typeof label === 'string'
      ? { name: label, color: '#5c5c5c', textColor: '#ffffff' }
      : {
          name: label.name,
          color: label.color || '#5c5c5c',
          textColor: label.text_color || '#ffffff',
        }
  );
}

function resolveAvatarUrl(baseUrl, avatarUrl) {
  if (!avatarUrl) return null;
  return /^https?:\/\//i.test(avatarUrl) ? avatarUrl : `${baseUrl}${avatarUrl}`;
}

async function resolveUsername(baseUrl, token, settings) {
  if (settings.username) return settings.username;
  const me = await gitlabFetch(baseUrl, token, '/user');
  return me.username;
}

// Everything about one MR that needs a follow-up request beyond the
// merge_requests list payload: approval state, the head commit's date, and
// unresolved discussion count.
async function fetchMrDetails(baseUrl, token, encodedProject, mr) {
  const [approvals, commit, discussions] = await Promise.all([
    gitlabFetch(
      baseUrl,
      token,
      `/projects/${encodedProject}/merge_requests/${mr.iid}/approvals`
    ).catch(() => null),
    mr.sha
      ? gitlabFetch(
          baseUrl,
          token,
          `/projects/${encodedProject}/repository/commits/${mr.sha}`
        ).catch(() => null)
      : Promise.resolve(null),
    gitlabFetch(
      baseUrl,
      token,
      `/projects/${encodedProject}/merge_requests/${mr.iid}/discussions?per_page=100`
    ).catch(() => null),
  ]);

  return {
    approved: Boolean(approvals && approvals.approved),
    approvedBy:
      approvals && Array.isArray(approvals.approved_by)
        ? approvals.approved_by
            .map((entry) => entry.user)
            .filter(Boolean)
            .map((user) => ({ username: user.username, name: user.name }))
        : [],
    approvalsRequired:
      approvals && typeof approvals.approvals_required === 'number'
        ? approvals.approvals_required
        : 0,
    lastCommitAt: commit ? commit.committed_date || commit.created_at : null,
    unresolvedThreads: countUnresolvedDiscussions(discussions),
  };
}

// Counts open MRs where `username` is a requested reviewer (and not the
// author) and hasn't approved yet.
async function countPendingReviews(baseUrl, token, projectPath, username) {
  const encodedProject = encodeURIComponent(projectPath);
  const reviewMrs = await fetchAllPages(
    baseUrl,
    token,
    `/projects/${encodedProject}/merge_requests?state=opened&reviewer_username=${encodeURIComponent(
      username
    )}`
  );
  const candidates = reviewMrs.filter((mr) => (mr.author && mr.author.username) !== username);

  const results = await mapWithConcurrency(candidates, DETAIL_FETCH_CONCURRENCY, async (mr) => {
    try {
      const approvals = await gitlabFetch(
        baseUrl,
        token,
        `/projects/${encodedProject}/merge_requests/${mr.iid}/approvals`
      );
      return (approvals.approved_by || []).some(
        (entry) => entry.user && entry.user.username === username
      )
        ? 0
        : 1;
    } catch {
      return 0; // Skip MRs whose approval state we can't read.
    }
  });

  return results.reduce((sum, value) => sum + value, 0);
}

// Counts open, non-draft MRs that are blocked on nothing but an approval:
// no unresolved discussion threads, and fewer approvals than the rule
// requires. Doesn't matter whose approval — GitLab only counts a total.
async function countNeedsReview(baseUrl, token, projectPath) {
  const encodedProject = encodeURIComponent(projectPath);
  const openMrs = await fetchAllPages(
    baseUrl,
    token,
    `/projects/${encodedProject}/merge_requests?state=opened`
  );
  const candidates = openMrs.filter((mr) => !isDraft(mr));

  const results = await mapWithConcurrency(candidates, DETAIL_FETCH_CONCURRENCY, async (mr) => {
    try {
      const [approvals, discussions] = await Promise.all([
        gitlabFetch(
          baseUrl,
          token,
          `/projects/${encodedProject}/merge_requests/${mr.iid}/approvals`
        ),
        gitlabFetch(
          baseUrl,
          token,
          `/projects/${encodedProject}/merge_requests/${mr.iid}/discussions?per_page=100`
        ).catch(() => []),
      ]);
      const approvedCount = (approvals.approved_by || []).length;
      const approvalsRequired = approvals.approvals_required || 0;
      const unresolvedThreads = countUnresolvedDiscussions(discussions);
      return unresolvedThreads === 0 && approvedCount < approvalsRequired ? 1 : 0;
    } catch {
      return 0; // Skip MRs whose state we can't read.
    }
  });

  return results.reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// Toolbar badge — a single global indicator aggregated across every
// configured repo (see background.js). Priority: MRs waiting on your own
// review (red) beat the project-wide needs-review count (amber) beat empty.
// Polling errors are handled separately via setErrorBadge/clearErrorBadge.
// ---------------------------------------------------------------------------

function refreshBadge({ myReviewCount = 0, needsReviewCount = 0 } = {}) {
  if (myReviewCount > 0) {
    chrome.action.setBadgeText({ text: String(myReviewCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return;
  }
  chrome.action.setBadgeText({ text: needsReviewCount > 0 ? String(needsReviewCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
}

function setErrorBadge(message) {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  chrome.action.setTitle({
    title: `GitLab MR Dashboard — polling error: ${message}`,
  });
}

function clearErrorBadge() {
  chrome.action.setTitle({ title: 'GitLab MR Dashboard' });
}

function setLockedBadge() {
  chrome.action.setBadgeText({ text: '🔒' });
  chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  chrome.action.setTitle({
    title: 'GitLab MR Dashboard — locked, open the popup to unlock (password or Touch ID)',
  });
}
