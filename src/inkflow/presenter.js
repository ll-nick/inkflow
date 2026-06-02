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
let _pickerMatches = [];
let _pickerActive  = 0;
let _overviewActive = 0;
let _overviewCols   = 1;

// ── DOM refs ──
const stage        = document.getElementById('stage');
const slideInfo    = document.getElementById('slide-info');
const stepInfo     = document.getElementById('step-info');
const wsDot        = document.getElementById('ws-dot');
const curtain      = document.getElementById('curtain');
const help         = document.getElementById('help');
const errorOverlay = document.getElementById('error-overlay');
const errorMsg     = document.getElementById('error-msg');
const picker       = document.getElementById('picker');
const pickerInput  = document.getElementById('picker-input');
const pickerList   = document.getElementById('picker-list');
const overview     = document.getElementById('overview');
const overviewGrid = document.getElementById('overview-grid');

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

function buildStepRing(current, total) {
  const size = 20, cx = 10, cy = 10, ro = 9, ri = 5;
  if (total === 0) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle"><circle cx="${cx}" cy="${cy}" r="${(ro + ri) / 2}" fill="none" stroke="var(--overlay)" stroke-width="${ro - ri}" opacity="0.2"/></svg>`;
  }
  const gap = total > 1 ? 0.15 : 0;
  const sweep = (2 * Math.PI) / total;
  let paths = '';
  for (let i = 0; i < total; i++) {
    const a1 = -Math.PI / 2 + i * sweep + gap / 2;
    const a2 = -Math.PI / 2 + (i + 1) * sweep - gap / 2;
    const ox1 = (cx + ro * Math.cos(a1)).toFixed(2), oy1 = (cy + ro * Math.sin(a1)).toFixed(2);
    const ox2 = (cx + ro * Math.cos(a2)).toFixed(2), oy2 = (cy + ro * Math.sin(a2)).toFixed(2);
    const ix1 = (cx + ri * Math.cos(a1)).toFixed(2), iy1 = (cy + ri * Math.sin(a1)).toFixed(2);
    const ix2 = (cx + ri * Math.cos(a2)).toFixed(2), iy2 = (cy + ri * Math.sin(a2)).toFixed(2);
    const large = (a2 - a1 > Math.PI) ? 1 : 0;
    const active = i < current;
    const d = `M${ox1},${oy1}A${ro},${ro},0,${large},1,${ox2},${oy2}L${ix2},${iy2}A${ri},${ri},0,${large},0,${ix1},${iy1}Z`;
    paths += `<path d="${d}" fill="${active ? 'var(--text)' : 'var(--overlay)'}" opacity="${active ? 1 : 0.3}"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle" aria-label="Step ${current} of ${total}">${paths}</svg>`;
}

