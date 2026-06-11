// ── Target adapter (SCAFFOLD — selectors need tuning with real Target HTML) ──────
window.__STORES = window.__STORES || {};
window.__STORES.target = {
  key: 'target',
  name: 'Target',
  // By Name search + direct item URL (Target item pages look like /p/-/A-<TCIN>)
  searchUrl: (q)  => 'https://www.target.com/s?searchTerm=' + encodeURIComponent(q),
  itemUrl:   (id) => 'https://www.target.com/p/-/A-' + encodeURIComponent(id),

  // TODO: confirm these against live Target pages
  sel: {
    addToCart:  '[data-test="shippingButton"], [data-test="addToCartButton"], [data-test="orderPickupButton"]',
    productLink:'a[href*="/p/"]',
    viewCart:   'a[href*="/cart"], [data-test="@web/CartLink"]',
    checkout:   '[data-test="checkout-button"], [data-test="content-checkout-button"]',
    placeOrder: '[data-test="placeOrderButton"]',
    cvv:        '#credit-card-cvv, input[name="cvv"], [data-test*="cvv"]',
    qtyInc:     '[data-test="stepUp"], button[aria-label*="increase" i]',
  },

  // Which checkout step the current URL represents
  detectPhase: (url) => {
    url = url.toLowerCase();
    if (/order-confirmation|thank|order-summary/.test(url)) return 'CONFIRM';
    if (/checkout/.test(url))                                return 'CHECKOUT';
    if (/\/cart\b/.test(url))                                return 'CART';
    if (/\/s\?|searchterm=/.test(url))                       return 'RESULTS';
    if (/\/p\/|\/A-/.test(url))                              return 'SEARCH';
    return null;
  },
};
