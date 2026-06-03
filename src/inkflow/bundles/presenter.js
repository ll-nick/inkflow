"use strict";
(() => {
  // src/ts/presenter/state.ts
  var state = {
    slides: [],
    transitions: [],
    slideIndex: 0,
    step: 0,
    _maxStepCache: null,
    _pickerMatches: [],
    _pickerActive: 0,
    _overviewActive: 0,
    _overviewCols: 1,
    ws: null,
    _syncingFromServer: false
  };

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

  // src/ts/presenter/status.ts
  var stage = document.getElementById("stage");
  var slideInfo = document.getElementById("slide-info");
  var stepInfo = document.getElementById("step-info");
  function maxStep2() {
    if (state._maxStepCache !== null) return state._maxStepCache;
    state._maxStepCache = maxStep(stage);
    return state._maxStepCache;
  }
  function applyCurrentStep() {
    applyStep(stage, state.step);
    updateStatus();
  }
  function syncURL() {
    const search = state.step > 0 ? `?clicks=${state.step}` : "";
    try {
      history.replaceState(null, "", `/${state.slideIndex + 1}${search}`);
    } catch (_) {
    }
  }
  function readURL() {
    const seg = window.location.pathname.replace(/^\//, "");
    const n = parseInt(seg, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= state.slides.length)
      state.slideIndex = n - 1;
    const clicks = parseInt(
      new URLSearchParams(window.location.search).get("clicks") ?? "0",
      10
    );
    if (!Number.isNaN(clicks) && clicks >= 0) state.step = clicks;
  }
  function buildStepRing(current, total) {
    const size = 20, cx = 10, cy = 10, ro = 9, ri = 5;
    if (total === 0) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle"><circle cx="${cx}" cy="${cy}" r="${(ro + ri) / 2}" fill="none" stroke="var(--overlay)" stroke-width="${ro - ri}" opacity="0.2"/></svg>`;
    }
    const gap = total > 1 ? 0.15 : 0;
    const sweep = 2 * Math.PI / total;
    let paths = "";
    for (let i = 0; i < total; i++) {
      const a1 = -Math.PI / 2 + i * sweep + gap / 2;
      const a2 = -Math.PI / 2 + (i + 1) * sweep - gap / 2;
      const ox1 = (cx + ro * Math.cos(a1)).toFixed(2), oy1 = (cy + ro * Math.sin(a1)).toFixed(2);
      const ox2 = (cx + ro * Math.cos(a2)).toFixed(2), oy2 = (cy + ro * Math.sin(a2)).toFixed(2);
      const ix1 = (cx + ri * Math.cos(a1)).toFixed(2), iy1 = (cy + ri * Math.sin(a1)).toFixed(2);
      const ix2 = (cx + ri * Math.cos(a2)).toFixed(2), iy2 = (cy + ri * Math.sin(a2)).toFixed(2);
      const large = a2 - a1 > Math.PI ? 1 : 0;
      const active = i < current;
      const d = `M${ox1},${oy1}A${ro},${ro},0,${large},1,${ox2},${oy2}L${ix2},${iy2}A${ri},${ri},0,${large},0,${ix1},${iy1}Z`;
      paths += `<path d="${d}" fill="${active ? "var(--text)" : "var(--overlay)"}" opacity="${active ? 1 : 0.3}"/>`;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle" aria-label="Step ${current} of ${total}">${paths}</svg>`;
  }
  function updateStatus() {
    slideInfo.innerHTML = `<span class="slide-current">${state.slideIndex + 1}</span> / ${state.slides.length}`;
    stepInfo.innerHTML = buildStepRing(state.step, maxStep2());
    syncURL();
  }

  // src/ts/presenter/transitions.ts
  var stage2 = document.getElementById("stage");
  function geomAttrs(el) {
    const g = (k) => parseFloat(el.getAttribute(k) ?? "0");
    switch (el.tagName.toLowerCase()) {
      case "rect":
        return {
          x: g("x"),
          y: g("y"),
          width: g("width"),
          height: g("height"),
          rx: g("rx")
        };
      case "circle":
        return { cx: g("cx"), cy: g("cy"), r: g("r") };
      case "ellipse":
        return { cx: g("cx"), cy: g("cy"), rx: g("rx"), ry: g("ry") };
      default:
        return null;
    }
  }
  function parseHexColor(s) {
    const h = (s ?? "").replace("#", "");
    if (h.length === 3) return h.split("").map((c) => parseInt(c + c, 16));
    if (h.length === 6)
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return null;
  }
  function lerpColor(a, b, t) {
    const ca = parseHexColor(a), cb = parseHexColor(b);
    if (!ca || !cb) return t < 0.5 ? a ?? "" : b ?? "";
    return "#" + ca.map(
      (c, i) => Math.round(c + (cb[i] - c) * t).toString(16).padStart(2, "0")
    ).join("");
  }
  function ease(t) {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  }
  function morphSlide(duration, then) {
    const ms = duration * 1e3;
    const fromMap = /* @__PURE__ */ new Map();
    stage2.querySelectorAll("[id]").forEach((el) => {
      fromMap.set(el.id, {
        tag: el.tagName.toLowerCase(),
        geom: geomAttrs(el),
        fill: el.getAttribute("fill"),
        stroke: el.getAttribute("stroke")
      });
    });
    stage2.innerHTML = state.slides[state.slideIndex].svg;
    state._maxStepCache = null;
    const newSvg = stage2.querySelector("svg");
    if (!newSvg) {
      updateStatus();
      if (then) then();
      return;
    }
    updateStatus();
    const tasks = [];
    const seenIds = /* @__PURE__ */ new Set();
    newSvg.querySelectorAll("[id]").forEach((el) => {
      seenIds.add(el.id);
      const from = fromMap.get(el.id);
      const toGeom = geomAttrs(el);
      if (from?.geom && toGeom && from.tag === el.tagName.toLowerCase()) {
        const toFill = el.getAttribute("fill");
        const toStroke = el.getAttribute("stroke");
        for (const [k, v] of Object.entries(from.geom))
          el.setAttribute(k, String(v));
        if (from.fill) el.setAttribute("fill", from.fill);
        if (from.stroke) el.setAttribute("stroke", from.stroke);
        tasks.push({ type: "morph", el, from, toGeom, toFill, toStroke });
      } else if (!from) {
        el.style.opacity = "0";
        tasks.push({
          type: "fade",
          el,
          toOpacity: parseFloat(el.getAttribute("opacity") ?? "1")
        });
      }
    });
    for (const [id, from] of fromMap) {
      if (seenIds.has(id) || !from.geom) continue;
      const ghost = document.createElementNS(
        "http://www.w3.org/2000/svg",
        from.tag
      );
      for (const [k, v] of Object.entries(from.geom))
        ghost.setAttribute(k, String(v));
      if (from.fill) ghost.setAttribute("fill", from.fill);
      if (from.stroke) ghost.setAttribute("stroke", from.stroke);
      newSvg.appendChild(ghost);
      tasks.push({ type: "exit", el: ghost });
    }
    const t0 = performance.now();
    function frame(now) {
      const raw = Math.min((now - t0) / ms, 1);
      const e = ease(raw);
      for (const task of tasks) {
        if (task.type === "morph") {
          for (const k of Object.keys(task.toGeom))
            task.el.setAttribute(
              k,
              String(
                task.from.geom[k] + (task.toGeom[k] - task.from.geom[k]) * e
              )
            );
          if (task.from.fill && task.toFill)
            task.el.setAttribute(
              "fill",
              lerpColor(task.from.fill, task.toFill, e)
            );
          if (task.from.stroke && task.toStroke)
            task.el.setAttribute(
              "stroke",
              lerpColor(task.from.stroke, task.toStroke, e)
            );
        } else if (task.type === "exit") {
          task.el.style.opacity = String(
            1 - ease(Math.min(raw / 0.7, 1))
          );
        } else {
          task.el.style.opacity = String(
            ease(Math.max(0, Math.min((raw - 0.3) / 0.5, 1))) * task.toOpacity
          );
        }
      }
      if (raw < 1) {
        requestAnimationFrame(frame);
        return;
      }
      for (const task of tasks) {
        if (task.type === "morph") {
          for (const [k, v] of Object.entries(task.toGeom))
            task.el.setAttribute(k, String(v));
          if (task.toFill) task.el.setAttribute("fill", task.toFill);
          if (task.toStroke)
            task.el.setAttribute("stroke", task.toStroke);
        } else if (task.type === "exit") {
          task.el.remove();
        } else {
          task.el.style.opacity = "";
        }
      }
      if (then) then();
    }
    requestAnimationFrame(frame);
  }
  var HANDLERS = {
    morph(swap, t, then) {
      if (t.duration > 0 && state.slides.length) {
        morphSlide(t.duration, then);
        return;
      }
      swap();
      if (then) then();
    },
    crossfade(swap, t, then) {
      if (t.duration <= 0) {
        swap();
        if (then) then();
        return;
      }
      stage2.style.transition = `opacity ${t.duration}s ease`;
      stage2.style.opacity = "0";
      setTimeout(() => {
        swap();
        requestAnimationFrame(() => {
          stage2.style.opacity = "1";
          if (then) then();
        });
      }, t.duration * 1e3);
    }
  };
  function loadSlide(then = null, transition = null) {
    const swap = () => {
      stage2.innerHTML = state.slides.length ? state.slides[state.slideIndex].svg : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
      state._maxStepCache = null;
      updateStatus();
    };
    const t = transition ?? state.transitions[state.slideIndex] ?? { type: "cut", duration: 0 };
    const handler = HANDLERS[t.type];
    if (handler) {
      handler(swap, t, then);
      return;
    }
    stage2.style.transition = "none";
    stage2.style.opacity = "1";
    swap();
    if (then) then();
  }

  // src/ts/presenter/ui.ts
  var curtain = document.getElementById("curtain");
  var help = document.getElementById("help");
  var errorOverlay = document.getElementById("error-overlay");
  var errorMsg = document.getElementById("error-msg");
  var statusBarEl = document.getElementById("statusbar");
  var _doc = document;
  var _fsHideTimer;
  function showCurtain(color) {
    curtain.style.background = color;
    curtain.classList.add("visible");
  }
  function hideCurtain() {
    curtain.classList.remove("visible");
  }
  function toggleCurtain(color) {
    curtain.classList.contains("visible") ? hideCurtain() : showCurtain(color);
  }
  function toggleHelp() {
    help.classList.toggle("visible");
  }
  function showError(msg) {
    errorMsg.textContent = msg;
    errorOverlay.classList.add("visible");
  }
  function hideError() {
    errorOverlay.classList.remove("visible");
  }
  function toggleTheme() {
    const html = document.documentElement;
    html.dataset.theme = html.dataset.theme === "light" ? "" : "light";
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement)
      document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  function showFsBar() {
    statusBarEl.classList.add("fs-visible");
    clearTimeout(_fsHideTimer);
    _fsHideTimer = void 0;
  }
  function scheduleFsHide() {
    if (_fsHideTimer) return;
    _fsHideTimer = setTimeout(() => {
      statusBarEl.classList.remove("fs-visible");
      _fsHideTimer = void 0;
    }, 600);
  }
  function handleFullscreenChange() {
    const isFS = !!(document.fullscreenElement || _doc.webkitFullscreenElement);
    document.body.classList.toggle("is-fullscreen", isFS);
    if (!isFS) {
      statusBarEl.classList.remove("fs-visible");
      clearTimeout(_fsHideTimer);
      _fsHideTimer = void 0;
    }
  }
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
  document.addEventListener("mousemove", (e) => {
    if (!document.fullscreenElement && !_doc.webkitFullscreenElement) return;
    const inZone = e.clientX < window.innerWidth * 0.2 && e.clientY > window.innerHeight * 0.9;
    if (inZone) showFsBar();
    else scheduleFsHide();
  });
  statusBarEl.addEventListener("mouseenter", () => {
    if (document.fullscreenElement || _doc.webkitFullscreenElement) showFsBar();
  });
  statusBarEl.addEventListener("mouseleave", () => {
    if (document.fullscreenElement || _doc.webkitFullscreenElement)
      scheduleFsHide();
  });
  curtain.addEventListener("click", hideCurtain);
  help.addEventListener("click", (e) => {
    if (e.target === help) toggleHelp();
  });

  // src/ts/presenter/websocket.ts
  var wsDot = document.getElementById("ws-dot");
  var overviewEl = document.getElementById("overview");
  var overviewGridEl = document.getElementById("overview-grid");
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
      wsDot.className = "connected";
      sendNav();
    };
    state.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "update") {
        state.slides = msg.slides;
        state.transitions = msg.transitions ?? [];
        hideError();
        if (overviewEl.classList.contains("visible")) {
          overviewEl.classList.remove("visible");
          overviewGridEl.innerHTML = "";
        }
        state.slideIndex = Math.min(
          state.slideIndex,
          Math.max(0, state.slides.length - 1)
        );
        state.step = 0;
        loadSlide();
      } else if (msg.type === "error") {
        showError(msg.message);
      } else if (msg.type === "position") {
        const newIndex = Math.min(
          Math.max(0, msg.slideIndex | 0),
          Math.max(0, state.slides.length - 1)
        );
        const newStep = Math.max(0, msg.step | 0);
        if (newIndex === state.slideIndex && newStep === state.step) return;
        state._syncingFromServer = true;
        state.slideIndex = newIndex;
        state.step = newStep;
        loadSlide(() => {
          if (state.step > 0) applyCurrentStep();
          state._syncingFromServer = false;
        });
      }
    };
    state.ws.onclose = () => {
      wsDot.className = "";
      state.ws = null;
      setTimeout(() => connectWS(wsPort), 2e3);
    };
    state.ws.onerror = () => state.ws?.close();
  }

  // src/ts/presenter/navigation.ts
  function advance() {
    if (state.step < maxStep2()) {
      state.step++;
      applyCurrentStep();
    } else if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      loadSlide();
    }
    sendNav();
  }
  function retreat() {
    if (state.step > 0) {
      state.step--;
      applyCurrentStep();
    } else if (state.slideIndex > 0) {
      const t = state.transitions[state.slideIndex];
      state.slideIndex--;
      state.step = 0;
      loadSlide(() => {
        state.step = maxStep2();
        applyCurrentStep();
        sendNav();
      }, t ?? null);
      return;
    }
    sendNav();
  }
  function nextSlide() {
    if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      loadSlide();
    }
    sendNav();
  }
  function prevSlide() {
    if (state.slideIndex > 0) {
      const t = state.transitions[state.slideIndex];
      state.slideIndex--;
      state.step = 0;
      loadSlide(null, t ?? null);
    }
    sendNav();
  }
  function gotoFirst() {
    state.slideIndex = 0;
    state.step = 0;
    loadSlide();
    sendNav();
  }
  function gotoLast() {
    state.slideIndex = state.slides.length - 1;
    state.step = 0;
    loadSlide();
    sendNav();
  }

  // src/ts/presenter/overview.ts
  var overview = document.getElementById("overview");
  var overviewGrid = document.getElementById("overview-grid");
  function scaleThumb(thumb) {
    const svg = thumb.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2], vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const scale = Math.min(thumb.clientWidth / vbW, thumb.clientHeight / vbH);
    svg.style.transform = `scale(${scale})`;
    svg.querySelectorAll("[data-step]").forEach((el) => {
      el.classList.add("active");
    });
  }
  function computeCols() {
    const cols = getComputedStyle(overviewGrid).gridTemplateColumns.split(" ").length;
    state._overviewCols = cols || 1;
  }
  function overviewSetActive(i) {
    state._overviewActive = Math.max(0, Math.min(state.slides.length - 1, i));
    overviewGrid.querySelectorAll(".overview-cell").forEach((el, idx) => {
      el.classList.toggle("active", idx === state._overviewActive);
    });
    const active = overviewGrid.children[state._overviewActive];
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function overviewCommit() {
    state.slideIndex = state._overviewActive;
    state.step = 0;
    closeOverview();
    loadSlide();
    sendNav();
  }
  function openOverview() {
    overviewGrid.innerHTML = "";
    state.slides.forEach((s, i) => {
      const cell = document.createElement("div");
      cell.className = "overview-cell";
      cell.dataset.index = String(i);
      cell.innerHTML = `<div class="overview-num">${i + 1}</div><div class="overview-thumb">${s.svg}</div>`;
      overviewGrid.appendChild(cell);
    });
    state._overviewActive = state.slideIndex;
    overview.classList.add("visible");
    requestAnimationFrame(() => {
      overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
      computeCols();
      overviewSetActive(state._overviewActive);
    });
  }
  function closeOverview() {
    overview.classList.remove("visible");
    overviewGrid.innerHTML = "";
  }
  overview.addEventListener("click", (e) => {
    const cell = e.target.closest(".overview-cell");
    if (cell) {
      state._overviewActive = +cell.dataset.index;
      overviewCommit();
    } else if (e.target === overview) {
      closeOverview();
    }
  });
  window.addEventListener("resize", () => {
    if (!overview.classList.contains("visible")) return;
    overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
    computeCols();
  });

  // src/ts/presenter/picker.ts
  var picker = document.getElementById("picker");
  var pickerInput = document.getElementById("picker-input");
  var pickerList = document.getElementById("picker-list");
  function openPicker() {
    picker.classList.add("visible");
    pickerInput.value = "";
    filterPicker("");
    pickerInput.focus();
  }
  function closePicker() {
    picker.classList.remove("visible");
  }
  function filterPicker(query) {
    const q = query.trim();
    let matches;
    if (q === "") {
      matches = state.slides.map((_, i) => i);
    } else if (/^\d+$/.test(q)) {
      matches = state.slides.reduce((acc, _, i) => {
        if (String(i + 1).startsWith(q)) acc.push(i);
        return acc;
      }, []);
    } else {
      const lq = q.toLowerCase();
      matches = state.slides.reduce((acc, s, i) => {
        const title = (s.title || "").toLowerCase();
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
    state._pickerMatches = matches;
    state._pickerActive = 0;
    pickerList.innerHTML = matches.map(
      (idx, pos) => `<li role="option" data-pos="${pos}" class="${pos === 0 ? "active" : ""}"><span class="pk-num">${idx + 1}</span><span class="pk-title">${state.slides[idx].title || ""}</span></li>`
    ).join("");
    const active = pickerList.querySelector("li.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function pickerMoveCursor(delta) {
    if (!state._pickerMatches.length) return;
    state._pickerActive = Math.max(
      0,
      Math.min(state._pickerMatches.length - 1, state._pickerActive + delta)
    );
    pickerList.querySelectorAll("li").forEach((li, i) => {
      li.classList.toggle("active", i === state._pickerActive);
    });
    const active = pickerList.querySelector("li.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function pickerCommit() {
    if (!state._pickerMatches.length) return;
    state.slideIndex = state._pickerMatches[state._pickerActive];
    state.step = 0;
    loadSlide();
    closePicker();
    sendNav();
  }
  pickerInput.addEventListener("input", () => filterPicker(pickerInput.value));
  pickerInput.addEventListener("keydown", (e) => {
    const down = e.key === "ArrowDown" || e.key === "Tab" && !e.shiftKey || e.key === "j" && e.ctrlKey;
    const up = e.key === "ArrowUp" || e.key === "Tab" && e.shiftKey || e.key === "k" && e.ctrlKey;
    if (down) {
      e.preventDefault();
      pickerMoveCursor(1);
    } else if (up) {
      e.preventDefault();
      pickerMoveCursor(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickerCommit();
    } else if (e.key === "Escape") {
      closePicker();
    }
  });
  pickerList.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const pos = parseInt(li.dataset.pos, 10);
    state._pickerActive = pos;
    pickerCommit();
  });
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });

  // src/ts/presenter/keyboard.ts
  document.getElementById("stage").addEventListener("click", advance);
  document.getElementById("btn-prev").addEventListener("click", retreat);
  document.getElementById("btn-next").addEventListener("click", advance);
  document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  document.getElementById("btn-overview").addEventListener("click", openOverview);
  document.getElementById("btn-presenter").addEventListener(
    "click",
    () => window.open("/presenter", "_blank", "noopener")
  );
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
    k: { action: prevSlide, preventDefault: true },
    Home: { action: gotoFirst },
    "^": { action: gotoFirst },
    End: { action: gotoLast },
    $: { action: gotoLast },
    g: { action: openPicker, preventDefault: true },
    o: { action: openOverview, preventDefault: true },
    f: { action: toggleFullscreen },
    b: { action: () => toggleCurtain("black") },
    ".": { action: () => toggleCurtain("black") },
    w: { action: () => toggleCurtain("white") },
    "?": { action: toggleHelp },
    t: { action: toggleTheme },
    p: { action: () => window.open("/presenter", "_blank", "noopener") }
  };
  var helpEl = document.getElementById("help");
  var overviewEl2 = document.getElementById("overview");
  var pickerEl = document.getElementById("picker");
  var curtainEl = document.getElementById("curtain");
  document.addEventListener("keydown", (e) => {
    if (helpEl.classList.contains("visible")) {
      if (e.key === "?" || e.key === "Escape") {
        toggleHelp();
        return;
      }
      if (e.key !== "t") return;
    }
    if (overviewEl2.classList.contains("visible")) {
      if (e.key === "Escape") {
        closeOverview();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        overviewSetActive(state._overviewActive + 1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "h") {
        e.preventDefault();
        overviewSetActive(state._overviewActive - 1);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        overviewSetActive(state._overviewActive + state._overviewCols);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        overviewSetActive(state._overviewActive - state._overviewCols);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        overviewCommit();
        return;
      }
      if (e.key !== "t" && e.key !== "?") return;
    }
    if (pickerEl.classList.contains("visible")) return;
    if (curtainEl.classList.contains("visible")) {
      hideCurtain();
      return;
    }
    const binding = KEYBINDINGS[e.key];
    if (binding) {
      if (binding.preventDefault) e.preventDefault();
      binding.action();
    }
  });

  // src/ts/presenter/main.ts
  var INITIAL_SLIDES = __SLIDES_JSON__;
  var INITIAL_TRANSITIONS = __TRANSITIONS_JSON__;
  var WS_PORT = __WS_PORT__;
  var INITIAL_ERROR = __ERROR_JSON__;
  state.slides = INITIAL_SLIDES;
  state.transitions = INITIAL_TRANSITIONS;
  readURL();
  loadSlide(() => {
    if (state.step > 0) applyCurrentStep();
  });
  if (INITIAL_ERROR) showError(INITIAL_ERROR);
  connectWS(WS_PORT);
})();
