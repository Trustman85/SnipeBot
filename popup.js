// All config field IDs — used to save/restore form values from storage
const FIELDS = ['siteUrl','useCurrentTab','itemName','itemSku','searchType','maxPrice','refreshInterval',
                'firstName','lastName','email','address','city','state','zip',
                'cardNumber','cardName','expiry','cvv','stopOnSuccess'];

// Tracks which profile is active — each profile has its own saved config
let activeProfile = 'default';

// ── Profile switcher (top tabs) ────────────────────────────────────────────────
// Switching profiles saves the current form and loads the selected profile's config
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    if (tab.dataset.profile === activeProfile) return;
    // Save current profile before switching
    await saveProfileConfig(activeProfile);
    // Switch profile
    activeProfile = tab.dataset.profile;
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    // Load new profile's config into the form
    await loadProfileConfig(activeProfile);
    updateStartLabel();
    addLog('info', 'Switched to ' + (activeProfile === 'sams' ? "Sam's Bot" : 'Bot'));
  });
});

// Save form values under a profile-specific storage key
async function saveProfileConfig(profile) {
  const cfg = {};
  FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    cfg[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  await chrome.storage.local.set({ ['botConfig_' + profile]: cfg });
}

// Load a profile's config into the form
async function loadProfileConfig(profile) {
  const key  = 'botConfig_' + profile;
  const data = await chrome.storage.local.get(key);
  const cfg  = data[key];
  if (!cfg) return;
  FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.type === 'checkbox' ? el.checked = cfg[id] ?? true : el.value = cfg[id] || '';
  });
  // Restore search type toggle
  const type = cfg.searchType || 'name';
  document.querySelectorAll('.search-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.getElementById('nameGroup').style.display = type === 'name' ? '' : 'none';
  document.getElementById('skuGroup').style.display  = type === 'sku'  ? '' : 'none';
}

// ── Sub-tab switching (Item / Address / Payment) ───────────────────────────────
// Highlight the active tab and show its panel when clicked
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// Update the bottom start button label to show which profile is active
function updateStartLabel() {
  const btn     = document.getElementById('startBtn');
  const label   = activeProfile === 'sams' ? "Sam's Bot" : 'Bot';
  const running = btn.classList.contains('running');
  btn.textContent = running ? ('⏹ Stop ' + label) : ('▶ Start ' + label);
}

// ── Search type toggle (By Name / By SKU) ─────────────────────────────────────
// Show the relevant input group based on which search type is selected
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
// MV3 CSP blocks inline onclick handlers, so event listeners are attached here
document.getElementById('startBtn').addEventListener('click', toggleBot);
document.getElementById('saveBtn').addEventListener('click', saveConfig);
document.getElementById('clearBtn').addEventListener('click', clearLog);
document.getElementById('closeBtn').addEventListener('click', () => window.close());

// Stop the bot when the sidebar is closed
window.addEventListener('unload', () => {
  chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
  chrome.runtime.sendMessage({ type: 'STOP_BOT' }).catch(() => {});
});

// ── Auto-detect item name/SKU from current tab ───────────────────────────────
// When "Use current tab" is checked, read the item identifier from the active page.
// Checks URL params first (id = SKU, search = name), then falls back to h1/title.
document.getElementById('useCurrentTab').addEventListener('change', async function () {
  if (!this.checked) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const params = new URLSearchParams(window.location.search);
        // SKU present in URL — use it directly
        if (params.get('id')) return { type: 'sku', value: params.get('id') };
        // Name search present in URL — use it directly
        if (params.get('search')) return { type: 'name', value: params.get('search') };
        // Fall back to reading the product title from the DOM
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

// ── Restore saved config on popup open ────────────────────────────────────────
// Load the active profile's config and restore running state
(async () => {
  await loadProfileConfig(activeProfile);
  const { botRunning } = await chrome.storage.local.get('botRunning');
  if (botRunning) setRunningUI(true);
  updateStartLabel();
})();

// ── Listen for messages from content script (relayed via background) ───────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'BOT_LOG')    addLog(msg.level, msg.text);    // Add entry to activity log
  if (msg.type === 'BOT_STATUS') setStatus(msg.status, msg.text); // Update status bar
  if (msg.type === 'BOT_DONE')   setRunningUI(false);             // Reset start button
});

// ── Save config ────────────────────────────────────────────────────────────────
// Persist the current form values under the active profile's storage key
function saveConfig() {
  const cfg = {};
  FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    cfg[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  const label = activeProfile === 'sams' ? "Sam's Bot" : 'Bot';
  chrome.storage.local.set({ ['botConfig_' + activeProfile]: cfg }, () => addLog('success', label + ' config saved ✓'));
}

// ── Start / Stop bot ───────────────────────────────────────────────────────────
// Toggles the bot on or off depending on current running state
async function toggleBot() {
  addLog('info', 'Button clicked...');
  try {
    const data = await chrome.storage.local.get('botRunning');

    // If already running, stop it
    if (data.botRunning) {
      chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
      setRunningUI(false);
      addLog('warning', 'Bot stopped by user');
      return;
    }

    // Collect all config values from the form
    const cfg = {};
    FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      cfg[id] = el.type === 'checkbox' ? el.checked : el.value;
    });

    const searchType = cfg.searchType || 'name';
    const identifier = searchType === 'sku' ? cfg.itemSku : cfg.itemName;

    // Only require an item name/SKU when navigating to a site — not needed for current tab
    if (!cfg.useCurrentTab && !identifier) {
      addLog('error', searchType === 'sku' ? 'Enter a SKU first!' : 'Enter an item name first!');
      return;
    }

    addLog('info', cfg.useCurrentTab ? 'Using current tab' : 'Search type: ' + searchType + ' | Value: "' + identifier + '"');

    // Save state and update UI — store config and active profile so content.js knows which bot is running
    await chrome.storage.local.set({ botRunning: true, botPhase: 'SEARCH', botConfig: cfg, activeProfile, ['botConfig_' + activeProfile]: cfg });
    setRunningUI(true);

    const siteUrl = (cfg.siteUrl || 'http://localhost:3000').replace(/\/$/, '');

    if (cfg.useCurrentTab) {
      // Inject content.js into whatever tab the user is currently on
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.storage.local.set({ currentTabId: tab.id });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__checkoutBotInit = false; } });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      addLog('success', 'Bot injected into current tab');
    } else {
      // Build URL and navigate to the configured site
      const url = searchType === 'sku'
        ? siteUrl + '/product.html?id='     + encodeURIComponent(cfg.itemSku)
        : siteUrl + '/product.html?search=' + encodeURIComponent(cfg.itemName);

      addLog('info', 'Navigating to: ' + url);
      const tabs = await chrome.tabs.query({ url: siteUrl + '/*' });

      // Reuse an existing tab on the configured site if available
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

// Update the start button and status bar to reflect running or idle state
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

// Update the status dot color and text
function setStatus(state, text) {
  document.getElementById('statusDot').className = 'status-dot ' + state;
  document.getElementById('statusText').textContent = text;
}

// Prepend a timestamped log entry and cap the log at 50 entries
function addLog(level, text) {
  const log = document.getElementById('log');
  const e   = document.createElement('div');
  e.className = 'log-entry ' + level;
  const t = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  e.textContent = '[' + t + '] ' + text;
  log.prepend(e);
  while (log.children.length > 50) log.removeChild(log.lastChild);
}

// Clear all entries from the activity log
function clearLog() { document.getElementById('log').innerHTML = ''; }
