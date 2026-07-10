// ── Per-window state namespacing (mirror of popup.js / background.js) ───────────
// Per-window keys are stored as "w<windowId>:<key>" (background stamped window.__BOT_WID before
// injecting us). NS_ON is the shared kill-switch — popup.js, background.js and content.js must ALL
// agree. false = old global single-window behavior (Step 4a); true = per-window isolation (Step 4b).
// Declared with var/function (NOT const) so a re-injection into an ALREADY-INJECTED world doesn't
// throw "already declared" and abort the whole script. SPA route changes (Sam's "View Cart",
// Target's Buy-now drawer, etc.) keep the SAME document, so the content script re-runs in the SAME
// world — const would crash on the 2nd run and the bot would silently stall.
var NS_ON = true;
var PW_KEYS = new Set(['botRunning', 'botPhase', 'botConfig', 'activeProfile', 'currentTabId',
  'botTestMode', 'botRunToken', 'burstUntil', 'queueSince', 'qtyDone', 'samsFellBack', 'addAttempts',
  'pokePlaceRetries', 'armState', 'watchIndex']);
function _wid() { return (typeof window.__BOT_WID === 'number') ? window.__BOT_WID : null; }
function nsk(key) { return (NS_ON && _wid() != null && PW_KEYS.has(key)) ? ('w' + _wid() + ':' + key) : key; }
// Wrappers that auto-namespace ONLY per-window keys (global keys pass through); return original names.
function wget(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  const mapped = arr.map(nsk);
  return chrome.storage.local.get(mapped).then(res => {
    const out = {}; arr.forEach((orig, i) => { out[orig] = res[mapped[i]]; }); return out;
  });
}
function wset(obj)    { const o = {}; for (const key in obj) o[nsk(key)] = obj[key]; return chrome.storage.local.set(o); }
function wremove(keys){ const arr = Array.isArray(keys) ? keys : [keys]; return chrome.storage.local.remove(arr.map(nsk)); }

