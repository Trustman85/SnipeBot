// ── Walmart adapter (SCAFFOLD — selectors need tuning with real Walmart HTML) ────
window.__STORES = window.__STORES || {};
window.__STORES.walmart = {
  key: 'walmart',
  name: 'Walmart',
  // Walmart item pages look like /ip/<slug>/<id> (or /ip/<id>)
  searchUrl: (q)  => 'https://www.walmart.com/search?q=' + encodeURIComponent(q),
  itemUrl:   (id) => 'https://www.walmart.com/ip/' + encodeURIComponent(id),

  // TODO: confirm these against live Walmart pages
  sel: {
    addToCart:  '[data-automation-id="atc"], [data-testid="add-to-cart"], button[aria-label*="add to cart" i]',
    productLink:'a[href*="/ip/"]',
    viewCart:   'a[href*="/cart"], [data-automation-id="cart"]',
    checkout:   '[data-automation-id="checkout"], [data-testid="checkout"]',
    placeOrder: '[data-automation-id="place-order"], [data-testid="place-order-button"]',
    cvv:        '#cvv, input[name="cvv"], [data-automation-id="cvv"]',
    qtyInc:     'button[aria-label*="increase" i], [data-automation-id="incrementButton"]',
  },

  detectPhase: (url) => {
    url = url.toLowerCase();
    if (/thankyou|order-confirmation|order-summary/.test(url)) return 'CONFIRM';
    if (/checkout/.test(url))                                  return 'CHECKOUT';
    if (/\/cart\b/.test(url))                                  return 'CART';
    if (/\/search\b|\?q=/.test(url))                           return 'RESULTS';
    if (/\/ip\//.test(url))                                    return 'SEARCH';
    return null;
  },
};
