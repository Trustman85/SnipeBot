// All config field IDs — used to save/restore form values
const FIELDS = ['siteUrl','useCurrentTab','itemName','itemSku','searchType','maxPrice','refreshInterval',
                'firstName','lastName','email','address','city','state','zip',
                'cardNumber','cardName','expiry','cvv','stopOnSuccess'];

let activeProfile = 'default';
let cryptoKey = null;     // AES-GCM key derived from the PIN (in memory only, never stored)
let lockMode  = 'unlock'; // 'unlock' (PIN exists) or 'create' (first-time PIN setup)

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
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
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
  writeForm({ siteUrl: 'http://localhost:3000', maxPrice: '999', refreshInterval: '2',
              stopOnSuccess: true, useCurrentTab: false, searchType: 'name' });
}

// ── PIN lock overlay ───────────────────────────────────────────────────────────
function showLock(mode) {
  lockMode = mode;
  document.getElementById('lockOverlay').style.display = 'flex';
  document.getElementById('lockError').textContent = '';
  document.getElementById('pinInput').value = '';
  document.getElementById('pinConfirm').value = '';
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

document.getElementById('unlockBtn').addEventListener('click', handlePin);
document.getElementById('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') handlePin(); });
document.getElementById('pinConfirm').addEventListener('keydown', e => { if (e.key === 'Enter') handlePin(); });

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
    hideLock();
    await saveProfileConfig(activeProfile); // persist current form encrypted
    addLog('success', 'PIN set — saved data is now encrypted');
  } else {
    // Unlock: derive key from PIN + stored salt, verify against the check token
    const { pinSalt, pinCheck } = await chrome.storage.local.get(['pinSalt', 'pinCheck']);
    try {
      const key = await deriveKey(pin, ub64(pinSalt));
      const v = await decryptObj(key, pinCheck);
      if (v.v !== 'VALID') throw new Error('bad');
      cryptoKey = key;
      hideLock();
      await loadProfileConfig(activeProfile);
      addLog('success', 'Unlocked');
    } catch (_) {
      err.textContent = 'Wrong PIN';
    }
  }
}

// ── Encrypted per-profile save/load ──────────────────────────────────────────
async function saveProfileConfig(profile) {
  if (!cryptoKey) return; // locked / no PIN yet
  const blob = await encryptObj(cryptoKey, readForm());
  await chrome.storage.local.set({ ['botConfigEnc_' + profile]: blob });
}
async function loadProfileConfig(profile) {
  if (!cryptoKey) return;
  const key = 'botConfigEnc_' + profile;
  const data = await chrome.storage.local.get(key);
  if (!data[key]) { clearForm(); return; }
  try { writeForm(await decryptObj(cryptoKey, data[key])); }
  catch (_) { clearForm(); addLog('warning', 'Could not decrypt ' + profile + ' config'); }
}

// ── Profile switcher (top tabs) ────────────────────────────────────────────────
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    if (tab.dataset.profile === activeProfile) return;
    await saveProfileConfig(activeProfile);
    activeProfile = tab.dataset.profile;
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    await loadProfileConfig(activeProfile);
    updateStartLabel();
    addLog('info', 'Switched to ' + (activeProfile === 'sams' ? "Sam's Bot" : 'Bot'));
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
  const label   = activeProfile === 'sams' ? "Sam's Bot" : 'Bot';
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
document.getElementById('startBtn').addEventListener('click', toggleBot);
document.getElementById('saveBtn').addEventListener('click', saveConfig);
document.getElementById('clearBtn').addEventListener('click', clearLog);
document.getElementById('closeBtn').addEventListener('click', () => window.close());

// Stop the bot + wipe the temporary plaintext config when the sidebar is closed
window.addEventListener('unload', () => {
  chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
  chrome.storage.local.remove('botConfig');
  chrome.runtime.sendMessage({ type: 'STOP_BOT' }).catch(() => {});
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

// ── On popup open: lock if a PIN exists, else first-time (no lock yet) ──────────
(async () => {
  const { pinSalt, botRunning } = await chrome.storage.local.get(['pinSalt', 'botRunning']);
  if (pinSalt) {
    showLock('unlock');           // PIN exists — require unlock before anything
  } else {
    // No PIN yet — migrate any legacy plaintext config into the form so the user's
    // existing address/card carry over and get encrypted when they set a PIN.
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
  if (msg.type === 'BOT_DONE') {
    setRunningUI(false);
    chrome.storage.local.remove('botConfig'); // wipe temp plaintext once the run ends
  }
});

// ── Save config (encrypted) ──────────────────────────────────────────────────
async function saveConfig() {
  if (!cryptoKey) { showLock('create'); return; } // first save sets the PIN
  await saveProfileConfig(activeProfile);
  const label = activeProfile === 'sams' ? "Sam's Bot" : 'Bot';
  addLog('success', label + ' config saved ✓ (encrypted)');
}

// ── Start / Stop bot ───────────────────────────────────────────────────────────
async function toggleBot() {
  addLog('info', 'Button clicked...');
  try {
    const data = await chrome.storage.local.get('botRunning');
    if (data.botRunning) {
      chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
      chrome.storage.local.remove('botConfig'); // wipe temp plaintext on stop
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

    addLog('info', cfg.useCurrentTab ? 'Using current tab' : 'Search type: ' + searchType + ' | Value: "' + identifier + '"');

    // Persist the encrypted copy, and a TEMPORARY plaintext copy the bot reads during the run.
    // The temp copy is removed on stop / done / sidebar-close.
    await saveProfileConfig(activeProfile);
    await chrome.storage.local.set({ botRunning: true, botPhase: 'SEARCH', botConfig: cfg, activeProfile });
    setRunningUI(true);

    const siteUrl = (cfg.siteUrl || 'http://localhost:3000').replace(/\/$/, '');
    if (cfg.useCurrentTab) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.storage.local.set({ currentTabId: tab.id });
      chrome.runtime.sendMessage({ type: 'INJECT_BOT', tabId: tab.id, url: tab.url });
      addLog('success', 'Bot injected into current tab');
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
  const label = activeProfile === 'sams' ? "Sam's Bot" : 'Bot';
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
