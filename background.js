// Open the side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Keep the service worker alive while the side panel is open. The panel holds a "keepalive" port
// and pings it; an open port + incoming messages reset the worker's idle timer, so it won't die
// out from under the panel (which left Start/Test doing nothing until the panel was reopened).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  port.onMessage.addListener(() => {}); // each ping keeps the worker warm
  port.onDisconnect.addListener(() => {}); // panel closed → worker may sleep (fine)
});

// Stop the bot whenever the extension is reloaded/updated or Chrome restarts,
// so a refresh of the extension always leaves it in a clean stopped state.
chrome.runtime.onInstalled.addListener(() => stopBot());
chrome.runtime.onStartup.addListener(() => stopBot());

// Keep the service worker alive while bot is running so it can re-inject content.js on page reloads.
// Chrome kills idle service workers after ~30s — this alarm fires every 25s to prevent that.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (!(await anyBotRunning())) chrome.alarms.clear('keepalive');
});

// Holds the reference to the OOS retry timer so we can cancel it if the user stops the bot
let botInterval = null;

// Tracks the last URL we injected into PER TAB, to avoid re-injecting when an SPA fires "complete"
// multiple times for the SAME page (which caused duplicate racing runs). Keyed by tab so multiple
// windows — even two on the same URL — are deduped independently. Maps tabId -> { url, at }.
const lastInjected = {};

// ── Per-window state namespacing (mirror of popup.js / content.js) ──────────────
// Per-window keys are stored as "w<windowId>:<key>". NS_ON is the shared kill-switch — popup.js,
// content.js and background.js must ALL agree. false = old global single-window behavior (Step 4a);
// flipping all three to true (Step 4b) gives each window its own independent bot state.
const NS_ON = true;
const PW_KEYS = new Set(['botRunning', 'botPhase', 'botConfig', 'activeProfile', 'currentTabId',
  'botTestMode', 'botRunToken', 'burstUntil', 'queueSince', 'qtyDone', 'samsFellBack', 'addAttempts',
  'pokePlaceRetries', 'armState']);
// Per-window RUN-state keys to wipe on stop (everything except armState, which intentionally
// survives a stop/reload so an armed drop isn't lost).
const PW_RUN_KEYS = ['botRunning', 'botPhase', 'botConfig', 'currentTabId', 'botTestMode',
  'botRunToken', 'burstUntil', 'queueSince', 'qtyDone', 'samsFellBack', 'addAttempts', 'pokePlaceRetries'];
const nskw = (wid, key) => (NS_ON && wid != null && PW_KEYS.has(key)) ? ('w' + wid + ':' + key) : key;
// Reads per-window keys for the window that owns `tabId` (returns the ORIGINAL key names).
async function wgetTab(tabId, keys) {
  const wid = await widForTab(tabId);
  const arr = Array.isArray(keys) ? keys : [keys];
  const mapped = arr.map(k => nskw(wid, k));
  const res = await chrome.storage.local.get(mapped);
  const out = {}; arr.forEach((orig, i) => { out[orig] = res[mapped[i]]; }); return out;
}
// True if ANY window's bot is running — keepalive must persist while at least one runs.
async function anyBotRunning() {
  const all = await chrome.storage.local.get(null);
  if (all.botRunning) return true;
  for (const k in all) if (/^w\d+:botRunning$/.test(k) && all[k]) return true;
  return false;
}

// Reject a promise if it doesn't settle within ms — so a hung chrome.scripting call can't freeze
// the whole injection chain (Walmart frames navigating out from under executeScript hang otherwise).
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'op') + ' timed out after ' + ms + 'ms')), ms)),
  ]);
}

