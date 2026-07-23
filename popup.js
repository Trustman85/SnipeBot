// All config field IDs — used to save/restore form values
const FIELDS = ['siteUrl','useCurrentTab','itemSku','searchType','quantity','maxPrice','refreshInterval',
                'watchlist',
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

// Resolve THIS panel's window id ONCE at open, when the window is focused and the answer is
// reliable. We then PIN it (MY_WID) and never re-resolve mid-session — re-resolving via
// currentWindow/getCurrent from a side panel DRIFTS to the last-focused window.
async function resolveMyWid() {
  // A side panel document belongs to ONE window for its whole life, and sessionStorage survives
  // our own location.reload() (auto-reset on store switch) but NOT a real close+reopen. So a wid
  // this panel already resolved is strictly more reliable than re-deriving it after a programmatic
  // reload, where getCurrent/currentWindow can drift to whatever window was last focused — the
  // silent killer where Start writes w<X> keys but the tab reads w<Y> ("works after I reopen").
  try {
    const cached = Number(sessionStorage.getItem('SNIPE_MY_WID'));
    if (Number.isFinite(cached) && cached > 0) return cached;
  } catch (_) {}
  let wid = null;
  try { const win = await chrome.windows.getCurrent(); if (win && win.id != null) wid = win.id; } catch (_) {}
  if (wid == null) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && typeof tab.windowId === 'number') wid = tab.windowId;
    } catch (_) {}
  }
  if (wid != null) { try { sessionStorage.setItem('SNIPE_MY_WID', String(wid)); } catch (_) {} }
  return wid;
}

// ── Fluid scale: the panel zooms CONTINUOUSLY with the window instead of jumping between
// fixed-size breakpoints. Baseline = the size everything was designed at (roomy 1440p sidebar);
// smaller windows scale everything down proportionally, clamped so text stays readable.
function fitPanelScale() {
  const z = Math.max(0.72, Math.min(1, window.innerHeight / 1150, window.innerWidth / 430));
  document.body.style.zoom = String(z);
  // zoom shrinks the rendered body below the real viewport (dead space under the Start buttons)
  // — compensate so the layout still spans the FULL window: rendered = (innerHeight / z) × z.
  document.body.style.height = Math.round(window.innerHeight / z) + 'px';
}
window.addEventListener('resize', fitPanelScale);
fitPanelScale();

// After a Walmart Start-reload, report the TAB's load state every 5s — the anti-bot slow-load
// can stall the page 30-60s+ and the panel showed NOTHING (user kept stopping at ~10-20s thinking
// the bot was dead). Also distinguishes the two failure modes: "still loading" = tarpit (wait);
// "finished loading but no bot lines" = injection problem (tell the dev).
async function monitorWalmartLoad(tabId) {
  const t0 = Date.now();
  for (let i = 0; i < 24; i++) {              // up to ~2 min
    await new Promise(res => setTimeout(res, 5000));
    try {
      const { botRunning } = await wget('botRunning');
      if (!botRunning) return;                 // user stopped — stop narrating
      const tab = await chrome.tabs.get(tabId);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (tab.status === 'loading') {
        addLog('info', '⏳ Walmart page still loading… (' + secs + 's — anti-bot slow-load; the bot starts the moment it finishes)');
      } else {
        addLog('info', '🌐 Walmart page finished loading (' + secs + 's). If no bot lines follow, injection failed — copy the log.');
        return;
      }
    } catch (_) { return; }                    // tab closed
  }
}

// The active tab IN OUR pinned window. Always scope by windowId: MY_WID, never `currentWindow`
// (which drifts to whatever window is focused) — so the bot always injects into the tab the panel
// actually belongs to, regardless of focus.
async function activeTabInMyWindow() {
  if (MY_WID != null) {
    try { const [t] = await chrome.tabs.query({ active: true, windowId: MY_WID }); if (t) return t; } catch (_) {}
  }
  try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t || null; } catch (_) { return null; }
}

// Maps this window's id to a small, stable, human-friendly number using a shared registry in
// storage. Reuses numbers freed by closed windows so labels stay small (Bot 1, Bot 2, ...).
async function assignBotNumber(wid) {
  if (wid == null) return '?';
  let liveIds = [];
  try { liveIds = (await chrome.windows.getAll()).map(w => w.id); } catch (_) {}
  const { windowNames = {} } = await chrome.storage.local.get('windowNames');
  // Drop entries for windows that no longer exist, so their numbers can be reused.
  for (const id of Object.keys(windowNames)) if (liveIds.length && !liveIds.includes(Number(id))) delete windowNames[id];
  // RE-COMPACT on every panel open: this window re-grabs the smallest free number. Without this a
  // window kept the "Bot 3" it was assigned while two other (since-closed) windows existed —
  // confusing when it's the ONLY window left. Other open windows keep their numbers.
  delete windowNames[wid];
  const used = new Set(Object.values(windowNames));
  let n = 1; while (used.has(n)) n++;         // smallest free positive integer
  windowNames[wid] = n;
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
  'pokePlaceRetries', 'armState', 'watchIndex']);
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

// ── Per-window form values (Quantity & Max Price) ───────────────────────────────
// These are saved/restored PER WINDOW (under w<wid>:ui:<field>), so running several bots doesn't
// make Quantity / Max Price snap to whatever you last typed in any one window. They override the
// shared per-profile config when the form loads, and persist as you type.
const PW_UI_FIELDS = ['quantity', 'maxPrice'];
async function applyPerWindowUI() {
  if (MY_WID == null) return;
  const keys = PW_UI_FIELDS.map(f => 'w' + MY_WID + ':ui:' + f);
  const res = await chrome.storage.local.get(keys);
  PW_UI_FIELDS.forEach((f, i) => {
    const v = res[keys[i]];
    const el = document.getElementById(f);
    if (el && v != null && v !== '') el.value = v;
  });
}
PW_UI_FIELDS.forEach(f => {
  const el = document.getElementById(f);
  if (el) el.addEventListener('input', () => { if (MY_WID != null) chrome.storage.local.set({ ['w' + MY_WID + ':ui:' + f]: el.value }); });
});

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

