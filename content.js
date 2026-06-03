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
    log('info', '── Phase: ' + botPhase + ' | Page: ' + page + ' ──');

  // ── PHASE: SEARCH ──────────────────────────────────────────────
  if (botPhase === 'SEARCH') {
    setStatus('running', 'Looking for item...');
    const interval = parseInt(botConfig.refreshInterval || '2');

    if (isSams) {
      log('info', 'Checking shipping selection...');
      await selectShipping();
    }

    log('info', 'Looking for Add to Cart button...');
    const addBtn = isSams
      ? await waitForSamsBtn('[data-automation-id="atc"], [data-dca-event="addToCart"]', interval * 1000)
      : await findBtn(['addtocart', 'addtobag', 'addtobasket', 'atc', 'buynow', 'buyitnow', 'purchase'], interval * 1000);

    if (!addBtn) {
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
  else if (botPhase === 'ADDED' && isSams) {
    log('info', 'Item already added — waiting for View Cart button...');
    await waitForViewCart(botConfig, isSams);
  }

  // ── PHASE: CART ────────────────────────────────────────────────
  else if (botPhase === 'CART') {
    setStatus('running', 'Looking for checkout button...');
    log('info', 'On cart page — looking for checkout button...');
    const btn = isSams
      ? await waitForSamsBtn('[data-automation-id="checkout"]', 5000)
      : await findBtn(['checkout', 'checkoutbtn', 'proceedtocheckout', 'gotocheckout', 'paynow']);
    if (!btn) {
      log('error', 'Checkout button not found — is cart empty?');
      setStatus('error', 'Checkout button not found');
      await chrome.storage.local.set({ botRunning: false });
      return;
    }
    log('success', 'Found checkout button: "' + btn.textContent.trim().substring(0, 40) + '"');
    log('info', 'Clicking checkout...');
    await chrome.storage.local.set({ botPhase: 'CHECKOUT' });
    btn.click();
  }

  // ── PHASE: CHECKOUT ────────────────────────────────────────────
  else if (botPhase === 'CHECKOUT') {
    setStatus('running', 'Filling checkout form...');
    log('info', 'On checkout page — waiting for form fields...');
    await new Promise(resolve => {
      const check = () => document.querySelector('#email, input[type="email"], input[name*="email"], input[type="text"]');
      if (check()) return resolve();
      const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); resolve(); } });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
    });
    log('info', 'Form ready — filling fields...');
    const cfg = botConfig;

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
    if (filled.length === 0) log('warning', 'No fields matched — checkout form may use different field IDs');

    // Sam's Club — handle payment modal (click Add, fill card, save)
    if (isSams) {
      const done = await fillSamsPayment(cfg);
      if (!done) return; // Not ready to place order yet
    }

    log('info', 'Looking for Place Order button...');
    setStatus('running', 'Submitting order...');
    const submitBtn = isSams
      ? await waitForSamsBtn('[data-automation-id="place-order-button"], [data-testid="place-order-button"]', 5000)
      : await findBtn(['place', 'order', 'pay', 'confirm', 'submit', 'buy']);
    if (!submitBtn) { log('error', 'Place Order button not found!'); return; }
    log('success', 'Found Place Order: "' + submitBtn.textContent.trim().substring(0, 40) + '"');
    log('info', 'Clicking Place Order...');
    await chrome.storage.local.set({ botPhase: 'CONFIRM' });
    submitBtn.click();
  }

  // ── PHASE: CONFIRM ─────────────────────────────────────────────
  else if (botPhase === 'CONFIRM') {
    log('info', 'On confirmation page — reading order ID...');
    if (isSams) {
      // Sam's Club confirmation — look for order number in page text or URL
      const confirmEl = await new Promise(resolve => {
        const check = () =>
          document.querySelector('[class*="order-number"], [class*="orderNumber"], [data-testid*="order"]') ||
          [...document.querySelectorAll('h1,h2,h3,p,span')].find(el =>
            /order\s*(number|#|confirmed|placed)/i.test(el.textContent)
          );
        const found = check(); if (found) return resolve(found);
        const obs = new MutationObserver(() => { const el = check(); if (el) { obs.disconnect(); resolve(el); } });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(null); }, 8000);
      });
      const orderId = confirmEl?.textContent?.trim() || 'confirmed';
      log('success', '🎉 Order placed! ' + orderId.substring(0, 60));
      setStatus('done', 'Order complete!');
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
