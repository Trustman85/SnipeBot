// ── Best Buy adapter (SCAFFOLD — selectors need tuning with real Best Buy HTML) ──
window.__STORES = window.__STORES || {};
window.__STORES.bestbuy = {
  key: 'bestbuy',
  name: 'Best Buy',
  // Best Buy item pages look like /site/<slug>/<sku>.p?skuId=<sku>
  searchUrl: (q)  => 'https://www.bestbuy.com/site/searchpage.jsp?st=' + encodeURIComponent(q),
  itemUrl:   (id) => 'https://www.bestbuy.com/site/x/x/' + encodeURIComponent(id) + '.p?skuId=' + encodeURIComponent(id),

  // TODO: confirm these against live Best Buy pages
  sel: {
    addToCart:  '.add-to-cart-button, button[data-button-state="ADD_TO_CART"]',
    productLink:'a.image-link, h4.sku-title a, a[href*="/site/"]',
    viewCart:   '.cart-link, a[href*="/cart"]',
    checkout:   '.checkout-buttons__checkout button, button[data-track="Checkout - Top"]',
    placeOrder: '.button--place-order button, button[data-track*="Place"]',
    cvv:        '#credit-card-cvv, #cvv, input[name="cvv"]',
    qtyInc:     'button[aria-label*="increase" i], .fulfillment-add-to-cart-button .stepper-up',
  },

  detectPhase: (url) => {
    url = url.toLowerCase();
    if (/order|thank|confirmation/.test(url) && !/orders\b/.test(url)) return 'CONFIRM';
    if (/checkout/.test(url))             return 'CHECKOUT';
    if (/\/cart\b/.test(url))             return 'CART';
    if (/searchpage|\?st=/.test(url))     return 'RESULTS';
    if (/\.p\b|skuid=/.test(url))         return 'SEARCH';
    return null;
  },
};