// ── 12-hour unlock window ──────────────────────────────────────────────────────
// Cache the key with an expiry so reopening the panel (or reloading the extension)
// within 12 hours skips the PIN. Stored in local so it survives a reset; auto-deleted
// when it expires. (Tradeoff: the key sits cached for up to 12h — bounded exposure.)
const UNLOCK_HOURS = 12;
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
  // All stores are SKU/Link-only now — older saved configs may still carry searchType 'name'.
  document.getElementById('searchType').value = 'sku';
}
// Per-store item-ID extraction from a pasted LINK or bare ID (the "SKU / Link" field and the
// drop watchlist both accept either). Returns the id, or null if the line isn't recognizable.
const ID_EXTRACT = {
  sams:          s => (s.match(/\/ip\/(?:[^\/]+\/)?(\d{5,})/)  || s.match(/^(\d{5,})$/) || [])[1] || null,
  target:        s => (s.match(/\/A-(\d{5,})/i)                || s.match(/^(\d{5,})$/) || [])[1] || null,
  walmart:       s => (s.match(/\/ip\/(?:[^\/]+\/)?(\d{5,})/)  || s.match(/^(\d{5,})$/) || [])[1] || null,
  bestbuy:       s => (s.match(/skuId=(\d{5,})/i) || s.match(/\/(\d{5,})\.p\b/) || s.match(/^(\d{5,})$/) || [])[1] || null,
  pokemoncenter: s => (s.match(/\/product\/([A-Za-z0-9._-]+)/i) || (!/^https?:/i.test(s) && s.match(/^([A-Za-z0-9._-]{4,})$/)) || [])[1] || null,
};
const extractItemId = (line, profile) => {
  const fn = ID_EXTRACT[profile];
  return fn ? fn(String(line).trim()) : null;
};
// Parse the watchlist textarea into de-duped item IDs for the active store (links or bare IDs).
function parseWatchlist(text, profile) {
  if (!text) return [];
  const ids = String(text).split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean)
    .map(line => extractItemId(line, profile)).filter(Boolean);
  return ids.filter((id, i) => ids.indexOf(id) === i);
}

function clearForm() {
  writeForm({ siteUrl: 'http://localhost:3000', quantity: '1', maxPrice: '999', refreshInterval: '2',
              stopOnSuccess: true, useCurrentTab: false, searchType: 'sku' });
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
                refreshInterval: '2', stopOnSuccess: true, useCurrentTab: false, searchType: 'sku' };
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
  await applyPerWindowUI(); // Quantity & Max Price are per-window — override the shared values
  applyWatchlistVisibility();
}

// Every store now has the SAME item section: "By SKU / Link" + the drop watchlist
// (name search was removed everywhere). This just fills in per-store examples so the
// placeholders/hints show the right link format for the active profile.
const STORE_LINK_EX = {
  sams:          { ex: 'samsclub.com/ip/…',       ph: 'https://www.samsclub.com/ip/prismatic/990466313\n990466314' },
  target:        { ex: 'target.com/p/…/A-…',      ph: 'https://www.target.com/p/-/A-94721312\n94300072' },
  walmart:       { ex: 'walmart.com/ip/…',        ph: 'https://www.walmart.com/ip/20278470684\n19965460207' },
  bestbuy:       { ex: 'bestbuy.com/site/…',      ph: 'https://www.bestbuy.com/site/x/6614325.p\n6614326' },
  pokemoncenter: { ex: 'pokemoncenter.com/product/…', ph: 'https://www.pokemoncenter.com/product/100-10086\n100-10087' },
};
function applyWatchlistVisibility() {
  const s = STORE_LINK_EX[activeProfile] || { ex: 'product link', ph: 'one link or ID per line' };
  const skuInput = document.getElementById('itemSku');
  if (skuInput) skuInput.placeholder = s.ex + ' link or item ID';
  const wl = document.getElementById('watchLabel');
  if (wl) wl.textContent = '👁 Drop watchlist — one ' + s.ex + ' link or item ID per line';
  const wt = document.getElementById('watchlist');
  if (wt) wt.placeholder = s.ph;
  const wh = document.getElementById('watchHint');
  if (wh) wh.textContent = (activeProfile === 'walmart')
    ? 'Use the stable /ip/<id> links (NOT buff.ly — those change each drop). Bot watches all items and jumps into the first queue that opens.'
    : 'Bot watches all items in the background and buys the first that goes live.';
}