// Single injection gate — ALL injection (initial from popup + re-injection on
// navigation) goes through here, so the dedup tracker covers every path.
async function injectBot(tabId, url, force) {
  const now = Date.now();
  // Resolve THIS tab's window id FIRST so every log below is tagged for the owning window's panel
  // (per-window activity log — mirrors the "Bot N" numbering). logWin(wid,…) filters to that panel.
  let wid = null, gotTab = false;
  try { wid = (await chrome.tabs.get(tabId)).windowId; gotTab = true; } catch (_) {}
  const ilog = (lvl, txt) => logWin(wid, lvl, txt);
  ilog('info', '🔧 inj enter tab=' + tabId + ' force=' + !!force); // TEMP step telemetry
  // Skip a repeat injection of the same URL into the SAME tab within 3s (SPA firing complete
  // repeatedly). `force` bypasses this: an explicit user Start must NEVER be swallowed.
  const prev = lastInjected[tabId];
  if (!force && url && prev && url === prev.url && now - prev.at < 3000) { ilog('info', '🔧 inj DEDUP-skip'); return; }
  lastInjected[tabId] = { url: url || '', at: now };
  ilog('info', '🔧 inj wid=' + wid + ' gotTab=' + gotTab);
  // Stamp THIS tab's browser-window id into the content-script world FIRST, so content.js knows
  // which window it belongs to without having to guess. A failure here must NOT block injection.
  try {
    // Also mark explicit (user-Start) injections so content.js can report LOUDLY if it then finds
    // no run state. TIMEOUT-guarded: on a navigating page executeScript can HANG against a frame
    // being torn down; a timeout lets us bail and the webNavigation re-injection retries.
    await withTimeout(chrome.scripting.executeScript({ target: { tabId }, args: [wid, !!force],
      func: (w, ex) => { window.__BOT_WID = w; if (ex) window.__BOT_EXPLICIT = Date.now(); } }), 2500, 'stamp');
    ilog('info', '🔧 inj stamp OK');
  } catch (e) { ilog('error', '🔧 inj stamp FAILED: ' + (e && e.message || e)); }
  // content.js guards itself by URL, so no external flag reset is needed.
  // Store adapter files load before content.js so their registry + helpers are in scope.
  ilog('info', '🔧 inj injecting files…');
  try {
    await withTimeout(chrome.scripting.executeScript({ target: { tabId },
      files: ['stores.js', 'sams.js', 'target.js', 'walmart.js', 'bestbuy.js', 'pokemoncenter.js', 'content.js'] }), 4000, 'files');
    ilog('info', '🔧 inj files OK');
  } catch (e) {
    ilog('error', '⚠️ Could not inject into tab ' + tabId + ' (wid=' + wid + '): ' + (e && e.message || e));
  }
}

// PRIMARY (fast): inject as soon as the DOM is parsed — well before the page finishes
// loading images/trackers. The bot's MutationObservers then act the instant the
// next-step element appears, so it never waits for a full page load.
chrome.webNavigation.onDOMContentLoaded.addListener(async (d) => {
  if (d.frameId !== 0) return; // main frame only
  const { botRunning, botConfig, currentTabId } = await wgetTab(d.tabId, ['botRunning', 'botConfig', 'currentTabId']);
  if (!botRunning || !(botConfig?.useCurrentTab || botConfig?.samsSearch || botConfig?.watchlist?.length)) return;
  if (d.tabId !== currentTabId) return;
  await injectBot(d.tabId, d.url);
});

// Client-side (SPA) navigations don't reload the document — catch those too
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const { botRunning, botConfig, currentTabId } = await wgetTab(d.tabId, ['botRunning', 'botConfig', 'currentTabId']);
  if (!botRunning || !(botConfig?.useCurrentTab || botConfig?.samsSearch || botConfig?.watchlist?.length)) return;
  if (d.tabId !== currentTabId) return;
  await injectBot(d.tabId, d.url);
});

// FALLBACK: if DOMContentLoaded was missed, the full-load event still injects (deduped)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const { botRunning, botConfig, currentTabId } = await wgetTab(tabId, ['botRunning', 'botConfig', 'currentTabId']);
  if (!botRunning || !(botConfig?.useCurrentTab || botConfig?.samsSearch || botConfig?.watchlist?.length)) return;
  if (tabId !== currentTabId) return;
  await injectBot(tabId, tab?.url || '');
});

// A real navigation/reload starts a BRAND-NEW document. Clear the dedup tracker so the upcoming
// re-injection is allowed even when the URL is identical — a fast refresh loop reloads the SAME
// url every cycle, and the 3s dedup window in injectBot would otherwise swallow it (one cycle,
// then silence). SPA "complete"/historyState spam does NOT fire onBeforeNavigate, so those stay
// coalesced by the time window. The DOMContentLoaded + complete pair for THIS load still dedup
// against each other (only the first resets, the second is within 3s), so we inject exactly once.
chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0) return; // main frame only
  const { botRunning, currentTabId } = await wgetTab(d.tabId, ['botRunning', 'currentTabId']);
  if (!botRunning || d.tabId !== currentTabId) return;
  if (lastInjected[d.tabId]) lastInjected[d.tabId].url = ''; // allow re-inject after a real reload
});

