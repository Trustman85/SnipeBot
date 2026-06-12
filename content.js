// Runs on every page load — checks current bot phase and acts accordingly
(async () => {
  try {
    const { botRunning, botPhase, botConfig, activeProfile, burstUntil, botRunToken } = await chrome.storage.local.get(['botRunning', 'botPhase', 'botConfig', 'activeProfile', 'burstUntil', 'botRunToken']);
    if (!botRunning || !botConfig) return;
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
    // Burst mode (around a drop): reload as fast as possible to catch the item going live
    const burst = burstUntil && Date.now() < burstUntil;

    const page = window.location.pathname;

    // ── CAPTCHA / bot challenge ────────────────────────────────────
    // The bot can't solve these — alert the human (sound + notification) and WAIT for it
    // to be cleared (don't reload, which can make it worse). Resume once it's gone.
    if (isStore && detectCaptcha()) {
      log('error', '🛑 CAPTCHA / verification detected — SOLVE IT in the page! (alerting you)');
      setStatus('error', '🛑 CAPTCHA — solve it!');
      chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'captcha', text: 'A CAPTCHA/verification is blocking the bot — solve it in the page.' }).catch(() => {});
      let buzzed = 0;
      while (detectCaptcha()) {
        await sleep(2500);
        if (++buzzed % 6 === 0) chrome.runtime.sendMessage({ type: 'BOT_ALERT', kind: 'captcha', text: 'Still waiting on the CAPTCHA…' }).catch(() => {});
        const st = await chrome.storage.local.get('botRunning');
        if (!st.botRunning) return;
      }
      log('success', 'CAPTCHA cleared — continuing');
    }

    // ── High-demand QUEUE / waiting room ───────────────────────────
    // If the site put us in a waiting line, WAIT it out — do NOT reload (that can lose
    // your place). Track elapsed time, the queue's est-wait/position, and report to the panel.
    if (isStore && detectQueue()) {
      // Persist the queue start time so "time in line" survives queue-page reloads
      let qs = (await chrome.storage.local.get('queueSince')).queueSince;
      if (!qs) { qs = Date.now(); await chrome.storage.local.set({ queueSince: qs }); }
      log('warning', '⏳ In high-demand queue — waiting in line (will not reload)...');
      setStatus('running', 'Waiting in queue (high demand)...');
      chrome.runtime.sendMessage({ type: 'BOT_QUEUE', state: 'in', since: qs, info: readQueueInfo() }).catch(() => {});

      let waited = 0;
      while (detectQueue()) {
        chrome.runtime.sendMessage({ type: 'BOT_QUEUE', state: 'in', since: qs, info: readQueueInfo() }).catch(() => {});
        await sleep(3000); waited += 3;
        if (waited % 15 === 0) log('info', 'Still in queue... (' + Math.round((Date.now() - qs) / 1000) + 's in line)');
        const st = await chrome.storage.local.get('botRunning');
        if (!st.botRunning) return; // user stopped
      }
      await chrome.storage.local.remove('queueSince');
      chrome.runtime.sendMessage({ type: 'BOT_QUEUE', state: 'out' }).catch(() => {});
      log('success', 'Queue cleared after ' + Math.round((Date.now() - qs) / 1000) + 's — continuing');
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
    const interval = parseInt(botConfig.refreshInterval || '2');

    if (isSams) {
      log('info', 'Checking shipping selection...');
      await selectShipping();
      await selectVariant(); // pick a Style if the item has variants and none is chosen
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
        const { samsFellBack } = await chrome.storage.local.get('samsFellBack');
        if (!hasProduct && !samsFellBack) {
          log('warning', 'Item number page not found — falling back to search...');
          await chrome.storage.local.set({ samsFellBack: true });
          location.href = 'https://www.samsclub.com/s/' + encodeURIComponent(botConfig.itemSku);
          return;
        }
      }
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
      await chrome.storage.local.set({ botRunning: false });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
      return;
    }

    log('success', (price > 0 ? 'In stock at $' + price : 'Item available') + ' — clicking Add to Cart...');
    setStatus('running', 'Adding to cart...');
    addBtn.click();
    log('info', 'Add to Cart clicked — waiting for confirmation...');

    if (isSams) {
      await chrome.storage.local.set({ botPhase: 'ADDED' });
      await waitForViewCart(botConfig, isSams);
    } else {
      await chrome.storage.local.set({ botPhase: 'CART' });
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
    await chrome.storage.local.set({ botPhase: 'CHECKOUT' });
    btn.click();
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
    await chrome.storage.local.set({ botPhase: 'CONFIRM' });
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
        await chrome.storage.local.set({ botPhase: 'CHECKOUT' });
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
      await chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
      log('info', 'Bot stopped (stop-on-success)');
    }
  }

  } catch (err) {
    log('error', 'Bot error: ' + err.message + ' (phase: ' + (await chrome.storage.local.get('botPhase')).botPhase + ')');
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
  const { qtyDone } = await chrome.storage.local.get('qtyDone');
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
  await chrome.storage.local.set({ qtyDone: true }); // lock it so it can't run again
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
  if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="captcha" i], #px-captcha, [id*="px-captcha"], [class*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i], [aria-label*="captcha" i]')) return true;
  const t = (document.body && document.body.innerText || '').toLowerCase();
  return /are you a human|verify (?:you(?:'| a)?re|that you are) (?:a )?human|i'?m not a robot|complete the (?:captcha|security check)|press (?:and|&) hold|unusual traffic|confirm you(?:'| a)?re human|enter the characters|verify your identity|security check to access/.test(t);
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
// Real browser-level click via CDP (background). For buttons gated on trusted events
// (Target's Buy now / Place your order ignore a scripted .click()). Returns true on success.
async function trustedClickSel(selector) {
  return await new Promise(res => chrome.runtime.sendMessage({ type: 'CDP_CLICK', selector }, r => res(!!r)));
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
  const sel = await waitForAny(S.qtySelect, 6000);
  if (!sel) { log('warning', 'Quantity dropdown not found'); return false; }
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
async function pokemonCheckout(S, cfg) {
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
      const r = (await chrome.storage.local.get('pokePlaceRetries')).pokePlaceRetries || 0;
      if (r >= 3) { log('error', '🛑 Gateway kept rejecting payment after ' + r + ' tries — stopping.'); setStatus('error', 'Payment rejected — check card'); return; }
      await chrome.storage.local.set({ pokePlaceRetries: r + 1 });
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
      const { botTestMode } = await chrome.storage.local.get('botTestMode');
      if (botTestMode) {
        log('success', '🧪 TEST MODE — found Place Order, NOT submitting. Order would go through here.');
        showBigBanner('✓ ORDER CONFIRMED', 'TEST MODE — no real order was placed');
        setStatus('done', '🧪 Test passed — order NOT placed');
        await chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
        chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
        return;
      }
      log('success', 'Placing order: "' + (po.textContent || '').trim().substring(0, 40) + '"');
      await chrome.storage.local.set({ botPhase: 'CONFIRM' });
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
    await chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
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

// Target's "Buy now" opens the checkout as a DRAWER on the same product URL (no navigation),
// so we finish the order right here instead of waiting for a CHECKOUT page that never loads.
// Waits for the Total to populate, fills CVV if asked, then submits (or, in Test mode, shows
// the confirmation banner without submitting).
async function buyNowDrawerCheckout(store, cfg) {
  const S = store.sel;
  // The side drawer animates in and loads its contents asynchronously — give it a beat.
  log('info', 'Buy now clicked — waiting for checkout drawer...');
  await sleep(400);

  // The drawer is rendered in an IFRAME, so search ALL frames (via background) — the top-frame
  // content script can't see inside it. Poll tightly so we act the instant it loads.
  const kw = ['place your order', 'place order', 'placeorder', 'submit order'];
  let res = { found: false };
  for (let i = 0; i < 20; i++) {
    res = await new Promise(r => chrome.runtime.sendMessage(
      { type: 'PLACE_ORDER_FRAMES', selectors: [S.placeOrder], keywords: kw, click: false }, resp => r(resp || { found: false })));
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
  const { botTestMode } = await chrome.storage.local.get('botTestMode');
  if (botTestMode) {
    log('success', '🧪 TEST MODE — found "Place your order", NOT clicking it. No order placed.');
    showBigBanner('✓ ORDER CONFIRMED', 'TEST MODE — no real order was placed');
    setStatus('done', '🧪 Test passed — order NOT placed');
    await chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
    chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
    return;
  }

  // ── REAL run only beyond this point ──────────────────────────────────────────────
  // Click "Place your order", which opens the "Confirm your CVV" sidebar.
  log('success', 'Clicking "Place your order"...');
  await new Promise(r => chrome.runtime.sendMessage(
    { type: 'PLACE_ORDER_FRAMES', selectors: [S.placeOrder], keywords: kw, click: true }, resp => r(resp)));

  // Target re-asks for the CVV even with saved payment. Fill #enter-cvv (in its iframe), poll
  // while the sidebar renders, then click Confirm → final submit (the charge).
  log('info', 'Waiting for CVV confirmation sidebar...');
  let cvvRes = { found: false };
  for (let i = 0; i < 20; i++) {
    cvvRes = await new Promise(r => chrome.runtime.sendMessage(
      { type: 'TARGET_CVV', cvv: cfg.cvv, confirm: false }, resp => r(resp || { found: false })));
    if (cvvRes.found) break;
    await sleep(300);
  }
  if (!cvvRes.found) { log('warning', 'Target: CVV sidebar not found — stopping before order.'); return; }
  log('success', 'CVV entered — confirming order...');
  await chrome.storage.local.set({ botPhase: 'CONFIRM' });
  await new Promise(r => chrome.runtime.sendMessage(
    { type: 'TARGET_CVV', cvv: cfg.cvv, confirm: true }, resp => r(resp)));
}

async function runStore(store, cfg, burst) {
  const S = store.sel;
  const phase = store.detectPhase(location.href) || 'SEARCH';
  log('info', '── ' + store.name + ' | ' + phase + ' | ' + location.pathname + ' ──');
  setStatus('running', store.name + ': ' + phase);

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
    const interval = parseInt(cfg.refreshInterval || '2');
    const wantQty = parseInt(cfg.quantity || '1');
    // If the Buy-now checkout drawer is already open (e.g. after a stop/restart on this page),
    // go straight to placing the order instead of clicking Buy now again. Instant check.
    if (S.buyNow && await findBtn(['place your order'], 0)) {
      log('info', 'Checkout drawer already open — placing order...');
      await buyNowDrawerCheckout(store, cfg); return;
    }
    // Set quantity ON THE PRODUCT PAGE (must happen BEFORE Buy now uses it):
    //  • qtySelect → <select> dropdown (Target)
    //  • qtyInc    → +/- stepper buttons
    //  • qtyInput  → cart-page number box (Pokémon) → handled later, not here
    if (wantQty > 1) {
      if (S.qtySelect)      await storeSetQtySelect(S, wantQty);
      else if (!S.qtyInput) await storeSetQty(S, wantQty);
    }
    // Prefer "Buy now" (skips the cart, straight to checkout). If it isn't present — some items
    // (e.g. apparel that needs a size picked) don't offer Buy now — fall back to Add to cart.
    let usingBuyNow = false, addBtn = null;
    if (S.buyNow) { addBtn = await waitForAny(S.buyNow, burst ? 700 : 6000); usingBuyNow = !!addBtn; }
    if (!addBtn)  { addBtn = await waitForAny(S.addToCart, burst ? 500 : 4000); }
    if (!addBtn) {
      const delay = burst ? 150 : interval * 1000;
      log('warning', burst ? '⚡ Not live — burst reloading...' : store.name + ': not available — refreshing...');
      await sleep(delay); location.reload(); return;
    }
    log('success', usingBuyNow ? 'Buy now — opening checkout drawer...' : 'Adding to cart...');
    const clickSel = usingBuyNow ? S.buyNow : S.addToCart;
    if (store.trustedClick) {
      const ok = await trustedClickSel(clickSel);
      if (!ok) { log('warning', 'Trusted click failed — falling back to DOM click'); addBtn.click(); }
    } else {
      addBtn.click();
    }
    await sleep(900);
    if (usingBuyNow) {
      // Buy now opens a checkout drawer on THIS same page — finish the order inline.
      await buyNowDrawerCheckout(store, cfg);
    } else {
      const vc = await waitForAny(S.viewCart, 4000);
      if (vc) { log('info', 'Opening cart...'); vc.click(); }
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
        await new Promise(res => chrome.runtime.sendMessage({ type: 'STORE_SET_QTY', selector: S.qtyInput, value: wantQty }, () => res()));
        // no extra pause — the CDP set already commits the change
      }
    }

    const co = await waitForAny(S.checkout, 10000);
    if (!co) { log('warning', store.name + ': checkout not ready — reloading...'); await sleep(1200); location.reload(); return; }
    log('success', 'Proceeding to checkout...'); co.click(); return;
  }

  if (phase === 'CHECKOUT') {
    // Pokémon Center has its own payment screen (dropdown + secure card iframes)
    if (store.key === 'pokemoncenter') { await pokemonCheckout(S, cfg); return; }

    const cvv = document.querySelector(S.cvv);
    if (cvv && cfg.cvv) { fillGeneric(cvv, cfg.cvv); log('info', 'CVV filled'); await sleep(400); }
    const po = await waitForAny(S.placeOrder, 10000);
    if (!po) { log('warning', store.name + ': Place Order not ready — reloading...'); await sleep(1200); location.reload(); return; }
    // TEST MODE: everything ran for real, but DON'T submit — show the confirmation banner.
    const { botTestMode } = await chrome.storage.local.get('botTestMode');
    if (botTestMode) {
      log('success', '🧪 TEST MODE — found Place Order, NOT submitting. Order would go through here.');
      showBigBanner('✓ ORDER CONFIRMED', 'TEST MODE — no real order was placed');
      setStatus('done', '🧪 Test passed — order NOT placed');
      await chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' }).catch(() => {});
      return;
    }
    log('success', 'Placing order...');
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
      await chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
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
  console.log('[CheckoutBot][' + level + '] ' + text);
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text }).catch(() => {});
}

function setStatus(state, text) {
  chrome.runtime.sendMessage({ type: 'BOT_STATUS', status: state, text }).catch(() => {});
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
