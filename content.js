// Runs on every localhost:3000 page load — checks current phase and acts accordingly
(async () => {
  // Guard against the script running twice on the same page
  if (window.__checkoutBotInit) return;
  window.__checkoutBotInit = true;

  // Read bot state from storage
  const { botRunning, botPhase, botConfig } = await chrome.storage.local.get(['botRunning', 'botPhase', 'botConfig']);
  if (!botRunning || !botConfig) return;

  const page = window.location.pathname;
  log('info', 'Page: ' + page + ' | Phase: ' + botPhase);

  // ── PHASE: SEARCH ──────────────────────────────────────────────
  // Wait for the stock element, check availability and price, then add to cart
  if (botPhase === 'SEARCH') {
    setStatus('running', 'Checking product page...');
    const stockEl = await waitFor('stock-status');
    const isOOS   = stockEl.classList.contains('out-stock');
    const price   = parseFloat(document.querySelector('.price')?.textContent?.replace('$', '') || '0');

    // Item is out of stock — wait the configured interval then reload to re-check
    if (isOOS) {
      const interval = parseInt(botConfig.refreshInterval || '2');
      log('warning', 'Out of stock. Refreshing in ' + interval + 's...');
      setStatus('running', 'Out of stock – refreshing in ' + interval + 's');
      await sleep(interval * 1000);
      location.reload();
      return;
    }

    // Price exceeds the configured max — stop the bot
    if (price > parseFloat(botConfig.maxPrice || '999')) {
      log('warning', 'Price $' + price + ' exceeds max $' + botConfig.maxPrice);
      setStatus('error', 'Price too high – bot stopped');
      await chrome.storage.local.set({ botRunning: false });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' });
      return;
    }

    // In stock and within price — find and click the add-to-cart button
    const addBtn = await findBtn(['add to cart', 'add-to-cart', 'buy now', 'buy']);
    if (!addBtn) { log('error', 'Add to cart button not found.'); return; }
    log('success', 'In stock at $' + price + '! Adding to cart...');
    setStatus('running', 'Adding to cart...');
    await chrome.storage.local.set({ botPhase: 'CART' });
    addBtn.click();
  }

  // ── PHASE: CART ────────────────────────────────────────────────
  // Wait for the checkout button to be enabled (cart API must finish loading first)
  else if (botPhase === 'CART') {
    setStatus('running', 'Cart page – proceeding to checkout...');
    log('info', 'Cart reached. Clicking checkout...');
    const btn = await findBtn(['checkout', 'proceed', 'continue', 'next']);
    if (!btn) {
      log('error', 'Checkout button not available.');
      setStatus('error', 'Cart empty');
      await chrome.storage.local.set({ botRunning: false });
      return;
    }
    await chrome.storage.local.set({ botPhase: 'CHECKOUT' });
    log('success', 'Clicking: "' + btn.textContent.trim() + '"');
    btn.click();
  }

  // ── PHASE: CHECKOUT ────────────────────────────────────────────
  // Wait for the form, fill all fields, then submit the order
  else if (botPhase === 'CHECKOUT') {
    setStatus('running', 'Filling checkout form...');
    log('info', 'Checkout reached. Filling details...');
    await waitFor('email'); // Wait for the form to be in the DOM
    const cfg = botConfig;

    // Fill a text input and fire all events so framework validation picks up the change
    function fill(id, val) {
      const el = document.getElementById(id);
      if (!el || !val) return;
      el.focus();
      // Native setter bypasses React/Vue value tracking
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
    }

    // Set a <select> value and fire change event
    function sel(id, val) {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Fill shipping info
    fill('email',     cfg.email);
    fill('firstName', cfg.firstName);
    fill('lastName',  cfg.lastName);
    fill('address',   cfg.address);
    fill('city',      cfg.city);
    sel('state',      (cfg.state || '').toUpperCase());
    fill('zip',       cfg.zip);

    // Fill payment info — format card number as groups of 4
    const cardFmt = (cfg.cardNumber || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
    fill('cardNumber', cardFmt);
    fill('cardName',   cfg.cardName || (cfg.firstName + ' ' + cfg.lastName));
    fill('expiry',     cfg.expiry);
    fill('cvv',        cfg.cvv);

    log('success', 'All fields filled. Submitting...');
    setStatus('running', 'Submitting order...');

    // Find and click the place order button
    const submitBtn = await findBtn(['place order', 'submit order', 'pay now', 'complete order', 'buy now', 'order now', 'place my order']);
    if (!submitBtn) { log('error', 'Submit button not found!'); return; }
    log('success', 'Clicking: "' + submitBtn.textContent.trim() + '"');
    await chrome.storage.local.set({ botPhase: 'CONFIRM' });
    submitBtn.click();
  }

  // ── PHASE: CONFIRM ─────────────────────────────────────────────
  // Read the order ID from the confirmation page and optionally stop the bot
  else if (botPhase === 'CONFIRM') {
    const orderEl = await waitFor('orderId');
    const orderId = orderEl.textContent;
    log('success', 'Order placed! ID: ' + orderId);
    setStatus('done', 'Order complete! ID: ' + orderId);
    if (botConfig.stopOnSuccess) {
      await chrome.storage.local.set({ botRunning: false, botPhase: 'IDLE' });
      chrome.runtime.sendMessage({ type: 'BOT_DONE' });
      log('info', 'Bot stopped (stop-on-success)');
    }
  }
})();

// Finds the first enabled button whose text matches any of the given keywords.
// Uses MutationObserver so it reacts instantly when a button appears or becomes enabled.
function findBtn(keywords, timeout = 5000) {
  return new Promise((resolve) => {
    const find = () => {
      for (const el of document.querySelectorAll('button:not([disabled]), input[type="submit"]:not([disabled])')) {
        const text = (el.textContent || el.value || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
        if (keywords.some(k => text.includes(k))) return el;
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

// Waits for an element with the given ID to appear in the DOM
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

// Pauses execution for the given number of milliseconds
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Sends a log entry to the popup activity log
function log(level, text) {
  console.log('[CheckoutBot][' + level + '] ' + text);
  chrome.runtime.sendMessage({ type: 'BOT_LOG', level, text }).catch(() => {});
}

// Sends a status update to the popup status bar
function setStatus(state, text) {
  chrome.runtime.sendMessage({ type: 'BOT_STATUS', status: state, text }).catch(() => {});
}