// GLOBAL keyboard shortcuts. Unlike the in-panel keydown, chrome.commands fire even when a web
// page (not the side panel) is focused — so the user doesn't have to click the panel first after
// opening/switching a tab. The actual actions (start/test/save) live in the panel, so we just
// forward the command to it. Works while the panel is OPEN (sendMessage rejects harmlessly if not).
chrome.commands.onCommand.addListener((command) => {
  const action = { 'start-bot': 'start', 'test-bot': 'test', 'save-config': 'save' }[command];
  if (action) chrome.runtime.sendMessage({ type: 'HOTKEY', action }).catch(() => {});
});

// Central message listener — background script is always alive and receives messages from popup and content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Popup sent START_BOT — kick off the bot with the user's config
  if (msg.type === 'START_BOT') startBot(msg.config);

  // Popup sent STOP_BOT — stop just that window's bot (wid provided), else a full global stop
  if (msg.type === 'STOP_BOT') { if (msg.wid != null) stopBotWin(msg.wid); else stopBot(); }

  // Popup requested initial injection into the current tab — routed through the same dedup gate.
  // Clear any stale debugger attachment first so it can't block page clicks this run. Also ensure
  // the keepalive alarm is running so the worker survives the whole run (not just the localhost flow).
  if (msg.type === 'INJECT_BOT') {
    chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
    // Await the chain and RETURN TRUE so the MV3 service worker stays alive until injection
    // finishes (a fire-and-forget promise gets dropped when the worker idles → injectBot never ran).
    (async () => {
      const wid = await widForTab(msg.tabId); // tag this run's marker for the owning window's panel
      logWin(wid, 'info', '🛠️ inject build v3');
      try { await injectBot(msg.tabId, msg.url, true); }
      catch (e) { logWin(wid, 'error', '⚠️ inject threw for tab ' + msg.tabId + ': ' + (e && e.message || e)); }
      try { await detachAllDebuggers(); } catch (_) {}
      try { sendResponse && sendResponse(true); } catch (_) {}
    })();
    return true; // keep the worker alive until injection completes
  }

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

  // Real browser-level click for buttons gated on trusted events (Target Buy now / Place order)
  if (msg.type === 'CDP_CLICK') { cdpClickSelector(sender.tab?.id, msg.selector).then(ok => sendResponse(ok)); return true; }

  // Find (and optionally click) a button across ALL frames — for drawers rendered in an iframe
  if (msg.type === 'PLACE_ORDER_FRAMES') { findClickInFrames(sender.tab?.id, msg).then(r => sendResponse(r)); return true; }

  // Target CVV-confirm sidebar (in an iframe): fill #enter-cvv, optionally click Confirm
  if (msg.type === 'TARGET_CVV') { targetCvvInFrames(sender.tab?.id, msg).then(r => sendResponse(r)); return true; }

  // READ-ONLY diagnostic: probe Target's stock endpoints and auto-find the availability field.
  if (msg.type === 'STOCK_TEST') { targetStockTest(msg).then(r => sendResponse(r)); return true; }

  // Fast stock check: fetch Target's product_fulfillment_v1 (in the page context, since Target blocks
  // the background's own fetch) and return the shipping availability. Used by the restock watcher.
  if (msg.type === 'STOCK_POLL') { targetStockPoll(sender.tab?.id, msg.tcin).then(r => sendResponse(r)); return true; }

  // Fast stock check for stores that SSR availability into the page HTML (Sam's/Walmart GLASS):
  // fetch the product URL and read the schema.org / availabilityStatus signal. Used by the watcher.
  if (msg.type === 'HTML_STOCK_POLL') { htmlStockPoll(sender.tab?.id, msg.url, msg.mode).then(r => sendResponse(r)); return true; }

  // NOTE: BOT_LOG / BOT_STATUS / BOT_DONE are NOT relayed here — the side panel
  // receives them directly from content.js. Relaying caused every log to appear twice.
});