// Runs on every page load — checks current bot phase and acts accordingly
(async () => {
  try {
    const { botRunning, botPhase, botConfig, activeProfile, burstUntil, botRunToken, windowNames } = await wget(['botRunning', 'botPhase', 'botConfig', 'activeProfile', 'burstUntil', 'botRunToken', 'windowNames']);
    // Step telemetry — proves the content script executed and reports the state it read. Tagged with
    // THIS tab's window id so it lands ONLY in the owning window's panel (per-window activity log).
    chrome.runtime.sendMessage({ type: 'BOT_LOG', level: 'info', wid: _wid(),
      text: '🔬 content ran @' + location.pathname.slice(0, 40) + ' | wid=' + _wid() +
            ' running=' + !!botRunning + ' cfg=' + !!botConfig + ' token=' + botRunToken +
            ' lastTok=' + (window.__botRunToken || 'none') }).catch(() => {});
    if (!botRunning || !botConfig) {
      // If this injection came from an EXPLICIT Start (background stamped __BOT_EXPLICIT) yet the
      // run state is invisible from this tab, say so in the panel — the classic cause is a
      // window-id mismatch between the panel and this tab, and silence here made it undebuggable.
      if (window.__BOT_EXPLICIT && Date.now() - window.__BOT_EXPLICIT < 8000) {
        window.__BOT_EXPLICIT = 0;
        chrome.runtime.sendMessage({ type: 'BOT_LOG', level: 'error', wid: _wid(),
          text: '⚠️ Injected on Start but found no run state in this tab (wid=' + _wid() +
                ', running=' + !!botRunning + ', config=' + !!botConfig + ') — reopen the sidebar and tell the dev.' }).catch(() => {});
      }
      return;
    }
    // Which window/bot is this tab part of? Background stamped window.__BOT_WID before injecting us;
    // map it to the friendly "Bot N" label so the log clearly says which bot a tab belongs to.
    const myWid  = (typeof window.__BOT_WID === 'number') ? window.__BOT_WID : null;
    const botNum = (windowNames && myWid != null && windowNames[myWid]) || '?';
    // Dedup guard: window persists across injections into the SAME document. Skip ONLY when
    // both the URL and the run-token are unchanged (a true duplicate injection within one run).
    //  • A real navigation/reload makes a fresh document (window reset) → runs again.
    //  • An SPA route change (same document, new URL) → URL differs → runs again.
    //  • Stopping and pressing Start again gets a NEW token → runs again on the same page.
    if (window.__botLastUrl === location.href && window.__botRunToken === botRunToken) return;
    window.__botLastUrl  = location.href;
    window.__botRunToken = botRunToken;
    const isSams = activeProfile === 'sams';
    const store  = (window.__STORES && window.__STORES[activeProfile]) || null; // non-Sam's store adapter
    const isStore = isSams || !!store;
    // Short, readable item id: Target's TCIN (the digits after /A-), else the last path segment.
    const itemId = (location.pathname.match(/\/A-(\d+)/) || [])[1] || location.pathname.replace(/\/+$/, '').split('/').pop() || location.pathname;
    // The panel prepends (newest on top), so log the detail line FIRST and the headline LAST,
    // which renders as: "Bot N live" on top with the profile/store/wid detail directly under it.
    log('info', 'profile=' + activeProfile + ' store=' + (isStore ? 'yes' : 'NO-adapter') + ' [wid=' + myWid + ']');
    log('info', '⚙️ Bot ' + botNum + ' live #' + itemId);
    // Burst mode (around a drop): reload as fast as possible to catch the item going live
    const burst = burstUntil && Date.now() < burstUntil;

    const page = window.location.pathname;

    // ── CAPTCHA / bot challenge ────────────────────────────────────
    // The bot can't solve these — pause, alert the human repeatedly, and WAIT for it to be
    // cleared (don't reload, which can make it worse). Resume once it's gone. Also checked
    // mid-checkout below, since press-and-hold / DataDome often appear AFTER a click.
    if (isStore && !(await awaitCaptchaClear('page'))) return;

    // ── High-demand QUEUE / waiting room ───────────────────────────
    // If the site put us in a waiting line, WAIT it out — do NOT reload (that can lose
    // your place). Track elapsed time, the queue's est-wait/position, and report to the panel.
    if (isStore && detectQueue()) {
      // Walmart: the qpdata URL carries your exact position (ticket #), the item, your odds, an ETA,
      // and whether it's your turn (state=valid). Surface it so you can see where you stand per item.
      const wq = (typeof readWalmartQueue === 'function') ? readWalmartQueue() : null;
      if (wq && wq.yourTurn) {
        setStep('🎉 Your turn', (wq.itemName || wq.itemId || 'item') + ' — proceeding to buy!', 'done');
        chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'success', text: 'Walmart: it\'s your turn — ' + (wq.itemName || 'item') }).catch(() => {});
        await wremove('queueSince');
        chrome.runtime.sendMessage({ type: 'BOT_QUEUE', state: 'out' }).catch(() => {});
        // NOT a blocking queue anymore — fall through to the buy flow below.
      } else {
        // Persist the queue start time so "time in line" survives queue-page reloads
        let qs = (await wget('queueSince')).queueSince;
        if (!qs) { qs = Date.now(); await wset({ queueSince: qs }); }
        if (wq) {
          setStep('🎟️ In line', '#' + (wq.ticket || '?') + ' for "' + (wq.itemName || wq.itemId || 'item') + '"' +
            (wq.likelihood ? ' · odds: ' + wq.likelihood : '') +
            (etaFromEpoch(wq.turnAt) ? ' · turn ' + etaFromEpoch(wq.turnAt) : ''));
        } else {
          setStep('⏳ In queue', 'high demand — waiting in line (will not reload)');
        }
        chrome.runtime.sendMessage({ type: 'BOT_QUEUE', state: 'in', since: qs, info: readQueueInfo() }).catch(() => {});

        let waited = 0, held = false, lastPos = wq && wq.ticket;
        while (detectQueue()) {
          // Your turn can flip mid-wait (state → valid): stop waiting and go buy.
          const now = (typeof readWalmartQueue === 'function') ? readWalmartQueue() : null;
          if (now && now.yourTurn) {
            setStep('🎉 Your turn', (now.itemName || now.itemId || 'item') + ' — proceeding to buy!', 'done');
            chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'success', text: 'Walmart: it\'s your turn — ' + (now.itemName || 'item') }).catch(() => {});
            break;
          }
          // Log position changes so you can watch it move up the line (per item).
          if (now && now.ticket && now.ticket !== lastPos) {
            log('info', '🎟️ Position now #' + now.ticket + (etaFromEpoch(now.turnAt) ? ' · turn ' + etaFromEpoch(now.turnAt) : ''));
            lastPos = now.ticket;
          }
          // Walmart's queue page has a "Hold my spot and Keep shopping" button that SECURES your
          // place in line — unlike a passive Queue-it room, you must CLICK it. Do so once, then wait.
          if (!held && await clickQueueHoldSpot(store)) { held = true; await sleep(1500); continue; }
          chrome.runtime.sendMessage({ type: 'BOT_QUEUE', state: 'in', since: qs, info: readQueueInfo() }).catch(() => {});
          await sleep(3000); waited += 3;
          if (waited % 15 === 0) log('info', 'Still in queue... (' + Math.round((Date.now() - qs) / 1000) + 's in line)');
          const st = await wget('botRunning');
          if (!st.botRunning) return; // user stopped
        }
        await wremove('queueSince');
        chrome.runtime.sendMessage({ type: 'BOT_QUEUE', state: 'out' }).catch(() => {});
        log('success', 'Queue cleared after ' + Math.round((Date.now() - qs) / 1000) + 's — continuing');
      }
    }

    // Report any post-queue "complete checkout within MM:SS" window to the panel
    if (isStore) {
      const ct = readCheckoutTimer();
      if (ct) chrome.runtime.sendMessage({ type: 'BOT_CHECKOUT_TIMER', remaining: ct }).catch(() => {});
    }

    // ── Non-Sam's store: run the generic (scaffold) flow from its adapter ───────────
    if (store && !isSams) { await runStore(store, botConfig, burst); return; }

    // Smart step detection (Sam's): figure out which step the PAGE is actually on and
    // act on that, self-correcting if the stored phase is stale or steps were skipped.
    let phase = botPhase;
    let autoDetected = false;
    if (isSams) {
      const detected = detectSamsPhase();
      if (detected) { phase = detected; autoDetected = detected !== botPhase; }
    }

    // Named steps so the bot (and the log/status bar) always show where it is.
    const STEPS = {
      RESULTS:  { n: 1, label: 'Search — open item' },
      SEARCH:   { n: 1, label: 'Find & add item' },
      ADDED:    { n: 2, label: 'Item added — open cart' },
      CART:     { n: 3, label: 'Cart — proceed to checkout' },
      CHECKOUT: { n: 4, label: 'Checkout — enter payment' },
      CONFIRM:  { n: 5, label: 'Confirm order' },
    };
    const step = STEPS[phase] || { n: '?', label: phase };
    const stepText = 'Step ' + step.n + '/5: ' + step.label;
    log('info', '── ' + stepText + (autoDetected ? ' (auto-detected)' : '') + ' | Page: ' + page + ' ──');
    setStatus('running', stepText);

  // ── PHASE: RESULTS (Sam's By Name search) ──────────────────────
  // On the Sam's search-results page — pick the product whose title best matches what
  // was searched (not just the first link, which can be a sponsored / "you might also
  // like" tile), then open it so the normal flow runs.
  if (phase === 'RESULTS' && isSams) {
    setStatus('running', 'Opening best match...');
    log('info', 'Search results — matching "' + (botConfig.itemName || '') + '"...');

    // Words from the searched name (ignore short/filler words)
    const want = (botConfig.itemName || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);

    const tileOf = (a) => a.closest('[data-testid*="product"], [data-testid*="result"], li, [class*="tile"], [class*="card"]') || a.parentElement || a;

    // Wait for product links, then score each by how many search words its tile contains
    const link = await new Promise(resolve => {
      const pickBest = () => {
        const links = [...document.querySelectorAll('a[href*="/ip/"]')];
        if (!links.length) return null;
        let best = null, bestScore = -1;
        for (const a of links) {
          const text = (a.textContent + ' ' + (tileOf(a).textContent || '')).toLowerCase();
          const score = want.length ? want.filter(w => text.includes(w)).length : 1;
          if (score > bestScore) { bestScore = score; best = a; }
        }
        // Require at least half the search words to match before committing
        return (want.length === 0 || bestScore >= Math.ceil(want.length / 2)) ? best : null;
      };
      const el = pickBest(); if (el) return resolve(el);
      const obs = new MutationObserver(() => { const el = pickBest(); if (el) { obs.disconnect(); resolve(el); } });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(pickBest() || document.querySelector('a[href*="/ip/"]')); }, 8000);
    });

    if (!link) {
      // Keep pushing — results may be slow to render under load; reload and retry
      log('warning', 'No product in results yet — reloading search and retrying...');
      setStatus('running', 'Waiting for results...');
      await sleep(1500);
      location.reload();
      return;
    }
    log('success', 'Opening: "' + (tileOf(link).textContent.trim().substring(0, 50) || link.href) + '"');
    location.href = link.href; // navigate to the product page → SEARCH phase takes over
    return;
  }

  // ── PHASE: SEARCH ──────────────────────────────────────────────
  if (phase === 'SEARCH') {
    setStatus('running', 'Looking for item...');
    // Fractional seconds allowed (0.2 = 200ms, 0.07 = 70ms); floor at 0.05s so it can't hammer to 0ms.
    const interval = Math.max(0.05, parseFloat(botConfig.refreshInterval) || 2);

    if (isSams) {
      log('info', 'Checking shipping selection...');
      await selectShipping();
      await selectVariant(); // pick a Style if the item has variants and none is chosen
      // Sam's shows an "Add to list" / "Members also considered" carousel "Add" even when the MAIN
      // item is Not Available — so trusting a button alone makes the bot click a dead-end and loop on
      // the missing View Cart. Check the real stock (schema.org / availabilityStatus in the SSR'd
      // page) FIRST; if out of stock, WATCH for the restock instead of clicking a phantom Add.
      if (samsPageOutOfStock()) {
        log('warning', 'Out of stock (page: Not available) — watching for restock…');
        setStatus('running', 'Out of stock — watching…');
        await watchStockHtml(location.href.split('#')[0], interval, burst); return;
      }
    }

    log('info', burst ? '⚡ Burst: checking if live...' : 'Looking for Add to Cart button...');
    // In burst mode use a SHORT check so we can reload fast and catch the moment it goes
    // live. Otherwise be patient so a slow page has time to render before giving up.
    const addWait = burst ? 700 : (isSams ? patientTimeout(8000) : (interval * 1000));
    const addBtn = isSams
      ? await waitForSamsBtn('[data-automation-id="atc"], [data-dca-event="addToCart"]', addWait)
      : await findBtn(['addtocart', 'addtobag', 'addtobasket', 'atc', 'buynow', 'buyitnow', 'purchase'], addWait);

    if (!addBtn) {
      // SKU direct-URL fallback: if the item-number page has no real product (bad number),
      // search for the number instead. Only once, and only in Sam's SKU search mode.
      if (isSams && botConfig.samsSearch && botConfig.searchType === 'sku') {
        const hasProduct = document.querySelector('h1, [class*="product-title"], [data-automation-id="productName"], .price, [itemprop="price"]');
        const { samsFellBack } = await wget('samsFellBack');
        if (!hasProduct && !samsFellBack) {
          log('warning', 'Item number page not found — falling back to search...');
          await wset({ samsFellBack: true });
          location.href = 'https://www.samsclub.com/s/' + encodeURIComponent(botConfig.itemSku);
          return;
        }
      }
      // Sam's: WATCH the page HTML (schema.org availability) instead of reloading every cycle — poll
      // until it flips to InStock, then reload ONCE to get the live Add to Cart button. (The localhost
      // demo has no such markup, so it just reloads.)
      if (isSams) { await watchStockHtml(location.href.split('#')[0], interval, burst); return; }
      // Burst: reload almost immediately to catch the live moment. Normal: wait the interval.
      const reloadDelay = burst ? 150 : (interval * 1000);
      if (burst) {
        log('warning', '⚡ Not live yet — burst reloading...');
        setStatus('running', '⚡ Burst polling for drop...');
      } else {
        log('warning', 'Add to Cart not found — refreshing in ' + interval + 's...');
        setStatus('running', 'Not available – refreshing in ' + interval + 's');
      }
      await sleep(reloadDelay);
      location.reload();
      return;
    }

    log('info', 'Found Add to Cart: "' + addBtn.textContent.trim().substring(0, 40) + '"');

    const priceEl = document.querySelector('.price,[class*="price"],[data-price],[itemprop="price"]');
    const price   = parseFloat(priceEl?.textContent?.replace(/[^0-9.]/g, '') || '0');

    if (price > 0 && price > parseFloat(botConfig.maxPrice || '999')) {
      log('warning', 'Price $' + price + ' exceeds max $' + botConfig.maxPrice + ' — stopping');
      setStatus('error', 'Price too high – bot stopped');
      await wset({ botRunning: false });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
      return;
    }

    log('success', (price > 0 ? 'In stock at $' + price : 'Item available') + ' — clicking Add to Cart...');
    setStatus('running', 'Adding to cart...');
    addBtn.click();
    log('info', 'Add to Cart clicked — waiting for confirmation...');

    if (isSams) {
      // VERIFY it actually added. During a drop the first click is often dropped, so if the "View
      // Cart" confirmation doesn't show, re-click Add to Cart — but ONLY while it's confirmed NOT
      // added (View Cart absent AND the Add button still present), so we can never double-add.
      for (let t = 1; t <= 3; t++) {
        const added = await findBtn(['viewcart', 'viewbag', 'gotocart', 'viewmycart'], 1800);
        if (added) break;                        // confirmation shown → it added ✓
        const again = await waitForSamsBtn('[data-automation-id="atc"], [data-dca-event="addToCart"]', 400);
        if (!again) break;                        // Add button gone (added, or now OOS) → let the flow handle it
        log('warning', 'Add to Cart didn’t confirm — clicking it again (try ' + (t + 1) + ')…');
        again.click();
      }
      await wset({ botPhase: 'ADDED' });
      await waitForViewCart(botConfig, isSams);
    } else {
      await wset({ botPhase: 'CART' });
    }
  }

  // ── PHASE: ADDED (Sam's only) ──────────────────────────────────
  else if (phase === 'ADDED' && isSams) {
    // The /pac interstitial has the quantity stepper — bump it here before viewing cart
    await maybeSetQuantity(botConfig);
    log('info', 'Item added — waiting for View Cart button...');
    await waitForViewCart(botConfig, isSams);
  }

  // ── PHASE: CART ────────────────────────────────────────────────
  else if (phase === 'CART') {
    setStatus('running', 'On cart page...');

    // Bump quantity if it wasn't already done on /pac (the guard prevents double-counting)
    await maybeSetQuantity(botConfig);

    log('info', 'Looking for checkout button...');
    const btn = isSams
      ? await waitForSamsBtn('[data-automation-id="checkout"]', patientTimeout(12000))
      : await findBtn(['checkout', 'checkoutbtn', 'proceedtocheckout', 'gotocheckout', 'paynow']);
    if (!btn) {
      // Keep pushing — reload the cart and retry until checkout appears
      log('warning', 'Checkout button not ready — reloading cart and retrying...');
      setStatus('running', 'Waiting for checkout...');
      await sleep(1500);
      location.reload();
      return;
    }
    log('success', 'Found checkout button: "' + btn.textContent.trim().substring(0, 40) + '"');
    log('info', 'Clicking checkout...');
    await wset({ botPhase: 'CHECKOUT' });
    const cartUrl = location.href;
    btn.click();
    if (isSams) {
      // VERIFY we left the cart. If the click was dropped (still on /cart with the button present),
      // re-click — bounded, and only while confirmed NOT advanced, so it can't misfire.
      for (let t = 1; t <= 3; t++) {
        let advanced = false;
        for (let j = 0; j < 8; j++) { await sleep(250); if (location.href !== cartUrl || !/\/cart\b/.test(location.pathname)) { advanced = true; break; } }
        if (advanced) break;
        const again = await waitForSamsBtn('[data-automation-id="checkout"]', 400);
        if (!again) break;
        log('warning', 'Checkout didn’t advance — clicking it again (try ' + (t + 1) + ')…');
        again.click();
      }
    }
  }

  // ── PHASE: CHECKOUT ────────────────────────────────────────────
  else if (phase === 'CHECKOUT') {
    setStatus('running', 'Filling checkout form...');
    const cfg = botConfig;

    // Sam's: saved card — skip the generic address/payment form entirely (it has none,
    // so that wait was pure dead time) and go straight to CVV + Place Order via CDP.
    if (isSams) {
      const done = await fillSamsPayment(cfg);
      if (!done) return; // background handles CVV (if needed) + Place Order
      return;
    }

    // Non-Sam's (mock store / generic): wait for the form, fill it, then place the order.
    log('info', 'On checkout page — waiting for form fields...');
    await new Promise(resolve => {
      const check = () => document.querySelector('#email, input[type="email"], input[name*="email"], input[type="text"]');
      if (check()) return resolve();
      const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); resolve(); } });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
    });
    log('info', 'Form ready — filling fields...');

    function fill(id, val) {
      const el = document.getElementById(id);
      if (!el || !val) return false;
      el.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
      return true;
    }
    function sel(id, val) {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const filled = [];
    if (fill('email',     cfg.email))     filled.push('email');
    if (fill('firstName', cfg.firstName)) filled.push('firstName');
    if (fill('lastName',  cfg.lastName))  filled.push('lastName');
    if (fill('address',   cfg.address))   filled.push('address');
    if (fill('city',      cfg.city))      filled.push('city');
    if (sel('state',      (cfg.state || '').toUpperCase())) filled.push('state');
    if (fill('zip',       cfg.zip))       filled.push('zip');

    const cardFmt = (cfg.cardNumber || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
    if (fill('cardNumber', cardFmt))                                        filled.push('cardNumber');
    if (fill('cardName', cfg.cardName || (cfg.firstName + ' ' + cfg.lastName))) filled.push('cardName');
    if (fill('expiry',   cfg.expiry))  filled.push('expiry');
    if (fill('cvv',      cfg.cvv))     filled.push('cvv');

    log('info', 'Fields filled: ' + (filled.length ? filled.join(', ') : 'none found'));

    log('info', 'Looking for Place Order button...');
    setStatus('running', 'Submitting order...');
    const submitBtn = await findBtn(['place', 'order', 'pay', 'confirm', 'submit', 'buy']);
    if (!submitBtn) { log('error', 'Place Order button not found!'); return; }
    log('success', 'Found Place Order: "' + submitBtn.textContent.trim().substring(0, 40) + '"');
    log('info', 'Clicking Place Order...');
    await wset({ botPhase: 'CONFIRM' });
    submitBtn.click();
  }

  // ── PHASE: CONFIRM ─────────────────────────────────────────────
  else if (phase === 'CONFIRM') {
    log('info', 'On confirmation page — reading order ID...');
    if (isSams) {
      // Distinguish a REAL order confirmation from a failed submit (error banner still on
      // the review-order page). Success = navigated to a confirmation page OR a genuine
      // "thank you / order number" appears. Failure = the validation error banner is shown.
      const outcome = await new Promise(resolve => {
        const check = () => {
          // Failure: still on review-order with the error banner
          const errEl = [...document.querySelectorAll('[role="alert"], h1, h2, p, span, div')]
            .find(el => /please correct the errors|enter the 3 digit/i.test(el.textContent || ''));
          if (errEl) return { ok: false, text: errEl.textContent.trim() };
          // Success: confirmation page URL, or a real thank-you / order-number element
          const url = location.pathname.toLowerCase();
          if (/confirmation|thank|order-confirm|order-placed|order-details|\/orders\//.test(url)) {
            return { ok: true, text: 'confirmation page' };
          }
          const okEl = [...document.querySelectorAll('h1, h2, h3, p, span')]
            .find(el => /thank you for your order|your order is confirmed|order\s*(number|#)\s*[:#]?\s*[A-Z0-9]{5,}/i.test(el.textContent || ''));
          if (okEl) return { ok: true, text: okEl.textContent.trim().substring(0, 80) };
          return null; // not determined yet
        };
        const found = check(); if (found) return resolve(found);
        const obs = new MutationObserver(() => { const r = check(); if (r) { obs.disconnect(); resolve(r); } });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(null); }, 8000);
      });

      if (outcome && outcome.ok) {
        log('success', '🎉 Order placed! ' + outcome.text);
        setStatus('done', 'Order complete!');
        chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'success', text: 'Sam\'s order placed! ' + outcome.text.substring(0, 50) }).catch(() => {});
        // (falls through to stop-on-success below)
      } else if (outcome && !outcome.ok) {
        // Error banner = order was NOT placed (no charge happened) → safe to retry checkout.
        log('warning', '❌ Order not placed (' + outcome.text.substring(0, 40) + ') — retrying checkout...');
        setStatus('running', 'Retrying checkout...');
        await wset({ botPhase: 'CHECKOUT' });
        await sleep(1500);
        location.reload();
        return;
      } else {
        // Couldn't confirm yet — keep pushing: reload and re-check (don't give up)
        log('warning', '⚠️ No confirmation yet — reloading to re-check...');
        setStatus('running', 'Confirming order...');
        await sleep(2000);
        location.reload();
        return;
      }
    } else {
      const orderEl = await waitFor('orderId');
      const orderId = orderEl.textContent;
      log('success', '🎉 Order placed! ID: ' + orderId);
      setStatus('done', 'Order complete! ID: ' + orderId);
    }
    if (botConfig.stopOnSuccess) {
      await wset({ botRunning: false, botPhase: 'IDLE' });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
      log('info', 'Bot stopped (stop-on-success)');
    }
  }

  } catch (err) {
    log('error', 'Bot error: ' + err.message + ' (phase: ' + (await wget('botPhase')).botPhase + ')');
  }
})();

