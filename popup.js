// All config field IDs — used to save/restore form values
const FIELDS = ['siteUrl','useCurrentTab','itemName','itemSku','searchType','quantity','maxPrice','refreshInterval',
                'firstName','lastName','email','address','city','state','zip',
                'cardNumber','cardName','expiry','cvv','stopOnSuccess'];

let activeProfile = 'sams';
let cryptoKey = null;     // AES-GCM key derived from the PIN (in memory only, never stored)
let lockMode  = 'unlock'; // 'unlock' (PIN exists) or 'create' (first-time PIN setup)

// Per-store navigation (the popup needs the URLs; content.js has the selectors).
const STORE_NAV = {
  sams:          { name: "Sam's Bot",      search: q => 'https://www.samsclub.com/s/' + encodeURIComponent(q),               item: id => 'https://www.samsclub.com/ip/' + encodeURIComponent(id) },
  target:        { name: 'Target Bot',     search: q => 'https://www.target.com/s?searchTerm=' + encodeURIComponent(q),       item: id => 'https://www.target.com/p/-/A-' + encodeURIComponent(id) },
  walmart:       { name: 'Walmart Bot',    search: q => 'https://www.walmart.com/search?q=' + encodeURIComponent(q),          item: id => 'https://www.walmart.com/ip/' + encodeURIComponent(id) },
  bestbuy:       { name: 'Best Buy Bot',   search: q => 'https://www.bestbuy.com/site/searchpage.jsp?st=' + encodeURIComponent(q), item: id => 'https://www.bestbuy.com/site/x/x/' + encodeURIComponent(id) + '.p?skuId=' + encodeURIComponent(id) },
  pokemoncenter: { name: 'Pokémon Bot',    search: q => 'https://www.pokemoncenter.com/search/' + encodeURIComponent(q),      item: id => 'https://www.pokemoncenter.com/product/' + encodeURIComponent(id) },
};
const profileLabel = (p) => (STORE_NAV[p] && STORE_NAV[p].name) || 'Bot';

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers — AES-256-GCM with a PBKDF2 key derived from the 6-digit PIN.
// The PIN and key are never written to disk; only encrypted blobs + a salt are.
// ─────────────────────────────────────────────────────────────────────────────
const b64  = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const ub64 = (str)   => Uint8Array.from(atob(str), c => c.charCodeAt(0));

async function deriveKey(pin, saltBytes) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 250000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true /* extractable, to cache in session */, ['encrypt', 'decrypt']);
}

