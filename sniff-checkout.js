// Checkout capture sniffer (document_start, MAIN world). Unlike sniff.js (which scans RESPONSES for
// stock text and is one-shot), this records the REQUESTS that mutate the cart/checkout — method, URL,
// request headers, request body, and a slice of the response — across the WHOLE manual checkout
// (PDP → cart → checkout → confirm). Stored in sessionStorage so it SURVIVES the page navigations;
// the document_start registration re-installs the hook on each page and appends to the same key.
// Passive: always calls through to the real fetch/XHR. Used to build direct-API checkout per store.
(function () {
  if (window.__botCoSniffOn) return;
  window.__botCoSniffOn = true;
  const KEY = '__botCheckoutSniff';
  // Only mutation-ish endpoints — skip the flood of analytics/beacon POSTs. GraphQL is included
  // because Target/Walmart run cart + order mutations through it.
  // Queue terms added 2026-08-19: Walmart drops are QUEUE-gated and the "Hold my spot and Keep
  // shopping" button fires a QUEUE call, not a cart one — without these the capture ignored the
  // single most important request in the whole Walmart drop flow.
  const URLRX = /cart|checkout|order|\batc\b|add[_-]?to[_-]?cart|place[_-]?order|purchase|basket|fulfillment|graphql|payment|tender|braintree|billing|queue|qpdata|hold[_-]?spot|waitingroom|lineup|ticket/i;
  // Never record obvious telemetry even if the URL happens to match above.
  const SKIPRX = /analytics|beacon|metrics|telemetry|\/collect|doubleclick|googletag|newrelic|nr-data|sentry|quantummetric|criteo|forter|bluecore|tealium/i;
  // GraphQL needs OPERATION-level filtering, not URL-level. Walmart runs its ENTIRE site through
  // one endpoint (/swag/graphql) — ads, search, tempo content, AND cart/checkout — so the `graphql`
  // term in URLRX matches everything and the ad flood buries the calls we actually want (capture
  // 2026-08-19 returned exactly one hit: AdV3DisplayDSP, a home-page display ad). Drop the obvious
  // non-commerce operations by NAME. Deliberately a DENYLIST, not an allowlist: this tool exists to
  // discover unknown calls, so anything unrecognised is still recorded.
  // NB: no bare "ad[A-Z]" here — with the /i flag [A-Z] also matches lowercase, which turned it
  // into /^ad./ and DROPPED AddToCartMutation, the one call this tool exists to find.
  const OP_SKIPRX = /^(adv\d|ad[sv]?display|displayad|sponsored|banner|carousel|tempo|seo|review|recommend|analytics|beacon|telemetry|typeahead|autocomplete|feedback|survey|notification|storelocator|storefinder)/i;
  // Pull the GraphQL operation name from the headers Walmart/Target set, else from the body.
  const opName = (headers, body) => {
    try {
      const h = headers || {};
      for (const k of Object.keys(h)) {
        if (/^x-apollo-operation-name$/i.test(k)) return String(h[k]);
        if (/^x-o-gql-query$/i.test(k)) return String(h[k]).replace(/^\s*(query|mutation)\s+/i, '').split('(')[0].trim();
      }
      const b = String(body || '');
      const m = b.match(/"operationName"\s*:\s*"([^"]+)"/) || b.match(/"query"\s*:\s*"\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/);
      if (m) return m[1];
    } catch (_) {}
    return '';
  };

  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (_) { return []; } };
  const save = (arr) => { try { sessionStorage.setItem(KEY, JSON.stringify(arr.slice(-60))); } catch (_) {} };
  const record = (entry) => {
    // GraphQL gate lives HERE so both the fetch and XHR paths are covered by construction.
    // Walmart runs its whole site through one /swag/graphql endpoint, so URL matching alone
    // records the ad flood and buries the real calls — filter by OPERATION NAME instead.
    try {
      if (/graphql/i.test(entry.url || '')) {
        const op = opName(entry.reqHeaders, entry.reqBody);
        if (op) {
          entry.op = op;                                  // label it so the dump is readable
          if (OP_SKIPRX.test(op)) return;                 // ads / content / search → drop
        }
      }
    } catch (_) {}
    const arr = load(); arr.push(entry); save(arr);
  };

  const wantUrl = (u) => { u = String(u || ''); return URLRX.test(u) && !SKIPRX.test(u); };
  const clip = (s, n) => { try { return String(s == null ? '' : s).slice(0, n); } catch (_) { return ''; } };
  const hdrObj = (h) => {
    const o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === 'function') h.forEach((v, k) => { o[k] = v; });      // Headers instance
      else if (Array.isArray(h)) for (const [k, v] of h) o[k] = v;
      else for (const k in h) o[k] = h[k];
    } catch (_) {}
    return o;
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      // input can be a URL string OR a Request object (Target builds Request objects and puts the
      // body INSIDE them — invisible via init.body). Detect that and clone to read the body.
      const isReq = input && typeof input === 'object' && typeof input.clone === 'function' && input.url;
      const url = isReq ? input.url : input;
      const method = ((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
      const p = origFetch.apply(this, arguments);
      try {
        if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && wantUrl(url)) {
          const reqHeaders = hdrObj((init && init.headers) || (isReq && input.headers));
          // Body source: explicit init.body, else clone the Request and read its stream.
          let bodyP;
          if (init && init.body != null) bodyP = Promise.resolve(clip(init.body, 4000));
          else if (isReq) { try { bodyP = input.clone().text().then((t) => clip(t, 4000)).catch(() => ''); } catch (_) { bodyP = Promise.resolve(''); } }
          else bodyP = Promise.resolve('');
          const respP = p.then((res) => res.clone().text().then((t) => ({ status: res.status, resp: clip(t, 1500) })).catch(() => ({ status: res.status, resp: '' }))).catch(() => ({ status: 0, resp: '' }));
          Promise.all([bodyP, respP]).then(([reqBody, r]) => {
            record({ via: 'fetch', method, url: clip(url, 400), reqHeaders, reqBody, status: r.status, respSample: r.resp, at: Date.now() });
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  }

  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send,
        oSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__coM = (m || 'GET').toUpperCase(); this.__coU = u; this.__coH = {}; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__coH[k] = v; } catch (_) {} return oSet.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if ((this.__coM === 'POST' || this.__coM === 'PUT' || this.__coM === 'PATCH') && wantUrl(this.__coU)) {
        const reqBody = clip(body, 4000), reqHeaders = this.__coH || {}, url = this.__coU, method = this.__coM;
        this.addEventListener('load', function () {
          record({ via: 'xhr', method, url: clip(url, 400), reqHeaders, reqBody,
                   status: this.status, respSample: clip(this.responseText, 1500), at: Date.now() });
        });
      }
    } catch (_) {}
    return oSend.apply(this, arguments);
  };
})();