// NOTE: Sam's Club specific functions (selectShipping, waitForSamsBtn,
// fillSamsPayment, waitForViewCart) live in sams.js, which is injected before
// this file. They share this isolated-world scope, so they're callable here.

// Dispatches a realistic press on an element (React Aria steppers/buttons respond to
// the pointer sequence, not a bare click)
function pressEl(el) {
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown',     { ...o, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup',   { ...o, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup',       { ...o, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click',         { ...o, buttons: 0 }));
  el.click();
}

// Bumps the quantity ONCE per order. A storage flag (qtyDone) guarantees it runs on
// whichever page has the stepper first (/pac or /cart) and never a second time.
async function maybeSetQuantity(botConfig) {
  const qty = parseInt(botConfig.quantity || '1');
  if (qty <= 1) return;
  const { qtyDone } = await wget('qtyDone');
  if (qtyDone) return; // already set this order

  // Wait briefly for the stepper to render
  await new Promise(resolve => {
    const sel = '[data-testid="quantity-stepper-inc-icon"], [data-testid*="stepper-inc"], [class*="ld-Plus"]';
    if (document.querySelector(sel)) return resolve();
    const obs = new MutationObserver(() => { if (document.querySelector(sel)) { obs.disconnect(); resolve(); } });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(); }, 4000);
  });

  if (!document.querySelector('[data-testid="quantity-stepper-inc-icon"], [data-testid*="stepper-inc"], [class*="ld-Plus"]')) {
    log('warning', 'Quantity stepper not found on this page — will try the next page');
    return; // don't mark done; let the next page (/cart) try
  }

  await setQuantity(qty);
  await wset({ qtyDone: true }); // lock it so it can't run again
  log('success', 'Quantity set to ' + qty);
  await sleep(400);
}

// Reads the current quantity shown by the stepper (input value or number display)
function readQty() {
  const inp = document.querySelector(
    '[data-testid*="stepper"] input, input[data-testid*="quantity"], input[name*="quant"], input[aria-label*="uantity"]'
  );
  if (inp && inp.value !== '') { const n = parseInt(inp.value); if (!isNaN(n)) return n; }
  const val = document.querySelector(
    '[data-testid*="stepper-input"], [data-testid*="stepper-value"], [data-testid*="quantity-stepper"] [aria-live]'
  );
  if (val) { const n = parseInt((val.textContent || '').replace(/\D/g, '')); if (!isNaN(n)) return n; }
  return null;
}