// ── 2-hour unlock window ───────────────────────────────────────────────────────
// Cache the key with an expiry so reopening the panel (or reloading the extension)
// within 2 hours skips the PIN. Stored in local so it survives a reset; auto-deleted
// when it expires. (Tradeoff: the key sits cached for up to 2h — bounded exposure.)
const UNLOCK_HOURS = 2;
async function cacheKey() {
  try {
    const raw = await crypto.subtle.exportKey('raw', cryptoKey);
    await chrome.storage.local.set({ keyCache: { keyB64: b64(raw), exp: Date.now() + UNLOCK_HOURS * 3600 * 1000 } });
  } catch (_) {}
}
async function tryRestoreKey() {
  try {
    const { keyCache } = await chrome.storage.local.get('keyCache');
    if (!keyCache) return false;
    if (Date.now() > keyCache.exp) { await chrome.storage.local.remove('keyCache'); return false; }
    cryptoKey = await crypto.subtle.importKey('raw', ub64(keyCache.keyB64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    return true;
  } catch (_) { return false; }
}
async function encryptObj(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decryptObj(key, blob) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(blob.iv) }, key, ub64(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ── Form <-> object helpers ────────────────────────────────────────────────────
function readForm() {
  const cfg = {};
  FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    cfg[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return cfg;
}
function writeForm(cfg) {
  FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = cfg[id] ?? (id === 'stopOnSuccess');
    else el.value = cfg[id] ?? '';
  });
  const type = cfg.searchType || 'name';
  document.querySelectorAll('.search-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.getElementById('nameGroup').style.display = type === 'name' ? '' : 'none';
  document.getElementById('skuGroup').style.display  = type === 'sku'  ? '' : 'none';
}
function clearForm() {
  writeForm({ siteUrl: 'http://localhost:3000', quantity: '1', maxPrice: '999', refreshInterval: '2',
              stopOnSuccess: true, useCurrentTab: false, searchType: 'name' });
}

// ── PIN lock overlay ───────────────────────────────────────────────────────────
let lockTimer = null; // countdown interval while locked out

function showLock(mode) {
  lockMode = mode;
  document.getElementById('lockOverlay').style.display = 'flex';
  document.getElementById('lockError').textContent = '';
  document.getElementById('pinInput').value = '';
  document.getElementById('pinConfirm').value = '';
  document.getElementById('pinInput').disabled = false;   // re-enable in case a prior lockout disabled it
  document.getElementById('unlockBtn').disabled = false;
  const confirmEl = document.getElementById('pinConfirm');
  if (mode === 'create') {
    document.getElementById('lockTitle').textContent = 'Create a PIN';
    document.getElementById('lockSub').textContent = 'Choose a 6-digit PIN to encrypt your saved data';
    confirmEl.style.display = '';
    document.getElementById('unlockBtn').textContent = 'Set PIN';
  } else {
    document.getElementById('lockTitle').textContent = 'Enter PIN';
    document.getElementById('lockSub').textContent = 'Enter your 6-digit PIN to unlock saved data';
    confirmEl.style.display = 'none';
    document.getElementById('unlockBtn').textContent = 'Unlock';
  }
  setTimeout(() => document.getElementById('pinInput').focus(), 50);
}
function hideLock() { document.getElementById('lockOverlay').style.display = 'none'; }

// Format milliseconds as M:SS
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Disable PIN entry and show a live countdown until `until` (ms timestamp)
function showLockedCountdown(until) {
  const inp = document.getElementById('pinInput');
  const btn = document.getElementById('unlockBtn');
  const err = document.getElementById('lockError');
  const sub = document.getElementById('lockSub');
  inp.disabled = true; btn.disabled = true; inp.value = '';
  document.getElementById('lockTitle').textContent = 'Locked';
  sub.textContent = 'Too many wrong attempts';
  if (lockTimer) clearInterval(lockTimer);
  const tick = () => {
    const rem = until - Date.now();
    if (rem <= 0) {
      clearInterval(lockTimer); lockTimer = null;
      inp.disabled = false; btn.disabled = false;
      document.getElementById('lockTitle').textContent = 'Enter PIN';
      sub.textContent = 'Enter your 6-digit PIN to unlock saved data';
      err.textContent = '';
      inp.focus();
      return;
    }
    err.textContent = 'Locked — try again in ' + fmtCountdown(rem);
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

document.getElementById('unlockBtn').addEventListener('click', handlePin);
document.getElementById('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') handlePin(); });
document.getElementById('pinConfirm').addEventListener('keydown', e => { if (e.key === 'Enter') handlePin(); });

// Auto-submit: digits-only, and act the moment the 6th digit is entered
document.getElementById('pinInput').addEventListener('input', function () {
  this.value = this.value.replace(/\D/g, '').slice(0, 6); // numbers only
  if (this.value.length === 6) {
    if (lockMode === 'create') document.getElementById('pinConfirm').focus(); // go confirm the PIN
    else handlePin();                                                          // unlock immediately
  }
});
document.getElementById('pinConfirm').addEventListener('input', function () {
  this.value = this.value.replace(/\D/g, '').slice(0, 6);
  if (this.value.length === 6) handlePin(); // both 6 digits — create the PIN
});

async function handlePin() {
  const pin = document.getElementById('pinInput').value;
  const err = document.getElementById('lockError');
  if (!/^\d{6}$/.test(pin)) { err.textContent = 'PIN must be exactly 6 digits'; return; }

  if (lockMode === 'create') {
    const confirm = document.getElementById('pinConfirm').value;
    if (pin !== confirm) { err.textContent = 'PINs do not match'; return; }
    // Generate salt, derive key, store a check token + clear any old plaintext configs
    const salt = crypto.getRandomValues(new Uint8Array(16));
    cryptoKey = await deriveKey(pin, salt);
    const check = await encryptObj(cryptoKey, { v: 'VALID' });
    await chrome.storage.local.set({ pinSalt: b64(salt), pinCheck: check });
    // Remove any legacy plaintext configs from before encryption existed
    await chrome.storage.local.remove(['botConfig', 'botConfig_default', 'botConfig_sams']);
    await cacheKey(); // start the 2-hour unlock window
    hideLock();
    await saveProfileConfig(activeProfile); // persist current form encrypted
    addLog('success', 'PIN set — saved data is now encrypted');
  } else {
    // Unlock — enforce escalating lockout after repeated wrong PINs
    const { pinSalt, pinCheck, pinFails = 0, pinLockUntil = 0 } =
      await chrome.storage.local.get(['pinSalt', 'pinCheck', 'pinFails', 'pinLockUntil']);

    // Currently locked out? Block and show the countdown.
    if (pinLockUntil && Date.now() < pinLockUntil) { showLockedCountdown(pinLockUntil); return; }

    try {
      const key = await deriveKey(pin, ub64(pinSalt));
      const v = await decryptObj(key, pinCheck);
      if (v.v !== 'VALID') throw new Error('bad');
      // Correct — clear the failure counter and unlock
      cryptoKey = key;
      await chrome.storage.local.set({ pinFails: 0, pinLockUntil: 0 });
      await cacheKey(); // start the 2-hour unlock window
      hideLock();
      await loadProfileConfig(activeProfile);
      addLog('success', 'Unlocked (stays unlocked ' + UNLOCK_HOURS + 'h)');
    } catch (_) {
      // Wrong PIN — 3 free attempts, then lock 5 min and double each lockout after (5,10,20…)
      const fails = pinFails + 1;
      let lockUntil = 0;
      if (fails >= 4) {
        const mins = 5 * Math.pow(2, fails - 4); // fail 4→5, 5→10, 6→20, ...
        lockUntil = Date.now() + mins * 60 * 1000;
      }
      await chrome.storage.local.set({ pinFails: fails, pinLockUntil: lockUntil });
      const inp = document.getElementById('pinInput');
      inp.value = ''; inp.focus();
      if (lockUntil) {
        showLockedCountdown(lockUntil);
      } else {
        const left = 3 - fails;
        err.textContent = left > 0
          ? 'Wrong PIN — ' + left + ' attempt' + (left > 1 ? 's' : '') + ' before lockout'
          : 'Wrong PIN — next wrong attempt locks for 5 min';
      }
    }
  }
}

// Address + payment are SHARED across all stores; everything else is per-store.
const SHARED_FIELDS  = ['firstName', 'lastName', 'email', 'address', 'city', 'state', 'zip',
                        'cardNumber', 'cardName', 'expiry', 'cvv'];
const PROFILE_FIELDS = FIELDS.filter(f => !SHARED_FIELDS.includes(f));

// ── Encrypted save/load (per-store item settings + one shared address/payment) ──
async function saveProfileConfig(profile) {
  if (!cryptoKey) return; // locked / no PIN yet
  const all = readForm();
  const profileCfg = {}; PROFILE_FIELDS.forEach(k => profileCfg[k] = all[k]);
  const sharedCfg  = {}; SHARED_FIELDS.forEach(k  => sharedCfg[k]  = all[k]);
  await chrome.storage.local.set({
    ['botConfigEnc_' + profile]: await encryptObj(cryptoKey, profileCfg),
    botConfigShared:             await encryptObj(cryptoKey, sharedCfg),
  });
}
async function loadProfileConfig(profile) {
  if (!cryptoKey) return;
  const data = await chrome.storage.local.get(['botConfigEnc_' + profile, 'botConfigShared']);
  // Start from sensible defaults so a brand-new store isn't blank
  const cfg = { siteUrl: 'http://localhost:3000', quantity: '1', maxPrice: '999',
                refreshInterval: '2', stopOnSuccess: true, useCurrentTab: false, searchType: 'name' };
  // Per-store item settings (older configs also carried address/payment — kept for migration)
  if (data['botConfigEnc_' + profile]) {
    try { Object.assign(cfg, await decryptObj(cryptoKey, data['botConfigEnc_' + profile])); } catch (_) {}
  }
  // Shared address/payment overlays on top (fill once, applies to every store)
  if (data.botConfigShared) {
    try { Object.assign(cfg, await decryptObj(cryptoKey, data.botConfigShared)); } catch (_) {}
  } else if (cfg.cardNumber || cfg.address) {
    // First run after the shared-config change: publish the address/payment we found
    // (from an older per-store config) into the shared blob so every store inherits it.
    const sharedCfg = {}; SHARED_FIELDS.forEach(k => sharedCfg[k] = cfg[k]);
    await chrome.storage.local.set({ botConfigShared: await encryptObj(cryptoKey, sharedCfg) });
  }
  writeForm(cfg);
}

// ── Profile switcher (top tabs) ────────────────────────────────────────────────
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    if (tab.dataset.profile === activeProfile) return;
    await saveProfileConfig(activeProfile);
    activeProfile = tab.dataset.profile;
    chrome.storage.local.set({ lastProfile: activeProfile }); // reopen on this store next time
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    await loadProfileConfig(activeProfile);
    updateStartLabel();
    addLog('info', 'Switched to ' + profileLabel(activeProfile));
  });
});