// Fills the CVV and clicks Place Order using the Chrome DevTools Protocol (chrome.debugger).
// CDP dispatches REAL, trusted browser-level input — indistinguishable from a human — so
// React Aria commits the value to its state every time (synthetic DOM events did not).
// Detect a CAPTCHA / bot challenge in a tab (for CDP-driven flows that don't run the content-script
// loop). Mirrors content.js detectCaptcha — covers reCAPTCHA/hCaptcha/PerimeterX press-and-hold/
// DataDome/Cloudflare Turnstile/Arkose + text signals. Returns true if a challenge is on the page.
async function pageHasCaptcha(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (document.querySelector([
          'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[title*="captcha" i]',
          'iframe[src*="geo.captcha-delivery.com"]', 'iframe[src*="challenges.cloudflare.com"]',
          'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]',
          '#px-captcha', '[id*="px-captcha"]', '[class*="datadome" i]', '[id*="datadome" i]',
          '.cf-turnstile', '[class*="captcha" i]', '[id*="captcha" i]',
          '[data-testid*="captcha" i]', '[aria-label*="press & hold" i]'
        ].join(', '))) return true;
        const t = (document.body && document.body.innerText || '').toLowerCase();
        return /are you a human|verify (?:you(?:'| a)?re|that you are) (?:a )?human|i'?m not a robot|press (?:and|&) hold|(?:slide|drag) (?:to |the )|unusual traffic|confirm you(?:'| a)?re human|checking your browser|activity from your (?:computer|device|network)/.test(t);
      }
    });
    return !!result;
  } catch (_) { return false; }
}

// Pause a CDP flow on a bot challenge and WAIT for the human to clear it, alerting REPEATEDLY
// (sound + notification) every 2s so it can't be missed. Returns true when clear to continue,
// false if the bot was stopped while waiting. No-op when there's no challenge.
async function awaitCaptchaClearBg(tabId, wid, tag) {
  if (!(await pageHasCaptcha(tabId))) return true;
  const log = (lvl, txt) => logWin(wid, lvl, txt);
  log('error', '🛑 CAPTCHA / verification detected (' + tag + ') — SOLVE IT in the page! (alerting you)');
  chrome.runtime.sendMessage({ type: 'BOT_STATUS', status: 'error', text: '🛑 CAPTCHA — solve it!', wid }).catch(() => {});
  let cycles = 0;
  while (await pageHasCaptcha(tabId)) {
    handleAlert('captcha', cycles === 0
      ? 'A CAPTCHA/verification is blocking the bot — solve it in the page.'
      : 'Still waiting on the CAPTCHA — solve it! (' + (cycles * 2) + 's)');
    cycles++;
    await sleep(2000);
    const { botRunning } = await wgetTab(tabId, ['botRunning']);
    if (!botRunning) return false; // user stopped while waiting
  }
  log('success', 'CAPTCHA cleared — continuing');
  handleAlert('success', 'CAPTCHA cleared — resuming checkout.');
  return true;
}

