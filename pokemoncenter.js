// ── Pokémon Center adapter (SCAFFOLD — selectors need tuning with real HTML) ─────
window.__STORES = window.__STORES || {};
window.__STORES.pokemoncenter = {
  key: 'pokemoncenter',
  name: 'Pokémon Center',
  // Pokémon Center product pages look like /product/<id>/<slug>
  searchUrl: (q)  => 'https://www.pokemoncenter.com/search/' + encodeURIComponent(q),
  itemUrl:   (id) => 'https://www.pokemoncenter.com/product/' + encodeURIComponent(id),

  sel: {
    // Confirmed from live page (class hashes like --PZmQF can change, so match the prefix)
    addToCart:  'button[class*="add-to-cart-button"]',
    viewCart:   'a[aria-label="My cart"], a.header-cart, a[href="/cart"]',
    productLink:'a[href*="/product/"]',
    // Cart-page quantity input (number field) — most items are 1-limit so usually unchanged
    qtyInput:   'input[aria-label="Product Quantity"], input[class*="order-item-qty-input"]',
    // Confirmed: cart "Continue Checkout" button
    checkout:   '#checkout, [data-ge-checkout-button="true"]',

    // Payment screen (CyberSource secure iframes for card# / cvv — filled via CDP)
    paymentSelect: '#billing-selector',          // <select>: pick "credit-card"
    cardIframe:    '#card-number-container iframe',
    cvvIframe:     '#security-code-container iframe',
    expMonth:      '#expiryMonth',               // <select> MM
    expYear:       '#expiryYear',                // <select> full year (2026…)
    continueBtn:   'button[value="CONTINUE"]',   // advances to the next checkout step
    // TODO: the final Place Order button on the review step
    placeOrder: 'button[value="PLACE ORDER" i], button[type="button"][value*="place order" i]',
    qtyInc:     'button[aria-label*="increase" i], [data-testid="quantity-increment"]',
  },

  detectPhase: (url) => {
    url = url.toLowerCase();
    if (/order-confirmation|thank|receipt/.test(url)) return 'CONFIRM';
    if (/checkout/.test(url))                         return 'CHECKOUT';
    if (/\/cart\b/.test(url))                         return 'CART';
    if (/\/search\//.test(url))                       return 'RESULTS';
    if (/\/product\//.test(url))                      return 'SEARCH';
    return null;
  },
};
