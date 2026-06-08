// ─────────────────────────────────────────────────────────────────────────────
// Sam's Club specific bot logic.
//
// This file is injected into the page BEFORE content.js (see popup.js / background.js
// / manifest.json). Both files run in the same content-script isolated world, so the
// top-level functions declared here are accessible from content.js.
//
// content.js calls these only when the active profile is "sams".
// ─────────────────────────────────────────────────────────────────────────────

// Detects a high-demand "waiting room" / queue / throttle page. On these the bot must
// WAIT (not reload — reloading can lose your place in line) until it clears.
function detectQueue() {
  const url = (location.href || '').toLowerCase();
  if (/queue|waitingroom|waiting-room|\/qit\/|queue-it|holding|throttle/.test(url)) return true;
  const t = (document.body && document.body.innerText || '').toLowerCase();
  return /waiting room|you are (now )?in line|you're in line|in the queue|your (place|spot|turn) in line|high demand|estimated wait|please wait while|number in line|currently in line|hold tight|you are in the queue/.test(t);
}

// Reads the queue page's own "estimated wait" and "position in line" if shown.
function readQueueInfo() {
  const t = (document.body && document.body.innerText) || '';
  const est = (t.match(/estimated wait[^0-9]*([0-9]+\s*(?:min|minute|sec|second|hour)[a-z]*)/i) ||
               t.match(/wait(?:ing)? time[^0-9]*([0-9]+\s*(?:min|minute|sec|second)[a-z]*)/i) ||
               t.match(/about\s*([0-9]+\s*(?:min|minute|sec|second)[a-z]*)/i))?.[1];
  const pos = (t.match(/(?:position|number)\s*(?:in line)?[^0-9]*([0-9][0-9,]{2,})/i) ||
               t.match(/you are[^0-9]*([0-9][0-9,]{2,})(?:st|nd|rd|th)?\s*in line/i))?.[1];
  return { est: est ? est.replace(/\s+/g, '') : null, pos: pos || null };
}

// Reads a post-queue "complete your purchase within MM:SS" / "time remaining" countdown.
function readCheckoutTimer() {
  const t = (document.body && document.body.innerText) || '';
  const m = t.match(/(?:complete (?:your )?(?:purchase|order|checkout)|time remaining|expires? in|reserved for(?: you)?|hold(?:ing)? your (?:cart|spot))[^0-9]*([0-9]{1,2}:[0-9]{2})/i);
  return m ? m[1] : null;
}

// Returns a more patient timeout when the page looks slow/still-loading (overloaded site),
// so the bot doesn't give up before a laggy element finally renders.
function patientTimeout(base) {
  const slow = document.readyState !== 'complete' || (document.querySelectorAll('*').length < 400);
  return slow ? Math.round(base * 2.5) : base;
}

