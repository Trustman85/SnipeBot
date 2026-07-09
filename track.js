// Interaction tracker (runs in the ISOLATED content-script world so it can message the panel). When
// the panel's "👁 Track" toggle is ON, this is registered on the domain and logs a compact descriptor
// of everything you do to an element — not just clicks, but PRESS-AND-HOLD (with hold time) and DRAGS
// (with distance + direction) — so a real checkout's steps/selectors AND its human-gesture challenges
// (press-and-hold buttons, drag-to-confirm sliders, hCaptcha, etc.) can be captured to tune a store.
// Passive: it only reads + logs, never blocks or alters an event.
(function () {
  if (window.__botClickTrackOn) return;
  window.__botClickTrackOn = true;

  var HOLD_MS = 350;   // press longer than this (without moving) = a "hold"
  var DRAG_PX = 8;     // pointer moved more than this between down and up = a "drag"

  function attr(el, name) { try { return el.getAttribute(name); } catch (_) { return null; } }

  // Walk up to the nearest meaningful interactive element (a / button / role=button / data-* / img).
  function meaningful(el) {
    for (var i = 0; i < 6 && el && el !== document.body; i++) {
      if (/^(a|button|img|input|label|svg)$/i.test(el.tagName) ||
          attr(el, 'role') === 'button' || attr(el, 'data-test') ||
          attr(el, 'data-automation-id') || attr(el, 'data-dca-event') ||
          attr(el, 'draggable') === 'true') return el;
      el = el.parentElement;
    }
    return el;
  }

  // Emit one tracked interaction to the panel. `kind` = CLICK | HOLD | DRAG.
  function emit(kind, el, extra) {
    el = meaningful(el) || el;
    if (!el || !el.tagName) return;
    var text = ((el.textContent || '') || (attr(el, 'aria-label') || attr(el, 'alt') || ''))
                 .trim().replace(/\s+/g, ' ').slice(0, 45);
    // The element CODE so it can be copy-pasted: the OPENING tag (all its attributes) — that's what's
    // needed to build a selector — plus a trimmed outerHTML for context.
    var openTag = '', html = '';
    try { openTag = el.cloneNode(false).outerHTML.replace(/><\/[a-z0-9-]+>$/i, '>'); }
    catch (_) { openTag = (el.tagName || '?').toLowerCase(); }
    try { html = (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 500); } catch (_) {}
    try {
      chrome.runtime.sendMessage({
        type: 'TRACK', kind: kind, extra: extra || '',
        tag: openTag.slice(0, 400), html: html, text: text, path: location.pathname
      });
    } catch (_) {}
  }

  // --- Pointer gesture tracking: down → (move) → up, so we can tell click vs hold vs drag ---
  var down = null;  // { x, y, t, el }

  window.addEventListener('pointerdown', function (e) {
    down = { x: e.clientX, y: e.clientY, t: Date.now(), el: e.target };
    // Emit the element CODE immediately on PRESS. A click that NAVIGATES (e.g. Walmart's "Hold my
    // spot and Keep shopping") unloads the page before pointerup's message can be delivered — so
    // capturing on down makes the code survive the navigation. pointerup below only ADDS a line if
    // the gesture turns out to be a hold or a drag (with its duration/distance).
    emit('CLICK', e.target, '');
  }, true);

  window.addEventListener('pointerup', function (e) {
    if (!down) return;
    var dx = e.clientX - down.x, dy = e.clientY - down.y;
    var dist = Math.round(Math.hypot(dx, dy));
    var held = Date.now() - down.t;
    var el = down.el || e.target;
    down = null;
    if (dist > DRAG_PX) {
      var dir = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? 'right' : 'left')
        : (dy > 0 ? 'down' : 'up');
      emit('DRAG', el, dist + 'px ' + dir + ' / ' + held + 'ms');
    } else if (held >= HOLD_MS) {
      emit('HOLD', el, held + 'ms');
    }
    // A plain quick click was already logged on pointerdown — don't double-log it here.
  }, true);

  // If the pointer leaves the window mid-press, don't leak the gesture into the next one.
  window.addEventListener('pointercancel', function () { down = null; }, true);

  // Native HTML5 drag (draggable="true" images / list items) — pointer events may not cover these.
  window.addEventListener('dragstart', function (e) { emit('DRAG', e.target, 'dragstart'); }, true);
  window.addEventListener('drop',      function (e) { emit('DRAG', e.target, 'drop'); }, true);

  // Fallback: keyboard-activated clicks (Enter/Space on a focused control) don't emit pointer events.
  window.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && /^(a|button)$/i.test(e.target.tagName)) {
      emit('CLICK', e.target, 'key:' + e.key.trim());
    }
  }, true);
})();
