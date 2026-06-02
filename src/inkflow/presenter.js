// ── Injected by server ──
const INITIAL_SLIDES = __SLIDES_JSON__;
const INITIAL_TRANSITIONS = __TRANSITIONS_JSON__;
const WS_PORT = __WS_PORT__;
const INITIAL_ERROR = __ERROR_JSON__;

// ── State ──
let slides = INITIAL_SLIDES;
let transitions = INITIAL_TRANSITIONS;
let slideIndex = 0;
let step = 0;
let _maxStepCache = null;
let gotoMode = false;
let gotoBuffer = '';

// ── DOM refs ──
const stage        = document.getElementById('stage');
const slideInfo    = document.getElementById('slide-info');
const stepInfo     = document.getElementById('step-info');
const wsDot        = document.getElementById('ws-dot');
const curtain      = document.getElementById('curtain');
const help         = document.getElementById('help');
const errorOverlay = document.getElementById('error-overlay');
const errorMsg     = document.getElementById('error-msg');

// ── Helpers ──
function maxStep() {
  if (_maxStepCache !== null) return _maxStepCache;
  let m = 0;
  stage.querySelectorAll('[data-step]').forEach(el => {
    const s = +el.getAttribute('data-step');
    if (s > m) m = s;
  });
  return (_maxStepCache = m);
}

function syncURL() {
  const search = step > 0 ? `?clicks=${step}` : '';
  try {
    history.replaceState(null, '', `/${slideIndex + 1}${search}`);
  } catch (_) {}
}

