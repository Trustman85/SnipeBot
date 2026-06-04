// Open the side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Stop the bot whenever the extension is reloaded/updated or Chrome restarts,
// so a refresh of the extension always leaves it in a clean stopped state.
chrome.runtime.onInstalled.addListener(() => stopBot());
chrome.runtime.onStartup.addListener(() => stopBot());

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

  // Popup requested initial injection into the current tab — routed through the same dedup gate.
  // Clear any stale debugger attachment first so it can't block page clicks this run.
  if (msg.type === 'INJECT_BOT') detachAllDebuggers().then(() => injectBot(msg.tabId, msg.url));

  // Sam's CVV + Place Order — must run in the page's MAIN world to reach React's state
  if (msg.type === 'SAMS_CHECKOUT') samsCheckout(sender.tab?.id, msg.cvv);

  // NOTE: BOT_LOG / BOT_STATUS / BOT_DONE are NOT relayed here — the side panel
  // receives them directly from content.js. Relaying caused every log to appear twice.
});

// Fills the CVV and clicks Place Order using the Chrome DevTools Protocol (chrome.debugger).
// CDP dispatches REAL, trusted browser-level input — indistinguishable from a human — so
// React Aria commits the value to its state every time (synthetic DOM events did not).
async function samsCheckout(tabId, cvv) {
  if (!tabId) { log('error', 'SAMS_CHECKOUT: no tab id'); return; }

  const dbg = { tabId };
  try {
    await chrome.debugger.attach(dbg, '1.3');

    // 1. Scroll the CVV field into view and get its center coordinates (CSS px, viewport-relative)
    const cvvPt = await elementPoint(tabId, 'document.getElementById("cvv-field") || document.querySelector(\'[id*="cvv-field"],[name="cvv"][type="password"]\')');
    if (!cvvPt) { log('error', 'CVV field not found'); return; }

    // 2. Real mouse click into the CVV field to focus it
    await cdpClick(dbg, cvvPt.x, cvvPt.y);
    await sleep(150);

    // 3. Type the CVV as genuine keystrokes — React Aria commits this to its state
    await chrome.debugger.sendCommand(dbg, 'Input.insertText', { text: String(cvv) });
    log('success', 'CVV typed via CDP: "' + cvv + '"');
    await sleep(400);

    // 4. Scroll the Place Order button into view, get fresh coordinates, and real-click it
    const btnPt = await elementPoint(tabId, 'document.querySelector(\'[data-automation-id="place-order-button"],[data-testid="place-order-button"]\')');
    if (!btnPt) { log('error', 'Place Order button not found'); return; }
    await cdpClick(dbg, btnPt.x, btnPt.y);
    log('info', 'Place Order clicked via CDP');
    await sleep(1500);
  } catch (e) {
    log('error', 'CDP checkout error: ' + e.message);
  } finally {
    try { await chrome.debugger.detach(dbg); } catch (_) {}
  }
}

// Scrolls an element into view (via main-world eval of `expr`) and returns its viewport-center point
async function elementPoint(tabId, expr) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', args: [expr],
    func: (expr) => {
      const el = eval(expr);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  });
  return result;
}

// Dispatches a real left-click (press + release) at viewport coordinates via CDP
async function cdpClick(dbg, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await chrome.debugger.sendCommand(dbg, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.debugger.sendCommand(dbg, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await chrome.debugger.sendCommand(dbg, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

// Initializes bot state in storage and opens (or reuses) a localhost tab on the product page
async function startBot(config) {

  // Clear any stale debugger attachment so it can't block page interactions this run
  await detachAllDebuggers();

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

// Detaches the debugger from every tab it's attached to, so a stale attachment
// from a failed CDP run can't interfere with the next run's page interactions.
async function detachAllDebuggers() {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null) {
        try { await chrome.debugger.detach({ tabId: t.tabId }); } catch (_) {}
      }
    }
  } catch (_) {}
}

// Stops the bot by clearing any pending retry timer and resetting storage state
function stopBot() {

  // Clear any stale debugger attachment so it doesn't block page clicks next run
  detachAllDebuggers();

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

// Pauses execution for the given number of milliseconds
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper — sends a log message to the popup's activity log
// level controls the color: 'info' (blue), 'success' (green), 'warning' (yellow), 'error' (red)
function log(level, text) {
  // .catch(()=>{}) prevents unhandled errors when the popup window is not open
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text }).catch(() => {});
}
