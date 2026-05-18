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
const stage     = document.getElementById('stage');
const slideInfo = document.getElementById('slide-info');
const stepInfo  = document.getElementById('step-info');
const wsDot     = document.getElementById('ws-dot');
const wsLabel   = document.getElementById('ws-label');
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
  history.replaceState(null, '', `/${slideIndex + 1}${search}`);
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
  stepInfo.textContent  = `step ${step}`;
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

// Replace innerHTML with new slide content. Does NOT call applyStep() —
// elements start in their pre-transition state so the next advance() triggers
// a real animated transition. Optional `then` runs after content is swapped
// (needed by callers that must applyStep() once the new DOM is in place).
function loadSlide(then = null) {
  const swap = () => {
    if (!slides.length) {
      stage.innerHTML = '<p style="color:var(--accent);padding:2rem">No slides.</p>';
    } else {
      stage.innerHTML = slides[slideIndex];
    }
    _maxStepCache = null;
    updateStatus();
    if (then) then();
  };

  const t = transitions[slideIndex] ?? {type: 'cut', duration: 0};
  if (t.type === 'crossfade' && t.duration > 0) {
    stage.style.transition = `opacity ${t.duration}s ease`;
    stage.style.opacity = '0';
    setTimeout(() => {
      swap();
      requestAnimationFrame(() => { stage.style.opacity = '1'; });
    }, t.duration * 1000);
  } else {
    stage.style.transition = 'none';
    stage.style.opacity = '1';
    swap();
  }
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
    slideIndex--;
    step = 0;
    loadSlide(() => { step = maxStep(); applyStep(); });
  }
}

function nextSlide() {
  if (slideIndex < slides.length - 1) { slideIndex++; step = 0; loadSlide(); }
}

function prevSlide() {
  if (slideIndex > 0) { slideIndex--; step = 0; loadSlide(); }
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

curtain.addEventListener('click', hideCurtain);
help.addEventListener('click', e => { if (e.target === help) toggleHelp(); });
stage.addEventListener('click', advance);

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

  if      (e.key === 'g') { enterGoto(); }
  else if (e.key === 'f') { toggleFullscreen(); }
  else if (e.key === 'b' || e.key === '.') { toggleCurtain('black'); }
  else if (e.key === 'w') { toggleCurtain('white'); }
  else if (e.key === '?') { toggleHelp(); }
  else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'l') { e.preventDefault(); advance(); }
  else if (e.key === 'ArrowLeft'  || e.key === 'Backspace' || e.key === 'h') { e.preventDefault(); retreat(); }
  else if (e.key === 'ArrowDown'  || e.key === 'j') { e.preventDefault(); nextSlide(); }
  else if (e.key === 'ArrowUp'    || e.key === 'k') { e.preventDefault(); prevSlide(); }
  else if (e.key === 'Home' || e.key === '^') { slideIndex = 0; step = 0; loadSlide(); }
  else if (e.key === 'End'  || e.key === '$') { slideIndex = slides.length - 1; step = 0; loadSlide(); }
});

// ── WebSocket live reload ──
function connectWS() {
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
