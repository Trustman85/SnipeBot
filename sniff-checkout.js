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
  // because Target/Walmart run cart + order mutations through it. Auth/login patterns included so
  // the sign-in request is captured too (for building API auto-login).
  const URLRX = /cart|checkout|order|\batc\b|add[_-]?to[_-]?cart|place[_-]?order|purchase|basket|fulfillment|graphql|payment|tender|braintree|billing|login|log[_-]?on|sign[_-]?in|signin|\bauth\b|oauth|\/token|session|identity|\bciam\b|accounts?\/|credential|authenticate|logon/i;
  // Never record obvious telemetry even if the URL happens to match above.
  const SKIPRX = /analytics|beacon|metrics|telemetry|\/collect|doubleclick|googletag|newrelic|nr-data|sentry|quantummetric|criteo|forter|bluecore|tealium/i;

  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (_) { return []; } };
  const save = (arr) => { try { sessionStorage.setItem(KEY, JSON.stringify(arr.slice(-60))); } catch (_) {} };
  const record = (entry) => { const arr = load(); arr.push(entry); save(arr); };

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