// ── Profile switcher ───────────────────────────────────────────────────────────
// HARD RESET on EVERY store switch (tab click AND auto-follow) — the panel behaves as if it was
// closed and reopened: stop THIS window's bot, WIPE its run-state (incl. the Test flag), detach
// any stale debugger, and reload the panel. Without this, a previous store's run (or a leftover
// botTestMode) could bleed into the next store — the classic "bot bugs out after switching, works
// after I reopen the sidebar" — and, worst case, make a Test run place a REAL order.
async function hardSwitchProfile(profile) {
  if (profile === activeProfile) return;
  try { await saveProfileConfig(activeProfile); } catch (_) {} // persist the current store's form first
  // Reopen on the new store after reload. Namespaced per window (each window's panel remembers its
  // OWN store); the un-namespaced key stays as a fallback for fresh windows.
  chrome.storage.local.set({ ['lastProfile:w' + MY_WID]: profile, lastProfile: profile });
  await wset({ botRunning: false, botPhase: 'IDLE', botTestMode: false });
  await wremove(['botConfig', 'burstUntil', 'queueSince', 'currentTabId']);
  chrome.runtime.sendMessage({ type: 'STOP_BOT', wid: MY_WID }).catch(() => {});
  // Wipe the WORKER's in-memory state too (injection dedup, stale debuggers) — a real sidebar
  // close+reopen effectively gets a clean worker; without this the reset wasn't equivalent.
  await new Promise(res => { try { chrome.runtime.sendMessage({ type: 'HARD_RESET' }, () => res()); } catch (_) { res(); } setTimeout(res, 1500); });
  isReloading = true;          // tell the unload handler NOT to run its own stop again
  location.reload();           // clean slate — full panel re-init, like close + reopen
}
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', () => hardSwitchProfile(tab.dataset.profile));
});

// Detect which store profile a URL belongs to (or null).
function profileForUrl(url) {
  const h = (url || '').toLowerCase();
  return /samsclub\.com/.test(h)      ? 'sams'
       : /target\.com/.test(h)        ? 'target'
       : /walmart\.com/.test(h)       ? 'walmart'
       : /bestbuy\.com/.test(h)       ? 'bestbuy'
       : /pokemoncenter\.com/.test(h) ? 'pokemoncenter' : null;
}

// Follow the tab: when you switch to a different tab in THIS window, auto-select the store that
// matches it. Skipped while a bot is running (so it never switches out from under a live run).
chrome.tabs.onActivated.addListener(async (info) => {
  if (MY_WID == null || info.windowId !== MY_WID) return; // only our window, once we know which it is
  const { botRunning } = await wget('botRunning');
  if (botRunning) return;
  try {
    const tab = await chrome.tabs.get(info.tabId);
    const p = profileForUrl(tab.url);
    if (p && STORE_NAV[p] && p !== activeProfile) await hardSwitchProfile(p);
  } catch (_) {}
});

// Follow the NAVIGATION too: when a click sends THIS window's active tab to a store (e.g. clicking a
// Discord/store link, which onActivated alone misses because the URL loads after activation), switch
// the profile as soon as the new URL is known. Same guards: only our window, only when not running.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return; // only on a URL change / load
  if (MY_WID == null || !tab || tab.windowId !== MY_WID || !tab.active) return; // active tab, our window
  const { botRunning } = await wget('botRunning');
  if (botRunning) return;
  const p = profileForUrl(changeInfo.url || tab.url);
  if (p && STORE_NAV[p] && p !== activeProfile) { try { await hardSwitchProfile(p); } catch (_) {} }
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

// ── Wire up buttons ────────────────────────────────────────────────────────────
document.getElementById('startBtn').addEventListener('click', () => toggleBot(false));
document.getElementById('testBtn').addEventListener('click', () => toggleBot(true));
document.getElementById('saveBtn').addEventListener('click', saveConfig);
document.getElementById('clearBtn').addEventListener('click', clearLog);
document.getElementById('copyLogBtn').addEventListener('click', copyLog);
document.getElementById('closeBtn').addEventListener('click', () => window.close());
document.getElementById('speedTestBtn').addEventListener('click', testLoadSpeed);
document.getElementById('stockTestBtn').addEventListener('click', findStockApi);
document.getElementById('trackBtn').addEventListener('click', toggleClickTracker);
document.getElementById('capCheckoutBtn').addEventListener('click', toggleCheckoutCapture);