// ── Sub-tab switching (Item / Address / Payment) ───────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

function updateStartLabel() {
  const btn     = document.getElementById('startBtn');
  const label   = profileLabel(activeProfile);
  const running = btn.classList.contains('running');
  btn.textContent = running ? ('⏹ Stop ' + label) : ('▶ Start ' + label);
}

// ── Search type toggle (By Name / By SKU) ─────────────────────────────────────
document.querySelectorAll('.search-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.search-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const type = btn.dataset.type;
    document.getElementById('searchType').value = type;
    document.getElementById('nameGroup').style.display = type === 'name' ? '' : 'none';
    document.getElementById('skuGroup').style.display  = type === 'sku'  ? '' : 'none';
  });
});

// ── Wire up buttons ────────────────────────────────────────────────────────────
document.getElementById('startBtn').addEventListener('click', () => toggleBot(false));
document.getElementById('testBtn').addEventListener('click', () => toggleBot(true));
document.getElementById('saveBtn').addEventListener('click', saveConfig);
document.getElementById('clearBtn').addEventListener('click', clearLog);
document.getElementById('closeBtn').addEventListener('click', () => window.close());

// Auto-format the card number into groups of 4 as you type (display only; the bot
// strips it back to digits when filling the store's field).
document.getElementById('cardNumber').addEventListener('input', function () {
  const digits = this.value.replace(/\D/g, '').slice(0, 16);
  this.value = digits.replace(/(.{4})/g, '$1 ').trim();
});
// Auto-format expiry as MM/YY
document.getElementById('expiry').addEventListener('input', function () {
  let v = this.value.replace(/\D/g, '').slice(0, 4);
  if (v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
  this.value = v;
});

// Stop the bot + wipe the temporary plaintext config when the sidebar is closed
window.addEventListener('unload', () => {
  chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
  chrome.storage.local.remove(['botConfig', 'burstUntil']);
  chrome.runtime.sendMessage({ type: 'STOP_BOT' }).catch(() => {});
});

// ── Live clock + timezone ──────────────────────────────────────────────────────
const TZ_ABBR = {
  'America/Chicago': 'CT', 'America/New_York': 'ET', 'America/Denver': 'MT',
  'America/Los_Angeles': 'PT', 'America/Phoenix': 'AZ', 'America/Anchorage': 'AK',
  'Pacific/Honolulu': 'HI', 'UTC': 'UTC'
};
const tzSelect  = document.getElementById('tzSelect');
const liveClock = document.getElementById('liveClock');

chrome.storage.local.get('clockTz', d => { if (d.clockTz && TZ_ABBR[d.clockTz]) tzSelect.value = d.clockTz; });
tzSelect.addEventListener('change', () => chrome.storage.local.set({ clockTz: tzSelect.value }));

function renderClock() {
  const tz = tzSelect.value;
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    liveClock.textContent = get('hour') + ':' + get('minute') + ':' + get('second') + '.' + ms + ' ' + get('dayPeriod') + ' ' + (TZ_ABBR[tz] || '');
  } catch (_) {
    liveClock.textContent = now.toTimeString().slice(0, 8) + '.' + ms;
  }
}
setInterval(renderClock, 47);
renderClock();