// Sets the item quantity to `qty` by clicking the + stepper until it reaches the target.
// Idempotent: if the quantity is already `qty`, it does nothing — safe to call on /pac AND /cart.
async function setQuantity(qty) {
  // 1) Sam's (and similar) quantity stepper — increment control by its test id / + icon
  const incIcon = document.querySelector(
    '[data-testid="quantity-stepper-inc-icon"], [data-testid*="stepper-inc"], [data-testid*="quantity-inc"], [class*="ld-Plus"]'
  );
  if (incIcon) {
    const incBtn = incIcon.closest('button, [role="button"]') || incIcon.parentElement;
    // Read the starting quantity ONCE (default 1), then click exactly (target - start)
    // times. Re-reading after each click is unreliable — the display lags and caused
    // an extra click (3 → 4). Deterministic counting avoids that.
    let start = readQty();
    if (start === null) start = 1;
    const clicks = Math.max(0, qty - start);
    log('info', 'Quantity: at ' + start + ', clicking + ' + clicks + ' time(s) to reach ' + qty);
    for (let i = 0; i < clicks; i++) { pressEl(incBtn); await sleep(220); }
    return true;
  }

  // 2) Dropdown <select> (e.g. "Qty: 1 ▼")
  const sel = document.querySelector('select[id*="qty"], select[id*="quantity"], select[name*="quant"], select[aria-label*="uantity"]');
  if (sel) {
    sel.value = String(qty);
    sel.dispatchEvent(new Event('input',  { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    if (parseInt(sel.value) === qty) return true;
  }

  // 3) Generic +/- stepper button (by text/label)
  const plus = [...document.querySelectorAll('button, [role="button"]')].find(b => {
    const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
    return t.includes('increase') || t.includes('increment') || /(^|\s)\+(\s|$)/.test(b.textContent || '') ||
           t.includes('add one') || t.includes('plus');
  });
  if (plus) {
    for (let i = 1; i < qty; i++) { pressEl(plus); await sleep(180); }
    return true;
  }

  // 4) Number input (last resort — may not stick on React-controlled inputs)
  const input = document.querySelector('#qty, input[type="number"][id*="qty"], input[id*="quantity"], input[name*="quant"], input[aria-label*="uantity"]');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(qty));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

// Detects a CAPTCHA / "verify you are human" / bot-challenge page (cross-store)
function detectCaptcha() {
  // Known anti-bot / human-verification widgets by their iframe/element fingerprints:
  //  reCAPTCHA, hCaptcha, PerimeterX press-and-hold (#px-captcha), DataDome (geo.captcha-delivery),
  //  Cloudflare Turnstile (challenges.cloudflare.com), Arkose/FunCaptcha, Akamai bot-manager.
  if (document.querySelector([
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[title*="captcha" i]',
    'iframe[src*="geo.captcha-delivery.com"]', 'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]', 'iframe[src*="/fc/"]',
    '#px-captcha', '[id*="px-captcha"]', '[class*="datadome" i]', '[id*="datadome" i]',
    '.cf-turnstile', '[class*="captcha" i]', '[id*="captcha" i]',
    '[data-testid*="captcha" i]', '[aria-label*="captcha" i]', '[aria-label*="press & hold" i]'
  ].join(', '))) return true;
  const t = (document.body && document.body.innerText || '').toLowerCase();
  return /are you a human|verify (?:you(?:'| a)?re|that you are) (?:a )?human|i'?m not a robot|complete the (?:captcha|security check)|press (?:and|&) hold|(?:slide|drag) (?:to |the )|unusual traffic|confirm you(?:'| a)?re human|enter the characters|verify your identity|security check to access|checking your browser|activity from your (?:computer|device|network)/.test(t);
}

// Pause the bot on a CAPTCHA / bot challenge and WAIT for the human to clear it — the bot can't (and
// shouldn't) solve these. Alerts REPEATEDLY (sound + panel) every cycle so it can't be missed, does
// NOT reload (reloading a challenge can make it worse / reset it), and resumes the instant it's gone.
// `tag` marks where it triggered (e.g. 'checkout'). Returns true when clear to continue, false if the
// bot was stopped while waiting. Safe to call anywhere in the flow — it's a no-op when no challenge.
async function awaitCaptchaClear(tag) {
  if (!detectCaptcha()) return true;
  const where = tag ? ' (' + tag + ')' : '';
  log('error', '🛑 CAPTCHA / verification detected' + where + ' — SOLVE IT in the page! (alerting you)');
  setStatus('error', '🛑 CAPTCHA — solve it!');
  let cycles = 0;
  while (detectCaptcha()) {
    // Re-alert EVERY cycle so it keeps buzzing until you clear it (multi-time alert).
    chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'captcha',
      text: cycles === 0 ? 'A CAPTCHA/verification is blocking the bot — solve it in the page.'
                         : 'Still waiting on the CAPTCHA — solve it! (' + (cycles * 2) + 's)' }).catch(() => {});
    cycles++;
    await sleep(2000);
    const st = await wget('botRunning');
    if (!st.botRunning) return false; // user stopped while waiting
  }
  log('success', 'CAPTCHA cleared — continuing');
  chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'success', text: 'CAPTCHA cleared — resuming checkout.' }).catch(() => {});
  return true;
}

// Walmart's drop queue shows a "Hold my spot and Keep shopping" button that SECURES your place in
// line (then returns you to browsing). Unlike a passive queue, you must CLICK it. Matched by TEXT —
// the data-dca-aid on it is per-session, not stable. Clicks once; returns true if it clicked.
async function clickQueueHoldSpot(store) {
  const cands = Array.from(document.querySelectorAll('button, [role="button"], a'));
  const btn = cands.find(function (b) {
    const t = (b.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return /hold my (spot|place)|hold your (spot|place)/.test(t) && !b.disabled && b.offsetParent !== null;
  });
  if (!btn) return false;
  log('success', '🎟️ Queue: clicking "' + (btn.textContent || '').trim().slice(0, 45) + '" to hold your spot...');
  // Prefer a TRUSTED (CDP) click when the store needs one; the per-session data-dca-aid gives a
  // stable enough selector for THIS click. Fall back to a normal DOM click.
  const aid = btn.getAttribute && btn.getAttribute('data-dca-aid');
  if (store && store.trustedClick && aid) {
    const ok = await trustedClickSel('button[data-dca-aid="' + aid + '"]');
    if (ok) return true;
  }
  try { btn.click(); } catch (_) {}
  return true;
}

// Detects a page-level ERROR that warrants a REFRESH (vs. a clickable button we should push
// through): site overloaded / "something went wrong" / item-not-found pages that show up when a
// drop site is hammered. Out-of-stock is handled separately via the DISABLED action button, so it
// is intentionally NOT matched here. Returns a short reason string, or null if the page looks fine.
function detectStoreError() {
  const t = (document.body && document.body.innerText || '').toLowerCase();
  if (!t) return null;
  // Overload / server error pages — STRONG signals only (generic phrases like "try again" appear on
  // normal/checkout pages and caused false refreshes away from a working checkout).
  if (/something went wrong|we'?re having (?:some )?(?:trouble|technical) (?:issue|problem|difficult)|high (?:traffic|demand)|too many requests|temporarily unavailable|service (?:is )?unavailable|site is (?:busy|down)|server error|http 5\d\d|error 5\d\d/.test(t)) return 'site overloaded/error';
  // Item / page not found
  if (/this (?:item|product) is (?:no longer|not|currently un)available|sorry, this item|page (?:you'?re looking for )?(?:not found|isn'?t available)/.test(t)) return 'item not available';
  return null;
}

// Spam-click a selector (TRUSTED click for stores that need it, else DOM) until the step ADVANCES
// (URL changes, or the button is consumed/disabled) or a page error appears. Returns
// 'advanced' | 'error' | 'timeout'. The DOM fallback only fires on an ENABLED button and we stop the
// moment the button is gone/disabled — so spamming even a final "Place order" can't place a 2nd order.
async function spamClickSel(sel, store, opts) {
  const tries = (opts && opts.tries) || 10, gap = (opts && opts.gap) || 300;
  const gone = (el) => !el || el.disabled || el.getAttribute('aria-disabled') === 'true';
  const startUrl = location.href;
  for (let i = 0; i < tries; i++) {
    if (store.trustedClick) {
      const ok = await trustedClickSel(sel);
      if (!ok) { const b = document.querySelector(sel); if (b && !gone(b)) b.click(); }
    } else {
      const b = document.querySelector(sel); if (b && !gone(b)) b.click();
    }
    await sleep(gap);
    if (location.href !== startUrl) return 'advanced';            // navigated to the next step
    if (gone(document.querySelector(sel))) return 'advanced';     // button consumed → moved on
    if (detectStoreError()) return 'error';                       // overload/error → caller refreshes
  }
  return 'timeout';
}

// Spam-click a KNOWN element until the step advances (URL changes or the element leaves the DOM /
// disables) or a page error appears. For the Sam's / localhost phase machine, which already holds
// the resolved button element. Stops on advance so it can't over-submit.
async function spamClickEl(el, opts) {
  const tries = (opts && opts.tries) || 10, gap = (opts && opts.gap) || 250;
  const gone = (e) => !e || e.disabled || e.getAttribute('aria-disabled') === 'true' || !document.contains(e);
  const startUrl = location.href;
  for (let i = 0; i < tries; i++) {
    if (gone(el)) return 'advanced';
    el.click();
    await sleep(gap);
    if (location.href !== startUrl) return 'advanced';
    if (gone(el)) return 'advanced';
    if (detectStoreError()) return 'error';
  }
  return 'timeout';
}

// Target restock watcher — polls the stock API instead of reloading the page each cycle. Stays put
// and only reloads ONCE when the item flips to IN_STOCK (so the live Buy now / Add to cart button
// appears and the spam-click grabs it). This turns ~2s-per-reload detection into ~sub-second. Polls
// are throttled (min 500ms) so we don't trip Target's rate limiting. Falls back to a page reload if
// the API errors or gets throttled.
async function watchTargetStock(tcin, interval, burst) {
  const pollMs = Math.max(500, (burst ? 0.5 : (parseFloat(interval) || 2)) * 1000);
  log('info', '⚡ Watching stock via API (' + tcin + ', every ' + Math.round(pollMs) + 'ms) — no reloads until it drops.');
  for (let i = 0; ; i++) {
    const st = await wget('botRunning');
    if (!st.botRunning) return; // stopped by the user
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'STOCK_POLL', tcin }, resp => res(resp || {})));
    const inStock = r.ok && (r.avail === 'IN_STOCK' || r.avail === 'LIMITED_STOCK' || (typeof r.qty === 'number' && r.qty > 0));
    if (inStock) {
      log('success', '⚡ IN STOCK (' + r.avail + (r.qty != null ? ', qty ' + r.qty : '') + ') — reloading to grab it!');
      location.reload(); return;
    }
    if (!r.ok || r.status === 'ERR' || (r.status && r.status !== 200)) {
      log('warning', '⚡ stock API ' + (r.status || 'unavailable') + ' — falling back to a page reload.');
      await sleep(pollMs); location.reload(); return;
    }
    if (i % 15 === 0) log('info', '⚡ ' + tcin + ' still ' + (r.avail || 'OOS') + ' — watching…');
    await sleep(pollMs);
  }
}

// Reads the CURRENT Sam's page's SSR'd availability (no fetch) to decide if the MAIN product is
// out of stock — used to avoid clicking a phantom "Add to list"/carousel Add on a Not Available item.
// schema.org markup is for the main product only, so it's the cleanest signal.
function samsPageOutOfStock() {
  const html = (document.documentElement && document.documentElement.outerHTML) || '';
  if (/schema\.org\/InStock/i.test(html)) return false;    // explicitly in stock
  if (/schema\.org\/OutOfStock/i.test(html)) return true;   // explicitly out of stock
  const m = html.match(/"availabilityStatus"\s*:\s*"([^"]+)"/);
  if (m && /OUT_OF_STOCK|NOT_AVAILABLE|UNAVAILABLE/i.test(m[1])) return true;
  return false; // unknown → let the button logic proceed (don't get stuck watching a stockable item)
}

// Stock watcher for stores that SSR availability into the page HTML (Sam's/Walmart GLASS). Instead
// of reloading the whole page each cycle, it fetches the product URL's HTML (via background, in the
// page context) and checks the schema.org / availabilityStatus signal, reloading ONCE only when the
// item flips to InStock. Falls back to a normal reload on any error/throttle.
async function watchStockHtml(url, interval, burst) {
  const pollMs = Math.max(700, (burst ? 0.6 : (parseFloat(interval) || 2)) * 1000);
  log('info', '⚡ Watching stock via page HTML (every ' + Math.round(pollMs) + 'ms) — no reloads until it drops.');
  for (let i = 0; ; i++) {
    const st = await wget('botRunning');
    if (!st.botRunning) return; // stopped by the user
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'HTML_STOCK_POLL', url }, resp => res(resp || {})));
    if (r.ok && r.inStock) {
      log('success', '⚡ IN STOCK (' + r.status + ') — reloading to grab it!');
      location.reload(); return;
    }
    if (!r.ok || r.status === 'ERR' || (typeof r.status === 'number' && r.status !== 200)) {
      log('warning', '⚡ stock check ' + (r.status || 'failed') + ' — falling back to a page reload.');
      await sleep(pollMs); location.reload(); return;
    }
    if (i % 12 === 0) log('info', '⚡ still ' + (r.status || 'OOS') + ' — watching…');
    await sleep(pollMs);
  }
}

// WALMART watchlist watcher — polls EVERY drop item's availability via a same-origin HTML fetch
// (background, in the page's context — DataDome tolerates that like a normal page request) WITHOUT
// navigating. The tab stays on the current item; we navigate ONLY when a DIFFERENT item flips to a
// live RETAIL offer. Falls back to page rotation if the fetch is blocked/errors across a full pass.
async function watchWalmartList(list, interval, burst, store, cfg) {
  const pollMs = Math.max(700, (burst ? 0.6 : (parseFloat(interval) || 2)) * 1000);
  log('info', '⚡ Watchlist: monitoring ' + list.length + ' items via background stock checks (no page reloads).');
  // The item this tab is CURRENTLY on — never "navigate" to it (that just reloads the same page in a
  // loop). Its own retail-guard already ran and sent us here to watch.
  const hereId = (location.pathname.match(/\/ip\/(?:.*\/)?(\d{6,})/) || [])[1] || null;
  let errStreak = 0;
  for (let cycle = 0; ; cycle++) {
    for (let j = 0; j < list.length; j++) {
      const st = await wget('botRunning');
      if (!st.botRunning) return; // stopped by the user
      const id = list[j];
      const url = store.itemUrl(id);
      const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'HTML_STOCK_POLL', url, mode: 'walmart' }, resp => res(resp || {})));
      if (r.ok && r.inStock && String(id) !== String(hereId)) {
        // A DIFFERENT item went live (retail) — go to it (routes into /qp / buy flow).
        log('success', '⚡ #' + id + ' is LIVE (' + r.status + ') — navigating to grab it!');
        await wset({ watchIndex: j });
        location.href = url; return;
      }
      if (!r.ok || r.status === 'ERR') {
        if (++errStreak >= list.length) {
          log('warning', '⚡ Stock fetch blocked — falling back to page rotation.');
          let idx = (await wget('watchIndex')).watchIndex; if (typeof idx !== 'number') idx = 0;
          const next = (idx + 1) % list.length;
          await wset({ watchIndex: next });
          await sleep(Math.max(1500, interval * 1000));
          location.href = store.itemUrl(list[next]); return;
        }
      } else errStreak = 0;
      setStep('👁 Watching', list.length + ' items — #' + id + ' ' + (r.status || 'OOS') + ' (no reloads)');
      await sleep(pollMs);
    }
    if (cycle % 5 === 0) log('info', '👁 Watchlist: all ' + list.length + ' still OOS — watching…');
  }
}