// Inspects the CURRENT page (URL + key elements) and returns which checkout step
// we're actually on — so the bot self-corrects instead of blindly trusting the
// stored phase. Returns one of: CONFIRM, CHECKOUT, CART, ADDED, SEARCH, or null.
function detectSamsPhase() {
  const url = location.pathname.toLowerCase();

  // Order confirmation / thank-you page
  if (/confirmation|thank|order-confirm|order-placed|order-details|\/orders\//.test(url)) return 'CONFIRM';

  // Checkout / review-order page — has the Place Order button
  if (/checkout|review-order/.test(url) || document.querySelector('[data-automation-id="place-order-button"],[data-testid="place-order-button"]'))
    return 'CHECKOUT';

  // Cart page — has the Check Out button
  if (/\/cart\b/.test(url) || document.querySelector('[data-automation-id="checkout"]'))
    return 'CART';

  // "Added to cart" interstitial page (kept strict — URL only, so a mini-cart
  // "View Cart" link on a product page can't be mistaken for this step)
  if (/\/pac\b/.test(url)) return 'ADDED';

  // Search results page (By Name) — MUST be checked before SEARCH, because result
  // tiles have their own "Add" buttons that would otherwise look like a product page.
  if (/^\/s\//.test(url) || /\/search\b/.test(url)) return 'RESULTS';

  // Product page — has an Add to Cart button
  if (document.querySelector('[data-automation-id="atc"],[data-dca-event="addToCart"]') || /\/ip\//.test(url))
    return 'SEARCH';

  return null; // couldn't tell
}

// Sam's Club — finds a button by exact CSS selector
function waitForSamsBtn(selector, timeout = 5000) {
  return new Promise(resolve => {
    const find = () => {
      const el = document.querySelector(selector);
      return (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') ? el : null;
    };
    const el = find(); if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = find(); if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

// Sam's Club — checks if Shipping is already selected, clicks it if not
async function selectShipping() {
  const radio = document.getElementById('fulfillment-Shipping');
  if (!radio) { log('info', 'No fulfillment selector on this page'); return; }
  if (radio.getAttribute('data-selected') === 'true' || radio.checked) {
    log('info', 'Shipping already selected');
    return;
  }
  const tile = radio.closest('[class*="flex"]') || radio.parentElement;
  if (tile) {
    tile.click();
    log('success', 'Shipping selected');
    await sleep(100);
  }
}

// Sam's — if the item has a variant/style selector and none is chosen, pick the first
// option (so "Add to Cart" works on variant items reached via search). Best-effort.
async function selectVariant() {
  // Look for a variant option group
  const groups = [...document.querySelectorAll(
    '[data-testid*="variant"], [data-testid*="variation"], [data-testid*="ariation"], [class*="variant"], [aria-label*="tyle"]'
  )];
  let options = [];
  for (const g of groups) {
    const btns = [...g.querySelectorAll('button, [role="radio"], [role="button"]')].filter(b => (b.textContent || '').trim());
    if (btns.length) { options = btns; break; }
  }
  if (!options.length) return false; // no variants on this item

  // Already selected? (aria-checked/pressed, or a selected/active class)
  const isSel = (b) => b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-pressed') === 'true' ||
                       /selected|active|chosen/i.test(b.className || '');
  if (options.some(isSel)) { log('info', 'Variant already selected'); return true; }

  options[0].click();
  log('success', 'Selected variant: "' + options[0].textContent.trim().substring(0, 30) + '"');
  await sleep(300);
  return true;
}

// Waits for View Cart button after adding to cart — reloads if not found, but gives up
// after a few tries so a non-addable item (e.g. unselected variant) can't loop forever.
async function waitForViewCart(botConfig, isSams) {
  log('info', 'Waiting for View Cart button...');
  const viewCartBtn = await findBtn(['viewcart', 'viewbag', 'gotocart', 'viewmycart'], patientTimeout(12000));
  if (viewCartBtn) {
    log('success', 'Found View Cart: "' + viewCartBtn.textContent.trim().split('\n')[0].substring(0, 40) + '"');
    log('info', 'Clicking View Cart...');
    viewCartBtn.click();
    await chrome.storage.local.set({ botPhase: 'CART', addAttempts: 0 }); // reset on success
  } else {
    // Keep trying indefinitely — under a heavy drop the confirmation can be slow, and you'd
    // rather keep pushing than give up. (Press Stop to end it; it checks botRunning first.)
    const { addAttempts = 0 } = await chrome.storage.local.get('addAttempts');
    await chrome.storage.local.set({ addAttempts: addAttempts + 1 });
    log('warning', 'View Cart not found (try ' + (addAttempts + 1) + ') — reloading and retrying...');
    location.reload();
  }
}

// Sam's Club — fills the payment modal (card number, expiry, CVV) and saves
async function fillSamsPayment(cfg) {
  function fillField(el, val, skipBlur = false) {
    if (!el || !val) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    el.focus();
    el.click();
    nativeSetter.call(el, String(val));

    // Trigger React's internal onChange via fiber props — works when _valueTracker is absent
    const reactPropsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
    if (reactPropsKey) {
      el[reactPropsKey].onChange?.({ target: el, currentTarget: el, type: 'change' });
      el[reactPropsKey].onInput?.({ target: el, currentTarget: el, type: 'input' });
    }

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (!skipBlur) el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // A saved card may or may not require re-entering the CVV. Rather than gate on the
  // CVV field (which isn't always present), wait for the Place Order button — its
  // presence means there's a usable payment method. Background then fills the CVV
  // ONLY if a CVV field exists, and clicks Place Order either way.
  const placeOrderReady = await waitForSamsBtn(
    '[data-automation-id="place-order-button"], [data-testid="place-order-button"]', patientTimeout(12000));

  if (placeOrderReady) {
    log('success', 'Payment ready — submitting (CVV filled only if required)...');
    chrome.runtime.sendMessage({ type: 'SAMS_CHECKOUT', cvv: String(cfg.cvv) });
    await chrome.storage.local.set({ botPhase: 'CONFIRM' });
    return false; // background handles CVV (if needed) + Place Order
  }

  log('info', 'No Place Order button — no saved card, will add a payment method');

  // No saved card — open the Add payment modal
  if (!document.getElementById('cc-number')) {
    log('info', 'Looking for Add payment button...');
    const paymentSection = [...document.querySelectorAll('section, div, article')]
      .find(el => /payment\s*method/i.test(el.textContent) && el.querySelector('button, a'));
    const addBtn = paymentSection
      ? paymentSection.querySelector('button, a[role="button"]')
      : await findBtn(['addpaymentmethod', 'addpayment', 'addcard']);
    if (addBtn) {
      log('info', 'Clicking Add payment: "' + addBtn.textContent.trim() + '"');
      addBtn.click();
      await sleep(800);
    }
  }

  // Wait for the card number field to appear in the modal
  const ccField = await new Promise(resolve => {
    const check = () => document.getElementById('cc-number');
    if (check()) return resolve(check());
    const obs = new MutationObserver(() => { const el = check(); if (el) { obs.disconnect(); resolve(el); } });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, 5000);
  });

  if (!ccField) { log('warning', 'Payment modal did not open'); return; }
  log('info', 'Payment modal open — filling card details...');

  // Fill card number (Sam's uses id="cc-number")
  const cardFmt = (cfg.cardNumber || '').replace(/\D/g, '');
  fillField(ccField, cardFmt);
  log('info', 'Card number filled');

  // Fill expiry — Sam's likely uses id="cc-exp" or similar
  const expField = document.getElementById('cc-exp') || document.querySelector('[autocomplete="cc-exp"], [id*="exp"], [id*="expir"]');
  if (expField) { fillField(expField, cfg.expiry); log('info', 'Expiry filled'); }

  // Fill CVV — Sam's uses id="cvv" or similar
  const cvvField = document.getElementById('cvv') || document.querySelector('[autocomplete="cc-csc"], [id*="cvv"], [id*="cvc"], [id*="security"]');
  if (cvvField) { fillField(cvvField, cfg.cvv); log('info', 'CVV filled'); }

  // Click Save card
  const saveBtn = await findBtn(['savecard', 'savepayment', 'save']);
  if (saveBtn) {
    log('info', 'Clicking Save card...');
    saveBtn.click();
    await sleep(1000);
    log('success', 'Payment saved');
  } else {
    log('warning', 'Save card button not found');
  }
}