// ── Drop-time scheduler (auto-start at the drop) ───────────────────────────────
// Returns the timezone's UTC offset (ms) at a given moment
function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of dtf.formatToParts(date)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}
// Timestamp for today's HH:MM:SS in `tz` (rolls to tomorrow if already well past)
function dropTimestamp(tz, hh, mm, ss) {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {}; for (const x of dtf.formatToParts(now)) p[x.type] = x.value;
  let guess = Date.UTC(+p.year, +p.month - 1, +p.day, hh, mm, ss);
  guess -= tzOffsetMs(tz, new Date(guess));
  if (guess - Date.now() < -60000) guess += 86400000; // already passed >1min ago → next day's drop
  return guess;
}

let dropInterval = null;
const armBtn       = document.getElementById('armBtn');
const dropStatusEl = document.getElementById('dropStatus');

armBtn.addEventListener('click', () => {
  if (dropInterval) { // Disarm
    clearInterval(dropInterval); dropInterval = null;
    armBtn.textContent = 'Arm'; armBtn.classList.remove('armed');
    dropStatusEl.textContent = 'Disarmed.';
    return;
  }
  const v = document.getElementById('dropTime').value; // "HH:MM:SS" or "HH:MM"
  if (!v) { dropStatusEl.textContent = 'Set a drop time first.'; return; }
  const [hh, mm, ss = 0] = v.split(':').map(Number);
  const tz = tzSelect.value;
  const target = dropTimestamp(tz, hh, mm, ss);
  const leadMs = Math.max(0, parseInt(document.getElementById('leadSec').value || '3')) * 1000;
  const fireAt = target - leadMs; // start early

  armBtn.textContent = 'Disarm'; armBtn.classList.add('armed');
  if (!cryptoKey) addLog('warning', '⚠️ Armed — but unlock your PIN before the drop or it can\'t auto-start');

  dropInterval = setInterval(async () => {
    const remFire = fireAt - Date.now();
    if (remFire <= 0) {
      clearInterval(dropInterval); dropInterval = null;
      armBtn.textContent = 'Arm'; armBtn.classList.remove('armed');
      dropStatusEl.textContent = '🚀 Starting early — burst-polling for the drop!';
      const { botRunning } = await chrome.storage.local.get('botRunning');
      if (botRunning) return;
      if (!cryptoKey) { addLog('error', 'Drop fired but PIN is locked — unlock and Start manually'); return; }
      // Burst window: from the drop moment until 90s after, the bot reloads as fast as it
      // can to grab a spot the instant the item goes live; then it settles to normal pace.
      await chrome.storage.local.set({ burstUntil: target + 90000 });
      toggleBot(); // same as pressing Start
      return;
    }
    const s = Math.ceil(remFire / 1000);
    const h2 = String(Math.floor(s / 3600)).padStart(2, '0');
    const m2 = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const s2 = String(s % 60).padStart(2, '0');
    dropStatusEl.textContent = 'Starts in ' + h2 + ':' + m2 + ':' + s2 + ' (' + (leadMs / 1000) + 's early, ' + (TZ_ABBR[tz] || '') + ')';
  }, 50);
});

