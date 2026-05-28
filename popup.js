// All config field IDs — used to save/restore form values from storage
const FIELDS = ['siteUrl','useCurrentTab','itemName','itemSku','searchType','maxPrice','refreshInterval',
                'firstName','lastName','email','address','city','state','zip',
                'cardNumber','cardName','expiry','cvv','stopOnSuccess'];

// ── Tab switching ──────────────────────────────────────────────────────────────
// Highlight the active tab and show its panel when clicked
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

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

// ── Restore saved config on popup open ────────────────────────────────────────
// Load previously saved config from storage and re-populate the form
chrome.storage.local.get(['botConfig', 'botRunning'], data => {
  if (data.botConfig) {
    const cfg = data.botConfig;
    FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.type === 'checkbox' ? el.checked = cfg[id] ?? true : el.value = cfg[id] || '';
    });
    // Restore the search type toggle UI to match saved config
    const type = cfg.searchType || 'name';
    document.querySelectorAll('.search-type-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.type === type);
    });
    document.getElementById('nameGroup').style.display = type === 'name' ? '' : 'none';
    document.getElementById('skuGroup').style.display  = type === 'sku'  ? '' : 'none';
  }
  // If the bot is already running, update the UI to reflect that
  if (data.botRunning) setRunningUI(true);
});

// ── Listen for messages from content script (relayed via background) ───────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'BOT_LOG')    addLog(msg.level, msg.text);    // Add entry to activity log
  if (msg.type === 'BOT_STATUS') setStatus(msg.status, msg.text); // Update status bar
  if (msg.type === 'BOT_DONE')   setRunningUI(false);             // Reset start button
});

// ── Save config ────────────────────────────────────────────────────────────────
// Read all form values and persist them to chrome.storage.local
function saveConfig() {
  const cfg = {};
  FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    cfg[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  chrome.storage.local.set({ botConfig: cfg }, () => addLog('success', 'Configuration saved ✓'));
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

    // Require an item name or SKU before starting
    if (!identifier) {
      addLog('error', searchType === 'sku' ? 'Enter a SKU first!' : 'Enter an item name first!');
      return;
    }

    addLog('info', 'Search type: ' + searchType + ' | Value: "' + identifier + '"');

    // Save state and update UI
    await chrome.storage.local.set({ botRunning: true, botPhase: 'SEARCH', botConfig: cfg });
    setRunningUI(true);

    const siteUrl = (cfg.siteUrl || 'http://localhost:3000').replace(/\/$/, '');

    if (cfg.useCurrentTab) {
      // Inject content.js into whatever tab the user is currently on
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.storage.local.set({ currentTabId: tab.id });
      // Reset the guard so content.js can run again on an already-loaded page
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
  const btn = document.getElementById('startBtn');
  if (running) {
    btn.textContent = '⏹ Stop Bot';
    btn.classList.add('running');
    setStatus('running', 'Bot is running...');
  } else {
    btn.textContent = '▶ Start Bot';
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
