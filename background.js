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
  // content.js guards itself by URL, so no external flag reset is needed.
  // Store adapter files load before content.js so their registry + helpers are in scope.
  await chrome.scripting.executeScript({ target: { tabId },
    files: ['stores.js', 'sams.js', 'target.js', 'walmart.js', 'bestbuy.js', 'pokemoncenter.js', 'content.js'] });
}

// PRIMARY (fast): inject as soon as the DOM is parsed — well before the page finishes
// loading images/trackers. The bot's MutationObservers then act the instant the
// next-step element appears, so it never waits for a full page load.
chrome.webNavigation.onDOMContentLoaded.addListener(async (d) => {
  if (d.frameId !== 0) return; // main frame only
  const { botRunning, botConfig, currentTabId } = await chrome.storage.local.get(['botRunning', 'botConfig', 'currentTabId']);
  if (!botRunning || !(botConfig?.useCurrentTab || botConfig?.samsSearch)) return;
  if (d.tabId !== currentTabId) return;
  await injectBot(d.tabId, d.url);
});

// Client-side (SPA) navigations don't reload the document — catch those too
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const { botRunning, botConfig, currentTabId } = await chrome.storage.local.get(['botRunning', 'botConfig', 'currentTabId']);
  if (!botRunning || !(botConfig?.useCurrentTab || botConfig?.samsSearch)) return;
  if (d.tabId !== currentTabId) return;
  await injectBot(d.tabId, d.url);
});

// FALLBACK: if DOMContentLoaded was missed, the full-load event still injects (deduped)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const { botRunning, botConfig, currentTabId } = await chrome.storage.local.get(['botRunning', 'botConfig', 'currentTabId']);
  if (!botRunning || !(botConfig?.useCurrentTab || botConfig?.samsSearch)) return;
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

  // Popup is starting a fresh run — detach any stale debugger so it can't block this run
  if (msg.type === 'RESET_BOT') detachAllDebuggers();

  // Alert the human (desktop notification + relay a sound to the popup)
  if (msg.type === 'BOT_ALERT') handleAlert(msg.kind, msg.text);

  // Sam's CVV + Place Order — must run in the page's MAIN world to reach React's state
  if (msg.type === 'SAMS_CHECKOUT') samsCheckout(sender.tab?.id, msg.cvv);

  // Set a React-controlled input (e.g. Pokémon Center cart quantity) via real CDP keystrokes
  if (msg.type === 'STORE_SET_QTY') { cdpSetValue(sender.tab?.id, msg.selector, msg.value).then(() => sendResponse(true)); return true; }

  // Pokémon Center: type card# + CVV into the secure CyberSource iframes via CDP
  if (msg.type === 'POKE_PAY') { pokemonPay(sender.tab?.id, msg).then(() => sendResponse(true)); return true; }

  // NOTE: BOT_LOG / BOT_STATUS / BOT_DONE are NOT relayed here — the side panel
  // receives them directly from content.js. Relaying caused every log to appear twice.
});