// Click-tracker toggle: registers track.js on the current store's DOMAIN (so it follows you across
// the checkout pages) and logs the CODE of every button/link you click. Turn ON, do a manual
// checkout during a drop, then paste the log so a store (Walmart/Best Buy/…) can be tuned.
// clickTrackOn is THIS window's own toggle — each bot tracks (and displays) independently. The
// content-script registration itself is browser-wide (can't be window-scoped), so it's shared and
// ref-counted: registered while ANY window is tracking, removed only when the LAST one turns off.
let clickTrackOn = false;
const trackKey = () => 'w' + MY_WID + ':clickTrackOn';
async function anyWindowTracking() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).some(k => /^w\d+:clickTrackOn$/.test(k) && all[k]);
}
async function toggleClickTracker() {
  const btn = document.getElementById('trackBtn');
  if (!clickTrackOn) {
    try {
      clickTrackOn = true;
      if (MY_WID != null) await chrome.storage.local.set({ [trackKey()]: true });
      // Register the shared tracker on ALL sites/frames if it isn't already (idempotent).
      const regs = await chrome.scripting.getRegisteredContentScripts({ ids: ['click-track'] }).catch(() => []);
      if (!regs || !regs.length) {
        await chrome.scripting.registerContentScripts([{ id: 'click-track', js: ['track.js'], matches: ['*://*/*'], runAt: 'document_start', allFrames: true }]);
      }
      // Apply to THIS window's current tab now (no reload needed) if it's a web page.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && /^https?:\/\//.test(tab.url || '')) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['track.js'] }).catch(() => {});
      btn.textContent = '👁 ON'; btn.classList.add('tracking');
      addLog('success', '👁 Tracking ON (this bot) — clicks, press-holds (⏳), drags (✋), tab switches, and page loads in THIS window are logged. Turn OFF when done, then paste the log.');
    } catch (e) { clickTrackOn = false; addLog('error', '👁 ' + e.message); }
  } else {
    clickTrackOn = false;
    if (MY_WID != null) await chrome.storage.local.set({ [trackKey()]: false });
    // Only remove the shared tracker once NO window still wants it.
    if (!(await anyWindowTracking())) await chrome.scripting.unregisterContentScripts({ ids: ['click-track'] }).catch(() => {});
    btn.textContent = '👁 Track'; btn.classList.remove('tracking');
    addLog('warning', '👁 Tracking OFF (this bot).');
  }
}
// While tracking: also log tab switches and page navigations (the whole browser flow, not just
// clicks) — but ONLY for THIS window's tabs, so each bot's track log stays independent.
chrome.tabs.onActivated.addListener(async (info) => {
  if (!clickTrackOn || MY_WID == null || info.windowId !== MY_WID) return;
  try { const t = await chrome.tabs.get(info.tabId); addLog('info', '🔀 tab → ' + (t.title || t.url || '').replace(/^https?:\/\//, '').slice(0, 60)); } catch (_) {}
});
chrome.tabs.onUpdated.addListener((tabId, ch, tab) => {
  if (!clickTrackOn || ch.status !== 'complete') return;
  if (MY_WID == null || (tab && tab.windowId !== MY_WID)) return; // only this window's tabs
  addLog('info', '🌐 loaded → ' + (tab.url || '').replace(/^https?:\/\//, '').slice(0, 72));
});
// Restore THIS window's tracker toggle on panel load — see restoreTrackToggle(), called from init
// once MY_WID is known (the per-window flag isn't readable before then).
async function restoreTrackToggle() {
  if (MY_WID == null) return;
  try {
    const k = trackKey();
    if ((await chrome.storage.local.get(k))[k]) {
      clickTrackOn = true;
      const b = document.getElementById('trackBtn');
      if (b) { b.textContent = '👁 ON'; b.classList.add('tracking'); }
    }
  } catch (_) {}
}

// Universal stock-API sniffer. Registers a document_start network hook on the CURRENT store site,
// reloads the page so the stock request fires WITH the hook active, then reports which request
// carried the availability data (URL + a sample of the response). Read-only diagnostic used to wire
// the fast stock-watcher for a new store — paste the results and I'll build that store's watcher.
async function findStockApi() {
  const btn = document.getElementById('stockTestBtn');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:\/\//.test(tab.url || '')) { addLog('error', '⚡ Open the store PRODUCT page in this tab first.'); return; }
  let origin; try { origin = new URL(tab.url).origin; } catch (_) { addLog('error', '⚡ Bad tab URL.'); return; }
  btn.disabled = true; btn.textContent = '⚡ …';
  addLog('info', '⚡ Sniffing the stock API — installing a network monitor + reloading the page…');
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['stock-sniff'] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{
      id: 'stock-sniff', js: ['sniff.js'], matches: [origin + '/*'], runAt: 'document_start', world: 'MAIN'
    }]);
    await chrome.tabs.reload(tab.id);
    await new Promise(r => setTimeout(r, 5500)); // let the page + its stock calls load with the hook on
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: () => { try { return sessionStorage.getItem('__botStockSniff'); } catch (_) { return null; } }
    });
    let hits = []; try { hits = JSON.parse((out && out.result) || '[]'); } catch (_) {}
    if (!hits.length) { addLog('warning', '⚡ No stock-looking request captured — the page may load stock differently. Tell me and we’ll try DevTools for this store.'); return; }
    const seen = new Set();
    for (const h of hits) {
      const short = h.url.replace(/^https?:\/\//, '').split('?')[0];
      if (seen.has(short)) continue; seen.add(short);
      addLog('success', '⚡ ' + short);
      addLog('info', '   ' + (h.sample || '').replace(/\s+/g, ' ').slice(0, 160));
    }
    // Also scan the page HTML — Walmart/Sam's (GLASS) SERVER-RENDER availability into the page (no
    // separate XHR), so the stock field lives in the HTML itself, not a caught request.
    try {
      const [scan] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          const html = (document.documentElement && document.documentElement.outerHTML) || '';
          const out = [], seen = new Set();
          const re = /"[a-zA-Z_]*availab[a-zA-Z_]*"\s*:\s*("[^"]{0,30}"|true|false|\d+)|"(?:stockStatus|onlineStatus|inventoryStatus)"\s*:\s*"[^"]{0,24}"|"orderLimit"\s*:\s*\d+|OUT_OF_STOCK|IN_STOCK/g;
          let m; while ((m = re.exec(html)) && out.length < 10) { const s = m[0].replace(/\s+/g, ''); if (!seen.has(s)) { seen.add(s); out.push(s); } }
          return out;
        }
      });
      const fields = (scan && scan.result) || [];
      if (fields.length) addLog('success', '⚡ (in page HTML) ' + fields.join('  ·  '));
    } catch (_) {}
    addLog('info', '⚡ Paste these lines to me — I’ll build the watcher for this store.');
  } catch (e) { addLog('error', '⚡ ' + e.message); }
  finally {
    await chrome.scripting.unregisterContentScripts({ ids: ['stock-sniff'] }).catch(() => {});
    btn.disabled = false; btn.textContent = '⚡ API';
  }
}

