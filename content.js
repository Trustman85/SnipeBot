// Runs on every page load — checks current bot phase and acts accordingly
(async () => {
  // Guard by URL: window persists across injections into the SAME document, so a
  // second injection of the same page exits here. A real navigation or location.reload()
  // creates a fresh document (window reset), so the bot runs again as intended.
  if (window.__botLastUrl === location.href) return;
  window.__botLastUrl = location.href;

  try {
    const { botRunning, botPhase, botConfig, activeProfile } = await chrome.storage.local.get(['botRunning', 'botPhase', 'botConfig', 'activeProfile']);
    if (!botRunning || !botConfig) return;
    const isSams = activeProfile === 'sams';

    const page = window.location.pathname;

    // ── High-demand QUEUE / waiting room ───────────────────────────
    // If the site put us in a waiting line, WAIT it out — do NOT reload (that can lose
    // your place) and do NOT treat it as a step. Poll until it clears, then continue.
    if (isSams && detectQueue()) {
      log('warning', '⏳ In high-demand queue — waiting in line (will not reload)...');
      setStatus('running', 'Waiting in queue (high demand)...');
      let waited = 0;
      while (detectQueue()) {
        await sleep(3000); waited += 3;
        if (waited % 15 === 0) log('info', 'Still in queue... (' + waited + 's in line)');
        const st = await chrome.storage.local.get('botRunning');
        if (!st.botRunning) return; // user stopped
      }
      log('success', 'Queue cleared after ' + waited + 's — continuing');
      // If the queue cleared by full-page redirect, this doc is gone and a fresh inject
      // takes over. If it cleared in-place (SPA), fall through and re-detect the step.
    }

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

    log('info', 'Looking for Add to Cart button...');
    // Patient wait so a slow/overloaded page has time to render the button before we
    // treat the item as unavailable (in-stock pages still resolve instantly).
    const addWait = isSams ? patientTimeout(8000) : (interval * 1000);
    const addBtn = isSams
      ? await waitForSamsBtn('[data-automation-id="atc"], [data-dca-event="addToCart"]', addWait)
      : await findBtn(['addtocart', 'addtobag', 'addtobasket', 'atc', 'buynow', 'buyitnow', 'purchase'], interval * 1000);

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
      log('warning', 'Add to Cart not found — item unavailable. Refreshing in ' + interval + 's...');
      setStatus('running', 'Not available – refreshing in ' + interval + 's');
      await sleep(interval * 1000);
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