// Fills the CVV and clicks Place Order using the Chrome DevTools Protocol (chrome.debugger).
// CDP dispatches REAL, trusted browser-level input — indistinguishable from a human — so
// React Aria commits the value to its state every time (synthetic DOM events did not).
async function samsCheckout(tabId, cvv) {
  if (!tabId) { log('error', 'SAMS_CHECKOUT: no tab id'); return; }

  const cvvExpr = 'document.getElementById("cvv-field") || document.querySelector(\'[id*="cvv-field"],[name="cvv"][type="password"]\')';
  const btnExpr = 'document.querySelector(\'[data-automation-id="place-order-button"],[data-testid="place-order-button"]\')';

  const dbg = { tabId };
  try {
    await chrome.debugger.attach(dbg, '1.3');

    // 1. Fill the CVV ONLY if the saved card requires it. We only arrive here once the
    //    Place Order button exists, so a required CVV field is already rendered — a short
    //    poll is enough. If it's absent, the card needs no CVV.
    const cvvPt = await waitPoint(tabId, cvvExpr, 1800);
    if (cvvPt) {
      await cdpClick(dbg, cvvPt.x, cvvPt.y);          // real click to focus
      await sleep(50);
      await chrome.debugger.sendCommand(dbg, 'Input.insertText', { text: String(cvv) }); // real keystrokes
      log('success', 'CVV required — typed via CDP');
      await sleep(250);                                // brief margin for React Aria to commit
    } else {
      log('info', 'No CVV field — saved card needs no CVV, placing order directly');
    }

    // 2. Click Place Order (real CDP click) — works whether or not a CVV was needed.
    //    If the button isn't there yet, reload and retry (keep pushing).
    const btnPt = await waitPoint(tabId, btnExpr, 12000);
    if (!btnPt) {
      log('warning', 'Place Order button not found — reloading to retry...');
      try { await chrome.debugger.detach(dbg); } catch (_) {}
      chrome.tabs.reload(tabId);
      return;
    }
    await cdpClick(dbg, btnPt.x, btnPt.y);
    log('info', 'Place Order clicked via CDP');

    // 3. Check the outcome. If a validation/error banner appears, the order did NOT go
    //    through (no charge) — reload and retry. If it navigated away, it succeeded.
    await sleep(2500);
    const [{ result: failed }] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => /checkout|review-order/.test(location.pathname) &&
                  /please correct the errors|enter the 3 digit|something went wrong|try again/i.test(document.body.innerText || '')
    });
    if (failed) {
      log('warning', 'Order not placed (page shows an error) — reloading to retry...');
      try { await chrome.debugger.detach(dbg); } catch (_) {}
      chrome.tabs.reload(tabId);
      return;
    }
  } catch (e) {
    log('error', 'CDP checkout error: ' + e.message);
  } finally {
    try { await chrome.debugger.detach(dbg); } catch (_) {}
  }
}

// Pokémon Center: card # and CVV live in cross-origin CyberSource iframes that normal
// scripts can't fill. CDP types at the browser level, so clicking the iframe to focus it
// and then sending real keystrokes works the same as a person typing.
async function pokemonPay(tabId, msg) {
  if (!tabId) return;
  const dbg = { tabId };
  const cardDigits = String(msg.card || '').replace(/\D/g, '');
  const cvv = String(msg.cvv || '');
  const speed = msg.speed || 55; // ms per card digit (raised on each retry)
  try {
    await chrome.debugger.attach(dbg, '1.3');

    // Card number iframe — click near the top-left (where the input text sits), not dead
    // center (the iframe can be taller than the input, so center may miss it).
    const cardRect = await getRect(tabId, msg.cardSel);
    if (cardRect) {
      const cx = cardRect.x + Math.min(40, cardRect.w * 0.25);
      const cy = cardRect.y + cardRect.h * 0.4;
      log('info', 'Card iframe — typing ' + cardDigits.length + ' digits @ ' + speed + 'ms');
      // The microform iframe needs a moment to become interactive. A single click right after
      // it appears often misses (focus lands on the page, not the inner input — which is why
      // Ctrl+A used to highlight the whole page). Click twice with a pause so focus reliably
      // lands inside the field on the FIRST attempt.
      await cdpClick(dbg, cx, cy);
      await sleep(250);
      await cdpClick(dbg, cx, cy);
      await sleep(250);
      // Clear the field with targeted Backspaces (NOT Ctrl+A — that selects the whole page
      // when focus misses). Harmless when the field is already empty.
      for (let i = 0; i < 24; i++) {
        await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      }
      await sleep(120);
      // Send REAL digit keystrokes (raw digits) and let CyberSource's microform add the
      // spaces itself — same as a human typing.
      for (const ch of cardDigits) {
        const vk = ch.charCodeAt(0); // '0'..'9' -> 48..57
        await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: ch, code: 'Digit' + ch, text: ch, unmodifiedText: ch });
        await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyUp',   windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: ch, code: 'Digit' + ch });
        await sleep(speed);
      }
      log('success', 'Card number typed @ ' + speed + 'ms');
      await sleep(120);
    } else { log('warning', 'Card number iframe not found'); }

    // CVV iframe
    const cvvPt = await waitPoint(tabId, 'document.querySelector(' + JSON.stringify(msg.cvvSel) + ')', 4000);
    if (cvvPt) {
      log('info', 'CVV iframe at ' + Math.round(cvvPt.x) + ',' + Math.round(cvvPt.y) + ' — clicking + typing ' + cvv.length + ' digits');
      await cdpClick(dbg, cvvPt.x, cvvPt.y);
      await sleep(100);
      for (const ch of cvv) { await chrome.debugger.sendCommand(dbg, 'Input.insertText', { text: ch }); await sleep(10); }
      log('success', 'CVV typed via CDP');
      await sleep(100);
    } else { log('warning', 'CVV iframe not found'); }
  } catch (e) {
    log('error', 'Pokémon pay CDP error: ' + e.message);
  } finally {
    try { await chrome.debugger.detach(dbg); } catch (_) {}
  }
}

