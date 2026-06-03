// Open the side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Keep the service worker alive while bot is running so it can re-inject content.js on page reloads.
// Chrome kills idle service workers after ~30s — this alarm fires every 25s to prevent that.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'keepalive') return;
  const { botRunning } = await chrome.storage.local.get('botRunning');
  if (!botRunning) chrome.alarms.clear('keepalive');
});

// Holds the reference to the OOS retry timer so we can cancel it if the user stops the bot
let botInterval = null;

// Tracks the last URL we injected into, to avoid re-injecting when an SPA fires
// "complete" multiple times for the SAME page (which caused duplicate racing runs).
let lastInjectedUrl = '';
let lastInjectAt = 0;

// Single injection gate — ALL injection (initial from popup + re-injection on
// navigation) goes through here, so the dedup tracker covers every path.
async function injectBot(tabId, url) {
  const now = Date.now();
  // Skip a repeat injection of the same URL within 3s (SPA firing complete repeatedly)
  if (url && url === lastInjectedUrl && now - lastInjectAt < 3000) return;
  lastInjectedUrl = url || '';
  lastInjectAt = now;
  // content.js guards itself by URL, so no external flag reset is needed
  // sams.js must be injected before content.js so its helpers are in scope
  await chrome.scripting.executeScript({ target: { tabId }, files: ['sams.js', 'content.js'] });
}

// When using current tab mode, re-inject content.js every time the tab finishes loading
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const { botRunning, botConfig, currentTabId } = await chrome.storage.local.get(['botRunning', 'botConfig', 'currentTabId']);
  if (!botRunning || !botConfig?.useCurrentTab) return;
  if (tabId !== currentTabId) return;
  await injectBot(tabId, tab?.url || '');
});

// Central message listener — background script is always alive and receives messages from popup and content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Popup sent START_BOT — kick off the bot with the user's config
  if (msg.type === 'START_BOT') startBot(msg.config);

  // Popup sent STOP_BOT — cancel any timers and reset state
  if (msg.type === 'STOP_BOT') stopBot();

  // Popup requested initial injection into the current tab — routed through the same dedup gate
  if (msg.type === 'INJECT_BOT') injectBot(msg.tabId, msg.url);

  // Sam's CVV + Place Order — must run in the page's MAIN world to reach React's state
  if (msg.type === 'SAMS_CHECKOUT') samsCheckout(sender.tab?.id, msg.cvv);

  // NOTE: BOT_LOG / BOT_STATUS / BOT_DONE are NOT relayed here — the side panel
  // receives them directly from content.js. Relaying caused every log to appear twice.
});

// Runs in the page's MAIN world to fill the CVV the way React expects, then click Place Order.
// In the main world we can reach el._valueTracker, which the isolated content-script world cannot.
async function samsCheckout(tabId, cvv) {
  if (!tabId) { log('error', 'SAMS_CHECKOUT: no tab id'); return; }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [cvv],
    func: async (cvv) => {
      const el = document.getElementById('cvv-field') ||
                 document.querySelector('[id*="cvv-field"], [name="cvv"][type="password"]');
      if (!el) return { ok: false, reason: 'CVV field not found' };

      // Sam's uses React Aria — it commits state from real beforeinput/input events.
      // execCommand('insertText') simulates genuine typing, which React Aria accepts;
      // a plain value-set + synthetic event does NOT update its internal state.
      el.focus();
      el.click();
      // Clear any existing content via selection
      el.setSelectionRange?.(0, el.value.length);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      // Type each digit so React Aria registers every keystroke
      let typed = '';
      for (const ch of String(cvv)) {
        document.execCommand('insertText', false, ch);
        typed += ch;
      }

      // Fallback: if typing didn't land, set value + reset tracker + input event
      if (el.value !== String(cvv)) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (el._valueTracker) el._valueTracker.setValue('');
        setter.call(el, String(cvv));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(cvv), inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // STOP after CVV is entered — do not click Place Order (verifying value)
      await new Promise(r => setTimeout(r, 600));
      const valueNow = el.value;
      const cvvOk = valueNow === String(cvv);
      let clicked = false;
      return { ok: true, value: valueNow, method: cvvOk ? 'typed' : 'setter', clicked };
    }
  });

  const r = result?.result || {};
  if (!r.ok) { log('error', 'CVV fill failed: ' + (r.reason || 'unknown')); return; }
  log('success', 'CVV typed in page: "' + r.value + '" (method: ' + r.method + ') — stopped, Place Order NOT clicked');
}

// Initializes bot state in storage and opens (or reuses) a localhost tab on the product page
async function startBot(config) {

  // Start keepalive alarm so the service worker stays alive during bot operation
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });

  // Log to the popup that the background script received the start signal
  log('info', 'Background: bot started');

  // Persist bot state so the content script knows it should run when the page loads
  await chrome.storage.local.set({
    botRunning: true,       // Tells content script the bot is active
    botPhase: 'SEARCH',     // First phase — content script will check stock on product page
    botConfig: config       // Full user config (item, address, payment, settings)
  });

  // Check if there is already a tab open on localhost:3000
  const tabs = await chrome.tabs.query({ url: 'http://localhost:3000/*' });

  // Build the product page URL using the item name from config
  const url = 'http://localhost:3000/product.html?search=' + encodeURIComponent(config.itemName);

  // Reuse the existing tab if found — avoids opening multiple tabs on repeated runs
  if (tabs.length > 0) await chrome.tabs.update(tabs[0].id, { url });

  // No existing tab — open a brand new one pointing at the product page
  else await chrome.tabs.create({ url });
}

// Stops the bot by clearing any pending retry timer and resetting storage state
function stopBot() {

  // Stop the keepalive alarm
  chrome.alarms.clear('keepalive');

  // Cancel the OOS retry timer if it's currently counting down
  if (botInterval) {
    clearInterval(botInterval); // Stop the timer
    botInterval = null;         // Clear the reference so it can be garbage collected
  }

  // Update storage so the content script won't act on the next page load
  chrome.storage.local.set({
    botRunning: false,    // Tells content script to do nothing
    botPhase: 'IDLE'      // Reset phase back to idle
  });

  // Notify the popup so it can update the UI
  log('warning', 'Background: bot stopped');
}

// Helper — sends a log message to the popup's activity log
// level controls the color: 'info' (blue), 'success' (green), 'warning' (yellow), 'error' (red)
function log(level, text) {
  // .catch(()=>{}) prevents unhandled errors when the popup window is not open
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text }).catch(() => {});
}
