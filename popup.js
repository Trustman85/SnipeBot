// All config field IDs — used to save/restore form values
const FIELDS = ['siteUrl','useCurrentTab','itemName','itemSku','searchType','quantity','maxPrice','refreshInterval',
                'firstName','lastName','email','address','city','state','zip',
                'cardNumber','cardName','expiry','cvv','stopOnSuccess'];

let activeProfile = 'sams';
let cryptoKey = null;     // AES-GCM key derived from the PIN (in memory only, never stored)
let lockMode  = 'unlock'; // 'unlock' (PIN exists) or 'create' (first-time PIN setup)

// This side panel's own browser-window id. Each window has its own panel instance; capturing the
// window id here is the foundation for running an INDEPENDENT bot per window (separate state/log).
// Captured at load while this window is focused (the panel opens in the focused window).
let MY_WID = null;
let MY_BOT_NUM = null;    // friendly "Bot N" label for this window (raw window id is unreadable)

// Maps this window's id to a small, stable, human-friendly number using a shared registry in
// storage. Reuses numbers freed by closed windows so labels stay small (Bot 1, Bot 2, ...).
async function assignBotNumber(wid) {
  if (wid == null) return '?';
  let liveIds = [];
  try { liveIds = (await chrome.windows.getAll()).map(w => w.id); } catch (_) {}
  const { windowNames = {} } = await chrome.storage.local.get('windowNames');
  // Drop entries for windows that no longer exist, so their numbers can be reused.
  for (const id of Object.keys(windowNames)) if (liveIds.length && !liveIds.includes(Number(id))) delete windowNames[id];
  if (windowNames[wid] == null) {
    const used = new Set(Object.values(windowNames));
    let n = 1; while (used.has(n)) n++;       // smallest free positive integer
    windowNames[wid] = n;
  }
  await chrome.storage.local.set({ windowNames });
  return windowNames[wid];
}

// ── Per-window state namespacing ────────────────────────────────────────────────
// Each browser window runs its own INDEPENDENT bot. The keys below are per-window: stored under
// "w<windowId>:<key>" so two windows never stomp each other's run-state. Everything else (PIN/crypto,
// saved card/address, clockTz, lastProfile, windowNames) stays GLOBAL/shared.
// NS_ON is a kill-switch: false = behaves exactly like the old single-window build (bare keys);
// true = real per-window isolation. (Step 4a keeps it false; Step 4b flips it on.)
const NS_ON = true;
const PW_KEYS = new Set(['botRunning', 'botPhase', 'botConfig', 'activeProfile', 'currentTabId',
  'botTestMode', 'botRunToken', 'burstUntil', 'queueSince', 'qtyDone', 'samsFellBack', 'addAttempts',
  'pokePlaceRetries', 'armState']);
const nsk = (key) => (NS_ON && MY_WID != null && PW_KEYS.has(key)) ? ('w' + MY_WID + ':' + key) : key;
// Storage wrappers that auto-namespace ONLY per-window keys (global keys pass through unchanged),
// so a mixed get([...global, ...perWindow]) Just Works and returns the ORIGINAL key names.
function wget(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  const mapped = arr.map(nsk);
  return chrome.storage.local.get(mapped).then(res => {
    const out = {}; arr.forEach((orig, i) => { out[orig] = res[mapped[i]]; }); return out;
  });
}
function wset(obj)    { const o = {}; for (const key in obj) o[nsk(key)] = obj[key]; return chrome.storage.local.set(o); }
function wremove(keys){ const arr = Array.isArray(keys) ? keys : [keys]; return chrome.storage.local.remove(arr.map(nsk)); }

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
document.getElementById('speedTestBtn').addEventListener('click', testLoadSpeed);

