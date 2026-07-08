// One-shot network sniffer (runs at document_start in the page's MAIN world) — wraps fetch + XHR and
// records any response whose body looks stock/availability-related, into sessionStorage. Used by the
// panel's "⚡ API" button to auto-discover a store's stock endpoint. Passive: always calls through to
// the real fetch/XHR, so it can't break the page. Removed again as soon as the capture is read.
(function () {
  if (window.__botStockSniffOn) return;
  window.__botStockSniffOn = true;
  const KEY = '__botStockSniff';
  const hits = [];
  const RX = /availab|out[_\s-]?of[_\s-]?stock|in[_\s-]?stock|sold\s*out|inventory|sellable|stock_?level|onlineinventory|isavailable|purchase_?limit|quantity/i;
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(hits.slice(-30))); } catch (_) {} };
  const scan = (url, text) => {
    if (!text || typeof text !== 'string' || text.length > 800000) return;
    if (RX.test(text)) { hits.push({ url: String(url || '').slice(0, 300), sample: text.slice(0, 500) }); save(); }
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const u = (args[0] && args[0].url) || args[0];
      return origFetch.apply(this, args).then((res) => {
        try { res.clone().text().then((t) => scan(u, t)).catch(() => {}); } catch (_) {}
        return res;
      });
    };
  }

  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__botUrl = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () { try { scan(this.__botUrl, this.responseText); } catch (_) {} });
    return oSend.apply(this, arguments);
  };
})();