// WALMART single-item watcher — same idea as the watchlist one but for ONE item (use-current-tab
// or a 1-item watchlist). Polls THIS item's availability via a same-origin HTML fetch WITHOUT
// reloading the page ("item not available — refreshing…" is what we're replacing), and reloads
// ONCE only when a genuine RETAIL offer is live (not the permanent 3rd-party $200 listing).
async function watchWalmartItem(url, interval, burst, store, cfg) {
  const pollMs = Math.max(700, (burst ? 0.6 : (parseFloat(interval) || 2)) * 1000);
  log('info', '⚡ Watching this item in the background — no page reloads until the retail drop is live.');
  let errStreak = 0;
  for (let i = 0; ; i++) {
    const st = await wget('botRunning');
    if (!st.botRunning) return; // stopped by the user
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'HTML_STOCK_POLL', url, mode: 'walmart' }, resp => res(resp || {})));
    if (r.ok && r.inStock) { // inStock here already REQUIRES the retail-seller signal (background.js)
      log('success', '⚡ Retail offer is LIVE — reloading to grab it!');
      location.reload(); return;
    }
    if (!r.ok || r.status === 'ERR') {
      if (++errStreak >= 4) { log('warning', '⚡ Stock fetch blocked — falling back to a page reload.'); await sleep(pollMs); location.reload(); return; }
    } else errStreak = 0;
    const state = r.busy ? 'page busy — retrying' : (!r.avail ? 'not available' : (r.retail ? 'in stock (retail!)' : 'in stock — 3rd-party only'));
    setStep('👁 Watching', 'in background — ' + state + ' (no reloads)');
    if (i % 12 === 0) log('info', '👁 still watching — ' + state + '…');
    await sleep(pollMs);
  }
}