// ── Keyboard shortcuts (GLOBAL) ────────────────────────────────────────────────
// Uses Chrome's commands API (manifest "commands") so the keys fire ANYWHERE in Chrome — the user
// doesn't have to click the side panel after opening/switching a tab. The command is handled in
// background.js and forwarded here as a {type:'HOTKEY'} message. We ALSO match the same combo via
// keydown as a fallback for when the panel itself is focused. dispatchHotkey() debounces so the two
// paths can't double-trigger one keypress. Keys are rebound by the user at chrome://extensions/shortcuts
// (Chrome doesn't allow extensions to set command keys programmatically), so the panel only displays them.
const HOTKEY_ACTIONS = {
  start: 'startBtn',  // ▶ Start / ⏹ Stop (toggle — same key stops it)
  test:  'testBtn',   // 🧪 Test / ⏹ Stop (toggle)
  save:  'saveBtn',   // 💾 Save
};
let cmdKeys = { start: '', test: '', save: '' }; // current Chrome-assigned combos (for display + keydown match)
const lastHotkeyAt = {};

function dispatchHotkey(action) {
  if (!HOTKEY_ACTIONS[action]) return;
  if (document.getElementById('lockOverlay').style.display !== 'none') return; // ignore while locked
  const now = Date.now();
  if (now - (lastHotkeyAt[action] || 0) < 400) return; // de-dupe the global + keydown paths for one press
  lastHotkeyAt[action] = now;
  const btn = document.getElementById(HOTKEY_ACTIONS[action]);
  if (btn && !btn.disabled) btn.click(); // start/test buttons toggle, so re-pressing stops the bot
}

// Build a canonical combo string from a keydown event (matches Chrome's "Ctrl+Shift+S" format),
// or null if only a modifier is held.
function comboFromEvent(e) {
  const k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'CapsLock', 'Dead'].includes(k)) return null;
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Command'); // Chrome labels Meta as "Command"
  parts.push(k.length === 1 ? k.toUpperCase() : k); // letters/digits uppercased; F2/Enter/Arrow* as-is
  return parts.join('+');
}

// Pull the live key assignments from Chrome (the user may have rebound them) and show them.
function refreshCmdKeys() {
  if (!chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll(cmds => {
    const map = { 'start-bot': 'start', 'test-bot': 'test', 'save-config': 'save' };
    cmdKeys = { start: '', test: '', save: '' };
    for (const c of cmds) { const a = map[c.name]; if (a) cmdKeys[a] = c.shortcut || ''; }
    for (const a of Object.keys(HOTKEY_ACTIONS)) {
      const el = document.getElementById('hk-' + a);
      if (el) { el.textContent = cmdKeys[a] || 'Not set'; el.classList.toggle('unset', !cmdKeys[a]); }
    }
  });
}
function openHotkeys()  { document.getElementById('hotkeyOverlay').style.display = 'flex'; refreshCmdKeys(); }
function closeHotkeys() { document.getElementById('hotkeyOverlay').style.display = 'none'; }

document.getElementById('hotkeyBtn').addEventListener('click', openHotkeys);
document.getElementById('hotkeyClose').addEventListener('click', closeHotkeys);
document.getElementById('hotkeyChange').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Global command relayed from the background service worker (fires even when a web page is focused).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'HOTKEY') dispatchHotkey(msg.action);
});

// Panel-focused fallback: match the same Chrome-assigned combo via keydown.
document.addEventListener('keydown', (e) => {
  if (document.getElementById('hotkeyOverlay').style.display !== 'none') return; // not while the recorder is open
  const combo = comboFromEvent(e);
  if (!combo) return;
  const hasMod = e.ctrlKey || e.altKey || e.metaKey;
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  for (const action of Object.keys(cmdKeys)) {
    if (cmdKeys[action] && cmdKeys[action] === combo) {
      if (typing && !hasMod) return; // a plain key shouldn't hijack typing in a field
      e.preventDefault();
      dispatchHotkey(action);
      return;
    }
  }
});
refreshCmdKeys();