// ── Auto-detect item name/SKU from current tab ───────────────────────────────
document.getElementById('useCurrentTab').addEventListener('change', async function () {
  if (!this.checked) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const params = new URLSearchParams(window.location.search);
        if (params.get('id')) return { type: 'sku', value: params.get('id') };
        if (params.get('search')) return { type: 'name', value: params.get('search') };
        const name = (
          document.querySelector('h1')?.textContent?.trim() ||
          document.querySelector('[class*="product-title"]')?.textContent?.trim() ||
          document.querySelector('[class*="product-name"]')?.textContent?.trim() ||
          document.title.split('–')[0].split('|')[0].split('-')[0].trim()
        );
        return { type: 'name', value: name };
      }
    });
    const { type, value } = result?.result || {};
    if (!value) { addLog('warning', 'Could not detect item on this page'); return; }
    if (type === 'sku') {
      document.getElementById('itemSku').value = value;
      document.getElementById('searchType').value = 'sku';
      document.querySelectorAll('.search-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'sku'));
      document.getElementById('nameGroup').style.display = 'none';
      document.getElementById('skuGroup').style.display  = '';
    } else {
      document.getElementById('itemName').value = value;
      document.getElementById('searchType').value = 'name';
      document.querySelectorAll('.search-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'name'));
      document.getElementById('nameGroup').style.display = '';
      document.getElementById('skuGroup').style.display  = 'none';
    }
    addLog('info', 'Detected ' + type.toUpperCase() + ': "' + value + '"');
  } catch (e) {
    addLog('warning', 'Could not auto-detect item');
  }
});

