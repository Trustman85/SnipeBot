// ── Target adapter (SCAFFOLD — selectors need tuning with real Target HTML) ──────
window.__STORES = window.__STORES || {};
window.__STORES.target = {
  key: 'target',
  name: 'Target',
  // Target gates Buy now / Place your order on TRUSTED clicks — a scripted .click() is ignored,
  // so the bot clicks these via CDP (real browser-level mouse event) instead.
  trustedClick: true,
  // Set preferAddToCart: true to FORCE the Add to cart → cart → checkout route (skips Buy now).
  // Left off so the bot prefers Buy now and only falls back to Add to cart when there's no Buy now.
  // By Name search + direct item URL (Target item pages look like /p/-/A-<TCIN>)
  searchUrl: (q)  => 'https://www.target.com/s?searchTerm=' + encodeURIComponent(q),
  itemUrl:   (id) => 'https://www.target.com/p/-/A-' + encodeURIComponent(id),

  sel: {
    // Product-page quantity DROPDOWN (1–10). Class hash changes, so match the module prefix; also
    // match common data-test/id/aria/name variants in case this item's dropdown differs.
    qtySelect:  'select[class*="styles_select__"], select[data-test*="qty" i], select[data-test*="quantity" i], select[id*="quantity" i], select[aria-label*="uantity"], select[name*="quant" i]',
    // "Buy now" skips the cart and goes straight to checkout — fastest path for a drop.
    buyNow:     '[data-test="buy-now-button"]',
    // Add to cart / Preorder (Target uses data-test="orderPickupButton" or "preorderButton";
    // the id "addToCartButtonOrTextIdFor<TCIN>" is a stable pattern across both)
    addToCart:  '[data-test="addToCartButton"], button[data-test="orderPickupButton"], [data-test="preorderButton"], [data-test="shippingButton"], button[id^="addToCartButton"]',
    productLink:'a[href*="/p/"]',
    // "View cart & check out" link in the flyout after Add to cart / Preorder (href="/cart")
    viewCart:   '[data-test="errorContent-viewCartButton"], a[data-test*="viewCart" i], a[href="/cart"], [data-test="@web/CartLink"]',
    checkout:   '[data-test="checkout-button"], [data-test="content-checkout-button"]',
    placeOrder: '[data-test="placeOrderButton"]',
    cvv:        '#credit-card-cvv, input[name="cvv"], [data-test*="cvv"]',
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