async function samsCheckout(tabId, cvv) {
  const wid = await widForTab(tabId);
  const log = (lvl, txt) => logWin(wid, lvl, txt); // route this op's logs to its window's panel
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

    // A bot challenge can gate the checkout page before we submit — pause & alert you to clear
    // it (detaching the debugger so it doesn't interfere), then re-attach and continue.
    if (await pageHasCaptcha(tabId)) {
      try { await chrome.debugger.detach(dbg); } catch (_) {}
      if (!(await awaitCaptchaClearBg(tabId, wid, 'sams checkout'))) return; // stopped while waiting
      try { await chrome.debugger.attach(dbg, '1.3'); } catch (_) {}
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

    // Sam's sometimes throws a press-and-hold / DataDome challenge right AFTER the place-order
    // click. Pause & alert you to clear it before we verify the order went through.
    await sleep(600);
    if (await pageHasCaptcha(tabId)) {
      try { await chrome.debugger.detach(dbg); } catch (_) {}
      if (!(await awaitCaptchaClearBg(tabId, wid, 'sams after place-order'))) return;
      try { await chrome.debugger.attach(dbg, '1.3'); } catch (_) {}
    }

    // 3. VERIFY the order went through, and RE-CLICK if a drop dropped the click. Poll for the page
    //    to leave the checkout/review path (= placed). Still on checkout with NO error → the click
    //    didn't register → re-click. We only re-click while it's confirmed NOT submitted (still on
    //    checkout + button present), so we can never double-order. Error banner → not placed → reload.
    let placed = false;
    for (let t = 0; t < 3 && !placed; t++) {
      await sleep(2200);
      const [{ result: state }] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => ({
          onCheckout: /checkout|review-order/.test(location.pathname),
          failed: /please correct the errors|enter the 3 digit|something went wrong|try again/i.test(document.body.innerText || '')
        })
      });
      if (!state.onCheckout) { placed = true; break; }         // left checkout → order placed ✓
      if (state.failed) {                                       // error banner → not placed → reload & retry
        log('warning', 'Order not placed (page shows an error) — reloading to retry...');
        try { await chrome.debugger.detach(dbg); } catch (_) {}
        chrome.tabs.reload(tabId);
        return;
      }
      // Still on checkout, no error → the click was dropped. Re-click ONLY if the button is still there.
      const btnPt2 = await waitPoint(tabId, btnExpr, 800);
      if (!btnPt2) break;
      log('warning', 'Place Order didn’t advance — clicking it again (try ' + (t + 2) + ')...');
      await cdpClick(dbg, btnPt2.x, btnPt2.y);
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
  const wid = await widForTab(tabId);
  const log = (lvl, txt) => logWin(wid, lvl, txt); // route this op's logs to its window's panel
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
  const wid = await widForTab(tabId);
  const log = (lvl, txt) => logWin(wid, lvl, txt); // route this op's logs to its window's panel
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

// Searches EVERY frame in the tab (the drawer/checkout may be an iframe the content script can't
// see) for a button matching one of `selectors` or, failing that, one whose text/data-test matches
// a keyword. If `click` is true, clicks it in its own frame. Returns the first frame that matched.
async function findClickInFrames(tabId, msg) {
  if (!tabId) return { found: false };
  const wid = await widForTab(tabId);
  const log = (lvl, txt) => logWin(wid, lvl, txt); // route this op's logs to its window's panel
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [msg.selectors || [], msg.keywords || [], !!msg.click],
      func: (selectors, keywords, doClick) => {
        const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        let el = null;
        for (const sel of selectors) { try { const e = document.querySelector(sel); if (e) { el = e; break; } } catch (_) {} }
        if (!el) {
          for (const b of document.querySelectorAll('button, [role="button"], input[type="submit"], a[role="button"]')) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            const t = norm((b.textContent || '') + ' ' + (b.getAttribute('data-test') || '') + ' ' + (b.getAttribute('aria-label') || ''));
            if (keywords.some(k => t.includes(norm(k)))) { el = b; break; }
          }
        }
        if (!el) return { found: false };
        const text = (el.textContent || '').trim().slice(0, 40);
        if (doClick) { el.scrollIntoView({ block: 'center' }); el.click(); }
        return { found: true, text, url: location.href };
      }
    });
    return results.map(r => r && r.result).find(r => r && r.found) || { found: false };
  } catch (e) {
    log('error', 'findClickInFrames error: ' + e.message);
    return { found: false, error: e.message };
  }
}

// Target's "Confirm your CVV" sidebar (rendered in an iframe). Fills #enter-cvv with the card's
// CVV via the native value setter (so React commits it), then optionally clicks Confirm — which
// is the FINAL submit (the actual charge). Searches all frames since the sidebar is an iframe.
async function targetCvvInFrames(tabId, msg) {
  if (!tabId) return { found: false };
  const wid = await widForTab(tabId);
  const log = (lvl, txt) => logWin(wid, lvl, txt); // route this op's logs to its window's panel
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [String(msg.cvv || ''), !!msg.confirm],
      func: (cvv, doConfirm) => {
        const input = document.querySelector('#enter-cvv, input[name="enter-cvv"]');
        if (!input) return { found: false };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        input.focus();
        setter.call(input, cvv);
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        let confirmed = false;
        if (doConfirm) {
          const b = document.querySelector('[data-test="confirm-button"]');
          if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); confirmed = true; }
        }
        return { found: true, confirmed };
      }
    });
    return results.map(r => r && r.result).find(r => r && r.found) || { found: false };
  } catch (e) {
    log('error', 'targetCvvInFrames error: ' + e.message);
    return { found: false, error: e.message };
  }
}

