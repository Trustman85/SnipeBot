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
  // Watchlist auto-restart after a successful checkout (content scheduled it, we survive sleep)
  if (alarm.name.startsWith('rewatch:w')) {
    const wid = Number(alarm.name.slice(9));
    chrome.alarms.clear('rewatchtick:w' + wid);
    chrome.storage.local.remove('rewatchAt:w' + wid);
    resumeWatchlist(wid); return;
  }
  // Per-minute countdown so the log shows the restart approaching instead of going silent
  if (alarm.name.startsWith('rewatchtick:w')) {
    const wid = Number(alarm.name.slice(13));
    const key = 'rewatchAt:w' + wid;
    const st = await chrome.storage.local.get(key);
    const remainMs = (st[key] || 0) - Date.now();
    if (remainMs <= 0) { chrome.alarms.clear(alarm.name); return; } // restart alarm handles the rest
    logWin(wid, 'info', '⏰ Watchlist auto-restart in ' + Math.ceil(remainMs / 60000) + ' min…');
    return;
  }
  if (alarm.name !== 'keepalive') return;
  if (!(await anyBotRunning())) chrome.alarms.clear('keepalive');
});

// Restarts a window's WATCHLIST run after the post-checkout cooldown: flips its per-window state
// back to running (fresh run token) and navigates its tab to the first watch item — from there the
// normal injection/watch flow takes over exactly like a manual Start.
const REWATCH_ITEM_URL = {
  sams:          id => 'https://www.samsclub.com/ip/' + encodeURIComponent(id),
  target:        id => 'https://www.target.com/p/-/A-' + encodeURIComponent(id),
  walmart:       id => 'https://www.walmart.com/ip/' + encodeURIComponent(id),
  bestbuy:       id => 'https://www.bestbuy.com/site/x/x/' + encodeURIComponent(id) + '.p?skuId=' + encodeURIComponent(id),
  pokemoncenter: id => 'https://www.pokemoncenter.com/product/' + encodeURIComponent(id),
};
async function resumeWatchlist(wid) {
  if (wid == null || isNaN(wid)) return;
  const k = (key) => 'w' + wid + ':' + key;
  const st = await chrome.storage.local.get([k('botRunning'), k('botConfig'), k('currentTabId'), k('activeProfile')]);
  const cfg = st[k('botConfig')], tabId = st[k('currentTabId')], profile = st[k('activeProfile')];
  const wl = cfg && Array.isArray(cfg.watchlist) ? cfg.watchlist : null;
  if (!wl || !wl.length) { logWin(wid, 'warning', '⏰ Auto-restart skipped — no watchlist config left (was the panel closed?).'); return; }
  if (st[k('botRunning')]) return; // user already restarted manually — don't double-start
  const mkUrl = REWATCH_ITEM_URL[profile];
  if (!mkUrl) return;
  await chrome.storage.local.set({
    [k('botRunning')]: true, [k('botPhase')]: 'SEARCH', [k('botRunToken')]: Date.now(),
    [k('watchIndex')]: 0, [k('qtyDone')]: false, [k('addAttempts')]: 0,
  });
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
  logWin(wid, 'success', '⏰ Cooldown over — auto-restarting the watchlist (' + wl.length + ' items).');
  try {
    if (tabId != null) await chrome.tabs.update(tabId, { url: mkUrl(wl[0]) });
    else logWin(wid, 'warning', '⏰ No tab recorded for this run — open the store tab and press Start.');
  } catch (e) {
    logWin(wid, 'warning', '⏰ Auto-restart could not navigate the tab (' + (e && e.message || e) + ') — press Start manually.');
  }
}

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
  // walmart.com is MANIFEST-injected (Chrome injects on every document) — executeScript stalls on
  // those tabs (stamp/files timeouts) and is never needed there. Skip to kill the error noise.
  if (/^https?:\/\/(www\.)?walmart\.com\//i.test(url || '')) return;
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
chrome.commands.onCommand.addListener(async (command) => {
  const action = { 'start-bot': 'start', 'test-bot': 'test', 'save-config': 'save' }[command];
  if (!action) return;
  // Tag the FOCUSED window so only ITS panel acts — without this every open window's bot
  // started/stopped on one key press.
  let wid = null;
  try { const w = await chrome.windows.getLastFocused(); wid = w && w.id != null ? w.id : null; } catch (_) {}
  chrome.runtime.sendMessage({ type: 'HOTKEY', action, wid }).catch(() => {});
});

// Central message listener — background script is always alive and receives messages from popup and content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Popup sent START_BOT — kick off the bot with the user's config
  if (msg.type === 'START_BOT') startBot(msg.config);

  // Popup sent STOP_BOT — stop just that window's bot (wid provided), else a full global stop
  if (msg.type === 'STOP_BOT') { if (msg.wid != null) stopBotWin(msg.wid); else stopBot(); }

  // Content asking which window its tab belongs to — used by MANIFEST-injected content scripts
  // (walmart.com), where no executeScript ever stamped window.__BOT_WID. sender.tab is authoritative.
  if (msg.type === 'GET_WID') { sendResponse({ wid: sender.tab?.windowId ?? null, tabId: sender.tab?.id ?? null }); return; }

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

  // Store-switch HARD reset: mimic what a REAL sidebar close+reopen gives the worker — drop ALL
  // in-memory per-tab state (injection dedup tracking) and stale debugger attachments, so the next
  // Start behaves exactly like a first Start after reopening the panel.
  if (msg.type === 'HARD_RESET') {
    for (const t in lastInjected) delete lastInjected[t];
    detachAllDebuggers();
    try { sendResponse && sendResponse(true); } catch (_) {}
    return;
  }

  // Direct-API Target checkout — runs the add→pre_checkout→checkout POSTs in the page's MAIN world
  // (so Akamai's fetch wrapper attaches its x-gyjwza5z sensor headers automatically). placeOrder
  // false = add+prep only (safe, no order). Replies on both settle so a hang can't freeze the caller.
  if (msg.type === 'TARGET_API_BUY') {
    targetApiBuy(sender.tab?.id, msg).then(r => sendResponse(r), e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  // Alert the human (desktop notification + relay a sound to the popup + optional spoken line)
  if (msg.type === 'BOT_ALERT') handleAlert(msg.kind, msg.text, msg.speak);

  // Watchlist auto-restart: content asks for it right after a successful checkout. The ALARM does
  // the waiting (survives page navigations, panel closes, and worker recycling).
  if (msg.type === 'SCHEDULE_REWATCH' && msg.wid != null) {
    const mins = msg.mins || 5;
    chrome.storage.local.set({ ['rewatchAt:w' + msg.wid]: Date.now() + mins * 60000 });
    chrome.alarms.create('rewatch:w' + msg.wid, { delayInMinutes: mins });
    chrome.alarms.create('rewatchtick:w' + msg.wid, { periodInMinutes: 1 }); // per-minute countdown in the log
  }

  // Sam's CVV + Place Order — must run in the page's MAIN world to reach React's state
  if (msg.type === 'SAMS_CHECKOUT') samsCheckout(sender.tab?.id, msg.cvv);

  // NB: every promise-based handler below MUST reply on BOTH resolve and reject — a rejected
  // promise that never calls sendResponse leaves the content script awaiting FOREVER, which is
  // exactly the "item went live, page reloaded, bot froze mid-buy" bug (Target, 2026-07-10).

  // Set a React-controlled input (e.g. Pokémon Center cart quantity) via real CDP keystrokes
  if (msg.type === 'STORE_SET_QTY') { cdpSetValue(sender.tab?.id, msg.selector, msg.value).then(() => sendResponse(true), () => sendResponse(false)); return true; }

  // Pokémon Center: type card# + CVV into the secure CyberSource iframes via CDP
  if (msg.type === 'POKE_PAY') { pokemonPay(sender.tab?.id, msg).then(() => sendResponse(true), () => sendResponse(false)); return true; }

  // Real browser-level click for buttons gated on trusted events (Target Buy now / Place order)
  if (msg.type === 'CDP_CLICK') { cdpClickSelector(sender.tab?.id, msg.selector).then(ok => sendResponse(ok), () => sendResponse(false)); return true; }

  // Find (and optionally click) a button across ALL frames — for drawers rendered in an iframe
  if (msg.type === 'PLACE_ORDER_FRAMES') { findClickInFrames(sender.tab?.id, msg).then(r => sendResponse(r), () => sendResponse({ found: false })); return true; }

  // Target CVV-confirm sidebar (in an iframe): fill #enter-cvv, optionally click Confirm
  if (msg.type === 'TARGET_CVV') { targetCvvInFrames(sender.tab?.id, msg).then(r => sendResponse(r), () => sendResponse({ ok: false })); return true; }

  // READ-ONLY diagnostic: probe Target's stock endpoints and auto-find the availability field.
  if (msg.type === 'STOCK_TEST') { targetStockTest(msg).then(r => sendResponse(r), e => sendResponse({ ok: false, error: String(e && e.message || e) })); return true; }

  // Fast stock check: fetch Target's product_fulfillment_v1 (in the page context, since Target blocks
  // the background's own fetch) and return the shipping availability. Used by the restock watcher.
  // msg.tabId: the SIDE PANEL has no sender.tab (that only exists for content-script senders), so
  // the panel passes the target tab explicitly. Fall back to sender.tab for content-script callers.
  if (msg.type === 'WM_QUEUE_POLL') { wmQueuePoll(msg.tabId || sender.tab?.id, msg.itemId).then(r => sendResponse(r), (e) => sendResponse({ ok: false, error: String(e) })); return true; }
  if (msg.type === 'STOCK_POLL') { targetStockPoll(sender.tab?.id, msg.tcin).then(r => sendResponse(r), () => sendResponse({ ok: false, status: 'ERR' })); return true; }

  // Fast stock check for stores that SSR availability into the page HTML (Sam's/Walmart GLASS):
  // fetch the product URL and read the schema.org / availabilityStatus signal. Used by the watcher.
  if (msg.type === 'HTML_STOCK_POLL') { htmlStockPoll(sender.tab?.id, msg.url, msg.mode).then(r => sendResponse(r), () => sendResponse({ ok: false, status: 'ERR' })); return true; }

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
function handleAlert(kind, text, speak) {
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
  // Spoken announcement (chrome.tts works from the service worker) — e.g. "Bot 1 item live".
  // interrupt so a fresh live-call never queues behind an old one.
  if (speak) { try { chrome.tts.speak(String(speak), { rate: 1.05, enqueue: false }); } catch (_) {} }
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
        // Walks a modules response for the product's fulfillment block (capture 2026-07-24: it sits at
        // modules[].module_data.data.product.fulfillment, same shipping_options shape as redsky's).
        // Reads OUR item's fulfillment out of a modules response. MUST be tcin-scoped: the payload also
        // carries a GlobalRecommendedProducts carousel whose OTHER products have their own
        // shipping_options — an unscoped search read a recommended item's "IN_STOCK, qty 20" and
        // falsely fired ITEM LIVE on an out-of-stock product (real false positive 2026-07-24).
        const readModules = (j) => {
          const want = String(tcin);
          const mods = (j && j.modules) || [];
          for (const m of mods) {
            const prod = m && m.module_data && m.module_data.data && m.module_data.data.product;
            const f = prod && prod.fulfillment;
            // Accept only when this fulfillment belongs to OUR tcin (product_id is inside the block).
            if (f && (String(f.product_id || prod.tcin || '') === want)) {
              const so = f.shipping_options || {};
              return { status: 200, avail: so.availability_status || null, qty: so.available_to_promise_quantity,
                       soldOut: !!f.sold_out, src: 'cdui' };
            }
          }
          // Fallback for a nesting change: anchor on OUR tcin's fulfillment block, never a loose match.
          try {
            const blob = JSON.stringify(j);
            const i = blob.indexOf('"fulfillment":{"product_id":"' + want + '"');
            if (i >= 0) {
              const seg = blob.slice(i, i + 1200);
              const k = seg.indexOf('"shipping_options"');
              if (k >= 0) {
                const sub = seg.slice(k, k + 500);
                const a = (sub.match(/"availability_status"\s*:\s*"([A-Z_]+)"/) || [])[1] || null;
                const q = parseFloat((sub.match(/"available_to_promise_quantity"\s*:\s*([0-9.]+)/) || [])[1]);
                if (a) return { status: 200, avail: a, qty: isNaN(q) ? undefined : q, src: 'cdui*' };
              }
            }
          } catch (_) {}
          return null;
        };
        // PRIMARY: replay the PAGE's OWN stock request (captured by targetstock.js in this MAIN world).
        // This is the endpoint target.com actually uses now; redsky 403s after a burst. Only used when
        // the captured request is for the SAME tcin — otherwise it would report another item's stock.
        // In-page capture, else the sessionStorage copy (survives reloads / bot started after load).
        let req = window.__botTgtStockReq;
        if (!req) { try { req = JSON.parse(sessionStorage.getItem('__botTgtStockReq') || 'null'); } catch (_) { req = null; } }
        // Diagnostics so a missing capture is visible in the log instead of silently falling back:
        // hook = targetstock.js installed?  req = a fulfillment request captured yet?
        const diag = (window.__botTgtStockHook ? 'hook' : 'nohook') + ':' + (req ? ('req' + (req.tcin || '?')) : 'noreq');
        // Build the replay attempts. EXACT = a capture taken on this item's own page. BORROWED =
        // another item's capture with the tcin swapped in the URL (and anywhere it appears in the
        // body as plain text). A watchlist watches N items but the tab sits on ONE product page, so
        // without borrowing only that single item gets the fast cdui endpoint and every other item
        // silently falls back to the LAGGY redsky one — which is the whole thing cdui exists to fix
        // (observed 2026-08-11: an 8-item watchlist reported [cdui/redsky], 7 of 8 on redsky).
        // Borrowing is SAFE because readModules only accepts a fulfillment block whose product_id
        // matches the tcin we asked for: if Target honours the base64 page_context over the tcin
        // param, the reply simply won't match and we fall through to redsky as before.
        const attempts = [];
        if (req && req.body) {
          if (!req.tcin || String(req.tcin) === String(tcin)) attempts.push({ url: req.url, body: req.body, src: 'cdui', exact: true });
          else {
            const u2 = String(req.url).replace(/([?&]tcin=)\d+/, '$1' + tcin);
            const b2 = String(req.body).split(String(req.tcin)).join(String(tcin));
            if (u2 !== req.url || b2 !== req.body) attempts.push({ url: u2, body: b2, src: 'cdui~', exact: false });
          }
        }
        for (const at of attempts) {
          try {
            const res = await fetch(at.url, { method: 'POST', credentials: 'include',
              headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: at.body });
            if (res.ok) {
              const hit = readModules(await res.json());
              if (hit) return Object.assign(hit, { src: at.src });
              if (!at.exact) continue;   // borrowed miss: keep the capture, it's still good for ITS item
              // Replay didn't carry our item's fulfillment (stale/wrong captured request). Drop the
              // capture so it can be re-taken, and FALL THROUGH to redsky — returning "no data" made
              // the watcher reload the page over and over (2026-07-26).
              try { sessionStorage.removeItem('__botTgtStockReq'); window.__botTgtStockReq = null; } catch (_) {}
            }
          } catch (_) {} // fall through to redsky
        }
        // FALLBACK: legacy redsky endpoint (works until it rate-limits us to 403).
        const key = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
        const url = 'https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?key=' + key +
                    '&tcin=' + tcin + '&is_bot=false&channel=WEB&page=%2Fp%2FA-' + tcin;
        try {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return { status: res.status, diag };
          const j = await res.json();
          const so = (j && j.data && j.data.product && j.data.product.fulfillment && j.data.product.fulfillment.shipping_options) || {};
          return { status: 200, avail: so.availability_status || null, qty: so.available_to_promise_quantity, src: 'redsky', diag };
        } catch (e) { return { status: 'ERR', error: e.message, diag }; }
      }
    });
    return { ok: true, ...(out && out.result || {}) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Stock check via the product page HTML (Sam's/Walmart GLASS SSR the availability into the page).
// Fetches the URL in the tab's page context and reads the main product's schema.org availability
// (falling back to the first availabilityStatus). Returns { inStock, status }.
// Direct-API Target buy. Runs the captured 3-call checkout in the page's MAIN world so Target's
// Akamai SDK (which wraps window.fetch) injects the x-gyjwza5z sensor headers + the session cookies
// ride along via credentials:include. The calls are session-cart based (no ids passed between them).
//   opts: { tcin, quantity, fulfillment, placeOrder }
//   placeOrder=false → add+pre_checkout ONLY (never completes an order — safe for Test).
// ── WALMART QUEUE POLL (read-only probe) ────────────────────────────────────────────────────────
// Walmart's /qp page appears to REFRESH ITSELF every 26-33s (nextRefreshUnixTimestamp + a fresh
// server signature each time) rather than calling a status API — four capture attempts on 2026-08-19
// caught nothing but display-ad GraphQL. If that's right there is no hidden endpoint to replay, but
// we don't need one: the queue state IS the qpdata blob, and requesting the item URL with the
// guest's own cookies makes Walmart mint a fresh, currently-signed one. So we fetch the item URL
// in the PAGE (MAIN world, same origin + Akamai's fetch wrapper) and read qpdata off the redirect.
// That turns a 26-33s wait for "is it my turn" into a poll WE control.
// Purely READ-ONLY: a GET of a product page, no cart, no order, nothing mutated.
async function wmQueuePoll(tabId, itemId) {
  if (!tabId || !itemId) return { ok: false, error: 'no tab/itemId' };
  const [out] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', args: [String(itemId)],
    func: async (id) => {
      const parse = (u) => {
        const m = String(u || '').match(/[?&]qpdata=([^&#]+)/);
        if (!m) return null;
        let raw = m[1];
        for (let i = 0; i < 3; i++) {
          try { return JSON.parse(decodeURIComponent(raw)); }
          catch (_) { try { const d = decodeURIComponent(raw); if (d === raw) break; raw = d; } catch (_) { break; } }
        }
        return null;
      };
      try {
        const t0 = Date.now();
        const res = await fetch('https://www.walmart.com/ip/' + encodeURIComponent(id), { credentials: 'include' });
        const ms = Date.now() - t0;
        // The ticket usually rides on the REDIRECTED url; fall back to scanning the HTML for a qpdata blob.
        let qp = parse(res.url);
        if (!qp) { const t = await res.text(); const m = t.match(/qpdata=([A-Za-z0-9%._-]+)/); if (m) qp = parse('?qpdata=' + m[1]); }
        if (!qp) return { ok: true, found: false, status: res.status, finalUrl: String(res.url || '').slice(0, 120), ms };
        return { ok: true, found: true, status: res.status, ms,
                 state: qp.state, ticket: qp.ticket, queue: qp.queue,
                 turnAt: qp.expectedTurnTimeUnixTimestamp,
                 nextRefresh: qp.nextRefreshRelativeTime,
                 yourTurn: qp.state === 'valid' };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
  });
  return (out && out.result) || { ok: false, error: 'no result' };
}

async function targetApiBuy(tabId, opts) {
  if (!tabId) return { ok: false, error: 'no tab' };
  // Whether THIS account's saved card actually demands a CVV. Learned from a real order and kept in
  // storage, because the only place that answer exists (pre_checkout's is_cvv_required) is the very
  // call the fast path skips. Unknown = try the fast path; we find out once and never re-pay for it.
  let cvvRequired;
  try { ({ tgtCvvRequired: cvvRequired } = await chrome.storage.local.get('tgtCvvRequired')); } catch (_) {}
  const o0 = Object.assign({}, opts || {}, { cvvRequired });
  const res = await withTimeout(chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', args: [o0],
    func: async (o) => {
      const H = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'x-application-name': 'web' };
      const KADD = '9f36aeafbe60771e321a7cc95a78140772ab3e96'; // target.com web cart key (read live later if it rotates)
      const KCO  = 'e59ce3b531b2c39afb2e2b8a71ff10113aac2a14'; // target.com web checkout key
      const CART = 'https://carts.target.com/web_checkouts/v1/';
      const post = async (url, body) => {
        const r = await fetch(url, { method: 'POST', credentials: 'include', headers: H, body: body ? JSON.stringify(body) : undefined });
        let j = null; try { j = await r.json(); } catch (_) {}
        return { status: r.status, body: j };
      };
      // Per-step wall-clock, so "the API takes ~3s" can be attributed to a specific call instead of
      // guessed at. All three POSTs are strictly sequential (each needs the previous one's server
      // state), so these add up to the total. Reported on every result, success or failure.
      const T = { add: 0, pre: 0, checkout: 0 };
      const t0 = Date.now(); let mark = t0;
      const lap = (k) => { const now = Date.now(); T[k] = now - mark; mark = now; };
      try {
        // 1) ADD TO CART. Shippable items (the drop case) send NO fulfillment field — Target
        // defaults to ship (capture 2026-07-23: tcin 79517000 → REGULARITEM, no fulfillment).
        // Only pickup items carry a fulfillment block (location_id), which we generally can't
        // scrape → those fall back to the UI. cart_subchannel:BUYNOW isolates an EXPRESS cart so
        // we buy ONLY this item, never whatever else is in the guest's main cart.
        const addBody = {
          cart_item: { item_channel_id: '10', tcin: String(o.tcin), quantity: o.quantity || 1 },
          cart_type: 'REGULAR', channel_id: '10', shopping_context: 'DIGITAL', cart_subchannel: 'BUYNOW'
        };
        if (o.fulfillment) addBody.fulfillment = o.fulfillment;
        const add = await post(CART + 'cart_items?field_groups=CART,CART_ITEMS,SUMMARY&key=' + KADD, addBody);
        lap('add');
        if (add.status < 200 || add.status >= 300) return { ok: false, step: 'add', status: add.status, body: add.body, T };
        // MAX-PRICE GUARD (best-effort): pull the unit price from the add response and abort BEFORE
        // checkout if it's over the item's max. Only blocks when a price is actually found, so it
        // can never wrongly stop a good buy. o.maxPrice<=0 or missing → no check.
        if (o.maxPrice && o.maxPrice > 0) {
          const blob = JSON.stringify(add.body || {});
          const pm = blob.match(/"(?:current_retail|unit_price|list_price|price|reg_retail)"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
          const price = pm ? parseFloat(pm[1]) : null;
          if (price != null && price > o.maxPrice) return { ok: false, step: 'price', price, max: o.maxPrice, body: add.body };
        }
        // 2) PRE-CHECKOUT — acts on the session cart. Body MUST include cart_type (capture
        // 2026-07-23: {} → 400 "cart_type must not be null"). RACE: the add returns 201 but the
        // cart backend can lag a few ms, so pre_checkout sometimes sees ZERO_CART_ITEM_QUANTITY
        // ("Cart is empty") — retry a few times with a short backoff before giving up.
        // cart_subchannel:BUYNOW is REQUIRED so pre_checkout/checkout act on the ISOLATED express
        // cart the add created — without it they look at the empty MAIN cart → "Cart is empty"
        // (ZERO_CART_ITEM_QUANTITY). Still retry that error a few times for the propagation race.
        // FIELD_GROUPS TRIMMED (measured 2026-08-11, Test-mode benchmark on tcin 95028728):
        //   full 9 groups 732ms · CART,PAYMENT_INSTRUCTIONS 415ms · PAYMENT_INSTRUCTIONS 393ms
        //   (omitted entirely) 429ms but UNUSABLE — loses reference_id/payment_instructions.
        // We read exactly three things from this reply: reference_id, payment_instructions (for the
        // CVV attach) and cart_state — so CART,PAYMENT_INSTRUCTIONS is the smallest SAFE set. The
        // dropped groups (addresses, delivery windows, finance providers, pickup, promos, summary)
        // were assembled by Target on every call and never read. ~45% off the slowest step.
        // Re-measure with the Test-mode benchmark before trimming further.
        const preUrl = CART + 'pre_checkout?cart_type=REGULAR&field_groups=CART,PAYMENT_INSTRUCTIONS&key=' + KCO;
        const preBody = { cart_type: 'REGULAR', cart_subchannel: 'BUYNOW' };
        const runPre = async () => {
          let p2 = await post(preUrl, preBody);
          for (let a = 0; a < 4 && (p2.status < 200 || p2.status >= 300) && p2.body && p2.body.code === 'ZERO_CART_ITEM_QUANTITY'; a++) {
            await new Promise(r => setTimeout(r, 200));
            p2 = await post(preUrl, preBody);
          }
          return p2;
        };
        // FAST PATH — SKIP pre_checkout. The checkout call does NOT consume anything pre_checkout
        // returns: its body is just {cart_type, cart_subchannel}, and pre's reference_id is only
        // ever logged. The one genuine dependency is payment_instructions, and that is needed ONLY
        // to attach a CVV. So when no CVV is in play we go straight from add -> checkout and save a
        // whole ~870ms round trip. If Target rejects that (the cart really did need preparing) the
        // checkout step below runs pre_checkout and retries ONCE — so the order is never lost, it
        // just costs one wasted call. Skipped entirely in Test mode, which needs pre's reply.
        // Gate the fast path on whether Target ACTUALLY demands a CVV, not on whether one happens
        // to be filled in. A verified card needs none (is_cvv_required=false), and keying off the
        // mere presence of the field silently disabled the skip (real order 2026-08-11: pre still
        // ran, 980ms wasted). If Target does want it, checkout 400s MISSING_CREDIT_CARD_CVV and the
        // recovery below runs pre_checkout, attaches the CVV, and retries — correct either way.
        // o.cvvRequired is what we LEARNED on a previous run (persisted by the caller):
        //   true  -> this card really does need a CVV: run pre_checkout up front and attach it,
        //            so we never pay for a checkout that is going to be refused.
        //   false/undefined -> take the fast path and find out. A refusal is self-healing below,
        //            and the answer is remembered so it only ever costs us once.
        const skipPre = !!o.placeOrder && o.cvvRequired !== true;
        let pre = skipPre ? null : await runPre();
        if (!skipPre) {
          lap('pre');
          if (pre.status < 200 || pre.status >= 300) return { ok: false, step: 'pre', status: pre.status, body: pre.body, T };
        }
        const refId = pre && pre.body && pre.body.reference_id, cartId = (add.body && add.body.cart_id);
        // The cart's payment instructions come back from pre_checkout (PAYMENT_INSTRUCTIONS field
        // group). Target 400s the checkout with MISSING_CREDIT_CARD_CVV when a saved card needs its
        // CVV re-entered, so we have to attach it here. Report the SHAPE (keys + ids, never the card
        // number) so a Test run shows exactly which field names this account returns.
        const pis = (pre && pre.body && (pre.body.payment_instructions || pre.body.paymentInstructions)) || [];
        const piShape = (Array.isArray(pis) ? pis : []).map(p => ({
          keys: Object.keys(p || {}),
          id: (p && (p.payment_instruction_id || p.id)) || null,
          type: (p && (p.payment_type || p.card_type || (p.card_details && p.card_details.card_type))) || null,
        }));
        if (!o.placeOrder) {
          // ── FIELD_GROUPS BENCHMARK (Test mode only — never runs on a real buy) ────────────────
          // pre_checkout is the fattest call: we ask for NINE field groups and read exactly two
          // things from the reply (reference_id, payment_instructions). Re-run it on the SAME cart
          // with progressively smaller field_groups and time each, so trimming is a measured
          // decision instead of a guess. Safe to repeat: the ZERO_CART race already retries this
          // call up to 4x, and it prepares a cart rather than mutating stock or placing anything.
          // Each variant is timed twice and the FASTER run kept, so one slow packet can't decide it.
          const bench = [];
          if (o.bench) {
            const VARIANTS = [
              ['full (current)', 'ADDRESSES,CART,CART_ITEMS,DELIVERY_WINDOWS,FINANCE_PROVIDERS,PAYMENT_INSTRUCTIONS,PICKUP_INSTRUCTIONS,PROMOTION_CODES,SUMMARY'],
              ['payment+cart', 'CART,PAYMENT_INSTRUCTIONS'],
              ['payment only', 'PAYMENT_INSTRUCTIONS'],
              ['none', ''],
            ];
            for (const [label, fg] of VARIANTS) {
              const u = CART + 'pre_checkout?cart_type=REGULAR' + (fg ? '&field_groups=' + fg : '') + '&key=' + KCO;
              let best = null, okAll = true, hadPay = false, hadRef = false;
              for (let run = 0; run < 2; run++) {
                const s = Date.now();
                const rr = await post(u, preBody);             // single call, no retry — times ONE round trip
                const ms = Date.now() - s;
                if (rr.status < 200 || rr.status >= 300) okAll = false;
                const b = rr.body || {};
                if (b.reference_id) hadRef = true;
                if ((b.payment_instructions || b.paymentInstructions || []).length) hadPay = true;
                best = best == null ? ms : Math.min(best, ms);
              }
              // usable = still returns BOTH things the real checkout depends on.
              bench.push({ label, fg: fg || '(omitted)', ms: best, ok: okAll, usable: okAll && hadRef && hadPay });
            }
          }
          return { ok: true, placed: false, cartId, refId, state: pre && pre.body && pre.body.cart_state, piShape, T, bench };
        }
        // 3) CHECKOUT — PLACES THE ORDER (Akamai adds sensor headers to this in-page fetch). Same
        // BUYNOW subchannel so it completes the express cart, not the main cart.
        // Built fresh each time: on the fast path there are no payment instructions yet (we skipped
        // pre_checkout), so this is a bare body. If the recovery runs pre_checkout we rebuild it
        // WITH the CVV attached to the card instruction.
        const buildCoBody = (instr) => {
          const b = { cart_type: 'REGULAR', cart_subchannel: 'BUYNOW' };
          if (!o.cvv) return b;
          const arr = Array.isArray(instr) ? instr : [];
          // Prefer the CARD instruction (an account can also carry gift cards / EBT etc).
          const card = arr.find(p => p && (p.card_details || /CARD|CREDIT|DEBIT/i.test(String(p.payment_type || p.card_type || '')))) || arr[0];
          const pid = card && (card.payment_instruction_id || card.id);
          if (pid) b.payment_instructions = [{ payment_instruction_id: pid, cvv: String(o.cvv) }];
          return b;
        };
        let coBody = buildCoBody(pis);
        // FIELD_GROUPS TRIMMED to match pre_checkout (2026-08-11). We read only orders[0].order_id /
        // .reference_id / .cart_state, all top-level in the response — the six dropped groups
        // (addresses, cart items, finance providers, pickup, promos, summary) were assembled every
        // time and never read. field_groups shapes the RESPONSE only; it does not change what the
        // call does. UNLIKE pre_checkout this could not be benchmarked — every measurement would
        // place a real order — so it is validated on the next live buy via the ⏱ timing line.
        // ROLLBACK, if an order ever fails at the checkout step right after this change: restore
        //   field_groups=ADDRESSES,CART,CART_ITEMS,FINANCE_PROVIDERS,PAYMENT_INSTRUCTIONS,PICKUP_INSTRUCTIONS,PROMOTION_CODES,SUMMARY
        const coUrl = CART + 'checkout?cart_type=REGULAR&field_groups=CART,PAYMENT_INSTRUCTIONS&key=' + KCO;
        let co = await post(coUrl, coBody);
        // RECOVERY for the skipped pre_checkout. If we skipped it and Target refused, the cart most
        // likely needed preparing — so prepare it and retry ONCE.
        // DOUBLE-ORDER GUARD: only retry when the reply carries NO order id. A response that
        // already created an order must never be re-sent, whatever its status code says.
        let preRecovered = false, learnedCvvRequired = null;
        if (skipPre && (co.status < 200 || co.status >= 300)) {
          // Remember WHY we had to recover, so the next run starts on the right path.
          const code = String((co.body && (co.body.code || co.body.errorKey)) || '') + ' ' + String((co.body && co.body.message) || '');
          if (/CVV|PIN on payment/i.test(code)) learnedCvvRequired = true;
          const madeOrder = !!(co.body && co.body.orders && co.body.orders[0] && co.body.orders[0].order_id);
          if (!madeOrder) {
            pre = await runPre();
            lap('pre');
            preRecovered = true;
            if (pre.status >= 200 && pre.status < 300) {
              // Now we HAVE the payment instructions — re-attach the CVV before retrying, which is
              // what makes a MISSING_CREDIT_CARD_CVV rejection self-healing.
              coBody = buildCoBody(pre.body && (pre.body.payment_instructions || pre.body.paymentInstructions));
              co = await post(coUrl, coBody);
            }
            else return { ok: false, step: 'pre', status: pre.status, body: pre.body, T, preRecovered };
          }
        }
        lap('checkout');
        const order = co.body && co.body.orders && co.body.orders[0];
        const done = co.status >= 200 && co.status < 300 && order && /COMPLETED/i.test(order.cart_state || '');
        // An order placed WITHOUT pre_checkout proves this card needs no CVV — record that so the
        // fast path stays on. Only recorded on a real success, never inferred from a failure.
        if (done && skipPre && !preRecovered) learnedCvvRequired = false;
        return { ok: !!done, placed: !!done, step: 'checkout', status: co.status,
                 orderId: order && order.order_id, refId: (order && order.reference_id) || refId,
                 state: order && order.cart_state, body: done ? null : co.body,
                 piShape, sentCvv: !!coBody.payment_instructions, T, total: Date.now() - t0,
                 skippedPre: skipPre && !preRecovered, preRecovered, learnedCvvRequired };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
  }), 22000, 'target-api').catch(e => null);
  const out = (res && res[0] && res[0].result) || { ok: false, error: 'no result (page busy?)' };
  // Persist what the run learned, so the next grab starts on the correct path with no wasted call.
  if (out && typeof out.learnedCvvRequired === 'boolean' && out.learnedCvvRequired !== cvvRequired) {
    try {
      await chrome.storage.local.set({ tgtCvvRequired: out.learnedCvvRequired });
      log('info', out.learnedCvvRequired
        ? '💳 Learned: this Target card REQUIRES a CVV — future grabs will send it up front (no wasted call).'
        : '💳 Learned: this Target card needs no CVV — future grabs skip pre_checkout entirely.');
    } catch (_) {}
  }
  return out;
}

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
          // POKÉMON CENTER: poll either the tpci-ecommweb-api product/status endpoint (tiny JSON —
          // preferred) or the PDP HTML. Sniffed signals: "availability":"NOT_AVAILABLE" /
          // schema.org/OutOfStock when dead; InStock/AVAILABLE when live; PreOrder counts as
          // BUYABLE (preorder-ready). NB: the page also ships an i18n label map with strings like
          // "availability":"Availability" — the value alternatives below can't match those labels.
          if (mode === 'pokemon') {
            const live = /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?(?:InStock|LimitedAvailability|AVAILABLE|IN_STOCK)"/i.test(t);
            const pre  = /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?(?:PreOrder|PRE_?ORDER)"/i.test(t) || /schema\.org\/PreOrder/i.test(t);
            const oos  = /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?(?:OutOfStock|SoldOut|Discontinued|NOT_AVAILABLE|OUT_OF_STOCK|UNAVAILABLE)"/i.test(t);
            const status = live ? 'InStock' : (pre ? 'PreOrder' : (oos ? 'OutOfStock' : 'unknown'));
            return { status, inStock: live || pre };
          }
          // FIRST schema.org availability only — the MAIN product's markup is SSR'd before the
          // "customers also bought" carousels, whose in-stock items false-positive a whole-page test.
          const av = t.match(/schema\.org\/(InStock|LimitedAvailability|PreOrder|OutOfStock|SoldOut|Discontinued)/i);
          if (av) return { status: av[1], inStock: /InStock|LimitedAvailability|PreOrder/i.test(av[1]) };
          // Fallback: first availabilityStatus (Walmart-style) or availability_status (Target-style)
          // in the SSR'd data.
          const m = t.match(/"availabilityStatus"\s*:\s*"([^"]+)"/) || t.match(/"availability_status"\s*:\s*"([^"]+)"/);
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
