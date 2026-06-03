// ─────────────────────────────────────────────────────────────────────────────
// Sam's Club specific bot logic.
//
// This file is injected into the page BEFORE content.js (see popup.js / background.js
// / manifest.json). Both files run in the same content-script isolated world, so the
// top-level functions declared here are accessible from content.js.
//
// content.js calls these only when the active profile is "sams".
// ─────────────────────────────────────────────────────────────────────────────

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
    await sleep(300);
  }
}

// Waits for View Cart button after adding to cart — reloads if not found
async function waitForViewCart(botConfig, isSams) {
  log('info', 'Waiting for View Cart button...');
  const viewCartBtn = await findBtn(['viewcart', 'viewbag', 'gotocart', 'viewmycart'], 8000);
  if (viewCartBtn) {
    log('success', 'Found View Cart: "' + viewCartBtn.textContent.trim().split('\n')[0].substring(0, 40) + '"');
    log('info', 'Clicking View Cart...');
    viewCartBtn.click();
    await chrome.storage.local.set({ botPhase: 'CART' });
  } else {
    log('warning', 'View Cart not found after 8s — reloading to retry...');
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

  // Check if there's already a saved card with a CVV field on the page
  const existingCvv = document.getElementById('cvv-field') ||
                      document.querySelector('[id*="cvv-field"], [name="cvv"][type="password"]');
  if (existingCvv) {
    // Content scripts can't see React's _valueTracker (it lives in the page's MAIN world),
    // so setting the value here doesn't update React's state and Sam's rejects it on submit.
    // Delegate to background.js, which injects into the MAIN world where React state is reachable.
    log('info', 'Filling CVV + Place Order via page (main world)...');
    chrome.runtime.sendMessage({ type: 'SAMS_CHECKOUT', cvv: String(cfg.cvv) });
    await chrome.storage.local.set({ botPhase: 'CONFIRM' });
    return false; // background handles the rest
  }

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
