(() => {
  // src/ts/presenter-view/main.ts
  var INITIAL_SLIDES = __SLIDES_JSON__;
  var INITIAL_POSITION = __INITIAL_POSITION__;
  var WS_PORT = __WS_PORT__;
  var slides = INITIAL_SLIDES;
  var slideIndex = Math.min(
    Math.max(0, INITIAL_POSITION.slideIndex | 0),
    Math.max(0, slides.length - 1)
  );
  var step = Math.max(0, INITIAL_POSITION.step | 0);
  var ws = null;
  var _syncingFromServer = false;
  var _maxStepCache = null;
  var startTime = Date.now();
  var currentPane = document.getElementById("pv-current-inner");
  var nextPane = document.getElementById("pv-next-inner");
  var notesPane = document.getElementById("pv-notes");
  var clockEl = document.getElementById("pv-clock");
  var elapsedEl = document.getElementById("pv-elapsed");
  var slideEl = document.getElementById("pv-slide");
  var stepEl = document.getElementById("pv-step");
  var dotEl = document.getElementById("pv-dot");
  var liveLabel = document.getElementById("pv-live-label");
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
    const now = /* @__PURE__ */ new Date();
    clockEl.textContent = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    const secs = Math.floor((Date.now() - startTime) / 1e3);
    const h = Math.floor(secs / 3600);
    const m = Math.floor(secs % 3600 / 60);
    const s = secs % 60;
    const elapsed = h > 0 ? `${_pad2(h)}:${_pad2(m)}:${_pad2(s)}` : `${_pad2(m)}:${_pad2(s)}`;
    elapsedEl.textContent = `elapsed ${elapsed}`;
  }
  function updateInfo() {
    const total = slides.length;
    slideEl.innerHTML = `Slide <span class="pv-num">${total ? slideIndex + 1 : "\u2013"}</span> / ${total || "\u2013"}`;
    const ms = maxStep();
    stepEl.innerHTML = `Step <span class="pv-num">${step}</span> / ${ms}`;
  }
  function _scaleNext() {
    const svg = nextPane.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2], vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const w = nextPane.clientWidth, h = nextPane.clientHeight;
    const scale = Math.min(w / vbW, h / vbH);
    const tx = (w - vbW * scale) / 2;
    const ty = (h - vbH * scale) / 2;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  function renderCurrent() {
    currentPane.innerHTML = slides[slideIndex]?.svg ?? "";
    _maxStepCache = null;
    applyStep();
    updateInfo();
  }
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
          +el.getAttribute("data-step") <= revealStep
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
          Math.max(0, slides.length - 1)
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
      setTimeout(connectWS, 2e3);
    };
    ws.onerror = () => ws.close();
  }
  window.addEventListener("resize", () => {
    _scaleNext();
  });
  renderAll();
  updateClock();
  setInterval(updateClock, 1e3);
  connectWS();
})();