// Attaches the debugger and dispatches a REAL left-click on `selector` (a trusted browser-level
// event). Needed for buttons that ignore a scripted .click() — e.g. Target's Buy now / Place
// your order, which are gated on trusted user gestures. Returns true if the click was sent.
async function cdpClickSelector(tabId, selector) {
  if (!tabId || !selector) return false;
  const wid = await widForTab(tabId);
  const log = (lvl, txt) => logWin(wid, lvl, txt); // route this op's logs to its window's panel
  const dbg = { tabId };
  try {
    // TIMEOUT the attach: chrome.debugger.attach can HANG (another debugger/DevTools attached, or the
    // tab busy) and would never return — freezing the whole Buy-now click. Bail so we can retry.
    await withTimeout(chrome.debugger.attach(dbg, '1.3'), 4000, 'debugger.attach');
    // Step 1: scroll the VISIBLE match into view if needed (instant, 'nearest' = minimal movement
    // so the page doesn't jump). There can be hidden/duplicate copies, so pick the visible one.
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [selector],
      func: (sel) => {
        const els = [...document.querySelectorAll(sel)];
        const vis = els.find(e => {
          const r = e.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && e.offsetParent !== null;
        }) || els[0];
        if (vis) vis.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    });
    // Step 2: AFTER the scroll settles, measure the button's CURRENT position, then click it.
    // (Measuring before the scroll finished was making the click miss.)
    await new Promise(r => setTimeout(r, 200));
    const [{ result: info }] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [selector],
      func: (sel) => {
        const els = [...document.querySelectorAll(sel)];
        const vis = els.find(e => {
          const r = e.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && e.offsetParent !== null;
        }) || els[0];
        if (!vis) return { found: false, count: els.length };
        const r = vis.getBoundingClientRect();
        return { found: true, count: els.length, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      }
    });
    if (!info || !info.found) { log('warning', 'CDP click: not found — ' + selector + ' (matches: ' + (info && info.count) + ')'); return false; }
    log('info', 'CDP click @ ' + Math.round(info.x) + ',' + Math.round(info.y) + ' (' + info.count + ' match · ' + Math.round(info.w) + '×' + Math.round(info.h) + ')');
    await cdpClick(dbg, info.x, info.y);
    return true;
  } catch (e) {
    log('error', 'CDP click error: ' + e.message);
    return false;
  } finally {
    try { await chrome.debugger.detach(dbg); } catch (_) {}
  }
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

// Stops ONLY the bot for window `wid` (used when a single panel closes). Detaches just that
// window's tab, wipes its per-window run-state, and keeps keepalive alive while ANY other bot is
// still running — so closing one window's bot never disturbs the others' (incl. mid-checkout).
async function stopBotWin(wid) {
  if (wid == null) { stopBot(); return; } // no window id → fall back to a full stop
  // Detach ONLY this window's tab (leave other windows' in-flight checkouts attached).
  const tk = nskw(wid, 'currentTabId');
  const tabId = (await chrome.storage.local.get(tk))[tk];
  if (tabId != null) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} }
  // Wipe this window's run-state (the panel also clears it, but may not flush as it closes).
  await chrome.storage.local.remove(PW_RUN_KEYS.map(k => nskw(wid, k)));
  // Keep the worker alive while any OTHER window's bot is still running.
  if (!(await anyBotRunning())) chrome.alarms.clear('keepalive');
}

// Wipes the RUN-state of EVERY window (used on a full/global stop, e.g. extension reload), so no
// panel restores a stale "running" state for a bot whose content script no longer exists.
async function clearAllPerWindowRunState() {
  const all = await chrome.storage.local.get(null);
  const re = new RegExp('^w\\d+:(' + PW_RUN_KEYS.join('|') + ')$');
  const rm = Object.keys(all).filter(k => re.test(k));
  if (rm.length) await chrome.storage.local.remove(rm);
}

// Stops ALL bots by clearing timers and resetting state (extension reload / startup).
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

  // Update storage so the content script won't act on the next page load, and wipe the temporary
  // plaintext config (global keys for the localhost flow, plus EVERY window's per-window run-state).
  chrome.storage.local.set({
    botRunning: false,    // Tells content script to do nothing
    botPhase: 'IDLE'      // Reset phase back to idle
  });
  chrome.storage.local.remove(['botConfig', 'burstUntil', 'queueSince']);
  clearAllPerWindowRunState();

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
  // Any non-captcha alert (e.g. the "cleared — resuming" success) dismisses the lingering
  // press-and-hold/captcha banner so it doesn't stay pinned on screen.
  if (kind !== 'captcha') { try { chrome.notifications.clear('bot-captcha'); } catch (_) {} }
  try {
    // A repeating captcha alert reuses ONE stable id so the notification refreshes in place
    // (updated countdown text) instead of stacking dozens of banners; others stay unique.
    const nid = kind === 'captcha' ? 'bot-captcha' : ('bot-' + kind + '-' + Date.now());
    chrome.notifications.create(nid, {
      type: 'basic', iconUrl: ICON_DATA_URL,
      title: titles[kind] || 'SnipeBot', message: text || '',
      priority: 2, requireInteraction: kind === 'captcha',
    });
  } catch (_) {}
  // Popup/side panel plays the sound (service workers can't play audio). Fired on EVERY alert,
  // so a repeating captcha alert keeps buzzing until it's cleared.
  chrome.runtime.sendMessage({ type: 'PLAY_SOUND', kind }).catch(() => {});
}

