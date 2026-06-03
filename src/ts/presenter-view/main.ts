export {};

// ── Injected by server ──
const INITIAL_SLIDES = __SLIDES_JSON__;
const INITIAL_POSITION = __INITIAL_POSITION__;
const WS_PORT = __WS_PORT__;

// ── State ──
let slides = INITIAL_SLIDES;
let slideIndex = Math.min(
    Math.max(0, INITIAL_POSITION.slideIndex | 0),
    Math.max(0, slides.length - 1),
);
let step = Math.max(0, INITIAL_POSITION.step | 0);
let ws = null;
let _syncingFromServer = false;
let _maxStepCache = null;
const startTime = Date.now();

// ── DOM refs ──
const currentPane = document.getElementById("pv-current-inner");
const nextPane = document.getElementById("pv-next-inner");
const notesPane = document.getElementById("pv-notes");
const clockEl = document.getElementById("pv-clock");
const elapsedEl = document.getElementById("pv-elapsed");
const slideEl = document.getElementById("pv-slide");
const stepEl = document.getElementById("pv-step");
const dotEl = document.getElementById("pv-dot");
const liveLabel = document.getElementById("pv-live-label");

// ── Helpers ──
function maxStep() {
    if (_maxStepCache !== null) return _maxStepCache;
    let m = 0;
    currentPane.querySelectorAll("[data-step]").forEach((el) => {
        const s = +el.getAttribute("data-step");
        if (s > m) m = s;
    });
    _maxStepCache = m;
    return m;
}

function applyStep() {
    currentPane.querySelectorAll("[data-step]").forEach((el) => {
        el.classList.toggle("active", +el.getAttribute("data-step") <= step);
    });
}

function _pad2(n) {
    return String(n).padStart(2, "0");
}

function updateClock() {
    const now = new Date();
    clockEl.textContent = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const elapsed =
        h > 0
            ? `${_pad2(h)}:${_pad2(m)}:${_pad2(s)}`
            : `${_pad2(m)}:${_pad2(s)}`;
    elapsedEl.textContent = `elapsed ${elapsed}`;
}

function updateInfo() {
    const total = slides.length;
    slideEl.innerHTML = `Slide <span class="pv-num">${total ? slideIndex + 1 : "–"}</span> / ${total || "–"}`;
    const ms = maxStep();
    stepEl.innerHTML = `Step <span class="pv-num">${step}</span> / ${ms}`;
}

// ── Scaling for the next-click preview (mirrors presenter.js _scaleThumb) ──
function _scaleNext() {
    const svg = nextPane.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") || "")
        .split(/[\s,]+/)
        .map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2],
        vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const w = nextPane.clientWidth,
        h = nextPane.clientHeight;
    const scale = Math.min(w / vbW, h / vbH);
    const tx = (w - vbW * scale) / 2;
    const ty = (h - vbH * scale) / 2;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

// ── Rendering ──
function renderCurrent() {
    currentPane.innerHTML = slides[slideIndex]?.svg ?? "";
    _maxStepCache = null;
    applyStep();
    updateInfo();
}

// The "next click" preview: either the current slide with one more step
// revealed, or the next slide in its initial state (step 0) when the
// current slide has no more steps.
function renderNext() {
    const curMax = maxStep();
    let previewSvg = null;
    let revealStep = 0;
    if (step < curMax) {
        previewSvg = slides[slideIndex]?.svg ?? null;
        revealStep = step + 1;
    } else if (slideIndex + 1 < slides.length) {
        previewSvg = slides[slideIndex + 1].svg;
        revealStep = 0;
    }
    if (previewSvg === null) {
        nextPane.innerHTML = '<div id="pv-next-empty">END</div>';
        return;
    }
    nextPane.innerHTML = previewSvg;
    const svg = nextPane.querySelector("svg");
    if (svg) {
        svg.querySelectorAll("[data-step]").forEach((el) => {
            el.classList.toggle(
                "active",
                +el.getAttribute("data-step") <= revealStep,
            );
        });
    }
    requestAnimationFrame(_scaleNext);
}

function renderNotes() {
    notesPane.innerHTML = slides[slideIndex]?.notes ?? "";
    notesPane.scrollTop = 0;
}

function renderAll() {
    renderCurrent();
    renderNext();
    renderNotes();
}

// ── Navigation ──
function sendNav() {
    if (!ws || ws.readyState !== WebSocket.OPEN || _syncingFromServer) return;
    ws.send(JSON.stringify({ type: "nav", slideIndex, step }));
}

function advance() {
    if (step < maxStep()) {
        step++;
        applyStep();
        updateInfo();
        renderNext();
    } else if (slideIndex < slides.length - 1) {
        slideIndex++;
        step = 0;
        renderAll();
    }
    sendNav();
}

function retreat() {
    if (step > 0) {
        step--;
        applyStep();
        updateInfo();
        renderNext();
    } else if (slideIndex > 0) {
        slideIndex--;
        step = 0;
        renderAll();
        // Reveal the previous slide at its end-state, like the main presenter does
        step = maxStep();
        applyStep();
        updateInfo();
        renderNext();
    }
    sendNav();
}

function nextSlide() {
    if (slideIndex < slides.length - 1) {
        slideIndex++;
        step = 0;
        renderAll();
    }
    sendNav();
}

function prevSlide() {
    if (slideIndex > 0) {
        slideIndex--;
        step = 0;
        renderAll();
    }
    sendNav();
}

// ── Keybindings ──
const KEYBINDINGS = {
    ArrowRight: { action: advance, preventDefault: true },
    " ": { action: advance, preventDefault: true },
    l: { action: advance, preventDefault: true },
    ArrowLeft: { action: retreat, preventDefault: true },
    Backspace: { action: retreat, preventDefault: true },
    h: { action: retreat, preventDefault: true },
    ArrowDown: { action: nextSlide, preventDefault: true },
    j: { action: nextSlide, preventDefault: true },
    ArrowUp: { action: prevSlide, preventDefault: true },
    k: { action: prevSlide, preventDefault: true },
};

document.addEventListener("keydown", (e) => {
    const binding = KEYBINDINGS[e.key];
    if (!binding) return;
    if (binding.preventDefault) e.preventDefault();
    binding.action();
});

// ── WebSocket ──
function connectWS() {
    if (!WS_PORT) return;
    ws = new WebSocket(`ws://localhost:${WS_PORT}`);

    ws.onopen = () => {
        dotEl.classList.add("connected");
        liveLabel.textContent = "live";
    };

    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "update") {
            slides = msg.slides;
            slideIndex = Math.min(slideIndex, Math.max(0, slides.length - 1));
            step = 0;
            renderAll();
        } else if (msg.type === "position") {
            const newIndex = Math.min(
                Math.max(0, msg.slideIndex | 0),
                Math.max(0, slides.length - 1),
            );
            const newStep = Math.max(0, msg.step | 0);
            if (newIndex === slideIndex && newStep === step) return;
            _syncingFromServer = true;
            const slideChanged = newIndex !== slideIndex;
            slideIndex = newIndex;
            step = newStep;
            if (slideChanged) {
                renderAll();
            } else {
                applyStep();
                updateInfo();
                renderNext();
            }
            _syncingFromServer = false;
        }
    };

    ws.onclose = () => {
        dotEl.classList.remove("connected");
        liveLabel.textContent = "offline";
        ws = null;
        setTimeout(connectWS, 2000);
    };

    ws.onerror = () => ws.close();
}

// ── Resize ──
window.addEventListener("resize", () => {
    _scaleNext();
});

// ── Boot ──
renderAll();
updateClock();
setInterval(updateClock, 1000);
connectWS();