// Measure how fast the CURRENT tab's page loads by reloading it a few times. Reports DOM-ready
// time (when the bot can first act) + full-load time, and suggests a refresh interval. This lets
// you tune the auto-refresh to the site's real speed instead of guessing.
async function testLoadSpeed() {
  const btn = document.getElementById('speedTestBtn');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:\/\//.test(tab.url || '')) {
    addLog('error', 'Open a store page in this tab first, then ⏱ Test.');
    return;
  }
  btn.disabled = true; btn.textContent = '⏱ …';
  addLog('info', '⏱ Testing "' + (tab.url || '').replace(/^https?:\/\//, '').slice(0, 40) + '" — 3 reloads...');
  const dcl = [], full = [];
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 20000);
        const l = (id, info) => {
          if (id === tab.id && info.status === 'complete') { clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); resolve(); }
        };
        chrome.tabs.onUpdated.addListener(l);
        chrome.tabs.reload(tab.id);
      });
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { const n = performance.getEntriesByType('navigation')[0]; return n ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null; }
        });
        if (result) { dcl.push(result.dcl); full.push(result.load); }
      } catch (_) {}
    }
  } finally {
    btn.disabled = false; btn.textContent = '⏱ Test';
  }
  if (!dcl.length) { addLog('warning', '⏱ Could not measure load timing on this page.'); return; }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const dclAvg = avg(dcl), suggest = Math.max(0.1, Math.round(dclAvg / 100) / 10);
  addLog('success', '⏱ DOM-ready ~' + dclAvg + 'ms · full-load ~' + avg(full) + 'ms. Suggested interval: ' + suggest + 's');
}

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

// Keep the background service worker ALIVE while the panel is open. MV3 kills idle workers after
// ~30s — and when that happened, Start/Test did nothing (there was no live worker to inject the
// bot) until the panel was reopened (which wakes the worker via the action click). A persistent
// port + periodic ping keeps the worker warm the whole time the panel is open, so opening tabs no
// longer leaves the bot unable to start. (Reloading the panel did NOT fix it — only waking the
// worker does.)
let kaPort = null;
function connectKeepAlive() {
  try {
    kaPort = chrome.runtime.connect({ name: 'keepalive' });
    kaPort.onDisconnect.addListener(() => { kaPort = null; });
  } catch (_) { kaPort = null; }
}
connectKeepAlive();
setInterval(() => {
  if (kaPort) { try { kaPort.postMessage({ ping: Date.now() }); } catch (_) { kaPort = null; } }
  else connectKeepAlive(); // reconnect if the worker had cycled
}, 20000);

// Auto-refresh the panel when a NEW TAB is opened (keeps the panel snappy during drops; OK to lose
// the log). Flagged so the unload handler below does NOT stop the running bot on our own reload.
// The armed drop + running state are persisted in storage, so they survive this reload.
let isReloading = false;
chrome.tabs.onCreated.addListener(() => { isReloading = true; location.reload(); });