// Pauses execution for the given number of milliseconds
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Target stock-API discovery (read-only) ─────────────────────────────────────
// Recursively walks a JSON blob and collects any field that looks like a stock/availability signal
// (key or value), so we can auto-detect Target's field name regardless of how it's nested.
function deepFindAvailability(obj, path, out) {
  out = out || []; path = path || '';
  if (out.length >= 10 || !obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k], p = path ? path + '.' + k : k;
    if (typeof v === 'object' && v !== null) { deepFindAvailability(v, p, out); }
    else if (/avail|in_stock|out_of_stock|sellable|is_out_of_stock|purchase_limit|shipping_status|inventory/i.test(k)) { out.push(p + ' = ' + JSON.stringify(v)); }
    else if (typeof v === 'string' && /^(IN_STOCK|OUT_OF_STOCK|LIMITED_STOCK|PRE_ORDER)$|sold out|out of stock|in stock/i.test(v)) { out.push(p + ' = ' + JSON.stringify(v)); }
  }
  return out;
}

// Probes several candidate Target endpoints for the given TCIN and reports which returns an
// availability field. Fetches with the user's cookies (credentials:'include') via host permissions.
async function targetStockTest(msg) {
  const key   = msg.key || '9f36aeafbe60771e321a7cc95a78140772ab3e96'; // Target's public web key
  const tcin  = msg.tcin;
  if (!tcin) return { ok: false, error: 'No TCIN — open a Target product page (…/A-<number>) first.' };
  const store = msg.storeId || '1248';
  const zip   = msg.zip || '';
  const state = msg.state || '';
  const common = 'key=' + key + '&tcin=' + tcin + '&is_bot=false&channel=WEB&page=%2Fp%2FA-' + tcin;
  const loc = '&store_id=' + store + '&pricing_store_id=' + store + '&has_pricing_store_id=true'
            + '&scheduled_delivery_store_id=' + store + '&required_store_id=' + store + '&has_required_store_id=true'
            + (zip ? '&zip=' + zip : '') + (state ? '&state=' + state : '');
  const rs = 'https://redsky.target.com/redsky_aggregations/v1/web/';
  const candidates = [
    rs + 'pdp_fulfillment_v1?' + common + loc,
    rs + 'product_fulfillment_v1?' + common + loc,
    rs + 'pdp_client_v1?' + common + loc,
    rs + 'pdp_variation_hierarchy_v1?' + common,
  ];
  const results = [];
  for (const url of candidates) {
    const short = url.replace('https://redsky.target.com/redsky_aggregations/v1/web/', '').split('?')[0];
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { results.push({ ep: short, status: res.status, found: [] }); continue; }
      const json = await res.json();
      results.push({ ep: short, status: res.status, found: deepFindAvailability(json) });
    } catch (e) { results.push({ ep: short, status: 'ERR', found: [], error: e.message }); }
  }
  return { ok: true, tcin, store, results };
}

