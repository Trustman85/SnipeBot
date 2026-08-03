// Target stock-request capturer (document_start, MAIN world, target.com only).
//
// WHY: Target's legacy redsky `product_fulfillment_v1` endpoint is aggressively rate-limited and
// starts returning 403 after a burst — and the real site no longer uses it. The PDP now gets its
// stock from a POST to
//   www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules?...&tcin=<tcin>
// whose body carries a base64 `page_context` blob that is page/build/session specific — we can't
// synthesize it. But we don't have to: the page itself fires that exact request on load, so we hook
// fetch, remember the ONE request whose response carried the fulfillment module, and the bot replays
// it verbatim to poll stock. Same origin, same headers, same shape as a real page request.
//
// Stores { url, body, tcin, at } on window.__botTgtStockReq for background.js's targetStockPoll to
// read via an executeScript in this same MAIN world. Passive — always calls the real fetch through.
(function () {
  if (window.__botTgtStockHook) return;
  window.__botTgtStockHook = true;
  const RX = /cdui_orchestrations\/v1\/pages\/pdp\/deferred_enrichment\/modules/;
  // Target's auth calls carry x-application-mouse-tool-key, a behavioral key its own JS mints. We
  // can't compute one — but we CAN reuse the key the page itself just used, so an API login sends a
  // genuine value instead of omitting the header (which is refused).
  const AUTHRX = /gsp\.target\.com\/gsp\/(authentications|oauth_validations)/;
  const origFetch = window.fetch;
  if (!origFetch) return;
  window.fetch = function (input, init) {
    // Target builds Request objects and puts the body inside them, so detect that and clone to read.
    const isReq = input && typeof input === 'object' && typeof input.clone === 'function' && input.url;
    const url = String((isReq ? input.url : input) || '');
    const p = origFetch.apply(this, arguments);
    // Stash the mouse-tool key + the device_info body from the page's OWN auth calls, so the
    // extension's API login can send the same shape (capture 2026-07-25 showed credential_validations
    // needs {username, password, device_info{~50 fields}, keep_me_signed_in} — sending just
    // username+password is what made it 400/401).
    try {
      if (AUTHRX.test(url)) {
        const isReq2 = input && typeof input === 'object' && input.headers;
        const h = (init && init.headers) || (isReq2 && input.headers);
        let key = null;
        try {
          if (h && typeof h.get === 'function') key = h.get('x-application-mouse-tool-key');
          else if (h) for (const k in h) if (/mouse-tool-key/i.test(k)) key = h[k];
        } catch (_) {}
        if (key) { try { sessionStorage.setItem('__botTgtMouseKey', key); } catch (_) {} }
        if (/credential_validations/.test(url)) {
          let bp = null;
          if (init && init.body != null) bp = Promise.resolve(String(init.body));
          else if (input && typeof input.clone === 'function') { try { bp = input.clone().text().catch(() => ''); } catch (_) {} }
          if (bp) bp.then((b) => {
            try {
              const j = JSON.parse(b || '{}');
              if (j && j.device_info) sessionStorage.setItem('__botTgtDeviceInfo', JSON.stringify(j.device_info));
            } catch (_) {}
          }).catch(() => {});
        }
      }
    } catch (_) {}
    try {
      if (RX.test(url)) {
        let bodyP;
        if (init && init.body != null) bodyP = Promise.resolve(String(init.body));
        else if (isReq) { try { bodyP = input.clone().text().catch(() => ''); } catch (_) { bodyP = Promise.resolve(''); } }
        else bodyP = Promise.resolve('');
        // Only keep the request that actually RETURNED fulfillment data — the PDP fires several of
        // these, one per module group, and only one carries shipping_options/availability_status.
        p.then((res) => res.clone().text().then((t) => {
          if (!/FulfillmentAndVariations|shipping_options/.test(t)) return;
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
