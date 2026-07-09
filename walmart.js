// ── Walmart adapter ──────────────────────────────────────────────────────────────
// Walmart drops are QUEUE-gated. Observed flow (captured via the click tracker):
//   1. Discord link → walmart.com/ip/<id>
//   2. Walmart queues you: walmart.com/qp?qpdata={"queued":true,"queue":"..."} — this holds your
//      spot, then redirects to walmart.com/
//   3. A persistent "You're in line for N items" widget appears; opening it shows your position
//   4. You wait on the position view until it's your turn, then add-to-cart → checkout → place order
// The generic queue-wait (detectQueue) already covers steps 2–3 (waits, never reloads = keeps spot).
// Walmart's interactive buttons carry data-dca-* attributes (data-dca-event / data-dca-aid), so
// selectors prefer those alongside data-automation-id / data-testid.
window.__STORES = window.__STORES || {};
window.__STORES.walmart = {
  key: 'walmart',
  name: 'Walmart',
  // Walmart is a heavy React + bot-detection site that ignores synthetic DOM clicks on its action
  // buttons — use TRUSTED (CDP) clicks like Target, or add-to-cart / checkout silently do nothing.
  trustedClick: true,
  // Walmart item pages look like /ip/<slug>/<id> (or /ip/<id>)
  searchUrl: (q)  => 'https://www.walmart.com/search?q=' + encodeURIComponent(q),
  itemUrl:   (id) => 'https://www.walmart.com/ip/' + encodeURIComponent(id),

  sel: {
    // Buy flow — data-dca-* first (Walmart's own attributes), then data-automation-id/testid, then text.
    addToCart:  '[data-automation-id="atc"], [data-testid="add-to-cart"], button[data-dca-event*="addToCart" i], button[aria-label*="add to cart" i]',
    productLink:'a[href*="/ip/"]',
    viewCart:   'a[href*="/cart"], [data-automation-id="cart"], [aria-label*="cart" i]',
    checkout:   '[data-automation-id="checkout"], [data-testid="checkout"], button[data-dca-event*="checkout" i], a[href*="/checkout"]',
    placeOrder: '[data-automation-id="place-order"], [data-testid="place-order-button"], button[data-dca-event*="placeOrder" i], button[aria-label*="place order" i]',
    cvv:        '#cvv, input[name="cvv"], [data-automation-id="cvv"]',
    qtyInc:     'button[aria-label*="increase" i], [data-automation-id="incrementButton"]',
  },

  detectPhase: (url) => {
    url = url.toLowerCase();
    if (/thankyou|order-confirmation|order-summary/.test(url)) return 'CONFIRM';
    if (/checkout/.test(url))                                  return 'CHECKOUT';
    if (/\/cart\b/.test(url))                                  return 'CART';
    if (/\/qp\b|qpdata=/.test(url))                            return null; // queue page → let detectQueue wait
    if (/\/search\b|\?q=/.test(url))                           return 'RESULTS';
    if (/\/ip\//.test(url))                                    return 'SEARCH';
    return null;
  },
};