// ── Checkout-API capture (🛒 Cap) ──────────────────────────────────────────────
// Toggle: ON installs sniff-checkout.js on the current store (now + on every navigation) so the
// cart/checkout POSTs are recorded across the whole manual checkout; OFF reads them back and dumps
// them to the log. Used to build direct-API checkout for a store. State kept in sessionStorage
// (page-side) + a panel flag so it survives the checkout's page navigations.
let capCheckoutOn = false;
async function toggleCheckoutCapture() {
  const btn = document.getElementById('capCheckoutBtn');
  const [tab] = await chrome.tabs.query({ active: true, windowId: MY_WID });
  if (!tab || !/^https?:\/\//.test(tab.url || '')) { addLog('error', '🛒 Open the store PRODUCT page in this tab first.'); return; }
  let origin; try { origin = new URL(tab.url).origin; } catch (_) { addLog('error', '🛒 Bad tab URL.'); return; }

  if (!capCheckoutOn) {
    try {
      // NOTE: does NOT clear prior captures — so you can turn Cap ON→OFF to RE-DUMP the last
      // checkout's calls (with full headers/bodies) without placing another order. Press Start to
      // wipe old captures. Register for future navigations + inject into the current page now.
      await chrome.scripting.unregisterContentScripts({ ids: ['checkout-sniff'] }).catch(() => {});
      // allFrames + <all_urls> so the hook also lands inside Target's checkout IFRAME (the final
      // place-order POST fires there, often on a different subdomain) — not just the top page.
      await chrome.scripting.registerContentScripts([{
        id: 'checkout-sniff', js: ['sniff-checkout.js'], matches: ['<all_urls>'], allFrames: true, runAt: 'document_start', world: 'MAIN'
      }]);
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN', files: ['sniff-checkout.js'] });
      capCheckoutOn = true;
      btn.textContent = '🛒 ●'; btn.classList.add('tracking');
      addLog('success', '🛒 Checkout capture ON — now do a FULL manual checkout (add to cart → place order). Turn OFF when done to dump the API calls.');
    } catch (e) { addLog('error', '🛒 ' + e.message); }
    return;
  }

  // Turn OFF → read + dump. Read EVERY frame (the checkout iframe keeps its own sessionStorage)
  // and merge, de-duped and time-ordered.
  try {
    const outs = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN',
      func: () => { try { return sessionStorage.getItem('__botCheckoutSniff'); } catch (_) { return null; } } });
    let hits = [];
    for (const o of (outs || [])) { try { const arr = JSON.parse((o && o.result) || '[]'); if (Array.isArray(arr)) hits = hits.concat(arr); } catch (_) {} }
    const seen = new Set();
    hits = hits.filter(h => { const k = h.method + ' ' + h.url + ' ' + (h.at || ''); if (seen.has(k)) return false; seen.add(k); return true; })
               .sort((a, b) => (a.at || 0) - (b.at || 0));
    if (!hits.length) {
      addLog('warning', '🛒 No cart/checkout POSTs captured. Did the checkout happen in THIS tab? (Capture stays per-origin — start it on the product page and stay on the store.)');
    } else {
      addLog('success', '🛒 Captured ' + hits.length + ' checkout request(s) — newest last:');
      for (const h of hits) {
        addLog('info', '— ' + h.method + ' ' + (h.url || '').replace(/^https?:\/\//, '') + '  →  ' + h.status);
        // Headers matter for replication (Target needs x-api-key / visitor / content-type). Skip the
        // giant cookie header (it rides along automatically via credentials:include).
        const hd = h.reqHeaders || {};
        const hkeys = Object.keys(hd).filter(k => !/^cookie$/i.test(k));
        if (hkeys.length) addLog('info', '   headers: ' + hkeys.map(k => k + '=' + String(hd[k]).slice(0, 60)).join(' | '));
        if (h.reqBody) addLog('info', '   body: ' + String(h.reqBody).replace(/\s+/g, ' '));
        if (h.respSample) addLog('info', '   resp: ' + String(h.respSample).replace(/\s+/g, ' ').slice(0, 200));
      }
      addLog('info', '🛒 Hit Copy and paste it to me — I’ll wire direct-API checkout for this store.');
    }
  } catch (e) { addLog('error', '🛒 ' + e.message); }
  finally {
    await chrome.scripting.unregisterContentScripts({ ids: ['checkout-sniff'] }).catch(() => {});
    capCheckoutOn = false;
    btn.textContent = '🛒 Cap'; btn.classList.remove('tracking');
  }
}

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
// Only OUR window's hotkey acts here — background tags the focused window's id (msg.wid); without
// the filter one key press started/stopped EVERY open window's bot.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'HOTKEY' && (msg.wid == null || msg.wid === MY_WID)) dispatchHotkey(msg.action);
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
chrome.tabs.onCreated.addListener(() => { if (clickTrackOn) return; isReloading = true; location.reload(); }); // don't wipe the log while tracking

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

// Reads the time/lead/test fields and (re)arms the drop. Shared by the Arm button and by the
// field listeners below, so changing the time/lead/test AFTER arming just updates the live
// countdown instead of leaving it stuck on the old time. Returns false if no time is set.
function armFromFields() {
  const v = document.getElementById('dropTime').value; // "HH:MM:SS" or "HH:MM"
  if (!v) { dropStatusEl.textContent = 'Set a drop time first.'; addLog('error', 'Arm failed — set a drop time first'); return false; }
  const [hh, mm, ss = 0] = v.split(':').map(Number);
  const tz = tzSelect.value;
  const target = dropTimestamp(tz, hh, mm, ss);
  const leadMs = Math.max(0, parseInt(document.getElementById('leadSec').value || '3')) * 1000;
  const testMode = document.getElementById('armTest').checked;
  wset({ armState: { target, leadMs, tz, testMode } }); // persist so a reload restores it
  startArm(target, leadMs, tz, testMode);
  // Confirm in the activity log so you can verify the drop is set correctly.
  addLog('success', '🎯 Armed → ' + v + ' ' + (TZ_ABBR[tz] || '') + ' · ' + (leadMs / 1000) + 's early · ' + (testMode ? 'TEST (rehearse)' : 'REAL order'));
  return true;
}

armBtn.addEventListener('click', () => {
  if (dropInterval) { disarm(); dropStatusEl.textContent = 'Disarmed.'; addLog('warning', 'Disarmed'); return; }
  armFromFields();
});

// Time field behavior:
//  • TYPING: don't blur on change — blurring mid-edit kicked focus out before the 2nd digit, so
//    "11" collapsed to "01". A keydown flags that you're typing, so the change handler leaves focus
//    alone and you can finish the segment (highlight + type "11" → "11", "1" → "01").
//  • PICKER/SPINNER (no keystroke): close it automatically by blurring once a value is chosen.
//  • RE-ARM: if a drop is already armed, re-arm to the new time when you finish editing (on blur,
//    only if the value actually changed) — so changing your mind on the time just works.
// Current time as "HH:MM:SS" in the chosen timezone — used to seed the picker at "now".
function nowTimeInTz(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
  return (p.hour === '24' ? '00' : p.hour) + ':' + p.minute + ':' + p.second;
}
const dropTimeEl = document.getElementById('dropTime');
let dropTimeTyped = false, dropTimeAtFocus = '';
// Reset the field to the CURRENT live time whenever you open it. Seeding on MOUSEDOWN runs BEFORE
// the native picker opens, so the dropdown ITSELF starts at "now" (focus alone fired too late — the
// picker had already captured the old value, so the field only updated after closing). focus also
// seeds it to cover keyboard/tab entry.
const seedDropNow = () => { dropTimeEl.value = nowTimeInTz(tzSelect.value); };
dropTimeEl.addEventListener('mousedown', seedDropNow);
dropTimeEl.addEventListener('focus', () => {
  seedDropNow();
  dropTimeAtFocus = dropTimeEl.value; dropTimeTyped = false;
});
dropTimeEl.addEventListener('keydown', () => { dropTimeTyped = true; });
dropTimeEl.addEventListener('change', (e) => {
  if (e.target.value && !dropTimeTyped) e.target.blur(); // picked from dropdown/spinner → close it
  dropTimeTyped = false;                                 // reset for the next interaction
});
dropTimeEl.addEventListener('blur', () => {
  if (dropInterval && dropTimeEl.value && dropTimeEl.value !== dropTimeAtFocus) armFromFields();
});
// Same for the lead-seconds and Test toggle: if armed, changing them updates the live countdown.
document.getElementById('leadSec').addEventListener('change', () => { if (dropInterval) armFromFields(); });
document.getElementById('armTest').addEventListener('change', () => { if (dropInterval) armFromFields(); });

// ── Auto-detect item ID from the current tab's URL (fills the SKU / Link field) ──
document.getElementById('useCurrentTab').addEventListener('change', async function () {
  if (!this.checked) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: MY_WID });
    const id = extractItemId(tab && tab.url || '', activeProfile);
    if (!id) { addLog('warning', 'Could not detect an item ID from this tab\'s URL'); return; }
    document.getElementById('itemSku').value = id;
    addLog('info', 'Detected item ID: "' + id + '"');
  } catch (e) {
    addLog('warning', 'Could not auto-detect item');
  }
});