function updateStatus() {
  slideInfo.innerHTML = `<span class="slide-current">${slideIndex + 1}</span> / ${slides.length}`;
  stepInfo.innerHTML = buildStepRing(step, maxStep());
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
  stage.innerHTML = slides[slideIndex].svg;
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
    stage.innerHTML = slides.length ? slides[slideIndex].svg : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
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

// ── Slide picker ──
function openPicker() {
  picker.classList.add('visible');
  pickerInput.value = '';
  filterPicker('');
  pickerInput.focus();
}

function closePicker() {
  picker.classList.remove('visible');
}

function filterPicker(query) {
  const q = query.trim();
  let matches;
  if (q === '') {
    matches = slides.map((_, i) => i);
  } else if (/^\d+$/.test(q)) {
    matches = slides.reduce((acc, _, i) => {
      if (String(i + 1).startsWith(q)) acc.push(i);
      return acc;
    }, []);
  } else {
    const lq = q.toLowerCase();
    matches = slides.reduce((acc, s, i) => {
      const title = (s.title || '').toLowerCase();
      let ti = 0;
      for (let qi = 0; qi < lq.length; qi++) {
        ti = title.indexOf(lq[qi], ti);
        if (ti === -1) return acc;
        ti++;
      }
      acc.push(i);
      return acc;
    }, []);
  }
  _pickerMatches = matches;
  _pickerActive = 0;
  pickerList.innerHTML = matches.map((idx, pos) =>
    `<li role="option" data-pos="${pos}" class="${pos === 0 ? 'active' : ''}">` +
    `<span class="pk-num">${idx + 1}</span>` +
    `<span class="pk-title">${slides[idx].title || ''}</span></li>`
  ).join('');
  const active = pickerList.querySelector('li.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function _pickerMoveCursor(delta) {
  if (!_pickerMatches.length) return;
  _pickerActive = Math.max(0, Math.min(_pickerMatches.length - 1, _pickerActive + delta));
  pickerList.querySelectorAll('li').forEach((li, i) =>
    li.classList.toggle('active', i === _pickerActive)
  );
  const active = pickerList.querySelector('li.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function _pickerCommit() {
  if (!_pickerMatches.length) return;
  slideIndex = _pickerMatches[_pickerActive];
  step = 0;
  loadSlide();
  closePicker();
}

pickerInput.addEventListener('input', () => filterPicker(pickerInput.value));
pickerInput.addEventListener('keydown', e => {
  const down = e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || (e.key === 'j' && e.ctrlKey);
  const up   = e.key === 'ArrowUp'   || (e.key === 'Tab' && e.shiftKey)  || (e.key === 'k' && e.ctrlKey);
  if (down)              { e.preventDefault(); _pickerMoveCursor(+1); }
  else if (up)           { e.preventDefault(); _pickerMoveCursor(-1); }
  else if (e.key === 'Enter')  { e.preventDefault(); _pickerCommit(); }
  else if (e.key === 'Escape') { closePicker(); }
});
pickerList.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  const pos = parseInt(li.dataset.pos, 10);
  _pickerActive = pos;
  _pickerCommit();
});
picker.addEventListener('click', e => { if (e.target === picker) closePicker(); });

// ── Slide overview ──
function openOverview() {
  overviewGrid.innerHTML = '';
  slides.forEach((s, i) => {
    const cell = document.createElement('div');
    cell.className = 'overview-cell';
    cell.dataset.index = i;
    cell.innerHTML =
      `<div class="overview-num">${i + 1}</div>` +
      `<div class="overview-thumb">${s.svg}</div>`;
    overviewGrid.appendChild(cell);
  });
  _overviewActive = slideIndex;
  overview.classList.add('visible');
  // Scale + mark active after grid layout has resolved
  requestAnimationFrame(() => {
    overviewGrid.querySelectorAll('.overview-thumb').forEach(_scaleThumb);
    _overviewComputeCols();
    _overviewSetActive(_overviewActive);
  });
}

function _scaleThumb(thumb) {
  const svg = thumb.querySelector('svg');
  if (!svg) return;
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(parseFloat);
  if (vb.length < 4) return;
  const vbW = vb[2], vbH = vb[3];
  svg.setAttribute('width', vbW);
  svg.setAttribute('height', vbH);
  svg.style.width  = vbW + 'px';
  svg.style.height = vbH + 'px';
  const w = thumb.clientWidth, h = thumb.clientHeight;
  const scale = Math.min(w / vbW, h / vbH);
  svg.style.transform = `scale(${scale})`;
  // Reveal animated elements in their final state
  svg.querySelectorAll('[data-step]').forEach(el => el.classList.add('active'));
}

function _overviewComputeCols() {
  const cols = getComputedStyle(overviewGrid).gridTemplateColumns.split(' ').length;
  _overviewCols = cols || 1;
}

function closeOverview() {
  overview.classList.remove('visible');
  overviewGrid.innerHTML = '';
}

function _overviewSetActive(i) {
  _overviewActive = Math.max(0, Math.min(slides.length - 1, i));
  overviewGrid.querySelectorAll('.overview-cell').forEach((el, idx) =>
    el.classList.toggle('active', idx === _overviewActive)
  );
  const active = overviewGrid.children[_overviewActive];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function _overviewCommit() {
  slideIndex = _overviewActive;
  step = 0;
  closeOverview();
  loadSlide();
}

overview.addEventListener('click', e => {
  const cell = e.target.closest('.overview-cell');
  if (cell) {
    _overviewActive = +cell.dataset.index;
    _overviewCommit();
  } else if (e.target === overview) {
    closeOverview();
  }
});

window.addEventListener('resize', () => {
  if (!overview.classList.contains('visible')) return;
  overviewGrid.querySelectorAll('.overview-thumb').forEach(_scaleThumb);
  _overviewComputeCols();
});

function toggleTheme() {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'light' ? '' : 'light';
}

curtain.addEventListener('click', hideCurtain);
help.addEventListener('click', e => { if (e.target === help) toggleHelp(); });
stage.addEventListener('click', advance);

// ── Status bar buttons ──
document.getElementById('btn-prev').addEventListener('click', retreat);
document.getElementById('btn-next').addEventListener('click', advance);
document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
document.getElementById('btn-theme').addEventListener('click', toggleTheme);
document.getElementById('btn-overview').addEventListener('click', () => { /* TODO */ });
document.getElementById('btn-presenter').addEventListener('click', () => { /* TODO */ });

// ── Fullscreen: body class + hot-zone statusbar reveal ──
const statusbar = document.getElementById('statusbar');
let _fsHideTimer = null;

function _handleFullscreenChange() {
  const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
  document.body.classList.toggle('is-fullscreen', isFS);
  if (!isFS) {
    statusbar.classList.remove('fs-visible');
    clearTimeout(_fsHideTimer);
    _fsHideTimer = null;
  }
}
document.addEventListener('fullscreenchange', _handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', _handleFullscreenChange);

function _showFsBar() {
  statusbar.classList.add('fs-visible');
  clearTimeout(_fsHideTimer);
  _fsHideTimer = null;
}
function _scheduleFsHide() {
  if (_fsHideTimer) return;
  _fsHideTimer = setTimeout(() => {
    statusbar.classList.remove('fs-visible');
    _fsHideTimer = null;
  }, 600);
}

// Hot zone: bottom-left corner, 20% wide × 10% tall
document.addEventListener('mousemove', e => {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) return;
  const inZone = e.clientX < window.innerWidth * 0.20 && e.clientY > window.innerHeight * 0.90;
  if (inZone) _showFsBar(); else _scheduleFsHide();
});
statusbar.addEventListener('mouseenter', () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) _showFsBar();
});
statusbar.addEventListener('mouseleave', () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) _scheduleFsHide();
});

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
  'g':          { action: openPicker,                        preventDefault: true },
  'f':          { action: toggleFullscreen },
  'b':          { action: () => toggleCurtain('black') },
  '.':          { action: () => toggleCurtain('black') },
  'w':          { action: () => toggleCurtain('white') },
  '?':          { action: toggleHelp },
  't':          { action: toggleTheme },
};

document.addEventListener('keydown', e => {
  if (picker.classList.contains('visible')) return;
  if (help.classList.contains('visible')) {
    if (e.key === '?' || e.key === 'Escape') toggleHelp();
    return;
  }
  if (curtain.classList.contains('visible')) { hideCurtain(); return; }

  const binding = KEYBINDINGS[e.key];
  if (binding) {
    if (binding.preventDefault) e.preventDefault();
    binding.action();
  }
});

// ── WebSocket live reload ──
function connectWS() {
  if (!WS_PORT) return;
  const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

  ws.onopen = () => {
    wsDot.className = 'connected';
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
    setTimeout(connectWS, 2000);
  };

  ws.onerror = () => ws.close();
}

// ── Boot ──
readURL();
loadSlide(() => { if (step > 0) applyStep(); });
if (INITIAL_ERROR) showError(INITIAL_ERROR);
connectWS();
