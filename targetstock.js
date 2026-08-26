// Target stock-request capturer (document_start, MAIN world, target.com only).
//
// WHY: Target's legacy redsky `product_fulfillment_v1` endpoint LAGS a real drop and 403s in bursts
// — and the real site no longer uses it. The PDP now gets its stock from a POST to
//   www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules?...&tcin=<tcin>
// whose body carries a base64 `page_context` blob that is page/build/session specific — we can't
// synthesize it. But we don't have to: the page itself fires that exact request on load, so we hook
// fetch, remember the ONE request whose response carried the fulfillment module, and the bot replays
// it verbatim to poll stock. Same origin, same headers, same shape as a real page request.
//
// Stores { url, body, tcin, at } on window.__botTgtStockReq for background.js's targetStockPoll to
// read via an executeScript in this same MAIN world. Passive — always calls the real fetch through.
//
// SCOPE: stock only. An earlier version of this file also scraped Target's auth calls for the
// login flow; that came out with the auto-login revert and is deliberately NOT here.
(function () {
  if (window.__botTgtStockHook) return;
  window.__botTgtStockHook = true;
  const RX = /cdui_orchestrations\/v1\/pages\/pdp\/deferred_enrichment\/modules/;
  const origFetch = window.fetch;
  if (!origFetch) return;
  window.fetch = function (input, init) {
    // Target builds Request objects and puts the body inside them, so detect that and clone to read.
    const isReq = input && typeof input === 'object' && typeof input.clone === 'function' && input.url;
    const url = String((isReq ? input.url : input) || '');
    const p = origFetch.apply(this, arguments);
    try {
      if (RX.test(url)) {
        let bodyP;
        if (init && init.body != null) bodyP = Promise.resolve(String(init.body));
        else if (isReq) { try { bodyP = input.clone().text().catch(() => ''); } catch (_) { bodyP = Promise.resolve(''); } }
        else bodyP = Promise.resolve('');
        // Only keep the request that actually RETURNED fulfillment data — the PDP fires several of
        // these, one per module group, and only one carries shipping_options/availability_status.
        p.then((res) => res.clone().text().then((t) => {
          // ONLY the fulfillment module. "shipping_options" also appears inside the
          // GlobalRecommendedProducts carousel (other products), so accepting it captured a
          // RECOMMENDATIONS request and replaying it never returned our item's stock — which drove an
          // endless "no availability field → reload" loop (2026-07-26).
          if (!/ProductDetailWebDatasourceFulfillmentAndVariations/.test(t)) return;
          bodyP.then((b) => {
            if (!b) return;
            const tcin = (url.match(/[?&]tcin=(\d+)/) || [])[1] || null;
            const rec = { url, body: b, tcin, at: Date.now() };
            window.__botTgtStockReq = rec;
            // Persist it: these requests fire only during a page LOAD, so without this a reload (or
            // starting the bot on an already-loaded page) would have nothing to replay.
            try { sessionStorage.setItem('__botTgtStockReq', JSON.stringify(rec)); } catch (_) {}
          }).catch(() => {});
        }).catch(() => {})).catch(() => {});
      }
    } catch (_) {}
    return p;
  };
})();