// ── On popup open: restore last store, then unlock (cached key, or PIN) ─────────
(async () => {
  // 0) Identify which browser window this panel belongs to (basis for per-window bots), and map
  //    the raw window id to a friendly "Bot N" label.
  try {
    MY_WID = await resolveMyWid();
    MY_BOT_NUM = await assignBotNumber(MY_WID);
    addLog('info', '🤖 Bot ' + MY_BOT_NUM + ' — panel ready (v' + chrome.runtime.getManifest().version + ') [w' + MY_WID + ']');
    const sub = document.querySelector('.subtitle');
    if (sub) sub.textContent = 'Bot ' + MY_BOT_NUM;
    await restoreTrackToggle(); // reflect THIS window's own tracker toggle (per-bot)
  } catch (e) { addLog('error', 'Could not get window id: ' + e.message); }

  // 1) Reopen on the store THIS WINDOW was last using (per-window key; global as fallback)
  const lpAll = await chrome.storage.local.get(['lastProfile:w' + MY_WID, 'lastProfile']);
  const lastProfile = lpAll['lastProfile:w' + MY_WID] || lpAll.lastProfile;
  if (lastProfile && STORE_NAV[lastProfile]) {
    activeProfile = lastProfile;
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.profile === activeProfile));
  }

  // 1b) …but if THIS tab is on a known store site, auto-select THAT store's profile — so opening the
  // sidebar on target.com picks 🎯 Target, samsclub.com picks 🏪 Sam's, etc. (avoids the "wrong store
  // tab" footgun). Overrides the last-used profile above.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = (tab && tab.url || '').toLowerCase();
    const siteProfile =
      /samsclub\.com/.test(host)      ? 'sams' :
      /target\.com/.test(host)        ? 'target' :
      /walmart\.com/.test(host)       ? 'walmart' :
      /bestbuy\.com/.test(host)       ? 'bestbuy' :
      /pokemoncenter\.com/.test(host) ? 'pokemoncenter' : null;
    if (siteProfile && STORE_NAV[siteProfile] && siteProfile !== activeProfile) {
      activeProfile = siteProfile;
      document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.profile === activeProfile));
      addLog('info', 'Auto-selected ' + profileLabel(activeProfile) + ' (matches this tab).');
    }
  } catch (_) {}
  applyWatchlistVisibility();

  const { pinSalt, botRunning, pinLockUntil = 0 } = await wget(['pinSalt', 'botRunning', 'pinLockUntil']);
  if (pinSalt) {
    // Within the unlock window? Skip the PIN using the cached key.
    if (await tryRestoreKey()) {
      await loadProfileConfig(activeProfile);
    } else if (botRunning) {
      // A bot is ALREADY running in this window — don't block the panel with a PIN prompt (e.g. when
      // the panel auto-reloads on a new tab and the cached key isn't available). The bot keeps
      // running on its captured config; the form just stays empty until you unlock to edit it.
      addLog('info', '🔓 Bot running — PIN not required while it’s active.');
    } else {
      showLock('unlock');         // PIN expired/never entered — require it
      if (pinLockUntil && Date.now() < pinLockUntil) showLockedCountdown(pinLockUntil);
    }
  } else {
    // No PIN yet — migrate any legacy plaintext config so it carries over + gets encrypted.
    const legacy = await chrome.storage.local.get('botConfig_' + activeProfile);
    const cfg = legacy['botConfig_' + activeProfile];
    if (cfg) writeForm(cfg); else clearForm();
    await applyPerWindowUI(); // Quantity & Max Price are per-window
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
      const t = new Date(armState.target).toLocaleTimeString('en-US', { hour12: false, timeZone: armState.tz });
      dropTimeEl.value = t; // show the armed time on restore (resets to "now" next time you open the picker)
      addLog('info', '🎯 Arm restored → ' + t + ' ' + (TZ_ABBR[armState.tz] || '') + ' · still counting down');
    } else {
      wremove('armState');
    }
  }
})();