// ── On popup open: restore last store, then unlock (cached key, or PIN) ─────────
(async () => {
  // 1) Reopen on the store you were last using
  const { lastProfile } = await chrome.storage.local.get('lastProfile');
  if (lastProfile && STORE_NAV[lastProfile]) {
    activeProfile = lastProfile;
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.profile === activeProfile));
  }

  const { pinSalt, botRunning, pinLockUntil = 0 } = await chrome.storage.local.get(['pinSalt', 'botRunning', 'pinLockUntil']);
  if (pinSalt) {
    // Within the 2-hour window? Skip the PIN using the cached key.
    if (await tryRestoreKey()) {
      await loadProfileConfig(activeProfile);
    } else {
      showLock('unlock');         // PIN expired/never entered — require it
      if (pinLockUntil && Date.now() < pinLockUntil) showLockedCountdown(pinLockUntil);
    }
  } else {
    // No PIN yet — migrate any legacy plaintext config so it carries over + gets encrypted.
    const legacy = await chrome.storage.local.get('botConfig_' + activeProfile);
    const cfg = legacy['botConfig_' + activeProfile];
    if (cfg) writeForm(cfg); else clearForm();
  }
  if (botRunning) setRunningUI(true);
  updateStartLabel();
})();

// ── Messages from content script ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'BOT_LOG')    addLog(msg.level, msg.text);
  if (msg.type === 'BOT_STATUS') setStatus(msg.status, msg.text);
  if (msg.type === 'BOT_QUEUE') {
    if (msg.state === 'in') startQueueTimer(msg.since, msg.info);
    else stopQueueTimer();
  }
  if (msg.type === 'BOT_CHECKOUT_TIMER') startCheckoutTimer(msg.remaining);
  if (msg.type === 'PLAY_SOUND') playSound(msg.kind);
  if (msg.type === 'BOT_DONE') {
    setRunningUI(false);
    stopQueueTimer(); stopCheckoutTimer();
    chrome.storage.local.remove(['botConfig', 'burstUntil', 'queueSince']); // wipe temp state
  }
});

// ── Queue / checkout timer displays ────────────────────────────────────────────
let queueTick = null, checkoutTick = null;
const mmss = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

