// ─────────────────────────────────────────────────────────────────────────────
// Multi-store registry. Each store file (target.js, walmart.js, bestbuy.js,
// pokemoncenter.js) registers a config object here. content.js looks up the active
// store by profile key and drives a generic flow from that config.
//
// Sam's keeps its own dedicated, fully-tuned logic in sams.js + content.js.
// The configs below are SCAFFOLDS — selectors must be tuned with each site's real
// HTML before checkout will actually complete (same process Sam's went through).
// ─────────────────────────────────────────────────────────────────────────────
window.__STORES = window.__STORES || {};

// Generic helpers shared by store adapters ------------------------------------
window.__storeFirstMatch = function (selectors) {
  for (const sel of selectors.split(',').map(s => s.trim()).filter(Boolean)) {
    const el = document.querySelector(sel);
    if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') return el;
  }
  return null;
};