function readURL() {
  const seg = window.location.pathname.replace(/^\//, '');
  const n = parseInt(seg, 10);
  if (!isNaN(n) && n >= 1 && n <= slides.length) slideIndex = n - 1;
  const clicks = parseInt(new URLSearchParams(window.location.search).get('clicks') ?? '0', 10);
  if (!isNaN(clicks) && clicks >= 0) step = clicks;
}

function updateStatus() {
  slideInfo.textContent = gotoMode
    ? `g: ${gotoBuffer}_`
    : `${slideIndex + 1} / ${slides.length}`;
  stepInfo.textContent = `step ${step}`;
  syncURL();
}

// Toggle .active on already-loaded SVG elements — triggers CSS transitions.
// Never touches innerHTML, so transitions fire correctly.
function applyStep() {
  stage.querySelectorAll('[data-step]').forEach(el =>
    el.classList.toggle('active', +el.getAttribute('data-step') <= step)
  );
  updateStatus();
}

// ── Morph transition ──
// Drives matched IDs via a rAF loop that sets SVG geometry attributes directly in
// SVG user units — no CSS px ↔ SVG unit conversion, no coordinate space ambiguity.
// Unmatched new elements fade in; unmatched old elements disappear immediately.

function _geomAttrs(el) {
  const g = k => parseFloat(el.getAttribute(k) ?? '0');
  switch (el.tagName.toLowerCase()) {
    case 'rect':    return { x: g('x'), y: g('y'), width: g('width'), height: g('height'), rx: g('rx') };
    case 'circle':  return { cx: g('cx'), cy: g('cy'), r: g('r') };
    case 'ellipse': return { cx: g('cx'), cy: g('cy'), rx: g('rx'), ry: g('ry') };
    default:        return null;
  }
}

function _parseHexColor(s) {
  const h = (s ?? '').replace('#', '');
  if (h.length === 3) return h.split('').map(c => parseInt(c + c, 16));
  if (h.length === 6) return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return null;
}

function _lerpColor(a, b, t) {
  const ca = _parseHexColor(a), cb = _parseHexColor(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  return '#' + ca.map((c, i) => Math.round(c + (cb[i] - c) * t).toString(16).padStart(2, '0')).join('');
}

function _ease(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; }

function morphSlide(duration, then) {
  const ms = duration * 1000;

  // 1. Snapshot old elements in SVG user units before swap
  const fromMap = new Map();
  stage.querySelectorAll('[id]').forEach(el =>
    fromMap.set(el.id, {
      tag:    el.tagName.toLowerCase(),
      geom:   _geomAttrs(el),
      fill:   el.getAttribute('fill'),
      stroke: el.getAttribute('stroke'),
    })
  );

  // 2. Swap to new slide
  stage.innerHTML = slides[slideIndex];
  _maxStepCache = null;
  const newSvg = stage.querySelector('svg');
  if (!newSvg) { updateStatus(); if (then) then(); return; }
  updateStatus();

  // 3. Build task list; snap morph elements to old positions before first paint
  const tasks = [];
  const seenIds = new Set();
  newSvg.querySelectorAll('[id]').forEach(el => {
    seenIds.add(el.id);
    const from   = fromMap.get(el.id);
    const toGeom = _geomAttrs(el);
    if (from && from.geom && toGeom && from.tag === el.tagName.toLowerCase()) {
      // Capture target color before overwriting with old values
      const toFill   = el.getAttribute('fill');
      const toStroke = el.getAttribute('stroke');
      // Snap to old geometry so first paint shows old position
      for (const [k, v] of Object.entries(from.geom)) el.setAttribute(k, v);
      if (from.fill)   el.setAttribute('fill',   from.fill);
      if (from.stroke) el.setAttribute('stroke', from.stroke);
      tasks.push({ type: 'morph', el, from, toGeom, toFill, toStroke });
    } else if (!from) {
      // New element — fade in
      el.style.opacity = '0';
      tasks.push({ type: 'fade', el, toOpacity: parseFloat(el.getAttribute('opacity') ?? '1') });
    }
    // matched but unmorphable (text, group, path) → instant cut, leave as-is
  });

  // Exit elements: had geometry on old slide, absent from new — ghost them in and fade out
  for (const [id, from] of fromMap) {
    if (seenIds.has(id) || !from.geom) continue;
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', from.tag);
    for (const [k, v] of Object.entries(from.geom)) ghost.setAttribute(k, v);
    if (from.fill)   ghost.setAttribute('fill',   from.fill);
    if (from.stroke) ghost.setAttribute('stroke', from.stroke);
    newSvg.appendChild(ghost);
    tasks.push({ type: 'exit', el: ghost });
  }

  // 4. Drive animation via requestAnimationFrame
  const t0 = performance.now();
  function frame(now) {
    const raw = Math.min((now - t0) / ms, 1);
    const e   = _ease(raw);
    for (const task of tasks) {
      if (task.type === 'morph') {
        for (const k of Object.keys(task.toGeom))
          task.el.setAttribute(k, task.from.geom[k] + (task.toGeom[k] - task.from.geom[k]) * e);
        if (task.from.fill   && task.toFill)   task.el.setAttribute('fill',   _lerpColor(task.from.fill,   task.toFill,   e));
        if (task.from.stroke && task.toStroke) task.el.setAttribute('stroke', _lerpColor(task.from.stroke, task.toStroke, e));
      } else if (task.type === 'exit') {
        task.el.style.opacity = String(1 - _ease(Math.min(raw / 0.7, 1)));
      } else {
        task.el.style.opacity = String(_ease(Math.max(0, Math.min((raw - 0.3) / 0.5, 1))) * task.toOpacity);
      }
    }
    if (raw < 1) { requestAnimationFrame(frame); return; }
    // Restore final attribute state cleanly
    for (const task of tasks) {
      if (task.type === 'morph') {
        for (const [k, v] of Object.entries(task.toGeom)) task.el.setAttribute(k, v);
        if (task.toFill)   task.el.setAttribute('fill',   task.toFill);
        if (task.toStroke) task.el.setAttribute('stroke', task.toStroke);
      } else if (task.type === 'exit') {
        task.el.remove();
      } else {
        task.el.style.opacity = '';
      }
    }
    if (then) then();
  }
  requestAnimationFrame(frame);
}

const TRANSITIONS = {
  morph(swap, t, then) {
    if (t.duration > 0 && slides.length) { morphSlide(t.duration, then); return; }
    swap(); if (then) then();
  },
  crossfade(swap, t, then) {
    if (t.duration <= 0) { swap(); if (then) then(); return; }
    stage.style.transition = `opacity ${t.duration}s ease`;
    stage.style.opacity = '0';
    setTimeout(() => {
      swap();
      requestAnimationFrame(() => { stage.style.opacity = '1'; if (then) then(); });
    }, t.duration * 1000);
  },
};

// Replace innerHTML with new slide content. Does NOT call applyStep() —
// elements start in their pre-transition state so the next advance() triggers
// a real animated transition. Optional `then` runs after content is swapped.
// Pass `transition` to override the destination slide's declared transition (used
// when navigating backward so the outgoing slide's transition plays in reverse).
function loadSlide(then = null, transition = null) {
  const swap = () => {
    stage.innerHTML = slides.length ? slides[slideIndex] : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
    _maxStepCache = null;
    updateStatus();
  };

  const t = transition ?? transitions[slideIndex] ?? { type: 'cut', duration: 0 };
  const handler = TRANSITIONS[t.type];
  if (handler) { handler(swap, t, then); return; }

  stage.style.transition = 'none';
  stage.style.opacity = '1';
  swap();
  if (then) then();
}

// ── Navigation ──
function advance() {
  if (step < maxStep()) {
    step++;
    applyStep();
  } else if (slideIndex < slides.length - 1) {
    slideIndex++;
    step = 0;
    loadSlide();
  }
}

function retreat() {
  if (step > 0) {
    step--;
    applyStep();
  } else if (slideIndex > 0) {
    const t = transitions[slideIndex];
    slideIndex--;
    step = 0;
    loadSlide(() => { step = maxStep(); applyStep(); }, t);
  }
}

function nextSlide() {
  if (slideIndex < slides.length - 1) { slideIndex++; step = 0; loadSlide(); }
}

function prevSlide() {
  if (slideIndex > 0) {
    const t = transitions[slideIndex];
    slideIndex--;
    step = 0;
    loadSlide(null, t);
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

function showCurtain(color) { curtain.style.background = color; curtain.classList.add('visible'); }
function hideCurtain()      { curtain.classList.remove('visible'); }
function toggleCurtain(color) {
  curtain.classList.contains('visible') ? hideCurtain() : showCurtain(color);
}

function toggleHelp() { help.classList.toggle('visible'); }

function gotoFirst() { slideIndex = 0; step = 0; loadSlide(); }
function gotoLast()  { slideIndex = slides.length - 1; step = 0; loadSlide(); }

// ── Error display ──
function showError(msg) {
  errorMsg.textContent = msg;
  errorOverlay.classList.add('visible');
}
function hideError() { errorOverlay.classList.remove('visible'); }

// ── Go-to-slide ──
function enterGoto() { gotoMode = true; gotoBuffer = ''; updateStatus(); }
function exitGoto()  { gotoMode = false; gotoBuffer = ''; updateStatus(); }
function commitGoto() {
  const n = parseInt(gotoBuffer, 10);
  exitGoto();
  if (!isNaN(n) && n >= 1 && n <= slides.length) {
    slideIndex = n - 1;
    step = 0;
    loadSlide();
  }
}

function toggleTheme() {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'light' ? '' : 'light';
}

curtain.addEventListener('click', hideCurtain);
help.addEventListener('click', e => { if (e.target === help) toggleHelp(); });
stage.addEventListener('click', advance);

// ── Keybindings ──
// To make keys configurable via deck.py in the future, merge a server-injected
// KEYBINDINGS_OVERRIDES object into this map before the listener runs.
const KEYBINDINGS = {
  'ArrowRight': { action: advance,                          preventDefault: true },
  ' ':          { action: advance,                          preventDefault: true },
  'l':          { action: advance,                          preventDefault: true },
  'ArrowLeft':  { action: retreat,                          preventDefault: true },
  'Backspace':  { action: retreat,                          preventDefault: true },
  'h':          { action: retreat,                          preventDefault: true },
  'ArrowDown':  { action: nextSlide,                        preventDefault: true },
  'j':          { action: nextSlide,                        preventDefault: true },
  'ArrowUp':    { action: prevSlide,                        preventDefault: true },
  'k':          { action: prevSlide,                        preventDefault: true },
  'Home':       { action: gotoFirst },
  '^':          { action: gotoFirst },
  'End':        { action: gotoLast },
  '$':          { action: gotoLast },
  'g':          { action: enterGoto },
  'f':          { action: toggleFullscreen },
  'b':          { action: () => toggleCurtain('black') },
  '.':          { action: () => toggleCurtain('black') },
  'w':          { action: () => toggleCurtain('white') },
  '?':          { action: toggleHelp },
  't':          { action: toggleTheme },
};

document.addEventListener('keydown', e => {
  if (help.classList.contains('visible')) {
    if (e.key === '?' || e.key === 'Escape') toggleHelp();
    return;
  }
  if (curtain.classList.contains('visible')) { hideCurtain(); return; }

  if (gotoMode) {
    if (e.key >= '0' && e.key <= '9')  { gotoBuffer += e.key; updateStatus(); }
    else if (e.key === 'Enter')         { e.preventDefault(); commitGoto(); }
    else if (e.key === 'Backspace')     { e.preventDefault(); gotoBuffer = gotoBuffer.slice(0, -1); updateStatus(); }
    else if (e.key === 'Escape')        { exitGoto(); }
    return;
  }

  const binding = KEYBINDINGS[e.key];
  if (binding) {
    if (binding.preventDefault) e.preventDefault();
    binding.action();
  }
});

// ── WebSocket live reload ──
function connectWS() {
  if (!WS_PORT) {
    wsLabel.textContent = 'offline';
    return;
  }
  const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

  ws.onopen = () => {
    wsDot.className = 'connected';
    wsLabel.textContent = 'live';
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'update') {
      slides = msg.slides;
      transitions = msg.transitions ?? [];
      hideError();
      slideIndex = Math.min(slideIndex, Math.max(0, slides.length - 1));
      step = 0;
      loadSlide();
    } else if (msg.type === 'error') {
      showError(msg.message);
    }
  };

  ws.onclose = () => {
    wsDot.className = '';
    wsLabel.textContent = 'disconnected';
    setTimeout(connectWS, 2000);
  };

  ws.onerror = () => ws.close();
}

// ── Boot ──
readURL();
loadSlide(() => { if (step > 0) applyStep(); });
if (INITIAL_ERROR) showError(INITIAL_ERROR);
connectWS();