// ── Messages from content script ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  // Per-window routing: a message tagged with a wid belongs to THAT window's panel only. Untagged
  // messages (background-origin, or the localhost Sam's flow) are shown everywhere as before.
  if (msg.wid != null && msg.wid !== MY_WID) return;
  if (msg.type === 'TRACK') {
    // Tracker output belongs ONLY to the panel of the window where the interaction happened —
    // the source tab's window (from sender.tab) tells us which. So each bot has its own track log.
    if (!clickTrackOn) return; // this bot's tracker is OFF — don't show (shared script runs browser-wide)
    if (sender && sender.tab && MY_WID != null && sender.tab.windowId !== MY_WID) return;
    // Log the interacted element's CODE so it can be copied out to tune a store. `kind` is the
    // gesture (CLICK / HOLD / DRAG); `extra` carries hold time or drag distance+direction.
    const icon = msg.kind === 'DRAG' ? '✋' : (msg.kind === 'HOLD' ? '⏳' : '👆');
    const label = (msg.kind || 'CLICK').toLowerCase();
    const ex = msg.extra ? ' (' + msg.extra + ')' : '';
    addLog('info', icon + ' ' + label + ex + ' @' + (msg.path || '') + (msg.text ? '  "' + msg.text + '"' : ''));
    addLog('success', '   ' + (msg.html || msg.tag || ''));
    return;
  }
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
  // Prefer showing your POSITION (#ticket) — with the ETA appended when we have both (Walmart).
  est.textContent = (info && info.pos) ? ('#' + info.pos + (info.est ? ' · ' + info.est : ''))
                  : (info && info.est) ? info.est : 'in line';
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

    // Drop watchlist (all stores): watch multiple drop links and grab the first that goes live.
    // For Walmart use the STABLE walmart.com/ip/<id> links (the same every drop) — NOT the buff.ly
    // short links, which change per drop and carry no item ID.
    // "Use current tab" WINS over the watchlist: checked = run on the page you're on;
    // unchecked = cycle the drop watchlist.
    const rawWatch = !cfg.useCurrentTab ? (cfg.watchlist || '').trim() : '';
    const watchIds = rawWatch ? parseWatchlist(rawWatch, activeProfile) : [];
    let watchMode = watchIds.length > 0;
    // Sam's still runs the legacy (non-adapter) flow which can't rotate a watchlist — fall back to
    // watching the FIRST item via the normal single-SKU path so Start still does something sane.
    if (watchMode && activeProfile === 'sams') {
      if (watchIds.length > 1) addLog('warning', "👁 Sam's watchlist is single-item for now — using the first item only.");
      cfg.itemSku = watchIds[0];
      watchMode = false;
    }
    if (rawWatch && !watchMode) {
      addLog('error', '👁 Watchlist has text but no ' + profileLabel(activeProfile).replace(' Bot', '') + ' item IDs found — paste product links or bare IDs (short links won\'t work).');
      return;
    }
    // Tell the user the watchlist is being skipped so a checked box never LOOKS like a broken watchlist.
    if (cfg.useCurrentTab && (cfg.watchlist || '').trim())
      addLog('info', '👁 Watchlist ignored — "Use current tab" is checked (uncheck it to run the watchlist).');
    if (watchMode) cfg.watchlist = watchIds; else delete cfg.watchlist;

    const identifier = (cfg.itemSku || '').trim();
    if (!cfg.useCurrentTab && !watchMode && !identifier) {
      addLog('error', 'Enter a SKU / link first (or fill the drop watchlist)!');
      return;
    }

    // Store "search & navigate" mode: a store profile with "use current tab" UNCHECKED (not watchlist).
    const navStore = STORE_NAV[activeProfile];
    const samsSearchMode = !!navStore && !cfg.useCurrentTab && !watchMode;
    if (samsSearchMode) cfg.samsSearch = true; // background uses this to inject on navigation

    addLog('info', cfg.useCurrentTab ? 'Using current tab' : (watchMode ? 'Watchlist: ' + watchIds.length + ' items' : 'SKU / Link: "' + identifier + '"'));

    // HARD RESET: wipe any leftover state from a previous (possibly stuck) run so a new
    // run never inherits stale pointers/flags. Background detaches any stale debugger.
    await wremove(['currentTabId', 'queueSince']);
    chrome.storage.local.remove(['w' + MY_WID + ':orderDone', 'w' + MY_WID + ':workingItem']).catch(() => {}); // clear last run's order/off-course flags
    stopQueueTimer(); stopCheckoutTimer();
    chrome.runtime.sendMessage({ type: 'RESET_BOT' }).catch(() => {});

    // Persist the encrypted copy, and a TEMPORARY plaintext copy the bot reads during the run.
    await saveProfileConfig(activeProfile);
    // Embed the Test flag INSIDE the run config so it's captured atomically with this run and can't
    // go stale relative to a separate key — the checkout guards read cfg.testMode as the source of
    // truth, so a Test run can never be mistaken for a real one.
    cfg.testMode = !!testMode;
    // Fresh run flags: qtyDone (quantity), samsFellBack (SKU fallback), addAttempts (stuck guard)
    await wset({ botRunning: true, botPhase: 'SEARCH', botConfig: cfg, activeProfile, qtyDone: false, samsFellBack: false, addAttempts: 0, pokePlaceRetries: 0, botTestMode: !!testMode, botRunToken: Date.now(), watchIndex: 0 });
    if (testMode) addLog('info', '🧪 TEST MODE: full flow will run but the order will NOT be submitted.');
    setRunningUI(true);

    if (watchMode) {
      // Watchlist: drive THIS window's active tab through the drop links; the bot rotates to the
      // next item when one is out of stock, and locks in when one goes live.
      const url = navStore.item(watchIds[0]);
      const tab = await activeTabInMyWindow();
      if (!tab) { addLog('error', 'No active tab — open a store tab in this window, then Start.'); setRunningUI(false); return; }
      await wset({ currentTabId: tab.id, watchIndex: 0 });
      // If we're ALREADY on the first item's page, a same-URL tabs.update won't reload it (so the
      // bot would never inject). Walmart: RELOAD — executeScript stalls on walmart tabs, so the
      // bot rides the manifest content script, which only runs on a fresh document. Other stores:
      // force executeScript injection directly.
      const onFirst = (tab.url || '').includes(String(watchIds[0]));
      if (onFirst && activeProfile === 'walmart') {
        try {
          await chrome.tabs.reload(tab.id);
          addLog('info', '🔄 Reload requested for tab ' + tab.id + ' (w' + tab.windowId + ') @ ' + (tab.url || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 45));
        } catch (e) { addLog('error', '🔄 tabs.reload FAILED: ' + (e && e.message || e)); }
        addLog('info', '⏳ Reloading the Walmart page — the bot loads WITH the page. First load after a store switch can take 30-60s (anti-bot slow-load); leave it running.');
        monitorWalmartLoad(tab.id); // fire-and-forget: narrates the load state every 5s
      } else if (onFirst) {
        chrome.runtime.sendMessage({ type: 'INJECT_BOT', tabId: tab.id, url: tab.url });
      } else {
        await chrome.tabs.update(tab.id, { url, active: true });
      }
      addLog('success', '👁 Watchlist: monitoring ' + watchIds.length + ' items — starting with #' + watchIds[0] + (onFirst ? ' (injecting here)' : ''));
    } else if (cfg.useCurrentTab) {
      const tab = await activeTabInMyWindow();
      if (!tab) { addLog('error', 'No active tab found — click the store tab, then Start.'); setRunningUI(false); return; }
      const okPage = /^https?:\/\//.test(tab.url || '');
      if (!okPage) { addLog('error', 'Current tab is "' + (tab.url || 'blank') + '" — open the STORE PAGE in this tab, then Start.'); setRunningUI(false); return; }
      await wset({ currentTabId: tab.id });
      // Walmart: reload so the MANIFEST content script injects on the fresh document —
      // executeScript stalls on walmart tabs (stamp/files timeouts, bot never runs).
      if (activeProfile === 'walmart') {
        try {
          await chrome.tabs.reload(tab.id);
          addLog('info', '🔄 Reload requested for tab ' + tab.id + ' (w' + tab.windowId + ') @ ' + (tab.url || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 45));
        } catch (e) { addLog('error', '🔄 tabs.reload FAILED: ' + (e && e.message || e)); }
        addLog('info', '⏳ Reloading the Walmart page — the bot loads WITH the page. First load after a store switch can take 30-60s (anti-bot slow-load); leave it running.');
        monitorWalmartLoad(tab.id); // fire-and-forget: narrates the load state every 5s
      } else chrome.runtime.sendMessage({ type: 'INJECT_BOT', tabId: tab.id, url: tab.url });
      addLog('success', 'Bot injected → ' + (tab.url || '').replace(/^https?:\/\//, '').slice(0, 45));
    } else {
      // SKU / Link → direct product URL. The field accepts a full store LINK (used as-is),
      // a link the store's ID pattern recognizes (ID extracted), or a bare item ID.
      const id = extractItemId(identifier, activeProfile);
      const url = id ? navStore.item(id)
        : (/^https?:\/\//i.test(identifier) ? identifier : navStore.item(identifier));
      addLog('info', 'Opening ' + navStore.name + ': ' + url);
      const tab = await activeTabInMyWindow();
      await wset({ currentTabId: tab.id });
      await chrome.tabs.update(tab.id, { url, active: true });
      addLog('success', 'Going to item…');
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
  while (log.children.length > 200) log.removeChild(log.lastChild); // hold plenty for click-tracking
}
function clearLog() { document.getElementById('log').innerHTML = ''; }
// Copy the whole log (oldest → newest, i.e. reading order) to the clipboard for pasting.
async function copyLog() {
  const entries = Array.from(document.querySelectorAll('#log .log-entry')).map(e => e.textContent).reverse();
  const btn = document.getElementById('copyLogBtn');
  try {
    await navigator.clipboard.writeText(entries.join('\n'));
    if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
  } catch (e) { addLog('error', 'Copy failed: ' + e.message); }
}
