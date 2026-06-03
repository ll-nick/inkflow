"use strict";
(() => {
  // src/ts/presenter-view/clock.ts
  var clockEl = document.getElementById("pv-clock");
  var elapsedEl = document.getElementById("pv-elapsed");
  var startTime = Date.now();
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function updateClock() {
    const now = /* @__PURE__ */ new Date();
    clockEl.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const secs = Math.floor((Date.now() - startTime) / 1e3);
    const h = Math.floor(secs / 3600);
    const m = Math.floor(secs % 3600 / 60);
    const s = secs % 60;
    const elapsed = h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
    elapsedEl.textContent = `elapsed ${elapsed}`;
  }

  // src/ts/shared/step.ts
  function maxStep(root) {
    let m = 0;
    root.querySelectorAll("[data-step]").forEach((el) => {
      const s = +(el.getAttribute("data-step") ?? "0");
      if (s > m) m = s;
    });
    return m;
  }
  function applyStep(root, step) {
    root.querySelectorAll("[data-step]").forEach((el) => {
      el.classList.toggle(
        "active",
        +(el.getAttribute("data-step") ?? "0") <= step
      );
    });
  }

  // src/ts/presenter-view/state.ts
  var state = {
    slides: [],
    slideIndex: 0,
    step: 0,
    ws: null,
    _syncingFromServer: false,
    _maxStepCache: null
  };

  // src/ts/presenter-view/render.ts
  var currentPane = document.getElementById("pv-current-inner");
  var nextPane = document.getElementById("pv-next-inner");
  var notesPane = document.getElementById("pv-notes");
  var slideEl = document.getElementById("pv-slide");
  var stepEl = document.getElementById("pv-step");
  function maxStep2() {
    if (state._maxStepCache !== null) return state._maxStepCache;
    state._maxStepCache = maxStep(currentPane);
    return state._maxStepCache;
  }
  function applyCurrentStep() {
    applyStep(currentPane, state.step);
  }
  function updateInfo() {
    const total = state.slides.length;
    slideEl.innerHTML = `Slide <span class="pv-num">${total ? state.slideIndex + 1 : "\u2013"}</span> / ${total || "\u2013"}`;
    stepEl.innerHTML = `Step <span class="pv-num">${state.step}</span> / ${maxStep2()}`;
  }
  function scaleNext() {
    const svg = nextPane.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2];
    const vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const scale = Math.min(
      nextPane.clientWidth / vbW,
      nextPane.clientHeight / vbH
    );
    const tx = (nextPane.clientWidth - vbW * scale) / 2;
    const ty = (nextPane.clientHeight - vbH * scale) / 2;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  function renderCurrent() {
    currentPane.innerHTML = state.slides[state.slideIndex]?.svg ?? "";
    state._maxStepCache = null;
    applyCurrentStep();
    updateInfo();
  }
  function renderNext() {
    const curMax = maxStep2();
    let previewSvg = null;
    let revealStep = 0;
    if (state.step < curMax) {
      previewSvg = state.slides[state.slideIndex]?.svg ?? null;
      revealStep = state.step + 1;
    } else if (state.slideIndex + 1 < state.slides.length) {
      previewSvg = state.slides[state.slideIndex + 1].svg;
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
          +(el.getAttribute("data-step") ?? "0") <= revealStep
        );
      });
    }
    requestAnimationFrame(scaleNext);
  }
  function renderNotes() {
    notesPane.innerHTML = state.slides[state.slideIndex]?.notes ?? "";
    notesPane.scrollTop = 0;
  }
  function renderAll() {
    renderCurrent();
    renderNext();
    renderNotes();
  }
  window.addEventListener("resize", () => {
    scaleNext();
  });

  // src/ts/presenter-view/websocket.ts
  var dotEl = document.getElementById("pv-dot");
  var liveLabel = document.getElementById("pv-live-label");
  function sendNav() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state._syncingFromServer)
      return;
    state.ws.send(
      JSON.stringify({
        type: "nav",
        slideIndex: state.slideIndex,
        step: state.step
      })
    );
  }
  function connectWS(wsPort) {
    if (!wsPort) return;
    state.ws = new WebSocket(`ws://localhost:${wsPort}`);
    state.ws.onopen = () => {
      dotEl.classList.add("connected");
      liveLabel.textContent = "live";
    };
    state.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "update") {
        state.slides = msg.slides;
        state.slideIndex = Math.min(
          state.slideIndex,
          Math.max(0, state.slides.length - 1)
        );
        state.step = 0;
        renderAll();
      } else if (msg.type === "position") {
        const newIndex = Math.min(
          Math.max(0, msg.slideIndex | 0),
          Math.max(0, state.slides.length - 1)
        );
        const newStep = Math.max(0, msg.step | 0);
        if (newIndex === state.slideIndex && newStep === state.step) return;
        state._syncingFromServer = true;
        const slideChanged = newIndex !== state.slideIndex;
        state.slideIndex = newIndex;
        state.step = newStep;
        if (slideChanged) {
          renderAll();
        } else {
          applyCurrentStep();
          updateInfo();
          renderNext();
        }
        state._syncingFromServer = false;
      }
    };
    state.ws.onclose = () => {
      dotEl.classList.remove("connected");
      liveLabel.textContent = "offline";
      state.ws = null;
      setTimeout(() => connectWS(wsPort), 2e3);
    };
    state.ws.onerror = () => state.ws?.close();
  }

  // src/ts/presenter-view/keyboard.ts
  function advance() {
    if (state.step < maxStep2()) {
      state.step++;
      applyCurrentStep();
      updateInfo();
      renderNext();
    } else if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      renderAll();
    }
    sendNav();
  }
  function retreat() {
    if (state.step > 0) {
      state.step--;
      applyCurrentStep();
      updateInfo();
      renderNext();
    } else if (state.slideIndex > 0) {
      state.slideIndex--;
      state.step = 0;
      renderAll();
      state.step = maxStep2();
      applyCurrentStep();
      updateInfo();
      renderNext();
    }
    sendNav();
  }
  function nextSlide() {
    if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      renderAll();
    }
    sendNav();
  }
  function prevSlide() {
    if (state.slideIndex > 0) {
      state.slideIndex--;
      state.step = 0;
      renderAll();
    }
    sendNav();
  }
  var KEYBINDINGS = {
    ArrowRight: { action: advance, preventDefault: true },
    " ": { action: advance, preventDefault: true },
    l: { action: advance, preventDefault: true },
    ArrowLeft: { action: retreat, preventDefault: true },
    Backspace: { action: retreat, preventDefault: true },
    h: { action: retreat, preventDefault: true },
    ArrowDown: { action: nextSlide, preventDefault: true },
    j: { action: nextSlide, preventDefault: true },
    ArrowUp: { action: prevSlide, preventDefault: true },
    k: { action: prevSlide, preventDefault: true }
  };
  document.addEventListener("keydown", (e) => {
    const binding = KEYBINDINGS[e.key];
    if (!binding) return;
    if (binding.preventDefault) e.preventDefault();
    binding.action();
  });

  // src/ts/presenter-view/main.ts
  var INITIAL_SLIDES = __SLIDES_JSON__;
  var INITIAL_POSITION = __INITIAL_POSITION__;
  var WS_PORT = __WS_PORT__;
  state.slides = INITIAL_SLIDES;
  state.slideIndex = Math.min(
    Math.max(0, INITIAL_POSITION.slideIndex | 0),
    Math.max(0, state.slides.length - 1)
  );
  state.step = Math.max(0, INITIAL_POSITION.step | 0);
  renderAll();
  updateClock();
  setInterval(updateClock, 1e3);
  connectWS(WS_PORT);
})();