// Fast single stock check for the restock watcher. Runs the fetch inside the Target tab (MAIN world)
// — Target blocks the background's own fetch — and returns { avail, qty }. Confirmed endpoint/field:
//   product_fulfillment_v1 → data.product.fulfillment.shipping_options.availability_status
async function targetStockPoll(tabId, tcin) {
  if (!tabId || !tcin) return { ok: false };
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [tcin],
      func: async (tcin) => {
        const key = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
        const url = 'https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?key=' + key +
                    '&tcin=' + tcin + '&is_bot=false&channel=WEB&page=%2Fp%2FA-' + tcin;
        try {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return { status: res.status };
          const j = await res.json();
          const so = (j && j.data && j.data.product && j.data.product.fulfillment && j.data.product.fulfillment.shipping_options) || {};
          return { status: 200, avail: so.availability_status || null, qty: so.available_to_promise_quantity };
        } catch (e) { return { status: 'ERR', error: e.message }; }
      }
    });
    return { ok: true, ...(out && out.result || {}) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Stock check via the product page HTML (Sam's/Walmart GLASS SSR the availability into the page).
// Fetches the URL in the tab's page context and reads the main product's schema.org availability
// (falling back to the first availabilityStatus). Returns { inStock, status }.
async function htmlStockPoll(tabId, url, mode) {
  if (!tabId || !url) return { ok: false };
  try {
    // TIMEOUT the MAIN-world poll: right after switching back to a Walmart tab its main thread is
    // JAMMED for ~20-40s (anti-bot JS + /ip→seort redirect), and this executeScript HANGS — which
    // froze the whole watcher on its first poll (no 👁 updates, looked dead). On timeout return a
    // benign "busy" (ok:true, NOT an error) so the watch loop keeps ticking until the page frees up.
    const [out] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [url, mode || ''],
      func: async (url, mode) => {
        try {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return { status: res.status };
          const t = await res.text();
          // WALMART: do NOT trust schema.org here — PDP pages embed "customers also bought"
          // carousels whose in-stock items carry their own schema.org/InStock markup (false
          // positives). The MAIN product's PDP data is SSR'd FIRST, so the first availabilityStatus
          // in the payload is the item we're watching.
          if (mode === 'walmart') {
            const m = t.match(/"availabilityStatus"\s*:\s*"([^"]+)"/);
            const s = m ? m[1] : null;
            const avail = s ? /IN_STOCK|LIMITED/i.test(s) : false;
            // availabilityStatus alone is useless for these drops: the item carries a permanent
            // 3rd-party ~$200 offer, so it reads IN_STOCK forever. The RETAIL drop is what we want,
            // and the decider is the SELLER — only navigate when a 1st-party offer is present.
            // Keep these OFFER-scoped so page boilerplate can't false-positive.
            const retail = /sold (?:and shipped )?by\s*:?\s*walmart/i.test(t)
              || /"sellerType"\s*:\s*"(?:INTERNAL|1P|FIRST_PARTY)"/i.test(t)
              || /"sellerId"\s*:\s*"F55CDC31AB754BB68FE0B39041159D63"/i.test(t); // Walmart.com's 1P seller id
            return { status: (s || 'unknown') + (retail ? ' +retail' : ''), inStock: avail && retail, avail, retail };
          }
          // schema.org markup is for the MAIN product only → cleanest signal.
          if (/schema\.org\/InStock/i.test(t))    return { status: 'InStock', inStock: true };
          if (/schema\.org\/OutOfStock/i.test(t)) return { status: 'OutOfStock', inStock: false };
          // Fallback: first availabilityStatus in the SSR'd data.
          const m = t.match(/"availabilityStatus"\s*:\s*"([^"]+)"/);
          const s = m ? m[1] : null;
          return { status: s || 'unknown', inStock: s ? /IN_STOCK|LIMITED/i.test(s) : false };
        } catch (e) { return { status: 'ERR', error: e.message }; }
      }
    }), 6000, 'poll');
    return { ok: true, ...(out && out.result || {}) };
  } catch (e) {
    // Timeout = the page's main thread is busy, NOT a real failure — report "busy" so the watcher
    // keeps looping quietly (an error would trigger its reload/rotation fallback).
    if (/timed out/.test(e && e.message || '')) return { ok: true, status: 'busy', inStock: false, avail: false, retail: false, busy: true };
    return { ok: false, error: e.message };
  }
}

// Helper — sends a log message to the popup's activity log
// level controls the color: 'info' (blue), 'success' (green), 'warning' (yellow), 'error' (red)
function log(level, text) {
  // .catch(()=>{}) prevents unhandled errors when the popup window is not open
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text }).catch(() => {});
}

// Per-window log: tags the message with `wid` so ONLY that window's panel shows it. Used by the
// per-tab CDP operations below so their logs land in the right bot's panel, not every panel.
function logWin(wid, level, text) {
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text, wid: wid == null ? null : wid }).catch(() => {});
}
// Maps a tab to its browser-window id (so a per-tab operation can tag its logs for that window).
async function widForTab(tabId) {
  if (!tabId) return null;
  try { return (await chrome.tabs.get(tabId)).windowId; } catch (_) { return null; }
}