function startQueueTimer(since, info) {
  const elapsed = document.getElementById('qElapsed');
  const est     = document.getElementById('qEst');
  elapsed.classList.add('active');
  est.textContent = (info && info.est) ? info.est : (info && info.pos) ? ('#' + info.pos) : 'in line';
  if (queueTick) clearInterval(queueTick);
  const tick = () => { elapsed.textContent = mmss(Math.max(0, Math.floor((Date.now() - since) / 1000))); };
  tick(); queueTick = setInterval(tick, 1000);
}
function stopQueueTimer() {
  if (queueTick) { clearInterval(queueTick); queueTick = null; }
  const elapsed = document.getElementById('qElapsed');
  elapsed.classList.remove('active'); elapsed.textContent = '—';
  document.getElementById('qEst').textContent = '—';
}
function startCheckoutTimer(remaining) {
  const parts = String(remaining).split(':').map(Number);
  let secs = parts.length === 2 ? parts[0] * 60 + parts[1] : parseInt(remaining);
  if (isNaN(secs)) return;
  const el = document.getElementById('qCheckout');
  if (checkoutTick) clearInterval(checkoutTick);
  const tick = () => {
    el.textContent = mmss(Math.max(0, secs));
    el.classList.toggle('warn', secs <= 60);
    if (secs <= 0) { clearInterval(checkoutTick); checkoutTick = null; return; }
    secs--;
  };
  tick(); checkoutTick = setInterval(tick, 1000);
}
function stopCheckoutTimer() {
  if (checkoutTick) { clearInterval(checkoutTick); checkoutTick = null; }
  const el = document.getElementById('qCheckout');
  el.classList.remove('warn'); el.textContent = '—';
}

// ── Alert sounds (Web Audio — no asset files needed) ───────────────────────────
let _audioCtx = null;
function playSound(kind) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const seqs = {
      success: [[660, 0], [880, 150], [1175, 300]],                 // pleasant rising chime
      captcha: [[1000, 0], [1000, 220], [1000, 440], [1000, 660]],  // urgent repeated beeps
      fail:    [[300, 0], [220, 220]],                              // low buzz
      stuck:   [[800, 0], [800, 200]],
    };
    const seq = seqs[kind] || seqs.stuck;
    for (const [f, t] of seq) tone(f, t, kind === 'captcha' ? 'square' : 'sine');
  } catch (_) {}
}
function tone(freq, startMs, type) {
  const ctx = _audioCtx;
  const t0 = ctx.currentTime + startMs / 1000;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  osc.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.17);
  osc.start(t0); osc.stop(t0 + 0.19);
}

// ── Save config (encrypted) ──────────────────────────────────────────────────
async function saveConfig() {
  if (!cryptoKey) { showLock('create'); return; } // first save sets the PIN
  await saveProfileConfig(activeProfile);
  addLog('success', profileLabel(activeProfile) + ' config saved ✓ (encrypted)');
}