// On genuine panel close: stop the bot + wipe the temporary plaintext config. On our own reload
// (new-tab refresh), do NEITHER — the bot keeps running, its config stays, and the arm persists.
window.addEventListener('unload', () => {
  if (isReloading) return;
  wset({ botRunning: false, botPhase: 'IDLE' });
  wremove(['botConfig', 'burstUntil']);
  // Window-scoped stop: close THIS window's bot only — don't disturb other windows' running bots.
  chrome.runtime.sendMessage({ type: 'STOP_BOT', wid: MY_WID }).catch(() => {});
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

// Cache one Intl.DateTimeFormat per timezone — building one is expensive, and the clock renders
// ~20×/sec. Creating it every frame (the old code) saturated the panel thread and froze it.
const _fmtCache = {};
function clockFmt(tz) {
  if (!_fmtCache[tz]) {
    try { _fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (_) { _fmtCache[tz] = null; }
  }
  return _fmtCache[tz];
}
function renderClock() {
  const tz = tzSelect.value;
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const fmt = clockFmt(tz);
  if (fmt) {
    const parts = fmt.formatToParts(now);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    liveClock.textContent = get('hour') + ':' + get('minute') + ':' + get('second') + '.' + ms + ' ' + get('dayPeriod') + ' ' + (TZ_ABBR[tz] || '');
  } else {
    liveClock.textContent = now.toTimeString().slice(0, 8) + '.' + ms;
  }
}
// Only tick while the panel is actually visible — pause when hidden to save CPU.
let clockTimer = null;
function startClock() { if (!clockTimer) { renderClock(); clockTimer = setInterval(renderClock, 50); } }
function stopClock()  { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }
document.addEventListener('visibilitychange', () => { document.hidden ? stopClock() : startClock(); });
startClock();

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

function disarm() {
  if (dropInterval) { clearInterval(dropInterval); dropInterval = null; }
  armBtn.textContent = 'Arm'; armBtn.classList.remove('armed');
  wremove('armState');
}

// Start (or restore) an armed drop. The arm is persisted in storage (armState) so it SURVIVES a
// panel reload/refresh — without that, opening a tab wiped the arm and the drop never fired.
// testMode ON → the drop fires the bot in TEST mode (stops before placing the order, for rehearsing
// the timing safely). OFF → fires a real order (same as the Start button).
function startArm(target, leadMs, tz, testMode) {
  const fireAt = target - leadMs; // start early
  const tag = testMode ? ' [TEST]' : ' [REAL]';
  armBtn.textContent = 'Disarm'; armBtn.classList.add('armed');
  if (!cryptoKey) addLog('warning', '⚠️ Armed — but unlock your PIN before the drop or it can\'t auto-start');
  if (dropInterval) clearInterval(dropInterval);
  dropInterval = setInterval(async () => {
    const remFire = fireAt - Date.now();
    if (remFire <= 0) {
      clearInterval(dropInterval); dropInterval = null;
      armBtn.textContent = 'Arm'; armBtn.classList.remove('armed');
      await wremove('armState'); // fired — don't re-arm on a later reload
      dropStatusEl.textContent = '🚀 Drop fired' + tag + ' — burst-polling!';
      const { botRunning } = await wget('botRunning');
      if (botRunning) return;
      if (!cryptoKey) { addLog('error', 'Drop fired but PIN is locked — unlock and Start manually'); return; }
      // Burst window: from the drop moment until 90s after, the bot reloads as fast as it
      // can to grab a spot the instant the item goes live; then it settles to normal pace.
      await wset({ burstUntil: target + 90000 });
      toggleBot(testMode); // TEST (stops before order) or real, per the Test toggle
      return;
    }
    const s = Math.ceil(remFire / 1000);
    const h2 = String(Math.floor(s / 3600)).padStart(2, '0');
    const m2 = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const s2 = String(s % 60).padStart(2, '0');
    dropStatusEl.textContent = 'Starts in ' + h2 + ':' + m2 + ':' + s2 + tag + ' (' + (leadMs / 1000) + 's early, ' + (TZ_ABBR[tz] || '') + ')';
  }, 50);
}

armBtn.addEventListener('click', () => {
  if (dropInterval) { disarm(); dropStatusEl.textContent = 'Disarmed.'; return; }
  const v = document.getElementById('dropTime').value; // "HH:MM:SS" or "HH:MM"
  if (!v) { dropStatusEl.textContent = 'Set a drop time first.'; return; }
  const [hh, mm, ss = 0] = v.split(':').map(Number);
  const tz = tzSelect.value;
  const target = dropTimestamp(tz, hh, mm, ss);
  const leadMs = Math.max(0, parseInt(document.getElementById('leadSec').value || '3')) * 1000;
  const testMode = document.getElementById('armTest').checked;
  wset({ armState: { target, leadMs, tz, testMode } }); // persist so a reload restores it
  startArm(target, leadMs, tz, testMode);
});

// As soon as a time is picked, close the native time picker and commit the value (blur), so you
// don't have to click away — the chosen time lands in the field automatically.
document.getElementById('dropTime').addEventListener('change', (e) => {
  if (e.target.value) e.target.blur();
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
  // 0) Identify which browser window this panel belongs to (basis for per-window bots), and map
  //    the raw window id to a friendly "Bot N" label.
  try {
    const win = await chrome.windows.getCurrent();
    MY_WID = win && win.id;
    MY_BOT_NUM = await assignBotNumber(MY_WID);
    addLog('info', '🤖 Bot ' + MY_BOT_NUM + ' — panel ready');
    const sub = document.querySelector('.subtitle');
    if (sub) sub.textContent = 'Bot ' + MY_BOT_NUM;
  } catch (e) { addLog('error', 'Could not get window id: ' + e.message); }

  // 1) Reopen on the store you were last using
  const { lastProfile } = await chrome.storage.local.get('lastProfile');
  if (lastProfile && STORE_NAV[lastProfile]) {
    activeProfile = lastProfile;
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.profile === activeProfile));
  }

  const { pinSalt, botRunning, pinLockUntil = 0 } = await wget(['pinSalt', 'botRunning', 'pinLockUntil']);
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

  // Restore an armed drop that was set before a panel refresh/reopen, so opening tabs (or the
  // auto-refresh) never loses the arm. Drop stale ones (target already well past).
  const { armState } = await wget('armState');
  if (armState && typeof armState.target === 'number') {
    if (armState.target - Date.now() > -90000) {
      document.getElementById('armTest').checked = !!armState.testMode; // restore the Test toggle
      startArm(armState.target, armState.leadMs, armState.tz, armState.testMode);
    } else {
      wremove('armState');
    }
  }
})();

// ── Messages from content script ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  // Per-window routing: a message tagged with a wid belongs to THAT window's panel only. Untagged
  // messages (background-origin, or the localhost Sam's flow) are shown everywhere as before.
  if (msg.wid != null && msg.wid !== MY_WID) return;
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
    wremove(['botConfig', 'burstUntil', 'queueSince']); // wipe temp state
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
    const data = await wget('botRunning');
    if (data.botRunning) {
      wset({ botRunning: false, botPhase: 'IDLE', botTestMode: false });
      wremove(['botConfig', 'burstUntil', 'queueSince']); // wipe temp state on stop
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
    await wremove(['currentTabId', 'queueSince']);
    stopQueueTimer(); stopCheckoutTimer();
    chrome.runtime.sendMessage({ type: 'RESET_BOT' }).catch(() => {});

    // Persist the encrypted copy, and a TEMPORARY plaintext copy the bot reads during the run.
    await saveProfileConfig(activeProfile);
    // Fresh run flags: qtyDone (quantity), samsFellBack (SKU fallback), addAttempts (stuck guard)
    await wset({ botRunning: true, botPhase: 'SEARCH', botConfig: cfg, activeProfile, qtyDone: false, samsFellBack: false, addAttempts: 0, pokePlaceRetries: 0, botTestMode: !!testMode, botRunToken: Date.now() });
    if (testMode) addLog('info', '🧪 TEST MODE: full flow will run but the order will NOT be submitted.');
    setRunningUI(true);

    const siteUrl = (cfg.siteUrl || 'http://localhost:3000').replace(/\/$/, '');
    if (cfg.useCurrentTab) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { addLog('error', 'No active tab found — click the store tab, then Start.'); setRunningUI(false); return; }
      const okPage = /^https?:\/\//.test(tab.url || '');
      if (!okPage) { addLog('error', 'Current tab is "' + (tab.url || 'blank') + '" — open the STORE PAGE in this tab, then Start.'); setRunningUI(false); return; }
      await wset({ currentTabId: tab.id });
      chrome.runtime.sendMessage({ type: 'INJECT_BOT', tabId: tab.id, url: tab.url });
      addLog('success', 'Bot injected → ' + (tab.url || '').replace(/^https?:\/\//, '').slice(0, 45));
    } else if (samsSearchMode) {
      // By Item #/SKU → direct product URL; By Name → store search results
      const url = searchType === 'sku' ? navStore.item(cfg.itemSku) : navStore.search(cfg.itemName);
      addLog('info', 'Opening ' + navStore.name + ': ' + url);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await wset({ currentTabId: tab.id });
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