// Sets a React-controlled input to `value` using genuine CDP keystrokes (click → select
// all → type → Enter), so the page commits it the way it would for a real person.
async function cdpSetValue(tabId, selector, value) {
  if (!tabId) return;
  const dbg = { tabId };
  const expr = 'document.querySelector(' + JSON.stringify(selector) + ')';
  try {
    await chrome.debugger.attach(dbg, '1.3');
    const pt = await waitPoint(tabId, expr, 4000);
    if (!pt) { log('warning', 'Quantity input not found'); return; }
    await cdpClick(dbg, pt.x, pt.y);          // focus the field
    await sleep(30);
    // Select all (Ctrl+A) so typing replaces the current number
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyUp',   modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await chrome.debugger.sendCommand(dbg, 'Input.insertText', { text: String(value) });
    // Commit: Enter, then Tab to blur (carts usually recalc on the change/blur)
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await chrome.debugger.sendCommand(dbg, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(250);
    // Read the value back so we can see whether it actually stuck
    const [{ result: now }] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [selector],
      func: (sel) => { const el = document.querySelector(sel); return el ? el.value : '(no input)'; }
    });
    log('success', 'Quantity field now shows: "' + now + '" (wanted ' + value + ')');
  } catch (e) {
    log('error', 'Quantity CDP error: ' + e.message);
  } finally {
    try { await chrome.debugger.detach(dbg); } catch (_) {}
  }
}

// Polls elementPoint until the element appears or the timeout elapses (returns null if never)
async function waitPoint(tabId, expr, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await elementPoint(tabId, expr);
    if (p) return p;
    await sleep(80);
  }
  return null;
}

// Scrolls an element into view and returns its viewport rect {x,y,w,h} (top-left + size)
async function getRect(tabId, selector) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', args: [selector],
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
  });
  return result;
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

  // Update storage so the content script won't act on the next page load,
  // and wipe the temporary plaintext config (only the encrypted copy remains at rest)
  chrome.storage.local.set({
    botRunning: false,    // Tells content script to do nothing
    botPhase: 'IDLE'      // Reset phase back to idle
  });
  chrome.storage.local.remove(['botConfig', 'burstUntil', 'queueSince']);

  // Notify the popup so it can update the UI
  log('warning', 'Background: bot stopped');
}

// ── Alerts: desktop notification + sound relay to popup ────────────────────────
// 1x1 transparent PNG (valid iconUrl so the notification renders without a bundled icon)
const ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
function handleAlert(kind, text) {
  const titles = {
    captcha: '🛑 CAPTCHA — needs you!',
    success: '🎉 Order placed!',
    fail:    '❌ Order problem',
    stuck:   '⏳ Bot needs attention',
  };
  try {
    chrome.notifications.create('bot-' + kind + '-' + Date.now(), {
      type: 'basic', iconUrl: ICON_DATA_URL,
      title: titles[kind] || 'Checkout Bot', message: text || '',
      priority: 2, requireInteraction: kind === 'captcha',
    });
  } catch (_) {}
  // Popup/side panel plays the sound (service workers can't play audio)
  chrome.runtime.sendMessage({ type: 'PLAY_SOUND', kind }).catch(() => {});
}

// Pauses execution for the given number of milliseconds
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper — sends a log message to the popup's activity log
// level controls the color: 'info' (blue), 'success' (green), 'warning' (yellow), 'error' (red)
function log(level, text) {
  // .catch(()=>{}) prevents unhandled errors when the popup window is not open
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text }).catch(() => {});
}
