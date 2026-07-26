"use strict";
(() => {
  // src/ts/shared/ring.ts
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

  // src/ts/shared/keyframes.ts
  var templates = /* @__PURE__ */ new Map();
  function parseOffsets(keyText) {
    return keyText.split(",").map((part) => {
      const t = part.trim();
      if (t === "from") return 0;
      if (t === "to") return 1;
      return Number.parseFloat(t) / 100;
    }).filter((n) => Number.isFinite(n));
  }
  function kebabToCamel(prop) {
    return prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  function ruleToKeyframes(rule) {
    const frames = [];
    for (const raw of Array.from(rule.cssRules)) {
      const kf = raw;
      const style = kf.style;
      const props = {};
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        props[kebabToCamel(name)] = style.getPropertyValue(name).trim();
      }
      for (const offset of parseOffsets(kf.keyText)) {
        frames.push({ offset, ...props });
      }
    }
    frames.sort((a, b) => a.offset - b.offset);
    return frames;
  }
  function findKeyframes(name, rules) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSKeyframesRule) {
        if (rule.name === name) return rule;
        continue;
      }
      const grouping = rule;
      if (grouping.cssRules) {
        const found = findKeyframes(name, grouping.cssRules);
        if (found) return found;
      }
    }
    return null;
  }
  function templateFor(name) {
    const cached = templates.get(name);
    if (cached !== void 0) return cached;
    let result = null;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const rule = findKeyframes(name, rules);
      if (rule) {
        result = ruleToKeyframes(rule);
        break;
      }
    }
    templates.set(name, result);
    return result;
  }
  var VAR_ANIM = /var\(\s*--anim-([\w-]+)\s*(?:,[^()]*)?\)/g;
  function substituteVars(value, vars) {
    return value.replace(
      VAR_ANIM,
      (match, key) => key in vars ? vars[key] : match
    );
  }
  function buildKeyframes(name, vars) {
    const template = templateFor(name);
    if (!template) return [];
    if (Object.keys(vars).length === 0) return template;
    return template.map((frame) => {
      const out = {};
      for (const [k, v] of Object.entries(frame)) {
        out[k] = typeof v === "string" ? substituteVars(v, vars) : v;
      }
      return out;
    });
  }

  // src/ts/shared/step.ts
  var elementCues = /* @__PURE__ */ new WeakMap();
  var rootStep = /* @__PURE__ */ new WeakMap();
  function parseCues(el) {
    const raw = el.getAttribute("data-cues");
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  function cueStates(el) {
    let states = elementCues.get(el);
    if (!states) {
      states = parseCues(el).map((cue) => ({ cue, anim: null }));
      elementCues.set(el, states);
    }
    return states;
  }
  function ensureAnim(el, st) {
    if (!st.anim) {
      const { name, vars, opts } = st.cue;
      const anim = el.animate(buildKeyframes(`anim-${name}`, vars), {
        duration: Math.max(0, opts.duration * 1e3),
        delay: Math.max(0, opts.delay * 1e3),
        easing: opts.easing || "linear",
        iterations: opts.iterations ?? 1,
        fill: "forwards"
      });
      anim.pause();
      st.anim = anim;
    }
    return st.anim;
  }
  function holdAtEnd(anim) {
    anim.playbackRate = 1;
    try {
      anim.play();
      anim.finish();
    } catch {
    }
  }
  function elementActions(cues, step, prev, instant) {
    const governing = (at) => {
      let idx = -1;
      cues.forEach((c, i) => {
        if (c.kind !== "emphasis" && c.step <= at) idx = i;
      });
      return idx;
    };
    const gov = governing(step);
    const govPrev = governing(prev);
    return cues.map((cue, i) => {
      if (cue.kind === "emphasis") {
        const crossedForward = !instant && step > prev && cue.step > prev && cue.step <= step;
        if (crossedForward) return "emphasis";
        return instant ? "cancel" : "idle";
      }
      if (i === gov) {
        return !instant && step > prev && cue.step === step ? "forward" : "hold";
      }
      if (!instant && i === govPrev && govPrev > gov) return "reverse";
      return "cancel";
    });
  }
  function applyAction(el, st, action) {
    switch (action) {
      case "forward":
      case "emphasis": {
        const anim = ensureAnim(el, st);
        anim.cancel();
        anim.playbackRate = 1;
        anim.play();
        break;
      }
      case "reverse": {
        const anim = ensureAnim(el, st);
        anim.playbackRate = -1;
        anim.play();
        break;
      }
      case "hold":
        holdAtEnd(ensureAnim(el, st));
        break;
      case "cancel":
        st.anim?.cancel();
        break;
      case "idle":
        break;
    }
  }
  function applyCodeHighlights(root, step) {
    root.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const specIdx = Math.min(Math.max(step - baseStep, 0), spec.length - 1);
      const active = spec[specIdx];
      const hasHL = active !== null;
      block.querySelectorAll(".code-line").forEach((line) => {
        const n = +(line.dataset.line ?? "0");
        line.classList.toggle("hl-active", hasHL && active.includes(n));
        line.classList.toggle("hl-dim", hasHL && !active.includes(n));
        if (!hasHL) line.classList.remove("hl-active", "hl-dim");
      });
    });
  }
  function maxStep(root) {
    let m = 0;
    root.querySelectorAll("[data-cues]").forEach((el) => {
      for (const c of parseCues(el)) if (c.step > m) m = c.step;
    });
    root.querySelectorAll("[data-play-on-step]").forEach((el) => {
      const s = +(el.getAttribute("data-play-on-step") ?? "0");
      if (s > m) m = s;
    });
    root.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const last = baseStep + spec.length - 1;
      if (last > m) m = last;
    });
    return m;
  }
  function applyStep(root, step) {
    const prev = rootStep.get(root) ?? 0;
    root.querySelectorAll("[data-cues]").forEach((el) => {
      const states = cueStates(el);
      const actions = elementActions(
        states.map((s) => s.cue),
        step,
        prev,
        false
      );
      states.forEach((st, i) => applyAction(el, st, actions[i]));
    });
    applyCodeHighlights(root, step);
    rootStep.set(root, step);
  }
  function commitStepStyles(root) {
    if (typeof root.getAnimations !== "function") return;
    for (const anim of root.getAnimations({ subtree: true })) {
      try {
        anim.commitStyles();
      } catch {
      }
    }
  }
  function applyStepInstant(root, step) {
    root.querySelectorAll("[data-cues]").forEach((el) => {
      const states = cueStates(el);
      const actions = elementActions(
        states.map((s) => s.cue),
        step,
        step,
        true
      );
      states.forEach((st, i) => applyAction(el, st, actions[i]));
    });
    applyCodeHighlights(root, step);
    rootStep.set(root, step);
  }

  // src/ts/presenter/state.ts
  var state = {
    slides: [],
    transitions: [],
    slideIndex: 0,
    step: 0,
    syncMode: "two-way",
    _pickerMatches: [],
    _pickerActive: 0,
    _overviewActive: 0,
    _overviewCols: 1,
    ws: null,
    _syncingFromServer: false,
    _laserMode: false
  };

  // src/ts/presenter/video.ts
  var armed = /* @__PURE__ */ new WeakSet();
  var activeState = /* @__PURE__ */ new WeakMap();
  function readSpec(v) {
    const step = v.getAttribute("data-play-on-step");
    const start = v.getAttribute("data-start");
    const end = v.getAttribute("data-end");
    return {
      autoplay: v.hasAttribute("data-autoplay"),
      loop: v.hasAttribute("data-loop"),
      playOnStep: step === null ? null : Number(step),
      start: start === null ? 0 : Number(start),
      end: end === null ? null : Number(end)
    };
  }
  function arm(v, spec) {
    if (armed.has(v)) return;
    armed.add(v);
    if (spec.start > 0) {
      const seek = () => {
        if (v.currentTime < spec.start) v.currentTime = spec.start;
      };
      if (v.readyState >= 1) seek();
      else v.addEventListener("loadedmetadata", seek, { once: true });
    }
    if (spec.end !== null || spec.loop) {
      v.addEventListener("timeupdate", () => {
        if (spec.end !== null && v.currentTime >= spec.end) {
          if (spec.loop) v.currentTime = spec.start;
          else v.pause();
        }
      });
    }
    if (spec.loop) {
      v.addEventListener("ended", () => playFrom(v, spec.start));
    }
  }
  function playFrom(v, start) {
    const go = () => {
      v.currentTime = start;
      void v.play().catch(() => {
      });
    };
    if (start > 0 && v.readyState < 1) {
      v.addEventListener("loadedmetadata", go, { once: true });
    } else {
      go();
    }
  }
  function syncVideos(root, step) {
    root.querySelectorAll("video").forEach((v) => {
      const spec = readSpec(v);
      arm(v, spec);
      const shouldPlay = spec.autoplay || spec.playOnStep !== null && step >= spec.playOnStep;
      const wasActive = activeState.get(v) ?? false;
      if (shouldPlay && !wasActive) {
        playFrom(v, spec.start);
      } else if (!shouldPlay && wasActive) {
        v.pause();
        v.currentTime = spec.start;
      }
      activeState.set(v, shouldPlay);
    });
  }

  // src/ts/presenter/status.ts
  var stage = document.getElementById("stage");
  var slideInfo = document.getElementById("slide-info");
  var stepInfo = document.getElementById("step-info");
  var mhudSlideInfo = document.getElementById("mhud-slide-info");
  var mhudStepRing = document.getElementById("mhud-step-ring");
  var maxStepSlides = null;
  var maxStepIndex = -1;
  var maxStepValue = 0;
  function maxStep2() {
    if (maxStepSlides === state.slides && maxStepIndex === state.slideIndex)
      return maxStepValue;
    const scratch = document.createElement("div");
    scratch.innerHTML = state.slides[state.slideIndex]?.svg ?? "";
    maxStepValue = maxStep(scratch);
    maxStepSlides = state.slides;
    maxStepIndex = state.slideIndex;
    return maxStepValue;
  }
  function applyCurrentStep() {
    applyStep(stage, state.step);
    syncVideos(stage, state.step);
    updateStatus();
  }
  function applyCurrentStepInstant() {
    applyStepInstant(stage, state.step);
    syncVideos(stage, state.step);
    updateStatus();
  }
  function syncURL() {
    const params = new URLSearchParams(window.location.search);
    if (state.step > 0) params.set("steps", String(state.step));
    else params.delete("steps");
    const search = params.size > 0 ? `?${params.toString()}` : "";
    const base = window.location.pathname.replace(/\/[^/]*$/, "");
    try {
      history.replaceState(
        null,
        "",
        `${base}/${state.slideIndex + 1}${search}`
      );
    } catch (_) {
    }
  }
  function readURL() {
    const seg = window.location.pathname.replace(/^.*\//, "");
    const n = parseInt(seg, 10);
    const deepLinked2 = !Number.isNaN(n) && n >= 1 && n <= state.slides.length;
    if (deepLinked2) state.slideIndex = n - 1;
    const steps = parseInt(
      new URLSearchParams(window.location.search).get("steps") ?? "0",
      10
    );
    if (!Number.isNaN(steps) && steps >= 0) state.step = steps;
    return deepLinked2;
  }
  function updateStatus() {
    const infoHtml = `<span class="slide-current">${state.slideIndex + 1}</span> / ${state.slides.length}`;
    const ringHtml = buildStepRing(state.step, maxStep2());
    slideInfo.innerHTML = infoHtml;
    stepInfo.innerHTML = ringHtml;
    mhudSlideInfo.innerHTML = infoHtml;
    mhudStepRing.innerHTML = ringHtml;
    syncURL();
  }

  // src/ts/presenter/pv.ts
  var pvPanel = document.getElementById("pv");
  var pvResizeHandle = document.getElementById("pv-resize-handle");
  var pvClock = document.getElementById("pv-clock");
  var pvElapsed = document.getElementById("pv-elapsed");
  var pvSlideInfo = document.getElementById("pv-slide-info");
  var pvStepRing = document.getElementById("pv-step-ring");
  var pvNextInner = document.getElementById("pv-next-inner");
  var pvNotes = document.getElementById("pv-notes");
  var _startTime = Date.now();
  function _pad2(n) {
    return String(n).padStart(2, "0");
  }
  function updatePvClock() {
    const now = /* @__PURE__ */ new Date();
    pvClock.textContent = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    const secs = Math.floor((Date.now() - _startTime) / 1e3);
    const h = Math.floor(secs / 3600);
    const m = Math.floor(secs % 3600 / 60);
    const s = secs % 60;
    pvElapsed.textContent = h > 0 ? `${_pad2(h)}:${_pad2(m)}:${_pad2(s)}` : `${_pad2(m)}:${_pad2(s)}`;
  }
  function updatePvInfo() {
    const total = state.slides.length;
    pvSlideInfo.innerHTML = `<span class="slide-current">${total ? state.slideIndex + 1 : "\u2013"}</span> / ${total || "\u2013"}`;
    pvStepRing.innerHTML = buildStepRing(state.step, maxStep2());
  }
  function _scalePvNext() {
    const svg = pvNextInner.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2];
    const vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const scale = Math.min(
      pvNextInner.clientWidth / vbW,
      pvNextInner.clientHeight / vbH
    );
    const tx = (pvNextInner.clientWidth - vbW * scale) / 2;
    const ty = (pvNextInner.clientHeight - vbH * scale) / 2;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  function renderPvNext() {
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
      pvNextInner.innerHTML = '<div id="pv-next-empty">END</div>';
      return;
    }
    pvNextInner.innerHTML = previewSvg;
    const svg = pvNextInner.querySelector("svg");
    if (svg) applyStepInstant(svg, revealStep);
    requestAnimationFrame(_scalePvNext);
  }
  function renderPvNotes() {
    pvNotes.innerHTML = state.slides[state.slideIndex]?.notes ?? "";
    pvNotes.scrollTop = 0;
  }
  function renderPv() {
    updatePvInfo();
    renderPvNext();
    renderPvNotes();
  }
  function togglePv() {
    document.body.classList.toggle("pv-open");
    pvPanel.addEventListener("transitionend", _scalePvNext, { once: true });
  }
  window.addEventListener("resize", _scalePvNext);
  function _onPvResizeMove(e) {
    pvPanel.style.setProperty(
      "--pv-width",
      `${window.innerWidth - e.clientX}px`
    );
    _scalePvNext();
  }
  function _onPvResizeUp(e) {
    pvResizeHandle.releasePointerCapture(e.pointerId);
    pvResizeHandle.removeEventListener("pointermove", _onPvResizeMove);
    pvResizeHandle.removeEventListener("pointerup", _onPvResizeUp);
    pvPanel.style.transition = "";
  }
  pvResizeHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pvPanel.style.transition = "none";
    pvResizeHandle.setPointerCapture(e.pointerId);
    pvResizeHandle.addEventListener("pointermove", _onPvResizeMove);
    pvResizeHandle.addEventListener("pointerup", _onPvResizeUp);
  });

  // src/ts/shared/easing.ts
  var NAMED_CURVES = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1]
  };
  var CUBIC_BEZIER_PATTERN = /^cubic-bezier\(\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*\)$/;
  function parseControlPoints(spec) {
    if (!spec) return null;
    const trimmed = spec.trim();
    if (trimmed in NAMED_CURVES) return NAMED_CURVES[trimmed];
    const match = CUBIC_BEZIER_PATTERN.exec(trimmed);
    if (!match) return null;
    const points = [match[1], match[2], match[3], match[4]].map(Number);
    return points.every(Number.isFinite) ? points : null;
  }
  var identity = (progress) => progress;
  function makeCubicBezier(points) {
    const [x1, y1, x2, y2] = points;
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const sampleSlopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    const solveForT = (x) => {
      let t = x;
      for (let iteration = 0; iteration < 8; iteration++) {
        const error = sampleX(t) - x;
        if (Math.abs(error) < 1e-6) return t;
        const slope = sampleSlopeX(t);
        if (Math.abs(slope) < 1e-6) break;
        t -= error / slope;
      }
      let lower = 0;
      let upper = 1;
      t = x;
      while (lower < upper) {
        const value = sampleX(t);
        if (Math.abs(value - x) < 1e-6) return t;
        if (x > value) lower = t;
        else upper = t;
        t = (lower + upper) / 2;
      }
      return t;
    };
    return (progress) => {
      if (progress <= 0) return 0;
      if (progress >= 1) return 1;
      return sampleY(solveForT(progress));
    };
  }
  function cubicBezierEasing(spec) {
    const points = parseControlPoints(spec);
    if (!points) return identity;
    const [x1, y1, x2, y2] = points;
    if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return identity;
    return makeCubicBezier(points);
  }

  // src/ts/shared/morph-math.ts
  var INTERPOLATED_ATTRIBUTES = [
    "fill",
    "stroke",
    "opacity",
    "fill-opacity",
    "stroke-opacity"
  ];
  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  }
  function parseColorToRGB(colorString) {
    if (colorString.startsWith("#")) {
      const hexDigits = colorString.slice(1);
      if (hexDigits.length === 3)
        return hexDigits.split("").map((c) => parseInt(c + c, 16));
      if (hexDigits.length === 6)
        return [0, 2, 4].map(
          (i) => parseInt(hexDigits.slice(i, i + 2), 16)
        );
    }
    const rgbMatch = colorString.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
    return null;
  }
  function interpolateColorAttribute(fromColor, toColor, progress) {
    const fromRGB = parseColorToRGB(fromColor);
    const toRGB = parseColorToRGB(toColor);
    if (!fromRGB || !toRGB) return progress < 0.5 ? fromColor : toColor;
    return "#" + fromRGB.map(
      (channel, index) => Math.round(channel + (toRGB[index] - channel) * progress).toString(16).padStart(2, "0")
    ).join("");
  }
  function interpolateNumericAttribute(fromValue, toValue, progress) {
    return String(
      parseFloat(fromValue) + (parseFloat(toValue) - parseFloat(fromValue)) * progress
    );
  }
  var COLOR_ATTRIBUTES = /* @__PURE__ */ new Set(["fill", "stroke"]);
  function interpolateAttribute(attribute, fromValue, toValue, progress) {
    if (COLOR_ATTRIBUTES.has(attribute))
      return interpolateColorAttribute(fromValue, toValue, progress);
    return interpolateNumericAttribute(fromValue, toValue, progress);
  }
  function readInterpolatedAttributes(element) {
    const result = {};
    const inlineStyle = element instanceof SVGElement || element instanceof HTMLElement ? element.style : null;
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
      const styleValue = inlineStyle?.getPropertyValue(attribute).trim();
      if (styleValue && styleValue !== "none") {
        result[attribute] = styleValue;
        continue;
      }
      const directValue = element.getAttribute(attribute);
      if (directValue !== null && directValue !== "none") {
        result[attribute] = directValue;
        continue;
      }
      const computedValue = getComputedStyle(element).getPropertyValue(attribute).trim();
      if (computedValue && computedValue !== "none")
        result[attribute] = computedValue;
    }
    return result;
  }
  function decomposeAffine(m) {
    let a = m.a;
    let b = m.b;
    let c = m.c;
    let d = m.d;
    const determinant = a * d - b * c;
    let scaleX = Math.hypot(a, b);
    if (scaleX !== 0) {
      a /= scaleX;
      b /= scaleX;
    }
    let skew = a * c + b * d;
    c -= a * skew;
    d -= b * skew;
    const scaleY = Math.hypot(c, d);
    if (scaleY !== 0) {
      skew /= scaleY;
    }
    if (determinant < 0) {
      scaleX = -scaleX;
      a = -a;
      b = -b;
    }
    return {
      tx: m.e,
      ty: m.f,
      scaleX,
      scaleY,
      skew,
      rotation: Math.atan2(b, a)
    };
  }
  function recomposeAffine(c) {
    const skewMatrix = new DOMMatrix([1, 0, c.skew, 1, 0, 0]);
    return new DOMMatrix().translate(c.tx, c.ty).rotate(c.rotation * 180 / Math.PI).multiply(skewMatrix).scale(c.scaleX, c.scaleY);
  }
  function lerp(from, to, t) {
    return from + (to - from) * t;
  }
  function lerpAngle(from, to, t) {
    let delta = to - from;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return from + delta * t;
  }
  function interpolateAffine(from, to, t) {
    return recomposeAffine({
      tx: lerp(from.tx, to.tx, t),
      ty: lerp(from.ty, to.ty, t),
      scaleX: lerp(from.scaleX, to.scaleX, t),
      scaleY: lerp(from.scaleY, to.scaleY, t),
      skew: lerp(from.skew, to.skew, t),
      rotation: lerpAngle(from.rotation, to.rotation, t)
    });
  }
  function matrixScaleX(m) {
    return Math.hypot(m.a, m.b);
  }
  function matrixScaleY(m) {
    const scaleX = Math.hypot(m.a, m.b);
    if (scaleX === 0) return Math.hypot(m.c, m.d);
    return Math.abs(m.a * m.d - m.b * m.c) / scaleX;
  }

  // src/ts/presenter/progress-driver.ts
  var ProgressDriver = class {
    value = 0;
    // The end the most recent animateTo is travelling toward. Callers read this to
    // decide which way a reversal should go.
    heading = 1;
    animateTo(target, durationSeconds, signal, onFrame) {
      this.heading = target;
      const ratePerMillisecond = 1 / (durationSeconds * 1e3);
      return new Promise((resolve) => {
        let lastTimestamp = null;
        const step = (timestamp) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          if (lastTimestamp === null) lastTimestamp = timestamp;
          const direction = target >= this.value ? 1 : -1;
          this.value += direction * ratePerMillisecond * (timestamp - lastTimestamp);
          lastTimestamp = timestamp;
          const reachedTarget = direction === 1 && this.value >= target || direction === -1 && this.value <= target;
          if (reachedTarget) {
            this.value = target;
            onFrame(this.value);
            resolve();
            return;
          }
          onFrame(this.value);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }
  };

  // src/ts/presenter/morph.ts
  var LEAF_SELECTOR = "rect, circle, ellipse, line, polyline, polygon, path, text, image, foreignObject";
  var LENGTH_ATTRIBUTES = ["stroke-width", "rx", "ry"];
  function captureFrame(element) {
    const bbox = element.getBBox();
    const screenCTM = DOMMatrix.fromMatrix(element.getScreenCTM());
    const frame = screenCTM.translate(bbox.x, bbox.y).scale(bbox.width, bbox.height);
    return {
      comp: decomposeAffine(frame),
      screenScale: { x: matrixScaleX(screenCTM), y: matrixScaleY(screenCTM) },
      bbox
    };
  }
  function readLengthAttributes(element) {
    const lengths = {};
    for (const name of LENGTH_ATTRIBUTES) {
      const raw = element.getAttribute(name);
      if (raw === null) continue;
      const value = parseFloat(raw);
      if (Number.isFinite(value)) lengths[name] = value;
    }
    return lengths;
  }
  function readFontSize(node) {
    const px = parseFloat(getComputedStyle(node).fontSize);
    return Number.isFinite(px) ? px : 0;
  }
  function textAnchorLocal(node) {
    return {
      x: node.x.baseVal.numberOfItems > 0 ? node.x.baseVal.getItem(0).value : 0,
      y: node.y.baseVal.numberOfItems > 0 ? node.y.baseVal.getItem(0).value : 0
    };
  }
  function captureTextScreenPose(node) {
    const ctm = node.getScreenCTM() ?? new DOMMatrix();
    const anchor = textAnchorLocal(node);
    const screen = new DOMPoint(anchor.x, anchor.y).matrixTransform(ctm);
    return {
      anchorX: screen.x,
      anchorY: screen.y,
      rotation: Math.atan2(ctm.b, ctm.a),
      scale: Math.hypot(ctm.a, ctm.b) || 1,
      fontSize: readFontSize(node)
    };
  }
  function captureEndpointsScreen(node) {
    const ctm = node.getScreenCTM() ?? new DOMMatrix();
    const p1 = new DOMPoint(
      node.x1.baseVal.value,
      node.y1.baseVal.value
    ).matrixTransform(ctm);
    const p2 = new DOMPoint(
      node.x2.baseVal.value,
      node.y2.baseVal.value
    ).matrixTransform(ctm);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }
  function leafKind(element) {
    if (element instanceof SVGLineElement) return "line";
    if (element instanceof SVGTextElement) return "text";
    return "box";
  }
  function parentScreenCTM(element) {
    const parent = element.parentElement;
    return parent instanceof SVGGraphicsElement ? parent.getScreenCTM() ?? new DOMMatrix() : new DOMMatrix();
  }
  function ancestorIdChain(element) {
    const ids = [];
    let current = element;
    while (current) {
      if (current.id) ids.push(current.id);
      current = current.parentElement;
    }
    return ids;
  }
  function snapshotLeaf(element) {
    const common = {
      ancestorIds: ancestorIdChain(element),
      fromAttributes: readInterpolatedAttributes(element),
      clone: element.cloneNode(true),
      screenCTM: element.getScreenCTM() ?? new DOMMatrix()
    };
    if (element instanceof SVGLineElement)
      return {
        kind: "line",
        ...common,
        endpointsScreen: captureEndpointsScreen(element),
        strokeWidth: readLengthAttributes(element)["stroke-width"]
      };
    if (element instanceof SVGTextElement)
      return {
        kind: "text",
        ...common,
        textPose: captureTextScreenPose(element)
      };
    const captured = captureFrame(element);
    return {
      kind: "box",
      ...common,
      frame: captured.comp,
      screenScale: captured.screenScale,
      lengths: readLengthAttributes(element)
    };
  }
  function snapshotLeaves(svg) {
    const ids = /* @__PURE__ */ new Set();
    for (const el of svg.querySelectorAll("[id]")) ids.add(el.id);
    const leaves = [];
    for (const el of svg.querySelectorAll(LEAF_SELECTOR)) {
      if (!el.getScreenCTM()) continue;
      leaves.push(snapshotLeaf(el));
    }
    return { ids, leaves };
  }
  function collectIds(root) {
    const ids = /* @__PURE__ */ new Set();
    if (root.id) ids.add(root.id);
    for (const element of root.querySelectorAll("[id]")) ids.add(element.id);
    return ids;
  }
  function snapshotTopLevelChildren(svg) {
    return Array.from(svg.children).map((child, index) => ({
      element: child.cloneNode(true),
      html: child.outerHTML,
      ids: collectIds(child),
      index
    }));
  }
  function nearestMatchedId(ancestorIds, matchedIds) {
    return ancestorIds.find((id) => matchedIds.has(id));
  }
  function createLeafMorph(element, snapshot) {
    const kind = leafKind(element);
    if (kind !== snapshot.kind) return null;
    const fromAttributes = snapshot.fromAttributes;
    const toAttributes = readInterpolatedAttributes(element);
    if (kind === "line" && element instanceof SVGLineElement && snapshot.endpointsScreen) {
      const screenInverse = (element.getScreenCTM() ?? new DOMMatrix()).inverse();
      const s = snapshot.endpointsScreen;
      const p1 = new DOMPoint(s.x1, s.y1).matrixTransform(screenInverse);
      const p2 = new DOMPoint(s.x2, s.y2).matrixTransform(screenInverse);
      return {
        kind: "line",
        element,
        fromAttributes,
        toAttributes,
        from: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
        to: {
          x1: element.x1.baseVal.value,
          y1: element.y1.baseVal.value,
          x2: element.x2.baseVal.value,
          y2: element.y2.baseVal.value
        },
        fromStrokeWidth: snapshot.strokeWidth,
        toStrokeWidth: readLengthAttributes(element)["stroke-width"]
      };
    }
    if (kind === "text" && element instanceof SVGTextElement && snapshot.textPose) {
      const anchor = textAnchorLocal(element);
      return {
        kind: "text",
        element,
        fromAttributes,
        toAttributes,
        parentCTM: parentScreenCTM(element),
        originalTransform: element.getAttribute("transform") ?? "",
        anchorLocalX: anchor.x,
        anchorLocalY: anchor.y,
        from: snapshot.textPose,
        to: captureTextScreenPose(element)
      };
    }
    if (snapshot.frame && snapshot.screenScale) {
      const captured = captureFrame(element);
      if (captured.bbox.width === 0 || captured.bbox.height === 0)
        return null;
      if (snapshot.clone.innerHTML !== element.innerHTML) return null;
      const bTo = new DOMMatrix().translate(captured.bbox.x, captured.bbox.y).scale(captured.bbox.width, captured.bbox.height);
      element.style.setProperty("transform-box", "view-box");
      element.style.setProperty("transform-origin", "0 0");
      return {
        kind: "box",
        element,
        fromAttributes,
        toAttributes,
        originalTransform: element.getAttribute("transform") ?? "",
        fromComp: snapshot.frame,
        toComp: captured.comp,
        parentInverse: parentScreenCTM(element).inverse(),
        bToInverse: bTo.inverse(),
        fromLengths: snapshot.lengths ?? {},
        toLengths: readLengthAttributes(element),
        fromScreenScale: snapshot.screenScale,
        toScreenScale: captured.screenScale
      };
    }
    return null;
  }
  function buildLeafExit(snapshot, svgRoot) {
    const ghost = snapshot.clone;
    const placement = (svgRoot.getScreenCTM() ?? new DOMMatrix()).inverse().multiply(snapshot.screenCTM);
    ghost.setAttribute("transform", matrixToSvgTransform(placement));
    svgRoot.appendChild(ghost);
    const startOpacity = parseFloat(snapshot.fromAttributes.opacity ?? "1");
    return {
      type: "exit",
      element: ghost,
      startOpacity: Number.isFinite(startOpacity) ? startOpacity : 1
    };
  }
  function buildLeafEnter(element) {
    const target = parseFloat(element.getAttribute("opacity") ?? "1");
    element.style.opacity = "0";
    return {
      type: "fadeIn",
      element,
      targetOpacity: Number.isFinite(target) ? target : 1
    };
  }
  function buildLeafTasks(svgRoot, oldLeaves, matchedIds) {
    const oldByScope = /* @__PURE__ */ new Map();
    for (const leaf of oldLeaves.leaves) {
      const scope = nearestMatchedId(leaf.ancestorIds, matchedIds);
      if (!scope) continue;
      (oldByScope.get(scope) ?? oldByScope.set(scope, []).get(scope)).push(
        leaf
      );
    }
    const newByScope = /* @__PURE__ */ new Map();
    for (const el of svgRoot.querySelectorAll(
      LEAF_SELECTOR
    )) {
      if (!el.getScreenCTM()) continue;
      const scope = nearestMatchedId(ancestorIdChain(el), matchedIds);
      if (!scope) continue;
      (newByScope.get(scope) ?? newByScope.set(scope, []).get(scope)).push(
        el
      );
    }
    const tasks = [];
    const scopes = /* @__PURE__ */ new Set([...oldByScope.keys(), ...newByScope.keys()]);
    for (const scope of scopes) {
      const oldList = oldByScope.get(scope) ?? [];
      const newList = newByScope.get(scope) ?? [];
      const paired = Math.min(oldList.length, newList.length);
      for (let i = 0; i < paired; i++) {
        const snapshot = oldList[i];
        const element = newList[i];
        const morph = leafKind(element) === snapshot.kind ? createLeafMorph(element, snapshot) : null;
        if (morph) {
          tickMorph(morph, 0);
          tasks.push({ type: "morph", morph });
        } else {
          tasks.push(buildLeafExit(snapshot, svgRoot));
          tasks.push(buildLeafEnter(element));
        }
      }
      for (let i = paired; i < oldList.length; i++)
        tasks.push(buildLeafExit(oldList[i], svgRoot));
      for (let i = paired; i < newList.length; i++)
        tasks.push(buildLeafEnter(newList[i]));
    }
    return tasks;
  }
  function containsMatchedId(ids, matchedIds) {
    for (const id of ids) if (matchedIds.has(id)) return true;
    return false;
  }
  var NON_RENDERING_TAGS = /* @__PURE__ */ new Set([
    "defs",
    "style",
    "metadata",
    "title",
    "desc"
  ]);
  function buildCrossfadeTasks(svgRoot, oldChildren, newChildren, matchedIds) {
    const oldHtml = new Set(oldChildren.map((child) => child.html));
    const newHtml = new Set(newChildren.map((child) => child.html));
    const newChildElements = Array.from(svgRoot.children);
    const tasks = [];
    for (const child of oldChildren) {
      if (NON_RENDERING_TAGS.has(child.element.tagName)) continue;
      if (containsMatchedId(child.ids, matchedIds)) continue;
      if (newHtml.has(child.html)) continue;
      const clone = child.element;
      if (!(clone instanceof SVGGraphicsElement)) continue;
      svgRoot.insertBefore(clone, newChildElements[child.index] ?? null);
      const startOpacity = parseFloat(
        clone.style.opacity || clone.getAttribute("opacity") || "1"
      );
      tasks.push({
        type: "exit",
        element: clone,
        startOpacity: Number.isFinite(startOpacity) ? startOpacity : 1
      });
    }
    for (const child of newChildren) {
      if (NON_RENDERING_TAGS.has(child.element.tagName)) continue;
      if (containsMatchedId(child.ids, matchedIds)) continue;
      if (oldHtml.has(child.html)) continue;
      const element = child.element;
      if (!(element instanceof SVGGraphicsElement)) continue;
      element.style.opacity = "0";
      tasks.push({
        type: "fadeIn",
        element,
        targetOpacity: parseFloat(element.getAttribute("opacity") ?? "1")
      });
    }
    return tasks;
  }
  function matchedContainingChildIds(children, matchedIds) {
    const ids = /* @__PURE__ */ new Set();
    for (const child of children)
      if (containsMatchedId(child.ids, matchedIds))
        for (const id of child.ids) ids.add(id);
    return ids;
  }
  function buildOrphanTasks(svgRoot, oldLeaves, oldChildren, newChildren, matchedIds) {
    const oldScope = matchedContainingChildIds(oldChildren, matchedIds);
    const newScope = matchedContainingChildIds(newChildren, matchedIds);
    const isOrphan = (ancestorIds, scope) => !nearestMatchedId(ancestorIds, matchedIds) && ancestorIds.some((id) => scope.has(id));
    const newLeaves = Array.from(
      svgRoot.querySelectorAll(LEAF_SELECTOR)
    ).filter((el) => el.getScreenCTM());
    const oldHtml = new Set(oldLeaves.leaves.map((l) => l.clone.outerHTML));
    const newHtml = new Set(newLeaves.map((el) => el.outerHTML));
    const tasks = [];
    for (const leaf of oldLeaves.leaves)
      if (isOrphan(leaf.ancestorIds, oldScope) && !newHtml.has(leaf.clone.outerHTML))
        tasks.push(buildLeafExit(leaf, svgRoot));
    for (const el of newLeaves)
      if (isOrphan(ancestorIdChain(el), newScope) && !oldHtml.has(el.outerHTML))
        tasks.push(buildLeafEnter(el));
    return tasks;
  }
  function buildTasks(svgRoot, oldLeaves, oldChildren) {
    const newIds = collectIds(svgRoot);
    const matchedIds = /* @__PURE__ */ new Set();
    for (const id of oldLeaves.ids) if (newIds.has(id)) matchedIds.add(id);
    const newChildren = Array.from(svgRoot.children).map(
      (child, index) => ({
        element: child,
        html: child.outerHTML,
        ids: collectIds(child),
        index
      })
    );
    const orphanTasks = buildOrphanTasks(
      svgRoot,
      oldLeaves,
      oldChildren,
      newChildren,
      matchedIds
    );
    return [
      ...buildLeafTasks(svgRoot, oldLeaves, matchedIds),
      ...orphanTasks,
      ...buildCrossfadeTasks(svgRoot, oldChildren, newChildren, matchedIds)
    ];
  }
  function matrixToSvgTransform(m) {
    return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
  }
  function applyColorAttributes(morph, easedProgress) {
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
      const fromValue = morph.fromAttributes[attribute];
      const toValue = morph.toAttributes[attribute];
      if (fromValue !== void 0 && toValue !== void 0)
        morph.element.style.setProperty(
          attribute,
          interpolateAttribute(
            attribute,
            fromValue,
            toValue,
            easedProgress
          )
        );
    }
  }
  function applyBox(morph, easedProgress) {
    const frame = interpolateAffine(
      morph.fromComp,
      morph.toComp,
      easedProgress
    );
    const localToScreen = frame.multiply(morph.bToInverse);
    morph.element.setAttribute(
      "transform",
      matrixToSvgTransform(morph.parentInverse.multiply(localToScreen))
    );
    const curScaleX = matrixScaleX(localToScreen);
    const curScaleY = matrixScaleY(localToScreen);
    const lerp2 = (from, to) => from + (to - from) * easedProgress;
    const rxFrom = morph.fromLengths.rx;
    const rxTo = morph.toLengths.rx;
    if (rxFrom !== void 0 && rxTo !== void 0) {
      const ryFrom = morph.fromLengths.ry ?? rxFrom;
      const ryTo = morph.toLengths.ry ?? rxTo;
      const rxScreen = lerp2(
        rxFrom * morph.fromScreenScale.x,
        rxTo * morph.toScreenScale.x
      );
      const ryScreen = lerp2(
        ryFrom * morph.fromScreenScale.y,
        ryTo * morph.toScreenScale.y
      );
      morph.element.setAttribute("rx", String(rxScreen / curScaleX));
      morph.element.setAttribute("ry", String(ryScreen / curScaleY));
    }
    const swFrom = morph.fromLengths["stroke-width"];
    const swTo = morph.toLengths["stroke-width"];
    if (swFrom !== void 0 && swTo !== void 0) {
      const fromUniform = Math.sqrt(
        morph.fromScreenScale.x * morph.fromScreenScale.y
      );
      const toUniform = Math.sqrt(
        morph.toScreenScale.x * morph.toScreenScale.y
      );
      const curUniform = Math.sqrt(Math.max(curScaleX * curScaleY, 1e-6));
      const swScreen = lerp2(swFrom * fromUniform, swTo * toUniform);
      morph.element.setAttribute(
        "stroke-width",
        String(swScreen / curUniform)
      );
    }
  }
  function applyText(morph, easedProgress) {
    const lerp2 = (from, to) => from + (to - from) * easedProgress;
    const target = new DOMMatrix().translate(
      lerp2(morph.from.anchorX, morph.to.anchorX),
      lerp2(morph.from.anchorY, morph.to.anchorY)
    ).rotate(lerp2(morph.from.rotation, morph.to.rotation) * 180 / Math.PI).scale(lerp2(morph.from.scale, morph.to.scale)).translate(-morph.anchorLocalX, -morph.anchorLocalY);
    const local = morph.parentCTM.inverse().multiply(target);
    morph.element.setAttribute("transform", matrixToSvgTransform(local));
    morph.element.style.fontSize = `${lerp2(morph.from.fontSize, morph.to.fontSize)}px`;
  }
  function applyLine(morph, easedProgress) {
    const lerp2 = (from, to) => from + (to - from) * easedProgress;
    const element = morph.element;
    element.setAttribute("x1", String(lerp2(morph.from.x1, morph.to.x1)));
    element.setAttribute("y1", String(lerp2(morph.from.y1, morph.to.y1)));
    element.setAttribute("x2", String(lerp2(morph.from.x2, morph.to.x2)));
    element.setAttribute("y2", String(lerp2(morph.from.y2, morph.to.y2)));
    if (morph.fromStrokeWidth !== void 0 && morph.toStrokeWidth !== void 0)
      element.setAttribute(
        "stroke-width",
        String(lerp2(morph.fromStrokeWidth, morph.toStrokeWidth))
      );
  }
  function tickMorph(morph, easedProgress) {
    if (morph.kind === "box") applyBox(morph, easedProgress);
    else if (morph.kind === "text") applyText(morph, easedProgress);
    else applyLine(morph, easedProgress);
    applyColorAttributes(morph, easedProgress);
  }
  function tickTasks(tasks, rawProgress) {
    const easedProgress = easeInOut(rawProgress);
    for (const task of tasks) {
      if (task.type === "morph") {
        tickMorph(task.morph, easedProgress);
      } else if (task.type === "fadeIn") {
        const fadeProgress = easeInOut(
          Math.max(0, Math.min((rawProgress - 0.3) / 0.7, 1))
        );
        task.element.style.opacity = String(
          fadeProgress * task.targetOpacity
        );
      } else {
        const exitProgress = easeInOut(Math.min(rawProgress / 0.7, 1));
        task.element.style.opacity = String(
          task.startOpacity * (1 - exitProgress)
        );
      }
    }
  }
  function finalizeMorph(morph) {
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
      morph.element.style.removeProperty(attribute);
    }
    if (morph.kind === "line") {
      morph.element.setAttribute("x1", String(morph.to.x1));
      morph.element.setAttribute("y1", String(morph.to.y1));
      morph.element.setAttribute("x2", String(morph.to.x2));
      morph.element.setAttribute("y2", String(morph.to.y2));
      if (morph.toStrokeWidth !== void 0)
        morph.element.setAttribute(
          "stroke-width",
          String(morph.toStrokeWidth)
        );
      return;
    }
    if (morph.kind === "text") {
      if (morph.originalTransform)
        morph.element.setAttribute("transform", morph.originalTransform);
      else morph.element.removeAttribute("transform");
      morph.element.style.fontSize = "";
      return;
    }
    if (morph.originalTransform)
      morph.element.setAttribute("transform", morph.originalTransform);
    else morph.element.removeAttribute("transform");
    morph.element.style.removeProperty("transform-box");
    morph.element.style.removeProperty("transform-origin");
    if (morph.toLengths.rx !== void 0)
      morph.element.setAttribute("rx", String(morph.toLengths.rx));
    if (morph.toLengths.ry !== void 0)
      morph.element.setAttribute("ry", String(morph.toLengths.ry));
    else if (morph.fromLengths.rx !== void 0)
      morph.element.removeAttribute("ry");
    if (morph.toLengths["stroke-width"] !== void 0)
      morph.element.setAttribute(
        "stroke-width",
        String(morph.toLengths["stroke-width"])
      );
  }
  function finalizeTasks(tasks) {
    for (const task of tasks) {
      if (task.type === "morph") finalizeMorph(task.morph);
      else if (task.type === "exit") task.element.remove();
      else {
        task.element.style.opacity = "";
        if (task.element.getAttribute("style") === "")
          task.element.removeAttribute("style");
      }
    }
  }
  var MorphTransition = class {
    oldLeaves = { ids: /* @__PURE__ */ new Set(), leaves: [] };
    oldChildren = [];
    tasks = [];
    driver = new ProgressDriver();
    stage;
    oldHtml = "";
    // Snapshot the outgoing slide before swap() replaces the DOM, and keep its
    // markup so a full reversal can restore the real previous slide.
    prepare({ stage: stage4 }) {
      this.stage = stage4;
      this.oldHtml = stage4.innerHTML;
      const beforeSvg = stage4.querySelector("svg");
      this.oldLeaves = beforeSvg ? snapshotLeaves(beforeSvg) : { ids: /* @__PURE__ */ new Set(), leaves: [] };
      this.oldChildren = beforeSvg ? snapshotTopLevelChildren(beforeSvg) : [];
    }
    async start({
      stage: stage4,
      params,
      signal
    }) {
      if (params.duration <= 0) return;
      const svgRoot = stage4.querySelector("svg");
      if (!svgRoot) return;
      this.tasks = buildTasks(svgRoot, this.oldLeaves, this.oldChildren);
      await this.driver.animateTo(
        1,
        params.duration,
        signal,
        (progress) => tickTasks(this.tasks, progress)
      );
      if (!signal.aborted) this.settle();
    }
    // Reverse direction mid-flight by retargeting the progress: the same tasks run
    // backward, so every property retraces its exact path. No re-snapshot of the
    // intermediate DOM, hence no colour or corner-radius jump and no crossfade
    // darkening across repeated reversals.
    async reverse({
      params,
      signal
    }) {
      const target = this.driver.heading === 1 ? 0 : 1;
      await this.driver.animateTo(
        target,
        params.duration,
        signal,
        (progress) => tickTasks(this.tasks, progress)
      );
      if (!signal.aborted) this.settle();
    }
    cancel(_ctx) {
      for (const task of this.tasks)
        if (task.type === "exit") task.element.remove();
    }
    // progress 1 → the new slide is fully formed; snap it to its natural state.
    // progress 0 → reversed all the way back; the morphed elements only *look* like
    // the previous slide, so restore the real one.
    settle() {
      if (this.driver.value >= 1) finalizeTasks(this.tasks);
      else this.stage.innerHTML = this.oldHtml;
    }
  };

  // src/ts/presenter/transitions.ts
  var stage2 = document.getElementById("stage");
  var CUT = { type: "cut", duration: 0 };
  var registry = /* @__PURE__ */ new Map();
  function registerTransition(name, factory) {
    registry.set(name, factory);
  }
  var liveInstance = null;
  var liveController = null;
  var liveParams = null;
  var liveSettle = null;
  function cancelInflight(callThen) {
    if (!liveController) return;
    const ctrl = liveController;
    const inst = liveInstance;
    const params = liveParams;
    const settle = liveSettle;
    liveController = null;
    liveInstance = null;
    liveParams = null;
    liveSettle = null;
    ctrl.abort();
    inst?.cancel?.({ stage: stage2, params });
    settle(callThen);
  }
  function inflightDirection() {
    if (!liveParams) return null;
    return liveParams.reverse ? "backward" : "forward";
  }
  function snapInflight() {
    cancelInflight(true);
    stage2.innerHTML = state.slides.length ? state.slides[state.slideIndex].svg : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
    applyCurrentStepInstant();
    updateStatus();
  }
  function makeLayer() {
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
    layer.style.padding = getComputedStyle(stage2).padding;
    return layer;
  }
  function sizeLayerChild(layer) {
    const child = layer.firstElementChild;
    if (child) {
      child.style.width = "100%";
      child.style.height = "100%";
    }
  }
  function dirAxis(dir) {
    return dir === "up" || dir === "down" ? "Y" : "X";
  }
  function incomingSign(dir) {
    return dir === "left" || dir === "up" ? 1 : -1;
  }
  function flipDir(dir) {
    return { left: "right", right: "left", up: "down", down: "up" }[dir] ?? dir;
  }
  var ProgressTransition = class {
    constructor(render) {
      this.render = render;
    }
    render;
    oldLayer;
    newLayer;
    outgoingHtml = "";
    stageStyleText = "";
    settled = false;
    driver = new ProgressDriver();
    ease = (progress) => progress;
    // Captured at start() and used for every frame, including reverse(). The
    // geometry must not change when direction flips — the progress value alone
    // carries the reversal — so reverse()'s own (direction-flipped) params are
    // ignored for painting.
    startParams;
    prepare() {
      this.outgoingHtml = stage2.innerHTML;
      this.stageStyleText = stage2.style.cssText;
    }
    async start({
      params,
      signal
    }) {
      if (params.duration <= 0) return;
      this.startParams = params;
      this.buildLayers();
      this.ease = cubicBezierEasing(params.easing);
      this.paint(0);
      await this.driver.animateTo(
        1,
        params.duration,
        signal,
        (value) => this.paint(value)
      );
      if (!signal.aborted) this.settle();
    }
    async reverse({
      signal
    }) {
      const target = this.driver.heading === 1 ? 0 : 1;
      await this.driver.animateTo(
        target,
        this.startParams.duration,
        signal,
        (value) => this.paint(value)
      );
      if (!signal.aborted) this.settle();
    }
    cancel() {
      this.teardown(this.newLayer);
    }
    paint(value) {
      this.render(
        { stage: stage2, oldLayer: this.oldLayer, newLayer: this.newLayer },
        this.ease(value),
        this.startParams
      );
    }
    buildLayers() {
      this.settled = false;
      const newLayer = makeLayer();
      while (stage2.firstChild) newLayer.appendChild(stage2.firstChild);
      sizeLayerChild(newLayer);
      stage2.appendChild(newLayer);
      this.newLayer = newLayer;
      const oldLayer = makeLayer();
      oldLayer.innerHTML = this.outgoingHtml;
      sizeLayerChild(oldLayer);
      stage2.appendChild(oldLayer);
      this.oldLayer = oldLayer;
    }
    settle() {
      this.teardown(this.driver.value >= 1 ? this.newLayer : this.oldLayer);
    }
    // Replace the stage's content with just the shown slide, dropping both layers
    // and anything else a render added (the fade colour backdrop) in one step, and
    // restore the stage's pre-transition inline style. Idempotent; skipped when no
    // layers were built (duration 0), where the slide is already in place.
    teardown(shownLayer) {
      if (this.settled) return;
      this.settled = true;
      if (shownLayer) stage2.replaceChildren(...shownLayer.children);
      stage2.style.cssText = this.stageStyleText;
    }
  };
  function registerProgressTransition(name, render) {
    registerTransition(name, () => new ProgressTransition(render));
  }
  var CutTransition = class {
    async start() {
    }
  };
  var crossfadeRender = ({ oldLayer }, progress) => {
    oldLayer.style.opacity = String(1 - progress);
  };
  var pushRender = ({ oldLayer, newLayer }, progress, params) => {
    const direction = params.reverse ? flipDir(params.direction ?? "left") : params.direction ?? "left";
    const axis = dirAxis(direction);
    const sign = incomingSign(direction);
    oldLayer.style.transform = `translate${axis}(${-progress * 100 * sign}%)`;
    newLayer.style.transform = `translate${axis}(${(1 - progress) * 100 * sign}%)`;
  };
  var coverRender = ({ oldLayer }, progress, params) => {
    const direction = params.direction ?? "left";
    const axis = dirAxis(direction);
    const sign = incomingSign(direction);
    const exitSign = params.reverse ? sign : -sign;
    oldLayer.style.transform = `translate${axis}(${exitSign * 100 * progress}%)`;
  };
  var zoomRender = ({ oldLayer, newLayer }, progress, params) => {
    const amount = params.amount ?? 0.6;
    oldLayer.style.transformOrigin = "center";
    newLayer.style.transformOrigin = "center";
    oldLayer.style.opacity = String(1 - progress);
    newLayer.style.opacity = String(progress);
    if (params.reverse) {
      oldLayer.style.transform = `scale(${1 - amount * progress})`;
      newLayer.style.transform = `scale(${1 + amount - amount * progress})`;
    } else {
      oldLayer.style.transform = `scale(${1 + amount * progress})`;
      newLayer.style.transform = `scale(${1 - amount + amount * progress})`;
    }
  };
  var SVG_NS = "http://www.w3.org/2000/svg";
  function makeFadeBackdrop(slideSvg, color) {
    const layer = makeLayer();
    layer.dataset.fadeBackdrop = "1";
    const viewBox = slideSvg?.getAttribute("viewBox") ?? "0 0 1920 1080";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute(
      "preserveAspectRatio",
      slideSvg?.getAttribute("preserveAspectRatio") ?? "xMidYMid meet"
    );
    const [, , width, height] = viewBox.split(/[\s,]+/).map(Number);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", String(width || 0));
    rect.setAttribute("height", String(height || 0));
    rect.setAttribute("fill", color);
    svg.appendChild(rect);
    layer.appendChild(svg);
    sizeLayerChild(layer);
    return layer;
  }
  var fadeRender = ({ stage: stageElement, oldLayer, newLayer }, progress, params) => {
    const existing = newLayer.previousElementSibling;
    if (!(existing instanceof HTMLElement) || existing.dataset.fadeBackdrop !== "1") {
      const backdrop = makeFadeBackdrop(
        newLayer.querySelector("svg"),
        params.color ?? "#000000"
      );
      stageElement.insertBefore(backdrop, newLayer);
    }
    oldLayer.style.opacity = String(Math.max(0, 1 - progress * 2));
    newLayer.style.opacity = String(Math.max(0, progress * 2 - 1));
  };
  var WIPE_CLIP = {
    left: (percent) => `inset(0 0 0 ${percent}%)`,
    right: (percent) => `inset(0 ${percent}% 0 0)`,
    up: (percent) => `inset(0 0 ${percent}% 0)`,
    down: (percent) => `inset(${percent}% 0 0 0)`
  };
  var wipeRender = ({ oldLayer }, progress, params) => {
    const direction = params.reverse ? flipDir(params.direction ?? "left") : params.direction ?? "left";
    const clip = WIPE_CLIP[direction] ?? WIPE_CLIP.left;
    oldLayer.style.clipPath = clip(progress * 100);
  };
  registerTransition("cut", () => new CutTransition());
  registerProgressTransition("crossfade", crossfadeRender);
  registerProgressTransition("push", pushRender);
  registerProgressTransition("cover", coverRender);
  registerProgressTransition("zoom", zoomRender);
  registerProgressTransition("fade", fadeRender);
  registerProgressTransition("wipe", wipeRender);
  registerTransition("morph", () => new MorphTransition());
  function loadSlide(then = null, transition = null) {
    const params = transition ?? state.transitions[state.slideIndex] ?? CUT;
    const settleContent = () => {
      applyCurrentStepInstant();
      updateStatus();
    };
    const swap = () => {
      stage2.innerHTML = state.slides.length ? state.slides[state.slideIndex].svg : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
      settleContent();
    };
    const canReverse = liveInstance?.reverse != null && liveParams != null && liveParams.type === params.type && Boolean(liveParams.reverse) !== Boolean(params.reverse);
    if (canReverse) {
      const inst2 = liveInstance;
      const ctrl2 = liveController;
      const prevSettle = liveSettle;
      ctrl2.abort();
      liveController = null;
      liveInstance = null;
      liveParams = null;
      liveSettle = null;
      prevSettle(true);
      const newCtrl = new AbortController();
      let done2 = false;
      const settle2 = (callThen) => {
        if (done2) return;
        done2 = true;
        if (liveController === newCtrl) {
          liveController = null;
          liveInstance = null;
          liveParams = null;
          liveSettle = null;
        }
        if (callThen) then?.();
      };
      liveController = newCtrl;
      liveInstance = inst2;
      liveParams = params;
      liveSettle = settle2;
      inst2.reverse({ stage: stage2, params, signal: newCtrl.signal }).then(() => {
        if (!newCtrl.signal.aborted) settleContent();
        settle2(true);
      }).catch(() => settle2(false));
      return;
    }
    cancelInflight(true);
    const makeTransition = registry.get(params.type);
    if (!makeTransition) {
      swap();
      then?.();
      return;
    }
    const inst = makeTransition();
    commitStepStyles(stage2);
    inst.prepare?.({ stage: stage2, params });
    const ctrl = new AbortController();
    let done = false;
    const settle = (callThen) => {
      if (done) return;
      done = true;
      if (liveController === ctrl) {
        liveController = null;
        liveInstance = null;
        liveParams = null;
        liveSettle = null;
      }
      if (callThen) then?.();
    };
    liveController = ctrl;
    liveInstance = inst;
    liveParams = params;
    liveSettle = settle;
    swap();
    inst.start({ stage: stage2, params, signal: ctrl.signal }).then(() => settle(true)).catch(() => settle(false));
  }

  // src/ts/presenter/ui.ts
  var curtain = document.getElementById("curtain");
  var help = document.getElementById("help");
  var errorOverlay = document.getElementById("error-overlay");
  var errorMsg = document.getElementById("error-msg");
  var logBanner = document.getElementById("log-banner");
  var logList = document.getElementById("log-list");
  var logClose = document.getElementById("log-close");
  var logIndicator = document.getElementById("log-indicator");
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
  var LOG_LEVEL_ORDER = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3
  };
  var LOG_ICON = {
    debug: "\u25E6",
    info: "\u2139\uFE0E",
    warning: "\u26A0\uFE0E",
    error: "\u2716\uFE0E"
  };
  function highestLevel(logs) {
    return logs.reduce(
      (top, e) => (LOG_LEVEL_ORDER[e.level] ?? 0) > (LOG_LEVEL_ORDER[top] ?? 0) ? e.level : top,
      logs[0].level
    );
  }
  var logSignature = "";
  function showLogs(logs) {
    if (logs.length === 0) {
      hideLogs();
      logSignature = "";
      logIndicator.removeAttribute("data-level");
      return;
    }
    const signature = JSON.stringify(logs);
    const changed = signature !== logSignature;
    logSignature = signature;
    logList.replaceChildren(
      ...logs.map((entry) => {
        const li = document.createElement("li");
        li.className = `log-${entry.level}`;
        const ico = document.createElement("span");
        ico.className = "log-ico";
        ico.textContent = LOG_ICON[entry.level] ?? LOG_ICON.warning;
        const msg = document.createElement("span");
        msg.textContent = entry.message;
        li.append(ico, msg);
        return li;
      })
    );
    logIndicator.dataset.level = highestLevel(logs);
    if (changed) logBanner.classList.add("visible");
  }
  function hideLogs() {
    logBanner.classList.remove("visible");
  }
  function toggleLogs() {
    if (logBanner.classList.contains("visible")) {
      hideLogs();
    } else if (logIndicator.hasAttribute("data-level")) {
      logBanner.classList.add("visible");
    }
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
  var _mhudTimer;
  function showMobileHud() {
    document.body.classList.add("mobile-hud-visible");
    clearTimeout(_mhudTimer);
    _mhudTimer = setTimeout(() => {
      document.body.classList.remove("mobile-hud-visible");
      _mhudTimer = void 0;
    }, 3e3);
  }
  function toggleMobileHud() {
    if (document.body.classList.contains("mobile-hud-visible")) {
      document.body.classList.remove("mobile-hud-visible");
      clearTimeout(_mhudTimer);
      _mhudTimer = void 0;
    } else {
      showMobileHud();
    }
  }
  document.getElementById("mobile-hud").addEventListener("pointerdown", showMobileHud, { passive: true });
  logClose.addEventListener("click", hideLogs);
  logIndicator.addEventListener("click", () => {
    logBanner.classList.add("visible");
  });
  curtain.addEventListener("click", hideCurtain);
  help.addEventListener("click", (e) => {
    if (e.target === help) toggleHelp();
  });

  // src/ts/presenter/websocket.ts
  var wsDot = document.getElementById("ws-dot");
  var overviewEl = document.getElementById("overview");
  var overviewGridEl = document.getElementById("overview-grid");
  var SYNC_MODE_KEY = "inkflow-sync-mode";
  function isSyncMode(v) {
    return v === "two-way" || v === "present" || v === "follow" || v === "solo";
  }
  function sends() {
    return state.syncMode === "two-way" || state.syncMode === "present";
  }
  function receives() {
    return state.syncMode === "two-way" || state.syncMode === "follow";
  }
  function loadSyncMode() {
    let stored = null;
    try {
      stored = sessionStorage.getItem(SYNC_MODE_KEY);
    } catch (_) {
    }
    if (isSyncMode(stored)) state.syncMode = stored;
  }
  function applySyncMode(mode) {
    state.syncMode = mode;
    try {
      sessionStorage.setItem(SYNC_MODE_KEY, mode);
    } catch (_) {
    }
    if (receives()) requestSync();
  }
  function requestSync() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN)
      state.ws.send(JSON.stringify({ type: "sync-request" }));
  }
  function sendNav(transition) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state._syncingFromServer || !sends())
      return;
    state.ws.send(
      JSON.stringify({
        type: "nav",
        slideIndex: state.slideIndex,
        step: state.step,
        ...transition ? { transition } : {}
      })
    );
  }
  function sendSnap() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state._syncingFromServer || !sends())
      return;
    state.ws.send(
      JSON.stringify({
        type: "nav",
        slideIndex: state.slideIndex,
        step: state.step,
        snap: true
      })
    );
  }
  function connectWS(wsPort, authoritative) {
    if (!wsPort) return;
    state.ws = new WebSocket(`ws://localhost:${wsPort}`);
    let firstPositionPending = false;
    state.ws.onopen = () => {
      wsDot.className = "connected";
      const assert = authoritative && sends();
      firstPositionPending = assert;
      if (assert) sendNav();
    };
    state.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.type === "update") {
        state.slides = msg.slides;
        state.transitions = msg.transitions;
        hideError();
        showLogs(msg.logs ?? []);
        if (overviewEl.classList.contains("visible")) {
          overviewEl.classList.remove("visible");
          overviewGridEl.innerHTML = "";
        }
        state.slideIndex = Math.min(
          state.slideIndex,
          Math.max(0, state.slides.length - 1)
        );
        state.step = Math.min(state.step, maxStep2());
        loadSlide(null, CUT);
        renderPv();
      } else if (msg.type === "error") {
        showError(msg.message);
      } else if (msg.type === "position") {
        if (!receives()) return;
        if (msg.snap) {
          snapInflight();
          return;
        }
        if (firstPositionPending) {
          firstPositionPending = false;
          return;
        }
        const newIndex = Math.min(
          Math.max(0, msg.slideIndex | 0),
          Math.max(0, state.slides.length - 1)
        );
        const newStep = Math.max(0, msg.step | 0);
        if (newIndex === state.slideIndex && newStep === state.step) return;
        if (newIndex === state.slideIndex) {
          const prevStep = state.step;
          state._syncingFromServer = true;
          state.step = newStep;
          if (Math.abs(newStep - prevStep) === 1) applyCurrentStep();
          else applyCurrentStepInstant();
          state._syncingFromServer = false;
          renderPvNext();
          updatePvInfo();
          return;
        }
        state._syncingFromServer = true;
        state.slideIndex = newIndex;
        state.step = newStep;
        loadSlide(() => {
          if (state.step > 0) applyCurrentStep();
          state._syncingFromServer = false;
        }, msg.transition ?? null);
        renderPv();
      }
    };
    state.ws.onclose = () => {
      wsDot.className = "";
      state.ws = null;
      setTimeout(() => connectWS(wsPort, true), 2e3);
    };
    state.ws.onerror = () => state.ws?.close();
  }

  // src/ts/presenter/syncmenu.ts
  var btnSync = document.getElementById("btn-sync");
  var syncMenu = document.getElementById("sync-menu");
  var syncWrap = btnSync.closest(".sync-wrap");
  var enabled = false;
  var SYNC_ORDER = ["two-way", "present", "follow", "solo"];
  var SYNC_LABELS = {
    "two-way": "Two-way (send + receive)",
    present: "Present (send only)",
    follow: "Follow (receive only)",
    solo: "Solo (no sync)"
  };
  function renderSyncButton() {
    btnSync.dataset.mode = state.syncMode;
    const label = SYNC_LABELS[state.syncMode];
    btnSync.title = `Sync: ${label} (s)`;
    btnSync.setAttribute("aria-label", `Sync mode: ${label}`);
    for (const row of syncMenu.querySelectorAll(".sync-row")) {
      const active = row.dataset.mode === state.syncMode;
      row.classList.toggle("active", active);
      row.setAttribute("aria-checked", String(active));
    }
  }
  function setSyncMode(mode) {
    applySyncMode(mode);
    renderSyncButton();
    closeMenu();
  }
  function cycleSyncMode() {
    if (!enabled) return;
    const i = SYNC_ORDER.indexOf(state.syncMode);
    setSyncMode(SYNC_ORDER[(i + 1) % SYNC_ORDER.length]);
  }
  function onDocClick(e) {
    const t = e.target;
    if (!btnSync.contains(t) && !syncMenu.contains(t)) closeMenu();
  }
  function onKeydown(e) {
    if (e.key === "Escape") {
      closeMenu();
      btnSync.focus();
    }
  }
  function openMenu() {
    syncMenu.classList.add("open");
    btnSync.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
  }
  function closeMenu() {
    if (!syncMenu.classList.contains("open")) return;
    syncMenu.classList.remove("open");
    btnSync.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKeydown);
  }
  function toggleMenu() {
    if (syncMenu.classList.contains("open")) closeMenu();
    else openMenu();
  }
  function initSyncMenu(wsPort) {
    if (!wsPort) {
      syncWrap.style.display = "none";
      document.getElementById("help-sync-row").style.display = "none";
      return;
    }
    enabled = true;
    btnSync.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    for (const row of syncMenu.querySelectorAll(".sync-row"))
      row.addEventListener(
        "click",
        () => setSyncMode(row.dataset.mode)
      );
    renderSyncButton();
  }

  // src/ts/presenter/laser.ts
  var SVG_NS2 = "http://www.w3.org/2000/svg";
  var stageWrap = document.getElementById("stage-wrap");
  var overlay = document.getElementById(
    "laser-overlay"
  );
  var dot = document.getElementById("laser-dot");
  var DOT_RADIUS = 8;
  var isDrawing = false;
  var currentPath = null;
  var currentPoints = [];
  var pendingClientX = 0;
  var pendingClientY = 0;
  var rafId = null;
  var stageRect = stageWrap.getBoundingClientRect();
  new ResizeObserver(() => {
    stageRect = stageWrap.getBoundingClientRect();
  }).observe(stageWrap);
  function flushFrame() {
    rafId = null;
    const x = pendingClientX - stageRect.left;
    const y = pendingClientY - stageRect.top;
    dot.style.transform = `translate(${x - DOT_RADIUS}px, ${y - DOT_RADIUS}px)`;
    if (isDrawing && currentPath && currentPoints.length > 0) {
      currentPath.setAttribute("d", currentPoints.join(" "));
    }
  }
  stageWrap.addEventListener("pointermove", (e) => {
    if (!state._laserMode) return;
    pendingClientX = e.clientX;
    pendingClientY = e.clientY;
    if (isDrawing) {
      const x = e.clientX - stageRect.left;
      const y = e.clientY - stageRect.top;
      currentPoints.push(`L ${x} ${y}`);
    }
    if (rafId === null) rafId = requestAnimationFrame(flushFrame);
  });
  stageWrap.addEventListener("pointerdown", (e) => {
    if (!state._laserMode) return;
    if (e.target.closest("#overview")) return;
    stageWrap.setPointerCapture(e.pointerId);
    const x = e.clientX - stageRect.left;
    const y = e.clientY - stageRect.top;
    currentPath = document.createElementNS(SVG_NS2, "path");
    currentPoints = [`M ${x} ${y}`];
    currentPath.classList.add("laser-trail");
    overlay.appendChild(currentPath);
    isDrawing = true;
  });
  stageWrap.addEventListener("pointerup", finalizeDraw);
  stageWrap.addEventListener("pointercancel", finalizeDraw);
  function finalizeDraw() {
    if (!isDrawing || !currentPath) return;
    isDrawing = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      flushFrame();
    }
    currentPath.classList.add("trail");
    const path = currentPath;
    path.addEventListener("animationend", () => path.remove(), { once: true });
    currentPath = null;
    currentPoints = [];
  }
  function toggleLaser() {
    state._laserMode = !state._laserMode;
    document.body.classList.toggle("laser-mode", state._laserMode);
    if (!state._laserMode) finalizeDraw();
  }

  // src/ts/presenter/navigation.ts
  function gotoId(id) {
    const idx = state.slides.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    history.pushState(null, "", window.location.href);
    state.slideIndex = idx;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
    return true;
  }
  function advance() {
    if (inflightDirection() === "forward") {
      snapInflight();
      sendSnap();
      return;
    }
    if (state.step < maxStep2()) {
      state.step++;
      applyCurrentStep();
      renderPvNext();
      updatePvInfo();
    } else if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      loadSlide();
      renderPv();
    }
    sendNav();
  }
  function retreat() {
    if (inflightDirection() === "backward") {
      snapInflight();
      sendSnap();
      return;
    }
    if (state.step > 0) {
      state.step--;
      applyCurrentStep();
      renderPvNext();
      updatePvInfo();
    } else if (state.slideIndex > 0) {
      const t = state.transitions[state.slideIndex];
      state.slideIndex--;
      state.step = maxStep2();
      const tReversed = t ? { ...t, reverse: true } : null;
      loadSlide(null, tReversed);
      renderPv();
      sendNav(tReversed);
      return;
    }
    sendNav();
  }
  function nextSlide() {
    if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      loadSlide();
      renderPv();
    }
    sendNav();
  }
  function prevSlide() {
    if (state.slideIndex > 0) {
      const t = state.transitions[state.slideIndex];
      state.slideIndex--;
      state.step = maxStep2();
      const tReversed = t ? { ...t, reverse: true } : null;
      loadSlide(null, tReversed);
      renderPv();
      sendNav(tReversed);
      return;
    }
    sendNav();
  }
  function gotoFirst() {
    history.pushState(null, "", window.location.href);
    state.slideIndex = 0;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
  }
  function gotoLast() {
    history.pushState(null, "", window.location.href);
    state.slideIndex = state.slides.length - 1;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
  }

  // src/ts/presenter/overview.ts
  var overview = document.getElementById("overview");
  var overviewGrid = document.getElementById("overview-grid");
  var stage3 = document.getElementById("stage");
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  function firstSlideViewBox() {
    const svg = state.slides[0]?.svg ?? "";
    const m = svg.match(/viewBox="[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)"/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : [1920, 1080];
  }
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
  }
  function computeCols() {
    const cols = getComputedStyle(overviewGrid).gridTemplateColumns.split(" ").length;
    state._overviewCols = cols || 1;
  }
  function applyOptimalCols() {
    const n = state.slides.length;
    const gap = parseFloat(getComputedStyle(overviewGrid).gap) || 28;
    const availW = overviewGrid.clientWidth;
    const availH = overview.clientHeight - parseFloat(getComputedStyle(overview).paddingTop) - parseFloat(getComputedStyle(overview).paddingBottom);
    const [vbW, vbH] = firstSlideViewBox();
    const ratio = vbH / vbW;
    let cols = n;
    for (let c = 1; c <= n; c++) {
      const thumbW = (availW - (c - 1) * gap) / c;
      const rows = Math.ceil(n / c);
      if (rows * (thumbW * ratio + gap) - gap <= availH) {
        cols = Math.max(2, c);
        break;
      }
    }
    overviewGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
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
    history.pushState(null, "", window.location.href);
    state.slideIndex = state._overviewActive;
    closeOverview();
    state.step = maxStep2();
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
  }
  function computeStageFlip() {
    const activeCell = overviewGrid.children[state._overviewActive];
    if (!activeCell) return null;
    const thumb = activeCell.querySelector(".overview-thumb");
    const el = thumb ?? activeCell;
    const gr = overviewGrid.getBoundingClientRect();
    const cr = el.getBoundingClientRect();
    const sr = stage3.getBoundingClientRect();
    const sp = parseFloat(getComputedStyle(stage3).paddingLeft) || 0;
    const s = Math.min(
      (sr.width - 2 * sp) / cr.width,
      (sr.height - 2 * sp) / cr.height
    );
    const thumbCX = cr.left + cr.width / 2 - gr.left;
    const thumbCY = cr.top + cr.height / 2 - gr.top;
    const stageCX = sr.left + sr.width / 2 - gr.left;
    const stageCY = sr.top + sr.height / 2 - gr.top;
    const ox = (stageCX - thumbCX * s) / (1 - s);
    const oy = (stageCY - thumbCY * s) / (1 - s);
    return { s, ox, oy };
  }
  var scaleDriver = new ProgressDriver();
  var fadeDriver = new ProgressDriver();
  var controller = null;
  var geometry = null;
  function paintScale(progress) {
    if (!geometry) return;
    const scale = geometry.s + (1 - geometry.s) * progress;
    overviewGrid.style.transformOrigin = `${geometry.ox}px ${geometry.oy}px`;
    overviewGrid.style.transform = `scale(${scale})`;
  }
  function setActiveHighlight(visible, durationSeconds) {
    const activeCell = overviewGrid.children[state._overviewActive];
    const thumb = activeCell?.querySelector(".overview-thumb");
    const num = activeCell?.querySelector(".overview-num");
    if (thumb) {
      thumb.style.transition = `outline-color ${durationSeconds}s ease`;
      thumb.style.outlineColor = visible ? "" : "transparent";
    }
    if (num) {
      num.style.transition = `color ${durationSeconds}s ease`;
      num.style.color = visible ? "" : "transparent";
    }
  }
  async function openOverview() {
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
    const [vbW, vbH] = firstSlideViewBox();
    overview.style.setProperty("--thumb-ar", `${vbW} / ${vbH}`);
    state.slides.forEach((s, i) => {
      const cell = document.createElement("div");
      cell.className = "overview-cell";
      cell.dataset.index = String(i);
      cell.innerHTML = `<div class="overview-num">${i + 1}</div><div class="overview-thumb">${s.svg}</div>`;
      overviewGrid.appendChild(cell);
    });
    state._overviewActive = state.slideIndex;
    overviewGrid.querySelectorAll(".overview-thumb").forEach((thumb) => {
      applyStepInstant(thumb, maxStep(thumb));
    });
    await nextFrame();
    applyOptimalCols();
    await nextFrame();
    overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
    computeCols();
    overviewSetActive(state._overviewActive);
    geometry = computeStageFlip();
    const activeCell = overviewGrid.children[state._overviewActive];
    const activeThumb = activeCell?.querySelector(".overview-thumb");
    const activeNum = activeCell?.querySelector(".overview-num");
    if (activeThumb) activeThumb.style.outlineColor = "transparent";
    if (activeNum) activeNum.style.color = "transparent";
    scaleDriver.value = 0;
    paintScale(0);
    await nextFrame();
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    overview.classList.add("visible");
    overview.style.opacity = "1";
    fadeDriver.value = 1;
    setActiveHighlight(true, 0.6);
    const ease = cubicBezierEasing("cubic-bezier(0.22, 1, 0.36, 1)");
    await scaleDriver.animateTo(
      1,
      0.6,
      myController.signal,
      (v) => paintScale(ease(v))
    );
    if (controller === myController) controller = null;
  }
  async function closeOverview() {
    state._overviewActive = state.slideIndex;
    if (controller === null) geometry = computeStageFlip();
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    const { signal } = myController;
    setActiveHighlight(false, 0.35);
    const ease = cubicBezierEasing("cubic-bezier(0.55, 0, 1, 0.45)");
    await scaleDriver.animateTo(0, 0.35, signal, (v) => paintScale(ease(v)));
    if (signal.aborted) return;
    await fadeDriver.animateTo(0, 0.28, signal, (v) => {
      overview.style.opacity = String(v);
    });
    if (signal.aborted) return;
    overview.classList.remove("visible");
    overview.style.opacity = "";
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
    if (controller === myController) controller = null;
  }
  function toggleOverview() {
    overview.classList.contains("visible") ? closeOverview() : openOverview();
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
    applyOptimalCols();
    requestAnimationFrame(() => {
      overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
      computeCols();
    });
  });

  // src/ts/shared/escape.ts
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

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
      (idx, pos) => `<div role="option" data-pos="${pos}" class="${pos === 0 ? "active" : ""}"><span class="pk-num">${idx + 1}</span><span class="pk-title">${escapeHtml(state.slides[idx].title || "")}</span></div>`
    ).join("");
    const active = pickerList.querySelector('[role="option"].active');
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function pickerMoveCursor(delta) {
    if (!state._pickerMatches.length) return;
    state._pickerActive = Math.max(
      0,
      Math.min(state._pickerMatches.length - 1, state._pickerActive + delta)
    );
    pickerList.querySelectorAll('[role="option"]').forEach((opt, i) => {
      opt.classList.toggle("active", i === state._pickerActive);
    });
    const active = pickerList.querySelector('[role="option"].active');
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function pickerCommit() {
    if (!state._pickerMatches.length) return;
    history.pushState(null, "", window.location.href);
    state.slideIndex = state._pickerMatches[state._pickerActive];
    closePicker();
    state.step = maxStep2();
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
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
    const opt = e.target.closest('[role="option"]');
    if (!opt) return;
    const pos = parseInt(opt.dataset.pos, 10);
    state._pickerActive = pos;
    pickerCommit();
  });
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });

  // src/ts/presenter/keyboard.ts
  var stageEl = document.getElementById("stage");
  var isCoarse = () => window.matchMedia("(pointer: coarse)").matches;
  stageEl.addEventListener("click", (e) => {
    const slideLink = e.target.closest?.("[data-inkflow-slide]");
    if (slideLink) {
      gotoId(slideLink.getAttribute("data-inkflow-slide") ?? "");
      return;
    }
    if (e.target.closest?.("a[href]")) return;
    if (isCoarse()) {
      const ratio = e.clientX / window.innerWidth;
      if (ratio < 0.2) retreat();
      else if (ratio > 0.8) advance();
      else toggleMobileHud();
    } else {
      advance();
    }
  });
  document.getElementById("btn-prev").addEventListener("click", retreat);
  document.getElementById("btn-next").addEventListener("click", advance);
  document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  document.getElementById("btn-overview").addEventListener("click", toggleOverview);
  document.getElementById("btn-presenter").addEventListener("click", togglePv);
  document.getElementById("mhud-theme").addEventListener("click", toggleTheme);
  document.getElementById("mhud-fullscreen").addEventListener("click", toggleFullscreen);
  {
    const SWIPE_MIN_PX = 50;
    let startX = 0;
    let startY = 0;
    stageEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      },
      { passive: true }
    );
    stageEl.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
      },
      { passive: false }
    );
    stageEl.addEventListener("touchend", (e) => {
      if (e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
        if (dx < 0) nextSlide();
        else prevSlide();
      }
    });
  }
  var KEYBINDINGS = {
    ArrowRight: { action: advance, preventDefault: true },
    " ": { action: advance, preventDefault: true },
    PageDown: { action: advance, preventDefault: true },
    l: { action: advance, preventDefault: true },
    ArrowLeft: { action: retreat, preventDefault: true },
    Backspace: { action: retreat, preventDefault: true },
    PageUp: { action: retreat, preventDefault: true },
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
    o: { action: toggleOverview, preventDefault: true },
    f: { action: toggleFullscreen },
    b: { action: () => toggleCurtain("black") },
    ".": { action: toggleLaser },
    w: { action: () => toggleCurtain("white") },
    "?": { action: toggleHelp },
    t: { action: toggleTheme },
    p: { action: togglePv },
    m: { action: toggleLogs },
    s: { action: cycleSyncMode }
  };
  var helpEl = document.getElementById("help");
  var overviewEl2 = document.getElementById("overview");
  var pickerEl = document.getElementById("picker");
  var curtainEl = document.getElementById("curtain");
  var logBannerEl = document.getElementById("log-banner");
  document.addEventListener("keydown", (e) => {
    if (helpEl.classList.contains("visible")) {
      if (e.key === "?" || e.key === "Escape" || e.key === "q") {
        toggleHelp();
        return;
      }
      if (e.key !== "t") return;
    }
    if (overviewEl2.classList.contains("visible")) {
      if (e.key === "Escape" || e.key === "q") {
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
      if (e.key === "o") {
        toggleOverview();
        return;
      }
      if (e.key !== "t" && e.key !== "?") return;
    }
    if (pickerEl.classList.contains("visible")) return;
    if (curtainEl.classList.contains("visible")) {
      hideCurtain();
      return;
    }
    if ((e.key === "Escape" || e.key === "q") && logBannerEl.classList.contains("visible")) {
      hideLogs();
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
  var INITIAL_LOGS = __LOGS_JSON__;
  state.slides = INITIAL_SLIDES;
  state.transitions = INITIAL_TRANSITIONS;
  window.inkflow = {
    registerTransition,
    registerProgressTransition,
    setSyncMode
  };
  window.addEventListener("popstate", () => {
    readURL();
    loadSlide(null, CUT);
    renderPv();
  });
  loadSyncMode();
  initSyncMenu(WS_PORT);
  var deepLinked = readURL();
  loadSlide();
  renderPv();
  updatePvClock();
  setInterval(updatePvClock, 1e3);
  if (INITIAL_ERROR) showError(INITIAL_ERROR);
  if (INITIAL_LOGS.length) showLogs(INITIAL_LOGS);
  connectWS(WS_PORT, deepLinked);
})();