// ── Start / Stop bot ───────────────────────────────────────────────────────────
async function toggleBot(testMode = false) {
  addLog('info', testMode ? '🧪 Test run...' : 'Button clicked...');
  try {
    const data = await chrome.storage.local.get('botRunning');
    if (data.botRunning) {
      chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE', botTestMode: false });
      chrome.storage.local.remove(['botConfig', 'burstUntil', 'queueSince']); // wipe temp state on stop
      stopQueueTimer(); stopCheckoutTimer();
      setRunningUI(false);
      addLog('warning', 'Bot stopped by user');
      return;
    }

    // Must have a PIN/key before running (so config is encrypted at rest)
    if (!cryptoKey) { showLock('create'); return; }

    const cfg = readForm();
    const searchType = cfg.searchType || 'name';
    const identifier = searchType === 'sku' ? cfg.itemSku : cfg.itemName;
    if (!cfg.useCurrentTab && !identifier) {
      addLog('error', searchType === 'sku' ? 'Enter a SKU first!' : 'Enter an item name first!');
      return;
    }

    // Store "search & navigate" mode: a store profile with "use current tab" UNCHECKED.
    const navStore = STORE_NAV[activeProfile];
    const samsSearchMode = !!navStore && !cfg.useCurrentTab;
    if (samsSearchMode) cfg.samsSearch = true; // background uses this to inject on navigation

    addLog('info', cfg.useCurrentTab ? 'Using current tab' : 'Search type: ' + searchType + ' | Value: "' + identifier + '"');

    // HARD RESET: wipe any leftover state from a previous (possibly stuck) run so a new
    // run never inherits stale pointers/flags. Background detaches any stale debugger.
    await chrome.storage.local.remove(['currentTabId', 'queueSince']);
    stopQueueTimer(); stopCheckoutTimer();
    chrome.runtime.sendMessage({ type: 'RESET_BOT' }).catch(() => {});

    // Persist the encrypted copy, and a TEMPORARY plaintext copy the bot reads during the run.
    await saveProfileConfig(activeProfile);
    // Fresh run flags: qtyDone (quantity), samsFellBack (SKU fallback), addAttempts (stuck guard)
    await chrome.storage.local.set({ botRunning: true, botPhase: 'SEARCH', botConfig: cfg, activeProfile, qtyDone: false, samsFellBack: false, addAttempts: 0, pokePlaceRetries: 0, botTestMode: !!testMode });
    if (testMode) addLog('info', '🧪 TEST MODE: full flow will run but the order will NOT be submitted.');
    setRunningUI(true);

    const siteUrl = (cfg.siteUrl || 'http://localhost:3000').replace(/\/$/, '');
    if (cfg.useCurrentTab) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.storage.local.set({ currentTabId: tab.id });
      chrome.runtime.sendMessage({ type: 'INJECT_BOT', tabId: tab.id, url: tab.url });
      addLog('success', 'Bot injected into current tab');
    } else if (samsSearchMode) {
      // By Item #/SKU → direct product URL; By Name → store search results
      const url = searchType === 'sku' ? navStore.item(cfg.itemSku) : navStore.search(cfg.itemName);
      addLog('info', 'Opening ' + navStore.name + ': ' + url);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.storage.local.set({ currentTabId: tab.id });
      await chrome.tabs.update(tab.id, { url, active: true });
      addLog('success', searchType === 'sku' ? 'Going to item…' : 'Searching ' + navStore.name + '…');
    } else {
      const url = searchType === 'sku'
        ? siteUrl + '/product.html?id='     + encodeURIComponent(cfg.itemSku)
        : siteUrl + '/product.html?search=' + encodeURIComponent(cfg.itemName);
      addLog('info', 'Navigating to: ' + url);
      const tabs = await chrome.tabs.query({ url: siteUrl + '/*' });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { url, active: true });
        addLog('success', 'Tab navigated!');
      } else {
        await chrome.tabs.create({ url });
        addLog('success', 'New tab opened!');
      }
    }
  } catch (err) {
    addLog('error', 'ERROR: ' + err.message);
    console.error(err);
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
function setRunningUI(running) {
  const btn   = document.getElementById('startBtn');
  const label = profileLabel(activeProfile);
  if (running) {
    btn.textContent = '⏹ Stop ' + label;
    btn.classList.add('running');
    setStatus('running', label + ' is running...');
  } else {
    btn.textContent = '▶ Start ' + label;
    btn.classList.remove('running');
    setStatus('idle', 'Idle – press Start to begin');
  }
}
function setStatus(state, text) {
  document.getElementById('statusDot').className = 'status-dot ' + state;
  document.getElementById('statusText').textContent = text;
}
function addLog(level, text) {
  const log = document.getElementById('log');
  const e   = document.createElement('div');
  e.className = 'log-entry ' + level;
  const t = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  e.textContent = '[' + t + '] ' + text;
  log.prepend(e);
  while (log.children.length > 50) log.removeChild(log.lastChild);
}
function clearLog() { document.getElementById('log').innerHTML = ''; }