// ── Generic store flow (scaffold) ──────────────────────────────────────────────
// Drives Target/Walmart/Best Buy/Pokémon Center from their adapter config. This is a
// best-effort starting point — each store's selectors/CVV handling need real-HTML tuning.
function waitForAny(selectorList, timeout = 5000) {
  return new Promise(resolve => {
    const find = () => (window.__storeFirstMatch ? window.__storeFirstMatch(selectorList) : document.querySelector(selectorList));
    const el = find(); if (el) return resolve(el);
    const obs = new MutationObserver(() => { const el = find(); if (el) { obs.disconnect(); resolve(el); } });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}
// Like waitForAny, but resolves as soon as the element EXISTS in ANY state (enabled OR disabled).
// __storeFirstMatch deliberately skips disabled buttons, so waiting for the action button with
// waitForAny on an OUT-OF-STOCK page never matches and burns the whole timeout. Here we want to
// detect the button the moment it renders — disabled or not — so the caller can decide (click vs
// refresh) immediately instead of waiting 8s every cycle.
function waitForAnyState(selectorList, timeout = 5000) {
  return new Promise(resolve => {
    const find = () => document.querySelector(selectorList);
    const el = find(); if (el) return resolve(el);
    const obs = new MutationObserver(() => { const el = find(); if (el) { obs.disconnect(); resolve(el); } });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}
// Real browser-level click via CDP (background). For buttons gated on trusted events
// (Target's Buy now / Place your order ignore a scripted .click()). Returns true on success.
// TIMEOUT-guarded: the background reply can be lost if the service worker cycles or chrome.debugger
// hangs — without a timeout the await here freezes the WHOLE buy flow right at "Buy now" (exactly
// the "item live but bot froze, never clicked Buy now" symptom). On no-reply we retry once, then
// give up so the caller can fall back instead of hanging forever.
async function trustedClickSel(selector) {
  const attempt = () => new Promise(res => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; res(v); } };
    try { chrome.runtime.sendMessage({ type: 'CDP_CLICK', selector }, r => fin(!!r)); } catch (_) { fin(false); }
    setTimeout(() => fin(null), 7000); // null = no reply (worker/CDP hung)
  });
  let r = await attempt();
  if (r === null) { log('warning', 'Trusted click got no reply — retrying once…'); r = await attempt(); }
  return r === true;
}
// sendMessage to background with a hard timeout, so a cycled/hung service worker (which never calls
// sendResponse) can NEVER freeze the buy flow. Returns `fallback` if no reply arrives in `ms`.
function bgSend(msg, ms, fallback) {
  return new Promise(res => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; res(v); } };
    try { chrome.runtime.sendMessage(msg, r => fin(r === undefined ? fallback : r)); } catch (_) { fin(fallback); }
    setTimeout(() => fin(fallback), ms || 8000);
  });
}
function fillGeneric(el, val) {
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(val));
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
// Sets a <select> quantity dropdown (Target) to qty. Native selects commit on a bubbling
// 'change' event, which React's onChange picks up.
async function storeSetQtySelect(S, qty) {
  // Short wait: the dropdown (if this item has one) is in the DOM almost immediately. Items that use
  // a +/- stepper instead (e.g. some Target grocery items) don't have it, so don't burn 6s here.
  const sel = await waitForAny(S.qtySelect, 1500);
  if (!sel) {
    log('warning', 'Quantity dropdown not found');
    // Diagnostic: dump the quantity-ish controls on the page so we can pin the right selector.
    try {
      const els = [...document.querySelectorAll('[data-test*="qty" i],[data-test*="quantity" i],[aria-label*="quantity" i],select,input[type="number"]')].slice(0, 8);
      log('info', els.length
        ? 'qty controls: ' + els.map(e => '<' + e.tagName.toLowerCase() + ' data-test="' + (e.getAttribute('data-test') || '') + '" aria="' + (e.getAttribute('aria-label') || '').slice(0, 24) + '">').join('  ')
        : 'no qty control on this page — quantity is likely set in the Buy-now checkout drawer, not the product page');
    } catch (_) {}
    return false;
  }
  if (parseInt(sel.value) === qty) { log('info', 'Quantity already ' + qty); return true; }
  // Only pick a value the dropdown actually offers (Target caps at 10)
  if (!Array.from(sel.options).some(o => o.value === String(qty))) {
    log('warning', 'Quantity ' + qty + ' not available (max ' + sel.options.length + ') — leaving as is');
    return false;
  }
  sel.value = String(qty);
  sel.dispatchEvent(new Event('input',  { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  log('success', 'Set quantity to ' + qty);
  return true;
}
async function storeSetQty(S, qty) {
  const inc = document.querySelector(S.qtyInc);
  if (!inc) return;
  const btn = inc.closest('button, [role="button"]') || inc;
  for (let i = 1; i < qty; i++) { pressEl(btn); await sleep(200); }
}
// Pokémon Center payment screen. Step 1 (this build): pick Credit/Debit Card and set the
// expiry selects. Card# and CVV (secure CyberSource iframes) + Place Order come next via CDP.
async function pokemonCheckout(store, cfg) {
  const S = store.sel;
  setStatus('running', 'Pokémon: payment...');

  // The /checkout/address step (shipping) comes BEFORE payment. If the address is already
  // saved on the account it just needs a Continue; otherwise send me this page's HTML to fill it.
  if (/\/address/.test(location.pathname)) {
    log('info', 'On address step — continuing to payment...');
    setStatus('running', 'Pokémon: address...');
    const cont = await waitForAny(S.continueBtn, 6000);
    if (cont) { log('success', 'Address — clicking Continue...'); cont.click(); }
    else { log('warning', 'Address Continue not found — may need the address form filled (send HTML).'); await sleep(1500); }
    return;
  }

  // The /checkout/summary (or /review) page is the FINAL review step — don't re-enter the
  // card there; find and click Place Order. Card entry only happens on /checkout/payment.
  if (/\/summary|\/review/.test(location.pathname)) {
    log('info', 'On review page — looking for Place Order...');

    // If the gateway already rejected a prior attempt ("Payment could not be processed,
    // please refresh and retry"), reload to retry — but cap it so we never loop or double-submit.
    const payErr = /payment could not be processed|please refresh and retry/i.test(document.body.innerText || '');
    if (payErr) {
      const r = (await wget('pokePlaceRetries')).pokePlaceRetries || 0;
      if (r >= 3) { log('error', '🛑 Gateway kept rejecting payment after ' + r + ' tries — stopping.'); setStatus('error', 'Payment rejected — check card'); return; }
      await wset({ pokePlaceRetries: r + 1 });
      log('warning', 'Gateway rejected the payment — refreshing to retry (' + (r + 1) + '/3)...');
      await sleep(1200); location.reload(); return;
    }

    // The order summary (totals) renders as grey skeletons for a moment. Clicking Place Order
    // before the Total has loaded makes the gateway reject it. Wait until a real Total ($amount)
    // is showing, then give it one more beat to settle, before clicking.
    log('info', 'Waiting for order total to load...');
    for (let i = 0; i < 30 && !/total[\s\S]{0,60}\$\s*\d/i.test(document.body.innerText || ''); i++) await sleep(200);
    await sleep(1000);

    // Try the known selector first, then fall back to finding the button by its text.
    let po = await waitForAny(S.placeOrder, 3000);
    if (!po) po = await findBtn(['place order', 'placeorder', 'submit order', 'pay now', 'complete order'], 6000);
    if (po) {
      // TEST MODE: everything ran for real up to here, but DON'T actually submit the order.
      // Show a big confirmation banner and stop, so you can verify the full flow safely.
      const botTestMode = (cfg && cfg.testMode) || (await wget('botTestMode')).botTestMode;
      if (botTestMode) {
        log('success', '🧪 TEST MODE — found Place Order, NOT submitting. Order would go through here.');
        showBigBanner('✓ ORDER CONFIRMED', 'TEST MODE — no real order was placed');
        setStatus('done', '🧪 Test passed — order NOT placed');
        await wset({ botRunning: false, botPhase: 'IDLE' });
        chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
        return;
      }
      // A bot challenge can gate the final submit — pause & alert you to clear it, then place it.
      if (!(await awaitCaptchaClear('pokemon checkout'))) return;
      log('success', 'Placing order: "' + (po.textContent || '').trim().substring(0, 40) + '"');
      await wset({ botPhase: 'CONFIRM' });
      po.click();
      // Watch for a gateway rejection right after clicking; if it appears, the next injection
      // (or the block above on reload) handles the retry.
      await sleep(2500);
      if (/payment could not be processed|please refresh and retry/i.test(document.body.innerText || '')) {
        log('warning', 'Gateway returned an error after Place Order — will refresh & retry.');
        await sleep(800); location.reload();
      }
    } else {
      log('warning', 'Place Order button not found — paste its HTML so I can pin the selector.');
    }
    return;
  }

  // Guard: card details must be saved in THIS profile's Payment tab
  if (!cfg.cardNumber || !cfg.cvv || !cfg.expiry) {
    log('error', '🛑 No card saved for Pokémon — fill the Payment tab (Card #, CVV, Expiry) on the ⚡ Pokémon profile and Save.');
    setStatus('error', 'No card saved — fill Payment tab');
    await wset({ botRunning: false, botPhase: 'IDLE' });
    chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
    return;
  }

  // 1) Select "Credit/Debit Card" in the payment dropdown (reveals the card fields)
  const sel = await waitForAny(S.paymentSelect, 8000);
  if (!sel) { log('warning', 'Payment dropdown not found — reloading...'); await sleep(1200); location.reload(); return; }
  if (sel.value !== 'credit-card') {
    sel.value = 'credit-card';
    sel.dispatchEvent(new Event('input',  { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    log('success', 'Selected Credit/Debit Card');
    // Wait for the card iframe to actually render (instead of a fixed pause)
    await waitForAny(S.cardIframe, 4000);
  } else {
    log('info', 'Credit/Debit Card already selected');
  }

  // 2) Set expiry month/year from "MM/YY"
  const exp = (cfg.expiry || '').replace(/[^0-9]/g, '');
  const mm = exp.slice(0, 2), yy = exp.slice(-2);
  const mSel = document.querySelector(S.expMonth);
  const ySel = document.querySelector(S.expYear);
  if (mSel && mm) { mSel.value = mm; mSel.dispatchEvent(new Event('change', { bubbles: true })); }
  if (ySel && yy) { ySel.value = '20' + yy; ySel.dispatchEvent(new Event('change', { bubbles: true })); }
  log('info', 'Set expiry ' + (mm || '??') + '/' + (yy || '??'));

  // 3+4) Fill card/CVV (CDP) then Continue. FIXED fast speed every run (no auto-tuning, so
  // it never creeps). If a run gets unlucky and is rejected, retry a bit slower for THAT
  // run only — the starting speed never changes.
  const START_SPEED = 48;  // proven reliable. Going lower risks dropped/scrambled digits that
                           // still pass the front-end check but get DECLINED by the gateway.
  let speed = START_SPEED;
  const MAX_SPEED = 90;
  let attempt = 0;
  // The iframe element appears instantly, but the CyberSource microform inside takes a couple
  // seconds to become interactive. Without this wait, try 1 always failed (typing into a
  // not-yet-ready field) and only try 2 — ~3s later — succeeded. Give it that head start once.
  log('info', 'Letting card field initialize...');
  await sleep(1000);
  while (speed <= MAX_SPEED) {
    attempt++;
    log('info', 'Filling card # and CVV @ ' + speed + 'ms (try ' + attempt + ')...');
    await new Promise(res => chrome.runtime.sendMessage({
      type: 'POKE_PAY', card: cfg.cardNumber, cvv: cfg.cvv,
      cardSel: S.cardIframe, cvvSel: S.cvvIframe, speed: speed, clear: true // focus+clear every attempt
    }, () => res()));

    const cont = await waitForAny(S.continueBtn, 6000);
    if (cont) { log('info', 'Clicking Continue...'); cont.click(); }
    else { log('warning', 'Continue button not found'); }

    await sleep(1400); // wait for validation / page to advance
    const bad = /please enter a valid|enter a valid (?:credit )?card|invalid card/i.test(document.body.innerText || '');
    if (!bad) { log('success', '✓ Payment accepted @ ' + speed + 'ms/digit'); return; }
    log('warning', 'Rejected @ ' + speed + 'ms — retrying this run @ ' + (speed + 4) + 'ms...');
    speed += 4;
  }
  log('error', 'Card rejected even at ' + MAX_SPEED + 'ms — check the number.');
}

// Target drop failure popups (confirmed by the click tracker during a real drop): a modal with only
// "Close" (on the product page, after a Buy-now click fails) or "Ok" (on /checkout/buy-now/checkout
// when the order can't proceed). A human dismisses them and retries — this clicks the first visible
// one and returns its label (null if none).
function dismissTargetModal() {
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent || '').trim().toLowerCase();
    if ((t === 'close' || t === 'ok') && b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
      b.click();
      return t;
    }
  }
  return null;
}

// Target's "Buy now" opens the checkout as a DRAWER on the same product URL (no navigation),
// so we finish the order right here instead of waiting for a CHECKOUT page that never loads.
// Waits for the Total to populate, fills CVV if asked, then submits (or, in Test mode, shows
// the confirmation banner without submitting).
async function buyNowDrawerCheckout(store, cfg) {
  const S = store.sel;
  // The checkout (Buy now drawer OR cart-route page) loads its contents asynchronously — give
  // it a beat, then search all frames for "Place your order".
  log('info', 'Checkout — looking for "Place your order"...');
  await sleep(400);

  // The drawer is rendered in an IFRAME, so search ALL frames (via background) — the top-frame
  // content script can't see inside it. Poll tightly so we act the instant it loads.
  const kw = ['place your order', 'place order', 'placeorder', 'submit order'];
  let res = { found: false };
  for (let i = 0; i < 20; i++) {
    res = await bgSend({ type: 'PLACE_ORDER_FRAMES', selectors: [S.placeOrder], keywords: kw, click: false }, 6000, { found: false });
    if (res.found) break;
    await sleep(300);
  }
  if (!res.found) {
    log('warning', 'Target: "Place your order" not found in any frame.');
    return;
  }
  log('success', 'Found "Place your order"' + (res.url ? ' in ' + res.url.replace(/^https?:\/\//, '').slice(0, 40) : ''));

  // TEST MODE: stop HERE. Do NOT click Place your order — clicking it can complete the purchase.
  // Show the banner and end; nothing that submits an order ever runs in Test mode.
  const { botTestMode } = await wget('botTestMode');
  if (botTestMode) {
    log('success', '🧪 TEST MODE — found "Place your order", NOT clicking it. No order placed.');
    showBigBanner('✓ ORDER CONFIRMED', 'TEST MODE — no real order was placed');
    setStatus('done', '🧪 Test passed — order NOT placed');
    await wset({ botRunning: false, botPhase: 'IDLE' });
    chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
    return;
  }

  // ── REAL run only beyond this point ──────────────────────────────────────────────
  // Click "Place your order", which opens the "Confirm your CVV" sidebar.
  log('success', 'Clicking "Place your order"...');
  await bgSend({ type: 'PLACE_ORDER_FRAMES', selectors: [S.placeOrder], keywords: kw, click: true }, 8000, { found: false });

  // A bot challenge (press-and-hold / DataDome) often fires right after this click — pause &
  // alert you to clear it, then resume, before we go looking for the CVV sidebar.
  await sleep(500);
  if (!(await awaitCaptchaClear('after place-order'))) return;

  // Target re-asks for the CVV even with saved payment. Fill #enter-cvv (in its iframe), poll
  // while the sidebar renders, then click Confirm → final submit (the charge).
  log('info', 'Waiting for CVV confirmation sidebar...');
  let cvvRes = { found: false };
  for (let i = 0; i < 20; i++) {
    cvvRes = await bgSend({ type: 'TARGET_CVV', cvv: cfg.cvv, confirm: false }, 6000, { found: false });
    if (cvvRes.found) break;
    await sleep(300);
  }
  if (!cvvRes.found) { log('warning', 'Target: CVV sidebar not found — stopping before order.'); return; }
  log('success', 'CVV entered — confirming order...');
  await wset({ botPhase: 'CONFIRM' });
  await bgSend({ type: 'TARGET_CVV', cvv: cfg.cvv, confirm: true }, 8000, { found: false });
}

// Reads the buy-box SELLER on a Walmart product page. Returns 'walmart' (1st-party retail),
// 'other:<name>' (3rd-party marketplace seller), or null if it can't be read from the page.
function walmartSeller() {
  const scan = (s) => {
    s = (s || '').toLowerCase().replace(/\s+/g, ' ');
    const m = s.match(/sold (?:and shipped )?by\s*:?\s*([a-z0-9 .,'&\-]{2,40})/);
    if (!m) return null;
    return /walmart/.test(m[1]) ? 'walmart' : ('other:' + m[1].trim().replace(/[.,]+$/, ''));
  };
  // Targeted seller elements first (more reliable than scanning the whole page).
  const sel = '[data-testid*="seller" i],[data-automation-id*="seller" i],[link-identifier*="seller" i],[aria-label*="sold" i],a[href*="/seller/"],a[href*="sold-and-shipped"]';
  for (const n of document.querySelectorAll(sel)) {
    const r = scan(n.textContent) || scan(n.getAttribute && n.getAttribute('aria-label'));
    if (r) return r;
  }
  // Fallback: the buy box / page text ("Sold and shipped by …").
  return scan(document.body && document.body.innerText);
}

// Walmart retail-only guard. The SELLER is the decider: buy only a 1st-party "Sold by Walmart" offer,
// and refuse any 3rd-party marketplace seller (the inflated $200+ resell listings). This means you do
// NOT have to set a price per item. Returns a REASON string if we should NOT buy, or null if it's a
// Walmart retail offer (or the seller can't be read — the retail drop routes through the /qp queue
// anyway, so we don't block on an unreadable seller).
function walmartRetailReject(cfg) {
  const seller = walmartSeller();
  if (seller && seller.indexOf('other:') === 0)
    return 'sold by "' + seller.slice(6).slice(0, 28) + '" — 3rd-party marketplace seller, not Walmart';
  if (seller === 'walmart') log('success', '✅ Sold by Walmart — retail offer, OK to buy.');
  else log('info', '⚠️ Seller not shown on this page — allowing (retail drops route through the queue).');
  // OPTIONAL extra cap: only if you ALSO set a Max Price, reject a price above it.
  const max = parseFloat((cfg && cfg.maxPrice) || '0');
  if (max > 0) {
    const el = document.querySelector('[itemprop="price"]');
    const price = el ? (parseFloat(el.getAttribute('content') || (el.textContent || '').replace(/[^0-9.]/g, '')) || 0) : 0;
    if (price > 0 && price > max) return 'price $' + price + ' over your Max Price $' + max;
  }
  return null;
}

async function runStore(store, cfg, burst) {
  const S = store.sel;
  const phase = store.detectPhase(location.href) || 'SEARCH';
  // Named steps for the checkout side so the status bar reads clearly. SEARCH is left to its own
  // handler below (watchlist sets a "Watching" step; single-item just searches) to avoid log spam.
  var PHASE_STEP = { RESULTS: '🔍 Search results', CART: '🛒 In cart', CHECKOUT: '💳 Checkout', CONFIRM: '✅ Order placed' };
  if (PHASE_STEP[phase]) setStep(PHASE_STEP[phase]);
  else { log('info', '── ' + phase + ' ──'); setStatus('running', store.name + ': ' + phase); }

  if (phase === 'RESULTS') {
    const want = (cfg.itemName || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const first = await waitForAny(S.productLink, 8000);
    if (!first) { log('warning', 'No results yet — reloading...'); await sleep(1200); location.reload(); return; }
    let best = first, score = -1;
    for (const a of document.querySelectorAll(S.productLink)) {
      const text = (a.textContent + ' ' + ((a.closest('li,div,article,[class*="card"]') || {}).textContent || '')).toLowerCase();
      const sc = want.length ? want.filter(w => text.includes(w)).length : 1;
      if (sc > score) { score = sc; best = a; }
    }
    log('success', 'Opening: "' + (best.textContent.trim().substring(0, 40) || best.href) + '"');
    location.href = best.href; return;
  }

  if (phase === 'SEARCH') {
    // Fractional seconds allowed (0.2 = 200ms, 0.07 = 70ms); floor at 0.05s so it can't hammer to 0ms.
    const interval = Math.max(0.05, parseFloat(cfg.refreshInterval) || 2);
    const wantQty = parseInt(cfg.quantity || '1');
    const canBuyNow = !!S.buyNow && !store.preferAddToCart; // preferAddToCart forces the cart route
    // If the Buy-now checkout drawer is already open (e.g. after a stop/restart on this page),
    // go straight to placing the order instead of clicking Buy now again. Instant check.
    if (canBuyNow && await findBtn(['place your order'], 0)) {
      log('info', 'Checkout drawer already open — placing order...');
      await buyNowDrawerCheckout(store, cfg); return;
    }
    // TARGET: Buy now sometimes NAVIGATES to /checkout/buy-now/checkout instead of opening the
    // drawer. During a drop an "Ok" error popup can block that page (capture: Ok → bounced back to
    // the item → Buy now again). So here: Place-order appears → finish checkout; "Ok"/"Close" popup
    // → dismiss it (Target bounces us back to the item, where the buy loop re-runs); neither → wait.
    if (store.key === 'target' && /\/checkout/.test(location.pathname)) {
      const poKw = ['place your order', 'place order', 'placeorder', 'submit order'];
      log('info', 'Target checkout page — waiting for "Place your order" (or an error popup)...');
      for (let i = 0; i < 25; i++) {
        const st = await wget('botRunning');
        if (!st.botRunning) return;
        const po = await bgSend({ type: 'PLACE_ORDER_FRAMES', selectors: [S.placeOrder], keywords: poKw, click: false }, 4000, { found: false });
        if (po.found) { await buyNowDrawerCheckout(store, cfg); return; }
        // Same grace as the drawer: give the checkout page ~7s to render Place-order before
        // treating a "Close"/"Ok" as the failure popup (dismissing early kills a loading page).
        if (i >= 14) {
          const dis = dismissTargetModal();
          if (dis) { log('warning', '🧹 Checkout popup — clicked "' + dis + '" (bounces back to the item; bot retries there).'); return; }
        }
        setStep('💳 Checkout', 'waiting for Place your order (' + (i + 1) + ')');
        await sleep(500);
      }
      log('warning', 'Target checkout: nothing actionable appeared — reloading.');
      location.reload(); return;
    }
    // Set quantity ON THE PRODUCT PAGE (must happen BEFORE Buy now uses it):
    //  • qtySelect → <select> dropdown (Target)   • qtyInput → cart-page box (handled later, not here)
    if (wantQty > 1) {
      if (S.qtySelect)      await storeSetQtySelect(S, wantQty);
      else if (!S.qtyInput) await storeSetQty(S, wantQty);
    }
    // Wait for the primary action button to EXIST (enabled OR disabled). On Target the main
    // button's id is "addToCartButtonOrTextIdFor<TCIN>" and the TCIN is in the URL, so anchor on
    // it: that way an OUT-OF-STOCK (disabled) button is detected the instant it renders instead of
    // burning the full timeout waiting for an enabled one that never comes (the old ~8s/cycle bug).
    const tcin = (location.pathname.match(/\/A-(\d+)/) || [])[1];
    const mainSel = tcin ? '#addToCartButtonOrTextIdFor' + tcin : null;
    const actionSel = (canBuyNow ? S.buyNow + ', ' : '') + S.addToCart;
    // In watchlist mode we're scanning many items, so don't burn 8s per out-of-stock item — a live
    // item redirects to /qp (caught earlier by detectQueue), so a slow-to-render add button here
    // means it's not live; bail sooner and rotate to the next item.
    const watchlistMode = store.key === 'walmart' && Array.isArray(cfg.watchlist) && cfg.watchlist.length > 1;
    if (watchlistMode) {
      let wi = (await wget('watchIndex')).watchIndex; if (typeof wi !== 'number') wi = 0;
      const itemId = location.pathname.replace(/\/+$/, '').split('/').pop();
      setStatus('running', '👁 STEP: Watching for drop — #' + itemId + ' (' + (wi + 1) + '/' + cfg.watchlist.length + ')');
    }
    await waitForAnyState(mainSel || actionSel, burst ? 700 : (watchlistMode ? 3500 : 8000));

    // Resolve the action button + a UNIQUE selector to click. For Target, anchor on the MAIN
    // product button (its id is "addToCartButtonOrTextIdFor<TCIN>"), so a "Buy now"/"Add to cart"
    // in a related-items CAROUSEL can't be picked by mistake. Only use Buy now if it sits next to
    // the main button (not a carousel); preorders have none.
    let usingBuyNow = false, addBtn = null, clickSel = null;
    const mainBtn = tcin ? document.getElementById('addToCartButtonOrTextIdFor' + tcin) : null;
    if (mainBtn) {
      const isPreorder = mainBtn.getAttribute('data-test') === 'preorderButton';
      let mainBuyNow = null;
      if (canBuyNow && !isPreorder) { // find a Buy now in the main button's nearby container
        let node = mainBtn;
        for (let i = 0; i < 4 && node && !mainBuyNow; i++) { node = node.parentElement; if (node) mainBuyNow = node.querySelector(S.buyNow); }
      }
      if (mainBuyNow) { usingBuyNow = true; addBtn = mainBuyNow; clickSel = S.buyNow; }
      else            { addBtn = mainBtn;  clickSel = '#' + (window.CSS && CSS.escape ? CSS.escape(mainBtn.id) : mainBtn.id); }
    } else {
      // Non-Target / unknown layout: prefer Buy now if present, else Add to cart (first match).
      const buyNowEl = canBuyNow ? document.querySelector(S.buyNow) : null;
      usingBuyNow = !!buyNowEl;
      addBtn = buyNowEl || document.querySelector(S.addToCart);
      clickSel = usingBuyNow ? S.buyNow : S.addToCart;
    }
    // REFRESH only when the page genuinely can't proceed: a real error/overload page, OR no
    // clickable action button (out of stock = present-but-DISABLED, or not rendered). A disabled
    // click is a no-op and would wrongly open an empty cart, so we reload and watch for the restock.
    const isDisabled = (el) => !el || el.disabled || el.getAttribute('aria-disabled') === 'true';
    const errNow = detectStoreError();
    if (errNow || !addBtn || isDisabled(addBtn)) {
      // TARGET FAST WATCH: instead of reloading the whole page (~2s) every cycle, poll Target's stock
      // API (~150ms) and only reload ONCE when it flips to IN_STOCK — then the live button appears and
      // the spam-click grabs it. Falls back to a normal reload on an error page or API hiccup.
      if (store.key === 'target' && !errNow) {
        const tcin = (location.pathname.match(/\/A-(\d+)/) || [])[1];
        if (tcin) { await watchTargetStock(tcin, interval, burst); return; }
      }
      // WALMART: reloading the item page bounces you back into the /qp queue (loses your spot), so
      // do NOT reload — wait IN-PLACE for the Add to cart button to become buyable, then fall
      // through and click it. Reload only as a last resort if it never enables.
      const watchlist = (store.key === 'walmart' && Array.isArray(cfg.watchlist)) ? cfg.watchlist : null;
      if (watchlist && watchlist.length > 1) {
        // WATCHLIST MODE: watch ALL drop items in the BACKGROUND (same-origin HTML fetch reading
        // availabilityStatus) WITHOUT navigating — the tab stays put and we only navigate to an
        // item the instant a RETAIL offer goes live. Falls back to rotation if the fetch is blocked.
        await watchWalmartList(watchlist, interval, burst, store, cfg); return;
      }
      // WALMART single item: watch in the BACKGROUND (same-origin HTML poll) instead of reloading
      // the page every cycle. Covers BOTH "item not available" (errNow — the normal pre-drop state)
      // and out-of-stock. Reloads only when the retail offer is live; never bounces a /qp queue spot.
      if (store.key === 'walmart') {
        await watchWalmartItem(location.href.split('#')[0], interval, burst, store, cfg); return;
      }
      {
        const delay = burst ? 150 : interval * 1000;
        const why = errNow || (!addBtn ? 'not available' : 'out of stock');
        log('warning', (burst ? '⚡ ' : '') + why + (burst ? ' — burst reloading…' : ' — refreshing…'));
        await sleep(delay); location.reload(); return;
      }
    }

    // WALMART retail-only guard: a buyable button here might be an over-priced 3rd-party offer, NOT
    // the cheap retail drop. If so, DON'T buy — keep waiting for the retail drop (arrives via the /qp
    // queue at the retail price). Watchlist → rotate to next item; single → reload to keep watching.
    if (store.key === 'walmart') {
      const reject = walmartRetailReject(cfg);
      if (reject) {
        log('warning', '⛔ Not buying — ' + reject + '. Waiting for the retail drop.');
        setStatus('running', '⛔ 3rd-party/over-price — waiting for retail');
        const wl = Array.isArray(cfg.watchlist) ? cfg.watchlist : null;
        if (wl && wl.length > 1) {
          let idx = (await wget('watchIndex')).watchIndex; if (typeof idx !== 'number') idx = 0;
          const next = (idx + 1) % wl.length;
          await wset({ watchIndex: next });
          await sleep(Math.max(1500, interval * 1000));
          location.href = store.itemUrl(wl[next]); return;
        }
        // Single item: don't reload-loop on the 3rd-party offer — watch in the background and only
        // reload when a retail offer appears.
        await watchWalmartItem(location.href.split('#')[0], interval, burst, store, cfg); return;
      }
    }

    setStep(usingBuyNow ? '🛒 Buy now' : '🛒 Adding to cart', usingBuyNow ? 'opening checkout drawer' : '');
    if (store.trustedClick) {
      const ok = await trustedClickSel(clickSel);
      if (!ok) { log('warning', 'Trusted click failed — falling back to DOM click'); addBtn.click(); }
    } else {
      addBtn.click();
    }
    await sleep(900);
    if (usingBuyNow && store.key === 'target') {
      // TARGET DROP PERSISTENCE — do what a human does (confirmed by the click tracker during a
      // real drop): "Buy now" flickers enabled/disabled and EATS clicks for ~30-60s before the
      // drawer opens. One click is never enough. So loop: check WHAT STEP we're on each cycle —
      // drawer open ("Place your order" exists in any frame) → go check out; Buy now still on the
      // page and enabled → CLICK IT AGAIN; disabled → wait for the flicker back to enabled.
      const poKw = ['place your order', 'place order', 'placeorder', 'submit order'];
      const drawerOpen = () => bgSend({ type: 'PLACE_ORDER_FRAMES', selectors: [S.placeOrder], keywords: poKw, click: false }, 4000, { found: false });
      let opened = false, lastClick = Date.now(); // the initial click just happened above
      for (let t = 0; t < 50; t++) {                       // ~60s of persistence
        const st = await wget('botRunning');
        if (!st.botRunning) return;                        // user stopped
        const po = await drawerOpen();
        if (po.found) { opened = true; break; }            // step advanced → drawer is open
        // GRACE WINDOW: the REAL checkout drawer takes a few seconds to render "Place your order"
        // after a click — and it has its own "Close" button, so dismissing during this window was
        // CLOSING the good drawer. 7.3s matches the ORIGINAL pre-persistence wait (900ms post-click
        // + 400ms settle + 20×300ms poll), which worked. Only after that is "Close"/"Ok" a failure.
        if (Date.now() - lastClick < 7300) {
          setStep('🛒 Buy now', 'drawer opening — waiting for it to load…');
          await sleep(500); continue;
        }
        // Still no Place-order well after the click → whatever "Close"/"Ok" is showing is the
        // FAILURE popup from the capture — dismiss it and retry, like a human.
        const dis = dismissTargetModal();
        if (dis) { log('info', '🧹 Dismissed "' + dis + '" popup — retrying Buy now'); await sleep(250); }
        const btn = document.querySelector(clickSel);
        if (!btn) { opened = true; break; }                // button gone → page moved on; let checkout look
        const enabled = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        if (enabled) {
          if (t % 5 === 0) log('info', '🛒 Buy now still here — clicking again (try ' + (t + 1) + ')');
          setStep('🛒 Buy now', 'drawer not open yet — re-clicking (' + (t + 1) + ')');
          if (store.trustedClick) { const ok = await trustedClickSel(clickSel); if (!ok) btn.click(); }
          else btn.click();
          lastClick = Date.now();
        } else {
          setStep('🛒 Buy now', 'button disabled — waiting for it to re-enable (' + (t + 1) + ')');
        }
        await sleep(650);
      }
      if (!opened) { log('warning', 'Buy-now drawer never opened after persistent clicking — reloading to retry.'); await sleep(400); location.reload(); return; }
      await buyNowDrawerCheckout(store, cfg);
    } else if (usingBuyNow) {
      // Buy now opens a checkout drawer on THIS same page — finish the order inline.
      await buyNowDrawerCheckout(store, cfg);
    } else {
      // "View cart & check out" flyout link → go to the cart. Navigate via its href when it's an
      // anchor (more reliable than .click(), which the page can intercept); else click it.
      const vc = await waitForAny(S.viewCart, 5000);
      if (vc) {
        log('info', 'Opening cart...');
        const href = vc.getAttribute && vc.getAttribute('href');
        if (href) location.href = new URL(href, location.origin).href;
        else vc.click();
      } else {
        log('warning', store.name + ': "View cart" not found — going to /cart directly');
        location.href = new URL('/cart', location.origin).href;
      }
    }
    return;
  }

  if (phase === 'CART') {
    // Change the amount on the cart page if you asked for more than 1 (qty input).
    // The box is React-controlled, so set it with real CDP keystrokes (via background).
    const wantQty = parseInt(cfg.quantity || '1');
    if (wantQty > 1 && S.qtyInput) {
      // WAIT for the qty box to render (cart React mounts after DOMContentLoaded)
      const qin = await waitForAny(S.qtyInput, 6000);
      if (!qin) {
        log('warning', 'Quantity box not found on cart page yet');
      } else if (parseInt(qin.value) === wantQty) {
        log('info', 'Quantity already ' + qin.value);
      } else {
        log('info', 'Setting cart quantity to ' + wantQty + '...');
        await bgSend({ type: 'STORE_SET_QTY', selector: S.qtyInput, value: wantQty }, 6000, null);
        // no extra pause — the CDP set already commits the change
      }
    }

    const co = await waitForAny(S.checkout, 10000);
    if (!co) { log('warning', store.name + ': checkout not ready — reloading...'); await sleep(1200); location.reload(); return; }
    // TEST MODE: the item is in the cart — STOP here. Proceeding to checkout on a logged-in
    // account with saved payment can run straight through to placing a real order, so Test never
    // clicks "Check out".
    const testCart = (cfg && cfg.testMode) || (await wget('botTestMode')).botTestMode;
    if (testCart) {
      log('success', '🧪 TEST MODE — item is in the cart, NOT proceeding to checkout. No order placed.');
      showBigBanner('✓ ADDED TO CART', 'TEST MODE — stopped before checkout');
      setStatus('done', '🧪 Test passed — in cart, not ordered');
      await wset({ botRunning: false, botPhase: 'IDLE' });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
      return;
    }
    setStep('💳 Checkout', 'proceeding to checkout'); co.click(); return;
  }

  if (phase === 'CHECKOUT') {
    // Pokémon Center has its own payment screen (dropdown + secure card iframes)
    if (store.key === 'pokemoncenter') { await pokemonCheckout(store, cfg); return; }
    // Target: whether we got here via Buy now OR the cart route, finish through the SAME handler
    // (all-frames "Place your order" → CVV → Confirm) which STOPS in Test mode before submitting.
    if (store.key === 'target') { await buyNowDrawerCheckout(store, cfg); return; }

    const cvv = document.querySelector(S.cvv);
    if (cvv && cfg.cvv) { fillGeneric(cvv, cfg.cvv); log('info', 'CVV filled'); await sleep(400); }
    const po = await waitForAny(S.placeOrder, 10000);
    if (!po) { log('warning', store.name + ': Place Order not ready — reloading...'); await sleep(1200); location.reload(); return; }
    // TEST MODE: everything ran for real, but DON'T submit — show the confirmation banner.
    const botTestMode = (cfg && cfg.testMode) || (await wget('botTestMode')).botTestMode;
    if (botTestMode) {
      log('success', '🧪 TEST MODE — found Place Order, NOT submitting. Order would go through here.');
      showBigBanner('✓ ORDER CONFIRMED', 'TEST MODE — no real order was placed');
      setStatus('done', '🧪 Test passed — order NOT placed');
      await wset({ botRunning: false, botPhase: 'IDLE' });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
      return;
    }
    // A bot challenge can gate the final submit — pause & alert to clear it, then place the order.
    if (!(await awaitCaptchaClear('checkout'))) return;
    setStep('✅ Placing order');
    if (store.trustedClick) {
      const ok = await trustedClickSel(S.placeOrder);
      if (!ok) po.click();
    } else { po.click(); }
    return;
  }

  if (phase === 'CONFIRM') {
    log('success', '🎉 ' + store.name + ' — order step reached (verify the page).');
    setStatus('done', 'Order step complete');
    chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'success', text: store.name + ' order placed (please verify).' }).catch(() => {});
    if (cfg.stopOnSuccess) {
      await wset({ botRunning: false, botPhase: 'IDLE' });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
    }
    return;
  }

  log('info', store.name + ': unrecognized page — waiting...');
  await sleep(1500); location.reload();
}

// Finds the first enabled button matching any keyword across all attributes
function findBtn(keywords, timeout = 5000) {
  return new Promise((resolve) => {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const find = () => {
      for (const el of document.querySelectorAll('button, input[type="submit"], a[role="button"]')) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const visibleText = (el.textContent || '').trim().toLowerCase();
        if (visibleText.startsWith('skip')) continue;
        if (visibleText.includes('shopping')) continue;
        if (visibleText.includes('keep browsing')) continue;
        const raw = [
          el.textContent,
          el.getAttribute('aria-label')         || '',
          el.getAttribute('value')              || '',
          el.getAttribute('title')              || '',
          el.getAttribute('name')               || '',
          el.getAttribute('id')                 || '',
          el.getAttribute('class')              || '',
          el.getAttribute('data-automation-id') || '',
          el.getAttribute('data-test')          || '',
          el.getAttribute('data-testid')        || '',
          el.getAttribute('data-action')        || '',
          el.getAttribute('data-tl-id')         || '',
          el.getAttribute('data-btn-id')        || '',
          el.getAttribute('data-dca-event')     || '',
          el.getAttribute('data-dca-intent')    || '',
        ].join(' ').toLowerCase();
        const text = norm(raw);
        if (keywords.some(k => text.includes(norm(k)))) return el;
      }
      return null;
    };
    const el = find(); if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = find(); if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

function waitFor(id, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.getElementById(id);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = document.getElementById(id);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error(id + ' not found')); }, timeout);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(level, text) {
  console.log('[SnipeBot][' + level + '] ' + text);
  // Tag with this tab's window id so ONLY the owning window's panel shows it (per-window logs).
  const wid = (typeof window.__BOT_WID === 'number') ? window.__BOT_WID : null;
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text, wid }).catch(() => {});
}

function setStatus(state, text) {
  const wid = (typeof window.__BOT_WID === 'number') ? window.__BOT_WID : null;
  chrome.runtime.sendMessage({ type: 'BOT_STATUS', status: state, text, wid }).catch(() => {});
}

// Named steps — surfaced in the status bar AND logged as "▶ STEP: …", so it's always clear which
// step the bot is on at any moment (watching → in line → your turn → cart → checkout → placed).
function setStep(name, extra, state) {
  const full = name + (extra ? ' — ' + extra : '');
  log('info', '▶ STEP: ' + full);
  setStatus(state || 'running', full);
}

// Big full-screen confirmation banner drawn ON the page (used by Test mode). Self-contained
// inline styles so it shows regardless of the site's CSS; click or 6s auto-dismiss.
function showBigBanner(title, sub) {
  try {
    document.getElementById('__botBigBanner')?.remove();
    const o = document.createElement('div');
    o.id = '__botBigBanner';
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;background:rgba(0,40,10,.92);cursor:pointer;'
      + 'font-family:Arial,Helvetica,sans-serif;text-align:center;';
    o.innerHTML =
      '<div style="font-size:96px;line-height:1;margin-bottom:18px">✅</div>'
      + '<div style="font-size:64px;font-weight:900;color:#fff;letter-spacing:1px">' + title + '</div>'
      + (sub ? '<div style="font-size:22px;color:#bff5cf;margin-top:14px;font-weight:700">' + sub + '</div>' : '')
      + '<div style="font-size:14px;color:#8fd9a8;margin-top:28px">(click to dismiss)</div>';
    o.addEventListener('click', () => o.remove());
    document.documentElement.appendChild(o);
    setTimeout(() => o.remove(), 6000);
  } catch (_) {}
}
