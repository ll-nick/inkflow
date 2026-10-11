"use strict";
(() => {
  // src/ts/shared/viewbox.ts
  var deckCanvas = { w: 1920, h: 1080 };
  function setDeckCanvas(w2, h3) {
    if (w2 > 0 && h3 > 0) deckCanvas = { w: w2, h: h3 };
  }
  function parseViewBox(attr, fallback = `0 0 ${deckCanvas.w} ${deckCanvas.h}`) {
    const parts = (attr ?? "").trim().split(/[\s,]+/).map(Number);
    const valid = parts.length === 4 && parts.every((n3) => Number.isFinite(n3)) && parts[2] > 0 && parts[3] > 0;
    const [x2, y2, w2, h3] = valid ? parts : fallback.split(/[\s,]+/).map(Number);
    return { x: x2, y: y2, w: w2, h: h3 };
  }

  // src/ts/shared/fit.ts
  var MIN_TEXT_FRACTION = 1 / 80;
  var FIT_FLOOR = 0.33;
  var TEXT_SIZE_STEPS = [
    0.5,
    0.67,
    0.8,
    0.9,
    1,
    1.15,
    1.3,
    1.5,
    2
  ];
  var TEXT_SCALE_MIN = 0.25;
  var TEXT_SCALE_MAX = 3;
  var FIT_TOLERANCE = 0.01;
  var SLACK = 1;
  function nextTextSize(current3, direction2) {
    const eps = 1e-6;
    if (direction2 > 0) {
      return TEXT_SIZE_STEPS.find((s2) => s2 > current3 + eps) ?? current3;
    }
    return [...TEXT_SIZE_STEPS].reverse().find((s2) => s2 < current3 - eps) ?? current3;
  }
  function parseTextSize(text) {
    const t2 = text.replace(/\s+/g, "").replace(/%$/, "");
    if (!t2) return null;
    const n3 = Number(t2);
    if (!Number.isFinite(n3)) return null;
    const scale2 = Math.round(n3 * 10) / 1e3;
    return scale2 >= TEXT_SCALE_MIN && scale2 <= TEXT_SCALE_MAX ? scale2 : null;
  }
  function formatTextSize(scale2) {
    return `${Math.round(scale2 * 100)}%`;
  }
  function floorScale(baseSize, minText) {
    if (!(baseSize > 0)) return 1;
    return Math.min(1, Math.max(FIT_FLOOR, minText / baseSize));
  }
  function searchScale(fits, floor, tolerance = FIT_TOLERANCE) {
    if (fits(1)) return { scale: 1, overflow: false };
    const lowest = Math.min(1, Math.max(0, floor));
    if (lowest >= 1 || !fits(lowest)) return { scale: lowest, overflow: true };
    let lo = lowest;
    let hi = 1;
    while (hi - lo > tolerance) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return {
      scale: Math.max(lowest, Math.floor(lo * 1e3) / 1e3),
      overflow: false
    };
  }
  function neededHeight(children2) {
    let total2 = 0;
    for (const c2 of children2) {
      if (c2.inFlow) total2 += c2.height + c2.marginTop + c2.marginBottom;
    }
    return total2;
  }
  var px = (v2) => Number.parseFloat(v2) || 0;
  function slideSvg(el2) {
    let svg = el2.ownerSVGElement ?? null;
    while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
    return svg ?? (el2 instanceof SVGSVGElement ? el2 : null);
  }
  function minTextSize(svg) {
    const own = Number.parseFloat(
      svg.getAttribute("data-inkflow-min-text") ?? ""
    );
    if (own > 0) return own;
    return parseViewBox(svg.getAttribute("viewBox")).h * MIN_TEXT_FRACTION;
  }
  function unitScale(fo) {
    const root2 = slideSvg(fo);
    const a2 = fo.getScreenCTM?.();
    const b2 = root2?.getScreenCTM();
    if (!a2 || !b2) return 1;
    const da = Math.sqrt(Math.abs(a2.a * a2.d - a2.b * a2.c));
    const db = Math.sqrt(Math.abs(b2.a * b2.d - b2.b * b2.c));
    return da > 0 && db > 0 ? da / db : 1;
  }
  function laidOut(wrapper) {
    return Array.from(wrapper.children, (el2) => {
      const s2 = getComputedStyle(el2);
      return {
        height: el2.offsetHeight ?? 0,
        marginTop: px(s2.marginTop),
        marginBottom: px(s2.marginBottom),
        inFlow: s2.display !== "none" && s2.position !== "absolute" && s2.position !== "fixed"
      };
    });
  }
  function overflows(wrapper, content2) {
    const ws2 = getComputedStyle(wrapper);
    const avail = wrapper.clientHeight - px(ws2.paddingTop) - px(ws2.paddingBottom);
    if (neededHeight(laidOut(wrapper)) > avail + SLACK) return true;
    const width = content2.clientWidth;
    for (const el2 of Array.from(content2.querySelectorAll("pre, table"))) {
      const box2 = el2;
      if (box2.localName === "pre") {
        if (box2.scrollWidth > box2.clientWidth + SLACK) return true;
      } else if (box2.offsetWidth > width + SLACK) {
        return true;
      }
    }
    return false;
  }
  function neededBoxHeight(fo) {
    const wrapper = fo.querySelector(
      ":scope > .inkflow-wrapper"
    );
    if (!wrapper) return null;
    const saved = wrapper.style.getPropertyValue("--inkflow-fit-scale");
    wrapper.style.removeProperty("--inkflow-fit-scale");
    const ws2 = getComputedStyle(wrapper);
    const need = px(ws2.paddingTop) + px(ws2.paddingBottom) + px(ws2.borderTopWidth) + px(ws2.borderBottomWidth) + neededHeight(laidOut(wrapper));
    if (saved) wrapper.style.setProperty("--inkflow-fit-scale", saved);
    return need;
  }
  function fitZone(fo, minText) {
    const wrapper = fo.querySelector(
      ":scope > .inkflow-wrapper"
    );
    const content2 = wrapper?.querySelector(
      ":scope > .inkflow-content"
    );
    if (!wrapper || !content2) return null;
    wrapper.style.removeProperty("--inkflow-fit-scale");
    fo.removeAttribute("data-inkflow-fit");
    fo.removeAttribute("data-inkflow-overflow");
    const cs = getComputedStyle(wrapper);
    if (cs.display === "none" || wrapper.clientHeight === 0) return null;
    const apply3 = (scale2) => {
      if (scale2 < 1)
        wrapper.style.setProperty("--inkflow-fit-scale", String(scale2));
      else wrapper.style.removeProperty("--inkflow-fit-scale");
    };
    const fits = (scale2) => {
      apply3(scale2);
      return !overflows(wrapper, content2);
    };
    const off2 = cs.getPropertyValue("--inkflow-fit").trim() === "none";
    const result = off2 ? { scale: 1, overflow: !fits(1) } : searchScale(
      fits,
      floorScale(px(cs.fontSize) * unitScale(fo), minText)
    );
    apply3(result.scale);
    if (result.scale < 1)
      fo.setAttribute("data-inkflow-fit", result.scale.toFixed(3));
    if (result.overflow) fo.setAttribute("data-inkflow-overflow", "");
    return result;
  }
  function fitSlide(root2) {
    if (!root2) return;
    const svg = root2 instanceof SVGSVGElement ? root2 : root2.querySelector("svg");
    if (!svg) return;
    const min = minTextSize(slideSvg(svg) ?? svg);
    for (const wrapper of Array.from(
      svg.querySelectorAll("foreignObject > .inkflow-wrapper")
    )) {
      const fo = wrapper.parentElement;
      if (fo) fitZone(fo, min);
    }
  }
  var pending = /* @__PURE__ */ new Set();
  var scheduled = false;
  function scheduleFit(root2) {
    pending.add(root2);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const roots = [...pending];
      pending.clear();
      for (const r2 of roots) if (r2.isConnected) fitSlide(r2);
    });
  }
  function onFontsLoaded(fn) {
    if (typeof document === "undefined" || !document.fonts) return;
    document.fonts.addEventListener("loadingdone", () => fn());
    void document.fonts.ready.then(() => fn());
  }

  // src/ts/shared/gestures.ts
  var DELTA_LINE = 1;
  var DELTA_PAGE = 2;
  var LINE_PX = 40;
  var PAGE_PX = 800;
  function wheelPixels(delta, mode2, pagePx = PAGE_PX) {
    if (mode2 === DELTA_LINE) return delta * LINE_PX;
    if (mode2 === DELTA_PAGE) return delta * pagePx;
    return delta;
  }
  var PINCH_PER_PX = 0.01;
  var MAX_WHEEL_STEP = Math.log(1.2);
  function wheelZoomLog(deltaY, deltaMode) {
    const z = -wheelPixels(deltaY, deltaMode) * PINCH_PER_PX;
    return Math.min(Math.max(z, -MAX_WHEEL_STEP), MAX_WHEEL_STEP);
  }
  function scrollCorrection(now, want) {
    return { x: now.x - want.x, y: now.y - want.y };
  }
  var ZoomAnchor = class {
    last = null;
    tolerance;
    constructor(tolerance = 0.5) {
      this.tolerance = tolerance;
    }
    // The content point to hold under `from`; `measure` reads the one under
    // a client point now.
    point(from, measure2) {
      const l2 = this.last;
      if (l2 && distance(l2.client, from) <= this.tolerance) return l2.content;
      return measure2(from);
    }
    // This frame put `content` under `to`.
    settle(to, content2) {
      this.last = { client: to, content: content2 };
    }
    reset() {
      this.last = null;
    }
  };
  function midpoint(a2, b2) {
    return { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
  }
  function distance(a2, b2) {
    return Math.hypot(a2.x - b2.x, a2.y - b2.y);
  }
  var TOUCH_DEFAULTS = {
    windowMs: 200,
    slopPx: 10,
    tapMs: 300,
    doubleTapMs: 350,
    doubleTapPx: 30
  };
  var TouchTracker = class {
    opts;
    phase = "idle";
    fingers = /* @__PURE__ */ new Map();
    first = null;
    moved = false;
    committed = false;
    pair = null;
    last = null;
    lastTap = null;
    // This sequence had a second finger: nothing it does is a swipe or tap.
    multi = false;
    constructor(opts2 = {}) {
      this.opts = { ...TOUCH_DEFAULTS, ...opts2 };
    }
    // Fingers are down and at least one of them is the gesture's (a pinch,
    // or one left over from it): clicks and swipes are not the page's.
    get claimed() {
      return this.phase === "pinch" || this.phase === "spent";
    }
    get pinching() {
      return this.phase === "pinch";
    }
    // The sequence in progress has had more than one finger.
    get multiTouch() {
      return this.multi;
    }
    get active() {
      return this.phase !== "idle";
    }
    // The single finger's id while one finger acts alone.
    get single() {
      return this.phase === "single" ? this.first?.id ?? null : null;
    }
    get isCommitted() {
      return this.committed;
    }
    has(id) {
      return this.fingers.has(id);
    }
    down(id, at3, t2) {
      const finger = { id, start: at3, at: at3, t0: t2 };
      if (this.phase === "idle") {
        this.fingers.clear();
        this.fingers.set(id, finger);
        this.first = finger;
        this.moved = false;
        this.committed = false;
        this.multi = false;
        this.phase = "single";
        return { pass: true };
      }
      this.fingers.set(id, finger);
      this.multi = true;
      if (this.phase === "single" && this.first) {
        if (this.committed) return { pass: false };
        this.lastTap = null;
        this.startPinch(this.first.id, id);
        return { pass: false, cancelSingle: true, pinchStart: true };
      }
      if (this.phase === "spent" && this.fingers.size === 2) {
        const other = [...this.fingers.keys()].find((k2) => k2 !== id);
        if (other !== void 0) {
          this.startPinch(other, id);
          return { pass: false, pinchStart: true };
        }
      }
      return { pass: false };
    }
    startPinch(a2, b2) {
      this.phase = "pinch";
      this.pair = [a2, b2];
      this.last = this.measure();
    }
    measure() {
      if (!this.pair) return null;
      const a2 = this.fingers.get(this.pair[0]);
      const b2 = this.fingers.get(this.pair[1]);
      if (!a2 || !b2) return null;
      return { mid: midpoint(a2.at, b2.at), dist: distance(a2.at, b2.at) };
    }
    move(id, at3, t2) {
      const f2 = this.fingers.get(id);
      if (!f2) return { pass: true };
      f2.at = at3;
      if (this.phase === "single" && f2 === this.first) {
        if (!this.moved && distance(at3, f2.start) > this.opts.slopPx)
          this.moved = true;
        return { pass: true, commit: this.tryCommit(t2) };
      }
      if (this.phase === "pinch" && this.pair?.includes(id)) {
        const now = this.measure();
        const before = this.last;
        if (!now || !before) return { pass: false };
        this.last = now;
        const scale2 = before.dist > 0 && now.dist > 0 ? now.dist / before.dist : 1;
        return {
          pass: false,
          pinch: { scale: scale2, from: before.mid, to: now.mid }
        };
      }
      return { pass: false };
    }
    // Time passing with no event: a finger that moved past the slop early
    // commits once the window is over, even if it then holds still.
    tick(t2) {
      return { pass: true, commit: this.tryCommit(t2) };
    }
    tryCommit(t2) {
      if (this.phase !== "single" || this.committed || !this.first)
        return false;
      if (!this.moved || t2 - this.first.t0 < this.opts.windowMs) return false;
      this.committed = true;
      return true;
    }
    // `cancelled`: the browser took the pointer back (pointercancel).
    up(id, at3, t2, cancelled = false) {
      const f2 = this.fingers.get(id);
      if (!f2) return { pass: true };
      f2.at = at3;
      this.fingers.delete(id);
      if (this.phase === "single" && f2 === this.first) {
        const release = !this.committed;
        if (this.fingers.size) {
          this.phase = "spent";
          this.first = null;
        } else this.reset();
        const verdict = {
          pass: true,
          release,
          moved: this.moved
        };
        if (!cancelled && !this.moved && distance(at3, f2.start) <= this.opts.slopPx && t2 - f2.t0 <= this.opts.tapMs) {
          verdict.tap = f2.start;
          const prev = this.lastTap;
          if (prev && t2 - prev.t <= this.opts.doubleTapMs && distance(prev.at, f2.start) <= this.opts.doubleTapPx) {
            verdict.doubleTap = f2.start;
            this.lastTap = null;
          } else {
            this.lastTap = { at: f2.start, t: t2 };
          }
        } else {
          this.lastTap = null;
        }
        return verdict;
      }
      const ended = this.phase === "pinch" && !!this.pair?.includes(id);
      if (ended) {
        this.phase = "spent";
        this.pair = null;
        this.last = null;
      }
      if (this.fingers.size === 0) this.reset();
      return ended ? { pass: false, pinchEnd: true } : { pass: false };
    }
    reset() {
      this.phase = "idle";
      this.fingers.clear();
      this.first = null;
      this.pair = null;
      this.last = null;
      this.committed = false;
    }
  };

  // src/ts/shared/keyframes.ts
  var templates = /* @__PURE__ */ new Map();
  function parseOffsets(keyText) {
    return keyText.split(",").map((part) => {
      const t2 = part.trim();
      if (t2 === "from") return 0;
      if (t2 === "to") return 1;
      return Number.parseFloat(t2) / 100;
    }).filter((n3) => Number.isFinite(n3));
  }
  function kebabToCamel(prop) {
    return prop.replace(/-([a-z])/g, (_2, c2) => c2.toUpperCase());
  }
  function ruleToKeyframes(rule) {
    const frames = [];
    for (const raw of Array.from(rule.cssRules)) {
      const kf = raw;
      const style = kf.style;
      const props = {};
      for (let i2 = 0; i2 < style.length; i2++) {
        const name2 = style[i2];
        props[kebabToCamel(name2)] = style.getPropertyValue(name2).trim();
      }
      for (const offset of parseOffsets(kf.keyText)) {
        frames.push({ offset, ...props });
      }
    }
    frames.sort((a2, b2) => a2.offset - b2.offset);
    return frames;
  }
  function findKeyframes(name2, rules) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSKeyframesRule) {
        if (rule.name === name2) return rule;
        continue;
      }
      const grouping = rule;
      if (grouping.cssRules) {
        const found = findKeyframes(name2, grouping.cssRules);
        if (found) return found;
      }
    }
    return null;
  }
  function templateFor(name2) {
    const cached = templates.get(name2);
    if (cached !== void 0) return cached;
    let result = null;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const rule = findKeyframes(name2, rules);
      if (rule) {
        result = ruleToKeyframes(rule);
        break;
      }
    }
    templates.set(name2, result);
    return result;
  }
  var VAR_ANIM = /var\(\s*--anim-([\w-]+)\s*(?:,[^()]*)?\)/g;
  function substituteVars(value, vars) {
    return value.replace(
      VAR_ANIM,
      (match, key) => key in vars ? vars[key] : match
    );
  }
  function buildKeyframes(name2, vars) {
    const template = templateFor(name2);
    if (!template) return [];
    if (Object.keys(vars).length === 0) return template;
    return template.map((frame) => {
      const out = {};
      for (const [k2, v2] of Object.entries(frame)) {
        out[k2] = typeof v2 === "string" ? substituteVars(v2, vars) : v2;
      }
      return out;
    });
  }

  // src/ts/shared/step.ts
  var elementCues = /* @__PURE__ */ new WeakMap();
  var rootStep = /* @__PURE__ */ new WeakMap();
  function parseCues(el2) {
    const raw = el2.getAttribute("data-cues");
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  function cueStates(el2) {
    let states = elementCues.get(el2);
    if (!states) {
      states = parseCues(el2).map((cue) => ({ cue, anim: null }));
      elementCues.set(el2, states);
    }
    return states;
  }
  function effectEndMs(cue) {
    const { duration, delay, iterations } = cue.opts;
    return Math.max(0, delay) * 1e3 + Math.max(0, duration) * (iterations ?? 1) * 1e3;
  }
  function ensureAnim(el2, st) {
    if (!st.anim) {
      const { name: name2, vars, opts: opts2 } = st.cue;
      const anim = el2.animate(buildKeyframes(`anim-${name2}`, vars), {
        duration: Math.max(0, opts2.duration * 1e3),
        delay: Math.max(0, opts2.delay * 1e3),
        easing: opts2.easing || "linear",
        iterations: opts2.iterations ?? 1,
        fill: "both"
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
  function restingActions(cues, step2) {
    let gov = -1;
    cues.forEach((c2, i2) => {
      if (c2.kind !== "emphasis" && c2.step <= step2) gov = i2;
    });
    return cues.map((_2, i2) => i2 === gov ? "hold" : "cancel");
  }
  function buildStepRun(root2, fromStep, toStep) {
    const forward2 = toStep >= fromStep;
    const runStep = Math.max(fromStep, toStep);
    const items2 = [];
    root2.querySelectorAll("[data-cues]").forEach((el2) => {
      for (const st of cueStates(el2)) {
        if (st.cue.step !== runStep) continue;
        const anim = ensureAnim(el2, st);
        anim.pause();
        items2.push({
          anim,
          offsetMs: Math.max(0, st.cue.offset) * 1e3,
          spanMs: effectEndMs(st.cue)
        });
      }
    });
    const totalMs = items2.reduce(
      (m2, it) => Math.max(m2, it.offsetMs + it.spanMs),
      0
    );
    return { items: items2, totalMs, forward: forward2, toStep };
  }
  function seekStepRun(run, value) {
    const runTimeMs = value * run.totalMs;
    for (const it of run.items) {
      it.anim.currentTime = Math.min(
        Math.max(runTimeMs - it.offsetMs, 0),
        it.spanMs
      );
    }
  }
  function applyCodeHighlights(root2, step2) {
    root2.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const specIdx = Math.min(Math.max(step2 - baseStep, 0), spec.length - 1);
      const active3 = spec[specIdx];
      const hasHL = active3 !== null;
      block.querySelectorAll(".code-line").forEach((line) => {
        const n3 = +(line.dataset.line ?? "0");
        line.classList.toggle("hl-active", hasHL && active3.includes(n3));
        line.classList.toggle("hl-dim", hasHL && !active3.includes(n3));
        if (!hasHL) line.classList.remove("hl-active", "hl-dim");
      });
    });
  }
  function maxStep(root2) {
    let m2 = 0;
    root2.querySelectorAll("[data-cues]").forEach((el2) => {
      for (const c2 of parseCues(el2)) if (c2.step > m2) m2 = c2.step;
    });
    root2.querySelectorAll("[data-play-on-step]").forEach((el2) => {
      const s2 = +(el2.getAttribute("data-play-on-step") ?? "0");
      if (s2 > m2) m2 = s2;
    });
    root2.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const last = baseStep + spec.length - 1;
      if (last > m2) m2 = last;
    });
    return m2;
  }
  function applyStepInstant(root2, step2) {
    root2.querySelectorAll("[data-cues]").forEach((el2) => {
      const states = cueStates(el2);
      const actions = restingActions(
        states.map((s2) => s2.cue),
        step2
      );
      states.forEach((st, i2) => {
        if (actions[i2] === "hold") holdAtEnd(ensureAnim(el2, st));
        else st.anim?.cancel();
      });
    });
    applyCodeHighlights(root2, step2);
    rootStep.set(root2, step2);
  }

  // src/ts/editor/connectors.ts
  var SIDES = ["top", "right", "bottom", "left"];
  var MAX_SITES = 9;
  function siteName(side, t2) {
    return Math.abs(t2 - 0.5) < 1e-9 ? side : `${side}@${Math.round(t2 * 1e3) / 1e3}`;
  }
  function parseSite(name2) {
    const [side, frac] = name2.split("@");
    if (!SIDES.includes(side)) return null;
    const t2 = frac === void 0 ? 0.5 : Number(frac);
    return Number.isFinite(t2) && t2 >= 0 && t2 <= 1 ? { side, t: t2 } : null;
  }
  function siteOnCorners(c2, side, t2, round2 = false) {
    const along = {
      top: [t2, 0],
      right: [1, t2],
      bottom: [1 - t2, 1],
      left: [0, 1 - t2]
    };
    let [u2, v2] = along[side];
    if (round2) {
      const off2 = Math.sqrt(Math.max(0, 0.25 - (t2 - 0.5) ** 2));
      if (side === "top") v2 = 0.5 - off2;
      else if (side === "bottom") v2 = 0.5 + off2;
      else if (side === "right") u2 = 0.5 + off2;
      else u2 = 0.5 - off2;
    }
    const ex = { x: c2[1].x - c2[0].x, y: c2[1].y - c2[0].y };
    const ey = { x: c2[3].x - c2[0].x, y: c2[3].y - c2[0].y };
    const x2 = c2[0].x + u2 * ex.x + v2 * ey.x;
    const y2 = c2[0].y + u2 * ex.y + v2 * ey.y;
    const i2 = SIDES.indexOf(side);
    const a2 = c2[i2];
    const b2 = c2[(i2 + 1) % 4];
    let nx = b2.y - a2.y;
    let ny = -(b2.x - a2.x);
    const centre = {
      x: (c2[0].x + c2[1].x + c2[2].x + c2[3].x) / 4,
      y: (c2[0].y + c2[1].y + c2[2].y + c2[3].y) / 4
    };
    const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
    if (nx * (mid.x - centre.x) + ny * (mid.y - centre.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(nx, ny) || 1;
    const clean = (n3) => Math.abs(n3) < 1e-12 ? 0 : n3;
    return {
      name: siteName(side, t2),
      x: x2,
      y: y2,
      dx: clean(nx / len),
      dy: clean(ny / len)
    };
  }
  function sitesFromCorners(c2, perSide = 1, round2 = false) {
    const n3 = Math.max(1, Math.min(MAX_SITES, Math.round(perSide)));
    return SIDES.flatMap(
      (side) => Array.from(
        { length: n3 },
        (_2, k2) => siteOnCorners(c2, side, (k2 + 1) / (n3 + 1), round2)
      )
    );
  }
  function siteByName(c2, name2, round2 = false) {
    const s2 = parseSite(name2);
    return s2 ? siteOnCorners(c2, s2.side, s2.t, round2) : null;
  }
  function nearestSite(sites, p2, within) {
    let best2 = null;
    let bestD = within;
    for (const s2 of sites) {
      const d2 = Math.hypot(s2.x - p2.x, s2.y - p2.y);
      if (d2 <= bestD) {
        best2 = s2;
        bestD = d2;
      }
    }
    return best2;
  }
  function direction(end, other) {
    if (end.dx !== void 0 && end.dy !== void 0) {
      return { x: end.dx, y: end.dy };
    }
    const dx = other.x - end.x;
    const dy = other.y - end.y;
    return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
  }
  function horizontal(d2) {
    return Math.abs(d2.x) >= Math.abs(d2.y);
  }
  function parseBend(value) {
    const m2 = /^([xy]):(-?\d*\.?\d+(?:e[-+]?\d+)?)$/i.exec(value ?? "");
    if (!m2) return null;
    const at3 = Number(m2[2]);
    return Number.isFinite(at3) ? { axis: m2[1], at: at3 } : null;
  }
  function formatBend(b2) {
    return `${b2.axis}:${Math.round(b2.at * 100) / 100}`;
  }
  var STUB = 30;
  function route(style, a2, b2, bend = null) {
    if (style === "curved") {
      const da = direction(a2, b2);
      const db = direction(b2, a2);
      const k2 = Math.max(30, Math.hypot(b2.x - a2.x, b2.y - a2.y) * 0.4);
      return {
        curve: true,
        points: [
          { x: a2.x, y: a2.y },
          { x: a2.x + da.x * k2, y: a2.y + da.y * k2 },
          { x: b2.x + db.x * k2, y: b2.y + db.y * k2 },
          { x: b2.x, y: b2.y }
        ]
      };
    }
    if (style === "straight") {
      return {
        curve: false,
        points: [a2, b2].map((p2) => ({ x: p2.x, y: p2.y }))
      };
    }
    return elbow(a2, b2, bend);
  }
  function elbow(a2, b2, bend) {
    const da = direction(a2, b2);
    const db = direction(b2, a2);
    const ha = horizontal(da);
    const hb = horizontal(db);
    let axis;
    let fallback;
    let build2;
    if (ha === hb) {
      axis = ha ? "x" : "y";
      const pa = ha ? a2.x : a2.y;
      const pb = ha ? b2.x : b2.y;
      const sa = Math.sign(ha ? da.x : da.y);
      const sb = Math.sign(ha ? db.x : db.y);
      fallback = sa === sb ? sa > 0 ? Math.max(pa, pb) + STUB : Math.min(pa, pb) - STUB : (pa + pb) / 2;
      build2 = (m2) => ha ? {
        pts: [a2, { x: m2, y: a2.y }, { x: m2, y: b2.y }, b2],
        mid: { x: m2, y: (a2.y + b2.y) / 2 }
      } : {
        pts: [a2, { x: a2.x, y: m2 }, { x: b2.x, y: m2 }, b2],
        mid: { x: (a2.x + b2.x) / 2, y: m2 }
      };
    } else if (ha) {
      axis = "x";
      fallback = b2.x;
      const k2 = b2.y + Math.sign(db.y || 1) * STUB;
      build2 = (m2) => ({
        pts: [a2, { x: m2, y: a2.y }, { x: m2, y: k2 }, { x: b2.x, y: k2 }, b2],
        mid: { x: m2, y: (a2.y + k2) / 2 }
      });
    } else {
      axis = "y";
      fallback = b2.y;
      const k2 = b2.x + Math.sign(db.x || 1) * STUB;
      build2 = (m2) => ({
        pts: [a2, { x: a2.x, y: m2 }, { x: k2, y: m2 }, { x: k2, y: b2.y }, b2],
        mid: { x: (a2.x + k2) / 2, y: m2 }
      });
    }
    const at3 = bend && bend.axis === axis ? bend.at : fallback;
    const { pts, mid } = build2(at3);
    return {
      curve: false,
      points: simplify(pts.map((p2) => ({ x: p2.x, y: p2.y }))),
      bend: { axis, at: at3, mid }
    };
  }
  function simplify(pts) {
    const out = [];
    for (const p2 of pts) {
      const last = out[out.length - 1];
      if (last && Math.hypot(p2.x - last.x, p2.y - last.y) < 1e-6) continue;
      out.push(p2);
      while (out.length >= 3) {
        const [p0, p1, p22] = out.slice(-3);
        const ux = p1.x - p0.x;
        const uy = p1.y - p0.y;
        const vx = p22.x - p1.x;
        const vy = p22.y - p1.y;
        if (Math.abs(ux * vy - uy * vx) < 1e-6 && ux * vx + uy * vy > 0) {
          out.splice(out.length - 2, 1);
        } else break;
      }
    }
    return out;
  }
  function n(v2) {
    return String(Math.round(v2 * 100) / 100);
  }
  function pathData(r2) {
    const [first, ...rest] = r2.points;
    const head = `M${n(first.x)},${n(first.y)}`;
    if (r2.curve) {
      return `${head} C${rest.map((p2) => `${n(p2.x)},${n(p2.y)}`).join(" ")}`;
    }
    return `${head} ${rest.map((p2) => `L${n(p2.x)},${n(p2.y)}`).join(" ")}`;
  }
  function endpointsOf(d2) {
    const nums = (d2.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (nums.length < 4 || nums.some((v2) => !Number.isFinite(v2))) return null;
    return {
      start: { x: nums[0], y: nums[1] },
      end: { x: nums[nums.length - 2], y: nums[nums.length - 1] }
    };
  }
  function parseConnection(value) {
    if (!value) return null;
    const i2 = value.lastIndexOf(":");
    const site = value.slice(i2 + 1);
    if (i2 <= 0 || !parseSite(site)) return null;
    return { id: value.slice(0, i2), site };
  }

  // src/ts/editor/dom.ts
  function h(tag, attrs2 = {}, ...children2) {
    const el2 = document.createElement(tag);
    for (const [k2, v2] of Object.entries(attrs2)) {
      if (v2 == null || v2 === false) continue;
      if (k2.startsWith("on") && typeof v2 === "function") {
        el2.addEventListener(k2.slice(2), v2);
      } else if (k2 === "value" && "value" in el2) {
        el2.value = String(v2);
      } else if (v2 === true) {
        el2.setAttribute(k2, "");
      } else {
        el2.setAttribute(k2, String(v2));
      }
    }
    for (const c2 of children2) {
      if (c2 == null || c2 === false) continue;
      el2.append(typeof c2 === "string" ? document.createTextNode(c2) : c2);
    }
    return el2;
  }
  function clear(el2) {
    while (el2.firstChild) el2.removeChild(el2.firstChild);
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs2 = {}) {
    const el2 = document.createElementNS(SVG_NS, tag);
    for (const [k2, v2] of Object.entries(attrs2)) el2.setAttribute(k2, String(v2));
    return el2;
  }
  var ICON_PATHS = {
    undo: '<path d="M4 7h7a3.5 3.5 0 0 1 0 7H8"/><path d="M6.5 4.5 4 7l2.5 2.5"/>',
    redo: '<path d="M12 7H5a3.5 3.5 0 0 0 0 7h3"/><path d="M9.5 4.5 12 7 9.5 9.5"/>',
    select: '<path d="M3 2l9 5-4 1.2L6.5 12z"/>',
    text: '<path d="M3 3.5h10M8 3.5V13M6 13h4"/>',
    rect: '<rect x="2.5" y="4" width="11" height="8" rx="1.2"/>',
    ellipse: '<ellipse cx="8" cy="8" rx="5.5" ry="4.2"/>',
    line: '<path d="M3 13 13 3"/>',
    arrow: '<path d="M3 13 13 3"/><path d="M7.5 3H13v5.5"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.2"/><circle cx="5.8" cy="6.5" r="1.2"/><path d="m2.5 12 4-4 3 3 2-2 2.5 2.5"/>',
    play: '<path d="M5 3.2 12.5 8 5 12.8Z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>',
    copy: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10.5V3h7.5"/>',
    layers: '<path d="M8 2 14 5.5 8 9 2 5.5 8 2Z"/><path d="M2 9 8 12.5 14 9"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
    eyeOff: '<path d="M2 2l12 12M6.5 4A6.6 6.6 0 0 1 14.5 8a9 9 0 0 1-1.8 2.3M9.9 11.9A6.3 6.3 0 0 1 1.5 8 9.5 9.5 0 0 1 4 5"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    unlock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/>',
    up: '<path d="M4 10l4-4 4 4"/>',
    down: '<path d="M4 6l4 4 4-4"/>',
    front: '<rect x="5" y="5" width="8" height="8" rx="1" fill="currentColor"/><path d="M3 10.5V3h7.5"/>',
    back: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10.5V3h7.5" /><rect x="3" y="3" width="7.5" height="7.5" fill="currentColor" opacity=".35" stroke="none"/>',
    group: '<rect x="2" y="2" width="12" height="12" rx="1" stroke-dasharray="2 1.5"/><rect x="4.5" y="4.5" width="4" height="4"/><rect x="8" y="8" width="3.5" height="3.5"/>',
    code: '<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>',
    fit: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>'
  };
  function icon(name2, size4 = 16) {
    const wrap2 = document.createElement("span");
    wrap2.innerHTML = `<svg viewBox="0 0 16 16" width="${size4}" height="${size4}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name2] ?? ""}</svg>`;
    return wrap2.firstElementChild;
  }
  var toastTimer = 0;
  function toast(message, kind = "info", action) {
    const el2 = document.getElementById("toast");
    if (!el2) return;
    el2.textContent = message;
    el2.className = `show ${kind}`;
    if (action) {
      el2.classList.add("has-action");
      el2.append(
        h(
          "button",
          {
            type: "button",
            class: "toast-action",
            onclick: () => {
              el2.className = "";
              action.run();
            }
          },
          action.label
        )
      );
    }
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      () => {
        el2.className = "";
      },
      action ? 1e4 : kind === "error" ? 6e3 : 2600
    );
  }

  // src/ts/editor/drawioshapes.ts
  function diagramShapes(svg) {
    const shapes2 = [];
    for (const g2 of svg.querySelectorAll("g[data-cell-id]")) {
      const parent = g2.parentElement?.closest("g[data-cell-id]");
      if (!parent?.parentElement?.closest("g[data-cell-id]")) continue;
      const id = g2.getAttribute("id");
      if (id) shapes2.push({ id, label: cellLabel(g2), el: g2 });
    }
    return shapes2;
  }
  function cellLabel(g2) {
    const own = (sel) => [...g2.querySelectorAll(sel)].filter(
      (el2) => el2.closest("g[data-cell-id]") === g2
    );
    for (const el2 of [...own("foreignObject"), ...own("text")]) {
      const text = (el2.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return "";
  }
  function attachableCell(el2) {
    const cell = el2?.closest('g[data-cell-kind="vertex"][id]');
    return cell?.closest("svg[data-drawio]") ? cell : null;
  }
  function attachableCells(svg) {
    return [
      ...svg.querySelectorAll('g[data-cell-kind="vertex"][id]')
    ];
  }
  function cellShape(cell) {
    for (const kid of cell.children) {
      if (kid.hasAttribute("data-cell-id")) continue;
      if (kid.querySelector("foreignObject, text, switch")) continue;
      return kid;
    }
    return cell;
  }
  function shapesEditable(diagram) {
    return diagram.getAttribute("inkflow:drawio-edit") === "shapes";
  }
  function isDiagramCell(el2) {
    return el2.localName === "g" && el2.getAttribute("data-cell-kind") === "vertex" && el2.hasAttribute("data-ink") && !!el2.closest("svg[data-drawio]");
  }
  function median(values) {
    const v2 = [...values].sort((a2, b2) => a2 - b2);
    const mid = Math.floor(v2.length / 2);
    return v2.length % 2 ? v2[mid] : (v2[mid - 1] + v2[mid]) / 2;
  }
  function boxIn(el2, ref) {
    const g2 = el2;
    const from = g2.getScreenCTM?.();
    const to = ref.getScreenCTM?.();
    if (!from || !to || typeof g2.getBBox !== "function") return null;
    const m2 = to.inverse().multiply(from);
    const b2 = g2.getBBox();
    const pts = [
      [b2.x, b2.y],
      [b2.x + b2.width, b2.y],
      [b2.x, b2.y + b2.height],
      [b2.x + b2.width, b2.y + b2.height]
    ].map(([x2, y2]) => new DOMPoint(x2, y2).matrixTransform(m2));
    const xs = pts.map((p2) => p2.x);
    const ys = pts.map((p2) => p2.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
  }
  function pageOffset(diagram) {
    const xs = [];
    const ys = [];
    for (const cell of diagram.querySelectorAll(
      'g[data-cell-kind="vertex"][data-cell-geometry]'
    )) {
      const geo = (cell.getAttribute("data-cell-geometry") ?? "").split(/\s+/).map(Number);
      const b2 = boxIn(cellShape(cell), cell);
      if (!b2 || geo.length !== 4 || geo.some((v2) => !Number.isFinite(v2)))
        continue;
      xs.push(b2.x - geo[0]);
      ys.push(b2.y - geo[1]);
    }
    return xs.length ? { x: median(xs), y: median(ys) } : null;
  }
  function pageBox(cell, offset) {
    const parent = cell.parentElement;
    const b2 = parent ? boxIn(cellShape(cell), parent) : null;
    if (!b2) return null;
    const r2 = (v2) => Math.round(v2 * 100) / 100;
    return {
      x: r2(b2.x - offset.x),
      y: r2(b2.y - offset.y),
      width: r2(b2.width),
      height: r2(b2.height)
    };
  }
  function drawnBox(cell, root2) {
    return boxIn(cellShape(cell), root2);
  }

  // src/ts/editor/geom.ts
  var IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  function mat(m2) {
    return { a: m2.a, b: m2.b, c: m2.c, d: m2.d, e: m2.e, f: m2.f };
  }
  function multiply(p2, q) {
    return {
      a: p2.a * q.a + p2.c * q.b,
      b: p2.b * q.a + p2.d * q.b,
      c: p2.a * q.c + p2.c * q.d,
      d: p2.b * q.c + p2.d * q.d,
      e: p2.a * q.e + p2.c * q.f + p2.e,
      f: p2.b * q.e + p2.d * q.f + p2.f
    };
  }
  function invert(m2) {
    const det = m2.a * m2.d - m2.b * m2.c;
    if (Math.abs(det) < 1e-12) return { ...IDENTITY };
    return {
      a: m2.d / det,
      b: -m2.b / det,
      c: -m2.c / det,
      d: m2.a / det,
      e: (m2.c * m2.f - m2.d * m2.e) / det,
      f: (m2.b * m2.e - m2.a * m2.f) / det
    };
  }
  function apply(m2, p2) {
    return { x: m2.a * p2.x + m2.c * p2.y + m2.e, y: m2.b * p2.x + m2.d * p2.y + m2.f };
  }
  function applyVector(m2, p2) {
    return { x: m2.a * p2.x + m2.c * p2.y, y: m2.b * p2.x + m2.d * p2.y };
  }
  function translate(x2, y2) {
    return { a: 1, b: 0, c: 0, d: 1, e: x2, f: y2 };
  }
  function scaleAbout(sx, sy, origin2) {
    return {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      e: origin2.x - sx * origin2.x,
      f: origin2.y - sy * origin2.y
    };
  }
  function rotateAbout(degrees, origin2) {
    const r2 = degrees * Math.PI / 180;
    const cos = Math.cos(r2);
    const sin = Math.sin(r2);
    return multiply(
      translate(origin2.x, origin2.y),
      multiply(
        { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 },
        translate(-origin2.x, -origin2.y)
      )
    );
  }
  var EPS = 1e-6;
  function isTranslateOnly(m2) {
    return Math.abs(m2.a - 1) < EPS && Math.abs(m2.d - 1) < EPS && Math.abs(m2.b) < EPS && Math.abs(m2.c) < EPS;
  }
  function isAxisAligned(m2) {
    return Math.abs(m2.b) < EPS && Math.abs(m2.c) < EPS;
  }
  function transformBox(m2, box2) {
    const pts = [
      apply(m2, { x: box2.x, y: box2.y }),
      apply(m2, { x: box2.x + box2.width, y: box2.y }),
      apply(m2, { x: box2.x, y: box2.y + box2.height }),
      apply(m2, { x: box2.x + box2.width, y: box2.y + box2.height })
    ];
    const xs = pts.map((p2) => p2.x);
    const ys = pts.map((p2) => p2.y);
    const x2 = Math.min(...xs);
    const y2 = Math.min(...ys);
    return { x: x2, y: y2, width: Math.max(...xs) - x2, height: Math.max(...ys) - y2 };
  }
  function unionBoxes(boxes) {
    if (!boxes.length) return null;
    const x2 = Math.min(...boxes.map((b2) => b2.x));
    const y2 = Math.min(...boxes.map((b2) => b2.y));
    const r2 = Math.max(...boxes.map((b2) => b2.x + b2.width));
    const btm = Math.max(...boxes.map((b2) => b2.y + b2.height));
    return { x: x2, y: y2, width: r2 - x2, height: btm - y2 };
  }
  function fmt(n3) {
    const r2 = Math.round(n3 * 1e3) / 1e3;
    return Object.is(r2, -0) ? "0" : String(r2);
  }
  function formatTransform(m2) {
    if (isTranslateOnly(m2)) {
      if (Math.abs(m2.e) < EPS && Math.abs(m2.f) < EPS) return null;
      return `translate(${fmt(m2.e)},${fmt(m2.f)})`;
    }
    const r2 = (n3) => String(Math.round(n3 * 1e6) / 1e6);
    return `matrix(${r2(m2.a)},${r2(m2.b)},${r2(m2.c)},${r2(m2.d)},${fmt(m2.e)},${fmt(m2.f)})`;
  }
  var BOX_TAGS = /* @__PURE__ */ new Set(["rect", "image", "foreignObject", "use", "svg"]);
  function num(v2, fallback = 0) {
    const n3 = parseFloat(v2 ?? "");
    return Number.isFinite(n3) ? n3 : fallback;
  }
  function usesBoxAttrs(g2) {
    return BOX_TAGS.has(g2.sourceTag) && g2.sourceTag !== "use" && g2.attrs.width != null && g2.attrs.height != null && isTranslateOnly(g2.own);
  }
  function transformPlan(g2, slideChange2) {
    const p2 = g2.parentToSlide;
    const inParent = multiply(invert(p2), multiply(slideChange2, p2));
    return { transform: formatTransform(multiply(inParent, g2.own)) };
  }
  function shiftList(value, delta) {
    if (value == null) return null;
    const parts = value.trim().split(/[\s,]+/);
    if (!parts.length || parts.some((p2) => !Number.isFinite(parseFloat(p2))))
      return null;
    return parts.map((p2) => fmt(parseFloat(p2) + delta)).join(" ");
  }
  function planMove(g2, dx, dy, textChildren2 = []) {
    const delta = applyVector(invert(g2.parentToSlide), { x: dx, y: dy });
    if (isTranslateOnly(g2.own)) {
      if (usesBoxAttrs(g2)) {
        return {
          attrs: {
            x: fmt(num(g2.attrs.x) + delta.x),
            y: fmt(num(g2.attrs.y) + delta.y)
          }
        };
      }
      if (g2.sourceTag === "circle" || g2.sourceTag === "ellipse") {
        return {
          attrs: {
            cx: fmt(num(g2.attrs.cx) + delta.x),
            cy: fmt(num(g2.attrs.cy) + delta.y)
          }
        };
      }
      if (g2.sourceTag === "line") {
        return {
          attrs: {
            x1: fmt(num(g2.attrs.x1) + delta.x),
            y1: fmt(num(g2.attrs.y1) + delta.y),
            x2: fmt(num(g2.attrs.x2) + delta.x),
            y2: fmt(num(g2.attrs.y2) + delta.y)
          }
        };
      }
      if (g2.sourceTag === "text") {
        const xs = shiftList(g2.attrs.x ?? "0", delta.x);
        const ys = shiftList(g2.attrs.y ?? "0", delta.y);
        const kids = textChildren2.map((c2) => {
          const plan2 = {};
          const cx = shiftList(c2.attrs.x, delta.x);
          const cy = shiftList(c2.attrs.y, delta.y);
          if (cx != null) plan2.x = cx;
          if (cy != null) plan2.y = cy;
          return plan2;
        });
        if (xs != null && ys != null) {
          return { attrs: { x: xs, y: ys }, children: kids };
        }
      }
    }
    return { attrs: { transform: prependTranslate(g2.attrs.transform, delta) } };
  }
  var LEADING_TRANSLATE = /^\s*translate\(\s*([-+.\deE]+)(?:[\s,]+([-+.\deE]+))?\s*\)\s*(.*)$/s;
  function prependTranslate(transform, d2) {
    const original = (transform ?? "").trim();
    const m2 = original.match(LEADING_TRANSLATE);
    let x2 = d2.x;
    let y2 = d2.y;
    let rest = original;
    if (m2) {
      x2 += parseFloat(m2[1]);
      y2 += parseFloat(m2[2] ?? "0");
      rest = m2[3].trim();
    }
    const mm = rest.match(/^matrix\(([^)]*)\)$/);
    const nums = mm?.[1].split(/[\s,]+/).filter(Boolean).map(Number) ?? [];
    if (!m2 && nums.length === 6 && nums.every(Number.isFinite)) {
      const [a2, b2, c2, dd, e2, f2] = nums;
      return `matrix(${a2},${b2},${c2},${dd},${fmt(e2 + x2)},${fmt(f2 + y2)})`;
    }
    const zero = Math.abs(x2) < EPS && Math.abs(y2) < EPS;
    if (zero) return rest || null;
    const t2 = `translate(${fmt(x2)},${fmt(y2)})`;
    return rest ? `${t2} ${rest}` : t2;
  }
  function planResize(g2, from, to) {
    const sx = from.width > EPS ? to.width / from.width : 1;
    const sy = from.height > EPS ? to.height / from.height : 1;
    const change = multiply(
      translate(to.x, to.y),
      multiply(
        scaleAbout(sx, sy, { x: 0, y: 0 }),
        translate(-from.x, -from.y)
      )
    );
    const p2 = g2.parentToSlide;
    const inParent = multiply(invert(p2), multiply(change, p2));
    if (isTranslateOnly(g2.own) && isAxisAligned(inParent)) {
      const t2 = { x: g2.own.e, y: g2.own.f };
      const mapBox2 = (b2) => {
        const shifted = { ...b2, x: b2.x + t2.x, y: b2.y + t2.y };
        const out = transformBox(inParent, shifted);
        return { ...out, x: out.x - t2.x, y: out.y - t2.y };
      };
      if (usesBoxAttrs(g2)) {
        const b2 = mapBox2({
          x: num(g2.attrs.x),
          y: num(g2.attrs.y),
          width: num(g2.attrs.width),
          height: num(g2.attrs.height)
        });
        return {
          x: fmt(b2.x),
          y: fmt(b2.y),
          width: fmt(b2.width),
          height: fmt(b2.height)
        };
      }
      if (g2.sourceTag === "ellipse" || g2.sourceTag === "circle") {
        const rx = num(g2.attrs.rx ?? g2.attrs.r);
        const ry = num(g2.attrs.ry ?? g2.attrs.r);
        const b2 = mapBox2({
          x: num(g2.attrs.cx) - rx,
          y: num(g2.attrs.cy) - ry,
          width: 2 * rx,
          height: 2 * ry
        });
        const cx = fmt(b2.x + b2.width / 2);
        const cy = fmt(b2.y + b2.height / 2);
        if (g2.sourceTag === "circle") {
          return { cx, cy, r: fmt((b2.width + b2.height) / 4) };
        }
        return { cx, cy, rx: fmt(b2.width / 2), ry: fmt(b2.height / 2) };
      }
      if (g2.sourceTag === "line") {
        const tt = translate(t2.x, t2.y);
        const m2 = multiply(invert(tt), multiply(inParent, tt));
        const p1 = apply(m2, { x: num(g2.attrs.x1), y: num(g2.attrs.y1) });
        const p22 = apply(m2, { x: num(g2.attrs.x2), y: num(g2.attrs.y2) });
        return {
          x1: fmt(p1.x),
          y1: fmt(p1.y),
          x2: fmt(p22.x),
          y2: fmt(p22.y)
        };
      }
    }
    return { transform: formatTransform(multiply(inParent, g2.own)) };
  }
  function planCrop(g2, from, to) {
    const vb = (g2.attrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || vb.some((n3) => !Number.isFinite(n3))) return null;
    if (!usesBoxAttrs(g2)) return null;
    const frame = {
      x: num(g2.attrs.x),
      y: num(g2.attrs.y),
      width: num(g2.attrs.width),
      height: num(g2.attrs.height)
    };
    if (frame.width <= EPS || frame.height <= EPS) return null;
    const sx = from.width > EPS ? to.width / from.width : 1;
    const sy = from.height > EPS ? to.height / from.height : 1;
    const change = multiply(
      translate(to.x, to.y),
      multiply(
        scaleAbout(sx, sy, { x: 0, y: 0 }),
        translate(-from.x, -from.y)
      )
    );
    const p2 = g2.parentToSlide;
    const inParent = multiply(invert(p2), multiply(change, p2));
    if (!isAxisAligned(inParent)) return null;
    const t2 = { x: g2.own.e, y: g2.own.f };
    const moved = transformBox(inParent, {
      ...frame,
      x: frame.x + t2.x,
      y: frame.y + t2.y
    });
    const next = { ...moved, x: moved.x - t2.x, y: moved.y - t2.y };
    const kx = vb[2] / frame.width;
    const ky = vb[3] / frame.height;
    return {
      x: fmt(next.x),
      y: fmt(next.y),
      width: fmt(next.width),
      height: fmt(next.height),
      viewBox: [
        vb[0] + (next.x - frame.x) * kx,
        vb[1] + (next.y - frame.y) * ky,
        next.width * kx,
        next.height * ky
      ].map(fmt).join(" ")
    };
  }
  function planRotate(g2, degrees, center) {
    return transformPlan(g2, rotateAbout(degrees, center));
  }
  function parseTransform(value) {
    if (!value) return { ...IDENTITY };
    let m2 = { ...IDENTITY };
    const re2 = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    for (const match of value.matchAll(re2)) {
      const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
      let t2 = { ...IDENTITY };
      switch (match[1]) {
        case "matrix":
          if (args.length === 6) {
            t2 = {
              a: args[0],
              b: args[1],
              c: args[2],
              d: args[3],
              e: args[4],
              f: args[5]
            };
          }
          break;
        case "translate":
          t2 = translate(args[0] ?? 0, args[1] ?? 0);
          break;
        case "scale":
          t2 = scaleAbout(args[0] ?? 1, args[1] ?? args[0] ?? 1, {
            x: 0,
            y: 0
          });
          break;
        case "rotate":
          t2 = rotateAbout(args[0] ?? 0, {
            x: args[1] ?? 0,
            y: args[2] ?? 0
          });
          break;
        case "skewX":
          t2 = {
            ...IDENTITY,
            c: Math.tan((args[0] ?? 0) * Math.PI / 180)
          };
          break;
        case "skewY":
          t2 = {
            ...IDENTITY,
            b: Math.tan((args[0] ?? 0) * Math.PI / 180)
          };
          break;
      }
      m2 = multiply(m2, t2);
    }
    return m2;
  }
  function rotationOf(m2) {
    return Math.atan2(m2.b, m2.a) * 180 / Math.PI;
  }
  function relativePath(fromFile, target) {
    const from = fromFile.split("/").slice(0, -1).filter(Boolean);
    const to = target.split("/").filter(Boolean);
    let i2 = 0;
    while (i2 < from.length && i2 < to.length - 1 && from[i2] === to[i2]) i2++;
    const up = from.slice(i2).map(() => "..");
    return [...up, ...to.slice(i2)].join("/");
  }
  function projectFile(ref, base2) {
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("_theme/"))
      return null;
    const file = ref.replace(/[#?].*$/, "");
    if (file.startsWith("/")) return file;
    const parts = base2 ? base2.split("/").slice(0, -1) : [];
    for (const part of file.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  }

  // src/ts/shared/deck-styles.ts
  function applyDeckStyles(msg) {
    if (msg.styles !== void 0) {
      const el2 = document.getElementById("deck-styles");
      if (el2) el2.textContent = msg.styles;
    }
    if (msg.mode !== void 0)
      document.documentElement.dataset.theme = msg.mode;
  }

  // src/ts/shared/patch.ts
  function isWhole(sent2) {
    return !sent2.some((item2) => typeof item2 === "string");
  }
  function applyPatch(held, sent2) {
    if (isWhole(sent2)) return sent2;
    const byKey = /* @__PURE__ */ new Map();
    for (const item2 of held) {
      if (item2.key != null) byKey.set(item2.key, item2);
    }
    const out = [];
    for (const item2 of sent2) {
      if (typeof item2 !== "string") {
        out.push(item2);
        continue;
      }
      const mine = byKey.get(item2);
      if (!mine) return null;
      out.push(mine);
    }
    return out;
  }

  // src/ts/shared/wsurl.ts
  var WS_PATH = "/_inkflow/ws";
  function socketUrl(loc) {
    const scheme = loc.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${loc.host || "localhost"}${WS_PATH}`;
  }
  var SENT_AWAY = 4001;
  function relay() {
    try {
      if (window.parent !== window) {
        return window.parent.__inkflowRelay;
      }
    } catch {
    }
    return void 0;
  }
  function openSocket() {
    const online = relay();
    if (!online) return new WebSocket(socketUrl(location));
    const sock = online.openSocket();
    window.addEventListener("pagehide", () => sock.close(1001, "page left"));
    return sock;
  }

  // src/ts/shared/identity.ts
  var NAME_KEY = "inkflow-name";
  var ID_KEY = "inkflow-key";
  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  }
  function storedName() {
    const name2 = read(NAME_KEY)?.trim();
    return name2 ? name2.slice(0, 40) : null;
  }
  function saveName(name2) {
    write(NAME_KEY, name2.trim().slice(0, 40));
  }
  var sessionKey = null;
  function clientKey() {
    const stored2 = read(ID_KEY);
    if (stored2 && /^[A-Za-z0-9_-]{16,64}$/.test(stored2)) return stored2;
    if (!sessionKey) {
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      sessionKey = Array.from(
        bytes,
        (b2) => b2.toString(16).padStart(2, "0")
      ).join("");
      write(ID_KEY, sessionKey);
    }
    return sessionKey;
  }
  function initials(name2) {
    const words = name2.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return (words[0] ?? "?").slice(0, 2).toUpperCase();
  }

  // src/ts/editor/dialog.ts
  var host = document.getElementById("dialog");
  var onClose = null;
  function openDialog(title3, body3, opts2 = {}) {
    closeDialog();
    onClose = opts2.onClose ?? null;
    const box2 = h(
      "div",
      {
        class: `dialog-box${opts2.large ? " large" : opts2.wide ? " wide" : ""}`,
        role: "dialog"
      },
      h(
        "div",
        { class: "dialog-head" },
        h("h2", {}, title3),
        opts2.hint ? h("span", { class: "hint" }, opts2.hint) : null,
        h(
          "button",
          {
            type: "button",
            class: "dialog-close",
            title: "Close (Esc)",
            onclick: () => closeDialog()
          },
          "\xD7"
        )
      ),
      h("div", { class: "dialog-body" }, body3)
    );
    host.append(box2);
    host.classList.add("open");
    return box2;
  }
  function closeDialog() {
    if (!host.classList.contains("open")) return;
    host.classList.remove("open");
    clear(host);
    const fn = onClose;
    onClose = null;
    fn?.();
  }
  function dialogOpen() {
    return host.classList.contains("open");
  }
  function initDialog() {
    host.addEventListener("pointerdown", (e2) => {
      if (e2.target === host) closeDialog();
    });
    document.addEventListener(
      "keydown",
      (e2) => {
        const own = e2.target?.closest?.(
          "[data-own-escape]"
        );
        if (e2.key === "Escape" && dialogOpen() && !own) {
          e2.preventDefault();
          e2.stopPropagation();
          closeDialog();
        }
      },
      true
    );
    host.addEventListener("keydown", (e2) => {
      if (e2.key !== "Escape") e2.stopPropagation();
    });
  }

  // src/ts/editor/pathtext.ts
  function sepOf(path) {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
  }
  function withSep(dir) {
    const sep2 = sepOf(dir);
    return dir.endsWith(sep2) ? dir : dir + sep2;
  }
  function joinPath(dir, name2) {
    return withSep(dir) + name2;
  }
  function baseName(path) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  }
  function samePath(a2, b2) {
    const norm = (p2) => p2.replace(/(.)[\\/]+$/, "$1");
    return norm(a2) === norm(b2);
  }
  function commonPrefix(names2) {
    if (!names2.length) return "";
    let prefix = names2[0];
    for (const name2 of names2.slice(1)) {
      let i2 = 0;
      while (i2 < prefix.length && i2 < name2.length && prefix[i2].toLowerCase() === name2[i2].toLowerCase()) {
        i2++;
      }
      prefix = prefix.slice(0, i2);
    }
    return prefix;
  }
  function startingWith(names2, typed) {
    const t2 = typed.toLowerCase();
    return names2.filter((n3) => n3.toLowerCase().startsWith(t2));
  }
  function splitTyped(value) {
    const i2 = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    if (i2 < 0) return { dir: "", prefix: value };
    return { dir: value.slice(0, i2 + 1), prefix: value.slice(i2 + 1) };
  }
  function assetRef(href) {
    return href.replace(/\?v=[0-9a-f]+$/, "");
  }
  function isPdfRef(ref) {
    return /\.pdf(?:[#?]|$)/i.test(ref) && !/^[a-z][a-z0-9+.-]*:/i.test(ref);
  }
  function pdfPage(ref) {
    const m2 = /#(?:.*&)?page=(\d+)/i.exec(ref);
    return m2 ? Math.max(1, Number(m2[1])) : 1;
  }
  function withPage(ref, page) {
    const file = ref.replace(/#.*$/, "");
    return page > 1 ? `${file}#page=${page}` : file;
  }
  function splitFileName(rel) {
    const cut2 = rel.lastIndexOf("/");
    const folder = cut2 < 0 ? "" : rel.slice(0, cut2);
    const name2 = rel.slice(cut2 + 1);
    const drawio = /\.drawio\.svg$/i.exec(name2);
    const dot = name2.lastIndexOf(".");
    const ext = drawio ? drawio[0] : dot > 0 ? name2.slice(dot) : "";
    return { folder, stem: name2.slice(0, name2.length - ext.length), ext };
  }
  function joinFileName(folder, stem, ext) {
    const dir = folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const name2 = `${stem.trim()}${ext}`;
    return dir ? `${dir}/${name2}` : name2;
  }
  function projectRel(path, projectDir) {
    if (!path) return null;
    if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) {
      return path.split("/").includes("..") ? null : path;
    }
    const root2 = projectDir.replace(/[\\/]+$/, "");
    if (!path.startsWith(`${root2}/`)) return null;
    return path.slice(root2.length + 1);
  }

  // src/ts/editor/pdfpages.ts
  var THUMBS = 24;
  function sourceRef(image) {
    return image.getAttribute("data-inkflow-pdf") ?? assetRef(
      image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? ""
    );
  }
  function fileName(path) {
    return path.replace(/#.*$/, "").split(/[\\/]/).pop() ?? path;
  }
  async function pageUrl(path, page) {
    const res = await request({ action: "pdf-page", path, page });
    if (!res.ok) {
      toast(res.error ?? `cannot show page ${page}`, "error");
      return null;
    }
    return String(res.url);
  }
  async function choosePage(path, current3 = 1) {
    const info4 = await request({ action: "pdf-pages", path });
    if (!info4.ok) {
      toast(info4.error ?? "cannot read the PDF", "error");
      return null;
    }
    const name2 = fileName(path);
    if (info4.ignored) {
      toast(
        `${name2} is ignored by git (see .gitignore): add it to the repository with "git add -f" to keep it`
      );
    }
    if (!info4.converter) {
      toast(`${name2} shows as a placeholder: ${String(info4.hint)}`, "error");
      return { page: current3, url: null };
    }
    const pages = typeof info4.pages === "number" ? info4.pages : null;
    if (pages === 1) {
      const url = await pageUrl(path, 1);
      return url ? { page: 1, url } : null;
    }
    return pageDialog(path, name2, pages, current3);
  }
  function pageDialog(path, name2, pages, current3) {
    return new Promise((resolve) => {
      let done = false;
      const finish2 = (choice) => {
        if (done) return;
        done = true;
        resolve(choice);
        closeDialog();
      };
      const grid = h("div", { class: "pdf-pages" });
      const urls = /* @__PURE__ */ new Map();
      const pick2 = async (page) => {
        const url = urls.get(page) ?? await pageUrl(path, page);
        if (url) finish2({ page, url });
      };
      const count = pages ?? THUMBS;
      for (let page = 1; page <= Math.min(count, THUMBS); page++) {
        grid.append(
          h(
            "button",
            {
              type: "button",
              class: `pdf-page${page === current3 ? " current" : ""}`,
              title: `Page ${page}`,
              "data-page": page,
              onclick: () => void pick2(page)
            },
            h("span", { class: "pdf-thumb" }),
            h("span", {}, `Page ${page}`)
          )
        );
      }
      const field2 = h("input", {
        type: "number",
        min: 1,
        max: pages ?? null,
        step: 1,
        value: String(current3)
      });
      field2.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter") void pick2(Math.max(1, Number(field2.value)));
      });
      const body3 = h(
        "div",
        {},
        grid,
        h(
          "div",
          { class: "pdf-page-field" },
          h("label", {}, "Page ", field2, pages ? ` of ${pages}` : ""),
          h(
            "button",
            {
              type: "button",
              class: "pbtn on",
              onclick: () => void pick2(Math.max(1, Number(field2.value)))
            },
            "Use this page"
          )
        )
      );
      openDialog(`Which page of ${name2}?`, body3, {
        wide: true,
        hint: "A figure from a PDF shows one page",
        onClose: () => finish2(null)
      });
      void (async () => {
        for (const card of grid.querySelectorAll(
          ".pdf-page"
        )) {
          if (done) return;
          const page = Number(card.dataset.page);
          const res = await request({ action: "pdf-page", path, page });
          if (!res.ok) {
            for (const rest of grid.querySelectorAll(
              ".pdf-page"
            )) {
              if (Number(rest.dataset.page) >= page) rest.remove();
            }
            return;
          }
          const url = String(res.url);
          urls.set(page, url);
          card.querySelector(".pdf-thumb")?.append(
            h("img", { src: `/${url}`, alt: `Page ${page}` })
          );
        }
      })();
    });
  }

  // src/ts/editor/state.ts
  var CONNECTOR_TOOLS = {
    line: "straight",
    arrow: "straight",
    elbow: "elbow",
    curve: "curved"
  };
  var ed = {
    model: null,
    slides: [],
    // rendered SVG per *visible* slide
    current: 0,
    // deck index of the slide being edited
    selection: [],
    scope: null,
    // group entered by double-click
    layoutMode: false,
    // The slide master is open (its list replaces the slide list).
    masterMode: false,
    master: null,
    step: null,
    // null: every element shown, no build state
    zoom: 0,
    // 0 = fit to window, else device px per slide unit
    tool: "select",
    interacting: false,
    // a drag is in progress: defer re-renders
    richEditing: false,
    // a zone is being edited in place: defer re-renders
    cropMode: false,
    // the selected image's handles crop instead of scaling
    renderPending: false,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    // what Undo would take back ("Move slide")
    redoLabel: null,
    // Someone else's later edit to the same files keeps Undo from taking
    // this person's last step back (their name), else null.
    undoBlockedBy: null,
    slideSelection: /* @__PURE__ */ new Set(),
    // deck indices picked in the slide list
    focus: "canvas",
    // where Delete / copy apply
    error: null,
    // A structural edit was sent and its rebuild has not been rendered yet.
    structuralPending: false,
    rebuilt: false,
    // a model arrived since the last render
    restyled: false
    // so did a new stylesheet or colour mode (text fits anew)
  };
  var listeners = /* @__PURE__ */ new Map();
  function on(event, fn) {
    let set = listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      listeners.set(event, set);
    }
    set.add(fn);
  }
  function off(event, fn) {
    listeners.get(event)?.delete(fn);
  }
  function emit(event) {
    for (const fn of [...listeners.get(event) ?? []]) fn();
  }
  function currentSlide() {
    if (ed.master) return ed.master.slide;
    return ed.model?.slides[ed.current] ?? null;
  }
  function currentRendered() {
    if (ed.master) return ed.master.data;
    const s2 = currentSlide();
    if (!s2 || s2.visibleIndex == null) return null;
    return ed.slides[s2.visibleIndex] ?? null;
  }
  function sourceOf(key) {
    return currentSlide()?.sources?.[key] ?? null;
  }

  // src/ts/editor/types.ts
  function refBase(src) {
    return src.copyTo ?? src.path;
  }

  // src/ts/editor/folderpicker.ts
  function megabytes(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  function folderPicker(start, onChange, files2) {
    let folder = null;
    let places = { favorites: [], default: null };
    let filter = "";
    let typing = 0;
    const path = h("input", {
      type: "text",
      class: "folder-path",
      spellcheck: "false",
      autocomplete: "off",
      title: "Type a path: Tab completes, Enter opens, \u2193 goes to the list"
    });
    const list4 = h("div", { class: "folder-list", role: "listbox" });
    const where = h("div", { class: "hint folder-where" });
    const placesRow = h("div", { class: "folder-places" });
    const star = h("button", {
      type: "button",
      class: "pbtn folder-star"
    });
    const system = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        hidden: true,
        title: "Choose with this computer's own dialog"
      },
      "Browse\u2026"
    );
    const entries = () => [...list4.querySelectorAll("button.folder")].filter(
      (b2) => !b2.hidden
    );
    async function go(target, opts2 = {}) {
      const res = await request({
        action: "browse",
        path: target,
        files: files2?.kind
      });
      if (!res.ok) {
        if (!opts2.quiet) {
          where.textContent = res.error ?? "Cannot open that folder";
        }
        return false;
      }
      folder = res;
      places = folder.places ?? places;
      system.hidden = !folder.systemPicker;
      path.value = withSep(folder.path);
      filter = "";
      renderList4();
      renderPlaces();
      where.textContent = folder.repo ? `In the git repository at ${folder.repo}` : "Not in a git repository";
      onChange(folder);
      if (opts2.focus === "list") (entries()[0] ?? path).focus();
      else if (opts2.focus === "path") path.focus();
      return true;
    }
    function entry(label4, kind, onOpen, extra) {
      const b2 = h(
        "button",
        {
          type: "button",
          class: `folder ${kind === "file" ? "file" : kind === "up" ? "up" : ""}`,
          role: "option",
          onclick: onOpen
        },
        label4,
        extra ?? null
      );
      return b2;
    }
    function renderList4() {
      clear(list4);
      const f2 = folder;
      if (!f2) return;
      if (f2.parent && !filter) {
        list4.append(
          entry("\u2191 ..", "up", () => {
            if (f2.parent) void go(f2.parent, { focus: "list" });
          })
        );
      }
      const dirs = startingWith(f2.dirs, filter);
      for (const name2 of dirs) {
        list4.append(
          entry(`\u{1F4C1} ${name2}`, "dir", () => {
            void go(joinPath(f2.path, name2), { focus: "list" });
          })
        );
      }
      const shown3 = startingWith(
        (f2.files ?? []).map((x2) => x2.name),
        filter
      );
      for (const file of f2.files ?? []) {
        if (!shown3.includes(file.name)) continue;
        list4.append(
          entry(
            `\u{1F39E} ${file.name}`,
            "file",
            () => files2?.onFile(joinPath(f2.path, file.name)),
            h(
              "span",
              { class: "hint file-size" },
              megabytes(file.size)
            )
          )
        );
      }
      if (!dirs.length && !shown3.length) {
        list4.append(
          h(
            "p",
            { class: "hint folder-empty" },
            filter ? `Nothing here starts with \u201C${filter}\u201D.` : "No folders here."
          )
        );
      }
      path.toggleAttribute("data-own-escape", !!filter);
    }
    async function setPlaces(op, target) {
      const res = await request({ action: "places-set", op, path: target });
      if (!res.ok) {
        toast(res.error ?? "Cannot save that", "error");
        return;
      }
      places = res.places;
      renderPlaces();
    }
    function chip(label4, target, remove) {
      return h(
        "span",
        { class: "place" },
        h(
          "button",
          {
            type: "button",
            class: "place-go",
            title: target,
            onclick: () => void go(target, { focus: "list" })
          },
          label4
        ),
        remove ? h(
          "button",
          {
            type: "button",
            class: "place-remove",
            title: "Remove from favourites",
            onclick: remove
          },
          "\xD7"
        ) : null
      );
    }
    function renderPlaces() {
      clear(placesRow);
      const here = folder?.path ?? "";
      const isFavorite = places.favorites.some((p2) => samePath(p2, here));
      star.textContent = isFavorite ? "\u2605" : "\u2606";
      star.title = isFavorite ? "Remove this folder from your favourites" : "Add this folder to your favourites";
      star.classList.toggle("on", isFavorite);
      if (places.default) {
        placesRow.append(
          chip(`\u2302 ${baseName(places.default)} (default)`, places.default)
        );
      }
      for (const p2 of places.favorites) {
        placesRow.append(
          chip(`\u2605 ${baseName(p2)}`, p2, () => void setPlaces("remove", p2))
        );
      }
      const isDefault = !!places.default && samePath(places.default, here);
      placesRow.append(
        h(
          "button",
          {
            type: "button",
            class: "place-default",
            title: isDefault ? "New decks go here and Open deck starts here; click to forget it" : "New decks go here and Open deck starts here",
            onclick: () => void setPlaces("default", isDefault ? null : here)
          },
          isDefault ? "\u2713 Default location" : "Make this the default location"
        )
      );
    }
    path.addEventListener("input", () => {
      window.clearTimeout(typing);
      const { dir, prefix } = splitTyped(path.value);
      if (folder && samePath(dir, folder.path)) {
        filter = prefix;
        renderList4();
      } else if (dir && !prefix) {
        typing = window.setTimeout(
          () => void go(dir, { quiet: true }),
          250
        );
      }
    });
    async function complete() {
      const { dir, prefix } = splitTyped(path.value);
      if (!folder || !samePath(dir, folder.path)) {
        if (!dir || !await go(dir, { quiet: true })) return;
        path.value = withSep(folder.path) + prefix;
      }
      const f2 = folder;
      const matches2 = startingWith(f2.dirs, prefix);
      if (matches2.length === 1) {
        await go(joinPath(f2.path, matches2[0]));
        return;
      }
      const common = commonPrefix(matches2);
      filter = common.length > prefix.length ? common : prefix;
      path.value = withSep(f2.path) + filter;
      renderList4();
    }
    path.addEventListener("keydown", (e2) => {
      if (e2.key === "Tab" && !e2.shiftKey && !e2.ctrlKey && !e2.altKey) {
        e2.preventDefault();
        void complete();
      } else if (e2.key === "Enter") {
        e2.preventDefault();
        const { dir, prefix } = splitTyped(path.value);
        const f2 = folder;
        if (f2 && prefix && samePath(dir, f2.path)) {
          const exact = f2.dirs.find(
            (d2) => d2.toLowerCase() === prefix.toLowerCase()
          );
          const only = startingWith(f2.dirs, prefix);
          const into = exact ?? (only.length === 1 ? only[0] : null);
          if (into) {
            void go(joinPath(f2.path, into));
            return;
          }
        }
        void go(path.value);
      } else if (e2.key === "ArrowDown") {
        e2.preventDefault();
        entries()[0]?.focus();
      } else if (e2.key === "Escape" && filter && folder) {
        e2.preventDefault();
        path.value = withSep(folder.path);
        filter = "";
        renderList4();
      }
    });
    list4.addEventListener("keydown", (e2) => {
      const items2 = entries();
      const at3 = items2.indexOf(document.activeElement);
      if (e2.key === "ArrowDown" || e2.key === "ArrowUp") {
        e2.preventDefault();
        const next = at3 + (e2.key === "ArrowDown" ? 1 : -1);
        if (next < 0) path.focus();
        else items2[Math.min(next, items2.length - 1)]?.focus();
      } else if (e2.key === "Backspace") {
        e2.preventDefault();
        if (filter) {
          path.focus();
          path.value = path.value.slice(0, -1);
          path.dispatchEvent(new Event("input"));
        } else if (folder?.parent) {
          void go(folder.parent, { focus: "list" });
        }
      } else if (e2.key.length === 1 && !e2.ctrlKey && !e2.metaKey && !e2.altKey && e2.key !== " ") {
        e2.preventDefault();
        path.focus();
        path.value += e2.key;
        path.dispatchEvent(new Event("input"));
      }
    });
    star.addEventListener("click", () => {
      const here = folder?.path;
      if (!here) return;
      const isFavorite = places.favorites.some((p2) => samePath(p2, here));
      void setPlaces(isFavorite ? "remove" : "add", here);
    });
    system.addEventListener("click", async () => {
      system.disabled = true;
      const before = where.textContent;
      where.textContent = "A dialog is open on this computer (it may be behind the browser)\u2026";
      const res = await request({
        action: "system-pick",
        path: folder?.path ?? start,
        files: files2?.kind,
        title: files2 ? "Choose a video" : "Choose a folder"
      });
      system.disabled = false;
      where.textContent = before;
      if (!res.ok) {
        toast(res.error ?? "No dialog could be shown", "error");
        return;
      }
      const chosen = typeof res.path === "string" ? res.path : null;
      if (!chosen) return;
      if (files2) files2.onFile(chosen);
      else void go(chosen);
    });
    const el2 = h(
      "div",
      { class: "folder-picker" },
      h(
        "div",
        { class: "folder-bar" },
        path,
        system,
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Your home folder",
            onclick: () => void go(folder?.home ?? "~", { focus: "list" })
          },
          "Home"
        ),
        star
      ),
      placesRow,
      list4,
      where
    );
    void go(start);
    return { el: el2, current: () => folder, focus: () => path.focus() };
  }

  // src/ts/editor/openwith.ts
  var menu = document.getElementById("context-menu");
  function fileName2(path) {
    return path.split(/[\\/]/).pop() ?? path;
  }
  function inProject(path) {
    const root2 = ed.model?.projectDir;
    if (!path.startsWith("/")) return !path.split("/").includes("..");
    return !!root2 && path.startsWith(`${root2}/`);
  }
  async function openMenu(path, x2, y2) {
    const res = await request({ action: "open-apps", path });
    if (!res.ok) {
      toast(res.error ?? "Cannot open this file", "error");
      return;
    }
    const apps = res.apps ?? [];
    clear(menu);
    menu.append(h("div", { class: "menu-title" }, `Open ${fileName2(path)} in`));
    for (const app of apps) {
      menu.append(menuItem(app.label, () => void open(path, app)));
    }
    menu.append(
      menuItem("Copy path", () => {
        const root2 = ed.model?.projectDir ?? "";
        const full = path.startsWith("/") ? path : `${root2}/${path}`;
        void navigator.clipboard.writeText(full).then(
          () => toast(`Copied ${full}`, "ok"),
          () => toast(full)
        );
      })
    );
    showMenu(x2, y2);
  }
  async function open(path, app) {
    const res = await request({ action: "open-file", path, app: app.id });
    if (res.ok) toast(`Opened ${fileName2(path)} in ${app.label}`, "ok");
    else toast(res.error ?? "Could not open the file", "error");
  }
  function openButton(path, label4 = "Open") {
    if (!path || !inProject(path)) return null;
    return h(
      "button",
      {
        type: "button",
        class: "pbtn open-with",
        title: `Open ${fileName2(path)} in another program`,
        onclick: (e2) => {
          const r2 = e2.currentTarget.getBoundingClientRect();
          void openMenu(path, r2.left, r2.bottom + 4);
        }
      },
      `${label4} \u25BE`
    );
  }

  // src/ts/editor/videocheck.ts
  var LONG = 10 * 60;
  async function mediaInfo(path) {
    const res = await request({ action: "media-info", path });
    if (!res.ok) {
      toast(res.error ?? "Cannot read the video", "error");
      return null;
    }
    return res;
  }
  function name(path) {
    return path.split(/[\\/]/).pop() ?? path;
  }
  function minutes(seconds) {
    const m2 = Math.floor(seconds / 60);
    const s2 = Math.round(seconds % 60);
    return `${m2}:${String(s2).padStart(2, "0")}`;
  }
  function describe(info4) {
    return [
      info4.vcodec ? `${info4.vcodec.toUpperCase()} in .${info4.container}` : `.${info4.container}`,
      info4.width && info4.height ? `${info4.width}\xD7${info4.height}` : "",
      info4.fps ? `${Math.round(info4.fps)} fps` : "",
      info4.duration ? minutes(info4.duration) : "",
      megabytes(info4.size)
    ].filter(Boolean).join(" \xB7 ");
  }
  async function checkVideo(ctx) {
    const data = await mediaInfo(ctx.path);
    if (!data) return;
    const issues = collect(ctx, data);
    if (issues.length) showCheck(ctx, data, issues);
  }
  async function openVideoCheck(ctx) {
    const data = await mediaInfo(ctx.path);
    if (data) showCheck(ctx, data, collect(ctx, data));
  }
  function collect(ctx, data) {
    const issues = [...data.issues];
    if (ctx.browser && !ctx.browser.decoded) {
      issues.unshift({
        kind: "decode",
        level: "error",
        text: "This browser cannot play it: it shows as an empty box here, and in the presenter for anyone with this browser."
      });
    }
    const duration = ctx.browser?.duration;
    if (data.info.duration == null && duration && duration > LONG) {
      issues.push({
        kind: "length",
        level: "info",
        text: `It runs ${Math.round(duration / 60)} minutes. Trim start and end in its settings, or cut it in a video editor.`
      });
    }
    return issues;
  }
  function showCheck(ctx, data, issues) {
    const editors = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        title: "Trim or cut it in a video editor (LosslessCut, Shotcut\u2026)"
      },
      "Open in\u2026"
    );
    editors.addEventListener("click", () => {
      const r2 = editors.getBoundingClientRect();
      void openMenu(ctx.path, r2.left, r2.bottom + 4);
    });
    openDialog(
      "Video check",
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint" },
          `${name(ctx.path)}: ${describe(data.info)}`
        ),
        issues.length ? h(
          "ul",
          { class: "video-issues" },
          ...issues.map(
            (i2) => h("li", { class: `issue-${i2.level}` }, i2.text)
          )
        ) : h(
          "p",
          {},
          "Nothing to worry about: it plays in every current browser."
        ),
        !data.tools.ffprobe && h(
          "p",
          { class: "hint" },
          "Install ffmpeg (it brings ffprobe) to see the codec, resolution and length here, and to convert in place."
        ),
        h(
          "p",
          { class: "hint" },
          "MP4 with H.264 plays in every browser; WebM (VP9) in all but some Safari versions. Convert to one of them to be safe."
        ),
        h(
          "div",
          { class: "btn-row end" },
          editors,
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => closeDialog()
            },
            "Keep as is"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              onclick: () => convertDialog(ctx.path, data, {
                kind: "replace",
                ctx
              })
            },
            "Convert\u2026"
          )
        )
      ),
      { wide: true }
    );
  }
  var PRESETS = [
    { label: "Keep its resolution", height: null },
    { label: "4K (2160p)", height: 2160 },
    { label: "Full HD (1080p)", height: 1080 },
    { label: "HD (720p)", height: 720 },
    { label: "480p", height: 480 }
  ];
  async function convertForInsert(source) {
    const data = await mediaInfo(source);
    if (!data) return null;
    return new Promise(
      (resolve) => convertDialog(source, data, { kind: "insert", done: resolve })
    );
  }
  function convertDialog(path, data, purpose) {
    const info4 = data.info;
    let format = data.remux ? "copy" : "mp4";
    let height2 = null;
    let quality = 2;
    let audio = !!info4.acodec;
    const inserting = purpose.kind === "insert";
    const choices = [
      ["mp4", "MP4 (H.264)", "Plays in every browser. The safe choice."],
      [
        "webm",
        "WebM (VP9)",
        "Smaller at the same quality; not in all Safari versions."
      ]
    ];
    if (data.remux) {
      choices.unshift([
        "copy",
        `Keep the video as it is (.${data.remux})`,
        `Its ${info4.vcodec?.toUpperCase() ?? "video"} already plays in browsers: repackaged without re-encoding, in seconds and with no quality lost.`
      ]);
    }
    const formats = h(
      "div",
      { class: "look-list" },
      ...choices.map(([value, label4, text]) => {
        const radio = h("input", {
          type: "radio",
          name: "video-format",
          value
        });
        radio.checked = value === format;
        radio.addEventListener("change", () => {
          format = value;
          void update();
        });
        return h(
          "label",
          { class: "look" },
          radio,
          h(
            "span",
            { class: "look-text" },
            h("strong", {}, label4),
            h("span", { class: "hint" }, text)
          )
        );
      })
    );
    const size4 = h("select", {});
    for (const p2 of PRESETS) {
      const bigger = p2.height && info4.height && p2.height > info4.height;
      const option2 = h(
        "option",
        { value: String(p2.height ?? "") },
        p2.height ? `${p2.label}${bigger ? " (no larger than the source)" : ""}` : `${p2.label}${info4.width && info4.height ? ` (${info4.width}\xD7${info4.height})` : ""}`
      );
      option2.selected = p2.height === height2;
      size4.append(option2);
    }
    size4.addEventListener("change", () => {
      height2 = size4.value ? Number(size4.value) : null;
      void update();
    });
    const slider = h("input", {
      type: "range",
      class: "quality-slider",
      min: "0",
      max: String(data.qualities.length - 1),
      step: "1",
      value: String(quality)
    });
    const qualityLabel = h("span", { class: "hint" });
    slider.addEventListener("input", () => {
      quality = Number(slider.value);
      void update();
    });
    const sound = h("input", { type: "checkbox" });
    sound.checked = audio;
    sound.disabled = !info4.acodec && data.tools.ffprobe;
    sound.addEventListener("change", () => {
      audio = sound.checked;
      void update();
    });
    const estimate = h("p", { class: "video-estimate" });
    const command = h("textarea", {
      class: "git-message video-command",
      rows: "3",
      readonly: true,
      spellcheck: "false"
    });
    const copy3 = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        onclick: () => void navigator.clipboard.writeText(command.value).then(
          () => toast(
            "Command copied: run it in the deck's folder",
            "ok"
          ),
          () => command.select()
        )
      },
      "Copy command"
    );
    const use = h("input", { type: "checkbox" });
    use.checked = true;
    const progress = h("progress", {
      max: "1",
      value: "0",
      hidden: true
    });
    const run = h(
      "button",
      { type: "button", class: "pbtn primary", disabled: !data.tools.ffmpeg },
      "Convert now"
    );
    let job = null;
    let finished = false;
    async function update() {
      qualityLabel.textContent = data.qualities[quality] ?? "";
      size4.disabled = slider.disabled = format === "copy";
      const res = await request({
        action: "convert-plan",
        path,
        format,
        height: height2,
        quality,
        audio
      });
      if (!res.ok) {
        estimate.textContent = res.error ?? "";
        return;
      }
      command.value = String(res.command);
      const bytes = res.estimate;
      estimate.textContent = bytes ? `Roughly ${megabytes(bytes)}, from ${megabytes(info4.size)} now (a guess: it depends on the footage).` : "No size estimate without the video's length and resolution (install ffmpeg).";
      estimate.append(
        h("br"),
        h("span", { class: "hint" }, `Saved as ${res.out}`)
      );
    }
    run.addEventListener("click", async () => {
      if (job) {
        await request({ action: "convert-cancel", job });
        return;
      }
      const res = await request({
        action: "convert",
        path,
        format,
        height: height2,
        quality,
        audio
      });
      if (!res.ok || typeof res.job !== "string") {
        toast(res.error ?? "Could not start ffmpeg", "error");
        return;
      }
      job = res.job;
      run.textContent = "Cancel";
      progress.hidden = false;
      const poll = async () => {
        const st = await request({ action: "convert-status", job });
        progress.value = Number(st.progress ?? 0);
        if (st.state === "running") {
          window.setTimeout(() => void poll(), 700);
          return;
        }
        job = null;
        run.textContent = inserting ? "Convert and insert" : "Convert now";
        progress.hidden = true;
        if (st.state !== "done" || typeof st.path !== "string") {
          toast(
            `Conversion stopped: ${st.error || "cancelled"}`,
            "error"
          );
          return;
        }
        toast(`Converted to ${st.rel}`, "ok");
        finished = true;
        const placed = { path: st.path, rel: String(st.rel) };
        if (purpose.kind === "insert") purpose.done(placed);
        else if (use.checked) {
          await edit({
            action: "zone-media",
            slide: purpose.ctx.slide,
            zone: purpose.ctx.zone,
            src: st.path
          });
        }
        closeDialog();
      };
      void poll();
    });
    openDialog(
      "Convert video",
      h(
        "div",
        { class: "deck-form" },
        h("p", { class: "hint" }, `${name(path)}: ${describe(info4)}`),
        inserting && h(
          "p",
          { class: "hint warn" },
          "Browsers cannot play this file as it is: convert it to put it on the slide."
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Format"),
          formats
        ),
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Resolution"),
          size4
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Quality"),
          h(
            "div",
            { class: "video-quality" },
            h("span", { class: "hint" }, "Smaller"),
            slider,
            h("span", { class: "hint" }, "Better"),
            qualityLabel
          )
        ),
        h("label", { class: "check-row" }, sound, "Keep the sound"),
        estimate,
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "ffmpeg"),
          h("div", {}, command, h("div", { class: "btn-row" }, copy3))
        ),
        !data.tools.ffmpeg && h(
          "p",
          { class: "hint warn" },
          "ffmpeg is not installed here: copy the command and run it where it is, or install ffmpeg to convert from the editor."
        ),
        !inserting && h(
          "label",
          { class: "check-row" },
          use,
          "Use the converted video on this slide"
        ),
        h("div", { class: "btn-row end" }, progress, run)
      ),
      {
        wide: true,
        // Closed before it finished: an insert is called off, and a
        // source staged for it goes (cancelling a running ffmpeg first).
        onClose: () => {
          if (finished) return;
          if (job) void request({ action: "convert-cancel", job });
          if (purpose.kind === "insert") {
            void request({ action: "discard-source", path });
            purpose.done(null);
          }
        }
      }
    );
    if (inserting) run.textContent = "Convert and insert";
    void update();
  }
  function pickVideoFromDisk(start) {
    return new Promise((resolve) => {
      let chosen = null;
      const picker = folderPicker(start, () => {
      }, {
        kind: "video",
        onFile: (path) => {
          chosen = path;
          closeDialog();
        }
      });
      openDialog(
        "Insert a video from this computer",
        h(
          "div",
          { class: "deck-form" },
          h(
            "p",
            { class: "hint" },
            "Pick a video: the server copies it into the deck's assets/ folder straight from disk, however big it is."
          ),
          picker.el
        ),
        { large: true, onClose: () => resolve(chosen) }
      );
      picker.focus();
    });
  }

  // src/ts/editor/insert.ts
  var overlay = document.getElementById("overlay");
  var afterRender = {
    ids: [],
    editText: false
  };
  function setTool(tool) {
    ed.tool = tool;
    document.body.dataset.tool = tool;
    emit("tool");
  }
  function waitForModel(pred, ms = 5e3) {
    return new Promise((resolve) => {
      let done = false;
      const finish2 = (ok) => {
        if (done) return;
        done = true;
        off("model", check);
        resolve(ok);
      };
      const deadline = window.setTimeout(() => finish2(false), ms);
      const check = () => {
        const s2 = currentSlide();
        if (s2 && pred(s2)) {
          window.clearTimeout(deadline);
          finish2(true);
        }
      };
      on("model", check);
    });
  }
  async function ensureOwnDrawing() {
    const slide = currentSlide();
    if (!slide) return false;
    if (ed.master) return true;
    if (!slide.srcShared) return true;
    if (!ed.model?.deckEditable) {
      toast(
        "deck.py builds its slides in code; cannot add a drawing here",
        "error"
      );
      return false;
    }
    const deckIndex = slide.deckIndex;
    const result = await edit({
      action: "slide",
      op: "detach",
      slide: deckIndex,
      name: slide.id ?? slide.explicitId ?? "slide"
    });
    if (!result.ok) return false;
    toast("This slide now has its own SVG (built on its layout)");
    return waitForModel((s2) => s2.deckIndex === deckIndex && !s2.srcShared);
  }
  function ownSource() {
    const sources = currentSlide()?.sources ?? [];
    if (ed.master) {
      const target = ed.master.path;
      return sources.find((s2) => s2.path === target) ?? null;
    }
    return sources.find((s2) => s2.role === "slide") ?? null;
  }
  function ownKey() {
    const src = ownSource();
    const k2 = src ? (currentSlide()?.sources ?? []).indexOf(src) : 0;
    return Math.max(0, k2);
  }
  function insertParent() {
    const svg = slideRoot();
    const key = `${ownKey()}:`;
    if (ed.scope?.getAttribute("data-ink")?.startsWith(key)) {
      return { loc: ed.scope.getAttribute("data-ink"), el: ed.scope };
    }
    const layers = svg ? [
      ...svg.querySelectorAll(`[data-ink-layer][data-ink^="${key}"]`)
    ].filter((l2) => !l2.hasAttribute("data-ink-locked")) : [];
    const layer2 = layers[layers.length - 1];
    if (layer2) return { loc: layer2.getAttribute("data-ink"), el: layer2 };
    return { loc: key, el: null };
  }
  function toParent(el2, x2, y2) {
    const svg = slideRoot();
    if (!el2 || !svg) return { x: x2, y: y2 };
    const p2 = el2.getScreenCTM?.();
    const r2 = svg.getScreenCTM();
    if (!p2 || !r2) return { x: x2, y: y2 };
    const m2 = multiply(invert(mat(p2)), mat(r2));
    return { x: m2.a * x2 + m2.c * y2 + m2.e, y: m2.b * x2 + m2.d * y2 + m2.f };
  }
  async function insertXml(xml, base2, opts2 = {}) {
    if (!await ensureOwnDrawing()) return false;
    const src = ownSource();
    if (!src) return false;
    const parent = insertParent();
    const ops = [...opts2.before?.() ?? []];
    if (opts2.marker) ops.push({ kind: "ensure-marker" });
    if (typeof xml === "function") xml = xml();
    ops.push({ kind: "insert", parent: parent.loc, xml, base: base2, key: "new" });
    const result = await edit({
      action: "svg",
      file: src.path,
      hash: src.hash,
      ops,
      label: `Insert ${base2}`
    });
    if (!result.ok) return false;
    const id = result.ids?.new;
    if (id) {
      afterRender.ids = [id];
      afterRender.editText = !!opts2.editText;
    }
    return true;
  }
  function drawScale() {
    const vb = slideRoot()?.viewBox.baseVal;
    const short = vb && vb.width > 0 ? Math.min(vb.width, vb.height) : 1080;
    return Math.max(1, Math.round(short / 1080 * 10) / 10);
  }
  function textScale() {
    return (ed.model?.deckSize?.fontSize ?? 36) / 36;
  }
  var SHAPE_STYLE = {
    get rect() {
      return `class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:${fmt(4 * drawScale())}"`;
    },
    get ellipse() {
      return `class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:${fmt(4 * drawScale())}"`;
    },
    get line() {
      return `class="inkflow-stroke-text" style="fill:none;stroke-width:${fmt(6 * drawScale())};stroke-linecap:round"`;
    }
  };
  function shapeXml(tool, a2, b2) {
    const x2 = Math.min(a2.x, b2.x);
    const y2 = Math.min(a2.y, b2.y);
    const w2 = Math.abs(b2.x - a2.x);
    const h3 = Math.abs(b2.y - a2.y);
    switch (tool) {
      case "rect":
        return `<rect x="${fmt(x2)}" y="${fmt(y2)}" width="${fmt(w2)}" height="${fmt(h3)}" rx="${fmt(16 * drawScale())}" ${SHAPE_STYLE.rect}/>`;
      default:
        return `<ellipse cx="${fmt(x2 + w2 / 2)}" cy="${fmt(y2 + h3 / 2)}" rx="${fmt(w2 / 2)}" ry="${fmt(h3 / 2)}" ${SHAPE_STYLE.ellipse}/>`;
    }
  }
  function textXml(p2) {
    return `<text x="${fmt(p2.x)}" y="${fmt(p2.y)}" class="inkflow-fill-text" style="font-size:${fmt(56 * textScale())}px;font-family:var(--inkflow-body-font, sans-serif)">Text</text>`;
  }
  var draft = null;
  function drawDraft(tool, a2, b2, ends) {
    draft?.remove();
    const m2 = slideToPaper();
    const style = CONNECTOR_TOOLS[tool];
    if (style) {
      const r2 = route(style, ends?.a ?? a2, ends?.b ?? b2);
      const toPaper = (p2) => ({
        x: m2.a * p2.x + m2.e,
        y: m2.d * p2.y + m2.f
      });
      draft = svgEl("path", {
        d: pathData({ ...r2, points: r2.points.map(toPaper) }),
        class: "draft",
        fill: "none"
      });
    } else {
      const box2 = transformBox(m2, {
        x: Math.min(a2.x, b2.x),
        y: Math.min(a2.y, b2.y),
        width: Math.abs(b2.x - a2.x),
        height: Math.abs(b2.y - a2.y)
      });
      draft = tool === "ellipse" ? svgEl("ellipse", {
        cx: box2.x + box2.width / 2,
        cy: box2.y + box2.height / 2,
        rx: box2.width / 2,
        ry: box2.height / 2,
        class: "draft"
      }) : svgEl("rect", {
        x: box2.x,
        y: box2.y,
        width: box2.width,
        height: box2.height,
        class: "draft"
      });
    }
    overlay.append(draft);
  }
  async function insertConnector(tool, from, to, startHit, endHit) {
    let a2 = startHit ? startHit.site : from;
    let b2 = endHit ? endHit.site : to;
    if (Math.hypot(b2.x - a2.x, b2.y - a2.y) < 8) {
      a2 = { x: from.x - 150, y: from.y };
      b2 = { x: from.x + 150, y: from.y };
      startHit = null;
      endHit = null;
    }
    const before = [];
    const taken = /* @__PURE__ */ new Set();
    const attach = (hit) => {
      if (!hit) return null;
      let id = hit.el.getAttribute("id");
      if (!id && keyOf(hit.el) === 0) {
        const svg = slideRoot();
        let n3 = 1;
        const base2 = hit.el.localName;
        while (svg?.querySelector(`[id="${base2}-${n3}"]`) || taken.has(`${base2}-${n3}`))
          n3++;
        id = `${base2}-${n3}`;
        taken.add(id);
        hit.el.setAttribute("id", id);
        before.push({
          kind: "id",
          loc: hit.el.getAttribute("data-ink"),
          id
        });
      }
      return id ? `${id}:${hit.site.name}` : null;
    };
    const startAt = attach(startHit);
    const endAt = attach(endHit);
    const style = CONNECTOR_TOOLS[tool] ?? "straight";
    const arrow = tool !== "line";
    const attrs2 = [
      `inkflow:connector="${style}"`,
      startAt ? `inkflow:connect-start="${startAt}"` : "",
      endAt ? `inkflow:connect-end="${endAt}"` : "",
      arrow ? 'marker-end="url(#inkflow-arrow)"' : ""
    ].filter(Boolean).join(" ");
    await insertXml(
      // Routed into the insertion parent's space once it is known (a slide
      // drawn from a layout gets its own SVG first).
      () => `<path d="${newConnectorPath(style, a2, b2, insertParent().el)}" ${SHAPE_STYLE.line} ${attrs2}/>`,
      arrow ? "arrow" : "line",
      { marker: arrow, before: () => before }
    );
  }
  function onToolDown(e2, start) {
    const tool = ed.tool;
    if (tool === "select" || tool === "pen") return false;
    e2.preventDefault();
    clearSelection();
    const paperEl = e2.currentTarget;
    try {
      paperEl.setPointerCapture(e2.pointerId);
    } catch {
    }
    ed.interacting = true;
    const connecting = tool in CONNECTOR_TOOLS;
    const startHit = connecting && !e2.altKey ? siteAt(start, null) : null;
    if (startHit) start = { x: startHit.site.x, y: startHit.site.y };
    let endHit = null;
    let end = start;
    const move = (ev) => {
      end = clientToSlide(ev.clientX, ev.clientY);
      if (connecting) {
        endHit = ev.altKey ? null : siteAt(end, null);
        if (endHit) end = { x: endHit.site.x, y: endHit.site.y };
        const under = attachTargetAt(ev.clientX, ev.clientY);
        showSites([
          ...under ? [
            {
              el: under,
              active: endHit?.el === under ? endHit.site : null
            }
          ] : [],
          ...endHit && endHit.el !== under ? [{ el: endHit.el, active: endHit.site }] : [],
          ...startHit ? [{ el: startHit.el, active: startHit.site }] : []
        ]);
      }
      if (ev.shiftKey && (tool === "rect" || tool === "ellipse")) {
        const d2 = Math.max(
          Math.abs(end.x - start.x),
          Math.abs(end.y - start.y)
        );
        end = {
          x: start.x + Math.sign(end.x - start.x || 1) * d2,
          y: start.y + Math.sign(end.y - start.y || 1) * d2
        };
      }
      drawDraft(
        tool,
        start,
        end,
        connecting ? {
          a: startHit ? startHit.site : start,
          b: endHit ? endHit.site : end
        } : void 0
      );
    };
    const up = () => {
      paperEl.removeEventListener("pointermove", move);
      paperEl.removeEventListener("pointerup", up);
      draft?.remove();
      draft = null;
      ed.interacting = false;
      let a2 = start;
      let b2 = end;
      if (connecting) {
        showSites([]);
        void insertConnector(tool, start, end, startHit, endHit);
        setTool("select");
        drawOverlay();
        return;
      }
      if (tool === "text") {
        void insertTextBox(start, end);
        setTool("select");
        drawOverlay();
        return;
      }
      if (Math.hypot(b2.x - a2.x, b2.y - a2.y) < 8) {
        const w2 = 360;
        const h3 = 220;
        a2 = { x: start.x - w2 / 2, y: start.y - h3 / 2 };
        b2 = { x: start.x + w2 / 2, y: start.y + h3 / 2 };
      }
      const parent = insertParent().el;
      const pa = toParent(parent, a2.x, a2.y);
      const pb = toParent(parent, b2.x, b2.y);
      void insertXml(shapeXml(tool, pa, pb), tool);
      setTool("select");
      if (ed.renderPending) emit("model");
      drawOverlay();
    };
    paperEl.addEventListener("pointermove", move);
    paperEl.addEventListener("pointerup", up);
    return true;
  }
  async function insertTextBox(a2, b2) {
    const slide = currentSlide();
    if (!slide) return;
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    let box2 = {
      x: Math.min(a2.x, b2.x),
      y: Math.min(a2.y, b2.y),
      width: Math.abs(b2.x - a2.x),
      height: Math.abs(b2.y - a2.y)
    };
    if (box2.width < 40 || box2.height < 20) {
      const k2 = textScale();
      box2 = {
        x: a2.x,
        y: a2.y - 40 * k2,
        width: Math.max(300 * k2, Math.min(900 * k2, vw - a2.x - 60 * k2)),
        height: 100 * k2
      };
    }
    const plain2 = ed.layoutMode || !ed.model?.deckEditable && !slide.md;
    if (plain2) {
      const p2 = toParent(insertParent().el, a2.x, a2.y);
      await insertXml(textXml(p2), "text", { editText: true });
      return;
    }
    if (!await ensureOwnDrawing()) return;
    const src = ownSource();
    const current3 = currentSlide();
    if (!src || !current3) return;
    const parent = insertParent();
    const p0 = toParent(parent.el, box2.x, box2.y);
    const p1 = toParent(parent.el, box2.x + box2.width, box2.y + box2.height);
    const result = await edit({
      action: "insert-textbox",
      slide: current3.deckIndex,
      file: src.path,
      hash: src.hash,
      parent: parent.loc,
      x: Math.round(Math.min(p0.x, p1.x)),
      y: Math.round(Math.min(p0.y, p1.y)),
      width: Math.round(Math.abs(p1.x - p0.x)),
      height: Math.round(Math.abs(p1.y - p0.y)),
      text: "Text"
    });
    const id = result.ids?.new;
    if (result.ok && id) {
      afterRender.ids = [id];
      afterRender.editText = true;
    }
  }
  async function typeInto(el2) {
    const slide = currentSlide();
    const loc = el2.getAttribute("data-ink");
    const src = slide?.sources?.[keyOf(el2)];
    if (!slide || !loc || !src) return;
    if (!ed.model?.deckEditable && !slide.md) {
      toast(
        "deck.py builds its slides in code; there is nowhere to keep the text",
        "error"
      );
      return;
    }
    const result = await edit({
      action: "shape-text",
      slide: slide.deckIndex,
      file: src.path,
      hash: src.hash,
      loc
    });
    const id = result.ids?.new;
    if (result.ok && id) {
      afterRender.ids = [id];
      afterRender.editText = true;
    }
  }
  function zonePlaceholder(zone) {
    const words = zone.replace(/[-_]+/g, " ").trim() || "Text";
    return words[0].toUpperCase() + words.slice(1);
  }
  async function zoneText(zone) {
    const slide = currentSlide();
    if (!slide) return;
    const hint = slide.emptyZones?.find((z) => z.zone === zone)?.hint;
    const text = hint ?? zonePlaceholder(zone);
    const result = await edit({
      action: "zone-text",
      slide: slide.deckIndex,
      zone,
      text
    });
    if (!result.ok) return;
    afterRender.ids = [`zone-${zone}`];
    afterRender.editText = true;
    afterRender.placeholder = text;
  }
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  var CHUNK = 4 * 1024 * 1024;
  async function upload(media) {
    if (!(media instanceof File)) {
      const result2 = await request({
        action: "import-path",
        path: media.path
      });
      if (result2.ok && result2.convert) {
        return convertForInsert(String(result2.source));
      }
      if (result2.ok && result2.path && result2.rel) {
        return { path: result2.path, rel: result2.rel };
      }
      if (media.file) return upload(media.file);
      toast(result2.error ?? "could not copy the file", "error");
      return null;
    }
    const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const big = media.size > 3 * CHUNK;
    let result = { ok: false };
    for (let at3 = 0; at3 < media.size || at3 === 0; at3 += CHUNK) {
      const last = at3 + CHUNK >= media.size;
      const data = await readBase64(media.slice(at3, at3 + CHUNK));
      result = await request({
        action: "upload-chunk",
        upload: id,
        name: media.name,
        data,
        last
      });
      if (!result.ok) {
        toast(result.error ?? "upload failed", "error");
        return null;
      }
      if (big) {
        const done = Math.min(
          100,
          Math.round((at3 + CHUNK) / media.size * 100)
        );
        toast(`Copying ${media.name}\u2026 ${done}%`);
      }
      if (last) break;
    }
    if (result.convert) return convertForInsert(String(result.source));
    if (!result.path || !result.rel) return null;
    return { path: result.path, rel: result.rel };
  }
  function droppedPath(dt) {
    const list4 = dt?.getData("text/uri-list") ?? "";
    const uri = list4.split(/\r?\n/).find((line) => line.startsWith("file://"));
    if (!uri) return null;
    try {
      const url = new URL(uri);
      if (url.host && url.host !== "localhost") return null;
      return decodeURIComponent(url.pathname).replace(
        /^\/([A-Za-z]:\/)/,
        "$1"
      );
    } catch {
      return null;
    }
  }
  function naturalSize(rel) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({
        w: img.naturalWidth || 400,
        h: img.naturalHeight || 300
      });
      img.onerror = () => resolve({ w: 400, h: 300 });
      img.src = `/${rel}`;
    });
  }
  function videoSize(rel) {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      const fallback = { w: 1280, h: 720, decoded: false, duration: null };
      const timer6 = window.setTimeout(() => resolve(fallback), 3e3);
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () => {
        window.clearTimeout(timer6);
        const duration = Number.isFinite(video.duration) ? video.duration : null;
        resolve(
          video.videoWidth && video.videoHeight ? {
            w: video.videoWidth,
            h: video.videoHeight,
            decoded: true,
            duration
          } : { ...fallback, duration }
        );
      };
      video.onerror = () => {
        window.clearTimeout(timer6);
        resolve(fallback);
      };
      video.src = `/${rel}`;
    });
  }
  var VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|mkv|avi|m4v|wmv|flv|mpe?g|ts|mts|m2ts|3gp|3g2|mxf|vob|f4v|asf|dv)$/i;
  var VIDEO_ACCEPT = "video/*,.mkv,.avi,.m4v,.wmv,.flv,.mpg,.mpeg,.ts,.mts,.m2ts,.3gp,.mxf,.vob,.dv";
  function isVideo(file) {
    return file instanceof File && file.type.startsWith("video/") || VIDEO_EXT.test(file.name);
  }
  var IMAGE_ACCEPT = "image/*,.pdf,application/pdf";
  function isImage(file) {
    return file instanceof File && (file.type.startsWith("image/") || file.type === "application/pdf") || /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(file.name);
  }
  async function insertVideoFile(file, at3) {
    if (ed.master) {
      toast(
        "A video belongs to a slide: add a picture placeholder here, and each slide puts its video in it",
        "error"
      );
      return;
    }
    if (!await ensureOwnDrawing()) return;
    const up = await upload(file);
    const src = ownSource();
    const slide = currentSlide();
    if (!up || !src || !slide) return;
    const size4 = await videoSize(up.rel);
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    const vh = vb?.height || 1080;
    const k2 = Math.min(vw * 0.6 / size4.w, vh * 0.6 / size4.h);
    const w2 = size4.w * k2;
    const h3 = size4.h * k2;
    const cx = Math.min(Math.max(at3?.x ?? vw / 2, w2 / 2), vw - w2 / 2);
    const cy = Math.min(Math.max(at3?.y ?? vh / 2, h3 / 2), vh - h3 / 2);
    const parent = insertParent();
    const a2 = toParent(parent.el, cx - w2 / 2, cy - h3 / 2);
    const b2 = toParent(parent.el, cx + w2 / 2, cy + h3 / 2);
    const result = await edit({
      action: "insert-video",
      slide: slide.deckIndex,
      file: src.path,
      hash: src.hash,
      parent: parent.loc,
      x: Math.round(Math.min(a2.x, b2.x)),
      y: Math.round(Math.min(a2.y, b2.y)),
      width: Math.round(Math.abs(b2.x - a2.x)),
      height: Math.round(Math.abs(b2.y - a2.y)),
      src: up.path
    });
    const id = result.ids?.new;
    if (result.ok && id) {
      afterRender.ids = [id];
      void checkVideo({
        path: up.path,
        slide: slide.deckIndex,
        zone: id.replace(/^zone-/, ""),
        browser: size4
      });
    }
  }
  async function insertVideo() {
    const file = await pickFile(VIDEO_ACCEPT);
    if (file) await insertVideoFile(file);
  }
  async function insertFile(file, at3) {
    const zone = at3 ? mediaZoneAt(at3.clientX, at3.clientY) : null;
    if (zone) {
      await fillZone(zone, file);
      return;
    }
    if (isImage(file)) await insertImageFile(file, at3);
    else await insertVideoFile(file, at3);
  }
  async function insertImageFile(file, at3) {
    if (!await ensureOwnDrawing()) return;
    const up = await upload(file);
    const src = ownSource();
    if (!up || !src) return;
    let href = relativePath(refBase(src), up.path);
    let shown3 = up.rel;
    if (isPdfRef(up.path)) {
      const choice = await choosePage(up.path);
      if (!choice) return;
      href = withPage(href, choice.page);
      shown3 = choice.url;
    }
    const size4 = shown3 ? await naturalSize(shown3) : { w: 400, h: 300 };
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const maxW = (vb?.width || 1920) * 0.5;
    const maxH = (vb?.height || 1080) * 0.5;
    const k2 = Math.min(1, maxW / size4.w, maxH / size4.h);
    const w2 = size4.w * k2;
    const h3 = size4.h * k2;
    const cx = at3?.x ?? (vb?.width || 1920) / 2;
    const cy = at3?.y ?? (vb?.height || 1080) / 2;
    const parent = insertParent().el;
    const p2 = toParent(parent, cx - w2 / 2, cy - h3 / 2);
    await insertXml(
      `<image href="${href}" x="${fmt(p2.x)}" y="${fmt(p2.y)}" width="${fmt(w2)}" height="${fmt(h3)}" preserveAspectRatio="xMidYMid meet"/>`,
      "image"
    );
  }
  async function insertDiagramImage(path, width, height2) {
    if (!await ensureOwnDrawing()) return false;
    const src = ownSource();
    if (!src) return false;
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const slideW = vb?.width || 1920;
    const slideH = vb?.height || 1080;
    const k2 = Math.min(1, slideW * 0.6 / width, slideH * 0.6 / height2);
    const w2 = width * k2;
    const ht = height2 * k2;
    const parent = insertParent().el;
    const p2 = toParent(parent, (slideW - w2) / 2, (slideH - ht) / 2);
    return insertXml(
      `<image href="${relativePath(refBase(src), path)}" x="${fmt(p2.x)}" y="${fmt(p2.y)}" width="${fmt(w2)}" height="${fmt(ht)}" preserveAspectRatio="xMidYMid meet"/>`,
      "diagram"
    );
  }
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  }
  async function insertImage() {
    const file = await pickFile(IMAGE_ACCEPT);
    if (file) await insertImageFile(file);
  }
  var MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;
  async function fillZone(zone, file) {
    const slide = currentSlide();
    if (!slide) return;
    const up = await upload(file);
    if (!up) return;
    const choice = isPdfRef(up.path) ? await choosePage(up.path) : null;
    if (isPdfRef(up.path) && !choice) return;
    const result = await edit({
      action: "zone-media",
      slide: slide.deckIndex,
      zone,
      src: up.path,
      page: choice?.page ?? null,
      fit: slide.zones[zone]?.fit ?? "cover"
    });
    if (result.ok && isVideo(file)) {
      void checkVideo({
        path: up.path,
        slide: slide.deckIndex,
        zone,
        browser: await videoSize(up.rel)
      });
    }
  }
  async function zoneMedia(zone) {
    const file = await pickFile(MEDIA_ACCEPT);
    if (file) await fillZone(zone, file);
  }
  function cleanForPaste(el2) {
    const copy3 = el2.cloneNode(true);
    for (const node of [copy3, ...copy3.querySelectorAll("*")]) {
      if (node.hasAttribute("data-inkflow-pdf")) {
        node.setAttribute("href", sourceRef(node));
        node.removeAttribute("xlink:href");
      }
      for (const attr of [...node.attributes]) {
        const name2 = attr.name;
        if (name2.startsWith("data-")) node.removeAttribute(name2);
        else if (name2 === "xlink:href") {
          node.setAttribute("href", assetRef(attr.value));
          node.removeAttribute(name2);
        } else if (["href", "src", "poster"].includes(name2)) {
          node.setAttribute(name2, assetRef(attr.value));
        } else if (name2.includes(":") && !name2.startsWith("xml:")) {
          node.removeAttribute(name2);
        } else if (name2 === "class") {
          const kept = attr.value.split(/\s+/).filter((c2) => c2 && !c2.startsWith("anim-"));
          if (kept.length) node.setAttribute("class", kept.join(" "));
          else node.removeAttribute("class");
        }
      }
      node.style?.removeProperty?.("visibility");
    }
    return new XMLSerializer().serializeToString(copy3);
  }
  function initInsert() {
    hooks.toolDown = onToolDown;
    hooks.typeInto = (el2) => void typeInto(el2);
    hooks.zoneMedia = (zone) => void zoneMedia(zone);
    hooks.zoneText = (zone) => void zoneText(zone);
    hooks.selectAfterRender = (ids) => {
      afterRender.ids = ids;
    };
    const canvas2 = document.getElementById("canvas");
    canvas2.addEventListener("dragover", (e2) => {
      if (e2.dataTransfer?.types.includes("Files")) {
        e2.preventDefault();
        canvas2.classList.add("drop");
      }
    });
    canvas2.addEventListener("dragleave", () => canvas2.classList.remove("drop"));
    canvas2.addEventListener("drop", (e2) => {
      canvas2.classList.remove("drop");
      const file = e2.dataTransfer?.files?.[0];
      if (!file) return;
      e2.preventDefault();
      const at3 = {
        ...clientToSlide(e2.clientX, e2.clientY),
        clientX: e2.clientX,
        clientY: e2.clientY
      };
      const path = droppedPath(e2.dataTransfer);
      void insertFile(path ? { path, name: file.name, file } : file, at3);
    });
    document.addEventListener("paste", (e2) => {
      const target = e2.target;
      if (target.closest("textarea, input")) return;
      const file = [...e2.clipboardData?.files ?? []].find(
        (f2) => f2.type.startsWith("image/") || f2.type === "application/pdf" || isVideo(f2)
      );
      if (file) {
        e2.preventDefault();
        void insertFile(file);
        return;
      }
      e2.preventDefault();
      void pasteText(e2.clipboardData?.getData("text/plain") ?? "");
    });
  }

  // src/ts/editor/clipboard.ts
  var PREFIX = "inkflow-clipboard:";
  var lastCopied = null;
  async function put(payload) {
    const text = PREFIX + JSON.stringify(payload);
    lastCopied = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast("Copied for this tab only: the browser blocked the clipboard");
    }
  }
  function selectedSlides() {
    const picked = [...ed.slideSelection].sort((a2, b2) => a2 - b2);
    return picked.length ? picked : [ed.current];
  }
  async function copySlides(indices = selectedSlides()) {
    const result = await request({ action: "copy-slides", slides: indices });
    if (!result.ok) {
      toast(result.error ?? "could not copy", "error");
      return false;
    }
    const bundle = result.bundle;
    await put(bundle);
    const dropped = bundle.dropped ?? [];
    const n3 = indices.length;
    toast(
      `Copied ${n3} slide${n3 > 1 ? "s" : ""}` + (dropped.length ? `; left out ${dropped.join(", ")}` : "")
    );
    return true;
  }
  async function cutSlides() {
    const indices = selectedSlides();
    if (!await copySlides(indices)) return;
    const result = await edit({
      action: "slide",
      op: "delete",
      slides: indices
    });
    if (result.ok) {
      ed.slideSelection.clear();
      ed.current = Math.max(0, Math.min(...indices) - 1);
      emit("slide");
    }
  }
  function imageRefs(xml) {
    const refs = /* @__PURE__ */ new Set();
    for (const m2 of xml.matchAll(
      /<image\b[^>]*?\b(?:xlink:)?href="([^"]*)"/g
    )) {
      if (!/^(data:|https?:|#|\/)/.test(m2[1])) refs.add(m2[1]);
    }
    return [...refs];
  }
  async function copyObjects(cut2 = false) {
    const sels = ed.selection.filter((s2) => s2.el.localName !== "foreignObject");
    if (!sels.length) return false;
    const fragments = sels.map((s2) => cleanForPaste(s2.el));
    const refs = fragments.flatMap(imageRefs);
    let files2 = {};
    if (refs.length) {
      const result = await request({ action: "copy-assets", refs });
      files2 = result.files ?? {};
    }
    await put({
      type: "inkflow-objects",
      version: 1,
      project: ed.model?.projectDir,
      sourceFile: currentSlide()?.sources?.[sels[0].key]?.path ?? "",
      fragments,
      files: files2
    });
    const n3 = sels.length;
    toast(`${cut2 ? "Cut" : "Copied"} ${n3} object${n3 > 1 ? "s" : ""}`);
    if (cut2) emit("delete");
    return true;
  }
  function copy() {
    if (ed.selection.length) void copyObjects();
    else void copySlides();
  }
  function cut() {
    if (ed.selection.some((s2) => canTransform(s2.el))) void copyObjects(true);
    else void cutSlides();
  }
  async function pasteSlides(bundle) {
    const after = ed.current;
    const result = await edit({ action: "paste-slides", after, bundle });
    if (!result.ok) return;
    const n3 = result.pasted;
    toast(`Pasted ${n3} slide${n3 > 1 ? "s" : ""}`, "ok");
    ed.slideSelection.clear();
    afterSlides = after + 1;
  }
  var afterSlides = null;
  function followPastedSlides() {
    if (afterSlides != null && afterSlides < (ed.model?.slides.length ?? 0)) {
      const target = afterSlides;
      afterSlides = null;
      gotoSlide(target);
    }
  }
  async function pasteObjects(bundle) {
    if (!await ensureOwnDrawing()) return;
    const src = ownSource();
    if (!src) return;
    const sameFile = bundle.sourceFile === src.path;
    clearSelection();
    const result = await edit({
      action: "paste-objects",
      file: src.path,
      hash: src.hash,
      parent: insertParent().loc,
      fragments: bundle.fragments,
      files: bundle.files,
      // Copies on the same slide are offset so they do not hide the original.
      offset: sameFile ? [24, 24] : null
    });
    if (result.ok && result.ids) afterRender.ids = Object.values(result.ids);
  }
  async function pasteText(text) {
    const raw = text.startsWith(PREFIX) ? text : lastCopied;
    if (!raw?.startsWith(PREFIX)) return;
    let bundle;
    try {
      bundle = JSON.parse(raw.slice(PREFIX.length));
    } catch {
      toast("The clipboard holds damaged inkflow data", "error");
      return;
    }
    if (bundle.type === "inkflow-slides") await pasteSlides(bundle);
    else if (bundle.type === "inkflow-objects") await pasteObjects(bundle);
  }
  async function pasteFromClipboard() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = lastCopied ?? "";
    }
    await pasteText(text);
  }

  // src/ts/editor/commentstext.ts
  function slideThreads(threads2, slideId2) {
    return threads2.filter((t2) => slideId2 != null && t2.slide === slideId2).sort(
      (a2, b2) => Number(a2.resolved) - Number(b2.resolved) || a2.created - b2.created
    );
  }
  function openCount(threads2, slideId2) {
    return slideThreads(threads2, slideId2).filter((t2) => !t2.resolved).length;
  }
  function ago(at3, now = Date.now() / 1e3) {
    const s2 = Math.max(0, now - at3);
    if (s2 < 60) return "just now";
    if (s2 < 3600) return `${Math.floor(s2 / 60)} min ago`;
    if (s2 < 86400) return `${Math.floor(s2 / 3600)} h ago`;
    if (s2 < 86400 * 7) {
      const d2 = Math.floor(s2 / 86400);
      return `${d2} day${d2 === 1 ? "" : "s"} ago`;
    }
    return new Date(at3 * 1e3).toISOString().slice(0, 10);
  }
  function whereWords(t2) {
    if (t2.target) return `on #${t2.target}`;
    if (t2.x != null && t2.y != null)
      return `at ${Math.round(t2.x)}, ${Math.round(t2.y)}`;
    return "on the slide";
  }
  function commentTitle(threads2) {
    const open5 = threads2.filter((t2) => !t2.resolved);
    if (!open5.length) return "";
    const lines = open5.map((t2) => {
      const first = t2.messages[0];
      const more = t2.messages.length > 1 ? ` (+${t2.messages.length - 1})` : "";
      return `${first?.name || "someone"}: ${(first?.text ?? "").slice(0, 80)}${more}`;
    });
    return `${open5.length} open comment${open5.length === 1 ? "" : "s"}
${lines.join("\n")}`;
  }

  // src/ts/editor/keystext.ts
  var GROUPS = [
    "Tools",
    "Insert",
    "Edit",
    "Arrange",
    "Slides",
    "View",
    "Review",
    "Help"
  ];
  var SHORTCUTS = [
    { id: "tool.select", group: "Tools", label: "Select", keys: ["V"] },
    { id: "tool.text", group: "Tools", label: "Text", keys: ["T"] },
    { id: "tool.rect", group: "Tools", label: "Rectangle", keys: ["R"] },
    { id: "tool.ellipse", group: "Tools", label: "Ellipse", keys: ["O"] },
    { id: "tool.line", group: "Tools", label: "Line", keys: ["L"] },
    { id: "tool.arrow", group: "Tools", label: "Arrow", keys: ["A"] },
    { id: "tool.elbow", group: "Tools", label: "Elbow arrow", keys: ["E"] },
    { id: "tool.curve", group: "Tools", label: "Curved arrow", keys: ["C"] },
    { id: "tool.pen", group: "Tools", label: "Pen", keys: ["P"] },
    { id: "insert.image", group: "Insert", label: "Image", keys: ["I"] },
    { id: "insert.video", group: "Insert", label: "Video", keys: ["Shift+I"] },
    {
      id: "edit.undo",
      group: "Edit",
      label: "Undo",
      keys: ["Ctrl+Z"],
      fixed: true
    },
    {
      id: "edit.redo",
      group: "Edit",
      label: "Redo",
      keys: ["Ctrl+Shift+Z", "Ctrl+Y"],
      fixed: true
    },
    {
      id: "edit.clipboard",
      group: "Edit",
      label: "Copy, cut, paste (objects, or slides in the slide list)",
      keys: ["Ctrl+C", "Ctrl+X", "Ctrl+V"],
      fixed: true
    },
    {
      id: "edit.all",
      group: "Edit",
      label: "Select everything on the slide",
      keys: ["Ctrl+A"],
      fixed: true
    },
    {
      id: "edit.delete",
      group: "Edit",
      label: "Delete the selection (in the slide list: the slides)",
      keys: ["Delete", "Backspace"],
      fixed: true
    },
    {
      id: "edit.enter",
      group: "Edit",
      label: "Edit the selected text or zone, type into a shape",
      keys: ["Enter"],
      fixed: true
    },
    {
      id: "edit.escape",
      group: "Edit",
      label: "Back to Select, leave a group, select nothing",
      keys: ["Escape"],
      fixed: true
    },
    {
      id: "edit.nudge",
      group: "Edit",
      label: "Move the selection (Shift: by 10)",
      keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
      fixed: true
    },
    {
      id: "edit.duplicate",
      group: "Edit",
      label: "Duplicate",
      keys: ["Ctrl+D"]
    },
    {
      id: "edit.copy-style",
      group: "Edit",
      label: "Copy an object's style",
      keys: ["Ctrl+Alt+C"]
    },
    {
      id: "edit.paste-style",
      group: "Edit",
      label: "Paste the style onto the selection",
      keys: ["Ctrl+Alt+V"]
    },
    { id: "edit.find", group: "Edit", label: "Find", keys: ["Ctrl+F"] },
    { id: "edit.replace", group: "Edit", label: "Replace", keys: ["Ctrl+H"] },
    { id: "arrange.group", group: "Arrange", label: "Group", keys: ["Ctrl+G"] },
    {
      id: "arrange.ungroup",
      group: "Arrange",
      label: "Ungroup",
      keys: ["Ctrl+Shift+G"]
    },
    {
      id: "arrange.forward",
      group: "Arrange",
      label: "Bring forward",
      keys: ["Ctrl+ArrowUp"]
    },
    {
      id: "arrange.backward",
      group: "Arrange",
      label: "Send backward",
      keys: ["Ctrl+ArrowDown"]
    },
    {
      id: "arrange.front",
      group: "Arrange",
      label: "Bring to front",
      keys: ["Ctrl+Shift+ArrowUp"]
    },
    {
      id: "arrange.back",
      group: "Arrange",
      label: "Send to back",
      keys: ["Ctrl+Shift+ArrowDown"]
    },
    {
      id: "slide.next",
      group: "Slides",
      label: "Next / previous slide",
      keys: ["PageDown", "PageUp"],
      fixed: true
    },
    {
      id: "slide.new",
      group: "Slides",
      label: "New slide on this slide's layout",
      keys: ["Ctrl+M"]
    },
    {
      id: "slide.gallery",
      group: "Slides",
      label: "New slide from the layout gallery",
      keys: ["Ctrl+Shift+M"]
    },
    {
      id: "slide.star",
      group: "Slides",
      label: "Star / unstar the slide",
      keys: ["S"]
    },
    {
      id: "slide.present",
      group: "Slides",
      label: "Present from this slide",
      keys: ["Ctrl+Enter"]
    },
    {
      id: "view.grid",
      group: "View",
      label: "Grid view of all slides",
      keys: ["G"]
    },
    {
      id: "view.fullscreen",
      group: "View",
      label: "Full screen",
      keys: ["F"]
    },
    {
      id: "view.left",
      group: "View",
      label: "Hide / show the slide list",
      keys: ["1"]
    },
    {
      id: "view.bottom",
      group: "View",
      label: "Hide / show the speaker notes",
      keys: ["2"]
    },
    {
      id: "view.right",
      group: "View",
      label: "Hide / show the properties",
      keys: ["3"]
    },
    { id: "view.zoom-in", group: "View", label: "Zoom in", keys: ["+", "="] },
    { id: "view.zoom-out", group: "View", label: "Zoom out", keys: ["-"] },
    { id: "view.zoom-fit", group: "View", label: "Fit the slide", keys: ["0"] },
    {
      id: "review.comment",
      group: "Review",
      label: "Add a review comment",
      keys: ["Shift+C"]
    },
    {
      id: "review.next-change",
      group: "Review",
      label: "Next slide with changes since the last commit",
      keys: ["Alt+F5"]
    },
    {
      id: "review.prev-change",
      group: "Review",
      label: "Previous slide with changes",
      keys: ["Alt+Shift+F5"]
    },
    {
      id: "help.palette",
      group: "Help",
      label: "Command palette",
      keys: ["Space", "Ctrl+K", "Ctrl+Shift+P"]
    },
    {
      id: "help.shortcuts",
      group: "Help",
      label: "Keyboard shortcuts",
      keys: ["?"]
    }
  ];
  function shortcut(id) {
    return SHORTCUTS.find((s2) => s2.id === id);
  }
  var MODIFIERS = /* @__PURE__ */ new Set(["Control", "Meta", "Shift", "Alt", "AltGraph"]);
  function comboOf(e2) {
    if (MODIFIERS.has(e2.key)) return "";
    const ctrl = e2.ctrlKey || e2.metaKey;
    const mods = [];
    if (ctrl) mods.push("Ctrl");
    if (e2.altKey) mods.push("Alt");
    const letter2 = /^Key([A-Z])$/.exec(e2.code)?.[1];
    const digit = /^Digit([0-9])$/.exec(e2.code)?.[1];
    let name2;
    let shift = e2.shiftKey;
    if ((ctrl || e2.altKey) && (letter2 || digit)) name2 = letter2 ?? digit;
    else if (/^[a-z]$/i.test(e2.key)) name2 = e2.key.toUpperCase();
    else if (/^[0-9]$/.test(e2.key)) name2 = e2.key;
    else if (e2.key === " ") name2 = "Space";
    else if (e2.key.length === 1) {
      if (letter2) name2 = letter2;
      else {
        name2 = e2.key;
        shift = false;
      }
    } else name2 = e2.key;
    if (shift) mods.push("Shift");
    return [...mods, name2].join("+");
  }
  var SYMBOLS = {
    ArrowUp: "\u2191",
    ArrowDown: "\u2193",
    ArrowLeft: "\u2190",
    ArrowRight: "\u2192",
    Escape: "Esc",
    Delete: "Del"
  };
  function display(combo, mac = false) {
    return combo.split(/\+(?=.)/).map((p2) => p2 === "Ctrl" && mac ? "\u2318" : SYMBOLS[p2] ?? p2).join("+");
  }
  function effective(overrides2) {
    const out = {};
    for (const s2 of SHORTCUTS) {
      const own = s2.fixed ? void 0 : overrides2[s2.id];
      out[s2.id] = Array.isArray(own) ? own : s2.keys;
    }
    return out;
  }
  function commandOf(keys, combo) {
    if (!combo) return null;
    for (const s2 of SHORTCUTS) {
      if (keys[s2.id]?.includes(combo)) return s2.id;
    }
    return null;
  }
  function parseOverrides(stored2) {
    if (!stored2) return {};
    try {
      const raw = JSON.parse(stored2);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out = {};
      for (const [id, keys] of Object.entries(raw)) {
        const s2 = shortcut(id);
        if (!s2 || s2.fixed || !Array.isArray(keys)) continue;
        out[id] = keys.filter(
          (k2) => typeof k2 === "string" && !!k2
        );
      }
      return out;
    } catch {
      return {};
    }
  }
  function assign(overrides2, id, combo) {
    const s2 = shortcut(id);
    if (!s2 || s2.fixed)
      return { ok: false, error: "These keys cannot be changed" };
    if (!combo)
      return { ok: false, error: "Press a key, not only Ctrl, Alt or Shift" };
    if (combo === "Tab" || combo === "Shift+Tab")
      return {
        ok: false,
        error: "Tab moves between fields; pick another key"
      };
    const keys = effective(overrides2);
    const owner = commandOf(keys, combo);
    if (owner === id) return { ok: true, overrides: overrides2, took: null };
    const out = { ...overrides2, [id]: [combo] };
    let took = null;
    if (owner) {
      const other = shortcut(owner);
      if (other.fixed)
        return { ok: false, error: `${combo} is ${other.label}` };
      out[owner] = keys[owner].filter((k2) => k2 !== combo);
      took = owner;
    }
    return { ok: true, overrides: tidy(out), took };
  }
  function reset(overrides2, id) {
    const s2 = shortcut(id);
    if (!s2) return overrides2;
    const out = { ...overrides2 };
    delete out[id];
    const keys = effective(out);
    for (const other of SHORTCUTS) {
      if (other.id === id || other.fixed) continue;
      const kept = keys[other.id].filter((k2) => !s2.keys.includes(k2));
      if (kept.length !== keys[other.id].length) out[other.id] = kept;
    }
    return tidy(out);
  }
  function tidy(overrides2) {
    const out = {};
    for (const [id, keys] of Object.entries(overrides2)) {
      const s2 = shortcut(id);
      if (!s2) continue;
      if (keys.length === s2.keys.length && keys.every((k2, i2) => k2 === s2.keys[i2]))
        continue;
      out[id] = keys;
    }
    return out;
  }
  function retitle(base2, defaults, now) {
    const was = [`(${defaults.join(", ")})`, `(${defaults[0]})`].find(
      (w2) => base2.includes(w2)
    );
    if (!was) return base2;
    if (!now.length) return base2.replace(` ${was}`, "").replace(was, "");
    return base2.replace(was, `(${now.join(", ")})`);
  }
  function filterShortcuts(keys, query2) {
    const q = query2.trim().toLowerCase();
    if (!q) return [...SHORTCUTS];
    return SHORTCUTS.filter(
      (s2) => `${s2.group} ${s2.label} ${keys[s2.id].join(" ")}`.toLowerCase().includes(q)
    );
  }

  // src/ts/editor/keys.ts
  var KEY = "inkflow-editor-keys";
  var DOCS = "https://ll-nick.github.io/inkflow/editor/";
  var overrides = {};
  var bindings = effective(overrides);
  function load() {
    try {
      overrides = parseOverrides(localStorage.getItem(KEY));
    } catch {
      overrides = {};
    }
    bindings = effective(overrides);
  }
  function save(next) {
    overrides = next;
    bindings = effective(overrides);
    try {
      if (Object.keys(overrides).length)
        localStorage.setItem(KEY, JSON.stringify(overrides));
      else localStorage.removeItem(KEY);
    } catch {
    }
    retitleAll();
    emit("keys");
  }
  function commandFor(e2) {
    return commandOf(bindings, comboOf(e2));
  }
  function matches(e2, id) {
    const combo = comboOf(e2);
    return !!combo && (bindings[id] ?? []).includes(combo);
  }
  function keyLabel(id) {
    return (bindings[id] ?? []).map((k2) => display(k2)).join(", ");
  }
  function firstKey(id) {
    const k2 = bindings[id]?.[0];
    return k2 ? display(k2) : "";
  }
  function retitleAll() {
    for (const el2 of document.querySelectorAll("[data-keys]")) {
      el2.dataset.baseTitle ??= el2.title;
      let title3 = el2.dataset.baseTitle;
      for (const id of (el2.dataset.keys ?? "").split(/\s+/)) {
        const s2 = shortcut(id);
        if (!s2) continue;
        title3 = retitle(
          title3,
          s2.keys.map((k2) => display(k2)),
          (bindings[id] ?? []).map((k2) => display(k2))
        );
      }
      el2.title = title3;
    }
  }
  var recording = null;
  var redraw = null;
  function chips(keys) {
    if (!keys.length) return [h("span", { class: "keys-none" }, "none")];
    return keys.map((k2) => h("kbd", {}, display(k2)));
  }
  function stopRecording() {
    recording = null;
    window.removeEventListener("keydown", onRecordKey, true);
    redraw?.();
  }
  function onRecordKey(e2) {
    if (!recording) return;
    e2.preventDefault();
    e2.stopImmediatePropagation();
    const combo = comboOf(e2);
    if (!combo) return;
    const { id } = recording;
    if (combo === "Escape") {
      stopRecording();
      return;
    }
    if (combo === "Backspace" || combo === "Delete") {
      save({ ...overrides, [id]: [] });
      note(`${shortcut(id)?.label}: no key now`);
      stopRecording();
      return;
    }
    const result = assign(overrides, id, combo);
    if (!result.ok) {
      note(result.error, true);
      return;
    }
    save(result.overrides);
    note(
      result.took ? `${display(combo)} was ${shortcut(result.took)?.label}'s; that has no key now` : ""
    );
    stopRecording();
  }
  var noteEl = null;
  function note(text, error2 = false) {
    if (!noteEl) return;
    noteEl.textContent = text;
    noteEl.classList.toggle("error", error2);
  }
  function row(s2) {
    const keys = bindings[s2.id] ?? [];
    const own = s2.id in overrides;
    const live = recording?.id === s2.id;
    const cells = [h("span", { class: "keys-label" }, s2.label)];
    if (s2.fixed) {
      cells.push(
        h(
          "span",
          { class: "keys-fixed", title: "Fixed: these keys stay" },
          ...chips(keys)
        )
      );
    } else {
      const button10 = h(
        "button",
        {
          type: "button",
          class: `keys-set${live ? " live" : ""}${own ? " own" : ""}`,
          title: "Click, then press the new keys (Esc: keep them, Backspace: no key)",
          "data-own-escape": "",
          onclick: () => {
            if (live) {
              stopRecording();
              return;
            }
            recording = { id: s2.id, button: button10 };
            window.addEventListener("keydown", onRecordKey, true);
            note("");
            redraw?.();
          }
        },
        ...live ? [h("span", { class: "keys-press" }, "Press keys\u2026")] : chips(keys)
      );
      cells.push(button10);
      cells.push(
        own ? h(
          "button",
          {
            type: "button",
            class: "keys-reset",
            title: `Back to ${s2.keys.map((k2) => display(k2)).join(", ")}`,
            onclick: () => {
              save(reset(overrides, s2.id));
              note("");
            }
          },
          "\u21BA"
        ) : h("span", { class: "keys-reset-gap" })
      );
    }
    return h("div", { class: `keys-row${s2.fixed ? " fixed" : ""}` }, ...cells);
  }
  function openShortcuts() {
    const search2 = h("input", {
      type: "text",
      class: "keys-search",
      placeholder: "Search commands or keys",
      "aria-label": "Search commands or keys"
    });
    const list4 = h("div", { class: "keys-list" });
    noteEl = h("p", { class: "keys-note", role: "status" });
    const resetAll = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        title: "Every command back to its default keys",
        onclick: () => {
          save({});
          note("Every shortcut is back to its default");
        }
      },
      "Reset all"
    );
    redraw = () => {
      clear(list4);
      const shown3 = filterShortcuts(bindings, search2.value);
      for (const group2 of GROUPS) {
        const rows = shown3.filter((s2) => s2.group === group2);
        if (!rows.length) continue;
        list4.append(
          h("h3", { class: "keys-group" }, group2),
          ...rows.map(row)
        );
      }
      if (!shown3.length)
        list4.append(h("p", { class: "hint" }, "No command matches"));
      resetAll.disabled = !Object.keys(overrides).length;
      if (recording)
        list4.querySelector(".keys-set.live")?.focus();
    };
    search2.addEventListener("input", () => redraw?.());
    openDialog(
      "Keyboard shortcuts",
      h(
        "div",
        { class: "keys-dialog" },
        h("div", { class: "keys-head" }, search2, resetAll),
        noteEl,
        list4,
        h(
          "p",
          { class: "hint" },
          "Click a command's keys and press new ones. Your keys are kept in this browser. Ctrl stands for \u2318 on a Mac. The presenter's keys: press ? there."
        )
      ),
      {
        wide: true,
        onClose: () => {
          if (recording) stopRecording();
          redraw = null;
          noteEl = null;
        }
      }
    );
    redraw();
    search2.focus();
  }
  function openHelpMenu(button10) {
    closeMenu();
    const withKeys = (label4, id) => firstKey(id) ? `${label4}  (${firstKey(id)})` : label4;
    const menu7 = document.getElementById("context-menu");
    menu7.append(
      h("div", { class: "menu-title" }, "Settings"),
      menuItem(
        withKeys("Keyboard shortcuts\u2026", "help.shortcuts"),
        () => openShortcuts()
      ),
      h("div", { class: "menu-sep" }),
      h("div", { class: "menu-title" }, "Help"),
      menuItem(
        withKeys("Command palette\u2026", "help.palette"),
        () => emit("palette")
      ),
      menuItem(
        "Editor guide \u2197",
        () => window.open(DOCS, "_blank", "noopener")
      )
    );
    const r2 = button10.getBoundingClientRect();
    showMenu(Math.max(8, r2.right - 220), r2.bottom + 4);
  }
  function initKeys() {
    load();
    retitleAll();
    const button10 = document.getElementById("btn-help");
    button10?.addEventListener("click", (e2) => {
      e2.stopPropagation();
      openHelpMenu(button10);
    });
    window.addEventListener("storage", (e2) => {
      if (e2.key !== KEY) return;
      load();
      retitleAll();
      emit("keys");
      if (redraw) redraw();
    });
  }

  // src/ts/editor/comments.ts
  var canvasEl = document.getElementById("canvas");
  var dialogBody = null;
  var dialogSlide = null;
  var focusThread = null;
  var draft2 = null;
  var placing = null;
  function threads() {
    return ed.model?.comments ?? [];
  }
  function slideId(i2) {
    return ed.model?.slides[i2]?.id;
  }
  function setThreads(next) {
    if (!ed.model || !Array.isArray(next)) return;
    ed.model.comments = next;
    emit("comments");
  }
  function paint(badge4, i2) {
    const n3 = openCount(threads(), slideId(i2));
    badge4.textContent = n3 ? `\u{1F4AC}${n3 > 1 ? n3 : ""}` : "";
    if (n3)
      badge4.setAttribute(
        "title",
        commentTitle(slideThreads(threads(), slideId(i2)))
      );
    else badge4.removeAttribute("title");
  }
  function commentBadge(i2) {
    const badge4 = h("span", { class: "comment-mark" });
    paint(badge4, i2);
    badge4.addEventListener("click", (e2) => {
      if (!badge4.textContent) return;
      e2.stopPropagation();
      openComments(i2);
    });
    return badge4;
  }
  function markComments(item2, i2) {
    const badge4 = item2.querySelector(".comment-mark");
    if (badge4) paint(badge4, i2);
  }
  function pinPoint(t2) {
    const svg = slideRoot();
    if (!svg) return null;
    if (t2.target) {
      const el2 = svg.querySelector(`#${CSS.escape(t2.target)}`);
      if (el2 instanceof SVGGraphicsElement) {
        const c2 = outlineOf(el2);
        if (c2) {
          return {
            x: Math.max(...c2.map((p2) => p2.x)),
            y: Math.min(...c2.map((p2) => p2.y))
          };
        }
      }
    }
    const m2 = slideToPaper();
    if (t2.x != null && t2.y != null) {
      return {
        x: m2.a * t2.x + m2.c * t2.y + m2.e,
        y: m2.b * t2.x + m2.d * t2.y + m2.f
      };
    }
    return { x: m2.e + 24, y: m2.f + 24 };
  }
  function drawPins(overlay3) {
    if (ed.master || ed.step != null) return;
    const list4 = slideThreads(threads(), slideId(ed.current)).filter(
      (t2) => !t2.resolved
    );
    list4.forEach((t2, k2) => {
      const p2 = pinPoint(t2);
      if (!p2) return;
      const g2 = svgEl("g", {
        class: "comment-pin",
        transform: `translate(${p2.x} ${p2.y})`
      });
      g2.append(svgEl("circle", { r: 11 }));
      const label4 = svgEl("text", { "text-anchor": "middle", y: 4 });
      label4.textContent = String(k2 + 1);
      g2.append(label4);
      const title3 = svgEl("title", {});
      title3.textContent = commentTitle([t2]);
      g2.append(title3);
      g2.addEventListener("pointerdown", (e2) => e2.stopPropagation());
      g2.addEventListener("click", (e2) => {
        e2.stopPropagation();
        openComments(ed.current, t2.id);
      });
      overlay3.append(g2);
    });
  }
  function stopPlacing() {
    if (placing) canvasEl.removeEventListener("pointerdown", placing, true);
    placing = null;
    document.body.classList.remove("placing-comment");
  }
  function addComment() {
    if (ed.master) {
      toast("Comments go on slides, not on the slide master", "error");
      return;
    }
    const slide = ed.model?.slides[ed.current];
    if (!slide?.visible) {
      toast("A hidden slide takes no comments: show it first", "error");
      return;
    }
    const sel = ed.selection.length === 1 ? ed.selection[0].el : null;
    if (sel) {
      const id = sel.getAttribute("id");
      if (id) {
        openComments(ed.current, null, { slide: ed.current, target: id });
        return;
      }
      const mid = middle(sel);
      if (mid) {
        openComments(ed.current, null, { slide: ed.current, ...mid });
        return;
      }
    }
    stopPlacing();
    document.body.classList.add("placing-comment");
    toast("Click on the slide where the comment goes (Esc: cancel)");
    placing = (e2) => {
      if (!slideRoot()?.contains(e2.target)) {
        stopPlacing();
        return;
      }
      e2.preventDefault();
      e2.stopPropagation();
      stopPlacing();
      const pt = clientPoint(e2);
      openComments(ed.current, null, { slide: ed.current, ...pt });
    };
    canvasEl.addEventListener("pointerdown", placing, true);
  }
  function middle(el2) {
    const root2 = slideRoot()?.getScreenCTM();
    const own = el2.getScreenCTM?.();
    if (!root2 || !own) return null;
    try {
      const b2 = el2.getBBox();
      const p2 = new DOMPoint(b2.x + b2.width / 2, b2.y + b2.height / 2).matrixTransform(own).matrixTransform(root2.inverse());
      return { x: p2.x, y: p2.y };
    } catch {
      return null;
    }
  }
  function clientPoint(e2) {
    const svg = slideRoot();
    const m2 = svg?.getScreenCTM();
    if (!m2) return { x: 0, y: 0 };
    const p2 = new DOMPoint(e2.clientX, e2.clientY).matrixTransform(m2.inverse());
    return { x: p2.x, y: p2.y };
  }
  async function send(req) {
    const res = await edit({ action: "comment", ...req });
    if (!res.ok) return false;
    setThreads(res.comments);
    return true;
  }
  function composer(placeholder, label4, onSend) {
    const text = h("textarea", {
      class: "git-message",
      rows: "2",
      placeholder
    });
    const go = async () => {
      if (!text.value.trim()) return;
      if (await onSend(text.value)) text.value = "";
    };
    text.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" && (e2.ctrlKey || e2.metaKey)) {
        e2.preventDefault();
        void go();
      }
    });
    return h(
      "div",
      { class: "comment-compose" },
      text,
      h(
        "button",
        {
          type: "button",
          class: "pbtn primary",
          title: "Ctrl+Enter",
          onclick: () => void go()
        },
        label4
      )
    );
  }
  function threadView(t2, k2) {
    const box2 = h(
      "div",
      {
        class: `comment-thread${t2.resolved ? " resolved" : ""}${t2.id === focusThread ? " focus" : ""}`,
        "data-thread": t2.id
      },
      h(
        "div",
        { class: "comment-head" },
        h(
          "span",
          { class: "comment-num" },
          t2.resolved ? "\u2713" : String(k2 + 1)
        ),
        h("span", { class: "hint" }, whereWords(t2)),
        h("span", { class: "cmp-spacer" }),
        h(
          "button",
          {
            type: "button",
            class: "link-btn",
            onclick: () => void send({
              op: "resolve",
              thread: t2.id,
              on: !t2.resolved
            })
          },
          t2.resolved ? "Reopen" : "Resolve"
        ),
        h(
          "button",
          {
            type: "button",
            class: "link-btn",
            onclick: () => {
              if (confirm("Delete this thread and its replies?"))
                void send({ op: "delete", thread: t2.id });
            }
          },
          "Delete"
        )
      ),
      ...t2.messages.map(
        (m2) => h(
          "div",
          { class: "comment-msg" },
          h(
            "div",
            { class: "comment-who" },
            h("strong", {}, m2.name || "someone"),
            " ",
            h("span", { class: "hint" }, ago(m2.at))
          ),
          h("div", { class: "comment-text" }, m2.text)
        )
      )
    );
    if (!t2.resolved) {
      box2.append(
        composer(
          "Reply\u2026",
          "Reply",
          (text) => send({ op: "reply", thread: t2.id, text })
        )
      );
    }
    return box2;
  }
  function renderDialog() {
    if (!dialogBody || dialogSlide == null) return;
    clear(dialogBody);
    if (draft2) {
      const d2 = draft2;
      const where = d2.target ? `on #${d2.target}` : d2.x != null && d2.y != null ? `at ${Math.round(d2.x)}, ${Math.round(d2.y)}` : "on the slide";
      dialogBody.append(
        h("div", { class: "hint" }, `New comment ${where}`),
        composer("Write a comment\u2026", "Comment", async (text) => {
          const ok = await send({ op: "add", ...d2, text });
          if (ok) draft2 = null;
          renderDialog();
          return ok;
        })
      );
    }
    const list4 = slideThreads(threads(), slideId(dialogSlide));
    let open5 = 0;
    for (const t2 of list4) {
      dialogBody.append(threadView(t2, t2.resolved ? -1 : open5));
      if (!t2.resolved) open5 += 1;
    }
    if (!list4.length && !draft2) {
      dialogBody.append(
        h("p", { class: "hint" }, "No comments on this slide yet.")
      );
    }
    if (!draft2) {
      dialogBody.append(
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => {
              closeDialog();
              addComment();
            }
          },
          withKey("New comment\u2026")
        )
      );
    }
    dialogBody.querySelector(".comment-thread.focus")?.scrollIntoView({ block: "nearest" });
    dialogBody.querySelector(
      ".comment-compose textarea"
    )?.focus();
  }
  function openComments(i2, thread = null, start = null) {
    dialogSlide = i2;
    focusThread = thread;
    draft2 = start;
    dialogBody = h("div", { class: "comment-body" });
    const slide = ed.model?.slides[i2];
    openDialog(
      `Comments on slide ${i2 + 1}: ${slide?.title ?? slide?.id ?? ""}`,
      dialogBody,
      {
        wide: true,
        onClose: () => {
          dialogBody = null;
          draft2 = null;
        }
      }
    );
    renderDialog();
  }
  function commentItems(i2, item2) {
    const slide = ed.model?.slides[i2];
    if (!slide?.visible) return [];
    const n3 = openCount(threads(), slide.id);
    return [
      item2(withKey("Add comment\u2026"), () => addComment()),
      ...slideThreads(threads(), slide.id).length ? [item2(`Comments (${n3} open)\u2026`, () => openComments(i2))] : []
    ];
  }
  function withKey(label4) {
    const k2 = firstKey("review.comment");
    return k2 ? `${label4} (${k2})` : label4;
  }
  function initComments() {
    hooks.drawComments = drawPins;
    onMessage("comments", (msg) => setThreads(msg.comments));
    on("comments", () => {
      drawOverlay();
      if (dialogBody && dialogOpen()) renderDialog();
    });
    document.addEventListener(
      "keydown",
      (e2) => {
        if (e2.key === "Escape" && placing) {
          stopPlacing();
          return;
        }
        const target = e2.target;
        if (target?.closest(
          "input, textarea, select, [contenteditable], #dialog"
        ))
          return;
        if (matches(e2, "review.comment")) {
          e2.preventDefault();
          e2.stopImmediatePropagation();
          addComment();
        }
      },
      true
    );
  }

  // src/ts/editor/deletetext.ts
  function plural(n3, word) {
    return `${n3} ${word}${n3 === 1 ? "" : "s"}`;
  }
  function names(paths, limit = 3) {
    const shown3 = paths.slice(0, limit).join(", ");
    return paths.length > limit ? `${shown3} and ${paths.length - limit} more` : shown3;
  }
  function gitBadge(state) {
    switch (state) {
      case "committed":
        return {
          text: "in git",
          title: "Committed: git can bring it back",
          tone: "ok"
        };
      case "modified":
        return {
          text: "changed",
          title: "Uncommitted changes: git has only the last committed version",
          tone: "warn"
        };
      case "untracked":
        return {
          text: "not in git",
          title: "Never committed: git cannot bring it back",
          tone: "lost"
        };
      case "ignored":
        return {
          text: "ignored",
          title: "Ignored by git: never committed, git cannot bring it back",
          tone: "lost"
        };
      default:
        return null;
    }
  }
  function useText(f2) {
    switch (f2.state) {
      case "used":
        return {
          text: plural(f2.uses, "use"),
          title: "The deck uses it"
        };
      case "orphan":
        return {
          text: "only used by unused files",
          title: `Named only by files the deck does not use: ${f2.by.join(", ")}`
        };
      case "template":
        return f2.by.length ? {
          text: "used by a template",
          title: `Named only by layouts or overlays no slide uses: ${f2.by.join(", ")}`
        } : {
          text: "unused template",
          title: "A layout or overlay no slide uses: kept as a template"
        };
      default:
        return { text: "unused", title: "Nothing refers to it" };
    }
  }
  function pickable(state) {
    return state === "unused" || state === "orphan";
  }
  var NOT_IN_GIT = (n3, list4) => `Not in git: ${plural(n3, "file")} (${list4}) can't be restored from version control. Undo brings ${n3 === 1 ? "it" : "them"} back only while this editor stays open.`;
  function deleteWarnings(files2, repo) {
    if (!files2.length) return [];
    if (!repo) {
      return [
        {
          tone: "warn",
          text: "This deck is not in a git repository: deleted files can only be brought back with Undo while this editor is open."
        }
      ];
    }
    const lost = files2.filter((f2) => f2.git === "untracked" || f2.git === "ignored").map((f2) => f2.path);
    const changed2 = files2.filter((f2) => f2.git === "modified").map((f2) => f2.path);
    const out = [];
    if (lost.length) {
      out.push({ tone: "warn", text: NOT_IN_GIT(lost.length, names(lost)) });
    }
    if (changed2.length) {
      out.push({
        tone: "warn",
        text: `Uncommitted changes in ${plural(changed2.length, "file")} (${names(changed2)}): git keeps only ${changed2.length === 1 ? "its" : "their"} last committed version.`
      });
    }
    if (!out.length) {
      out.push({
        tone: "ok",
        text: "All in git: Discard changes in the Git menu brings them back, or its history once you commit."
      });
    }
    return out;
  }
  function slideQuestion(names2) {
    return names2.length === 1 ? `Delete \u201C${names2[0]}\u201D from the deck?` : `Delete ${names2.length} slides from the deck?`;
  }
  function slideFilesLine(n3, slides) {
    if (!n3) {
      return slides === 1 ? "No file is this slide's alone: nothing else is deleted." : "No file is these slides' alone: nothing else is deleted.";
    }
    return `Also deletes ${plural(n3, "file")} no other slide uses:`;
  }

  // src/ts/editor/deletedlg.ts
  function planOf(result) {
    if (!result.ok) return null;
    return {
      files: result.deleted ?? [],
      repo: Boolean(result.repo)
    };
  }
  function fileList(files2) {
    return h(
      "ul",
      { class: "delete-files" },
      ...files2.map((f2) => {
        const badge4 = gitBadge(f2.git);
        return h(
          "li",
          {},
          h("code", { class: "rename-code", title: f2.path }, f2.path),
          badge4 ? h(
            "span",
            {
              class: `git-state ${badge4.tone}`,
              title: badge4.title
            },
            badge4.text
          ) : null
        );
      })
    );
  }
  function warnings(plan2) {
    const lines = deleteWarnings(plan2.files, plan2.repo);
    if (!lines.length) return null;
    return h(
      "div",
      { class: "delete-warnings" },
      ...lines.map(
        (w2) => h("p", { class: `delete-warning ${w2.tone}`, role: "note" }, w2.text)
      )
    );
  }
  function askDelete(opts2) {
    return new Promise((resolve) => {
      let answer = null;
      const details = h("div", { class: "delete-details" });
      let check = null;
      const ok = h(
        "button",
        {
          type: "button",
          class: "pbtn primary danger",
          "data-delete": "confirm",
          onclick: () => {
            answer = { files: check?.checked ?? false };
            closeDialog();
          }
        },
        opts2.confirm
      );
      const body3 = h(
        "div",
        { class: "delete-dialog" },
        h("p", { class: "delete-question" }, opts2.question)
      );
      if (opts2.plan) {
        body3.append(fileList(opts2.plan.files));
        const w2 = warnings(opts2.plan);
        if (w2) body3.append(w2);
      }
      if (opts2.option) {
        const option2 = opts2.option;
        check = h("input", {
          type: "checkbox",
          "data-delete": "files"
        });
        let plan2 = null;
        const box2 = check;
        box2.addEventListener("change", async () => {
          if (!box2.checked) {
            details.replaceChildren();
            return;
          }
          details.replaceChildren(
            h(
              "p",
              { class: "hint delete-line" },
              "Looking for its files\u2026"
            )
          );
          plan2 ??= option2.load();
          const found = await plan2;
          if (!box2.checked) return;
          if (!found) {
            details.replaceChildren(
              h(
                "p",
                { class: "hint warn delete-line" },
                "Cannot tell which files would go."
              )
            );
            return;
          }
          details.replaceChildren(
            h(
              "p",
              { class: "hint delete-line" },
              slideFilesLine(found.files.length, option2.slides)
            ),
            ...found.files.length ? [fileList(found.files)] : [],
            ...[warnings(found)].filter((w2) => w2 !== null)
          );
        });
        body3.append(
          h(
            "label",
            { class: "rename-check delete-option" },
            check,
            option2.label
          ),
          details
        );
      }
      body3.append(
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => closeDialog()
            },
            "Cancel"
          ),
          ok
        )
      );
      body3.addEventListener("keydown", (e2) => {
        const target = e2.target;
        if (e2.key !== "Enter" || target.tagName === "BUTTON") return;
        e2.preventDefault();
        ok.click();
      });
      openDialog(opts2.title, body3, {
        wide: true,
        onClose: () => resolve(answer)
      });
      ok.focus();
    });
  }
  function askSlideDelete(question, slides, req) {
    return askDelete({
      title: slides === 1 ? "Delete slide" : "Delete slides",
      question,
      confirm: "Delete",
      option: {
        label: slides === 1 ? "Also delete its files from disk" : "Also delete their files from disk",
        slides,
        load: async () => planOf(await request({ ...req, files: true, dryRun: true }))
      }
    });
  }

  // src/ts/editor/gallery.ts
  var LABELS = {
    numbered: ["Blank", "Background and slide number"],
    title: ["Title only", "A title; draw the rest"],
    content: ["Title and content", "The everyday text slide"],
    "two-cols": ["Two columns", "Side by side under one title"],
    "three-cols": ["Three columns", "Three short columns"],
    comparison: ["Comparison", "Two headed columns"],
    agenda: ["Agenda", "A numbered outline"],
    quad: ["Four quadrants", "A two-by-two grid"],
    "three-cards": ["Three cards", "An image over text, three times"],
    "media-left": ["Media and text", "Image or video on the left"],
    "media-right": ["Text and media", "Image or video on the right"],
    "title-media": ["Title and media", "One large image or video"],
    "full-media": ["Full-bleed media", "A photo or video edge to edge"],
    cover: ["Cover", "The opening slide"],
    section: ["Section header", "Divides the deck into parts"],
    center: ["Centered", "One centered block"],
    fact: ["Big number", "One number or claim"],
    quote: ["Quote", "A pull quote with attribution"],
    end: ["Closing", "The last slide"],
    "poster-3col": ["Poster, three columns", "Title band, sections, footer"],
    "poster-2col": ["Poster, two columns", "Title band, sections, footer"],
    "poster-landscape-3col": [
      "Landscape poster, three columns",
      "Title band, sections, footer"
    ],
    "poster-landscape-4col": [
      "Landscape poster, four columns",
      "Title band, sections, footer"
    ]
  };
  var root = document.getElementById("gallery");
  var cache = null;
  function layoutLabel(name2) {
    const typed = ed.model?.layouts.find((l2) => l2.name === name2)?.label;
    return typed || (LABELS[name2]?.[0] ?? name2);
  }
  async function previews() {
    if (cache) return cache;
    const result = await request({ action: "layout-previews" });
    if (!result.ok) {
      toast(result.error ?? "could not load the layouts", "error");
      return [];
    }
    cache = result.layouts;
    return cache;
  }
  function thumbnail(p2) {
    const box2 = h("div", { class: "gallery-thumb" });
    box2.innerHTML = p2.svg;
    const svg = box2.querySelector("svg");
    if (svg) {
      const vb = parseViewBox(svg.getAttribute("viewBox"));
      box2.style.aspectRatio = `${vb.w} / ${vb.h}`;
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
      });
      for (const z of p2.emptyZones) {
        if (z.zone === "slide-number" || z.zone === "slide-total") continue;
        box2.append(
          h(
            "div",
            {
              class: "gallery-media",
              style: `left:${z.x / vb.w * 100}%;top:${z.y / vb.h * 100}%;width:${z.width / vb.w * 100}%;height:${z.height / vb.h * 100}%`
            },
            "Image or video"
          )
        );
      }
    }
    return box2;
  }
  function lostZones(p2) {
    const slide = currentSlide();
    if (!slide) return [];
    const used = /* @__PURE__ */ new Set([
      ...Object.keys(slide.zoneOrigins ?? {}),
      ...Object.keys(slide.zones)
    ]);
    return [...used].filter((z) => !p2.zones.includes(z));
  }
  function close() {
    root.classList.remove("open");
    clear(root);
  }
  async function openGallery(opts2) {
    if (!ed.model?.deckEditable) {
      toast(
        "deck.py builds its slide list in code; change it there",
        "error"
      );
      return;
    }
    clear(root);
    const grid = h(
      "div",
      { class: "gallery-grid" },
      h("p", { class: "hint" }, "Rendering layouts\u2026")
    );
    const title3 = opts2.mode === "insert" ? "New slide" : "Change layout";
    root.append(
      h(
        "div",
        { class: "gallery-box", role: "dialog", "aria-label": title3 },
        h(
          "div",
          { class: "gallery-head" },
          h("h2", {}, title3),
          h(
            "span",
            { class: "hint" },
            opts2.mode === "insert" ? "Every layout, in this deck's theme" : "The slide keeps its content; zones the new layout lacks are not shown"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: close,
              title: "Close (Esc)"
            },
            "\xD7"
          )
        ),
        grid
      )
    );
    root.classList.add("open");
    const layouts = await previews();
    clear(grid);
    for (const p2 of layouts) {
      const [named, description] = LABELS[p2.name] ?? [p2.name, ""];
      const label4 = p2.label || named;
      const lost = opts2.mode === "change" ? lostZones(p2) : [];
      const current3 = opts2.mode === "change" && p2.name === opts2.current;
      const card = h(
        "button",
        {
          type: "button",
          class: `gallery-card${current3 ? " current" : ""}`,
          title: p2.name,
          onclick: () => void choose(p2, opts2, lost)
        },
        thumbnail(p2),
        h(
          "div",
          { class: "gallery-label" },
          h("strong", {}, label4),
          p2.source === "local" && h(
            "span",
            {
              class: "badge",
              title: p2.copyOf ? `This deck's own copy of ${p2.copyOf} (slide master)` : "A layout of this deck's own (layouts/)"
            },
            p2.copyOf ? "deck's copy" : "project"
          )
        ),
        description && h("div", { class: "gallery-desc" }, description),
        lost.length > 0 && h(
          "div",
          { class: "gallery-warn" },
          `Hides: ${lost.join(", ")}`
        )
      );
      grid.append(card);
    }
    (grid.querySelector(".current") ?? grid.querySelector("button"))?.scrollIntoView({
      block: "nearest"
    });
    grid.querySelector(".current, button")?.focus();
  }
  async function choose(p2, opts2, lost) {
    if (opts2.mode === "insert") {
      close();
      await newSlide(p2.name, opts2.after);
      return;
    }
    if (p2.name === opts2.current) {
      close();
      return;
    }
    if (lost.length && !window.confirm(
      `${layoutLabel(p2.name)} has no ${lost.join(", ")} zone; that content stays in your files but is not shown. Switch anyway?`
    )) {
      return;
    }
    close();
    const slide = currentSlide();
    if (!slide) return;
    await edit({
      action: "slide",
      op: "layout",
      slide: slide.deckIndex,
      layout: p2.name
    });
  }
  function initGallery() {
    on("model", () => {
      cache = null;
    });
    root.addEventListener("pointerdown", (e2) => {
      if (e2.target === root) close();
    });
    document.addEventListener(
      "keydown",
      (e2) => {
        if (e2.key === "Escape" && root.classList.contains("open")) {
          e2.stopPropagation();
          close();
        }
      },
      true
    );
  }

  // src/ts/editor/mastertree.ts
  var ORDER = [
    "numbered",
    "title",
    "content",
    "two-cols",
    "three-cols",
    "comparison",
    "agenda",
    "quad",
    "three-cards",
    "media-left",
    "media-right",
    "title-media",
    "full-media",
    "cover",
    "section",
    "center",
    "fact",
    "quote",
    "end",
    "poster-3col",
    "poster-2col",
    "poster-landscape-3col",
    "poster-landscape-4col"
  ];
  function rank(l2) {
    const own = l2.source === "local" && !l2.copyOf && !ORDER.includes(l2.name);
    const at3 = ORDER.indexOf(l2.name);
    return [own ? 1 : 0, at3 < 0 ? ORDER.length : at3, l2.name];
  }
  function compare(a2, b2) {
    const [x2, y2] = [rank(a2), rank(b2)];
    return x2[0] - y2[0] || x2[1] - y2[1] || x2[2].localeCompare(y2[2]);
  }
  function layoutRows(tree2) {
    const names2 = new Set(tree2.layouts.map((l2) => l2.name));
    const children2 = /* @__PURE__ */ new Map();
    for (const l2 of tree2.layouts) {
      if (l2.name === tree2.background) continue;
      const parent = l2.parent && names2.has(l2.parent) && l2.parent !== tree2.background ? l2.parent : null;
      const list4 = children2.get(parent) ?? [];
      list4.push(l2);
      children2.set(parent, list4);
    }
    const rows = [];
    const seen = /* @__PURE__ */ new Set();
    const walk = (parent, depth) => {
      for (const l2 of (children2.get(parent) ?? []).sort(compare)) {
        if (seen.has(l2.name)) continue;
        seen.add(l2.name);
        rows.push({ layout: l2, depth });
        walk(l2.name, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }
  function origin(l2) {
    if (l2.copyOf) {
      return {
        text: "Deck's copy",
        kind: "copy",
        title: `This deck's own copy of ${l2.copyOf}: slides on it follow your copy. Revert to go back to the theme's.`
      };
    }
    if (l2.source === "local") {
      return {
        text: "Deck's own",
        kind: "own",
        title: "A layout of this deck's own (layouts/ in the project)"
      };
    }
    return {
      text: "Theme",
      kind: "theme",
      title: "From the theme: your first edit gives this deck its own copy, which every slide on it then follows"
    };
  }
  function plural2(n3, word) {
    return `${n3} ${word}${n3 === 1 ? "" : "s"}`;
  }
  function usage(l2, background, total2 = 0) {
    if (background) {
      if (!l2.reach.length) return "no slides";
      return l2.reach.length >= total2 ? "behind every slide" : `behind ${l2.reach.length} of ${total2} slides`;
    }
    if (!l2.slides.length && !l2.reach.length) return "no slides";
    const direct = plural2(l2.slides.length, "slide");
    const through = l2.reach.length - l2.slides.length;
    return through > 0 ? `${direct} (+${through} built on it)` : direct;
  }
  function copyTarget(path, projectDir, kind) {
    const sep2 = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    const root2 = projectDir.replace(/[\\/]+$/, "");
    if (path.startsWith(`${root2}${sep2}`)) return null;
    const file = path.split(/[\\/]/).pop() ?? "";
    return `${root2}${sep2}${kind === "overlay" ? "overlays" : "layouts"}${sep2}${file}`;
  }
  function layoutTitle(l2, labels) {
    return l2.label || labels[l2.name] || l2.name;
  }

  // src/ts/editor/placeholdertext.ts
  var MEDIA = /media|image|img|picture|photo|figure|video|logo/;
  var RESERVED = /* @__PURE__ */ new Set(["notes", "slide", "slide-number", "slide-total"]);
  function slugName(name2) {
    return name2.trim().replace(/(?<=[a-z0-9])(?=[A-Z])/g, "-").replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, "-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function kindOf(name2) {
    return MEDIA.test(name2) ? "picture" : "text";
  }
  function zoneNameFor(kind, typed) {
    const name2 = slugName(typed.trim().replace(/^zone-/, ""));
    return name2 && kind === "picture" && !MEDIA.test(name2) ? `picture-${name2}` : name2;
  }
  function nameProblem(name2) {
    if (!name2) return "Give the placeholder a name";
    if (!/^[a-z][a-z0-9-]*$/.test(name2)) return "Start the name with a letter";
    if (RESERVED.has(name2)) return `\u201C${name2}\u201D is a reserved zone name`;
    if (/^steps?(?![\w])/.test(name2))
      return "A zone name cannot start with \u201Cstep\u201D: Markdown reads that as a reveal";
    return null;
  }
  function checkName(kind, typed, taken, current3 = null) {
    const name2 = zoneNameFor(kind, typed);
    const problem = nameProblem(name2);
    if (problem) return { name: name2, problem };
    if (name2 === current3) return { name: name2, problem: null };
    for (const id of taken) {
      if (id === `zone-${name2}`) {
        return { name: name2, problem: `zone-${name2} is already used here` };
      }
    }
    return { name: name2, problem: null };
  }
  function fillsText(filled, number) {
    if (!filled.length) return "No slide fills it yet";
    const list4 = filled.map(number).join(", ");
    return filled.length === 1 ? `Filled on slide ${list4}` : `Filled on ${filled.length} slides: ${list4}`;
  }
  function renameSummary(plan2) {
    const n3 = plan2.slides.length;
    if (!n3) return "No slide fills it: only the layout changes";
    return `Renames the zone on ${n3} slide${n3 === 1 ? "" : "s"} (${plan2.slideNames.join(", ")})`;
  }

  // src/ts/editor/placeholders.ts
  async function loadPlaceholders(kind, path) {
    const result = await request({ action: "master-placeholders", kind, path });
    if (!result.ok) return null;
    return {
      placeholders: result.placeholders ?? [],
      ids: result.taken ?? []
    };
  }
  function listed() {
    return ed.master?.placeholders ?? { placeholders: [], ids: [] };
  }
  function masterSource() {
    const view3 = ed.master;
    return view3?.slide.sources?.find((s2) => s2.path === view3.path) ?? null;
  }
  function slideNumber(i2) {
    const s2 = ed.model?.slides[i2];
    return s2?.visibleIndex != null ? String(s2.visibleIndex + 1) : "hidden";
  }
  var TEXT_TAGS = ["rect", "ellipse", "circle"];
  var PICTURE_TAGS = ["rect", "ellipse", "circle", "polygon", "path"];
  function freeName(kind) {
    const ids = new Set(listed().ids);
    const base2 = kind === "picture" ? "picture" : "text";
    let name2 = base2;
    for (let n3 = 2; ids.has(`zone-${name2}`); n3++) name2 = `${base2}-${n3}`;
    return name2;
  }
  function placeholderDialog(kind, shape = null) {
    const src = shape ? sourceOf(shape.key) : masterSource();
    if (!ed.master || !src) return;
    const tag = shape ? shape.el.getAttribute("data-ink-tag") ?? shape.el.localName : "rect";
    const kinds = [
      ["text", "Text", TEXT_TAGS],
      ["picture", "Picture or video", PICTURE_TAGS]
    ];
    let chosen = kind;
    const radios = kinds.map(([k2, label4, tags]) => {
      const input = h("input", {
        type: "radio",
        name: "placeholder-kind",
        value: k2,
        checked: k2 === kind,
        disabled: !tags.includes(tag)
      });
      input.addEventListener("change", () => {
        if (!input.checked) return;
        if (name2.value === freeName(chosen)) name2.value = freeName(k2);
        chosen = k2;
        check();
      });
      return h("label", { class: "check" }, input, label4);
    });
    const name2 = h("input", {
      type: "text",
      class: "master-name",
      value: freeName(kind),
      spellcheck: "false",
      "aria-label": "Name"
    });
    const zone = h("p", { class: "hint placeholder-zone" });
    const prompt = h("input", {
      type: "text",
      placeholder: "Click to add the code example",
      "aria-label": "Prompt"
    });
    const ok = h(
      "button",
      { type: "submit", class: "pbtn primary" },
      shape ? "Make placeholder" : "Add"
    );
    const check = () => {
      const { name: n3, problem } = checkName(
        chosen,
        name2.value,
        listed().ids
      );
      zone.textContent = problem ?? `zone-${n3}`;
      zone.classList.toggle("error", !!problem);
      ok.disabled = !!problem;
      return problem ? null : n3;
    };
    name2.addEventListener("input", check);
    const form = h(
      "form",
      { class: "master-form placeholder-form" },
      h("div", { class: "placeholder-kinds", role: "radiogroup" }, ...radios),
      h("label", {}, "Name", name2, zone),
      h(
        "label",
        {},
        "Prompt (optional)",
        prompt,
        h(
          "span",
          { class: "hint" },
          "Grey text the empty zone shows on a new slide; a click types it in."
        )
      ),
      h(
        "p",
        { class: "hint" },
        shape ? "The shape keeps its look; each slide on this layout fills it with its own content." : "Each slide on this layout fills it with its own text or picture. Drag it into place afterwards."
      ),
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "pbtn", onclick: () => closeDialog() },
          "Cancel"
        ),
        ok
      )
    );
    form.addEventListener("submit", (e2) => {
      e2.preventDefault();
      if (!check()) return;
      ok.disabled = true;
      const send2 = shape ? makePlaceholder(shape, src, chosen, name2.value, prompt.value) : addPlaceholder(src, chosen, name2.value, prompt.value);
      void send2.then((done) => {
        if (done) closeDialog();
        else ok.disabled = false;
      });
    });
    check();
    openDialog(
      shape ? "Make placeholder" : chosen === "picture" ? "New picture placeholder" : "New text placeholder",
      form
    );
    name2.focus();
    name2.select();
  }
  async function addPlaceholder(src, kind, name2, prompt) {
    const vb = slideRoot()?.viewBox.baseVal;
    const W = vb?.width || 1920;
    const H = vb?.height || 1080;
    const w2 = W * (kind === "picture" ? 0.35 : 0.5);
    const hgt = H * (kind === "picture" ? 0.35 : 0.2);
    const result = await edit({
      action: "master",
      op: "add-zone",
      file: src.path,
      hash: src.hash,
      zoneKind: kind,
      name: name2,
      prompt,
      exact: true,
      x: Math.round((W - w2) / 2),
      y: Math.round((H - hgt) / 2),
      width: Math.round(w2),
      height: Math.round(hgt)
    });
    if (!result.ok || typeof result.zone !== "string") return false;
    afterRender.ids = [`zone-${result.zone}`];
    toast(`Placeholder \u201C${result.zone}\u201D added: drag it into place`);
    return true;
  }
  async function makePlaceholder(sel, src, kind, name2, prompt) {
    const result = await edit({
      action: "master",
      op: "zone-make",
      file: src.path,
      hash: src.hash,
      loc: sel.loc,
      zoneKind: kind,
      name: name2,
      prompt
    });
    if (!result.ok || typeof result.zone !== "string") return false;
    afterRender.ids = [`zone-${result.zone}`];
    toast(`The shape is the placeholder \u201C${result.zone}\u201D now`);
    return true;
  }
  function section(title3, ...body3) {
    return h(
      "section",
      { class: "props-section" },
      h("h3", {}, title3),
      ...body3.filter((b2) => !!b2)
    );
  }
  function row2(label4, ...controls) {
    return h(
      "label",
      { class: "prop-row" },
      h("span", { class: "prop-label" }, label4),
      ...controls
    );
  }
  function makePlaceholderSection(sel) {
    const src = sourceOf(sel.key);
    if (!ed.master || !src?.writable) return null;
    const tag = sel.el.localName;
    const text = TEXT_TAGS.includes(tag);
    const picture = PICTURE_TAGS.includes(tag);
    if (!text && !picture) return null;
    return section(
      "Placeholder",
      h(
        "p",
        { class: "hint" },
        "Make this shape a zone each slide on the layout fills; it keeps its look."
      ),
      h(
        "div",
        { class: "master-actions" },
        text ? h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => placeholderDialog("text", sel)
          },
          "Make text placeholder"
        ) : null,
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => placeholderDialog("picture", sel)
          },
          "Make picture placeholder"
        )
      )
    );
  }
  var previewTimer = 0;
  function placeholderSection(sel) {
    const name2 = zoneName(sel.el);
    const info4 = listed().placeholders.find((p2) => p2.name === name2);
    const kind = info4?.kind ?? kindOf(name2);
    const src = sourceOf(sel.key);
    const file = src?.path ?? ed.master?.path ?? "";
    const note2 = h("p", { class: "hint placeholder-note" });
    const nameInput = h("input", {
      type: "text",
      value: name2,
      spellcheck: "false",
      "aria-label": "Placeholder name"
    });
    const say = (text, error2 = false) => {
      note2.textContent = text;
      note2.classList.toggle("error", error2);
    };
    const fills = fillsText(info4?.filled ?? [], slideNumber);
    say(fills);
    const valid = () => {
      const { name: n3, problem } = checkName(
        kind,
        nameInput.value,
        listed().ids,
        name2
      );
      if (problem) say(problem, true);
      return problem || n3 === name2 ? null : n3;
    };
    nameInput.addEventListener("input", () => {
      window.clearTimeout(previewTimer);
      const to = valid();
      if (!to) {
        if (zoneNameFor(kind, nameInput.value) === name2) say(fills);
        return;
      }
      say(`zone-${to}\u2026`);
      previewTimer = window.setTimeout(async () => {
        const result = await request({
          action: "master",
          op: "zone-rename",
          file,
          zone: name2,
          to: nameInput.value,
          dryRun: true
        });
        if (zoneNameFor(kind, nameInput.value) !== to) return;
        if (!result.ok) {
          say(result.error ?? "cannot rename", true);
          return;
        }
        const plan2 = result.placeholder;
        const warn = plan2.warnings.length ? ` \xB7 ${plan2.warnings[0]}` : "";
        say(`zone-${to} \xB7 ${renameSummary(plan2)}${warn}`);
      }, 250);
    });
    nameInput.addEventListener("change", () => {
      window.clearTimeout(previewTimer);
      const to = valid();
      if (!to || !src) {
        if (!to && zoneNameFor(kind, nameInput.value) === name2)
          nameInput.value = name2;
        return;
      }
      void edit({
        action: "master",
        op: "zone-rename",
        file,
        hash: src.hash,
        zone: name2,
        to: nameInput.value
      }).then((result) => {
        if (result.ok && typeof result.zone === "string") {
          afterRender.ids = [`zone-${result.zone}`];
          const n3 = result.placeholder?.slides.length;
          toast(
            n3 ? `Renamed to \u201C${result.zone}\u201D on the layout and ${n3} slide${n3 === 1 ? "" : "s"}` : `Renamed to \u201C${result.zone}\u201D`
          );
        } else {
          nameInput.value = name2;
        }
      });
    });
    nameInput.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") nameInput.blur();
    });
    const prompt = h("input", {
      type: "text",
      value: info4?.prompt ?? "",
      placeholder: "None: the zone's name shows",
      "aria-label": "Prompt"
    });
    prompt.addEventListener("change", () => {
      if (!src || prompt.value.trim() === (info4?.prompt ?? "")) return;
      void edit({
        action: "master",
        op: "zone-prompt",
        file,
        hash: src.hash,
        zone: name2,
        prompt: prompt.value
      });
    });
    prompt.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") prompt.blur();
    });
    return section(
      "Placeholder",
      row2(
        "Kind",
        h(
          "span",
          { class: "prop-value" },
          kind === "picture" ? "Picture or video" : "Text",
          info4?.shape ? " \xB7 drawn as a shape" : ""
        )
      ),
      row2("Name", nameInput),
      note2,
      row2("Prompt", prompt),
      h(
        "p",
        { class: "hint" },
        "Each slide on this layout fills this zone with its own content; the prompt is what the empty zone says on a new slide."
      ),
      h(
        "div",
        { class: "master-actions" },
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Take this zone out of the layout",
            onclick: () => removeDialog(name2, info4 ?? null, src)
          },
          "Remove placeholder"
        )
      )
    );
  }
  function removeDialog(name2, info4, src) {
    if (!src) return;
    const filled = info4?.filled ?? [];
    const drop = h("input", { type: "checkbox" });
    const body3 = h(
      "div",
      { class: "master-form" },
      h(
        "p",
        {},
        info4?.shape ? `Remove the placeholder \u201C${name2}\u201D? The shape stays, as a plain shape.` : `Remove the placeholder \u201C${name2}\u201D from this layout?`
      ),
      filled.length ? h(
        "label",
        { class: "check" },
        drop,
        `Also delete what ${filled.length === 1 ? "slide" : "slides"} ${filled.map(slideNumber).join(", ")} put in it`
      ) : null,
      filled.length ? h(
        "p",
        { class: "hint" },
        "Otherwise their text stays in their files and no longer shows. Undo brings everything back."
      ) : null,
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "pbtn", onclick: () => closeDialog() },
          "Cancel"
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn danger",
            onclick: async () => {
              const result = await edit({
                action: "master",
                op: "zone-remove",
                file: src.path,
                hash: src.hash,
                zone: name2,
                dropContent: drop.checked
              });
              if (result.ok) closeDialog();
            }
          },
          "Remove"
        )
      )
    );
    openDialog("Remove placeholder", body3);
  }

  // src/ts/editor/master.ts
  var aside = document.getElementById("master");
  var button = document.getElementById("btn-layout");
  var menu2 = document.getElementById("context-menu");
  var tree = null;
  var item = null;
  var onSlide = null;
  var thumbs = /* @__PURE__ */ new Map();
  var dirty = false;
  var loading = 0;
  async function openMaster(want) {
    if (!ed.model) return;
    if (!ed.masterMode) {
      ed.masterMode = true;
      ed.layoutMode = true;
      dirty = false;
      document.body.classList.add("master-mode", "layout-mode");
      button.classList.add("on");
      setTool("select");
    }
    enterGroup(null);
    clearSelection();
    await loadTree();
    void loadThumbs();
    const start = want?.name ? find(want) : initialItem();
    if (start) await show(start);
    else renderList();
  }
  async function closeMaster() {
    if (!ed.masterMode) return;
    ed.masterMode = false;
    ed.layoutMode = false;
    ed.master = null;
    item = null;
    onSlide = null;
    document.body.classList.remove("master-mode", "layout-mode");
    button.classList.remove("on");
    enterGroup(null);
    clearSelection();
    render();
    emit("slide");
    emit("layout-mode");
    if (dirty) {
      dirty = false;
      await edit({ action: "master", op: "previews", attach: true });
    }
  }
  function toggle() {
    if (ed.masterMode) void closeMaster();
    else void openMaster();
  }
  function initialItem() {
    if (!tree) return null;
    const mine = tree.layouts.find((l2) => l2.slides.includes(ed.current));
    const chosen = mine ?? tree.layouts.find((l2) => l2.name === tree?.background);
    return chosen ? { kind: "layout", name: chosen.name, path: chosen.path } : null;
  }
  function find(want) {
    if (!tree) return null;
    if (want.kind === "overlay") {
      const o2 = tree.overlays.find((x2) => x2.name === want.name && x2.path);
      return o2?.path ? { kind: "overlay", name: o2.name, path: o2.path } : null;
    }
    const l2 = tree.layouts.find((x2) => x2.name === want.name);
    return l2 ? { kind: "layout", name: l2.name, path: l2.path } : null;
  }
  async function loadTree() {
    const result = await request({ action: "master-tree" });
    if (result.ok) tree = result.master;
  }
  async function loadThumbs() {
    const result = await request({ action: "layout-previews", all: true });
    if (!result.ok) return;
    const list4 = result.layouts;
    thumbs = new Map(list4.map((p2) => [p2.name, p2.svg]));
    if (ed.masterMode) renderList();
  }
  function withTarget(slide, path, kind) {
    const root2 = ed.model?.projectDir ?? "";
    for (const src of slide.sources ?? []) {
      if (src.path !== path) continue;
      const to = copyTarget(src.path, root2, kind);
      if (to && !src.writable) src.copyTo = to;
      src.writable = true;
    }
    return slide;
  }
  async function show(next, slideIndex2 = onSlide) {
    const ticket = ++loading;
    const changed2 = item?.path !== next.path || item?.kind !== next.kind;
    item = next;
    onSlide = slideIndex2;
    const listing = loadPlaceholders(next.kind, next.path);
    let view3 = null;
    if (slideIndex2 != null) {
      const real = ed.model?.slides[slideIndex2];
      const data = real?.visibleIndex != null ? ed.slides[real.visibleIndex] : null;
      if (real && data) {
        view3 = {
          slide: withTarget(structuredClone(real), next.path, next.kind),
          data
        };
      } else {
        onSlide = null;
      }
    }
    if (!view3) {
      const result = await request({
        action: "master-render",
        kind: next.kind,
        path: next.path
      });
      if (ticket !== loading || !ed.masterMode) return;
      if (!result.ok) {
        toast(result.error ?? "could not draw it", "error");
        renderList();
        return;
      }
      view3 = {
        slide: withTarget(
          result.entry,
          result.target,
          next.kind
        ),
        data: result.slide
      };
    }
    const placeholders = await listing ?? void 0;
    if (ticket !== loading || !ed.masterMode) return;
    ed.master = {
      kind: next.kind,
      name: next.name,
      path: next.path,
      onSlide,
      placeholders,
      ...view3
    };
    if (changed2) {
      enterGroup(null);
      clearSelection();
    }
    render();
    renderList();
  }
  async function refresh() {
    if (!ed.masterMode) return;
    await loadTree();
    void loadThumbs();
    const again = item ? find(item) : null;
    const next = again ?? initialItem();
    if (next) await show(next);
    else renderList();
  }
  function fadeContext() {
    const svg = slideRoot();
    if (!svg || !ed.master) return;
    const sources = ed.master.slide.sources ?? [];
    for (const el2 of svg.querySelectorAll("[data-ink-top]")) {
      const src = sources[keyOf(el2)];
      el2.classList.toggle(
        "master-context",
        !!src && src.path !== ed.master.path
      );
    }
  }
  function thumb(name2) {
    const box2 = h("div", { class: "master-thumb" });
    const svg = name2 ? thumbs.get(name2) : void 0;
    if (svg) {
      box2.innerHTML = svg;
      const el2 = box2.querySelector("svg");
      el2?.setAttribute("width", "100%");
      el2?.setAttribute("height", "100%");
      el2?.querySelectorAll(".anim-pending").forEach((x2) => {
        x2.classList.remove("anim-pending");
      });
      if (el2) scheduleFit(el2);
    }
    return box2;
  }
  function badge(of) {
    const o2 = origin(of);
    return h(
      "span",
      { class: `master-badge ${o2.kind}`, title: o2.title },
      o2.text
    );
  }
  function current(kind, path) {
    return !!item && item.kind === kind && item.path === path;
  }
  function row3(kind, entry, title3, sub, depth, thumbName) {
    const path = entry.path;
    const el2 = h(
      "div",
      {
        class: `master-row${current(kind, path) ? " active" : ""}`,
        style: `--depth:${depth}`,
        role: "button",
        tabindex: "0",
        title: entry.rel ?? entry.name,
        "data-name": entry.name,
        "data-kind": kind
      },
      kind === "layout" ? thumb(thumbName) : h("div", { class: "master-thumb overlay-thumb" }, "On top"),
      h(
        "div",
        { class: "master-text" },
        h("div", { class: "master-title" }, title3),
        h("div", { class: "master-sub" }, sub, " ", badge(entry))
      ),
      h(
        "button",
        {
          type: "button",
          class: "master-more",
          title: "More: copy, revert, rename, delete",
          onclick: (e2) => {
            e2.stopPropagation();
            rowMenu(kind, entry, e2.clientX, e2.clientY);
          }
        },
        "\u22EF"
      )
    );
    const open5 = () => {
      if (path) void show({ kind, name: entry.name, path }, null);
    };
    el2.addEventListener("click", open5);
    el2.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" || e2.key === " ") {
        e2.preventDefault();
        open5();
      }
    });
    el2.addEventListener("contextmenu", (e2) => {
      e2.preventDefault();
      rowMenu(kind, entry, e2.clientX, e2.clientY);
    });
    return el2;
  }
  function title(l2) {
    return layoutTitle(l2, { [l2.name]: layoutLabel(l2.name) });
  }
  function total() {
    return ed.model?.slides.length ?? 0;
  }
  function slideName(i2) {
    const s2 = ed.model?.slides[i2];
    if (!s2) return `slide ${i2 + 1}`;
    const n3 = s2.visibleIndex != null ? `Slide ${s2.visibleIndex + 1}` : "Hidden slide";
    return s2.title ? `${n3}: ${s2.title}` : n3;
  }
  function renderList() {
    clear(aside);
    aside.append(
      h(
        "div",
        { class: "master-head" },
        h("strong", {}, "Slide master"),
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Back to the slides",
            onclick: () => void closeMaster()
          },
          "Close"
        )
      )
    );
    if (!tree) {
      aside.append(h("p", { class: "hint" }, "Loading\u2026"));
      return;
    }
    const list4 = h("div", { class: "master-list" });
    list4.append(h("div", { class: "master-group" }, "All slides"));
    const background = tree.layouts.find((l2) => l2.name === tree?.background);
    if (background) {
      list4.append(
        row3(
          "layout",
          background,
          "Background",
          `${background.name} \xB7 ${usage(background, true, total())}`,
          0,
          background.name
        )
      );
    }
    const onTop = tree.overlays.filter((o2) => o2.deck);
    for (const o2 of onTop) {
      list4.append(
        row3(
          "overlay",
          o2,
          `On top \xB7 ${o2.name}`,
          tree.overlaysFromTheme ? "from the theme" : plural2(o2.slides.length, "slide"),
          0,
          null
        )
      );
    }
    list4.append(
      h(
        "button",
        {
          type: "button",
          class: "master-add",
          title: "An overlay: drawn on top of every slide, whatever its layout (a logo, footer text)",
          onclick: () => newOverlay()
        },
        onTop.length ? "+ Another overlay" : "+ New overlay (logo, footer\u2026)"
      )
    );
    for (const o2 of tree.overlays.filter((x2) => !x2.deck)) {
      const sub = o2.slides.length ? `on ${plural2(o2.slides.length, "slide")} of their own` : "not used";
      list4.append(row3("overlay", o2, o2.name, sub, 0, null));
    }
    for (const over of tree.overrides) {
      list4.append(
        h(
          "div",
          { class: "master-note" },
          `${slideName(over.slide)} has its own overlays: ${over.overlays.join(", ") || "none"}`
        )
      );
    }
    list4.append(h("div", { class: "master-group" }, "Layouts"));
    for (const r2 of layoutRows(tree)) {
      list4.append(
        row3(
          "layout",
          r2.layout,
          title(r2.layout),
          `${r2.layout.name === title(r2.layout) ? "" : `${r2.layout.name} \xB7 `}${usage(r2.layout, false)}`,
          r2.depth,
          r2.layout.name
        )
      );
    }
    aside.append(list4);
    aside.querySelector(".master-row.active")?.scrollIntoView({ block: "nearest" });
  }
  function layoutOf(name2) {
    return tree?.layouts.find((l2) => l2.name === name2) ?? null;
  }
  function rowMenu(kind, entry, x2, y2) {
    clear(menu2);
    const theme = !entry.copyOf && entry.source !== "local";
    const editable = !!ed.model?.deckEditable;
    if (theme) {
      menu2.append(
        menuItem(
          "Make this deck's own copy",
          () => void copyIn(kind, entry.name)
        )
      );
    }
    if (entry.copyOf) {
      menu2.append(
        menuItem(
          `Revert to the theme's ${kind}`,
          () => void revert(kind, entry.name)
        )
      );
    }
    if (kind === "layout" && entry.source === "local" && !entry.copyOf) {
      menu2.append(
        menuItem(
          "Rename\u2026",
          () => renameLayout(entry),
          !editable
        ),
        menuItem(
          "Delete\u2026",
          () => deleteLayout(entry),
          !editable
        )
      );
    }
    if (!menu2.childElementCount) {
      menu2.append(menuItem("Nothing to change here", () => {
      }, true));
    }
    showMenu(x2, y2);
  }
  async function copyIn(kind, name2) {
    const result = await edit({
      action: "master",
      op: "copy",
      kind,
      name: name2
    });
    if (result.ok) {
      const info4 = result.copied;
      if (info4) toast(info4.note);
      dirty = false;
    }
  }
  async function revert(kind, name2) {
    const what = kind === "layout" ? `layout \u201C${name2}\u201D` : `overlay \u201C${name2}\u201D`;
    if (!window.confirm(
      `Delete this deck's copy of the ${what}? Slides on it go back to the theme's ${kind}, and your changes to it are gone (Undo brings them back).`
    )) {
      return;
    }
    const result = await edit({ action: "master", op: "revert", kind, name: name2 });
    if (result.ok) toast(`Back to the theme's ${what}`);
  }
  function nameDialog(heading, label4, value, extra, run) {
    const input = h("input", {
      type: "text",
      class: "master-name",
      value,
      spellcheck: "false"
    });
    const ok = h("button", { type: "submit", class: "pbtn primary" }, "OK");
    const form = h(
      "form",
      { class: "master-form" },
      h("label", {}, label4, input),
      extra,
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "pbtn", onclick: () => closeDialog() },
          "Cancel"
        ),
        ok
      )
    );
    form.addEventListener("submit", (e2) => {
      e2.preventDefault();
      const name2 = input.value.trim();
      if (!name2) return;
      ok.disabled = true;
      void run(name2).then((done) => {
        if (done) closeDialog();
        else ok.disabled = false;
      });
    });
    openDialog(heading, form);
    input.focus();
    input.select();
  }
  function newOverlay() {
    const every = h(
      "p",
      { class: "hint" },
      "An overlay is drawn on top of every slide, whatever its layout: put a logo, footer text or a badge in it. It is overlays/<name>.svg, added to Deck(overlays=[\u2026])."
    );
    nameDialog("New overlay", "Name", "logo", every, async (name2) => {
      const result = await edit({
        action: "master",
        op: "new-overlay",
        name: name2
      });
      if (!result.ok) return false;
      const made = result.overlay;
      pendingItem = { kind: "overlay", name: made.name };
      toast(`Overlay \u201C${made.name}\u201D is on every slide: draw into it here`);
      return true;
    });
  }
  function renameLayout(l2) {
    nameDialog(
      `Rename \u201C${title(l2)}\u201D`,
      "New name",
      title(l2),
      h(
        "p",
        { class: "hint" },
        "Slides and layouts built on it follow the new name."
      ),
      async (name2) => {
        const result = await edit({
          action: "master",
          op: "rename",
          name: l2.name,
          to: name2
        });
        if (result.ok && typeof result.layout === "string") {
          pendingItem = { kind: "layout", name: result.layout };
        }
        return result.ok;
      }
    );
  }
  function deleteLayout(l2) {
    const users = l2.slides.length;
    const children2 = (tree?.layouts ?? []).filter((x2) => x2.parent === l2.name);
    const others2 = (tree?.layouts ?? []).filter(
      (x2) => x2.name !== l2.name && !children2.includes(x2)
    );
    const pickTo = h(
      "select",
      { class: "master-move" },
      ...others2.map(
        (x2) => h("option", { value: x2.name }, `${title(x2)} (${x2.name})`)
      )
    );
    pickTo.value = l2.parent && others2.some((x2) => x2.name === l2.parent) ? l2.parent : others2[0]?.name ?? "";
    const used = users > 0 || children2.length > 0;
    const body3 = h(
      "div",
      { class: "master-form" },
      h(
        "p",
        {},
        used ? `${[users ? plural2(users, "slide") : "", children2.length ? `layout ${children2.map((c2) => `\u201C${c2.name}\u201D`).join(", ")}` : ""].filter(Boolean).join(" and ")} ${users + children2.length === 1 ? "is" : "are"} built on \u201C${title(l2)}\u201D. Move ${users + children2.length === 1 ? "it" : "them"} to:` : `Delete the layout \u201C${title(l2)}\u201D (${l2.rel ?? l2.name})? No slide uses it.`
      ),
      used ? pickTo : null,
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "pbtn", onclick: () => closeDialog() },
          "Cancel"
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn danger",
            onclick: async () => {
              const result = await edit({
                action: "master",
                op: "delete",
                name: l2.name,
                ...used ? { moveTo: pickTo.value } : {}
              });
              if (!result.ok) return;
              closeDialog();
              if (item?.name === l2.name) {
                pendingItem = {
                  kind: "layout",
                  name: used ? pickTo.value : l2.parent ?? ""
                };
              }
            }
          },
          used ? "Move and delete" : "Delete"
        )
      )
    );
    openDialog(`Delete layout \u201C${title(l2)}\u201D`, body3);
  }
  function masterPanel() {
    if (!ed.master || !item || !tree) return null;
    const view3 = ed.master;
    const kind = item.kind;
    const layout2 = kind === "layout" ? layoutOf(item.name) : null;
    const overlay3 = kind === "overlay" ? tree.overlays.find((o3) => o3.name === item?.name) ?? null : null;
    const entry = layout2 ?? overlay3;
    if (!entry) return null;
    const o2 = origin(entry);
    const isBackground = layout2?.name === tree.background;
    const heading = isBackground ? "Background (every slide)" : layout2 ? `Layout: ${title(layout2)}` : `On top: ${item.name}`;
    const explain = {
      theme: kind === "layout" ? `From the theme. Your first edit gives this deck its own copy (layouts/${item.name}.svg), which ${isBackground ? "every slide" : "every slide on it"} then follows.` : `From the theme. Your first edit gives this deck its own copy (overlays/${item.name}.svg).`,
      copy: `This deck's own copy of ${entry.copyOf}: ${isBackground ? "every slide" : "the slides on it"} follow your copy, not the theme's.`,
      own: kind === "overlay" ? "Drawn on top of every slide that gets it, whatever the slide's layout." : "A layout of this deck's own."
    }[o2.kind];
    const reach = layout2 ? layout2.reach : overlay3?.slides ?? [];
    const shown3 = h(
      "select",
      { title: "See the layout with a slide's own content" },
      h(
        "option",
        { value: "" },
        kind === "layout" ? "Alone, with sample text" : "Over the background"
      ),
      ...reach.map((i2) => h("option", { value: String(i2) }, slideName(i2)))
    );
    shown3.value = view3.onSlide != null ? String(view3.onSlide) : "";
    shown3.addEventListener("change", () => {
      const v2 = shown3.value;
      if (item) void show(item, v2 === "" ? null : Number(v2));
    });
    const actions = [];
    if (o2.kind === "theme") {
      actions.push(
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => void copyIn(kind, entry.name)
          },
          "Make this deck's copy"
        )
      );
    }
    if (o2.kind === "copy") {
      actions.push(
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => void revert(kind, entry.name)
          },
          `Revert to the theme's ${kind}`
        )
      );
    }
    if (layout2 && o2.kind === "own") {
      actions.push(
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => renameLayout(layout2)
          },
          "Rename\u2026"
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => deleteLayout(layout2)
          },
          "Delete\u2026"
        )
      );
    }
    const opener = entry.source === "local" ? openButton(view3.path) : null;
    if (opener) actions.push(opener);
    return h(
      "div",
      { class: "master-panel" },
      h("h3", {}, heading),
      h("p", { class: "hint" }, explain),
      h(
        "p",
        { class: "hint" },
        kind === "layout" ? usage(layout2, isBackground, total()) : `${plural2(reach.length, "slide")} get${reach.length === 1 ? "s" : ""} it`
      ),
      h(
        "label",
        { class: "prop-row" },
        h("span", { class: "prop-label" }, "Show"),
        shown3
      ),
      h(
        "div",
        { class: "master-actions" },
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "An empty text zone each slide fills with its own text",
            onclick: () => placeholderDialog("text")
          },
          "+ Text placeholder"
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "An empty zone each slide fills with a picture or video",
            onclick: () => placeholderDialog("picture")
          },
          "+ Picture placeholder"
        )
      ),
      h(
        "p",
        { class: "hint" },
        "Draw shapes, text and pictures with the toolbar: they go into this file."
      ),
      actions.length ? h("div", { class: "master-actions" }, ...actions) : null
    );
  }
  function saveAsLayout(index = ed.current) {
    const slide = ed.model?.slides[index];
    if (!slide) return;
    if (!ed.model?.deckEditable) {
      toast(
        "deck.py builds its slides in code; save the layout there",
        "error"
      );
      return;
    }
    const hints = h("input", {
      type: "checkbox",
      checked: true
    });
    const pictures = h("input", { type: "checkbox" });
    const extra = h(
      "div",
      {},
      h(
        "label",
        { class: "check" },
        hints,
        "Keep the slide's text as placeholder prompts"
      ),
      h(
        "label",
        { class: "check" },
        pictures,
        "Turn its pictures into picture placeholders"
      ),
      h(
        "p",
        { class: "hint" },
        "The slide's drawing and the layout it is built on carry over; its text zones stay, empty. New slides can then start from it."
      )
    );
    nameDialog(
      `Save ${slideName(index)} as a layout`,
      "Layout name",
      "",
      extra,
      async (name2) => {
        const result = await edit({
          action: "master",
          op: "save",
          slide: index,
          name: name2,
          hints: hints.checked,
          pictures: pictures.checked
        });
        if (!result.ok) return false;
        toast(
          `Saved as the layout \u201C${name2}\u201D: \u201CNew slide\u201D offers it now`,
          "ok"
        );
        return true;
      }
    );
  }
  var pendingItem = null;
  function initMaster() {
    button.addEventListener("click", toggle);
    on("model", () => {
      if (!ed.masterMode) return;
      if (pendingItem) {
        const want = pendingItem;
        pendingItem = null;
        void loadTree().then(() => {
          const next = find(want);
          void loadThumbs();
          if (next) void show(next, null);
          else void refresh();
        });
        return;
      }
      void refresh();
    });
    on("render", fadeContext);
    on("history", () => {
      if (ed.masterMode && ed.canUndo) dirty = true;
    });
    on("master-copied", renderList);
    document.addEventListener("keydown", (e2) => {
      if (e2.key === "Escape" && menu2.classList.contains("open")) closeMenu();
    });
  }

  // src/ts/editor/problemstext.ts
  function worst(problems2) {
    if (!problems2?.length) return null;
    if (problems2.some((p2) => p2.level === "error")) return "error";
    if (problems2.some((p2) => p2.level === "warn")) return "warn";
    return "hint";
  }
  function marked(problems2) {
    return (problems2 ?? []).filter((p2) => p2.level !== "hint");
  }
  function countMarked(all) {
    return all.reduce((n3, p2) => n3 + marked(p2).length, 0);
  }
  function problemTitle(problems2) {
    const shown3 = marked(problems2);
    if (!shown3.length) return "";
    return shown3.map((p2) => `${p2.level === "error" ? "\u25CF" : "\u26A0"} ${p2.message}`).join("\n");
  }
  function slidesWithProblems(all, hints) {
    const out = [];
    all.forEach((p2, i2) => {
      if ((hints ? p2 : marked(p2)).length) out.push(i2);
    });
    return out;
  }
  function layoutWords(state) {
    if (state.running) return "Checking the layout\u2026";
    if (state.error) return `The layout check failed: ${state.error}`;
    if (!state.on)
      return "The layout check (text that does not fit, objects outside the slide, text too small, coarse pictures) needs a browser run: turn it on to keep it up to date.";
    return state.contrast ? "Layout and contrast are checked after every change." : "The layout is checked after every change (contrast is not).";
  }

  // src/ts/editor/problems.ts
  var button2 = document.getElementById("btn-problems");
  var CONTRAST_KEY = "inkflow-editor-check-contrast";
  var HINTS_KEY = "inkflow-editor-problem-hints";
  var problems = [];
  var layout = {
    on: false,
    contrast: false,
    running: false,
    error: null
  };
  var listBody = null;
  var onlySlide = null;
  function pref(key) {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }
  function setPref(key, on2) {
    try {
      localStorage.setItem(key, on2 ? "1" : "");
    } catch {
    }
  }
  function slideProblems(i2) {
    return problems.length === (ed.model?.slides.length ?? -1) ? problems[i2] ?? [] : [];
  }
  function paint2(badge4, list4) {
    const shown3 = marked(list4);
    const level = worst(shown3);
    badge4.textContent = shown3.length ? "\u26A0" : "";
    badge4.className = `problem-mark${level ? ` p-${level}` : ""}`;
    if (shown3.length) badge4.setAttribute("title", problemTitle(list4));
    else badge4.removeAttribute("title");
  }
  function problemBadge(i2) {
    const badge4 = h("span", { class: "problem-mark" });
    paint2(badge4, slideProblems(i2));
    badge4.addEventListener("click", (e2) => {
      if (!badge4.textContent) return;
      e2.stopPropagation();
      openProblems(i2);
    });
    return badge4;
  }
  function markProblems(item2, i2) {
    const badge4 = item2.querySelector(".problem-mark");
    if (badge4) paint2(badge4, slideProblems(i2));
  }
  function renderButton() {
    const n3 = countMarked(problems);
    button2.hidden = !n3 && !layout.running;
    button2.classList.toggle("busy", layout.running);
    button2.querySelector(".problem-count").textContent = n3 ? String(n3) : "";
    button2.title = layout.running ? "Checking the layout\u2026" : `${n3} problem${n3 === 1 ? "" : "s"} on the slides`;
  }
  function slideName2(i2) {
    const slide = ed.model?.slides[i2];
    return slide?.title ?? slide?.id ?? `slide ${i2 + 1}`;
  }
  function renderList2() {
    if (!listBody) return;
    const hints = pref(HINTS_KEY);
    const indices = onlySlide != null ? [onlySlide] : slidesWithProblems(problems, hints);
    clear(listBody);
    if (!indices.length || !slideProblems(indices[0]).length) {
      listBody.append(
        h("p", { class: "hint" }, "No problems found on the slides.")
      );
      return;
    }
    for (const i2 of indices) {
      const list4 = hints ? slideProblems(i2) : marked(slideProblems(i2));
      if (!list4.length) continue;
      listBody.append(
        h(
          "button",
          {
            type: "button",
            class: "problem-slide",
            title: "Go to this slide",
            onclick: () => {
              closeDialog();
              ed.slideSelection.clear();
              gotoSlide(i2);
            }
          },
          `${i2 + 1} \xB7 ${slideName2(i2)}`
        ),
        h(
          "ul",
          { class: "problem-list" },
          ...list4.map(
            (p2) => h(
              "li",
              { class: `p-${p2.level}` },
              h(
                "span",
                { class: "problem-level" },
                p2.level === "error" ? "\u2716" : p2.level === "warn" ? "\u26A0" : "\xB7"
              ),
              h("span", {}, p2.message)
            )
          )
        )
      );
    }
  }
  function openProblems(only = null) {
    onlySlide = only;
    const contrast = h("input", { type: "checkbox" });
    contrast.checked = pref(CONTRAST_KEY);
    const hints = h("input", { type: "checkbox" });
    hints.checked = pref(HINTS_KEY);
    const status3 = h("p", { class: "hint" });
    const toggle3 = h("button", { type: "button", class: "pbtn" });
    const drawState = () => {
      status3.textContent = layoutWords(layout);
      status3.classList.toggle("warn", !!layout.error);
      toggle3.textContent = layout.on ? "Stop checking the layout" : "Check the layout";
      toggle3.classList.toggle("primary", !layout.on);
    };
    toggle3.addEventListener("click", () => {
      sendRaw({
        type: "problems-check",
        on: !layout.on,
        contrast: contrast.checked
      });
    });
    contrast.addEventListener("change", () => {
      setPref(CONTRAST_KEY, contrast.checked);
      if (layout.on)
        sendRaw({
          type: "problems-check",
          on: true,
          contrast: contrast.checked
        });
    });
    hints.addEventListener("change", () => {
      setPref(HINTS_KEY, hints.checked);
      renderList2();
    });
    listBody = h("div", { class: "problem-body" });
    const box2 = openDialog(
      only != null ? `Problems on slide ${only + 1}` : "Problems",
      h(
        "div",
        { class: "git-form" },
        h(
          "div",
          { class: "btn-row" },
          toggle3,
          h(
            "label",
            { class: "problem-opt" },
            contrast,
            h("span", {}, "Also check text contrast")
          ),
          h(
            "label",
            { class: "problem-opt" },
            hints,
            h("span", {}, "Show hints")
          ),
          only != null ? h(
            "button",
            {
              type: "button",
              class: "link-btn",
              onclick: () => {
                onlySlide = null;
                renderList2();
              }
            },
            "All slides"
          ) : null
        ),
        status3,
        listBody
      ),
      {
        wide: true,
        onClose: () => {
          listBody = null;
        }
      }
    );
    box2.classList.add("problems-dialog");
    drawState();
    renderList2();
    redraw2 = drawState;
  }
  var redraw2 = null;
  function initProblems() {
    button2.addEventListener("click", () => openProblems());
    onMessage("problems", (msg) => {
      problems = msg.slides ?? [];
      layout = msg.layout ?? layout;
      renderButton();
      if (listBody && dialogOpen()) {
        renderList2();
        redraw2?.();
      }
      emit("problems");
    });
    on("model", renderButton);
  }

  // src/ts/editor/rename.ts
  function relOf(path) {
    if (!path) return null;
    const rel = projectRel(
      path.replace(/[?#].*$/, ""),
      ed.model?.projectDir ?? ""
    );
    return rel && !rel.startsWith("_theme/") && !rel.startsWith("_pdf/") ? rel : null;
  }
  function renameButton(path, label4 = "Rename\u2026") {
    const rel = relOf(path);
    if (!rel) return null;
    return h(
      "button",
      {
        type: "button",
        class: "pbtn open-with",
        title: `Give ${rel} another name or folder; every reference follows`,
        onclick: () => void renameFile(rel)
      },
      label4
    );
  }
  function summaryLine(p2) {
    if (!p2.references) return "Nothing refers to it: only the file moves.";
    return `Updates ${plural(p2.references, "reference")} in ${plural(p2.files, "file")}.`;
  }
  function previewBody(p2, opts2) {
    const box2 = h("div", { class: "rename-preview" });
    if (opts2.moves && p2.moves.length) {
      box2.append(
        h("p", { class: "rename-msg rename-head" }, "Files"),
        h(
          "ul",
          { class: "rename-list" },
          ...p2.moves.map(
            (m2) => h(
              "li",
              {},
              h("code", { class: "rename-code" }, m2.from),
              " \u2192 ",
              h("code", { class: "rename-code" }, m2.to)
            )
          )
        )
      );
    }
    if (p2.shared.length) {
      box2.append(
        h("p", { class: "rename-msg rename-head" }, "Stay as they are"),
        h(
          "ul",
          { class: "rename-list" },
          ...p2.shared.map(
            (s2) => h("li", {}, h("code", { class: "rename-code" }, s2))
          )
        )
      );
    }
    box2.append(h("p", { class: "rename-msg rename-summary" }, summaryLine(p2)));
    for (const [old, now] of Object.entries(p2.ids)) {
      box2.append(
        h(
          "p",
          { class: "hint" },
          `The slide id ${old} becomes ${now}; its saved ink follows${p2.links ? `, and ${plural(p2.links, "slide: link")} ${p2.links === 1 ? "is" : "are"} rewritten` : ""}.`
        )
      );
    }
    if (p2.edits.length) {
      const byFile = /* @__PURE__ */ new Map();
      for (const e2 of p2.edits) {
        const list5 = byFile.get(e2.file) ?? [];
        list5.push(e2);
        byFile.set(e2.file, list5);
      }
      const list4 = h("ul", { class: "rename-list" });
      for (const [file, edits] of byFile) {
        list4.append(
          h(
            "li",
            {},
            h("code", { class: "rename-code" }, file),
            h(
              "ul",
              {},
              ...edits.map(
                (e2) => h(
                  "li",
                  { class: "hint" },
                  `${e2.kind}: `,
                  h("code", { class: "rename-code" }, e2.old),
                  " \u2192 ",
                  h("code", { class: "rename-code" }, e2.new)
                )
              )
            )
          )
        );
      }
      box2.append(
        h(
          "details",
          { class: "rename-details" },
          h("summary", {}, "Show the references"),
          list4
        )
      );
    }
    for (const w2 of p2.warnings) {
      box2.append(h("p", { class: "rename-msg rename-warning" }, w2));
    }
    return box2;
  }
  function renameDialog(opts2) {
    const status3 = h("div", { class: "rename-status" });
    const go = h(
      "button",
      { type: "button", class: "pbtn primary", disabled: true },
      "Rename"
    );
    const cancel2 = h(
      "button",
      { type: "button", class: "pbtn", onclick: () => closeDialog() },
      "Cancel"
    );
    let token = 0;
    let timer6 = 0;
    let last = null;
    const refresh3 = async () => {
      const mine = ++token;
      const req = opts2.build();
      go.disabled = true;
      if (typeof req === "string") {
        status3.className = "rename-status";
        status3.replaceChildren(h("p", { class: "rename-msg hint" }, req));
        return;
      }
      status3.className = "rename-status busy";
      const res = await request({ ...req, dryRun: true });
      if (mine !== token) return;
      if (!res.ok) {
        last = null;
        status3.className = "rename-status error";
        status3.replaceChildren(
          h(
            "p",
            { class: "rename-msg" },
            res.error ?? "This name cannot be used"
          )
        );
        return;
      }
      last = res.rename;
      status3.className = "rename-status";
      status3.replaceChildren(previewBody(last, { moves: opts2.moves }));
      go.disabled = false;
    };
    const schedule2 = () => {
      window.clearTimeout(timer6);
      timer6 = window.setTimeout(() => void refresh3(), 200);
    };
    for (const input of opts2.inputs) {
      input.addEventListener("input", schedule2);
      input.addEventListener("change", schedule2);
      input.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter" && !go.disabled) {
          e2.preventDefault();
          go.click();
        }
      });
    }
    go.addEventListener("click", async () => {
      const req = opts2.build();
      if (typeof req === "string") return;
      go.disabled = true;
      const res = await edit(req);
      if (!res.ok) {
        status3.className = "rename-status error";
        status3.replaceChildren(
          h("p", { class: "rename-msg" }, res.error ?? "Rename failed")
        );
        return;
      }
      const p2 = res.rename ?? last;
      closeDialog();
      toast(
        `${res.label ?? "Renamed"}${p2?.references ? ` \xB7 ${plural(p2.references, "reference")} updated` : ""}`,
        "ok"
      );
      opts2.done(p2);
    });
    openDialog(
      opts2.title,
      h(
        "div",
        { class: "rename-body" },
        opts2.fields,
        status3,
        h("div", { class: "rename-actions" }, cancel2, go)
      ),
      { hint: opts2.hint }
    );
    opts2.inputs[opts2.inputs.length - 1]?.focus();
    opts2.inputs[opts2.inputs.length - 1]?.select();
    status3.replaceChildren(
      h("p", { class: "hint" }, "Type a new name to see what changes.")
    );
  }
  async function renameFile(path, done = () => {
  }) {
    const rel = relOf(path);
    if (!rel) {
      toast("Only the deck's own files can be renamed", "error");
      return;
    }
    const { folder, stem, ext } = splitFileName(rel);
    const folderInput = h("input", {
      type: "text",
      value: folder,
      spellcheck: "false",
      placeholder: "(the deck's folder)",
      title: "The folder, relative to deck.py; a new one is created"
    });
    const nameInput = h("input", {
      type: "text",
      value: stem,
      spellcheck: "false",
      title: "Letters, digits, - and _"
    });
    const fields = h(
      "div",
      { class: "rename-fields" },
      h(
        "label",
        { class: "rename-row" },
        h("span", { class: "rename-label" }, "Folder"),
        folderInput
      ),
      h(
        "label",
        { class: "rename-row" },
        h("span", { class: "rename-label" }, "Name"),
        nameInput,
        h(
          "code",
          { class: "rename-ext", title: "The extension stays" },
          ext
        )
      )
    );
    renameDialog({
      title: `Rename ${rel.split("/").pop() ?? rel}`,
      hint: "Every slide, Markdown file and deck.py line that names it follows",
      fields,
      inputs: [folderInput, nameInput],
      moves: false,
      build: () => {
        if (!nameInput.value.trim()) return "Give it a name.";
        const to = joinFileName(folderInput.value, nameInput.value, ext);
        if (to === rel) return "Type a new name to see what changes.";
        return { action: "rename", from: rel, to };
      },
      done: () => done()
    });
  }
  function renameSlideFiles(deckIndex) {
    const slide = ed.model?.slides[deckIndex];
    if (!slide) return;
    const current3 = slide.md?.kind === "file" && slide.md.rel ? splitFileName(slide.md.rel).stem : slide.srcRel && !slide.srcShared ? splitFileName(slide.srcRel).stem : slide.id ?? "";
    const nameInput = h("input", {
      type: "text",
      value: current3,
      spellcheck: "false",
      title: "Letters, digits, - and _ (no folder, no extension)"
    });
    const keep = h("input", { type: "checkbox" });
    const id = slide.id ?? "";
    const fields = h(
      "div",
      { class: "rename-fields" },
      h(
        "label",
        { class: "rename-row" },
        h("span", { class: "rename-label" }, "Name"),
        nameInput
      ),
      slide.explicitId ? h(
        "p",
        { class: "hint" },
        `Its id stays ${slide.explicitId} (set in deck.py).`
      ) : h(
        "label",
        {
          class: "rename-check",
          title: "Write id= into deck.py so links and ink keep the old id"
        },
        keep,
        ` Keep the slide id ${id}`
      )
    );
    renameDialog({
      title: "Rename slide files",
      hint: "Its drawing, Markdown, notes and ink get the new name",
      fields,
      inputs: [nameInput],
      moves: true,
      build: () => {
        const stem = nameInput.value.trim();
        if (!stem) return "Give it a name.";
        return {
          action: "rename",
          slide: deckIndex,
          stem,
          keepId: keep.checked
        };
      },
      done: () => {
      }
    });
    keep.addEventListener(
      "change",
      () => nameInput.dispatchEvent(new Event("input"))
    );
  }
  function size(bytes) {
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
    return `${bytes} B`;
  }
  async function deletePicked(paths) {
    const dry = await request({ action: "delete-files", paths, dryRun: true });
    const plan2 = planOf(dry);
    if (!plan2) {
      toast(dry.error ?? "Cannot delete those files", "error");
      void openFiles(new Set(paths));
      return;
    }
    const answer = await askDelete({
      title: "Delete files",
      question: `Delete ${plural(plan2.files.length, "file")} from disk?`,
      confirm: "Delete",
      plan: plan2
    });
    if (!answer) {
      void openFiles(new Set(paths));
      return;
    }
    const r2 = await edit({ action: "delete-files", paths });
    if (r2.ok) toast(r2.label ?? "Deleted", "ok");
    void openFiles(r2.ok ? /* @__PURE__ */ new Set() : new Set(paths));
  }
  async function openFiles(initial = /* @__PURE__ */ new Set()) {
    const res = await request({ action: "files" });
    if (!res.ok) {
      toast(res.error ?? "Cannot list the deck's files", "error");
      return;
    }
    const files2 = res.files ?? [];
    const unused = files2.filter((f2) => pickable(f2.state));
    const picked = new Set(
      [...initial].filter(
        (p2) => files2.some((f2) => f2.path === p2 && f2.state !== "used")
      )
    );
    const list4 = h("div", { class: "files-list" });
    const deleteBtn = h(
      "button",
      { type: "button", class: "pbtn", disabled: true },
      "Delete\u2026"
    );
    const sync = () => {
      deleteBtn.disabled = !picked.size;
      deleteBtn.textContent = picked.size ? `Delete ${plural(picked.size, "file")}\u2026` : "Delete\u2026";
    };
    let folder = null;
    for (const f2 of files2) {
      const { folder: dir } = splitFileName(f2.path);
      if (dir !== folder) {
        folder = dir;
        list4.append(h("div", { class: "files-folder" }, `${dir || "."}/`));
      }
      const used = f2.state === "used";
      const check = h("input", {
        type: "checkbox",
        disabled: used,
        title: used ? "In use" : "Pick it to delete",
        "data-path": f2.path
      });
      check.checked = picked.has(f2.path);
      check.addEventListener("change", () => {
        if (check.checked) picked.add(f2.path);
        else picked.delete(f2.path);
        sync();
      });
      const use = useText(f2);
      const badge4 = gitBadge(f2.git);
      list4.append(
        h(
          "div",
          {
            class: `files-row${used ? "" : " unused"}${f2.state === "template" ? " template" : ""}`,
            "data-state": f2.state
          },
          check,
          h(
            "code",
            { class: "rename-code files-name", title: f2.path },
            f2.path.split("/").pop() ?? f2.path
          ),
          h("span", { class: "files-uses", title: use.title }, use.text),
          badge4 ? h(
            "span",
            {
              class: `git-state ${badge4.tone}`,
              title: badge4.title
            },
            badge4.text
          ) : null,
          h("span", { class: "files-size" }, size(f2.size)),
          h(
            "button",
            {
              type: "button",
              class: "pbtn open-with",
              title: "Give it another name or folder; every reference follows",
              onclick: () => void renameFile(f2.path, () => void openFiles())
            },
            "Rename\u2026"
          )
        )
      );
    }
    deleteBtn.addEventListener("click", () => void deletePicked([...picked]));
    const selectUnused = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        disabled: !unused.length,
        title: "Unused files and those only unused files name; not templates",
        onclick: () => {
          for (const f2 of unused) picked.add(f2.path);
          for (const box2 of list4.querySelectorAll(
            "input[data-path]"
          )) {
            box2.checked = picked.has(box2.dataset.path ?? "");
          }
          sync();
        }
      },
      "Pick all unused"
    );
    sync();
    const body3 = h(
      "div",
      { class: "files-body" },
      files2.length ? list4 : h("p", { class: "hint" }, "No files yet."),
      h(
        "div",
        { class: "rename-actions" },
        h(
          "span",
          { class: "hint rename-count" },
          `${plural(files2.length, "file")} \xB7 ${unused.length} unused`
        ),
        selectUnused,
        deleteBtn
      )
    );
    openDialog("Files", body3, {
      wide: true,
      hint: "Pictures, videos, data, diagrams and slide files; a use is a reference from deck.py or from a file the deck uses"
    });
  }

  // src/ts/editor/sections.ts
  function sectionOf(sections2, i2) {
    for (let k2 = 0; k2 < sections2.length; k2++) {
      const s2 = sections2[k2];
      if (i2 >= s2.start && i2 < s2.start + s2.count) return k2;
    }
    return null;
  }
  function sectionSlides(sections2, k2) {
    const s2 = sections2[k2];
    if (!s2) return [];
    return Array.from({ length: s2.count }, (_2, j2) => s2.start + j2);
  }
  function unsectioned(sections2, n3) {
    return sections2.length ? sections2[0].start : n3;
  }
  function sorterRows(n3, sections2, collapsed2) {
    const rows = [];
    for (let i2 = 0; i2 < unsectioned(sections2, n3); i2++) {
      rows.push({ kind: "slide", index: i2 });
    }
    sections2.forEach((s2, k2) => {
      rows.push({ kind: "header", section: k2 });
      if (collapsed2(k2)) return;
      for (let j2 = 0; j2 < s2.count; j2++) {
        rows.push({ kind: "slide", index: s2.start + j2 });
      }
    });
    return rows;
  }
  function sectionBlocks(n3, sections2) {
    const blocks2 = [];
    const first = unsectioned(sections2, n3);
    if (first > 0 || !sections2.length) {
      blocks2.push({
        section: null,
        slides: Array.from({ length: first }, (_2, i2) => i2)
      });
    }
    sections2.forEach((_2, k2) => {
      blocks2.push({ section: k2, slides: sectionSlides(sections2, k2) });
    });
    return blocks2;
  }
  function moveRequest(sections2, moved, insertAt, section3) {
    const slides = [...new Set(moved)].sort((a2, b2) => a2 - b2);
    if (!slides.length) return null;
    const to = insertAt - slides.filter((i2) => i2 < insertAt).length;
    const contiguous = slides.every((v2, j2) => v2 === slides[0] + j2);
    const sameSection = slides.every((i2) => sectionOf(sections2, i2) === section3);
    if (contiguous && sameSection && to === slides[0]) return null;
    return { slides, to, section: section3 };
  }
  function dropOnSlide(sections2, i2, after) {
    return { insertAt: after ? i2 + 1 : i2, section: sectionOf(sections2, i2) };
  }
  function dropOnHeader(sections2, k2) {
    return { insertAt: sections2[k2].start, section: k2 };
  }
  function sectionMoveTo(k2, gap) {
    const to = gap > k2 ? gap - 1 : gap;
    return to === k2 ? null : to;
  }
  function sectionGapAtSlide(sections2, i2) {
    const k2 = sectionOf(sections2, i2);
    if (k2 == null) return 0;
    const s2 = sections2[k2];
    return i2 - s2.start < s2.count / 2 ? k2 : k2 + 1;
  }
  function sectionKeys(sections2) {
    const seen = /* @__PURE__ */ new Map();
    return sections2.map((s2) => {
      const n3 = (seen.get(s2.name) ?? 0) + 1;
      seen.set(s2.name, n3);
      return n3 > 1 ? `${s2.name}#${n3}` : s2.name;
    });
  }

  // src/ts/editor/sectionui.ts
  function sections() {
    return ed.model?.sections ?? [];
  }
  var collapsedKeys = null;
  var collapsedDeck = "";
  function storageKey() {
    return `inkflow-editor-collapsed:${ed.model?.deckPath ?? ""}`;
  }
  function collapsedSet() {
    const deck = ed.model?.deckPath ?? "";
    if (collapsedKeys && collapsedDeck === deck) return collapsedKeys;
    collapsedDeck = deck;
    collapsedKeys = /* @__PURE__ */ new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey()) ?? "[]");
      if (Array.isArray(saved)) {
        for (const k2 of saved)
          if (typeof k2 === "string") collapsedKeys.add(k2);
      }
    } catch {
    }
    return collapsedKeys;
  }
  function saveCollapsed() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify([...collapsedSet()]));
    } catch {
    }
  }
  function isCollapsed(k2) {
    const key = sectionKeys(sections())[k2];
    return key != null && collapsedSet().has(key);
  }
  function setCollapsed(k2, on2) {
    const key = sectionKeys(sections())[k2];
    if (key == null) return;
    if (on2) collapsedSet().add(key);
    else collapsedSet().delete(key);
    saveCollapsed();
    emit("sections");
  }
  function setAllCollapsed(on2) {
    const set = collapsedSet();
    for (const key of sectionKeys(sections())) {
      if (on2) set.add(key);
      else set.delete(key);
    }
    saveCollapsed();
    emit("sections");
  }
  function revealCurrent() {
    const k2 = sectionOf(sections(), ed.current);
    if (k2 == null || !isCollapsed(k2)) return false;
    const key = sectionKeys(sections())[k2];
    collapsedSet().delete(key);
    saveCollapsed();
    return true;
  }
  async function sectionEdit(req) {
    const result = await edit({
      action: "slide",
      follow: ed.current,
      ...req
    });
    if (result.ok && typeof result.select === "number") {
      followSelect(result.select);
    }
    return result.ok;
  }
  async function moveSlidesTo(slides, insertAt, section3) {
    const move = moveRequest(sections(), slides, insertAt, section3);
    if (!move) return;
    if (await sectionEdit({ op: "move", ...move })) ed.slideSelection.clear();
  }
  async function moveSectionToGap(k2, gap) {
    const to = sectionMoveTo(k2, gap);
    if (to == null) return;
    await sectionEdit({ op: "section-move", section: k2, to });
  }
  async function addSectionAt(slide) {
    const name2 = await askName("Add section", "New section");
    if (name2 == null) return;
    await sectionEdit({ op: "section-add", slide, name: name2 });
  }
  async function removeSection(k2, withSlides) {
    const s2 = sections()[k2];
    if (!s2) return;
    if (!withSlides) {
      await sectionEdit({ op: "section-remove", section: k2 });
      return;
    }
    const req = {
      action: "slide",
      op: "section-remove",
      section: k2,
      slides: true
    };
    const answer = await askSlideDelete(
      `Remove section \u201C${s2.name}\u201D and its ${s2.count} slide${s2.count === 1 ? "" : "s"} from the deck?`,
      s2.count,
      req
    );
    if (!answer) return;
    await sectionEdit({
      op: "section-remove",
      section: k2,
      slides: true,
      files: answer.files
    });
  }
  function selectSection(k2) {
    const indices = sectionSlides(sections(), k2);
    ed.focus = "sorter";
    ed.slideSelection.clear();
    if (!indices.length) {
      emit("slide-selection");
      return;
    }
    for (const i2 of indices) ed.slideSelection.add(i2);
    if (!indices.includes(ed.current)) gotoSlide(indices[0]);
    emit("slide-selection");
  }
  function askName(title3, initial) {
    return new Promise((resolve) => {
      let answer = null;
      const input = h("input", {
        type: "text",
        class: "section-name-input",
        value: initial,
        "aria-label": "Section name"
      });
      const ok = h(
        "button",
        { type: "submit", class: "pbtn primary" },
        "Add"
      );
      const form = h(
        "form",
        { class: "section-name-form" },
        input,
        ok
      );
      form.addEventListener("submit", (e2) => {
        e2.preventDefault();
        const name2 = input.value.trim();
        if (!name2) return;
        answer = name2;
        closeDialog();
      });
      openDialog(title3, form, { onClose: () => resolve(answer) });
      input.focus();
      input.select();
    });
  }
  function startRename(k2, nameEl) {
    const s2 = sections()[k2];
    if (!s2 || !ed.model?.deckEditable) return;
    const input = h("input", {
      type: "text",
      class: "section-rename",
      value: s2.name,
      "aria-label": "Section name"
    });
    let done = false;
    const finish2 = (commit) => {
      if (done) return;
      done = true;
      const name2 = input.value.trim();
      if (commit && name2 && name2 !== s2.name) {
        void sectionEdit({ op: "section-rename", section: k2, name: name2 });
      } else {
        emit("sections");
      }
    };
    input.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Enter") {
        e2.preventDefault();
        finish2(true);
      } else if (e2.key === "Escape") {
        e2.preventDefault();
        finish2(false);
      }
    });
    input.addEventListener("blur", () => finish2(true));
    for (const ev of ["click", "dblclick", "pointerdown", "dragstart"]) {
      input.addEventListener(ev, (e2) => e2.stopPropagation());
    }
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
  }
  var renameNext = null;
  function headerPending() {
    return renameNext != null;
  }
  function openSectionMenu(x2, y2, k2) {
    const menu7 = document.getElementById("context-menu");
    const s2 = sections()[k2];
    if (!s2) return;
    const editable = !!ed.model?.deckEditable;
    const n3 = sections().length;
    menu7.replaceChildren();
    menu7.append(
      menuItem(
        "Rename\u2026",
        () => {
          renameNext = k2;
          emit("sections");
        },
        !editable
      ),
      menuItem(
        "Select all slides in section",
        () => selectSection(k2),
        s2.count === 0
      ),
      menuItem(
        "Move section up",
        () => void moveSectionToGap(k2, k2 - 1),
        !editable || k2 === 0
      ),
      menuItem(
        "Move section down",
        () => void moveSectionToGap(k2, k2 + 2),
        !editable || k2 === n3 - 1
      ),
      menuItem(
        isCollapsed(k2) ? "Expand" : "Collapse",
        () => setCollapsed(k2, !isCollapsed(k2))
      ),
      menuItem("Collapse all", () => setAllCollapsed(true)),
      menuItem("Expand all", () => setAllCollapsed(false)),
      menuItem(
        "Remove section",
        () => void removeSection(k2, false),
        !editable
      ),
      menuItem(
        "Remove section and its slides\u2026",
        () => void removeSection(k2, true),
        !editable || s2.count === 0
      )
    );
    showMenu(x2, y2);
  }
  function sectionHeader(k2, view3, onClick) {
    const s2 = sections()[k2];
    const collapsed2 = isCollapsed(k2);
    const editable = !!ed.model?.deckEditable;
    const name2 = h("span", { class: "section-name" }, s2.name);
    const caret = h(
      "button",
      {
        type: "button",
        class: "section-caret",
        title: collapsed2 ? "Expand section" : "Collapse section",
        "aria-expanded": collapsed2 ? "false" : "true",
        onclick: (e2) => {
          e2.stopPropagation();
          setCollapsed(k2, !collapsed2);
        }
      },
      icon("down", 14)
    );
    const head = h(
      "div",
      {
        class: `section-head ${view3}-section-head${collapsed2 ? " collapsed" : ""}`,
        draggable: editable ? "true" : null,
        "data-section": k2,
        title: `${s2.name}: ${s2.count} slide${s2.count === 1 ? "" : "s"}${editable ? " (drag to move the section, double-click to rename)" : ""}`
      },
      caret,
      name2,
      h(
        "span",
        { class: "section-count" },
        s2.count === 0 ? "empty" : String(s2.count)
      )
    );
    name2.addEventListener("dblclick", (e2) => {
      e2.stopPropagation();
      startRename(k2, name2);
    });
    head.addEventListener("click", (e2) => onClick?.(e2));
    head.addEventListener("contextmenu", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      openSectionMenu(e2.clientX, e2.clientY, k2);
    });
    if (renameNext === k2) {
      renameNext = null;
      queueMicrotask(() => startRename(k2, name2));
    }
    return head;
  }

  // src/ts/editor/comparelib.ts
  function isChange(p2) {
    return p2.status !== "same" || p2.moved;
  }
  function visibleRows(pairs, onlyChanges2) {
    const rows = [];
    pairs.forEach((p2, i2) => {
      if (!onlyChanges2 || isChange(p2)) rows.push(i2);
    });
    return rows;
  }
  function nextChange(pairs, from, dir) {
    for (let i2 = from + dir; i2 >= 0 && i2 < pairs.length; i2 += dir) {
      if (isChange(pairs[i2])) return i2;
    }
    return null;
  }
  function firstRow(pairs) {
    const i2 = pairs.findIndex(isChange);
    return i2 >= 0 ? i2 : 0;
  }
  function focusRow(m2, index) {
    return m2.pairs.findIndex(
      (p2) => p2.right != null && m2.right.slides[p2.right]?.index === index
    );
  }
  function followRow(before, row7, after) {
    const old = before?.pairs[row7];
    if (!before || !old) return firstRow(after.pairs);
    const lid = old.left != null ? before.left.slides[old.left]?.id : null;
    const rid = old.right != null ? before.right.slides[old.right]?.id : null;
    const same = after.pairs.findIndex(
      (p2) => lid != null && p2.left != null && after.left.slides[p2.left]?.id === lid || rid != null && p2.right != null && after.right.slides[p2.right]?.id === rid
    );
    if (same >= 0) return same;
    return Math.min(row7, Math.max(0, after.pairs.length - 1));
  }
  function badge2(p2) {
    if (p2.status === "added")
      return { symbol: "+", cls: "added", title: "Only on the right" };
    if (p2.status === "removed")
      return { symbol: "\u2212", cls: "removed", title: "Only on the left" };
    if (p2.status === "changed")
      return {
        symbol: p2.moved ? "\u2195" : "~",
        cls: p2.moved ? "changed moved" : "changed",
        title: p2.moved ? "Changed and moved" : "Changed"
      };
    if (p2.moved) return { symbol: "\u2195", cls: "moved", title: "Moved" };
    return { symbol: "", cls: "same", title: "The same" };
  }
  function rowSlide(m2, p2) {
    if (p2.right != null) return m2.right.slides[p2.right] ?? null;
    if (p2.left != null) return m2.left.slides[p2.left] ?? null;
    return null;
  }
  function num2(s2) {
    return s2?.number != null ? String(s2.number) : "\xB7";
  }
  function rowNumber(m2, p2) {
    const l2 = p2.left != null ? m2.left.slides[p2.left] : null;
    const r2 = p2.right != null ? m2.right.slides[p2.right] : null;
    if (p2.moved && l2 && r2) return `${num2(l2)} \u2192 ${num2(r2)}`;
    return num2(r2 ?? l2);
  }
  function whatChanged(p2) {
    const parts = p2.files.filter((f2) => f2.role !== "notes").map((f2) => f2.path);
    if (p2.notes || p2.files.some((f2) => f2.role === "notes")) parts.push("notes");
    parts.push(...p2.settings.map((s2) => s2.replace(/_/g, " ")));
    if (!parts.length && p2.visual) parts.push("look");
    return parts;
  }
  function counts(pairs) {
    const c2 = { changed: 0, added: 0, removed: 0, moved: 0, same: 0 };
    for (const p2 of pairs) {
      if (p2.status === "changed") c2.changed++;
      else if (p2.status === "added") c2.added++;
      else if (p2.status === "removed") c2.removed++;
      else if (!p2.moved) c2.same++;
      if (p2.moved) c2.moved++;
    }
    return c2;
  }
  function countText(c2) {
    const parts = [
      c2.changed && `${c2.changed} changed`,
      c2.added && `${c2.added} added`,
      c2.removed && `${c2.removed} removed`,
      c2.moved && `${c2.moved} moved`
    ].filter(Boolean);
    return parts.length ? parts.join(" \xB7 ") : "No differences";
  }
  var MAX_CELLS = 4e6;
  function tokens(text) {
    return text.split(/(\s+)/).filter((t2) => t2 !== "");
  }
  function merge(parts) {
    const out = [];
    for (const p2 of parts) {
      const last = out[out.length - 1];
      if (last && last.kind === p2.kind) last.text += p2.text;
      else out.push({ ...p2 });
    }
    return out;
  }
  function wordDiff(a2, b2) {
    if (a2 === b2) return a2 ? [{ kind: "same", text: a2 }] : [];
    const x2 = tokens(a2);
    const y2 = tokens(b2);
    let start = 0;
    while (start < x2.length && start < y2.length && x2[start] === y2[start])
      start++;
    let endX = x2.length;
    let endY = y2.length;
    while (endX > start && endY > start && x2[endX - 1] === y2[endY - 1]) {
      endX--;
      endY--;
    }
    const head = start ? [{ kind: "same", text: x2.slice(0, start).join("") }] : [];
    const tail = endX < x2.length ? [{ kind: "same", text: x2.slice(endX).join("") }] : [];
    const xs = x2.slice(start, endX);
    const ys = y2.slice(start, endY);
    if (xs.length * ys.length > MAX_CELLS) {
      return merge([
        ...head,
        { kind: "del", text: xs.join("") },
        { kind: "ins", text: ys.join("") },
        ...tail
      ]).filter((p2) => p2.text);
    }
    const n3 = xs.length;
    const m2 = ys.length;
    const table = [];
    for (let i3 = 0; i3 <= n3; i3++) table.push(new Uint32Array(m2 + 1));
    for (let i3 = n3 - 1; i3 >= 0; i3--) {
      for (let j3 = m2 - 1; j3 >= 0; j3--) {
        table[i3][j3] = xs[i3] === ys[j3] ? table[i3 + 1][j3 + 1] + 1 : Math.max(table[i3 + 1][j3], table[i3][j3 + 1]);
      }
    }
    const mid = [];
    let i2 = 0;
    let j2 = 0;
    while (i2 < n3 && j2 < m2) {
      if (xs[i2] === ys[j2]) {
        mid.push({ kind: "same", text: xs[i2] });
        i2++;
        j2++;
      } else if (table[i2 + 1][j2] >= table[i2][j2 + 1]) {
        mid.push({ kind: "del", text: xs[i2++] });
      } else {
        mid.push({ kind: "ins", text: ys[j2++] });
      }
    }
    while (i2 < n3) mid.push({ kind: "del", text: xs[i2++] });
    while (j2 < m2) mid.push({ kind: "ins", text: ys[j2++] });
    return merge([...head, ...mid, ...tail]);
  }
  function takeState(m2, row7) {
    const p2 = m2.pairs[row7];
    const liveLeft = m2.left.live && !m2.right.live;
    const liveRight = m2.right.live && !m2.left.live;
    if (!p2 || !(liveLeft || liveRight)) {
      return {
        enabled: false,
        title: "One side must be the working copy to take a slide into it",
        replace: false
      };
    }
    const other = liveLeft ? m2.right : m2.left;
    const theirs = liveLeft ? p2.right : p2.left;
    const mine = liveLeft ? p2.left : p2.right;
    if (theirs == null) {
      return {
        enabled: false,
        title: `This slide is not in ${other.label}`,
        replace: false
      };
    }
    if (p2.status === "same") {
      return {
        enabled: false,
        title: "Both versions are the same",
        replace: true
      };
    }
    return {
      enabled: true,
      title: mine == null ? `Insert ${other.label}'s slide into the working copy` : `Replace the working copy's slide with ${other.label}'s version (Ctrl+Z undoes it)`,
      replace: mine != null
    };
  }
  function mergeTarget(m2) {
    if (m2.left.live && !m2.right.live) return m2.right.branch;
    if (m2.right.live && !m2.left.live) return m2.left.branch;
    return null;
  }
  async function mergeBranch(branch, send2) {
    const res = await send2({ action: "worktree", op: "merge", branch });
    if (!res.ok) {
      return {
        ok: false,
        error: String(res.error ?? `could not merge ${branch}`)
      };
    }
    return {
      ok: true,
      historyCleared: res.historyCleared === true,
      message: typeof res.message === "string" ? res.message : `Merged ${branch} into the working copy`
    };
  }
  function swapSources(m2) {
    return [m2.right.source, m2.left.source];
  }
  function newFontRules(fonts, present2) {
    const rules = fonts.match(/@font-face\s*\{[^{}]*\}/g) ?? [];
    return rules.filter((r2) => !present2.includes(r2)).join("\n");
  }
  function toSlideBox(r2, slide, vb) {
    if (!slide.width || !slide.height || !r2.width && !r2.height) return null;
    const sx = vb.w / slide.width;
    const sy = vb.h / slide.height;
    return [
      vb.x + (r2.left - slide.left) * sx,
      vb.y + (r2.top - slide.top) * sy,
      r2.width * sx,
      r2.height * sy
    ];
  }

  // src/ts/editor/gitnotice.ts
  var NOTICE_KEY = "inkflow-git-undo-notice";
  var noticeShown = false;
  function undoNoticeDue() {
    try {
      return sessionStorage.getItem(NOTICE_KEY) !== "1" && !noticeShown;
    } catch {
      return !noticeShown;
    }
  }
  function undoNoticeShown() {
    noticeShown = true;
    try {
      sessionStorage.setItem(NOTICE_KEY, "1");
    } catch {
    }
  }
  var UNDO_NOTICE = "Note: git changes the deck's files on disk, so the editor's undo and redo history is cleared afterwards (Ctrl+Z cannot go back past this point). You are told this once per session.";

  // src/ts/editor/compare.ts
  var view = document.getElementById("compare-view");
  var model = null;
  var viewId = 0;
  var open2 = null;
  var row4 = 0;
  var focus = null;
  var onlyChanges = readPref("inkflow-compare-only", "0") === "1";
  var mode = readPref("inkflow-compare-mode", "side") || "side";
  var outlines = readPref("inkflow-compare-outlines", "1") === "1";
  var wipe = 50;
  var error = null;
  function readPref(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function writePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  }
  function openCompare(left, right, opts2 = {}) {
    viewId += 1;
    open2 = [left, right];
    focus = opts2.focus ?? null;
    error = null;
    if (!model) {
      view.hidden = false;
      document.body.classList.add("compare-mode");
      renderLoading("Building both versions\u2026");
    } else {
      view.classList.add("busy");
    }
    view.focus();
    void whenConnected().then(
      () => sendRaw({ type: "compare-open", view: viewId, left, right })
    );
  }
  function closeCompare() {
    if (view.hidden) return;
    sendRaw({ type: "compare-close" });
    model = null;
    open2 = null;
    view.hidden = true;
    view.classList.remove("busy");
    clear(view);
    document.body.classList.remove("compare-mode");
    document.getElementById("cmp-fonts")?.remove();
    emit("slide");
  }
  function renderLoading(text) {
    clear(view);
    view.append(
      h(
        "div",
        { class: "cmp-head" },
        h("strong", { class: "cmp-title" }, "Compare"),
        h("span", { class: "cmp-spacer" }),
        closeButton()
      ),
      h("div", { class: "cmp-loading" }, text)
    );
  }
  function closeButton() {
    return h(
      "button",
      {
        type: "button",
        class: "pbtn",
        title: "Back to editing (Esc)",
        onclick: () => closeCompare()
      },
      "Close"
    );
  }
  var BASE_CSS = `
:host { display: block; position: relative; }
.cmp-root {
    all: initial;
    display: block;
    width: 100%;
    height: 100%;
    /* A slide's text that names no font: the deck's body font, as on a slide. */
    font-family: var(--inkflow-body-font);
}
.cmp-root > svg { display: block; width: 100%; height: 100%; }
`;
  var baseSheet = null;
  var sideSheets = /* @__PURE__ */ new Map();
  function sheets(side) {
    if (!baseSheet) {
      baseSheet = new CSSStyleSheet();
      baseSheet.replaceSync(BASE_CSS);
    }
    let entry = sideSheets.get(side.token);
    if (!entry || entry.css !== side.css) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(side.css);
      entry = { css: side.css, sheet };
      sideSheets.set(side.token, entry);
    }
    return [baseSheet, entry.sheet];
  }
  function addFonts(side) {
    if (!side.fonts) return;
    let style = document.getElementById("cmp-fonts");
    if (!style) {
      style = h("style", { id: "cmp-fonts" });
      document.head.append(style);
    }
    const present2 = (document.getElementById("deck-styles")?.textContent ?? "") + style.textContent;
    const rules = newFontRules(side.fonts, present2);
    if (rules) style.textContent += `
${rules}`;
  }
  function slideView(side, slide, cls) {
    const host5 = h("div", {
      class: `cmp-slide ${cls}`
    });
    if (!slide?.svg) {
      host5.classList.add("empty");
      host5.textContent = slide ? "hidden slide" : `not in ${side.label || "this version"}`;
      return host5;
    }
    const root2 = host5.attachShadow({ mode: "open" });
    root2.adoptedStyleSheets = sheets(side);
    const wrap2 = document.createElement("div");
    wrap2.className = "cmp-root";
    if (document.documentElement.dataset.theme === "light") {
      wrap2.dataset.theme = "light";
    }
    wrap2.innerHTML = slide.svg;
    const svg = wrap2.querySelector("svg");
    if (svg) {
      const vb = parseViewBox(svg.getAttribute("viewBox"));
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      host5.style.aspectRatio = `${vb.w} / ${vb.h}`;
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
      });
      svg.querySelectorAll("video").forEach((v2) => {
        v2.removeAttribute("autoplay");
        v2.removeAttribute("controls");
      });
      scheduleFit(svg);
      host5.svg = svg;
    }
    root2.append(wrap2);
    return host5;
  }
  var thumbs2 = /* @__PURE__ */ new Map();
  function thumb2(side, index) {
    const slide = index != null ? side.slides[index] ?? null : null;
    if (!slide) return h("div", { class: "cmp-thumb none" });
    const key = `${side.token}\0${slide.svg ?? `hidden:${slide.id}`}`;
    const cached = thumbs2.get(key);
    if (cached && !cached.isConnected) return cached;
    const el2 = slideView(side, slide, "cmp-thumb");
    thumbs2.set(key, el2);
    return el2;
  }
  function onModel(msg) {
    if (msg.view !== viewId || view.hidden) return;
    const next = msg;
    const before = model;
    row4 = before ? followRow(before, row4, next) : firstRow(next.pairs);
    if (focus != null) {
      const at3 = focusRow(next, focus);
      if (at3 >= 0) row4 = at3;
      focus = null;
    }
    model = next;
    view.classList.remove("busy");
    const tokens2 = /* @__PURE__ */ new Set([next.left.token, next.right.token]);
    for (const key of [...thumbs2.keys()]) {
      if (!tokens2.has(key.split("\0")[0])) thumbs2.delete(key);
    }
    addFonts(next.left);
    addFonts(next.right);
    render2();
  }
  function onError(msg) {
    if (msg.for !== "compare-open" || msg.view !== viewId) return;
    error = String(msg.message ?? "could not compare");
    view.classList.remove("busy");
    if (!model) {
      renderLoading(`Cannot compare: ${error}`);
      view.querySelector(".cmp-loading")?.classList.add("error");
    } else {
      toast(`Cannot compare: ${error}`, "error");
    }
  }
  var listEl = null;
  var mainEl = null;
  function render2() {
    if (!model) return;
    const m2 = model;
    clear(view);
    const c2 = counts(m2.pairs);
    const merge2 = mergeTarget(m2);
    const only = h("input", { type: "checkbox" });
    only.checked = onlyChanges;
    only.addEventListener("change", () => {
      onlyChanges = only.checked;
      writePref("inkflow-compare-only", onlyChanges ? "1" : "0");
      renderList3();
    });
    const head = h(
      "div",
      { class: "cmp-head" },
      h("strong", { class: "cmp-title" }, "Compare"),
      sideChip(m2.left, "left"),
      h(
        "button",
        {
          type: "button",
          class: "tb-btn cmp-swap",
          title: "Swap the two sides",
          onclick: () => {
            const [l2, r2] = swapSources(m2);
            openCompare(l2, r2);
          }
        },
        "\u21C4"
      ),
      sideChip(m2.right, "right"),
      h("span", { class: "cmp-counts" }, countText(c2)),
      m2.deck.length ? h(
        "span",
        {
          class: "cmp-deckdiff",
          title: "Deck-wide settings that differ"
        },
        `Deck: ${m2.deck.map((s2) => s2.replace(/_/g, " ")).join(", ")}`
      ) : null,
      h("span", { class: "cmp-spacer" }),
      h("label", { class: "cmp-only" }, only, "Only changes"),
      h(
        "button",
        {
          type: "button",
          class: "tb-btn",
          title: "Previous change (P)",
          onclick: () => jump(-1)
        },
        "\u2191"
      ),
      h(
        "button",
        {
          type: "button",
          class: "tb-btn",
          title: "Next change (N)",
          onclick: () => jump(1)
        },
        "\u2193"
      ),
      merge2 ? h(
        "button",
        {
          type: "button",
          class: "pbtn",
          title: `Merge ${merge2} into the working copy's branch`,
          onclick: () => void merging(merge2)
        },
        "Merge branch"
      ) : null,
      closeButton()
    );
    listEl = h("div", { class: "cmp-list", role: "listbox" });
    mainEl = h("div", { class: "cmp-main" });
    view.append(head, h("div", { class: "cmp-body" }, listEl, mainEl));
    renderList3();
    renderMain();
  }
  function sideChip(side, which) {
    const kind = side.kind === "live" ? "working copy" : side.kind === "commit" ? "commit" : "folder";
    const notes = [
      side.error ? `does not build: ${side.error}` : "",
      side.missing.length ? `${side.missing.length} Git LFS file(s) missing` : ""
    ].filter(Boolean);
    return h(
      "button",
      {
        type: "button",
        class: `cmp-chip ${which}${side.error ? " error" : ""}`,
        title: [
          side.deckPath,
          ...notes,
          "Click to show something else on this side"
        ].join("\n"),
        onclick: () => void openComparePicker(which)
      },
      h("span", { class: "cmp-chip-kind" }, which === "left" ? "L" : "R"),
      side.label,
      side.kind !== "live" && side.kind !== "commit" ? h("span", { class: "hint" }, ` (${kind})`) : null,
      notes.length ? h("span", { class: "cmp-warn" }, " \u26A0") : null
    );
  }
  function renderList3() {
    if (!model || !listEl) return;
    const m2 = model;
    clear(listEl);
    const rows = visibleRows(m2.pairs, onlyChanges);
    const broken = [m2.left, m2.right].filter((s2) => s2.error);
    for (const s2 of broken) {
      listEl.append(
        h(
          "div",
          { class: "cmp-empty error" },
          `${s2.label} does not build: ${s2.error}`
        )
      );
    }
    if (!rows.length && !broken.length) {
      listEl.append(h("div", { class: "cmp-empty" }, "No differences"));
    }
    for (const i2 of rows) {
      const p2 = m2.pairs[i2];
      const b2 = badge2(p2);
      const slide = rowSlide(m2, p2);
      listEl.append(
        h(
          "div",
          {
            class: `cmp-row s-${b2.cls.replace(/ /g, " s-")}${i2 === row4 ? " active" : ""}`,
            role: "option",
            "data-row": i2,
            title: `${b2.title}${p2.status === "changed" ? `: ${whatChanged(p2).join(", ")}` : ""}`,
            onclick: () => selectRow(i2)
          },
          h(
            "div",
            { class: "cmp-row-head" },
            h("span", { class: "cmp-num" }, rowNumber(m2, p2)),
            h("span", { class: "cmp-id" }, slide?.id ?? ""),
            b2.symbol ? h("span", { class: `cmp-badge ${b2.cls}` }, b2.symbol) : null
          ),
          h(
            "div",
            { class: "cmp-row-thumbs" },
            thumb2(m2.left, p2.left),
            thumb2(m2.right, p2.right)
          )
        )
      );
    }
    revealRow();
  }
  function revealRow() {
    const el2 = listEl?.querySelector(".cmp-row.active");
    if (!listEl || !el2) return;
    const top = el2.offsetTop;
    if (top < listEl.scrollTop) listEl.scrollTop = top - 8;
    else if (top + el2.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
      listEl.scrollTop = top + el2.offsetHeight - listEl.clientHeight + 8;
    }
  }
  function selectRow(i2) {
    if (!model || i2 < 0 || i2 >= model.pairs.length) return;
    row4 = i2;
    listEl?.querySelectorAll(".cmp-row").forEach((el2) => {
      el2.classList.toggle(
        "active",
        Number(el2.getAttribute("data-row")) === i2
      );
    });
    revealRow();
    renderMain();
  }
  function jump(dir) {
    if (!model) return;
    const next = nextChange(model.pairs, row4, dir);
    if (next == null) {
      toast(dir > 0 ? "No more changes below" : "No more changes above");
      return;
    }
    if (onlyChanges || isChange(model.pairs[next])) selectRow(next);
  }
  function step(dir) {
    if (!model) return;
    const rows = visibleRows(model.pairs, onlyChanges);
    const at3 = rows.indexOf(row4);
    const next = rows[at3 < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at3 + dir))];
    if (next != null) selectRow(next);
  }
  function renderMain() {
    if (!model || !mainEl) return;
    const m2 = model;
    clear(mainEl);
    const p2 = m2.pairs[row4];
    if (!p2) {
      mainEl.append(h("div", { class: "cmp-empty" }, "Nothing to compare"));
      return;
    }
    const left = p2.left != null ? m2.left.slides[p2.left] ?? null : null;
    const right = p2.right != null ? m2.right.slides[p2.right] ?? null : null;
    const modes = h(
      "div",
      { class: "cmp-modes", role: "tablist" },
      ...[
        ["side", "Side by side", "1"],
        ["slider", "Slider", "2"],
        ["diff", "Difference", "3"]
      ].map(
        ([id, label4, key]) => h(
          "button",
          {
            type: "button",
            class: `seg${mode === id ? " on" : ""}`,
            title: `${label4} (${key})`,
            onclick: () => setMode(id)
          },
          label4
        )
      )
    );
    const outlineBox = h("input", { type: "checkbox" });
    outlineBox.checked = outlines;
    outlineBox.addEventListener("change", () => {
      outlines = outlineBox.checked;
      writePref("inkflow-compare-outlines", outlines ? "1" : "0");
      renderMain();
    });
    const bar = h(
      "div",
      { class: "cmp-stagebar" },
      modes,
      h(
        "label",
        { class: "cmp-only", title: "Outline what changed (O)" },
        outlineBox,
        "Outline changes"
      ),
      h("span", { class: "cmp-spacer" }),
      h(
        "span",
        { class: "cmp-legend" },
        h("i", { class: "lg changed" }),
        "changed ",
        h("i", { class: "lg added" }),
        "added ",
        h("i", { class: "lg removed" }),
        "removed"
      )
    );
    const stage = h("div", { class: `cmp-stage mode-${mode}` });
    const both = left?.svg && right?.svg;
    if (mode === "side" || !both) {
      stage.classList.add("mode-side");
      stage.append(
        pane(m2.left, left, p2, "left", rowNumberOf(left)),
        pane(m2.right, right, p2, "right", rowNumberOf(right))
      );
    } else {
      stage.append(stacked(m2, left, right, p2));
    }
    mainEl.append(bar, stage, info(m2, p2, left, right));
  }
  function rowNumberOf(s2) {
    if (!s2) return "";
    return `${s2.number != null ? `${s2.number} \xB7 ` : "hidden \xB7 "}${s2.id}`;
  }
  function setMode(next) {
    mode = next;
    writePref("inkflow-compare-mode", mode);
    renderMain();
  }
  function pane(side, slide, p2, which, caption) {
    const frame = h("div", { class: "cmp-frame" });
    const sv = slideView(side, slide, "cmp-big");
    frame.append(sv);
    if (outlines && sv.svg) {
      const marks = p2.elements.filter(
        (e2) => which === "left" ? e2.left : e2.right
      );
      afterLayout(() => drawOutlines(frame, sv.svg, marks, which));
    }
    return h(
      "div",
      { class: `cmp-pane ${which}` },
      h(
        "div",
        { class: "cmp-pane-label" },
        h("span", { class: "cmp-chip-kind" }, which === "left" ? "L" : "R"),
        side.label,
        caption ? h("span", { class: "hint" }, `  ${caption}`) : null
      ),
      frame
    );
  }
  function stacked(m2, left, right, p2) {
    const frame = h("div", { class: "cmp-frame stacked" });
    const a2 = slideView(m2.left, left, "cmp-big under");
    const b2 = slideView(m2.right, right, "cmp-big over");
    frame.append(a2, b2);
    if (mode === "slider") {
      const handle2 = h("div", { class: "cmp-handle" });
      const place = () => {
        b2.style.clipPath = `inset(0 0 0 ${wipe}%)`;
        handle2.style.left = `${wipe}%`;
      };
      place();
      frame.append(handle2);
      const move = (e2) => {
        const r2 = frame.getBoundingClientRect();
        wipe = Math.max(
          0,
          Math.min(100, (e2.clientX - r2.left) / r2.width * 100)
        );
        place();
      };
      frame.addEventListener("pointerdown", (e2) => {
        frame.setPointerCapture(e2.pointerId);
        move(e2);
        frame.addEventListener("pointermove", move);
      });
      frame.addEventListener(
        "pointerup",
        () => frame.removeEventListener("pointermove", move)
      );
    }
    if (outlines && b2.svg) {
      const marks = p2.elements;
      afterLayout(() => {
        if (b2.svg) drawOutlines(frame, b2.svg, marks, "right", a2.svg);
      });
    }
    const caption = mode === "slider" ? h(
      "div",
      { class: "cmp-pane-label" },
      h("span", { class: "cmp-chip-kind" }, "L"),
      `${m2.left.label}  \u25C0 drag \u25B6  `,
      h("span", { class: "cmp-chip-kind" }, "R"),
      m2.right.label
    ) : h(
      "div",
      { class: "cmp-pane-label" },
      "Difference: what is the same turns black, what differs lights up"
    );
    return h("div", { class: "cmp-pane wide" }, caption, frame);
  }
  function afterLayout(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }
  function locate(svg, loc) {
    let el2 = svg;
    for (const i2 of loc.path) {
      el2 = el2?.children[i2] ?? null;
      if (!el2) break;
    }
    if (el2 && el2 !== svg && el2.localName.toLowerCase() === loc.tag.toLowerCase()) {
      const box2 = toSlideBox(
        el2.getBoundingClientRect(),
        svg.getBoundingClientRect(),
        parseViewBox(svg.getAttribute("viewBox"))
      );
      if (box2 && box2[2] > 0 && box2[3] > 0) return box2;
    }
    return loc.box;
  }
  var SVG_NS2 = "http://www.w3.org/2000/svg";
  function drawOutlines(frame, svg, marks, which, leftSvg) {
    if (!frame.isConnected || !marks.length) return;
    const vb = parseViewBox(svg.getAttribute("viewBox"));
    const layer2 = document.createElementNS(SVG_NS2, "svg");
    layer2.setAttribute("class", "cmp-outlines");
    layer2.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    layer2.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const pad2 = Math.max(vb.w, vb.h) / 240;
    const draw = (target, loc, cls, label4) => {
      const box2 = loc ? locate(target, loc) : null;
      if (!box2) return;
      const rect = document.createElementNS(SVG_NS2, "rect");
      rect.setAttribute("x", String(box2[0] - pad2));
      rect.setAttribute("y", String(box2[1] - pad2));
      rect.setAttribute("width", String(box2[2] + 2 * pad2));
      rect.setAttribute("height", String(box2[3] + 2 * pad2));
      rect.setAttribute("rx", String(pad2));
      rect.setAttribute("class", `mark ${cls}`);
      const title3 = document.createElementNS(SVG_NS2, "title");
      title3.textContent = label4;
      rect.append(title3);
      layer2.append(rect);
    };
    for (const mark of marks) {
      const label4 = `${mark.change}${mark.id ? ` #${mark.id}` : ""}${mark.text ? `: ${mark.text}` : ""}`;
      if (leftSvg) {
        if (mark.left && mark.change !== "added") {
          draw(
            leftSvg,
            mark.left,
            `${mark.change} before`,
            `${label4} (left)`
          );
        }
        if (mark.right) draw(svg, mark.right, mark.change, label4);
        continue;
      }
      draw(
        svg,
        which === "left" ? mark.left : mark.right,
        mark.change,
        label4
      );
    }
    frame.append(layer2);
  }
  function info(m2, p2, left, right) {
    const b2 = badge2(p2);
    const take2 = takeState(m2, row4);
    const what = p2.status === "changed" ? whatChanged(p2) : [];
    const summary2 = p2.status === "added" ? `Only in ${m2.right.label}` : p2.status === "removed" ? `Only in ${m2.left.label}` : p2.status === "same" ? p2.moved ? "The same slide, moved" : "No differences" : `${p2.moved ? "Moved, and changed: " : "Changed: "}${what.join(", ")}`;
    const box2 = h(
      "div",
      { class: "cmp-info" },
      h(
        "div",
        { class: "cmp-info-head" },
        b2.symbol ? h("span", { class: `cmp-badge ${b2.cls}` }, b2.symbol) : null,
        h("strong", {}, summary2),
        h("span", { class: "cmp-spacer" }),
        h(
          "button",
          {
            type: "button",
            class: "pbtn primary",
            disabled: !take2.enabled,
            title: take2.title,
            onclick: () => void taking()
          },
          "Take this slide"
        )
      )
    );
    if (p2.files.length) {
      box2.append(
        h("h4", {}, "Files"),
        h(
          "div",
          { class: "cmp-files" },
          ...p2.files.map(
            (f2) => h(
              "div",
              { class: "cmp-file" },
              h("span", { class: `cmp-fstat ${f2.change}` }, f2.change),
              h("code", {}, f2.path),
              h("span", { class: "hint" }, f2.role)
            )
          )
        )
      );
    }
    if (p2.settings.length) {
      box2.append(
        h("h4", {}, "In deck.py"),
        h(
          "div",
          { class: "cmp-settings" },
          p2.settings.map((s2) => s2.replace(/_/g, " ")).join(", ")
        )
      );
    }
    if (p2.elements.length) {
      const n3 = (k2) => p2.elements.filter((e2) => e2.change === k2).length;
      box2.append(
        h(
          "div",
          { class: "hint cmp-elcount" },
          `Elements: ${n3("changed")} changed, ${n3("added")} added, ${n3("removed")} removed`
        )
      );
    }
    if (left || right) {
      const a2 = left?.notes ?? "";
      const bText = right?.notes ?? "";
      const parts = wordDiff(a2, bText);
      box2.append(
        h("h4", {}, p2.notes ? "Speaker notes (changed)" : "Speaker notes"),
        parts.length ? h(
          "div",
          { class: "cmp-notes" },
          ...parts.map(
            (part) => part.kind === "same" ? document.createTextNode(part.text) : h(part.kind, {}, part.text)
          )
        ) : h("div", { class: "hint" }, "No notes")
      );
    }
    return box2;
  }
  async function taking() {
    if (!model) return;
    const m2 = model;
    const p2 = m2.pairs[row4];
    const state = takeState(m2, row4);
    if (!p2 || !state.enabled) return;
    const other = m2.left.live ? m2.right : m2.left;
    const files2 = p2.files.map((f2) => `  ${f2.path}`).join("\n");
    const question = state.replace ? `Replace this slide in the working copy with ${other.label}'s version?${files2 ? `

Files written:
${files2}` : ""}

Ctrl+Z takes it back.` : `Insert ${other.label}'s slide into the working copy?`;
    if (!confirm(question)) return;
    const res = await edit({
      action: "compare-take",
      pair: row4,
      left: p2.left,
      right: p2.right
    });
    if (res.ok) {
      const stepNo = res.step;
      toast(String(res.label ?? "Took the slide"), "ok", {
        label: "Undo",
        run: () => void edit({
          action: "undo",
          ...typeof stepNo === "number" ? { step: stepNo } : {}
        })
      });
    }
  }
  async function merging(branch) {
    const notice = undoNoticeDue();
    const question = `Merge ${branch} into the working copy's branch? Commit or discard your own changes first; git refuses a merge that would overwrite them.`;
    if (!confirm(notice ? `${question}

${UNDO_NOTICE}` : question)) {
      return;
    }
    if (notice) undoNoticeShown();
    view.classList.add("busy");
    const res = await mergeBranch(branch, request);
    view.classList.remove("busy");
    if (!res.ok) {
      toast(res.error ?? `Could not merge ${branch}`, "error");
      return;
    }
    if (res.historyCleared) {
      ed.canUndo = false;
      ed.canRedo = false;
      emit("history");
    }
    toast(res.message ?? `Merged ${branch}`, "ok");
  }
  var sourcesWaiting = null;
  function fetchSources() {
    return new Promise((resolve) => {
      sourcesWaiting = resolve;
      sendRaw({ type: "compare-sources" });
    });
  }
  var LIVE = { kind: "live" };
  async function openComparePicker(side = null) {
    await whenConnected();
    const data = await fetchSources();
    const current3 = model;
    const pick2 = (chosen) => {
      closeDialog();
      if (side && current3) {
        const [l2, r2] = [current3.left.source, current3.right.source];
        openCompare(
          side === "left" ? chosen : l2,
          side === "right" ? chosen : r2
        );
      } else {
        openCompare(LIVE, chosen);
      }
    };
    const sections2 = [];
    if (side) {
      sections2.push(
        h(
          "div",
          { class: "btn-row" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => pick2(LIVE)
            },
            "The working copy"
          )
        )
      );
    }
    if (data.repo) {
      const rev = h("input", {
        type: "text",
        placeholder: "HEAD~2, a tag, a sha\u2026",
        spellcheck: "false"
      });
      const go = () => {
        if (rev.value.trim())
          pick2({ kind: "commit", rev: rev.value.trim() });
      };
      rev.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter") {
          e2.preventDefault();
          go();
        }
      });
      const others2 = (data.worktrees ?? []).filter(
        (w2) => !w2.current && w2.deck
      );
      const inTree = new Set(others2.map((w2) => w2.branch));
      const branches = (data.branches ?? []).filter(
        (b2) => b2 !== data.branch && !inTree.has(b2)
      );
      if (others2.length || branches.length) {
        sections2.push(
          h("h3", {}, "A branch or worktree"),
          h(
            "div",
            { class: "git-list" },
            ...others2.map(
              (w2) => h(
                "div",
                { class: "git-row" },
                h(
                  "div",
                  { class: "git-commit" },
                  h("strong", {}, w2.branch ?? "(detached)"),
                  h(
                    "span",
                    { class: "hint" },
                    `worktree \xB7 ${w2.path}`
                  )
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    onclick: () => pick2({
                      kind: "path",
                      deck: w2.deck,
                      ...w2.branch ? { label: w2.branch } : {}
                    })
                  },
                  "Compare"
                )
              )
            ),
            ...branches.map(
              (b2) => h(
                "div",
                { class: "git-row" },
                h(
                  "div",
                  { class: "git-commit" },
                  h("strong", {}, b2),
                  h("span", { class: "hint" }, "branch")
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    onclick: () => pick2({ kind: "branch", name: b2 })
                  },
                  "Compare"
                )
              )
            )
          )
        );
      }
      sections2.push(
        h("h3", {}, "A commit"),
        h(
          "div",
          { class: "git-list history cmp-commits" },
          ...(data.commits ?? []).map(
            (c2) => h(
              "div",
              { class: `git-row${c2.head ? " current" : ""}` },
              h(
                "div",
                { class: "git-commit" },
                h("strong", {}, c2.subject),
                h(
                  "span",
                  { class: "hint" },
                  `${c2.short} \xB7 ${c2.author} \xB7 ${c2.when}${c2.refs.length ? ` \xB7 ${c2.refs.join(", ")}` : ""}`
                )
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "pbtn",
                  onclick: () => pick2({ kind: "commit", rev: c2.sha })
                },
                "Compare"
              )
            )
          )
        ),
        h(
          "div",
          { class: "btn-row" },
          rev,
          h(
            "button",
            { type: "button", class: "pbtn", onclick: go },
            "Compare"
          )
        )
      );
    }
    const folderBtn = h(
      "button",
      { type: "button", class: "pbtn primary", disabled: true },
      "Compare with this deck"
    );
    const start = (ed.model?.projectDir ?? "").replace(/[\\/][^\\/]*$/, "");
    const picker = folderPicker(start, (f2) => {
      folderBtn.disabled = !f2.isDeck;
      folderBtn.textContent = f2.isDeck ? "Compare with this deck" : "No deck.py in this folder";
    });
    folderBtn.addEventListener("click", () => {
      const f2 = picker.current();
      if (f2?.isDeck)
        pick2({ kind: "path", deck: joinPath(f2.path, "deck.py") });
    });
    sections2.push(
      h("h3", {}, "Another deck folder"),
      picker.el,
      h("div", { class: "btn-row end" }, folderBtn)
    );
    openDialog(
      side ? `Show on the ${side}\u2026` : "Compare the working copy with\u2026",
      h("div", { class: "git-form cmp-picker" }, ...sections2),
      { large: true }
    );
  }
  function onKey(e2) {
    if (view.hidden) return;
    const target = e2.target;
    const typing = target.closest(
      "input:not([type=checkbox]):not([type=radio]), textarea, select, #dialog"
    );
    if (dialogOpen() || typing) {
      return;
    }
    const mod = e2.ctrlKey || e2.metaKey;
    if (mod && ["z", "y"].includes(e2.key.toLowerCase())) return;
    const handled = () => {
      e2.preventDefault();
      e2.stopPropagation();
    };
    switch (e2.key) {
      case "Escape":
        handled();
        closeCompare();
        return;
      case "ArrowDown":
        handled();
        step(1);
        return;
      case "ArrowUp":
        handled();
        step(-1);
        return;
      case "n":
      case "N":
        handled();
        jump(1);
        return;
      case "p":
      case "P":
        handled();
        jump(-1);
        return;
      case "1":
        handled();
        setMode("side");
        return;
      case "2":
        handled();
        setMode("slider");
        return;
      case "3":
        handled();
        setMode("diff");
        return;
      case "o":
      case "O":
        handled();
        outlines = !outlines;
        writePref("inkflow-compare-outlines", outlines ? "1" : "0");
        renderMain();
        return;
    }
    e2.stopPropagation();
  }
  function initCompare() {
    onMessage("compare-model", onModel);
    onMessage("compare-error", (msg) => {
      if (msg.for === "compare-sources") {
        toast(String(msg.message ?? "cannot list versions"), "error");
        sourcesWaiting?.({ repo: false });
        sourcesWaiting = null;
        return;
      }
      onError(msg);
    });
    onMessage("compare-sources", (msg) => {
      sourcesWaiting?.(msg);
      sourcesWaiting = null;
    });
    onConnect(() => {
      if (open2 && !view.hidden) {
        viewId += 1;
        sendRaw({
          type: "compare-open",
          view: viewId,
          left: open2[0],
          right: open2[1]
        });
      }
    });
    document.addEventListener("keydown", onKey, true);
    new MutationObserver(() => {
      if (!model || view.hidden) return;
      thumbs2.clear();
      render2();
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"]
    });
    document.addEventListener("inkflow:compare", (e2) => {
      const detail = e2.detail;
      if (!detail?.deck) return;
      openCompare(LIVE, {
        kind: detail.kind ?? "path",
        deck: detail.deck,
        ...detail.label ? { label: detail.label } : {}
      });
    });
    const params = new URLSearchParams(location.search);
    const spec = params.get("compare");
    if (spec) {
      params.delete("compare");
      const query2 = params.toString();
      try {
        history.replaceState(
          null,
          "",
          `${location.pathname}${query2 ? `?${query2}` : ""}${location.hash}`
        );
      } catch {
      }
      openCompare(LIVE, { kind: "spec", spec });
    }
  }

  // src/ts/editor/packtext.ts
  function missingLines(summary2) {
    return summary2.items.filter((i2) => i2.fixable).map((i2) => i2.message);
  }
  function consequences(summary2) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const item2 of summary2.items.filter((i2) => i2.fixable)) {
      const line = sentence(item2.consequence);
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
    return out;
  }
  function remainingLines(items2) {
    return items2.filter((i2) => !i2.fixable).map((i2) => sentence(i2.message));
  }
  function withoutPackingTitle(summary2) {
    const all = consequences(summary2);
    if (!all.length) return "Commit as it is";
    const more = all.length > 1 ? ` (and ${all.length - 1} more)` : "";
    return `Not recommended: ${all[0]}${more}`;
  }
  function sentence(text) {
    const t2 = text.trim();
    if (!t2) return t2;
    const first = t2[0].toUpperCase() + t2.slice(1);
    return /[.!?]$/.test(first) ? first : `${first}.`;
  }
  function commitPaths(ticked, packed) {
    return [.../* @__PURE__ */ new Set([...ticked, ...packed])];
  }

  // src/ts/editor/pack.ts
  var PACK_HELP = "Make the deck self-contained: fonts, outside files, lock file, git rules \u2014 so it looks the same on every machine";
  async function packCheck() {
    const res = await request({ action: "pack", op: "check" });
    return res.ok ? res.pack : null;
  }
  async function applyPack() {
    const res = await edit({ action: "pack", op: "apply" });
    if (!res.ok) return null;
    const lock = res.lock;
    if (typeof lock === "string" && !lock.startsWith("uv.lock written")) {
      toast(lock, "info");
    }
    const changes2 = res.changes ?? [];
    return {
      gitPaths: res.gitPaths ?? [],
      changed: changes2.map((c2) => `${c2.change}: ${c2.path}`),
      remaining: res.remaining ?? []
    };
  }
  function list(lines, cls = "pack-list") {
    return h("ul", { class: cls }, ...lines.map((l2) => h("li", {}, l2)));
  }
  function commitGate(summary2, packAndCommit, commitAnyway) {
    const remaining = remainingLines(summary2.items);
    const busy = (b2) => {
      for (const btn of box2.querySelectorAll("button"))
        btn.disabled = b2;
    };
    const primary = h(
      "button",
      {
        type: "button",
        class: "pbtn primary",
        "data-pack": "pack-and-commit",
        onclick: async () => {
          busy(true);
          await packAndCommit();
          busy(false);
        }
      },
      "Pack and commit"
    );
    const box2 = openDialog(
      "Commit: pack the deck first?",
      h(
        "div",
        { class: "git-form pack-gate" },
        h(
          "p",
          {},
          "This deck depends on this computer, so it will not look the same elsewhere:"
        ),
        list(missingLines(summary2)),
        h(
          "p",
          { class: "hint" },
          "Packing copies what is missing into the deck and adds the files it writes to this commit."
        ),
        h(
          "div",
          { class: "pack-without" },
          h(
            "p",
            { class: "hint warn" },
            "Without packing, on other machines:"
          ),
          list(consequences(summary2), "pack-list warn")
        ),
        remaining.length ? h(
          "details",
          { class: "pack-remaining" },
          h("summary", {}, "Packing cannot change"),
          list(remaining)
        ) : null,
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              "data-pack": "commit-anyway",
              title: withoutPackingTitle(summary2),
              onclick: async () => {
                busy(true);
                await commitAnyway();
                busy(false);
              }
            },
            "Commit without packing (not recommended)"
          ),
          primary
        )
      ),
      { wide: true }
    );
    primary.focus();
  }
  async function openPackDialog() {
    const body3 = h(
      "div",
      { class: "git-form pack-dialog" },
      h("p", { class: "hint" }, "Checking the deck\u2026")
    );
    openDialog("Pack deck", body3, { wide: true, hint: PACK_HELP });
    const res = await request({ action: "pack", op: "plan" });
    if (!body3.isConnected) return;
    body3.replaceChildren();
    if (!res.ok) {
      body3.append(h("p", { class: "hint warn" }, res.error ?? "cannot pack"));
      return;
    }
    const summary2 = res.pack;
    const remaining = remainingLines(summary2.items);
    const copies = summary2.assets?.copies ?? [];
    const warnings2 = summary2.fonts?.warnings ?? [];
    if (!summary2.steps.length) {
      body3.append(
        h(
          "p",
          {},
          "Nothing to pack: everything this deck needs is in its folder."
        )
      );
    } else {
      body3.append(h("p", {}, "Packing will:"), list(summary2.steps));
      if (copies.length) {
        body3.append(
          h(
            "details",
            {},
            h("summary", {}, `Files copied in (${copies.length})`),
            list(copies.map((c2) => `${c2.from} \u2192 ${c2.to}`))
          )
        );
      }
    }
    if (warnings2.length) {
      body3.append(
        h("p", { class: "hint warn" }, "Font licences:"),
        list(warnings2, "pack-list warn")
      );
    }
    if (remaining.length) {
      body3.append(
        h(
          "p",
          { class: "hint" },
          "Still depends on the machine afterwards:"
        ),
        list(remaining)
      );
    }
    const pack = h(
      "button",
      {
        type: "button",
        class: "pbtn primary",
        "data-pack": "pack",
        onclick: async () => {
          pack.disabled = true;
          const done = await applyPack();
          if (!done) {
            pack.disabled = false;
            return;
          }
          showResult(done);
        }
      },
      "Pack"
    );
    pack.disabled = !summary2.steps.length;
    body3.append(
      h(
        "div",
        { class: "btn-row end" },
        h(
          "button",
          { type: "button", class: "pbtn", onclick: () => closeDialog() },
          summary2.steps.length ? "Cancel" : "Close"
        ),
        pack
      )
    );
    if (summary2.steps.length) pack.focus();
  }
  function showResult(done) {
    const remaining = remainingLines(done.remaining);
    openDialog(
      "Deck packed",
      h(
        "div",
        { class: "git-form pack-dialog" },
        done.changed.length ? h(
          "div",
          {},
          h(
            "p",
            {},
            "Packed (one step: Ctrl+Z takes it back). Commit these files to share them:"
          ),
          list(done.changed)
        ) : h("p", {}, "Packed: nothing needed changing."),
        remaining.length ? h(
          "div",
          {},
          h(
            "p",
            { class: "hint" },
            "Still depends on the machine:"
          ),
          list(remaining)
        ) : h(
          "p",
          { class: "hint" },
          "Nothing else depends on this machine."
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              onclick: () => closeDialog()
            },
            "Done"
          )
        )
      ),
      { wide: true }
    );
  }

  // src/ts/editor/publishtext.ts
  function defaultHost(info4) {
    return info4.configured?.host ?? info4.suggested ?? "github";
  }
  function filesFor(info4, host5, release) {
    return info4.hosts[host5].files.filter((f2) => release || !f2.release);
  }
  function fileAction(file) {
    if (file.exists === "inkflow") return "update";
    if (file.exists === "other") return "replace";
    return "new";
  }
  function linkParts(text) {
    const parts = [];
    const re2 = /https?:\/\/[^\s)]+[^\s).,;]/g;
    let last = 0;
    for (const m2 of text.matchAll(re2)) {
      const at3 = m2.index ?? 0;
      if (at3 > last) parts.push({ text: text.slice(last, at3) });
      parts.push({ url: m2[0] });
      last = at3 + m2[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
  }

  // src/ts/editor/publish.ts
  var HOST_NAMES = {
    github: "GitHub Pages",
    gitlab: "GitLab Pages"
  };
  function linked(text) {
    return h(
      "span",
      {},
      ...linkParts(text).map(
        (p2) => "url" in p2 ? h(
          "a",
          { href: p2.url, target: "_blank", rel: "noopener" },
          p2.url
        ) : p2.text
      )
    );
  }
  function fileRow(action, path) {
    const tone = action === "new" ? "new" : action === "replace" ? "deleted" : "modified";
    return h(
      "div",
      { class: "git-file" },
      h("span", { class: `git-status s-${tone}` }, action),
      h("code", { class: "git-path" }, path)
    );
  }
  function address(url, note2) {
    return h(
      "div",
      { class: "publish-url" },
      url ? h("a", { href: url, target: "_blank", rel: "noopener" }, url) : h("span", { class: "hint" }, "not known yet"),
      note2 ? h("p", { class: "hint publish-note" }, `(${note2})`) : null
    );
  }
  async function openPublishDialog(commit, canPush) {
    const res = await request({ action: "publish", op: "status" });
    if (!res.ok) {
      toast(res.error ?? "could not read the publishing setup", "error");
      return;
    }
    const info4 = res.publish;
    let host5 = defaultHost(info4);
    const release = h("input", { type: "checkbox" });
    release.checked = info4.configured?.release ?? false;
    const readme = h("input", { type: "checkbox" });
    readme.checked = info4.readme === "missing";
    const hostButtons = ["github", "gitlab"].map((value) => {
      const radio = h("input", {
        type: "radio",
        name: "publish-host",
        value
      });
      radio.checked = value === host5;
      radio.addEventListener("change", () => {
        host5 = value;
        update();
      });
      return h(
        "label",
        { class: "look" },
        radio,
        h(
          "span",
          { class: "look-text" },
          h("strong", {}, HOST_NAMES[value]),
          h(
            "span",
            { class: "hint" },
            value === "github" ? "A workflow in .github/workflows/" : "A pages job in .gitlab-ci.yml"
          )
        )
      );
    });
    const files2 = h("div", { class: "git-files" });
    const where = h("div", {});
    const notes = h("div", { class: "publish-notes" });
    const write2 = h(
      "button",
      { type: "button", class: "pbtn primary", onclick: () => void run() },
      "Write files"
    );
    release.addEventListener("change", () => update());
    readme.addEventListener("change", () => update());
    function update() {
      const hostInfo = info4.hosts[host5];
      const list4 = filesFor(info4, host5, release.checked);
      const rows = list4.map((f2) => fileRow(fileAction(f2), f2.path));
      if (readme.checked && info4.readme !== "linked") {
        const missing = info4.readme === "missing";
        rows.push(fileRow(missing ? "new" : "link", "README.md"));
      }
      files2.replaceChildren(...rows);
      where.replaceChildren(address(hostInfo.url, hostInfo.note));
      notes.replaceChildren(
        ...[...hostInfo.warnings, ...info4.fonts].map(
          (w2) => h("p", { class: "hint warn publish-note" }, w2)
        )
      );
      write2.textContent = list4.some((f2) => f2.exists !== "none") ? "Update files" : "Write files";
    }
    async function run() {
      const list4 = filesFor(info4, host5, release.checked);
      const theirs = list4.filter((f2) => f2.exists === "other");
      if (theirs.length && !confirm(
        `${theirs.map((f2) => f2.path).join(", ")} exists already and was not written by inkflow. Replace it?`
      ))
        return;
      write2.disabled = true;
      const out = await edit({
        action: "publish",
        op: "setup",
        host: host5,
        release: release.checked,
        readme: readme.checked,
        force: list4.some((f2) => f2.exists !== "none")
      });
      write2.disabled = false;
      if (!out.ok) return;
      done(out);
    }
    function done(out) {
      const written = out.written ?? [];
      const steps = out.steps ?? [];
      const url = out.url ?? null;
      const note2 = out.note ?? null;
      const message = `Publish the slides on ${HOST_NAMES[host5]}`;
      const commitBtn = (push) => h(
        "button",
        {
          type: "button",
          class: push ? "pbtn" : "pbtn primary",
          onclick: async () => {
            if (await commit(written, message, push)) closeDialog();
          }
        },
        push ? "Commit and push" : "Commit"
      );
      openDialog(
        `Publishing on ${HOST_NAMES[host5]}`,
        h(
          "div",
          { class: "git-form publish-form" },
          h(
            "div",
            { class: "field" },
            h("span", { class: "field-label" }, "Written"),
            h(
              "div",
              { class: "git-files" },
              ...written.map(
                (p2) => h("code", { class: "git-path" }, p2)
              )
            )
          ),
          h(
            "div",
            { class: "field" },
            h("span", { class: "field-label" }, "Address"),
            address(url, note2)
          ),
          h(
            "div",
            { class: "field" },
            h("span", { class: "field-label" }, "Next"),
            h(
              "ol",
              { class: "publish-steps" },
              ...steps.map((s2) => h("li", {}, linked(s2)))
            )
          ),
          h(
            "div",
            { class: "btn-row end" },
            h(
              "button",
              {
                type: "button",
                class: "pbtn",
                onclick: () => closeDialog()
              },
              "Later"
            ),
            written.length > 0 && canPush && commitBtn(true),
            written.length > 0 && commitBtn(false)
          )
        ),
        { wide: true }
      );
    }
    update();
    openDialog(
      "Publish the slides",
      h(
        "div",
        { class: "git-form publish-form" },
        h(
          "p",
          { class: "hint" },
          `Every push to ${info4.branch} builds the deck with inkflow build and puts it online. The files below go in the repository${info4.scope ? ` (at its root, ${info4.root})` : ""}: commit and push them.`
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Host"),
          h("div", { class: "look-list" }, ...hostButtons)
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Also"),
          h(
            "div",
            {},
            h(
              "label",
              { class: "check-row" },
              release,
              "Publish a release at every tag v\u2026 (the slides as one HTML file and a PDF)"
            ),
            info4.readme !== "linked" && h(
              "label",
              { class: "check-row" },
              readme,
              info4.readme === "missing" ? "Write a README.md that links to the slides" : "Add a link to the slides to README.md"
            )
          )
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Files"),
          files2
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Address"),
          where
        ),
        notes,
        h("div", { class: "btn-row end" }, write2)
      ),
      { wide: true, hint: info4.remote ?? "no remote yet" }
    );
  }

  // src/ts/editor/worktreetext.ts
  function branchName(wt) {
    return wt.branch ?? `@${wt.head}`;
  }
  function summary(wt) {
    const parts = [
      wt.ahead ? `${wt.ahead} ahead` : "",
      wt.behind ? `${wt.behind} behind` : "",
      wt.dirty ? "uncommitted changes" : "",
      wt.deck ? "" : "no deck"
    ].filter(Boolean);
    return parts.length ? parts.join(" \xB7 ") : "up to date";
  }
  function deckDir(deck) {
    const cut2 = Math.max(deck.lastIndexOf("/"), deck.lastIndexOf("\\"));
    return cut2 > 0 ? deck.slice(0, cut2) : deck;
  }
  function shellQuote(path) {
    return /^[\w@%+=:,./\\-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
  }
  function agentPrompt(wt) {
    const deck = wt.deck ?? `${wt.path}/deck.py`;
    return [
      `Work on this deck in the git worktree ${wt.path} (branch ${branchName(wt)}), not in the deck I have open.`,
      `Pass --deck ${shellQuote(deck)} to every inkflow command, change only files under that folder, and commit there when you are done.`,
      "Do not merge it: I will compare and merge it myself."
    ].join(" ");
  }
  function agentCommand(wt) {
    return `cd ${shellQuote(wt.deck ? deckDir(wt.deck) : wt.path)} && claude`;
  }

  // src/ts/editor/git.ts
  var menu3 = document.getElementById("context-menu");
  var button3 = document.getElementById("btn-git");
  var label = button3.querySelector(".git-label");
  var badge3 = button3.querySelector(".git-badge");
  var status = { repo: false, git: false };
  function render3() {
    button3.hidden = !status.git;
    if (!status.repo) {
      label.textContent = "Git";
      badge3.hidden = true;
      button3.title = "Not versioned: create a git repository for this deck";
      return;
    }
    label.textContent = status.branch ?? `@${status.detached ?? "?"}`;
    const n3 = status.changes?.length ?? 0;
    const lfsIssues = lfsFiles().length;
    const slidesChanged = changedSlideCount();
    button3.classList.toggle("warn", lfsIssues > 0);
    badge3.hidden = n3 === 0 && lfsIssues === 0;
    badge3.textContent = n3 ? String(n3) : "!";
    const sync = [
      status.ahead ? `${status.ahead} to push` : "",
      status.behind ? `${status.behind} to pull` : ""
    ].filter(Boolean).join(", ");
    button3.title = [
      status.branch ? `Branch ${status.branch}` : `Viewing ${status.detached}`,
      n3 ? `${n3} changed file${n3 === 1 ? "" : "s"}` : "No changes",
      slidesChanged ? `${slidesChanged} slide${slidesChanged === 1 ? "" : "s"} changed` : "",
      sync,
      lfsIssues ? `${lfsIssues} media file${lfsIssues === 1 ? "" : "s"} not in Git LFS` : ""
    ].filter(Boolean).join(" \xB7 ");
  }
  async function refreshGit() {
    if (!connected()) return status;
    const res = await request({ action: "git", op: "status", slides: true });
    if (res.ok && res.git) status = res.git;
    if (res.ok) setSlideChanges(status.repo ? res.slides : null);
    render3();
    return status;
  }
  function gitStatus() {
    return status;
  }
  var REWRITES = /* @__PURE__ */ new Set([
    "discard",
    "pull",
    "switch",
    "view",
    "revert",
    "restore",
    "create-branch"
  ]);
  async function git(op, args = {}, question = "") {
    const notice = REWRITES.has(op) && undoNoticeDue();
    if (question || notice) {
      const text = [question, notice ? UNDO_NOTICE : ""].filter(Boolean).join("\n\n");
      if (!confirm(question ? text : `${text}

Continue?`)) return null;
      if (notice) undoNoticeShown();
    }
    button3.classList.add("busy");
    const res = await request({ action: "git", op, ...args });
    button3.classList.remove("busy");
    if (res.git) {
      status = res.git;
      render3();
    }
    if (!res.ok) {
      toast(res.error ?? `git ${op} failed`, "error");
      return null;
    }
    if (typeof res.message === "string") toast(res.message, "ok");
    if (res.historyCleared) {
      ed.canUndo = false;
      ed.canRedo = false;
      emit("history");
    }
    void refreshGit();
    return res;
  }
  async function gitCommands() {
    await refreshGit();
    if (!status.git) return [];
    const group2 = "Git";
    if (!status.repo) {
      return [
        {
          label: "Create a git repository",
          group: group2,
          run: () => void git("init")
        }
      ];
    }
    const out = [];
    const n3 = status.changes?.length ?? 0;
    if (n3 && status.branch)
      out.push({ label: "Commit\u2026", group: group2, run: () => commitDialog() });
    if (status.remotes?.length && status.branch)
      out.push({ label: "Push", group: group2, run: () => void git("push") });
    if (status.upstream)
      out.push({ label: "Pull", group: group2, run: () => void git("pull") });
    if ((status.changes ?? []).some((c2) => c2.inDeck))
      out.push({
        label: "Discard changes\u2026",
        group: group2,
        run: () => discardDialog()
      });
    if (status.hasCommits) {
      out.push(
        { label: "Branches\u2026", group: group2, run: () => void branchesDialog() },
        { label: "History\u2026", group: group2, run: () => void historyDialog() }
      );
    }
    out.push({
      label: "Compare with\u2026",
      group: group2,
      run: () => void openComparePicker()
    });
    return out;
  }
  var runGit = git;
  async function openMenu2() {
    await refreshGit();
    clear(menu3);
    if (!status.repo) {
      menu3.append(
        h("div", { class: "menu-title" }, "Not versioned"),
        menuItem("Create a git repository", async () => {
          if (await git("init"))
            toast("This deck is now versioned with git", "ok");
        }),
        menuItem("Create a git repository (git only, no LFS)", async () => {
          if (await git("init", { lfs: false }))
            toast("This deck is now versioned with git", "ok");
        }),
        h("div", { class: "menu-sep" }),
        menuItem(
          "Compare with another deck\u2026",
          () => void openComparePicker()
        ),
        menuItem("Pack deck\u2026", () => void openPackDialog()),
        h("div", { class: "menu-note" }, PACK_HELP)
      );
    } else {
      const n3 = status.changes?.length ?? 0;
      const deckChanges = (status.changes ?? []).filter((c2) => c2.inDeck);
      const where = status.branch ? `On ${status.branch}` : `Viewing ${status.detached} (no branch)`;
      menu3.append(
        h(
          "div",
          { class: "menu-title" },
          `${where} \xB7 ${n3 ? `${n3} change${n3 === 1 ? "" : "s"}` : "no changes"}`
        )
      );
      if (status.last) {
        menu3.append(
          h(
            "div",
            { class: "menu-note" },
            `Last: ${status.last.subject} (${status.last.when})`
          )
        );
      }
      const lfsCount = lfsFiles().length;
      if (lfsCount) {
        const item2 = menuItem(
          `\u26A0 ${lfsCount} media file${lfsCount === 1 ? "" : "s"} not in Git LFS\u2026`,
          () => lfsDialog()
        );
        item2.classList.add("warn");
        menu3.append(item2);
      } else if (status.lfs?.mode === "on" && !status.lfs.installed) {
        menu3.append(
          h(
            "div",
            { class: "menu-note warn" },
            "git-lfs is not installed: this deck's media needs it"
          )
        );
      }
      menu3.append(
        menuItem(
          "Commit\u2026",
          () => commitDialog(),
          n3 === 0 || !status.branch
        ),
        menuItem(
          ed.slideSelection.size > 1 ? `Commit the ${ed.slideSelection.size} picked slides\u2026` : `Commit slide ${ed.current + 1} only\u2026`,
          () => commitPicked(),
          changedSlideCount() === 0 || !status.branch
        ),
        menuItem(
          status.ahead ? `Push (${status.ahead})` : "Push",
          () => void git("push"),
          !status.remotes?.length || !status.branch
        ),
        menuItem(
          status.behind ? `Pull (${status.behind})` : "Pull",
          () => void git("pull"),
          !status.upstream
        ),
        menuItem(
          "Discard changes\u2026",
          () => discardDialog(),
          deckChanges.length === 0
        ),
        menuItem("Pack deck\u2026", () => void openPackDialog()),
        h("div", { class: "menu-note" }, PACK_HELP),
        menuItem(
          "Undo last commit",
          async () => {
            if (await git(
              "undo-commit",
              {},
              `Take back "${status.last?.subject}"? Its changes stay, uncommitted.`
            ))
              toast(
                "Last commit taken back; its changes are kept",
                "ok"
              );
          },
          !status.canUndoCommit
        ),
        h("div", { class: "menu-sep" }),
        menuItem(
          status.branch ? "Branches\u2026" : "Back to a branch\u2026",
          () => void branchesDialog(),
          !status.hasCommits
        ),
        menuItem(
          "History\u2026",
          () => void historyDialog(),
          !status.hasCommits
        ),
        menuItem("Compare\u2026", () => void openComparePicker()),
        h("div", { class: "menu-sep" }),
        ...publishItems()
      );
      if (status.hasCommits) menu3.append(...await worktreeSection());
    }
    const r2 = button3.getBoundingClientRect();
    showMenu(Math.max(8, r2.right - 260), r2.bottom + 4);
  }
  function publishItems() {
    const pages = status.pages;
    const items2 = [];
    if (pages?.url) {
      items2.push(
        h(
          "a",
          {
            class: "menu-item publish-link",
            href: pages.url,
            target: "_blank",
            rel: "noopener",
            title: "Open the published slides",
            onclick: () => closeMenu()
          },
          `Published at ${pages.url.replace(/^https:\/\//, "")}`
        )
      );
    }
    items2.push(
      menuItem(pages ? "Publish\u2026 (update)" : "Publish\u2026", () => {
        void openPublishDialog(commitFiles, !!status.remotes?.length);
      })
    );
    return items2;
  }
  async function commitFiles(paths, message, push) {
    await refreshGit();
    if (!status.identity) {
      commitDialog(paths, message);
      return true;
    }
    if (!await git("commit", { message, paths })) return false;
    if (push) await git("push");
    return true;
  }
  function lfsFiles() {
    const l2 = status.lfs;
    return l2 ? [...l2.uncovered, ...l2.unconverted] : [];
  }
  function size2(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }
  function lfsList(files2) {
    return h(
      "div",
      { class: "git-files" },
      ...files2.map(
        (f2) => h(
          "div",
          { class: "git-file" },
          h("span", { class: "git-status" }, f2.kind),
          h("code", { class: "git-path" }, f2.path),
          h("span", { class: "hint git-size" }, size2(f2.size))
        )
      )
    );
  }
  function lfsDialog() {
    const l2 = status.lfs;
    if (!l2) return;
    const paths = lfsFiles().map((f2) => f2.path);
    openDialog(
      "Large files and Git LFS",
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint" },
          "Git keeps a full copy of a video or image in every version, so the repository grows with each change. Git LFS stores them outside the history; a small repository can do without it."
        ),
        l2.uncovered.length > 0 && h("h3", {}, "No Git LFS rule covers these"),
        l2.uncovered.length > 0 && lfsList(l2.uncovered),
        l2.unconverted.length > 0 && h("h3", {}, "Committed before Git LFS was set up"),
        l2.unconverted.length > 0 && lfsList(l2.unconverted),
        !l2.installed && h(
          "p",
          { class: "hint warn" },
          "git-lfs is not installed on this computer: install it (git-lfs.com) to track files with it."
        ),
        h(
          "p",
          { class: "hint" },
          "Tracking adds rules to the deck's .gitattributes and stages the files again as LFS files; commit to keep it. Earlier commits keep their full copies (git lfs migrate rewrites history, for everyone with a clone)."
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              title: "Record in .gitattributes that this deck stores media in git itself; no more warnings",
              onclick: async () => {
                if (await git("lfs-off")) closeDialog();
              }
            },
            "Use git without LFS"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              disabled: !l2.installed,
              onclick: async () => {
                if (await git("lfs-track", { paths }))
                  closeDialog();
              }
            },
            "Track with Git LFS"
          )
        )
      ),
      { wide: true }
    );
  }
  function fileRow2(change, checked) {
    const box2 = h("input", {
      type: "checkbox",
      value: change.path
    });
    box2.checked = checked;
    return h(
      "label",
      { class: `git-file${change.inDeck ? "" : " outside"}` },
      box2,
      h("span", { class: `git-status s-${change.status}` }, change.status),
      h("code", { class: "git-path" }, change.path)
    );
  }
  function checkedPaths(list4) {
    return [...list4.querySelectorAll("input:checked")].map(
      (b2) => b2.value
    );
  }
  function commitDialog(ticked, text) {
    const changes2 = status.changes ?? [];
    const message = h("textarea", {
      class: "git-message",
      rows: "3"
    });
    message.value = text ?? status.suggestedMessage ?? "Update slides";
    const files2 = h(
      "div",
      { class: "git-files" },
      ...changes2.map(
        (c2) => fileRow2(c2, ticked ? ticked.includes(c2.path) : c2.inDeck)
      )
    );
    const outside = changes2.some((c2) => !c2.inDeck);
    const name2 = h("input", {
      type: "text",
      placeholder: "Your name"
    });
    const email = h("input", {
      type: "email",
      placeholder: "you@example.com"
    });
    const identity = status.identity ? null : h(
      "div",
      { class: "git-identity" },
      h(
        "p",
        { class: "hint" },
        "git needs to know who commits (kept in this repository only):"
      ),
      h("div", { class: "btn-row" }, name2, email)
    );
    const commit = async (paths, push) => {
      const res = await git("commit", {
        message: message.value,
        paths,
        ...identity ? { name: name2.value, email: email.value } : {}
      });
      if (!res) return;
      closeDialog();
      if (push) await git("push");
    };
    const run = async (push) => {
      const paths = checkedPaths(files2);
      const summary2 = paths.length ? await packCheck() : null;
      if (!summary2?.needed) {
        await commit(paths, push);
        return;
      }
      commitGate(
        summary2,
        async () => {
          const packed = await applyPack();
          if (!packed) return;
          await refreshGit();
          await commit(commitPaths(paths, packed.gitPaths), push);
        },
        () => commit(paths, push)
      );
    };
    const canPush = !!status.remotes?.length;
    const changed2 = new Set(changes2.map((c2) => c2.path));
    const heavy = lfsFiles().filter((f2) => changed2.has(f2.path));
    const lfsNote = heavy.length > 0 && h(
      "p",
      { class: "hint warn" },
      `${heavy.length} of these ${heavy.length === 1 ? "is a media file" : "are media files"} git would store whole, not in Git LFS. `,
      h(
        "button",
        {
          type: "button",
          class: "link-btn",
          onclick: () => lfsDialog()
        },
        "Review\u2026"
      )
    );
    message.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" && (e2.ctrlKey || e2.metaKey)) {
        e2.preventDefault();
        void run(false);
      }
    });
    openDialog(
      "Commit",
      h(
        "div",
        { class: "git-form" },
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Message"),
          message
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Files"),
          h(
            "div",
            {},
            files2,
            outside && h(
              "p",
              { class: "hint" },
              "Files outside this deck are left out unless you tick them."
            )
          )
        ),
        lfsNote,
        identity,
        h(
          "div",
          { class: "btn-row end" },
          canPush && h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => void run(true)
            },
            "Commit and push"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              title: "Ctrl+Enter",
              onclick: () => void run(false)
            },
            "Commit"
          )
        )
      ),
      { wide: true, hint: status.branch ? `on ${status.branch}` : void 0 }
    );
    message.focus();
    message.select();
  }
  function discardDialog() {
    const changes2 = (status.changes ?? []).filter((c2) => c2.inDeck);
    const files2 = h(
      "div",
      { class: "git-files" },
      ...changes2.map((c2) => fileRow2(c2, true))
    );
    openDialog(
      "Discard changes",
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint warn" },
          "The ticked files go back to how they were in the last commit; new files are deleted. This cannot be undone."
        ),
        files2,
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn danger",
              onclick: async () => {
                const paths = checkedPaths(files2);
                if (!paths.length) return;
                if (await git("discard", { paths })) {
                  closeDialog();
                  toast(
                    `Discarded changes to ${paths.length} file${paths.length === 1 ? "" : "s"}`,
                    "ok"
                  );
                }
              }
            },
            "Discard"
          )
        )
      ),
      { wide: true }
    );
  }
  async function branchesDialog() {
    const res = await git("branches");
    if (!res) return;
    const branches = res.branches;
    const name2 = h("input", {
      type: "text",
      placeholder: "new-branch-name"
    });
    const create = async () => {
      if (!name2.value.trim()) return;
      if (await git("create-branch", { name: name2.value.trim() })) {
        closeDialog();
        toast(`Created and switched to ${name2.value.trim()}`, "ok");
      }
    };
    name2.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") {
        e2.preventDefault();
        void create();
      }
    });
    openDialog(
      "Branches",
      h(
        "div",
        { class: "git-form" },
        h(
          "div",
          { class: "git-list" },
          ...branches.map(
            (b2) => h(
              "div",
              { class: `git-row${b2.current ? " current" : ""}` },
              h("strong", {}, b2.name),
              h(
                "span",
                { class: "hint" },
                b2.current ? "current" : b2.when
              ),
              !b2.current && h(
                "button",
                {
                  type: "button",
                  class: "pbtn",
                  onclick: async () => {
                    if (await git("switch", {
                      name: b2.name
                    })) {
                      closeDialog();
                      toast(
                        `Switched to ${b2.name}`,
                        "ok"
                      );
                    }
                  }
                },
                "Switch"
              )
            )
          )
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "New branch"),
          h(
            "div",
            { class: "btn-row" },
            name2,
            h(
              "button",
              {
                type: "button",
                class: "pbtn primary",
                onclick: create
              },
              "Create and switch"
            )
          )
        ),
        h(
          "p",
          { class: "hint" },
          "Uncommitted changes come along to the branch you switch to; git refuses a switch that would overwrite them."
        )
      ),
      { wide: true }
    );
  }
  async function historyDialog() {
    const res = await git("log");
    if (!res) return;
    const log = res.log;
    const act = async (op, c2, question, done) => {
      if (await git(op, { sha: c2.sha }, question)) {
        closeDialog();
        toast(done, "ok");
      }
    };
    openDialog(
      "History",
      h(
        "div",
        { class: "git-form" },
        log.length ? h(
          "div",
          { class: "git-list history" },
          ...log.map(
            (c2) => h(
              "div",
              { class: `git-row${c2.head ? " current" : ""}` },
              h(
                "div",
                { class: "git-commit" },
                h("strong", {}, c2.subject),
                h(
                  "span",
                  { class: "hint" },
                  `${c2.short} \xB7 ${c2.author} \xB7 ${c2.when}${c2.refs.length ? ` \xB7 ${c2.refs.join(", ")}` : ""}`
                )
              ),
              h(
                "div",
                { class: "btn-row" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    title: "Compare with the working copy, slide by slide",
                    onclick: () => {
                      closeDialog();
                      openCompare(
                        { kind: "live" },
                        {
                          kind: "commit",
                          rev: c2.sha
                        }
                      );
                    }
                  },
                  "Compare"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    title: "Show the deck as it was then (switch back with Branches)",
                    onclick: () => void act(
                      "view",
                      c2,
                      `Show the deck as it was at "${c2.subject}"? Edits there are not on any branch until you create one.`,
                      `Viewing ${c2.short}; switch back to a branch from the git menu`
                    )
                  },
                  "View"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    title: "Make the deck's files what they were then, as uncommitted changes",
                    onclick: () => void act(
                      "restore",
                      c2,
                      `Restore the deck's files to "${c2.subject}"? Your current files are replaced (commit first to keep them).`,
                      `Restored the deck to ${c2.short}; commit to keep it`
                    )
                  },
                  "Restore"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    title: "A new commit that undoes this one",
                    onclick: () => void act(
                      "revert",
                      c2,
                      `Undo "${c2.subject}" with a new commit?`,
                      `Reverted ${c2.short}`
                    )
                  },
                  "Revert"
                )
              )
            )
          )
        ) : h("p", { class: "hint" }, "No commits touch this deck yet."),
        h(
          "p",
          { class: "hint" },
          "View: look at an old version (no branch). Restore: bring the deck back to it as changes you can commit. Revert: undo one commit with a new one."
        )
      ),
      {
        wide: true,
        hint: status.scope ? `changes to ${status.scope}/` : void 0
      }
    );
  }
  async function worktreeOp(op, args = {}, question = "", rewrites = false, quiet = false) {
    const notice = rewrites && undoNoticeDue();
    if (question || notice) {
      const text = [question, notice ? UNDO_NOTICE : ""].filter(Boolean).join("\n\n");
      if (!confirm(text)) return null;
      if (notice) undoNoticeShown();
    }
    button3.classList.add("busy");
    const res = await request({ action: "worktree", op, ...args });
    button3.classList.remove("busy");
    if (res.git) {
      status = res.git;
      render3();
    }
    if (!res.ok) {
      if (!quiet) toast(res.error ?? `worktree ${op} failed`, "error");
      return res;
    }
    if (typeof res.message === "string") toast(res.message, "ok");
    if (typeof res.note === "string") toast(res.note, "info");
    if (res.historyCleared) {
      ed.canUndo = false;
      ed.canRedo = false;
      emit("history");
    }
    return res;
  }
  async function worktreeList() {
    const res = await request({ action: "worktree", op: "list" });
    return res.ok ? res.worktrees : [];
  }
  async function worktreeSection() {
    const others2 = (await worktreeList()).filter((w2) => !w2.main);
    return [
      h("div", { class: "menu-sep" }),
      h("div", { class: "menu-title" }, "Worktrees"),
      ...others2.map(
        (wt) => h(
          "div",
          { class: "menu-wt" },
          h(
            "button",
            {
              type: "button",
              class: "menu-item",
              title: `${wt.path}
Merge, remove, or what to tell the agent`,
              onclick: () => {
                closeMenu();
                worktreeDialog(wt);
              }
            },
            h("span", { class: "wt-branch" }, branchName(wt)),
            h("span", { class: "wt-state" }, summary(wt))
          ),
          h(
            "button",
            {
              type: "button",
              class: "menu-mini",
              disabled: !wt.deck,
              title: "Compare its slides with this deck",
              onclick: () => {
                closeMenu();
                compareWith(wt);
              }
            },
            "Compare"
          )
        )
      ),
      menuItem("New worktree for an agent\u2026", () => newWorktreeDialog())
    ];
  }
  function compareWith(wt) {
    if (!wt.deck) return;
    document.dispatchEvent(
      new CustomEvent("inkflow:compare", {
        detail: { kind: "path", deck: wt.deck, label: branchName(wt) }
      })
    );
  }
  function copyBlock(text) {
    return h(
      "div",
      { class: "wt-copy" },
      h("pre", { class: "wt-command" }, text),
      h(
        "button",
        {
          type: "button",
          class: "pbtn",
          onclick: () => void navigator.clipboard.writeText(text).then(
            () => toast("Copied", "ok"),
            () => toast("Could not copy: select the text", "error")
          )
        },
        "Copy"
      )
    );
  }
  function newWorktreeDialog() {
    const name2 = h("input", {
      type: "text",
      placeholder: "e.g. bolder-colours",
      spellcheck: "false"
    });
    const create = async () => {
      const value = name2.value.trim().replace(/\s+/g, "-");
      if (!value) return;
      const res = await worktreeOp("add", { name: value });
      if (res?.ok) worktreeDialog(res.worktree, true);
    };
    name2.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") {
        e2.preventDefault();
        void create();
      }
    });
    openDialog(
      "New worktree for an agent",
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint" },
          `A copy of the deck on a branch of its own, deck/<name>, from the last commit of ${status.branch ?? "this version"}. A coding agent works and commits there while your deck stays as it is; then compare and merge it, or remove it.`
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Name"),
          h(
            "div",
            { class: "btn-row" },
            name2,
            h(
              "button",
              {
                type: "button",
                class: "pbtn primary",
                onclick: () => void create()
              },
              "Create"
            )
          )
        ),
        (status.changes ?? []).some((c2) => c2.inDeck) && h(
          "p",
          { class: "hint warn" },
          "Your uncommitted changes to the deck are not in it: commit first to include them."
        )
      ),
      { wide: true }
    );
    name2.focus();
  }
  function worktreeDialog(wt, created = false) {
    const into = status.branch;
    const merge2 = async () => {
      const n3 = wt.ahead;
      const question = [
        `Merge ${branchName(wt)} (${n3} commit${n3 === 1 ? "" : "s"}) into ${into}? Its changes land in your deck's files now.`,
        wt.dirty ? "Its uncommitted changes are not merged (commit them there first)." : ""
      ].filter(Boolean).join("\n\n");
      const res = await worktreeOp(
        "merge",
        { branch: wt.branch },
        question,
        true
      );
      if (res?.ok) closeDialog();
    };
    const remove = async () => {
      const lost = [
        wt.dirty ? "uncommitted changes" : "",
        wt.ahead ? `${wt.ahead} unmerged commit${wt.ahead === 1 ? "" : "s"}` : ""
      ].filter(Boolean);
      if (!confirm(
        `Remove the worktree ${wt.name} (${wt.path})?${lost.length ? `

It has ${lost.join(" and ")}.` : ""}`
      ))
        return;
      let res = await worktreeOp(
        "remove",
        { name: wt.path },
        "",
        false,
        true
      );
      if (res && !res.ok) {
        if (!confirm(
          `${res.error}

Remove it anyway? Its uncommitted changes and unmerged commits are lost.`
        ))
          return;
        res = await worktreeOp("remove", { name: wt.path, force: true });
      }
      if (res?.ok) closeDialog();
    };
    openDialog(
      `Worktree ${branchName(wt)}`,
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint" },
          created ? `Created from the last commit${into ? ` of ${into}` : ""} \xB7 ` : `${summary(wt)} \xB7 `,
          h("code", { class: "git-path" }, wt.path)
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Tell the agent"),
          copyBlock(agentPrompt(wt))
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Or start one there"),
          copyBlock(agentCommand(wt))
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn danger",
              onclick: () => void remove()
            },
            "Remove\u2026"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              disabled: !wt.deck,
              title: "Its slides side by side with this deck's",
              onclick: () => {
                closeDialog();
                compareWith(wt);
              }
            },
            "Compare"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              disabled: !wt.branch || !into || wt.ahead === 0,
              title: into ? `Bring its commits into ${into}` : "Switch the deck to a branch first",
              onclick: () => void merge2()
            },
            into ? `Merge into ${into}\u2026` : "Merge\u2026"
          )
        )
      ),
      { wide: true }
    );
  }
  var timer = 0;
  function initGit() {
    button3.addEventListener("click", () => void openMenu2());
    on("model", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshGit(), 600);
    });
  }

  // src/ts/editor/slidegittext.ts
  function letter(state) {
    if (state === "new") return "U";
    if (state === "modified") return "M";
    if (state === "shared") return "\u2022";
    return "";
  }
  var STATE_WORDS = {
    new: "New since the last commit",
    modified: "Changed since the last commit",
    shared: "Only files it shares with other slides changed"
  };
  var ROLE_WORDS = {
    layout: "its layout",
    overlay: "an overlay",
    md: "its Markdown",
    notes: "its notes",
    ink: "its ink",
    data: "chart data",
    asset: "a picture",
    diagram: "a diagram",
    slide: "its SVG",
    style: "its stylesheet",
    deck: "every slide uses it"
  };
  function changeTitle(c2) {
    if (!c2?.state) return "";
    const lines = [STATE_WORDS[c2.state] ?? ""];
    if (c2.entry === "new") lines.push("  its Slide(...) in deck.py is new");
    else if (c2.entry === "modified")
      lines.push("  its Slide(...) in deck.py changed");
    for (const f2 of c2.files) {
      const what = ROLE_WORDS[f2.role] ?? f2.role;
      const shared = f2.shared ? ", shared with other slides" : "";
      lines.push(`  ${f2.path} (${what}, ${f2.status}${shared})`);
    }
    return lines.join("\n");
  }
  function changedAmong(changes2, indices) {
    if (!changes2) return [];
    return [...indices].filter((i2) => {
      const s2 = changes2.slides[i2]?.state;
      return s2 === "new" || s2 === "modified";
    }).sort((a2, b2) => a2 - b2);
  }
  function markedAmong(changes2, indices) {
    if (!changes2) return [];
    return [...indices].filter((i2) => !!changes2.slides[i2]?.state).sort((a2, b2) => a2 - b2);
  }
  function nextMarked(changes2, from, dir) {
    const n3 = changes2?.slides.length ?? 0;
    for (let k2 = 1; k2 <= n3; k2++) {
      const i2 = ((from + dir * k2) % n3 + n3) % n3;
      if (i2 !== from && changes2?.slides[i2]?.state) return i2;
    }
    return null;
  }
  function commitWhat(c2) {
    const parts = [];
    if (c2.entry === "added") parts.push("added the slide");
    else if (c2.entry === "changed") parts.push("its Slide(...)");
    else if (c2.entry === "removed") parts.push("removed the slide");
    const names2 = c2.files.map((f2) => f2.split("/").slice(-2).join("/"));
    if (names2.length) parts.push(names2.join(", "));
    return parts.join(" \xB7 ");
  }
  function defaultMessage(titles2) {
    const named = titles2.map((t2) => `"${t2.trim() || "untitled"}"`);
    if (named.length === 1) return `Update slide ${named[0]}`;
    if (named.length <= 3) {
      const last = named.pop();
      return `Update slides ${named.join(", ")} and ${last}`;
    }
    return `Update ${named.length} slides`;
  }
  function removedName(r2) {
    if (!r2.key) return `slide ${r2.index + 1}`;
    return r2.key.replace(/^(id|md|src):/, "");
  }
  function deckWords(plan2) {
    if (plan2.deck === "none") return "";
    const whole = plan2.deck === "whole";
    const base2 = whole ? `${plan2.deckPath}: all its changes` : `${plan2.deckPath}: these slides' Slide(...) entries only`;
    return plan2.other ? `${base2}, with its imports, settings, sections and order as they are now` : base2;
  }
  function leftWords(plan2) {
    if (!plan2.left) return "";
    return `${plan2.left} other changed slide${plan2.left === 1 ? "" : "s"} stay${plan2.left === 1 ? "s" : ""} uncommitted.`;
  }
  function whyWords(why) {
    if (why === "shared") return "shared with other slides";
    if (why === "deck") return "every slide is drawn with it";
    return "";
  }
  function touchedWords(plan2) {
    const n3 = plan2.touched;
    if (!n3) return "";
    return `${n3} other slide${n3 === 1 ? " shares" : "s share"} these files and will look different in this commit too.`;
  }
  function missingWords(plan2) {
    return plan2.missing.map(
      (m2) => m2.why === "ignored" ? `${m2.path}: ignored by git, so a clone will not have it` : `${m2.path}: outside the repository, so a clone will not have it`
    );
  }
  function diffLine(line) {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("Binary files"))
      return "meta";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "";
  }

  // src/ts/editor/slidegit.ts
  var changes = null;
  function setSlideChanges(next) {
    const value = next && typeof next === "object" && Array.isArray(next.slides) ? next : null;
    if (JSON.stringify(value) === JSON.stringify(changes)) return;
    changes = value;
    emit("slide-git");
  }
  function slideChange(i2) {
    if (!changes || changes.slides.length !== (ed.model?.slides.length ?? 0))
      return void 0;
    return changes.slides[i2];
  }
  function changeBadge(i2) {
    const badge4 = h("span", { class: "git-mark" });
    paint3(badge4, slideChange(i2));
    return badge4;
  }
  function paint3(badge4, c2) {
    const state = c2?.state ?? "";
    badge4.textContent = letter(c2?.state ?? null);
    badge4.className = `git-mark${state ? ` m-${state}` : ""}`;
    if (state) badge4.setAttribute("title", changeTitle(c2));
    else badge4.removeAttribute("title");
  }
  function markChange(item2, i2) {
    const badge4 = item2.querySelector(".git-mark");
    if (badge4) paint3(badge4, slideChange(i2));
  }
  function slideGitItems(i2, item2) {
    const status3 = gitStatus();
    if (!status3.repo || !changes) return [];
    const picked = ed.slideSelection.size > 1 ? [...ed.slideSelection] : [i2];
    const changed2 = changedAmong(changes, picked);
    const out = [h("div", { class: "menu-sep" })];
    if (picked.length === 1) {
      const c2 = slideChange(i2);
      const any = !!c2?.state;
      out.push(
        item2(
          "Compare with the last commit",
          () => compareSlide(i2),
          !status3.hasCommits
        ),
        item2("Show git diff", () => void diffDialog(i2), !any)
      );
    }
    if (picked.length === 1) {
      out.push(
        item2(
          "History of this slide\u2026",
          () => void historyDialog2(i2),
          !status3.hasCommits
        )
      );
    }
    const n3 = changed2.length;
    const marked2 = markedAmong(changes, picked);
    out.push(
      item2(
        picked.length === 1 ? "Commit this slide\u2026" : `Commit ${n3} changed slide${n3 === 1 ? "" : "s"}\u2026`,
        () => void commitSlides(changed2),
        n3 === 0
      ),
      item2(
        picked.length === 1 ? "Discard changes to this slide\u2026" : `Discard changes to ${marked2.length} slide${marked2.length === 1 ? "" : "s"}\u2026`,
        () => void discardSlides(marked2),
        marked2.length === 0 || !status3.hasCommits
      )
    );
    return out;
  }
  function isMarked(i2) {
    return !!slideChange(i2)?.state;
  }
  function markedCount() {
    return markedAmong(changes, ed.model?.slides.keys() ?? []).length;
  }
  function jumpToChange(dir) {
    const next = nextMarked(changes, ed.current, dir);
    if (next == null) {
      toast(
        changes && markedCount() ? "No other slide has changes" : "No slide has changes since the last commit"
      );
      return;
    }
    ed.slideSelection.clear();
    gotoSlide(next);
  }
  async function discardSlides(slides) {
    if (!slides.length) {
      toast("These slides have no changes to put back");
      return;
    }
    const res = await request({
      action: "git",
      op: "discard-slides",
      slides,
      dryRun: true
    });
    if (!res.ok) {
      toast(res.error ?? "Cannot put these slides back", "error");
      return;
    }
    const plan2 = res.plan;
    const shared = /* @__PURE__ */ new Set();
    const fileRows = plan2.paths.map(
      (f2) => fileLine(
        f2.path,
        f2.status,
        f2.status === "new" ? "deleted (not in the last commit)" : ""
      )
    );
    if (plan2.deck === "partial") {
      fileRows.push(
        h(
          "div",
          { class: "git-file" },
          h("span", { class: "git-status s-modified" }, "part"),
          h(
            "span",
            { class: "git-path" },
            `${plan2.deckPath}: these slides' Slide(...) entries as committed (a new slide is removed)`
          )
        )
      );
    }
    const sharedRows = plan2.shared.map((f2) => {
      const box2 = h("input", {
        type: "checkbox",
        value: f2.path
      });
      box2.addEventListener("change", () => {
        if (box2.checked) shared.add(f2.path);
        else shared.delete(f2.path);
      });
      return h(
        "label",
        { class: "git-file" },
        box2,
        h("span", { class: `git-status s-${f2.status}` }, f2.status),
        h("code", { class: "git-path" }, f2.path),
        h("span", { class: "hint" }, "other slides change too")
      );
    });
    const n3 = slides.length;
    openDialog(
      n3 === 1 ? `Discard changes to slide ${slides[0] + 1}` : `Discard changes to ${n3} slides`,
      h(
        "div",
        { class: "git-form" },
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Put back"),
          fileRows.length ? h("div", { class: "git-files" }, ...fileRows) : h("p", { class: "hint" }, "Nothing of their own.")
        ),
        plan2.shared.length ? h(
          "div",
          { class: "field" },
          h(
            "span",
            { class: "field-label" },
            "Also put back (shared with other slides)"
          ),
          h("div", { class: "git-files" }, ...sharedRows)
        ) : null,
        h(
          "p",
          { class: "hint" },
          "The other slides keep their changes. Undo brings these back."
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn danger",
              onclick: async () => {
                const done = await edit({
                  action: "git",
                  op: "discard-slides",
                  slides,
                  shared: [...shared]
                });
                if (!done.ok) return;
                closeDialog();
                toast(
                  String(done.label ?? "Changes discarded"),
                  "ok"
                );
              }
            },
            "Discard"
          )
        )
      ),
      { wide: true }
    );
  }
  async function historyDialog2(i2) {
    const res = await request({ action: "git", op: "slide-log", slide: i2 });
    if (!res.ok) {
      toast(res.error ?? "Cannot read the slide's history", "error");
      return;
    }
    const log = res.log ?? [];
    const rows = log.map(
      (c2) => h(
        "div",
        { class: "git-row" },
        h(
          "div",
          { class: "git-commit" },
          h(
            "div",
            {},
            h("code", {}, c2.short),
            " ",
            h("strong", {}, c2.subject)
          ),
          h(
            "div",
            { class: "hint" },
            `${c2.author}, ${c2.when} \xB7 ${commitWhat(c2)}`
          )
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "This slide then, beside it now",
            onclick: () => {
              closeDialog();
              openCompare(
                { kind: "commit", rev: c2.sha },
                { kind: "live" },
                { focus: i2 }
              );
            }
          },
          "Compare"
        )
      )
    );
    openDialog(
      `History of slide ${i2 + 1}: ${slideName3(i2)}`,
      h(
        "div",
        { class: "git-form" },
        rows.length ? h("div", { class: "git-list" }, ...rows) : h(
          "p",
          { class: "hint" },
          "No commit has changed this slide's own files or its Slide(...) yet."
        ),
        h(
          "p",
          { class: "hint" },
          "Commits that changed its own files or its Slide(...) in deck.py; files it shares with other slides (its layout) are left out."
        )
      ),
      { wide: true }
    );
  }
  document.addEventListener("keydown", (e2) => {
    const dir = matches(e2, "review.next-change") ? 1 : matches(e2, "review.prev-change") ? -1 : 0;
    if (!dir) return;
    const target = e2.target;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    e2.preventDefault();
    jumpToChange(dir);
  });
  function compareSlide(i2) {
    openCompare(
      { kind: "commit", rev: "HEAD" },
      { kind: "live" },
      { focus: i2 }
    );
  }
  function slideName3(i2) {
    const slide = ed.model?.slides[i2];
    return slide?.title ?? slide?.id ?? `slide ${i2 + 1}`;
  }
  async function diffDialog(i2) {
    const res = await request({ action: "git", op: "slide-diff", slide: i2 });
    if (!res.ok) {
      toast(res.error ?? "Cannot read the slide's changes", "error");
      return;
    }
    const text = String(res.diff ?? "");
    const pre = h("pre", { class: "git-diff" });
    for (const line of text.split("\n")) {
      const kind = diffLine(line);
      pre.append(h("span", { class: kind ? `d-${kind}` : null }, line), "\n");
    }
    openDialog(
      `Changes to slide ${i2 + 1}: ${slideName3(i2)}`,
      h(
        "div",
        { class: "git-form" },
        text.trim() ? pre : h(
          "p",
          { class: "hint" },
          "No changes since the last commit."
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => {
                closeDialog();
                compareSlide(i2);
              }
            },
            "Compare with the last commit"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: async () => {
                await navigator.clipboard?.writeText(text);
                toast("Diff copied", "ok");
              }
            },
            "Copy"
          ),
          changedAmong(changes, [i2]).length ? h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              onclick: () => void commitSlides([i2])
            },
            "Commit this slide\u2026"
          ) : null
        )
      ),
      { large: true }
    );
  }
  async function plan(slides, removed) {
    const res = await request({
      action: "git",
      op: "commit-slides",
      slides,
      removed,
      dryRun: true
    });
    if (!res.ok) {
      toast(res.error ?? "Cannot commit these slides", "error");
      return null;
    }
    return res.plan;
  }
  function fileLine(path, status3, why = "") {
    return h(
      "div",
      { class: "git-file" },
      h("span", { class: `git-status s-${status3}` }, status3),
      h("code", { class: "git-path" }, path),
      why ? h("span", { class: "hint" }, why) : null
    );
  }
  async function commitSlides(slides) {
    if (!slides.length) {
      toast("These slides have no changes to commit");
      return;
    }
    let withRemoved = false;
    let current3 = await plan(slides, withRemoved);
    if (!current3) return;
    const status3 = gitStatus();
    const message = h("textarea", {
      class: "git-message",
      rows: "3"
    });
    message.value = defaultMessage(slides.map(slideName3));
    const files2 = h("div", { class: "git-files" });
    const offers = h("div", { class: "git-files" });
    const notes = h("div", {});
    const ticked = /* @__PURE__ */ new Set();
    const draw = (p2) => {
      files2.replaceChildren(
        ...p2.paths.map((f2) => fileLine(f2.path, f2.status, whyWords(f2.why))),
        ...p2.deck !== "none" ? [
          h(
            "div",
            { class: "git-file" },
            h(
              "span",
              { class: "git-status s-modified" },
              p2.deck === "whole" ? "modified" : "part"
            ),
            h("span", { class: "git-path" }, deckWords(p2))
          )
        ] : []
      );
      offers.replaceChildren(
        ...p2.offered.map((o2) => {
          const box2 = h("input", {
            type: "checkbox",
            value: o2.path
          });
          box2.checked = ticked.has(o2.path);
          box2.addEventListener("change", () => {
            if (box2.checked) ticked.add(o2.path);
            else ticked.delete(o2.path);
          });
          return h(
            "label",
            { class: "git-file" },
            box2,
            h("span", { class: `git-status s-${o2.status}` }, o2.status),
            h("code", { class: "git-path" }, o2.path)
          );
        })
      );
      offers.hidden = !p2.offered.length;
      offersLabel.hidden = !p2.offered.length;
      notes.replaceChildren(
        ...[touchedWords(p2), leftWords(p2)].filter(Boolean).map((t2) => h("p", { class: "hint" }, t2))
      );
      const lacking = missingWords(p2);
      missing.replaceChildren(
        ...lacking.length ? [
          h(
            "p",
            { class: "hint warn" },
            "A clone of this commit will not show these slides as they look here:"
          ),
          h(
            "ul",
            { class: "pack-list" },
            ...lacking.map((t2) => h("li", {}, t2))
          )
        ] : []
      );
    };
    const offersLabel = h(
      "span",
      { class: "field-label" },
      "Also commit (deleted files no slide uses)"
    );
    const missing = h("div", {});
    const removed = changes?.removed ?? [];
    const removedBox = h("input", { type: "checkbox" });
    removedBox.addEventListener("change", async () => {
      withRemoved = removedBox.checked;
      const next = await plan(slides, withRemoved);
      if (!next) {
        removedBox.checked = !removedBox.checked;
        withRemoved = removedBox.checked;
        return;
      }
      for (const o2 of next.offered) {
        if (o2.why === "deleted") {
          if (withRemoved) ticked.add(o2.path);
          else ticked.delete(o2.path);
        }
      }
      current3 = next;
      draw(next);
    });
    const name2 = h("input", {
      type: "text",
      placeholder: "Your name"
    });
    const email = h("input", {
      type: "email",
      placeholder: "you@example.com"
    });
    const identity = status3.identity ? null : h(
      "div",
      { class: "git-identity" },
      h(
        "p",
        { class: "hint" },
        "git needs to know who commits (kept in this repository only):"
      ),
      h("div", { class: "btn-row" }, name2, email)
    );
    const commit = async (push) => {
      if (!current3) return;
      const res = await runGit("commit-slides", {
        slides,
        message: message.value,
        removed: withRemoved,
        paths: current3.offered.map((o2) => o2.path).filter((p2) => ticked.has(p2)),
        ...identity ? { name: name2.value, email: email.value } : {}
      });
      if (!res) return;
      closeDialog();
      if (push) await runGit("push");
    };
    const run = (push) => commit(push);
    message.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" && (e2.ctrlKey || e2.metaKey)) {
        e2.preventDefault();
        void run(false);
      }
    });
    const list4 = h(
      "div",
      { class: "git-slides" },
      ...slides.map(
        (i2) => h(
          "div",
          { class: "git-file" },
          changeBadge(i2),
          h("span", { class: "git-slide-num" }, String(i2 + 1)),
          h("span", {}, slideName3(i2))
        )
      )
    );
    openDialog(
      slides.length === 1 ? "Commit this slide" : `Commit ${slides.length} slides`,
      h(
        "div",
        { class: "git-form" },
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Message"),
          message
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Slides"),
          list4
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Goes in"),
          h("div", {}, files2, notes, missing)
        ),
        h("div", { class: "field" }, offersLabel, offers),
        removed.length ? h(
          "label",
          { class: "field inline" },
          removedBox,
          h(
            "span",
            {},
            `Also commit the removal of ${removed.length} slide${removed.length === 1 ? "" : "s"} (${removed.map(removedName).join(", ")})`
          )
        ) : null,
        identity,
        h(
          "div",
          { class: "btn-row end" },
          status3.remotes?.length ? h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => void run(true)
            },
            "Commit and push"
          ) : null,
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              title: "Ctrl+Enter",
              onclick: () => void run(false)
            },
            "Commit"
          )
        )
      ),
      {
        wide: true,
        hint: status3.branch ? `on ${status3.branch}` : void 0
      }
    );
    draw(current3);
    message.focus();
    message.select();
  }
  function commitPicked() {
    const picked = ed.slideSelection.size ? [...ed.slideSelection] : [ed.current];
    void commitSlides(changedAmong(changes, picked));
  }
  function changedSlideCount() {
    return changedAmong(changes, ed.model?.slides.keys() ?? []).length;
  }

  // src/ts/editor/starstext.ts
  function starTargets(focus2, picked, current3) {
    if (focus2 === "sorter" && picked.size) {
      return [...picked].sort((a2, b2) => a2 - b2);
    }
    return [current3];
  }
  function starsOn(ids, starred2) {
    return !ids.every((id) => id != null && starred2.has(id));
  }
  function starTitle(starred2) {
    return starred2 ? "Starred: take the star off (S)" : "Star this slide (S)";
  }
  function filterLabel(count) {
    return `Starred only (${count})`;
  }
  function onlyStarred(indices, isStarred2) {
    return indices.filter(isStarred2);
  }

  // src/ts/editor/stars.ts
  function starred() {
    return new Set(ed.model?.stars ?? []);
  }
  function isStarred(deckIndex) {
    const id = ed.model?.slides[deckIndex]?.id;
    return id != null && (ed.model?.stars ?? []).includes(id);
  }
  function starCount() {
    return ed.model?.stars?.length ?? 0;
  }
  function setStars(ids) {
    if (!ed.model || !Array.isArray(ids)) return;
    ed.model.stars = ids.filter((id) => typeof id === "string");
    emit("stars");
  }
  async function toggleStar(indices) {
    const slides = ed.model?.slides ?? [];
    const on2 = starsOn(
      indices.map((i2) => slides[i2]?.id),
      starred()
    );
    const result = await edit({ action: "star", slides: indices, on: on2 });
    if (result.ok) setStars(result.stars);
  }
  function starSelection() {
    void toggleStar(starTargets(ed.focus, ed.slideSelection, ed.current));
  }
  function starButton(deckIndex) {
    const on2 = isStarred(deckIndex);
    const button10 = h(
      "button",
      {
        type: "button",
        class: `star-btn${on2 ? " on" : ""}`,
        "aria-pressed": String(on2),
        title: starTitle(on2),
        draggable: "false"
      },
      on2 ? "\u2605" : "\u2606"
    );
    button10.addEventListener("click", (e2) => {
      e2.stopPropagation();
      void toggleStar([deckIndex]);
    });
    button10.addEventListener("dblclick", (e2) => e2.stopPropagation());
    return button10;
  }
  function markStar(item2, deckIndex) {
    const on2 = isStarred(deckIndex);
    item2.classList.toggle("starred", on2);
    const button10 = item2.querySelector(".star-btn");
    if (!button10 || button10.classList.contains("on") === on2) return;
    button10.classList.toggle("on", on2);
    button10.setAttribute("aria-pressed", String(on2));
    button10.setAttribute("title", starTitle(on2));
    button10.textContent = on2 ? "\u2605" : "\u2606";
  }
  function initStars() {
    onMessage("stars", (msg) => setStars(msg.stars));
  }

  // src/ts/editor/sorter.ts
  var list2 = document.getElementById("sorter-list");
  var addBtn = document.getElementById("sorter-add");
  var menu4 = document.getElementById("context-menu");
  function pickSlide(i2, e2) {
    ed.focus = "sorter";
    if (e2.shiftKey) {
      const [a2, b2] = [Math.min(ed.current, i2), Math.max(ed.current, i2)];
      for (let k2 = a2; k2 <= b2; k2++) ed.slideSelection.add(k2);
      emit("slide-selection");
      return;
    }
    if (e2.ctrlKey || e2.metaKey) {
      if (!ed.slideSelection.size) ed.slideSelection.add(ed.current);
      if (ed.slideSelection.has(i2)) ed.slideSelection.delete(i2);
      else ed.slideSelection.add(i2);
      emit("slide-selection");
      if (ed.slideSelection.has(i2)) gotoSlide(i2);
      return;
    }
    ed.slideSelection.clear();
    if (i2 === ed.current) emit("slide-selection");
    else gotoSlide(i2);
  }
  async function deleteSlides() {
    const indices = [...ed.slideSelection].sort((a2, b2) => a2 - b2);
    if (indices.length <= 1) {
      await deleteSlide(indices[0] ?? ed.current);
      return;
    }
    const req = { action: "slide", op: "delete", slides: indices };
    const names2 = indices.map((i2) => slideName4(i2));
    const answer = await askSlideDelete(
      slideQuestion(names2),
      indices.length,
      req
    );
    if (!answer) return;
    const result = await edit({ ...req, files: answer.files });
    if (result.ok) {
      ed.slideSelection.clear();
      ed.current = Math.max(0, indices[0] - 1);
      emit("slide");
    }
  }
  function gotoSlide(deckIndex) {
    const n3 = ed.model?.slides.length ?? 0;
    if (!n3) return;
    const i2 = Math.max(0, Math.min(n3 - 1, deckIndex));
    if (i2 === ed.current) return;
    ed.current = i2;
    ed.selection = [];
    ed.scope = null;
    emit("slide");
  }
  var Thumbs = class {
    /** `scroller` is the element the thumbnails scroll in. */
    constructor(scroller) {
      this.scroller = scroller;
    }
    scroller;
    cache = /* @__PURE__ */ new Map();
    used = /* @__PURE__ */ new Map();
    drawn = /* @__PURE__ */ new WeakMap();
    svgs = /* @__PURE__ */ new WeakMap();
    watch = null;
    begin() {
      this.used = /* @__PURE__ */ new Map();
    }
    end() {
      for (const [key, box2] of this.cache) {
        if (this.used.get(key) !== box2) this.watch?.unobserve(box2);
      }
      this.cache = this.used;
    }
    /** A thumbnail taken out of its view by hand is no longer kept. */
    forget(svg) {
      const box2 = svg == null ? void 0 : this.cache.get(svg);
      if (!box2 || box2.isConnected) return;
      this.watch?.unobserve(box2);
      this.cache.delete(svg);
    }
    observer() {
      if (this.watch || typeof IntersectionObserver === "undefined") {
        return this.watch;
      }
      this.watch = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) this.draw(entry.target);
            else this.empty(entry.target);
          }
        },
        // A screenful ahead in both directions, so scrolling shows
        // thumbnails, not boxes filling in.
        { root: this.scroller, rootMargin: "100% 0px" }
      );
      return this.watch;
    }
    empty(box2) {
      if (!this.drawn.has(box2)) return;
      this.drawn.delete(box2);
      box2.replaceChildren();
    }
    draw(box2) {
      const markup = this.svgs.get(box2);
      if (markup == null || this.drawn.get(box2) === markup) return;
      this.drawn.set(box2, markup);
      box2.innerHTML = markup;
      const svg = box2.querySelector("svg");
      if (!svg) return;
      const vb = parseViewBox(svg.getAttribute("viewBox"));
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
      });
      svg.querySelectorAll("video").forEach((v2) => {
        v2.removeAttribute("autoplay");
      });
      scheduleFit(svg);
    }
    thumb(slide) {
      const box2 = h("div", { class: "thumb" });
      if (slide.visibleIndex == null) {
        box2.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
        return box2;
      }
      const data = ed.slides[slide.visibleIndex];
      if (!data) return box2;
      const key = data.svg;
      const cached = this.cache.get(key);
      if (cached && !this.used.has(key)) {
        this.used.set(key, cached);
        return cached;
      }
      this.used.set(key, box2);
      this.svgs.set(box2, data.svg);
      const vb = parseViewBox(rootViewBox(data.svg));
      box2.style.aspectRatio = `${vb.w} / ${vb.h}`;
      const watch = this.observer();
      if (watch) watch.observe(box2);
      else this.draw(box2);
      return box2;
    }
  };
  var ROOT_VIEWBOX = /^<svg\b[^>]*?\sviewBox="([^"]*)"/;
  function rootViewBox(svg) {
    const open5 = svg.slice(0, svg.indexOf(">") + 1);
    return ROOT_VIEWBOX.exec(open5)?.[1] ?? null;
  }
  var thumbs3 = new Thumbs(list2);
  var dragging = { now: null };
  function dragSlides(i2) {
    if (ed.slideSelection.size > 1 && ed.slideSelection.has(i2)) {
      return [...ed.slideSelection].sort((a2, b2) => a2 - b2);
    }
    return [i2];
  }
  var DROP_MARKS = ["drop-before", "drop-after", "drop-into"];
  function clearDropMarks(root2) {
    root2.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach(
      (el2) => {
        el2.classList.remove(...DROP_MARKS);
      }
    );
  }
  function markGap(root2, gap, last) {
    clearDropMarks(root2);
    const head = root2.querySelector(`.section-head[data-section="${gap}"]`);
    if (head) head.classList.add("drop-before");
    else last?.classList.add("drop-after");
  }
  function headerGap(head, k2, e2) {
    const r2 = head.getBoundingClientRect();
    const lower = e2.clientY > r2.top + r2.height / 2;
    const s2 = sections()[k2];
    return lower && (isCollapsed(k2) || !s2?.count) ? k2 + 1 : k2;
  }
  function dropAtEnd(drag) {
    const all = sections();
    if (drag.kind === "section") {
      void moveSectionToGap(drag.section, all.length);
      return;
    }
    const n3 = ed.model?.slides.length ?? 0;
    void moveSlidesTo(drag.slides, n3, all.length ? all.length - 1 : null);
  }
  function slideItem(slide, i2) {
    const item2 = h(
      "div",
      {
        class: `sorter-item${i2 === ed.current ? " active" : ""}${ed.slideSelection.has(i2) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
        draggable: ed.model?.deckEditable ? "true" : null,
        title: slide.title ?? slide.id ?? slide.src,
        "data-index": i2
      },
      h("span", { class: "sorter-num" }, String(i2 + 1)),
      thumbs3.thumb(slide),
      slide.visible ? starButton(i2) : null,
      changeBadge(i2),
      problemBadge(i2),
      commentBadge(i2)
    );
    item2.classList.toggle("starred", isStarred(i2));
    item2.addEventListener("click", (e2) => pickSlide(i2, e2));
    item2.addEventListener("contextmenu", (e2) => {
      e2.preventDefault();
      ed.focus = "sorter";
      if (!ed.slideSelection.has(i2)) {
        ed.slideSelection.clear();
        gotoSlide(i2);
      }
      openSlideMenu(e2.clientX, e2.clientY, i2);
    });
    item2.addEventListener("dragstart", (e2) => {
      dragging.now = { kind: "slides", slides: dragSlides(i2) };
      e2.dataTransfer?.setData("text/plain", String(i2));
      item2.classList.add("dragging");
    });
    item2.addEventListener("dragend", () => {
      dragging.now = null;
      item2.classList.remove("dragging");
      clearDropMarks(list2);
    });
    item2.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        const gap = sectionGapAtSlide(sections(), i2);
        markGap(list2, gap, list2.lastElementChild);
        return;
      }
      const r2 = item2.getBoundingClientRect();
      clearDropMarks(list2);
      item2.classList.add(
        e2.clientY > r2.top + r2.height / 2 ? "drop-after" : "drop-before"
      );
    });
    item2.addEventListener("drop", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      const drag = dragging.now;
      clearDropMarks(list2);
      if (!drag) return;
      if (drag.kind === "section") {
        const gap = sectionGapAtSlide(sections(), i2);
        void moveSectionToGap(drag.section, gap);
        return;
      }
      const r2 = item2.getBoundingClientRect();
      const after = e2.clientY > r2.top + r2.height / 2;
      const target = dropOnSlide(sections(), i2, after);
      void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return item2;
  }
  function headerItem(k2) {
    const head = sectionHeader(k2, "sorter", (e2) => {
      if (e2.ctrlKey || e2.metaKey || e2.shiftKey) selectSection(k2);
    });
    head.addEventListener("dragstart", (e2) => {
      dragging.now = { kind: "section", section: k2 };
      e2.dataTransfer?.setData("text/plain", `section:${k2}`);
      head.classList.add("dragging");
    });
    head.addEventListener("dragend", () => {
      dragging.now = null;
      head.classList.remove("dragging");
      clearDropMarks(list2);
    });
    head.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        markGap(list2, headerGap(head, k2, e2), list2.lastElementChild);
        return;
      }
      clearDropMarks(list2);
      head.classList.add("drop-into");
    });
    head.addEventListener("drop", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      const drag = dragging.now;
      clearDropMarks(list2);
      if (!drag) return;
      if (drag.kind === "section") {
        void moveSectionToGap(drag.section, headerGap(head, k2, e2));
        return;
      }
      const target = dropOnHeader(sections(), k2);
      void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return head;
  }
  var drawn = [];
  var items = [];
  function rowFacts(row7) {
    const editable = !!ed.model?.deckEditable;
    if (row7.kind === "header") {
      const s2 = sections()[row7.section];
      const text = `h ${row7.section} ${s2?.count} ${isCollapsed(row7.section)} ${editable} ${s2?.name}`;
      return { text, svg: void 0 };
    }
    const slide = ed.model?.slides[row7.index];
    const data = slide?.visibleIndex != null ? ed.slides[slide.visibleIndex] : null;
    return {
      text: `s ${row7.index} ${slide?.visible} ${editable} ${slide?.title ?? slide?.id ?? slide?.src}`,
      svg: data?.svg
    };
  }
  function rowItem(row7) {
    const slides = ed.model?.slides ?? [];
    return row7.kind === "header" ? headerItem(row7.section) : slideItem(slides[row7.index], row7.index);
  }
  function markRows() {
    for (const item2 of items) {
      if (!item2.classList.contains("sorter-item")) continue;
      const i2 = Number(item2.dataset.index);
      item2.classList.toggle("active", i2 === ed.current);
      item2.classList.toggle("picked", ed.slideSelection.has(i2));
      markStar(item2, i2);
      markChange(item2, i2);
      markProblems(item2, i2);
      markComments(item2, i2);
    }
  }
  function renderSorter(anew = false) {
    const slides = ed.model?.slides ?? [];
    const rows = sorterRows(slides.length, sections(), isCollapsed);
    const facts = rows.map(rowFacts);
    const sameRows = !anew && !headerPending() && facts.length === drawn.length && facts.every((f2, i2) => f2.text === drawn[i2].text);
    const before = list2.querySelector(".active");
    if (sameRows) {
      facts.forEach((f2, i2) => {
        if (f2.svg === drawn[i2].svg) return;
        const fresh = rowItem(rows[i2]);
        items[i2].replaceWith(fresh);
        items[i2] = fresh;
        thumbs3.forget(drawn[i2].svg);
      });
      drawn = facts;
      markRows();
    } else {
      const top = list2.scrollTop;
      drawn = facts;
      clear(list2);
      thumbs3.begin();
      items = rows.map(rowItem);
      list2.append(...items);
      thumbs3.end();
      list2.scrollTop = top;
    }
    const active3 = list2.querySelector(".active");
    if (active3 !== before || !sameRows) {
      active3?.scrollIntoView({ block: "nearest" });
    }
    emit("sorter");
  }
  function initListDrop() {
    list2.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag || e2.target !== list2) return;
      e2.preventDefault();
      if (drag.kind === "section") {
        markGap(list2, sections().length, list2.lastElementChild);
      } else {
        clearDropMarks(list2);
        list2.lastElementChild?.classList.add("drop-after");
      }
    });
    list2.addEventListener("drop", (e2) => {
      const drag = dragging.now;
      if (!drag || e2.target !== list2) return;
      e2.preventDefault();
      clearDropMarks(list2);
      dropAtEnd(drag);
    });
  }
  function followSelect(i2) {
    pendingSelect = i2;
  }
  async function newSlide(layout2, after = ed.current) {
    const result = await edit({
      action: "slide",
      op: "new",
      after,
      layout: layout2,
      name: "slide"
    });
    if (result.ok && result.select != null) pendingSelect = result.select;
  }
  async function newSlideLike(i2 = ed.current) {
    const result = await edit({
      action: "slide",
      op: "new",
      after: i2,
      like: i2,
      name: "slide"
    });
    if (result.ok && result.select != null) pendingSelect = result.select;
  }
  async function duplicateSlide(i2 = ed.current) {
    const result = await edit({ action: "slide", op: "duplicate", slide: i2 });
    if (result.ok && result.select != null) pendingSelect = result.select;
  }
  async function deleteSlide(i2 = ed.current) {
    const slide = ed.model?.slides[i2];
    if (!slide) return;
    const req = { action: "slide", op: "delete", slide: i2 };
    const answer = await askSlideDelete(slideQuestion([slideName4(i2)]), 1, req);
    if (!answer) return;
    const result = await edit({ ...req, files: answer.files });
    if (result.ok) {
      ed.current = Math.max(0, i2 - 1);
      emit("slide");
    }
  }
  function slideName4(i2) {
    const slide = ed.model?.slides[i2];
    return slide?.title ?? slide?.id ?? `slide ${i2 + 1}`;
  }
  async function toggleHidden(i2 = ed.current) {
    const slide = ed.model?.slides[i2];
    if (!slide) return;
    await edit({
      action: "slide",
      op: "hide",
      slide: i2,
      hidden: slide.visible
    });
  }
  var pendingSelect = null;
  function closeMenu() {
    menu4.classList.remove("open");
    clear(menu4);
  }
  function menuItem(label4, fn, disabled = false) {
    return h(
      "button",
      {
        type: "button",
        class: "menu-item",
        disabled,
        onclick: () => {
          closeMenu();
          fn();
        }
      },
      label4
    );
  }
  function openSlideMenu(x2, y2, i2) {
    const slide = ed.model?.slides[i2];
    const editable = !!ed.model?.deckEditable;
    const many = ed.slideSelection.size > 1;
    clear(menu4);
    menu4.append(
      menuItem(
        many ? `Copy ${ed.slideSelection.size} slides` : "Copy",
        () => void copySlides()
      )
    );
    menu4.append(
      menuItem(
        many ? "Cut slides" : "Cut",
        () => void cutSlides(),
        !editable
      )
    );
    menu4.append(
      menuItem(
        "Paste after this slide",
        () => void pasteFromClipboard(),
        !editable
      )
    );
    if (many) {
      menu4.append(
        menuItem(
          `Star ${ed.slideSelection.size} slides (or take their stars off)`,
          () => void toggleStar([...ed.slideSelection])
        )
      );
      menu4.append(
        menuItem(
          `Delete ${ed.slideSelection.size} slides`,
          () => void deleteSlides(),
          !editable
        )
      );
      menu4.append(...slideGitItems(i2, menuItem));
      showMenu(x2, y2);
      return;
    }
    menu4.append(
      menuItem(
        "New slide after\u2026",
        () => void openGallery({ mode: "insert", after: i2 }),
        !editable
      )
    );
    menu4.append(menuItem("Duplicate", () => void duplicateSlide(i2), !editable));
    menu4.append(
      menuItem(
        slide?.visible ? "Hide (skip in presentation)" : "Show",
        () => void toggleHidden(i2),
        !editable
      )
    );
    if (slide?.visible) {
      menu4.append(
        menuItem(
          isStarred(i2) ? "Take the star off" : "Star",
          () => void toggleStar([i2])
        )
      );
    }
    menu4.append(
      menuItem("Rename files\u2026", () => renameSlideFiles(i2), !editable)
    );
    menu4.append(menuItem("Save as layout\u2026", () => saveAsLayout(i2), !editable));
    menu4.append(menuItem("Delete", () => void deleteSlide(i2), !editable));
    menu4.append(
      menuItem("Add section here\u2026", () => void addSectionAt(i2), !editable)
    );
    const notes = commentItems(i2, menuItem);
    if (notes.length) menu4.append(h("div", { class: "menu-sep" }), ...notes);
    menu4.append(...slideGitItems(i2, menuItem));
    showMenu(x2, y2);
  }
  function showMenu(x2, y2) {
    menu4.classList.add("open");
    const r2 = menu4.getBoundingClientRect();
    menu4.style.left = `${Math.min(x2, window.innerWidth - r2.width - 8)}px`;
    menu4.style.top = `${Math.min(y2, window.innerHeight - r2.height - 8)}px`;
  }
  function initSorter() {
    on("model", () => {
      followPastedSlides();
      const n3 = ed.model?.slides.length ?? 0;
      if (pendingSelect != null && pendingSelect < n3) {
        ed.current = pendingSelect;
        pendingSelect = null;
        emit("slide");
      }
      if (ed.current >= n3) ed.current = Math.max(0, n3 - 1);
      renderSorter();
    });
    on("slide", () => {
      revealCurrent();
      renderSorter();
    });
    on("slide-selection", () => renderSorter());
    on("stars", () => renderSorter());
    on("slide-git", () => renderSorter());
    on("problems", () => renderSorter());
    on("comments", () => renderSorter());
    on("sections", () => renderSorter(true));
    initListDrop();
    addBtn.addEventListener("click", () => {
      if (!ed.model?.deckEditable) {
        toast(
          "deck.py builds its slides in code; add slides there",
          "error"
        );
        return;
      }
      void openGallery({ mode: "insert", after: ed.current });
    });
    document.addEventListener("pointerdown", (e2) => {
      if (!menu4.contains(e2.target)) closeMenu();
    });
    document.addEventListener("keydown", (e2) => {
      if (e2.key === "Escape") closeMenu();
    });
  }

  // src/ts/editor/collab.ts
  var collab = {
    me: null,
    people: []
  };
  function others() {
    return collab.people.filter((p2) => p2.id !== collab.me?.id);
  }
  function deckIndexOf(p2) {
    if (p2.slide == null) return null;
    if (p2.page !== "presenter") return p2.slide;
    const s2 = ed.model?.slides.find((x2) => x2.visibleIndex === p2.slide);
    return s2 ? s2.deckIndex : null;
  }
  function editorsOn(i2) {
    return others().filter((p2) => p2.page === "editor" && deckIndexOf(p2) === i2);
  }
  function myName() {
    return storedName() ?? collab.me?.name ?? "";
  }
  var timer2 = 0;
  var lastSent = "";
  function sendPresence(now = false) {
    window.clearTimeout(timer2);
    const go = () => {
      const msg = {
        type: "presence",
        page: "editor",
        key: clientKey(),
        ...myName() ? { name: myName() } : {},
        slide: ed.current,
        selection: ed.selection.map((s2) => s2.loc),
        editing: ed.richEditing ? "text" : null
      };
      const text = JSON.stringify(msg);
      if (text === lastSent) return;
      lastSent = text;
      sendRaw(msg);
    };
    if (now) go();
    else timer2 = window.setTimeout(go, 120);
  }
  function presenceConnected() {
    lastSent = "";
    sendPresence(true);
  }
  function welcome(msg) {
    collab.me = {
      id: String(msg.id ?? ""),
      role: String(msg.role ?? "owner"),
      color: String(msg.color ?? "#1c7ed6"),
      name: String(msg.name ?? "")
    };
    document.body.dataset.role = collab.me.role;
    document.body.classList.toggle("guest", collab.me.role !== "owner");
    const share = document.getElementById("btn-share");
    if (share) share.hidden = collab.me.role !== "owner";
    if (collab.me.role !== "owner" && !storedName()) askName2();
    renderPeople();
  }
  function setPeople(people) {
    collab.people = people;
    renderPeople();
    paintDots();
    drawOverlay();
  }
  var host2 = document.getElementById("people");
  function avatar(p2, me) {
    const where = p2.page === "presenter" ? `presenting, slide ${(p2.slide ?? 0) + 1}` : p2.slide != null ? `slide ${p2.slide + 1}` : "";
    const role = p2.role === "viewer" ? "viewer" : p2.role === "owner" ? "owner" : "editor";
    return h(
      "span",
      {
        class: `avatar${me ? " me" : ""}${p2.page === "presenter" ? " presenting" : ""}`,
        style: `--who:${p2.color}`,
        title: `${p2.name}${me ? " (you)" : ""} \xB7 ${role}${where ? ` \xB7 ${where}` : ""}`,
        "data-person": p2.id,
        onclick: me ? () => askName2() : () => {
          const i2 = deckIndexOf(p2);
          if (i2 != null) gotoSlide(i2);
        }
      },
      initials(p2.name || "?")
    );
  }
  function renderPeople() {
    if (!host2) return;
    clear(host2);
    const people = collab.people;
    host2.hidden = people.length < 2 && collab.me?.role === "owner";
    const mine = people.find((p2) => p2.id === collab.me?.id);
    if (mine) host2.append(avatar(mine, true));
    for (const p2 of others()) host2.append(avatar(p2, false));
  }
  function paintDots() {
    for (const old of document.querySelectorAll(".peer-dots")) old.remove();
    const byIndex = /* @__PURE__ */ new Map();
    for (const p2 of others()) {
      const i2 = deckIndexOf(p2);
      if (i2 == null) continue;
      byIndex.set(i2, [...byIndex.get(i2) ?? [], p2]);
    }
    for (const [i2, people] of byIndex) {
      const item2 = document.querySelector(`.sorter-item[data-index="${i2}"]`);
      if (!item2) continue;
      item2.append(
        h(
          "span",
          { class: "peer-dots" },
          ...people.map(
            (p2) => h("span", {
              class: "peer-dot",
              style: `background:${p2.color}`,
              title: p2.name
            })
          )
        )
      );
    }
  }
  function drawPeers(overlay3) {
    const svg = slideRoot();
    if (!svg) return;
    for (const p2 of editorsOn(ed.current)) {
      let labelled = false;
      for (const loc of p2.selection) {
        const el2 = svg.querySelector(`[data-ink="${CSS.escape(loc)}"]`);
        if (!(el2 instanceof SVGGraphicsElement)) continue;
        const corners = outlineOf(el2);
        if (!corners) continue;
        const g2 = svgEl("g", {
          class: "peer-sel",
          style: `--who:${p2.color}`
        });
        g2.append(
          svgEl("polygon", {
            points: corners.map((c2) => `${c2.x},${c2.y}`).join(" "),
            class: "peer-outline"
          })
        );
        if (!labelled) {
          labelled = true;
          const top = corners.reduce(
            (a2, b2) => b2.y < a2.y || b2.y === a2.y && b2.x < a2.x ? b2 : a2
          );
          const label4 = svgEl("text", {
            x: top.x,
            y: top.y - 5,
            class: "peer-label"
          });
          label4.textContent = p2.editing ? `${p2.name} (typing)` : p2.name;
          g2.append(label4);
        }
        overlay3.append(g2);
      }
    }
  }
  function askName2() {
    const input = h("input", {
      type: "text",
      value: myName(),
      maxlength: "40",
      placeholder: "Your name",
      "aria-label": "Your name"
    });
    const done = () => {
      const name2 = input.value.trim();
      if (!name2) return;
      saveName(name2);
      closeDialog();
      sendPresence(true);
    };
    input.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") done();
    });
    const body3 = h(
      "div",
      { class: "name-dialog" },
      h(
        "p",
        {},
        "The others editing this deck see you by this name, and your selection in your colour."
      ),
      input,
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "pbtn primary", onclick: done },
          "OK"
        )
      )
    );
    openDialog("Your name", body3);
    window.setTimeout(() => input.select(), 0);
  }
  function initCollab() {
    hooks.drawPeers = drawPeers;
    on("selection", () => sendPresence());
    on("render", () => sendPresence());
    on("model", () => sendPresence());
    on("sorter", paintDots);
  }

  // src/ts/editor/net.ts
  var ws = null;
  var nextId = 1;
  var pending2 = /* @__PURE__ */ new Map();
  var commandHandler = () => {
  };
  var pendingSlides = null;
  var resyncing = false;
  function take(held, sent2) {
    if (resyncing && !isWhole(sent2)) return null;
    const list4 = applyPatch(held, sent2);
    if (!list4 && !resyncing) {
      resyncing = true;
      sendRaw({ type: "resync" });
    }
    return list4;
  }
  function applyDeckSize(model2) {
    const size4 = model2.deckSize;
    if (!size4) return;
    const [w2, h3] = size4.canvas;
    setDeckCanvas(w2, h3);
    document.documentElement.style.setProperty("--deck-ar", `${w2} / ${h3}`);
  }
  function onCommand(fn) {
    commandHandler = fn;
  }
  var handlers = /* @__PURE__ */ new Map();
  var connectHooks = [];
  function onMessage(type, fn) {
    handlers.set(type, fn);
  }
  function onConnect(fn) {
    connectHooks.push(fn);
  }
  function connected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }
  var stopped = false;
  function stopReconnecting() {
    stopped = true;
  }
  var waiting = [];
  function whenConnected() {
    if (connected()) return Promise.resolve();
    return new Promise((resolve) => waiting.push(resolve));
  }
  function connect(port) {
    const sock = openSocket();
    ws = sock;
    sock.onopen = () => {
      presenceConnected();
      resyncing = false;
      sock.send(
        JSON.stringify({ type: "hello", role: "editor", patch: true })
      );
      document.body.classList.remove("offline");
      for (const resolve of waiting) resolve();
      waiting = [];
      for (const fn of connectHooks) fn();
    };
    sock.onclose = (ev) => {
      document.body.classList.add("offline");
      for (const resolve of pending2.values()) {
        resolve({ ok: false, error: "disconnected from the server" });
      }
      pending2.clear();
      if (ev.code === SENT_AWAY) {
        stopped = true;
        sentAway(ev.reason);
        return;
      }
      if (!stopped) window.setTimeout(() => connect(port), 1500);
    };
    sock.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "update": {
          const slides = take(
            pendingSlides ?? ed.slides,
            msg.slides
          );
          if (slides) pendingSlides = slides;
          if (msg.styles !== void 0 || msg.mode !== void 0) {
            ed.restyled = true;
          }
          applyDeckStyles(msg);
          ed.error = null;
          emit("error");
          break;
        }
        case "editor-model": {
          if (document.body.classList.contains("start-mode") || ed.model && msg.model.deckPath !== ed.model.deckPath) {
            location.assign("/edit");
            return;
          }
          const model2 = msg.model;
          const entries = take(
            ed.model?.slides ?? [],
            model2.slides
          );
          if (!entries) return;
          if (isWhole(model2.slides)) {
            resyncing = false;
          }
          model2.slides = entries;
          if (pendingSlides) {
            ed.slides = pendingSlides;
            pendingSlides = null;
          }
          ed.model = model2;
          applyDeckSize(ed.model);
          ed.rebuilt = true;
          if (msg.history) {
            setHistory(msg.history);
          }
          emit("model");
          break;
        }
        case "error":
          ed.error = String(msg.message ?? "build error");
          emit("error");
          break;
        case "edit-result": {
          const resolve = pending2.get(msg.id);
          pending2.delete(msg.id);
          resolve?.(msg);
          break;
        }
        case "editor-command":
          commandHandler(msg);
          break;
        case "agent-edit":
          agentEdit(msg);
          break;
        case "history":
          setHistory(msg);
          break;
        case "welcome":
          welcome(msg);
          break;
        case "presence":
          setPeople(msg.people ?? []);
          break;
        case "notify":
          toast(String(msg.message ?? ""));
          break;
        default:
          handlers.get(String(msg.type))?.(msg);
      }
    };
  }
  function setHistory(h3) {
    ed.canUndo = h3.canUndo ?? ed.canUndo;
    ed.canRedo = h3.canRedo ?? ed.canRedo;
    if ("undoLabel" in h3) ed.undoLabel = h3.undoLabel ?? null;
    if ("redoLabel" in h3) ed.redoLabel = h3.redoLabel ?? null;
    if ("undoBlockedBy" in h3) ed.undoBlockedBy = h3.undoBlockedBy ?? null;
    emit("history");
  }
  function sentAway(reason) {
    const box2 = document.getElementById("build-error");
    if (box2) {
      box2.textContent = `Disconnected: ${reason || "this link no longer opens the deck"}. Ask the person sharing it for a new link.`;
      box2.classList.add("show");
    }
  }
  function agentEdit(msg) {
    setHistory(msg);
    const label4 = String(msg.label ?? "Agent: changed the deck");
    const step2 = msg.step;
    if (!msg.mine) {
      toast(label4, "info");
      return;
    }
    toast(label4, "info", {
      label: "Undo",
      run: () => {
        void edit({
          action: "undo",
          ...typeof step2 === "number" ? { step: step2 } : {}
        });
      }
    });
  }
  function request(req) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast("Not connected to the inkflow server", "error");
      return Promise.resolve({ ok: false, error: "not connected" });
    }
    const id = nextId++;
    const sock = ws;
    const base2 = req.action === "undo" || req.action === "redo" ? {} : ed.model?.build != null ? { baseBuild: ed.model.build } : {};
    const cow = typeof req.file === "string" && ed.master?.slide.sources?.some(
      (s2) => s2.path === req.file && s2.copyTo != null
    ) ? { copyLayout: true } : {};
    return new Promise((resolve) => {
      pending2.set(id, (result) => {
        if (result.ok && result.copied) copied(result);
        resolve(result);
      });
      sock.send(
        JSON.stringify({ type: "edit-op", id, ...base2, ...cow, ...req })
      );
    });
  }
  function copied(result) {
    const info4 = result.copied;
    const hash = result.hashes?.[info4.to];
    for (const src of ed.master?.slide.sources ?? []) {
      if (src.path !== info4.from) continue;
      src.path = info4.to;
      src.copyTo = void 0;
      src.writable = true;
      if (hash) src.hash = hash;
    }
    if (ed.master?.path === info4.from) ed.master.path = info4.to;
    toast(info4.note, "info");
    emit("master-copied");
  }
  var pendingTimer = 0;
  function newerBuild(than, ms = 4e3) {
    return new Promise((resolve) => {
      const now = () => ed.model?.build != null && ed.model.build !== than;
      if (now()) {
        resolve(true);
        return;
      }
      const done = (ok) => {
        window.clearTimeout(timer6);
        off("model", check);
        resolve(ok);
      };
      const check = () => {
        if (now()) done(true);
      };
      const timer6 = window.setTimeout(() => done(false), ms);
      on("model", check);
    });
  }
  var TRANSIENT = /since the last build|wait for the reload/;
  async function edit(req, opts2 = {}) {
    const result = await request(req);
    if (!result.ok && result.stale && opts2.quietStale) return result;
    if (!result.ok && result.stale) {
      toast(
        result.error ?? "Changed by someone else meanwhile \u2014 updated",
        "error"
      );
      emit("stale");
      return result;
    }
    if (!result.ok && !(opts2.retrying && TRANSIENT.test(result.error ?? ""))) {
      toast(result.error ?? "edit failed", "error");
    }
    if (result.ok) {
      ed.canUndo = result.canUndo ?? ed.canUndo;
      ed.canRedo = result.canRedo ?? ed.canRedo;
      if ("undoLabel" in result) ed.undoLabel = result.undoLabel ?? null;
      if ("redoLabel" in result) ed.redoLabel = result.redoLabel ?? null;
      if (result.structural || req.action === "undo" || req.action === "redo") {
        ed.structuralPending = true;
        window.clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(() => {
          ed.structuralPending = false;
        }, 4e3);
      } else {
        updateHashes(result.hashes ?? {});
      }
      emit("history");
    }
    return result;
  }
  function updateHashes(hashes) {
    const shown3 = ed.master ? [ed.master.slide] : [];
    for (const slide of [...ed.model?.slides ?? [], ...shown3]) {
      for (const src of slide.sources ?? []) {
        if (!(src.path in hashes)) continue;
        src.hash = hashes[src.path];
        slide.key = void 0;
      }
    }
  }
  function sendRaw(payload) {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(payload));
  }

  // src/ts/editor/snap.ts
  function targetsFor(slide, others2) {
    const xs = [slide.x, slide.x + slide.width / 2, slide.x + slide.width];
    const ys = [slide.y, slide.y + slide.height / 2, slide.y + slide.height];
    for (const b2 of others2) {
      xs.push(b2.x, b2.x + b2.width / 2, b2.x + b2.width);
      ys.push(b2.y, b2.y + b2.height / 2, b2.y + b2.height);
    }
    return { xs, ys };
  }
  function best(edges, targets2, threshold) {
    let delta = 0;
    let dist = threshold + 1;
    for (const e2 of edges) {
      for (const t2 of targets2) {
        const d2 = Math.abs(t2 - e2);
        if (d2 < dist - 1e-9) {
          dist = d2;
          delta = t2 - e2;
        }
      }
    }
    if (dist > threshold) return { delta: 0, at: [] };
    const at3 = /* @__PURE__ */ new Set();
    for (const e2 of edges) {
      for (const t2 of targets2) {
        if (Math.abs(t2 - (e2 + delta)) < 1e-6) at3.add(t2);
      }
    }
    return { delta, at: [...at3] };
  }
  function snapBox(box2, targets2, threshold) {
    const x2 = best(
      [box2.x, box2.x + box2.width / 2, box2.x + box2.width],
      targets2.xs,
      threshold
    );
    const y2 = best(
      [box2.y, box2.y + box2.height / 2, box2.y + box2.height],
      targets2.ys,
      threshold
    );
    return { dx: x2.delta, dy: y2.delta, guidesX: x2.at, guidesY: y2.at };
  }
  function snapEdges(edgesX, edgesY, targets2, threshold) {
    const x2 = best(edgesX, targets2.xs, threshold);
    const y2 = best(edgesY, targets2.ys, threshold);
    return { dx: x2.delta, dy: y2.delta, guidesX: x2.at, guidesY: y2.at };
  }
  function distribute(boxes, axis) {
    const size4 = axis === "x" ? "width" : "height";
    const order2 = boxes.map((b2, i2) => ({ b: b2, i: i2 })).sort((p2, q) => p2.b[axis] - q.b[axis]);
    const out = boxes.map((b2) => b2[axis]);
    if (order2.length < 3) return out;
    const first = order2[0].b;
    const last = order2[order2.length - 1].b;
    const total2 = order2.reduce((s2, o2) => s2 + o2.b[size4], 0);
    const span = last[axis] + last[size4] - first[axis];
    const gap = (span - total2) / (order2.length - 1);
    let pos = first[axis];
    for (const o2 of order2) {
      out[o2.i] = pos;
      pos += o2.b[size4] + gap;
    }
    return out;
  }

  // src/ts/editor/canvas.ts
  var canvas = document.getElementById("canvas");
  var paper = document.getElementById("paper");
  var host3 = document.getElementById("slide-host");
  var overlay2 = document.getElementById("overlay");
  var NON_ZONES = /* @__PURE__ */ new Set(["zone-slide-number", "zone-slide-total"]);
  var DRAG_THRESHOLD = 3;
  var SNAP_PX = 6;
  var hooks = {
    editText: (_el) => {
    },
    editZone: (_zone, _el, _at) => {
    },
    // The element being edited in place (clicks inside it place the caret),
    // and how to finish that edit when the pointer goes elsewhere.
    editingHost: () => null,
    finishEditing: () => {
    },
    crop: (_el) => {
    },
    // Opens a draw.io diagram's editor; false when the picture is not one.
    diagram: (_el) => false,
    // A diagram shape's label, to be edited (its panel's Label field).
    cellLabel: (_el) => {
    },
    // Shapes of this drawn diagram were edited in its source (`step`: the
    // undo step): draw.io redraws its picture into that step.
    diagramEdited: (_diagram, _step) => {
    },
    typeInto: (_el) => {
    },
    zoneMedia: (_zone) => {
    },
    zoneText: (_zone) => {
    },
    // Select these ids once the rebuild that holds them has rendered.
    selectAfterRender: (_ids) => {
    },
    toolDown: (_e, _pt) => false,
    // Draws the others' selections on this slide (collab.ts).
    drawPeers: (_overlay) => {
    },
    // Draws the review comments' pins on this slide (comments.ts).
    drawComments: (_overlay) => {
    }
  };
  function slideRoot() {
    return host3.querySelector(":scope > svg");
  }
  function viewBoxSize() {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { w: vb.w, h: vb.h };
  }
  function scale() {
    const { w: w2, h: h3 } = viewBoxSize();
    if (ed.zoom > 0) return ed.zoom;
    const pad2 = 48;
    const availW = Math.max(100, canvas.clientWidth - pad2);
    const availH = Math.max(100, canvas.clientHeight - pad2);
    return Math.min(availW / w2, availH / h3);
  }
  function layoutPaper() {
    const svg = slideRoot();
    const { w: w2, h: h3 } = viewBoxSize();
    const s2 = scale();
    const pw = Math.round(w2 * s2);
    const ph = Math.round(h3 * s2);
    paper.style.width = `${pw}px`;
    paper.style.height = `${ph}px`;
    svg?.setAttribute("width", String(pw));
    svg?.setAttribute("height", String(ph));
    overlay2.setAttribute("width", String(pw));
    overlay2.setAttribute("height", String(ph));
    overlay2.setAttribute("viewBox", `0 0 ${pw} ${ph}`);
    canvas.classList.toggle("zoomed", ed.zoom > 0);
    canvas.style.padding = ed.zoom > 0 ? `${Math.round(canvas.clientHeight / 2)}px ${Math.round(canvas.clientWidth / 2)}px` : "";
    drawOverlay();
  }
  var drawnSvg = null;
  var drawnFacts = "";
  function canvasFacts() {
    const slide = currentSlide();
    if (!slide) return "";
    return JSON.stringify({ ...slide, notes: null, key: null });
  }
  function rebuilt() {
    const data = currentRendered();
    const same = !ed.interacting && !ed.richEditing && !ed.renderPending && !ed.restyled && (data?.svg ?? null) === drawnSvg && canvasFacts() === drawnFacts;
    if (!same) {
      render();
      return;
    }
    ed.structuralPending = false;
    ed.rebuilt = false;
    emit("selection");
  }
  function render() {
    if (ed.interacting || ed.richEditing) {
      ed.renderPending = true;
      return;
    }
    ed.renderPending = false;
    ed.restyled = false;
    const keep = ed.selection.map((s2) => ({
      loc: s2.loc,
      id: s2.el.getAttribute("id")
    }));
    const scopeKey = ed.scope?.getAttribute("data-ink") ?? null;
    const trustLoc = !ed.structuralPending;
    if (ed.rebuilt) ed.structuralPending = false;
    ed.rebuilt = false;
    const data = currentRendered();
    drawnSvg = data?.svg ?? null;
    drawnFacts = canvasFacts();
    host3.innerHTML = data ? data.svg : "";
    const hidden = currentSlide();
    if (!data && hidden && !hidden.visible) {
      host3.append(
        h(
          "div",
          { class: "hidden-note" },
          h("p", {}, "This slide is hidden: the presentation skips it."),
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => void edit({
                action: "slide",
                op: "hide",
                slide: hidden.deckIndex,
                hidden: false
              })
            },
            "Show it again to edit"
          )
        )
      );
    }
    const svg = slideRoot();
    if (svg) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.display = "block";
      prepareForEditing(svg);
      fitSlide(svg);
    }
    ed.scope = scopeKey ? host3.querySelector(`[data-ink="${scopeKey}"]`) : null;
    ed.selection = [];
    for (const k2 of keep) {
      const el2 = findElement(k2, trustLoc);
      if (el2 && selectable(el2)) addToSelection(el2, false);
    }
    layoutPaper();
    emit("render");
    emit("selection");
  }
  function findElement(k2, trustLoc) {
    const svg = slideRoot();
    if (!svg) return null;
    if (k2.id) {
      const byId2 = svg.querySelector(`[id="${CSS.escape(k2.id)}"]`);
      if (byId2?.hasAttribute("data-ink")) return byId2;
    }
    if (!trustLoc) return null;
    return svg.querySelector(
      `[data-ink="${k2.loc}"]`
    );
  }
  function prepareForEditing(svg) {
    svg.querySelectorAll("video").forEach((v2) => {
      v2.pause();
      v2.removeAttribute("autoplay");
      v2.removeAttribute("controls");
      v2.controls = false;
      const start = parseFloat(v2.dataset.start ?? "");
      if (start > 0) v2.currentTime = start;
    });
    if (ed.step == null) {
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
      });
    } else {
      applyStepInstant(svg, ed.step);
    }
    svg.querySelectorAll("a").forEach((a2) => {
      a2.addEventListener("click", (e2) => e2.preventDefault());
    });
  }
  function rootCTM() {
    const svg = slideRoot();
    const m2 = svg?.getScreenCTM();
    return m2 ? mat(m2) : { ...IDENTITY };
  }
  function paperOrigin() {
    const r2 = paper.getBoundingClientRect();
    return { x: r2.left, y: r2.top };
  }
  function slideToPaper() {
    const o2 = paperOrigin();
    return multiply({ a: 1, b: 0, c: 0, d: 1, e: -o2.x, f: -o2.y }, rootCTM());
  }
  function clientToSlide(x2, y2) {
    const inv = invert(rootCTM());
    return {
      x: inv.a * x2 + inv.c * y2 + inv.e,
      y: inv.b * x2 + inv.d * y2 + inv.f
    };
  }
  function measure(el2) {
    const g2 = el2;
    if (typeof g2.getBBox !== "function") return null;
    if (isDiagramCell(el2)) {
      const shape = cellShape(el2);
      const a2 = shape.getScreenCTM?.();
      const c2 = g2.getScreenCTM();
      if (shape !== el2 && a2 && c2) {
        const m2 = c2.inverse().multiply(a2);
        const b3 = shape.getBBox();
        const pts = [
          [b3.x, b3.y],
          [b3.x + b3.width, b3.y],
          [b3.x, b3.y + b3.height],
          [b3.x + b3.width, b3.y + b3.height]
        ].map(([x2, y2]) => new DOMPoint(x2, y2).matrixTransform(m2));
        const xs = pts.map((p2) => p2.x);
        const ys = pts.map((p2) => p2.y);
        return {
          bbox: {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys)
          },
          ctm: c2
        };
      }
    }
    if (el2.localName === "svg" && el2 !== slideRoot()) {
      const s2 = el2;
      const ctm2 = el2.parentElement?.getScreenCTM?.();
      if (!ctm2) return null;
      return {
        bbox: {
          x: s2.x.baseVal.value,
          y: s2.y.baseVal.value,
          width: s2.width.baseVal.value,
          height: s2.height.baseVal.value
        },
        ctm: ctm2
      };
    }
    const b2 = g2.getBBox();
    const ctm = g2.getScreenCTM();
    if (!ctm) return null;
    return { bbox: { x: b2.x, y: b2.y, width: b2.width, height: b2.height }, ctm };
  }
  function slideBox(el2) {
    try {
      const m2 = measure(el2);
      if (!m2) return null;
      const { bbox, ctm } = m2;
      const toSlide = multiply(invert(rootCTM()), mat(ctm));
      return transformBox(toSlide, {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height
      });
    } catch {
      return null;
    }
  }
  function slideSize() {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { x: vb.x, y: vb.y, width: vb.w, height: vb.h };
  }
  var GEOM_ATTRS = [
    "x",
    "y",
    "width",
    "height",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x1",
    "y1",
    "x2",
    "y2",
    "transform",
    "viewBox",
    // A connector's route and its attachments.
    "d",
    "inkflow:connect-start",
    "inkflow:connect-end",
    "inkflow:bend"
  ];
  function elementGeom(el2) {
    const parent = el2.parentElement;
    const parentCTM = parent?.getScreenCTM?.();
    const attrs2 = {};
    for (const a2 of GEOM_ATTRS) attrs2[a2] = el2.getAttribute(a2);
    let box2 = { x: 0, y: 0, width: 0, height: 0 };
    try {
      box2 = measure(el2)?.bbox ?? box2;
    } catch {
    }
    return {
      tag: el2.localName,
      sourceTag: el2.getAttribute("data-ink-tag") ?? el2.localName,
      attrs: attrs2,
      own: parseTransform(el2.getAttribute("transform")),
      parentToSlide: parentCTM ? multiply(invert(rootCTM()), mat(parentCTM)) : { ...IDENTITY },
      localBox: box2
    };
  }
  function isZone(el2) {
    const id = el2.getAttribute("id") ?? "";
    return id.startsWith("zone-") && !NON_ZONES.has(id);
  }
  function zoneName(el2) {
    return (el2.getAttribute("id") ?? "").replace(/^zone-/, "");
  }
  function mediaZoneAt(clientX, clientY) {
    const inside = (r2) => clientX >= r2.left && clientX <= r2.right && clientY >= r2.top && clientY <= r2.bottom;
    for (const el2 of overlay2.querySelectorAll("[data-media-zone]")) {
      if (inside(el2.getBoundingClientRect()))
        return el2.getAttribute("data-media-zone");
    }
    const slide = currentSlide();
    const svg = slideRoot();
    if (!slide || !svg) return null;
    for (const el2 of svg.querySelectorAll('[id^="zone-"]')) {
      const name2 = zoneName(el2);
      const kind = slide.zones[name2]?.kind;
      if ((kind === "image" || kind === "video") && inside(el2.getBoundingClientRect()))
        return name2;
    }
    return null;
  }
  function keyOf(el2) {
    const loc = el2.getAttribute("data-ink") ?? "";
    return parseInt(loc.split(":")[0] ?? "", 10);
  }
  function isLocked(el2) {
    return el2.closest("[data-ink-locked]") !== null;
  }
  function isOwn(el2) {
    const src = sourceOf(keyOf(el2));
    const slide = currentSlide();
    return !!src && src.role === "slide" && !!slide && !slide.srcShared && src.writable;
  }
  function editableCell(el2) {
    const diagram = el2.closest("svg[data-drawio]");
    return isDiagramCell(el2) && !!diagram && shapesEditable(diagram) && canTransform(diagram);
  }
  function selectable(el2) {
    if (!el2.hasAttribute("data-ink") || isLocked(el2)) return false;
    const src = sourceOf(keyOf(el2));
    if (!src) return false;
    if (ed.master) return src.path === ed.master.path;
    if (src.role === "diagram") return src.writable && editableCell(el2);
    if (src.role === "ink") return src.writable;
    if (ed.layoutMode) return src.writable;
    return isOwn(el2) || el2.hasAttribute("data-ink-top") && isZone(el2);
  }
  function canTransform(el2) {
    const src = sourceOf(keyOf(el2));
    if (ed.master) return src?.path === ed.master.path;
    if (!src?.writable) return false;
    if (src.role === "diagram") return editableCell(el2);
    if (src.role === "ink") return true;
    return ed.layoutMode || isOwn(el2);
  }
  function pick(x2, y2) {
    const svg = slideRoot();
    if (!svg) return null;
    for (const hit of document.elementsFromPoint(x2, y2)) {
      if (!svg.contains(hit)) continue;
      let node = hit;
      if (!(node instanceof SVGElement)) node = node.closest("foreignObject");
      while (node && node !== svg) {
        if (ed.scope) {
          if (node.parentElement === ed.scope && node.hasAttribute("data-ink")) {
            return selectable(node) ? node : null;
          }
        } else if (node.hasAttribute("data-ink-top") && selectable(node)) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return pickByBox(svg, x2, y2);
  }
  function canTypeInto(el2) {
    if (!["rect", "ellipse", "circle"].includes(el2.localName)) return false;
    if (!canTransform(el2) || ed.layoutMode || !isOwn(el2)) return false;
    return !isZone(el2) || el2.hasAttribute("inkflow:show-shape");
  }
  function isLineLike(el2) {
    return el2.localName === "line" || isConnector(el2);
  }
  function pickByBox(svg, x2, y2) {
    const pt = clientToSlide(x2, y2);
    const slide = slideSize();
    const pool = ed.scope ? [...ed.scope.children].filter((el2) => el2.hasAttribute("data-ink")) : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i2 = pool.length - 1; i2 >= 0; i2--) {
      const el2 = pool[i2];
      if (!selectable(el2) || isLineLike(el2)) continue;
      const b2 = slideBox(el2);
      if (!b2 || b2.width * b2.height > slide.width * slide.height * 0.8)
        continue;
      if (pt.x >= b2.x && pt.x <= b2.x + b2.width && pt.y >= b2.y && pt.y <= b2.y + b2.height) {
        return el2;
      }
    }
    return null;
  }
  function candidatesAt(x2, y2) {
    const svg = slideRoot();
    if (!svg) return [];
    const out = [];
    const add = (el2) => {
      if (el2 && !out.includes(el2) && selectable(el2)) {
        out.push(el2);
      }
    };
    const owner = (node) => {
      while (node && node !== svg) {
        if (ed.scope) {
          if (node.parentElement === ed.scope) return node;
        } else if (node.hasAttribute("data-ink-top")) return node;
        node = node.parentElement;
      }
      return null;
    };
    for (const hit of document.elementsFromPoint(x2, y2)) {
      if (!svg.contains(hit)) continue;
      const node = hit instanceof SVGElement ? hit : hit.closest("foreignObject");
      add(owner(node));
    }
    const pt = clientToSlide(x2, y2);
    const pool = ed.scope ? [...ed.scope.children] : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i2 = pool.length - 1; i2 >= 0; i2--) {
      if (isLineLike(pool[i2])) continue;
      const b2 = slideBox(pool[i2]);
      if (b2 && pt.x >= b2.x && pt.x <= b2.x + b2.width && pt.y >= b2.y && pt.y <= b2.y + b2.height) {
        add(pool[i2]);
      }
    }
    return out;
  }
  var cycle = null;
  function cycleSelect(e2) {
    const near = cycle !== null && Math.hypot(cycle.x - e2.clientX, cycle.y - e2.clientY) < 6;
    const all = candidatesAt(e2.clientX, e2.clientY);
    if (!all.length) {
      clearSelection();
      return;
    }
    const current3 = ed.selection.length === 1 ? ed.selection[0].el : null;
    let index = near && cycle ? cycle.index + 1 : 0;
    if (!near && current3 && all[0] === current3) index = 1;
    index %= all.length;
    cycle = { x: e2.clientX, y: e2.clientY, index };
    select([all[index]]);
    if (all.length > 1) {
      const name2 = all[index].getAttribute("id") ?? all[index].localName;
      toast(`${index + 1} of ${all.length} here: ${name2}`);
    }
  }
  function setHover(el2) {
    if (el2 !== hoverEl) {
      hoverEl = el2;
      drawOverlay();
    }
  }
  function toSelected(el2) {
    const loc = el2.getAttribute("data-ink") ?? "";
    return { el: el2, key: keyOf(el2), loc };
  }
  function addToSelection(el2, notify = true) {
    if (ed.selection.some((s2) => s2.el === el2)) return;
    ed.selection.push(toSelected(el2));
    if (notify) {
      drawOverlay();
      emit("selection");
    }
  }
  function select(els) {
    ed.selection = els.map(toSelected);
    drawOverlay();
    emit("selection");
  }
  function clearSelection() {
    if (!ed.selection.length) return;
    ed.selection = [];
    drawOverlay();
    emit("selection");
  }
  function selectAll() {
    const svg = slideRoot();
    if (!svg) return;
    const scope2 = ed.scope ?? svg;
    const els = [...scope2.querySelectorAll("[data-ink]")].filter(
      (el2) => (ed.scope ? el2.parentElement === ed.scope : el2.hasAttribute("data-ink-top")) && selectable(el2) && (canTransform(el2) || ed.scope !== null)
    );
    select(els);
  }
  function enterGroup(g2) {
    ed.scope = g2;
    clearSelection();
    drawOverlay();
    emit("selection");
  }
  var hoverEl = null;
  var guides = { xs: [], ys: [] };
  var marquee = null;
  function poly(points, cls) {
    return svgEl("polygon", {
      points: points.map((p2) => `${p2.x},${p2.y}`).join(" "),
      class: cls
    });
  }
  function outlineOf(el2) {
    return elementCorners(el2);
  }
  function elementCorners(el2) {
    try {
      const measured = measure(el2);
      if (!measured) return null;
      const b2 = measured.bbox;
      const ctm = measured.ctm;
      const o2 = paperOrigin();
      const m2 = mat(ctm);
      return [
        { x: b2.x, y: b2.y },
        { x: b2.x + b2.width, y: b2.y },
        { x: b2.x + b2.width, y: b2.y + b2.height },
        { x: b2.x, y: b2.y + b2.height }
      ].map((p2) => ({
        x: m2.a * p2.x + m2.c * p2.y + m2.e - o2.x,
        y: m2.b * p2.x + m2.d * p2.y + m2.f - o2.y
      }));
    } catch {
      return null;
    }
  }
  function toPaperBox(b2) {
    return transformBox(slideToPaper(), b2);
  }
  function selectionBox() {
    return unionBoxes(
      ed.selection.map((s2) => slideBox(s2.el)).filter((b2) => b2 !== null)
    );
  }
  var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  function handlePoint(h3, b2) {
    const cx = b2.x + b2.width / 2;
    const cy = b2.y + b2.height / 2;
    const r2 = b2.x + b2.width;
    const btm = b2.y + b2.height;
    switch (h3) {
      case "nw":
        return { x: b2.x, y: b2.y };
      case "n":
        return { x: cx, y: b2.y };
      case "ne":
        return { x: r2, y: b2.y };
      case "e":
        return { x: r2, y: cy };
      case "se":
        return { x: r2, y: btm };
      case "s":
        return { x: cx, y: btm };
      case "sw":
        return { x: b2.x, y: btm };
      case "w":
        return { x: b2.x, y: cy };
      case "rot":
        return { x: cx, y: b2.y - 28 };
      default:
        return { x: cx, y: cy };
    }
  }
  function drawOverlay() {
    while (overlay2.firstChild) overlay2.removeChild(overlay2.firstChild);
    const svg = slideRoot();
    if (!svg) return;
    drawPlaceholders();
    drawOverflowBadges();
    hooks.drawPeers(overlay2);
    hooks.drawComments(overlay2);
    if (ed.scope) {
      const c2 = elementCorners(ed.scope);
      if (c2) overlay2.append(poly(c2, "scope-outline"));
    }
    if (hoverEl && !ed.selection.some((s2) => s2.el === hoverEl)) {
      const c2 = elementCorners(hoverEl);
      if (c2) overlay2.append(poly(c2, "hover-outline"));
    }
    for (const s2 of ed.selection) {
      const c2 = elementCorners(s2.el);
      if (c2) {
        overlay2.append(
          poly(
            c2,
            canTransform(s2.el) ? "sel-outline" : "sel-outline content-only"
          )
        );
      }
    }
    if (ed.cropMode) drawCropGhost();
    drawSiteHints();
    const transformable = ed.selection.filter((s2) => canTransform(s2.el));
    const lone = ed.selection.length === 1 ? ed.selection[0].el : null;
    const connector = lone && isConnector(lone) && canTransform(lone) ? lone : null;
    const box2 = !connector && transformable.length === ed.selection.length ? selectionBox() : null;
    if (connector && ed.step == null) {
      const m2 = slideToPaper();
      for (const which of ["start", "end"]) {
        const end = connectorEnd(connector, which);
        if (!end) continue;
        const p2 = apply(m2, end);
        const attached = connector.hasAttribute(ENDS[which]);
        const handle2 = svgEl("circle", {
          cx: p2.x,
          cy: p2.y,
          r: 6,
          class: `handle endpoint${attached ? " attached" : ""}`
        });
        handle2.dataset.handle = `c-${which}`;
        overlay2.append(handle2);
      }
      const bend = connectorRoute(connector)?.bend;
      if (bend) {
        const p2 = apply(m2, bend.mid);
        const handle2 = svgEl("rect", {
          x: p2.x - 5,
          y: p2.y - 5,
          width: 10,
          height: 10,
          transform: `rotate(45 ${p2.x} ${p2.y})`,
          class: `handle bend ${bend.axis === "x" ? "ew" : "ns"}`
        });
        handle2.dataset.handle = "c-bend";
        overlay2.append(handle2);
      }
    }
    if (box2 && ed.step == null) {
      const pb = toPaperBox(box2);
      if (ed.selection.length > 1) {
        overlay2.append(
          svgEl("rect", {
            x: pb.x,
            y: pb.y,
            width: pb.width,
            height: pb.height,
            class: "group-outline"
          })
        );
      }
      const top = handlePoint("n", pb);
      const rot = handlePoint("rot", pb);
      overlay2.append(
        svgEl("line", {
          x1: top.x,
          y1: top.y,
          x2: rot.x,
          y2: rot.y,
          class: "rot-stem"
        })
      );
      const rh = svgEl("circle", {
        cx: rot.x,
        cy: rot.y,
        r: 6,
        class: "handle rot"
      });
      rh.dataset.handle = "rot";
      const frames = ed.selection.some(
        (s2) => s2.el.localName === "svg" && !s2.el.hasAttribute("data-drawio") && !s2.el.classList.contains("inkflow-chart") || isDiagramCell(s2.el)
      );
      if (!ed.cropMode && !frames) overlay2.append(rh);
      for (const h3 of HANDLES) {
        const p2 = handlePoint(h3, pb);
        const r2 = svgEl("rect", {
          x: p2.x - 5,
          y: p2.y - 5,
          width: 10,
          height: 10,
          class: `handle h-${h3}`
        });
        r2.dataset.handle = h3;
        overlay2.append(r2);
      }
    }
    for (const x2 of guides.xs) {
      const p2 = toPaperBox({ x: x2, y: 0, width: 0, height: slideSize().height });
      overlay2.append(
        svgEl("line", {
          x1: p2.x,
          y1: p2.y,
          x2: p2.x,
          y2: p2.y + p2.height,
          class: "guide"
        })
      );
    }
    for (const y2 of guides.ys) {
      const p2 = toPaperBox({ x: 0, y: y2, width: slideSize().width, height: 0 });
      overlay2.append(
        svgEl("line", {
          x1: p2.x,
          y1: p2.y,
          x2: p2.x + p2.width,
          y2: p2.y,
          class: "guide"
        })
      );
    }
    if (marquee) {
      const p2 = toPaperBox(marquee);
      overlay2.append(
        svgEl("rect", {
          x: p2.x,
          y: p2.y,
          width: p2.width,
          height: p2.height,
          class: "marquee"
        })
      );
    }
  }
  function drawCropGhost() {
    const frame = ed.selection[0]?.el;
    const image = frame ? [...frame.children].find((c3) => c3.localName === "image") : void 0;
    if (!image) return;
    const c2 = elementCorners(image);
    if (!c2) return;
    const xs = c2.map((p2) => p2.x);
    const ys = c2.map((p2) => p2.y);
    const ghost = svgEl("image", {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      href: image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "",
      preserveAspectRatio: image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet",
      class: "crop-ghost"
    });
    overlay2.append(ghost, poly(c2, "crop-extent"));
  }
  var MEDIA_ZONES = /media|image|img|picture|photo|figure|video|logo/;
  function drawOverflowBadges() {
    const svg = slideRoot();
    if (!svg || ed.step != null) return;
    for (const fo of Array.from(
      svg.querySelectorAll("foreignObject[data-inkflow-overflow]")
    )) {
      const c2 = elementCorners(fo);
      if (!c2) continue;
      const xs = c2.map((p2) => p2.x);
      const ys = c2.map((p2) => p2.y);
      const right = Math.max(...xs);
      const bottom = Math.max(...ys);
      const text = "Doesn't fit";
      const w2 = 14 + text.length * 6.6;
      const g2 = svgEl("g", { class: "overflow-badge" });
      g2.append(
        svgEl("rect", {
          x: right - w2 - 4,
          y: bottom - 26,
          width: w2,
          height: 20,
          rx: 10
        })
      );
      const label4 = svgEl("text", {
        x: right - 4 - w2 / 2,
        y: bottom - 12,
        "text-anchor": "middle"
      });
      label4.textContent = text;
      g2.append(label4);
      const title3 = svgEl("title");
      title3.textContent = fo.hasAttribute("data-inkflow-fit") ? "The text does not fit even shrunk as far as it goes: shorten it or make the box taller" : "The text does not fit its box";
      g2.append(title3);
      g2.addEventListener("pointerdown", (e2) => {
        if (!selectable(fo)) return;
        e2.stopPropagation();
        e2.preventDefault();
        select([fo]);
      });
      overlay2.append(g2);
    }
  }
  function drawPlaceholders() {
    const slide = currentSlide();
    if (!slide?.emptyZones || ed.step != null || ed.master) return;
    for (const z of slide.emptyZones) {
      const key = parseInt(z.locator.split(":")[0] ?? "", 10);
      const src = sourceOf(key);
      if (!src || z.zone === "slide-number" || z.zone === "slide-total")
        continue;
      const own = parseTransform(z.transform);
      const box2 = transformBox(own, z);
      const pb = toPaperBox(box2);
      const media = MEDIA_ZONES.test(z.zone);
      const outline = svgEl("rect", {
        x: pb.x,
        y: pb.y,
        width: pb.width,
        height: pb.height,
        rx: 4,
        class: "placeholder-outline"
      });
      if (media) outline.setAttribute("data-media-zone", z.zone);
      overlay2.append(outline);
      const g2 = svgEl("g", { class: "placeholder" });
      const text = media ? `+ media \xB7 ${z.hint ?? z.zone}` : `+ ${z.hint ?? z.zone}`;
      const w2 = 14 + text.length * 7.2;
      const tx = pb.x + 6;
      const ty = pb.y + 6;
      g2.append(svgEl("rect", { x: tx, y: ty, width: w2, height: 22, rx: 11 }));
      const label4 = svgEl("text", {
        x: tx + w2 / 2,
        y: ty + 15,
        "text-anchor": "middle"
      });
      label4.textContent = text;
      g2.append(label4);
      const title3 = svgEl("title");
      title3.textContent = media ? `Add an image or video to the ${z.zone} zone` : `Add ${z.zone} text`;
      g2.append(title3);
      g2.addEventListener("pointerdown", (e2) => {
        e2.stopPropagation();
        e2.preventDefault();
        if (media) hooks.zoneMedia(z.zone);
        else hooks.zoneText(z.zone);
      });
      overlay2.append(g2);
    }
  }
  var CONNECTOR = "inkflow:connector";
  var ENDS = { start: "inkflow:connect-start", end: "inkflow:connect-end" };
  var SNAP_SITE_PX = 14;
  function isConnector(el2) {
    return el2.hasAttribute(CONNECTOR);
  }
  function connectorStyle(el2) {
    const v2 = el2.getAttribute(CONNECTOR);
    return v2 === "elbow" || v2 === "curved" ? v2 : "straight";
  }
  function toSlideMat(el2) {
    const ctm = el2.getScreenCTM?.();
    return ctm ? multiply(invert(rootCTM()), mat(ctm)) : null;
  }
  var SITES = "inkflow:sites";
  function sitesPerSide(el2) {
    const n3 = Number(el2.getAttribute(SITES) ?? 1);
    return Number.isFinite(n3) ? Math.max(1, Math.min(MAX_SITES, Math.round(n3))) : 1;
  }
  function cornersOf(el2) {
    try {
      const m2 = measure(attachableCell(el2) ? cellShape(el2) : el2);
      if (!m2) return null;
      const toSlide = multiply(invert(rootCTM()), mat(m2.ctm));
      const b2 = m2.bbox;
      if (b2.width <= 0 && b2.height <= 0) return null;
      const tag = el2.getAttribute("data-ink-tag") ?? el2.localName;
      return {
        corners: [
          { x: b2.x, y: b2.y },
          { x: b2.x + b2.width, y: b2.y },
          { x: b2.x + b2.width, y: b2.y + b2.height },
          { x: b2.x, y: b2.y + b2.height }
        ].map((p2) => apply(toSlide, p2)),
        round: tag === "ellipse" || tag === "circle"
      };
    } catch {
      return null;
    }
  }
  function sitesOf(el2) {
    const c2 = cornersOf(el2);
    return c2 ? sitesFromCorners(c2.corners, sitesPerSide(el2), c2.round) : null;
  }
  function siteOf(el2, name2) {
    const c2 = cornersOf(el2);
    return c2 ? siteByName(c2.corners, name2, c2.round) : null;
  }
  function byId(id) {
    return slideRoot()?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;
  }
  function attachables(except) {
    const svg = slideRoot();
    if (!svg) return [];
    const pool = ed.scope ? [...ed.scope.children] : [...svg.querySelectorAll("[data-ink-top]")];
    const area2 = slideSize();
    const objects = pool.filter((el2) => {
      if (el2 === except || isConnector(el2) || !el2.hasAttribute("data-ink"))
        return false;
      const b2 = slideBox(el2);
      return !!b2 && b2.width * b2.height < area2.width * area2.height * 0.8;
    });
    const cells = objects.flatMap(
      (el2) => el2.hasAttribute("data-drawio") ? attachableCells(el2) : []
    );
    return [...objects, ...cells];
  }
  function attachTargetAt(x2, y2, except = null) {
    const svg = slideRoot();
    for (const hit of document.elementsFromPoint(x2, y2)) {
      if (!svg?.contains(hit)) continue;
      const cell = attachableCell(hit);
      if (cell) return cell;
    }
    return candidatesAt(x2, y2).find((el2) => el2 !== except && !isConnector(el2)) ?? null;
  }
  function siteAt(p2, except) {
    const within = SNAP_SITE_PX / (scale() || 1);
    let best2 = null;
    let bestD = within;
    for (const el2 of attachables(except)) {
      const s2 = nearestSite(sitesOf(el2) ?? [], p2, bestD);
      if (s2) {
        best2 = { el: el2, site: s2 };
        bestD = Math.hypot(s2.x - p2.x, s2.y - p2.y);
      }
    }
    return best2;
  }
  var siteHints = [];
  function showSites(hints) {
    siteHints = hints;
    drawOverlay();
  }
  function drawSiteHints() {
    const m2 = slideToPaper();
    for (const { el: el2, active: active3 } of siteHints) {
      for (const s2 of sitesOf(el2) ?? []) {
        const p2 = apply(m2, s2);
        const on2 = active3?.name === s2.name && Math.hypot(active3.x - s2.x, active3.y - s2.y) < 0.5;
        overlay2.append(
          svgEl("circle", {
            cx: p2.x,
            cy: p2.y,
            r: on2 ? 6 : 4,
            class: `site${on2 ? " on" : ""}`
          })
        );
      }
    }
  }
  function connectorEnd(conn, which) {
    const c2 = parseConnection(conn.getAttribute(ENDS[which]));
    if (c2) {
      const target = byId(c2.id);
      const site = target ? siteOf(target, c2.site) : null;
      if (site) return site;
    }
    const pts = endpointsOf(conn.getAttribute("d") ?? "");
    const m2 = toSlideMat(conn);
    if (!pts || !m2) return null;
    return apply(m2, which === "start" ? pts.start : pts.end);
  }
  function isStale(conn) {
    const pts = endpointsOf(conn.getAttribute("d") ?? "");
    const m2 = toSlideMat(conn);
    if (!pts || !m2) return false;
    for (const which of ["start", "end"]) {
      const c2 = parseConnection(conn.getAttribute(ENDS[which]));
      const target = c2 ? byId(c2.id) : null;
      const site = c2 && target ? siteOf(target, c2.site) : null;
      if (!site) continue;
      const drawn2 = apply(m2, which === "start" ? pts.start : pts.end);
      if (Math.hypot(drawn2.x - site.x, drawn2.y - site.y) > 1) return true;
    }
    return false;
  }
  function connectorsTo(id) {
    const svg = slideRoot();
    if (!svg) return [];
    return [
      ...svg.querySelectorAll(`[${CSS.escape(CONNECTOR)}][data-ink]`)
    ].filter(
      (conn) => canTransform(conn) && ["start", "end"].some((w2) => {
        const c2 = parseConnection(conn.getAttribute(ENDS[w2]));
        return !!c2 && (c2.id === id || c2.id.startsWith(`${id}-`));
      })
    );
  }
  function rerouteConnectors(conns, label4 = "Re-route arrows", coalesce) {
    const plans = conns.flatMap((el2) => {
      const d2 = connectorPath(el2);
      const sel = toSelected(el2);
      return d2 ? [{ sel, ops: [{ kind: "attrs", loc: sel.loc, set: { d: d2 } }] }] : [];
    });
    return plans.length ? sendSvgOps(plans, label4, coalesce) : null;
  }
  var BEND = "inkflow:bend";
  function connectorRoute(conn, ends = {}, style = connectorStyle(conn), bend = parseBend(conn.getAttribute(BEND))) {
    const a2 = ends.start ?? connectorEnd(conn, "start");
    const b2 = ends.end ?? connectorEnd(conn, "end");
    if (!a2 || !b2) return null;
    return route(style, a2, b2, bend);
  }
  function connectorPath(conn, ends = {}, style = connectorStyle(conn), bend = parseBend(conn.getAttribute(BEND))) {
    const r2 = connectorRoute(conn, ends, style, bend);
    const toSlide = toSlideMat(conn);
    if (!r2 || !toSlide) return null;
    const local = invert(toSlide);
    return pathData({ ...r2, points: r2.points.map((p2) => apply(local, p2)) });
  }
  function newConnectorPath(style, a2, b2, parent) {
    const svg = slideRoot();
    const pm = parent?.getScreenCTM?.();
    const local = pm && svg ? multiply(invert(mat(pm)), rootCTM()) : IDENTITY;
    const r2 = route(style, a2, b2);
    return pathData({ ...r2, points: r2.points.map((p2) => apply(local, p2)) });
  }
  var GEOMETRY = /* @__PURE__ */ new Set([...GEOM_ATTRS, "points"]);
  function geometryChanged(ops) {
    return ops.some(
      (op) => op.kind === "attrs" && Object.keys(op.set ?? {}).some(
        (k2) => GEOMETRY.has(k2)
      )
    );
  }
  function withConnectors(plans) {
    const svg = slideRoot();
    if (!svg) return plans;
    const moved = plans.filter((p2) => geometryChanged(p2.ops)).map((p2) => p2.sel.el);
    if (!moved.length) return plans;
    for (const p2 of plans) {
      for (const op of p2.ops) {
        if (op.kind === "attrs" && op.loc === p2.sel.loc) {
          applyPlanToDom(p2.sel.el, op.set);
        }
      }
    }
    const touches = (conn) => ["start", "end"].some((w2) => {
      const c2 = parseConnection(conn.getAttribute(ENDS[w2]));
      const target = c2 ? byId(c2.id) : null;
      return !!target && moved.some((m2) => m2 === target || m2.contains(target));
    });
    const out = [...plans];
    for (const conn of svg.querySelectorAll(`[${CSS.escape(CONNECTOR)}]`)) {
      if (!conn.hasAttribute("data-ink") || !canTransform(conn) || !touches(conn))
        continue;
      const d2 = connectorPath(conn);
      if (!d2) continue;
      applyPlanToDom(conn, { d: d2 });
      const loc = conn.getAttribute("data-ink") ?? "";
      const existing = out.find((p2) => p2.sel.el === conn);
      const op = { kind: "attrs", loc, set: { d: d2 } };
      if (existing) existing.ops = [...existing.ops, op];
      else
        out.push({
          sel: toSelected(conn),
          ops: [op]
        });
    }
    return out;
  }
  var movingTogether = [];
  function connectorMoveOps(sel, dx, dy) {
    const conn = sel.el;
    const set = {};
    const ends = {};
    for (const w2 of ["start", "end"]) {
      const c2 = parseConnection(conn.getAttribute(ENDS[w2]));
      const target = c2 ? byId(c2.id) : null;
      const kept = !!target && movingTogether.some((m2) => m2 === target || m2.contains(target));
      const here = connectorEnd(conn, w2);
      if (!kept) {
        if (c2) set[ENDS[w2]] = null;
        if (here) ends[w2] = { x: here.x + dx, y: here.y + dy };
      }
    }
    for (const [k2, v2] of Object.entries(set)) {
      if (v2 === null) conn.removeAttribute(k2);
    }
    let bend = parseBend(conn.getAttribute(BEND));
    if (bend) {
      bend = { ...bend, at: bend.at + (bend.axis === "x" ? dx : dy) };
      set[BEND] = formatBend(bend);
    }
    const d2 = connectorPath(conn, ends, connectorStyle(conn), bend);
    if (d2) set.d = d2;
    applyPlanToDom(conn, { d: set.d ?? null });
    return [{ kind: "attrs", loc: sel.loc, set }];
  }
  function freshId(base2) {
    const svg = slideRoot();
    let n3 = 1;
    while (svg?.querySelector(`[id="${base2}-${n3}"]`)) n3++;
    return `${base2}-${n3}`;
  }
  function endpointPlans(drag, p2, e2) {
    const sel = drag.snaps[0].sel;
    const conn = sel.el;
    const hit = e2.altKey ? null : siteAt(p2, conn);
    const under = attachTargetAt(e2.clientX, e2.clientY, conn);
    siteHints = [
      ...under ? [
        {
          el: under,
          active: hit?.el === under ? hit.site : null
        }
      ] : [],
      ...hit && hit.el !== under ? [{ el: hit.el, active: hit.site }] : []
    ];
    const ops = [];
    let attach = null;
    if (hit) {
      let id = hit.el.getAttribute("id");
      if (!id && keyOf(hit.el) === sel.key) {
        id = freshId(hit.el.localName);
        hit.el.setAttribute("id", id);
        ops.push({ kind: "id", loc: hit.el.getAttribute("data-ink"), id });
      }
      if (id) attach = `${id}:${hit.site.name}`;
    }
    const end = attach && hit ? hit.site : p2;
    const d2 = connectorPath(conn, { [drag.which]: end });
    if (!d2) return [];
    applyPlanToDom(conn, { d: d2 });
    ops.push({
      kind: "attrs",
      loc: sel.loc,
      set: { d: d2, [ENDS[drag.which]]: attach }
    });
    return [{ sel, ops }];
  }
  function bendPlans(drag, p2) {
    const sel = drag.snaps[0].sel;
    const conn = sel.el;
    const current3 = connectorRoute(conn)?.bend;
    if (!current3) return [];
    const bend = {
      axis: current3.axis,
      at: Math.round(current3.axis === "x" ? p2.x : p2.y)
    };
    const d2 = connectorPath(conn, {}, "elbow", bend);
    if (!d2) return [];
    applyPlanToDom(conn, { d: d2 });
    return [
      {
        sel,
        ops: [
          {
            kind: "attrs",
            loc: sel.loc,
            set: { d: d2, [BEND]: formatBend(bend) }
          }
        ]
      }
    ];
  }
  function opsByFile(plans) {
    const out = /* @__PURE__ */ new Map();
    for (const { sel, ops } of plans) {
      const src = sourceOf(sel.key);
      if (!src) continue;
      const list4 = out.get(src.path) ?? [];
      list4.push(...ops);
      out.set(src.path, list4);
    }
    return out;
  }
  async function sendSvgOps(plans, label4, coalesce, ids) {
    const slide = currentSlide();
    if (!slide) return false;
    if (ed.structuralPending) {
      toast("One moment: the last change is still being applied");
      return false;
    }
    const run = queue.then(() => sendQueued(plans, label4, coalesce, ids));
    queue = run.catch(() => false);
    return run;
  }
  var queue = Promise.resolve();
  async function sendQueued(plans, label4, coalesce, ids) {
    const slide = currentSlide();
    if (!slide) return false;
    let ok = true;
    plans = withConnectors(plans);
    const cells = diagramPlans(plans);
    plans = cells.plans;
    if (cells.diagrams.size && !coalesce) coalesce = `diagram-${Date.now()}`;
    for (const [path, ops] of opsByFile(plans)) {
      const src = slide.sources?.find((s2) => s2.path === path);
      if (src && src.usedBy.length > 1 && ed.layoutMode) {
        toast(`Edited ${src.rel}: affects ${src.usedBy.length} slides`);
      }
      const result = await edit({
        action: "svg",
        file: path,
        hash: src?.hash ?? "",
        ops,
        label: label4,
        coalesce,
        // Deleting or duplicating a zone takes its content along (not in
        // layout mode: a layout's zones are filled by every slide).
        zoneSlide: ed.layoutMode ? void 0 : slide.deckIndex
      });
      ok = ok && result.ok;
      if (ids && result.ids) Object.assign(ids, result.ids);
    }
    if (ok && coalesce) {
      for (const diagram of cells.diagrams)
        hooks.diagramEdited(diagram, coalesce);
    }
    return ok;
  }
  function applyPlanToDom(el2, plan2) {
    for (const [k2, v2] of Object.entries(plan2)) {
      if (v2 == null) el2.removeAttribute(k2);
      else el2.setAttribute(k2, v2);
    }
  }
  function textChildren(el2) {
    return [...el2.querySelectorAll("tspan")].filter(
      (t2) => t2.hasAttribute("x") || t2.hasAttribute("y")
    );
  }
  function moveOps(sel, dx, dy) {
    if (isConnector(sel.el) && sel.el.getAttribute("d")) {
      return connectorMoveOps(sel, dx, dy);
    }
    const kids = textChildren(sel.el);
    const plan2 = planMove(
      elementGeom(sel.el),
      dx,
      dy,
      kids.map((k2) => ({
        attrs: { x: k2.getAttribute("x"), y: k2.getAttribute("y") }
      }))
    );
    const ops = [{ kind: "attrs", loc: sel.loc, set: plan2.attrs }];
    applyPlanToDom(sel.el, plan2.attrs);
    plan2.children?.forEach((p2, i2) => {
      const loc = kids[i2].getAttribute("data-ink");
      if (loc && Object.keys(p2).length) {
        ops.push({ kind: "attrs", loc, set: p2 });
        applyPlanToDom(kids[i2], p2);
      }
    });
    return ops;
  }
  async function nudge(dx, dy) {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    if (!sels.length) return;
    movingTogether = sels.map((s2) => s2.el);
    const ordered = [
      ...sels.filter((s2) => !isConnector(s2.el)),
      ...sels.filter((s2) => isConnector(s2.el))
    ];
    const plans = ordered.map((sel) => ({ sel, ops: moveOps(sel, dx, dy) }));
    drawOverlay();
    await sendSvgOps(plans, "Nudge", "nudge");
  }
  function snapshot(sel) {
    const attrs2 = {};
    for (const a2 of GEOM_ATTRS) attrs2[a2] = sel.el.getAttribute(a2);
    return {
      sel,
      attrs: attrs2,
      kids: textChildren(sel.el).map((el2) => ({
        el: el2,
        x: el2.getAttribute("x"),
        y: el2.getAttribute("y")
      })),
      box: slideBox(sel.el) ?? { x: 0, y: 0, width: 0, height: 0 },
      geom: elementGeom(sel.el)
    };
  }
  function restore(snaps) {
    for (const s2 of snaps) {
      applyPlanToDom(s2.sel.el, s2.attrs);
      for (const k2 of s2.kids) {
        applyPlanToDom(k2.el, { x: k2.x, y: k2.y });
      }
    }
  }
  function snapTargets(exclude) {
    const svg = slideRoot();
    const boxes = [];
    if (svg) {
      for (const el2 of svg.querySelectorAll("[data-ink-top]")) {
        if (exclude.has(el2) || [...exclude].some((x2) => x2.contains(el2)))
          continue;
        const b2 = slideBox(el2);
        if (b2 && b2.width > 0 && b2.height > 0) boxes.push(b2);
      }
    }
    return targetsFor(slideSize(), boxes);
  }
  var pointer = null;
  function beginDrag(handle2) {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    if (!sels.length || sels.length !== ed.selection.length || ed.step != null)
      return null;
    const snaps = sels.map(snapshot);
    const start = unionBoxes(snaps.map((s2) => s2.box));
    if (!start) return null;
    if (handle2 === "c-bend") return { kind: "bend", snaps };
    if (handle2 === "c-start" || handle2 === "c-end") {
      return {
        kind: "endpoint",
        which: handle2 === "c-start" ? "start" : "end",
        snaps
      };
    }
    const targets2 = snapTargets(new Set(sels.map((s2) => s2.el)));
    if (handle2 === "rot") {
      return {
        kind: "rotate",
        snaps,
        center: {
          x: start.x + start.width / 2,
          y: start.y + start.height / 2
        }
      };
    }
    if (handle2) return { kind: "resize", handle: handle2, snaps, start, targets: targets2 };
    return { kind: "move", snaps, start, targets: targets2 };
  }
  function resizedBox(start, handle2, dx, dy, keepAspect) {
    let { x: x2, y: y2, width, height: height2 } = start;
    if (handle2.includes("w")) {
      x2 += dx;
      width -= dx;
    }
    if (handle2.includes("e")) width += dx;
    if (handle2.includes("n")) {
      y2 += dy;
      height2 -= dy;
    }
    if (handle2.includes("s")) height2 += dy;
    if (keepAspect && start.width > 0 && start.height > 0) {
      const ratio = start.width / start.height;
      const corner = handle2.length === 2;
      if (corner || handle2 === "e" || handle2 === "w") {
        const h22 = width / ratio;
        if (handle2.includes("n")) y2 += height2 - h22;
        else if (!corner) y2 = start.y + (start.height - h22) / 2;
        height2 = h22;
      } else {
        const w2 = height2 * ratio;
        x2 = start.x + (start.width - w2) / 2;
        width = w2;
      }
    }
    if (width < 0) {
      x2 += width;
      width = -width;
    }
    if (height2 < 0) {
      y2 += height2;
      height2 = -height2;
    }
    return { x: x2, y: y2, width: Math.max(width, 1), height: Math.max(height2, 1) };
  }
  function keepsAspect(snaps, shift) {
    const natural = snaps.some(
      (s2) => ["text", "image", "circle"].includes(s2.geom.sourceTag)
    );
    return natural !== shift;
  }
  function mapBox(b2, from, to) {
    const sx = from.width ? to.width / from.width : 1;
    const sy = from.height ? to.height / from.height : 1;
    return {
      x: to.x + (b2.x - from.x) * sx,
      y: to.y + (b2.y - from.y) * sy,
      width: b2.width * sx,
      height: b2.height * sy
    };
  }
  var lastPlans = [];
  var lastInput = null;
  var copying = false;
  var ghosts = [];
  function showGhosts(snaps) {
    if (ghosts.length) return;
    for (const s2 of snaps) {
      const ghost = s2.sel.el.cloneNode(true);
      for (const node of [ghost, ...ghost.querySelectorAll("*")]) {
        for (const attr of [...node.attributes]) {
          if (attr.name === "id" || attr.name.startsWith("data-ink")) {
            node.removeAttribute(attr.name);
          }
        }
      }
      ghost.setAttribute("pointer-events", "none");
      s2.sel.el.before(ghost);
      ghosts.push(ghost);
    }
  }
  function dropGhosts() {
    for (const g2 of ghosts) g2.remove();
    ghosts = [];
  }
  function setCopying(on2) {
    copying = on2;
    document.body.classList.toggle("drag-copy", on2);
    if (!on2) dropGhosts();
  }
  function updateDrag(drag, e2) {
    lastInput = e2;
    if (!pointer) return;
    const p0 = clientToSlide(pointer.x, pointer.y);
    const p1 = clientToSlide(e2.clientX, e2.clientY);
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const threshold = SNAP_PX / scale();
    guides = { xs: [], ys: [] };
    if (drag.kind === "move") {
      if (e2.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (!e2.altKey) {
        const moved = {
          ...drag.start,
          x: drag.start.x + dx,
          y: drag.start.y + dy
        };
        const snap = snapBox(moved, drag.targets, threshold);
        dx += snap.dx;
        dy += snap.dy;
        guides = { xs: snap.guidesX, ys: snap.guidesY };
      }
      restore(drag.snaps);
      setCopying(e2.ctrlKey || e2.metaKey);
      if (copying) showGhosts(drag.snaps);
      movingTogether = drag.snaps.map((s2) => s2.sel.el);
      const ordered = [
        ...drag.snaps.filter((s2) => !isConnector(s2.sel.el)),
        ...drag.snaps.filter((s2) => isConnector(s2.sel.el))
      ];
      const plans = ordered.map((s2) => ({
        sel: s2.sel,
        ops: moveOps(s2.sel, dx, dy)
      }));
      lastPlans = copying ? plans : withConnectors(plans);
    } else if (drag.kind === "resize") {
      if (!e2.altKey) {
        const h3 = drag.handle;
        const edgesX = [];
        const edgesY = [];
        if (h3.includes("w")) edgesX.push(drag.start.x + dx);
        if (h3.includes("e"))
          edgesX.push(drag.start.x + drag.start.width + dx);
        if (h3.includes("n")) edgesY.push(drag.start.y + dy);
        if (h3.includes("s"))
          edgesY.push(drag.start.y + drag.start.height + dy);
        const snap = snapEdges(edgesX, edgesY, drag.targets, threshold);
        dx += snap.dx;
        dy += snap.dy;
        guides = { xs: snap.guidesX, ys: snap.guidesY };
      }
      const cropping = ed.cropMode && drag.snaps.length === 1;
      const to = resizedBox(
        drag.start,
        drag.handle,
        dx,
        dy,
        !cropping && keepsAspect(drag.snaps, e2.shiftKey)
      );
      restore(drag.snaps);
      lastPlans = drag.snaps.map((s2) => {
        const target = mapBox(s2.box, drag.start, to);
        const plan2 = cropping && planCrop(s2.geom, s2.box, target) || planResize(s2.geom, s2.box, target);
        applyPlanToDom(s2.sel.el, plan2);
        return {
          sel: s2.sel,
          ops: [{ kind: "attrs", loc: s2.sel.loc, set: plan2 }]
        };
      });
    } else if (drag.kind === "rotate") {
      const c2 = drag.center;
      const a0 = Math.atan2(p0.y - c2.y, p0.x - c2.x);
      const a1 = Math.atan2(p1.y - c2.y, p1.x - c2.x);
      let deg = (a1 - a0) * 180 / Math.PI;
      if (e2.shiftKey) deg = Math.round(deg / 15) * 15;
      restore(drag.snaps);
      lastPlans = drag.snaps.map((s2) => {
        const plan2 = planRotate(s2.geom, deg, c2);
        applyPlanToDom(s2.sel.el, plan2);
        return {
          sel: s2.sel,
          ops: [{ kind: "attrs", loc: s2.sel.loc, set: plan2 }]
        };
      });
    } else if (drag.kind === "endpoint") {
      restore(drag.snaps);
      lastPlans = endpointPlans(drag, p1, e2);
    } else if (drag.kind === "bend") {
      restore(drag.snaps);
      lastPlans = bendPlans(drag, p1);
    } else if (drag.kind === "marquee") {
      marquee = {
        x: Math.min(p0.x, p1.x),
        y: Math.min(p0.y, p1.y),
        width: Math.abs(p1.x - p0.x),
        height: Math.abs(p1.y - p0.y)
      };
    }
    drawOverlay();
  }
  async function endDrag(drag) {
    guides = { xs: [], ys: [] };
    if (drag.kind === "marquee") {
      const m2 = marquee;
      marquee = null;
      if (!m2) return;
      const svg = slideRoot();
      if (!svg) return;
      const hits2 = [...svg.querySelectorAll("[data-ink-top]")].filter(
        (el2) => {
          if (!selectable(el2) || !canTransform(el2)) return false;
          const b2 = slideBox(el2);
          return !!b2 && b2.x >= m2.x && b2.y >= m2.y && b2.x + b2.width <= m2.x + m2.width && b2.y + b2.height <= m2.y + m2.height;
        }
      );
      if (drag.additive) {
        for (const el2 of hits2) addToSelection(el2, false);
        select(ed.selection.map((s2) => s2.el));
      } else select(hits2);
      return;
    }
    const plans = lastPlans;
    lastPlans = [];
    if (drag.kind === "move" && copying) {
      setCopying(false);
      restore(drag.snaps);
      drawOverlay();
      await dropCopies(plans);
      return;
    }
    drawOverlay();
    if (!plans.length) return;
    if (siteHints.length) siteHints = [];
    const label4 = drag.kind === "endpoint" ? "Connect" : drag.kind === "bend" ? "Reshape arrow" : drag.kind === "move" ? "Move" : drag.kind === "resize" ? ed.cropMode ? "Crop" : "Resize" : "Rotate";
    const ok = await sendSvgOps(plans, label4);
    if (!ok) restore(drag.snaps);
    drawOverlay();
  }
  async function dropCopies(plans) {
    const keys = [];
    const copies = plans.map((p2, i2) => {
      const set = {};
      const kids = [];
      for (const op of p2.ops) {
        if (op.kind !== "attrs") continue;
        if (op.loc === p2.sel.loc) Object.assign(set, op.set);
        else kids.push({ loc: String(op.loc), set: op.set });
      }
      keys.push(`copy${i2}`);
      return {
        sel: p2.sel,
        ops: [
          {
            kind: "duplicate",
            loc: p2.sel.loc,
            key: `copy${i2}`,
            set,
            kids
          }
        ]
      };
    });
    const ids = {};
    if (await sendSvgOps(copies, "Duplicate", void 0, ids)) {
      const made = keys.map((k2) => ids[k2]).filter(Boolean);
      if (made.length) hooks.selectAfterRender(made);
    }
  }
  function onPointerDown(e2) {
    ed.focus = "canvas";
    if (ed.slideSelection.size) {
      ed.slideSelection.clear();
      emit("slide-selection");
    }
    const target = e2.target;
    const editing = hooks.editingHost();
    if (editing) {
      if (editing.contains(target)) return;
      hooks.finishEditing();
    }
    if (!slideRoot()) return;
    if (e2.button === 1 || e2.button === 0 && e2.altKey && ed.tool === "select") {
      e2.preventDefault();
      cycleSelect(e2);
      return;
    }
    if (e2.button !== 0) return;
    const handle2 = target.closest("[data-handle]")?.dataset.handle;
    const pt = clientToSlide(e2.clientX, e2.clientY);
    if (!handle2 && ed.tool !== "select") {
      if (hooks.toolDown(e2, pt)) return;
    }
    try {
      paper.setPointerCapture(e2.pointerId);
    } catch {
    }
    e2.preventDefault();
    ed.interacting = true;
    let clickTarget = null;
    let drag = null;
    let deselectOnClick = false;
    if (handle2) {
      drag = beginDrag(handle2);
    } else {
      clickTarget = pick(e2.clientX, e2.clientY);
      if (clickTarget) {
        const already = ed.selection.some((s2) => s2.el === clickTarget);
        if (e2.shiftKey || e2.metaKey || e2.ctrlKey) {
          if (already) deselectOnClick = true;
          else addToSelection(clickTarget);
        } else if (!already) select([clickTarget]);
      } else {
        if (!e2.shiftKey) {
          if (ed.scope && !ed.scope.contains(target)) enterGroup(null);
          clearSelection();
        }
        drag = { kind: "marquee", additive: e2.shiftKey };
      }
    }
    pointer = {
      id: e2.pointerId,
      x: e2.clientX,
      y: e2.clientY,
      started: false,
      drag,
      clickTarget,
      shift: e2.shiftKey,
      deselectOnClick
    };
  }
  function onPointerMove(e2) {
    if (!pointer) {
      if (ed.tool === "select" && e2.buttons === 0) {
        const el2 = pick(e2.clientX, e2.clientY);
        if (el2 !== hoverEl) {
          hoverEl = el2;
          drawOverlay();
        }
      } else if (ed.tool in CONNECTOR_TOOLS && e2.buttons === 0) {
        const p2 = clientToSlide(e2.clientX, e2.clientY);
        const hit = e2.altKey ? null : siteAt(p2, null);
        const under = attachTargetAt(e2.clientX, e2.clientY);
        const hints = [
          ...under ? [
            {
              el: under,
              active: hit?.el === under ? hit.site : null
            }
          ] : [],
          ...hit && hit.el !== under ? [{ el: hit.el, active: hit.site }] : []
        ];
        if (hints.length || siteHints.length) showSites(hints);
      }
      return;
    }
    if (e2.pointerId !== pointer.id) return;
    if (!pointer.started) {
      const dist = Math.hypot(e2.clientX - pointer.x, e2.clientY - pointer.y);
      if (dist < DRAG_THRESHOLD) return;
      pointer.started = true;
      if (!pointer.drag && pointer.clickTarget)
        pointer.drag = beginDrag(null);
      if (pointer.drag?.kind === "move" && !canTransform(pointer.clickTarget)) {
        pointer.drag = null;
      }
    }
    if (pointer.drag) updateDrag(pointer.drag, e2);
  }
  async function onPointerUp(e2) {
    if (!pointer || e2.pointerId !== pointer.id) return;
    const p2 = pointer;
    pointer = null;
    lastInput = null;
    try {
      if (p2.drag && p2.started) await endDrag(p2.drag);
      else if (p2.drag?.kind === "marquee") marquee = null;
      if (!p2.started && p2.deselectOnClick && p2.clickTarget) {
        ed.selection = ed.selection.filter((s2) => s2.el !== p2.clickTarget);
        drawOverlay();
        emit("selection");
      }
    } finally {
      setCopying(false);
      ed.interacting = false;
      if (ed.renderPending) render();
      else drawOverlay();
    }
  }
  function textUnder(x2, y2) {
    const svg = slideRoot();
    for (const hit of document.elementsFromPoint(x2, y2)) {
      const t2 = hit.closest("text");
      if (t2 && svg?.contains(t2) && t2.hasAttribute("data-ink")) {
        return t2;
      }
    }
    return null;
  }
  function onDoubleClick(e2) {
    if (hooks.editingHost()?.contains(e2.target)) return;
    const el2 = pick(e2.clientX, e2.clientY);
    if (!el2) {
      if (ed.tool === "select") setZoom(0);
      return;
    }
    if (canTypeInto(el2)) {
      hooks.typeInto(el2);
      return;
    }
    if (isZone(el2)) {
      hooks.editZone(zoneName(el2), el2, { x: e2.clientX, y: e2.clientY });
      return;
    }
    const text = textUnder(e2.clientX, e2.clientY);
    if (text && el2.contains(text)) {
      if (text !== el2 && !text.hasAttribute("data-ink-top")) {
        enterGroup(text.parentElement);
      }
      select([text]);
      hooks.editText(text);
      return;
    }
    if (isDiagramCell(el2) && !el2.querySelector('g[data-cell-kind="vertex"][data-ink]')) {
      select([el2]);
      hooks.cellLabel(el2);
      return;
    }
    if (el2.localName === "g") {
      enterGroup(el2);
      const inner = pick(e2.clientX, e2.clientY);
      if (inner) select([inner]);
      return;
    }
    if (el2.hasAttribute("data-drawio") && shapesEditable(el2) && canTransform(el2)) {
      enterDiagram(el2, e2.clientX, e2.clientY);
      return;
    }
    if (canTransform(el2) && hooks.diagram(el2)) return;
    if (canTransform(el2) && (el2.localName === "image" || el2.localName === "svg" && [...el2.children].some((c2) => c2.localName === "image"))) {
      hooks.crop(el2);
    }
  }
  function enterDiagram(diagram, x2, y2) {
    const layers = [
      ...diagram.querySelectorAll(
        'g[data-cell-kind="other"][data-ink]'
      )
    ];
    const under = document.elementsFromPoint(x2, y2).map((hit) => layers.find((l2) => l2.contains(hit))).find((l2) => !!l2);
    const layer2 = under ?? layers[0];
    if (!layer2) {
      toast("This diagram has no shapes to edit here", "error");
      return;
    }
    enterGroup(layer2);
    const inner = pick(x2, y2);
    if (inner) select([inner]);
    else toast("Click a shape of the diagram; Esc leaves it");
  }
  function diagramPlans(plans) {
    const diagrams = /* @__PURE__ */ new Set();
    const out = [];
    let refused = false;
    for (const plan2 of plans) {
      if (sourceOf(plan2.sel.key)?.role !== "diagram") {
        out.push(plan2);
        continue;
      }
      const el2 = plan2.sel.el;
      const diagram = el2.closest("svg[data-drawio]");
      const cell = el2.getAttribute("data-cell-id");
      if (!diagram || !cell) continue;
      const ops = [];
      let moved = false;
      for (const op of plan2.ops) {
        if (op.kind === "delete") ops.push({ kind: "cell-delete", cell });
        else if (String(op.kind).startsWith("cell-")) ops.push(op);
        else if (geometryChanged([op])) moved = true;
        else refused = true;
      }
      if (moved) {
        const offset = pageOffset(diagram);
        const box2 = offset ? pageBox(el2, offset) : null;
        if (offset && box2) {
          ops.push({
            kind: "cell-geometry",
            cell,
            ...box2,
            offset: [offset.x, offset.y]
          });
        }
      }
      if (ops.length) {
        out.push({ sel: plan2.sel, ops });
        diagrams.add(diagram);
      }
    }
    if (refused) {
      toast(
        "That change to a diagram's shapes is made in draw.io (Edit diagram)",
        "error"
      );
    }
    return { plans: out, diagrams };
  }
  function initCanvas() {
    onFontsLoaded(() => {
      for (const svg2 of Array.from(
        document.querySelectorAll(".thumb svg, .master-thumb svg")
      )) {
        fitSlide(svg2);
      }
      const svg = slideRoot();
      if (!svg || ed.interacting || ed.richEditing) return;
      fitSlide(svg);
      drawOverlay();
      emit("selection");
    });
    paper.addEventListener("pointerdown", onPointerDown);
    for (const type of ["mousedown", "auxclick"]) {
      paper.addEventListener(type, (e2) => {
        if (e2.button === 1) e2.preventDefault();
      });
    }
    paper.addEventListener("pointermove", onPointerMove);
    for (const type of ["keydown", "keyup"]) {
      window.addEventListener(type, (e2) => {
        if (!["Control", "Meta", "Shift", "Alt"].includes(e2.key)) return;
        if (!pointer?.started || !pointer.drag || !lastInput) return;
        updateDrag(pointer.drag, {
          clientX: lastInput.clientX,
          clientY: lastInput.clientY,
          shiftKey: e2.shiftKey,
          altKey: e2.altKey,
          ctrlKey: e2.ctrlKey,
          metaKey: e2.metaKey
        });
      });
    }
    paper.addEventListener("pointerup", (e2) => void onPointerUp(e2));
    paper.addEventListener("pointercancel", (e2) => void onPointerUp(e2));
    paper.addEventListener("dblclick", onDoubleClick);
    paper.addEventListener("pointerleave", () => {
      if (siteHints.length) showSites([]);
      if (hoverEl) {
        hoverEl = null;
        drawOverlay();
      }
    });
    new ResizeObserver(() => layoutPaper()).observe(canvas);
    canvas.addEventListener("pointerdown", (e2) => {
      if (e2.target === canvas) {
        enterGroup(null);
        clearSelection();
      }
    });
    canvas.addEventListener("dblclick", (e2) => {
      if (e2.target === canvas) setZoom(0);
    });
    on("model", rebuilt);
    on("rerender", render);
  }
  var MIN_ZOOM = 0.05;
  var MAX_ZOOM = 8;
  function clampZoom(z) {
    return z <= 0 ? 0 : Math.max(MIN_ZOOM, Math.min(z, MAX_ZOOM));
  }
  function setZoom(z, about) {
    const c2 = canvas.getBoundingClientRect();
    const at3 = about ?? { x: c2.left + c2.width / 2, y: c2.top + c2.height / 2 };
    anchor.reset();
    zoomTo(clampZoom(z), at3, at3);
  }
  function zoomAbout(factor, from, to) {
    zoomTo(clampZoom(scale() * factor), from, to);
  }
  function zoomEnded() {
    anchor.reset();
  }
  var anchor = new ZoomAnchor();
  function zoomTo(z, from, to) {
    const p2 = z > 0 && slideRoot() ? anchor.point(from, (c2) => clientToSlide(c2.x, c2.y)) : null;
    ed.zoom = z;
    layoutPaper();
    if (p2) {
      const m2 = rootCTM();
      const now = {
        x: m2.a * p2.x + m2.c * p2.y + m2.e,
        y: m2.b * p2.x + m2.d * p2.y + m2.f
      };
      const fix = scrollCorrection(now, to);
      if (fix.x) canvas.scrollLeft += fix.x;
      if (fix.y) canvas.scrollTop += fix.y;
      anchor.settle(to, p2);
    } else anchor.reset();
    emit("zoom");
  }

  // src/ts/editor/chartgrid.ts
  var CHART_KINDS = [
    { value: "bar", label: "Bar" },
    { value: "line", label: "Line" },
    { value: "area", label: "Area" },
    { value: "scatter", label: "Scatter" },
    { value: "pie", label: "Pie" }
  ];
  function defaultSettings() {
    return {
      kind: "bar",
      x: null,
      y: null,
      title: null,
      stacked: false,
      horizontal: false,
      legend: null,
      labels: false,
      donut: false,
      y_min: null,
      y_max: null,
      y2: null,
      y2_min: null,
      y2_max: null
    };
  }
  function secondAxisAllowed(s2) {
    if (s2.kind === "pie") return false;
    if (s2.stacked && (s2.kind === "bar" || s2.kind === "area")) return false;
    return !(s2.horizontal && s2.kind === "bar");
  }
  function toggleRight(s2, column, on2) {
    const now = (s2.y2 ?? []).filter((c2) => c2 !== column);
    const next = on2 ? [...now, column] : now;
    return next.length ? next : null;
  }
  function sampleGrid() {
    return {
      columns: ["category", "series 1", "series 2"],
      rows: [
        ["A", "4", "2"],
        ["B", "6", "3"],
        ["C", "5", "4"],
        ["D", "8", "5"]
      ]
    };
  }
  var NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
  function isNumber(text) {
    const s2 = text.trim();
    return /\d/.test(s2) && NUMBER.test(s2);
  }
  function numericColumns(grid) {
    return grid.columns.filter((_2, c2) => {
      const cells = grid.rows.map((r2) => r2[c2] ?? "").filter((v2) => v2.trim());
      return cells.length > 0 && cells.every(isNumber);
    });
  }
  function xColumn(grid, s2) {
    return s2.x && grid.columns.includes(s2.x) ? s2.x : grid.columns[0] ?? null;
  }
  function plotted(grid, s2) {
    const x2 = xColumn(grid, s2);
    if (s2.y) return s2.y.filter((c2) => grid.columns.includes(c2));
    return numericColumns(grid).filter((c2) => c2 !== x2);
  }
  function toggleSeries(grid, s2, column, on2) {
    const current3 = plotted(grid, s2);
    const next = on2 ? grid.columns.filter((c2) => c2 === column || current3.includes(c2)) : current3.filter((c2) => c2 !== column);
    const auto = plotted(grid, { ...s2, y: null });
    const same = next.length === auto.length && next.every((c2, i2) => c2 === auto[i2]);
    return same ? null : next;
  }
  function parseClipboard(text) {
    const body3 = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const sep2 = body3.includes("	") ? "	" : body3.includes(",") ? "," : "	";
    const rows = [];
    let row7 = [];
    let cell = "";
    let quoted = false;
    let i2 = 0;
    while (i2 < body3.length) {
      const ch = body3[i2];
      if (quoted) {
        if (ch === '"' && body3[i2 + 1] === '"') {
          cell += '"';
          i2 += 2;
          continue;
        }
        if (ch === '"') quoted = false;
        else cell += ch;
        i2++;
        continue;
      }
      if (ch === '"' && cell === "") quoted = true;
      else if (ch === sep2) {
        row7.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row7.push(cell);
        rows.push(row7);
        row7 = [];
        cell = "";
      } else cell += ch;
      i2++;
    }
    row7.push(cell);
    rows.push(row7);
    return rows;
  }
  function isMultiCell(text) {
    const rows = parseClipboard(text);
    return rows.length > 1 || (rows[0]?.length ?? 0) > 1;
  }
  function blankRow(width) {
    return Array.from({ length: width }, () => "");
  }
  function uniqueName(columns, base2) {
    let name2 = base2;
    let n3 = 2;
    while (columns.includes(name2)) name2 = `${base2} ${n3++}`;
    return name2;
  }
  function pasteCells(grid, row7, col, cells) {
    const columns = [...grid.columns];
    const rows = grid.rows.map((r2) => [...r2]);
    let body3 = cells;
    if (row7 < 0) {
      const head = cells[0] ?? [];
      head.forEach((name2, j2) => {
        const c2 = col + j2;
        while (columns.length <= c2) {
          columns.push(
            uniqueName(columns, `column ${columns.length + 1}`)
          );
        }
        columns[c2] = name2.trim() || columns[c2];
      });
      body3 = cells.slice(1);
      row7 = 0;
    }
    const width = Math.max(
      columns.length,
      col + Math.max(0, ...body3.map((r2) => r2.length))
    );
    while (columns.length < width) {
      columns.push(uniqueName(columns, `column ${columns.length + 1}`));
    }
    for (const r2 of rows) while (r2.length < width) r2.push("");
    body3.forEach((line, i2) => {
      while (rows.length <= row7 + i2) rows.push(blankRow(width));
      line.forEach((value, j2) => {
        rows[row7 + i2][col + j2] = value;
      });
    });
    return { columns, rows };
  }
  function addRow(grid, at3 = grid.rows.length) {
    const rows = grid.rows.map((r2) => [...r2]);
    rows.splice(at3, 0, blankRow(grid.columns.length));
    return { columns: [...grid.columns], rows };
  }
  function removeRow(grid, at3) {
    return {
      columns: [...grid.columns],
      rows: grid.rows.filter((_2, i2) => i2 !== at3).map((r2) => [...r2])
    };
  }
  function addColumn(grid, name2) {
    const columns = [
      ...grid.columns,
      uniqueName(grid.columns, name2 ?? `series ${grid.columns.length}`)
    ];
    return { columns, rows: grid.rows.map((r2) => [...r2, ""]) };
  }
  function removeColumn(grid, at3, s2) {
    const name2 = grid.columns[at3];
    const next = {
      columns: grid.columns.filter((_2, i2) => i2 !== at3),
      rows: grid.rows.map((r2) => r2.filter((_2, i2) => i2 !== at3))
    };
    return {
      grid: next,
      settings: {
        ...s2,
        x: s2.x === name2 ? null : s2.x,
        y: s2.y ? s2.y.filter((c2) => c2 !== name2) : null,
        y2: toggleRight(s2, name2, false)
      }
    };
  }
  function renameColumn(grid, at3, wanted, s2) {
    const old = grid.columns[at3];
    const others2 = grid.columns.filter((_2, i2) => i2 !== at3);
    const name2 = uniqueName(others2, wanted.trim() || old);
    const columns = grid.columns.map((c2, i2) => i2 === at3 ? name2 : c2);
    return {
      grid: { columns, rows: grid.rows.map((r2) => [...r2]) },
      settings: {
        ...s2,
        x: s2.x === old ? name2 : s2.x,
        y: s2.y ? s2.y.map((c2) => c2 === old ? name2 : c2) : null,
        y2: s2.y2 ? s2.y2.map((c2) => c2 === old ? name2 : c2) : null
      }
    };
  }
  function trimmed(grid) {
    return {
      columns: [...grid.columns],
      rows: grid.rows.filter((r2) => r2.some((v2) => v2.trim() !== ""))
    };
  }

  // src/ts/editor/chart.ts
  function chartSettings(value) {
    const f2 = value.fields ?? {};
    const s2 = defaultSettings();
    return {
      kind: typeof f2.kind === "string" ? f2.kind : s2.kind,
      x: typeof f2.x === "string" ? f2.x : null,
      y: Array.isArray(f2.y) ? f2.y : null,
      title: typeof f2.title === "string" ? f2.title : null,
      stacked: f2.stacked === true,
      horizontal: f2.horizontal === true,
      legend: typeof f2.legend === "boolean" ? f2.legend : null,
      labels: f2.labels === true,
      donut: f2.donut === true,
      y_min: typeof f2.y_min === "number" ? f2.y_min : null,
      y_max: typeof f2.y_max === "number" ? f2.y_max : null,
      y2: Array.isArray(f2.y2) ? f2.y2 : null,
      y2_min: typeof f2.y2_min === "number" ? f2.y2_min : null,
      y2_max: typeof f2.y2_max === "number" ? f2.y2_max : null
    };
  }
  function rangeInput(value, commit, placeholder = "auto") {
    const input = h("input", {
      type: "number",
      step: "any",
      class: "chart-range",
      placeholder,
      value: value == null ? "" : String(value)
    });
    input.addEventListener("change", () => {
      const v2 = input.value.trim();
      commit(v2 === "" || !Number.isFinite(Number(v2)) ? null : Number(v2));
    });
    return input;
  }
  function newChartBox(at3) {
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    const vh = vb?.height || 1080;
    const w2 = Math.round(vw * 0.6);
    const ht = Math.round(w2 * 9 / 16);
    const cx = Math.min(Math.max(at3?.x ?? vw / 2, w2 / 2), vw - w2 / 2);
    const cy = Math.min(Math.max(at3?.y ?? vh / 2, ht / 2), vh - ht / 2);
    return { x: cx - w2 / 2, y: cy - ht / 2, width: w2, height: ht };
  }
  async function insertChart(at3) {
    const slide = currentSlide();
    if (!slide) return;
    if (ed.master) {
      toast("A chart belongs to a slide: insert it on the slide", "error");
      return;
    }
    if (!ed.model?.deckEditable) {
      toast(
        "deck.py builds its slides in code; cannot add a chart here",
        "error"
      );
      return;
    }
    openChartDialog({ kind: "insert", at: at3 }, sampleGrid(), defaultSettings());
  }
  async function editChart(zone) {
    const slide = currentSlide();
    const value = slide?.zones[zone];
    if (!slide || value?.kind !== "chart") return;
    const res = await request({
      action: "chart-data",
      slide: slide.deckIndex,
      zone
    });
    if (!res.ok) {
      toast(res.error ?? "Cannot read the chart's data", "error");
      return;
    }
    const grid = {
      columns: res.columns,
      rows: res.rows
    };
    openChartDialog(
      {
        kind: "edit",
        slide: slide.deckIndex,
        zone,
        src: res.src ?? null
      },
      grid,
      chartSettings(value)
    );
  }
  function openChartDialog(target, initial, initialSettings) {
    let grid = initial;
    let settings2 = initialSettings;
    let timer6 = 0;
    let asked = 0;
    let size4 = newChartBox();
    if (target.kind === "edit") {
      const el2 = slideRoot()?.querySelector(`[id="zone-${target.zone}"]`);
      const box2 = el2 ? slideBox(el2) : null;
      if (box2) size4 = { ...size4, width: box2.width, height: box2.height };
    }
    const table = h("table", { class: "chart-grid" });
    const fields = h("div", { class: "chart-fields" });
    const preview2 = h("div", { class: "chart-preview" });
    preview2.style.aspectRatio = `${size4.width} / ${size4.height}`;
    const status3 = h("span", { class: "hint chart-status" });
    const schedule2 = () => {
      window.clearTimeout(timer6);
      timer6 = window.setTimeout(() => void drawPreview(), 200);
    };
    async function drawPreview() {
      const mine = ++asked;
      const slide = currentSlide();
      const res = await request({
        action: "chart-preview",
        slide: slide?.deckIndex,
        zone: target.kind === "edit" ? target.zone : null,
        chart: settings2,
        table: trimmed(grid),
        width: size4.width,
        height: size4.height
      });
      if (mine !== asked) return;
      if (!res.ok) {
        status3.textContent = res.error ?? "Cannot draw the chart";
        return;
      }
      status3.textContent = "";
      preview2.innerHTML = String(res.svg ?? "");
    }
    function cellInput(row7, col, value) {
      const input = h("input", {
        type: "text",
        value,
        "data-row": row7,
        "data-col": col,
        spellcheck: "false"
      });
      if (row7 < 0) {
        input.classList.add("chart-head");
        input.addEventListener("change", () => {
          const r2 = renameColumn(grid, col, input.value, settings2);
          grid = r2.grid;
          settings2 = r2.settings;
          renderAll();
        });
      } else {
        input.addEventListener("input", () => {
          grid.rows[row7][col] = input.value;
          schedule2();
        });
        input.addEventListener("change", renderFields);
      }
      input.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter" || e2.key === "ArrowDown" || e2.key === "ArrowUp") {
          e2.preventDefault();
          const down = e2.key !== "ArrowUp";
          let next = row7 + (down ? 1 : -1);
          if (down && next >= grid.rows.length && e2.key === "Enter") {
            grid = addRow(grid);
            renderGrid2();
          }
          next = Math.max(-1, Math.min(next, grid.rows.length - 1));
          focusCell2(next, col);
        }
      });
      return input;
    }
    function focusCell2(row7, col) {
      const input = table.querySelector(
        `input[data-row="${row7}"][data-col="${col}"]`
      );
      input?.focus();
      input?.select();
    }
    function renderGrid2() {
      clear(table);
      const head = h(
        "tr",
        {},
        h("th", { class: "chart-corner" }),
        ...grid.columns.map(
          (name2, c2) => h(
            "th",
            {},
            h(
              "div",
              { class: "chart-th" },
              cellInput(-1, c2, name2),
              h(
                "button",
                {
                  type: "button",
                  class: "chart-x",
                  title: `Remove column "${name2}"`,
                  disabled: grid.columns.length <= 1,
                  onclick: () => {
                    const r2 = removeColumn(grid, c2, settings2);
                    grid = r2.grid;
                    settings2 = r2.settings;
                    renderAll();
                  }
                },
                "\xD7"
              )
            )
          )
        )
      );
      const body4 = grid.rows.map(
        (cells, r2) => h(
          "tr",
          {},
          h(
            "th",
            { class: "chart-rownum" },
            h(
              "button",
              {
                type: "button",
                class: "chart-x",
                title: `Remove row ${r2 + 1}`,
                onclick: () => {
                  grid = removeRow(grid, r2);
                  renderAll();
                }
              },
              String(r2 + 1)
            )
          ),
          ...grid.columns.map(
            (_2, c2) => h("td", {}, cellInput(r2, c2, cells[c2] ?? ""))
          )
        )
      );
      table.append(h("thead", {}, head), h("tbody", {}, ...body4));
    }
    table.addEventListener("paste", (e2) => {
      const input = e2.target;
      const text = e2.clipboardData?.getData("text/plain") ?? "";
      if (!input.dataset.row || !isMultiCell(text)) return;
      e2.preventDefault();
      grid = pasteCells(
        grid,
        Number(input.dataset.row),
        Number(input.dataset.col),
        parseClipboard(text)
      );
      renderAll();
    });
    function check(label4, on2, set) {
      const box2 = h("input", { type: "checkbox" });
      box2.checked = on2;
      box2.addEventListener("change", () => {
        set(box2.checked);
        renderFields();
      });
      return h("label", { class: "chart-check" }, box2, label4);
    }
    function select2(options, value, set) {
      const sel = h("select", {});
      for (const o2 of options) {
        const opt = h("option", { value: o2.value }, o2.label);
        opt.selected = o2.value === value;
        sel.append(opt);
      }
      sel.addEventListener("change", () => {
        set(sel.value);
        renderFields();
      });
      return sel;
    }
    function field2(label4, control) {
      return h(
        "label",
        { class: "chart-field" },
        h("span", {}, label4),
        control
      );
    }
    function renderFields() {
      clear(fields);
      const numeric = numericColumns(grid);
      const x2 = xColumn(grid, settings2);
      const shown3 = plotted(grid, settings2);
      const kind = settings2.kind;
      const title3 = h("input", {
        type: "text",
        value: settings2.title ?? "",
        placeholder: "none"
      });
      title3.addEventListener("input", () => {
        settings2.title = title3.value.trim() || null;
        schedule2();
      });
      fields.append(
        field2(
          "Kind",
          select2(CHART_KINDS, kind, (v2) => {
            settings2.kind = v2;
          })
        ),
        field2(
          kind === "scatter" ? "X values" : kind === "pie" ? "Slices" : "Categories",
          select2(
            grid.columns.map((c2) => ({ value: c2, label: c2 })),
            x2 ?? "",
            (v2) => {
              settings2.x = v2 === grid.columns[0] ? null : v2;
            }
          )
        ),
        field2("Title", title3)
      );
      const series = h("div", { class: "chart-series" });
      const choices = grid.columns.filter((c2) => c2 !== x2);
      const twoAxes = secondAxisAllowed(settings2);
      for (const c2 of choices) {
        const usable = numeric.includes(c2);
        const box2 = check(c2, shown3.includes(c2), (on2) => {
          settings2.y = toggleSeries(grid, settings2, c2, on2);
          if (!on2) settings2.y2 = toggleRight(settings2, c2, false);
        });
        if (!usable) {
          box2.classList.add("off");
          box2.title = "Not all numbers";
        }
        if (twoAxes && usable && shown3.includes(c2)) {
          const right = check(
            "right axis",
            (settings2.y2 ?? []).includes(c2),
            (on2) => {
              settings2.y2 = toggleRight(settings2, c2, on2);
            }
          );
          right.classList.add("chart-right");
          right.title = `Draw ${c2} against a second axis, on the right`;
          series.append(
            h("span", { class: "chart-series-row" }, box2, right)
          );
        } else series.append(box2);
      }
      fields.append(
        h(
          "div",
          { class: "chart-field" },
          h("span", {}, kind === "pie" ? "Sizes (first)" : "Series"),
          choices.length ? series : h("span", { class: "hint" }, "Add a column of numbers")
        )
      );
      const opts2 = h("div", { class: "chart-options" });
      if (kind === "bar" || kind === "area") {
        opts2.append(
          check("Stacked", settings2.stacked, (v2) => {
            settings2.stacked = v2;
          })
        );
      }
      if (kind === "bar") {
        opts2.append(
          check("Horizontal", settings2.horizontal, (v2) => {
            settings2.horizontal = v2;
          })
        );
      }
      if (kind === "pie") {
        opts2.append(
          check("Donut", settings2.donut, (v2) => {
            settings2.donut = v2;
          })
        );
      }
      opts2.append(
        check("Value labels", settings2.labels, (v2) => {
          settings2.labels = v2;
        })
      );
      const range = (label4, lo, hi) => field2(
        label4,
        h(
          "span",
          { class: "chart-range-row" },
          rangeInput(
            settings2[lo],
            (v2) => {
              settings2[lo] = v2;
              schedule2();
            },
            "from"
          ),
          h("span", { class: "hint" }, "to"),
          rangeInput(
            settings2[hi],
            (v2) => {
              settings2[hi] = v2;
              schedule2();
            },
            "auto"
          )
        )
      );
      if (kind !== "pie") {
        fields.append(
          range(
            settings2.y2 ? "Left axis" : "Value axis",
            "y_min",
            "y_max"
          )
        );
        if (settings2.y2 && twoAxes) {
          fields.append(range("Right axis", "y2_min", "y2_max"));
        }
      }
      fields.append(
        opts2,
        field2(
          "Legend",
          select2(
            [
              { value: "auto", label: "Auto" },
              { value: "on", label: "Show" },
              { value: "off", label: "Hide" }
            ],
            settings2.legend == null ? "auto" : settings2.legend ? "on" : "off",
            (v2) => {
              settings2.legend = v2 === "auto" ? null : v2 === "on";
            }
          )
        )
      );
      schedule2();
    }
    function renderAll() {
      renderGrid2();
      renderFields();
    }
    async function save5() {
      const data = trimmed(grid);
      if (!data.rows.length) {
        toast("The chart needs at least one row of data", "error");
        return;
      }
      if (target.kind === "edit") {
        const res2 = await edit({
          action: "chart-save-data",
          slide: target.slide,
          zone: target.zone,
          table: data,
          chart: settings2
        });
        if (res2.ok) closeDialog();
        return;
      }
      if (!await ensureOwnDrawing()) return;
      const src = ownSource();
      const slide = currentSlide();
      if (!src || !slide) return;
      const box2 = newChartBox(target.at);
      const parent = insertParent();
      const a2 = toParent(parent.el, box2.x, box2.y);
      const b2 = toParent(parent.el, box2.x + box2.width, box2.y + box2.height);
      const res = await edit({
        action: "insert-chart",
        slide: slide.deckIndex,
        file: src.path,
        hash: src.hash,
        parent: parent.loc,
        x: Math.round(Math.min(a2.x, b2.x)),
        y: Math.round(Math.min(a2.y, b2.y)),
        width: Math.round(Math.abs(b2.x - a2.x)),
        height: Math.round(Math.abs(b2.y - a2.y)),
        chart: settings2,
        table: data
      });
      const id = res.ids?.new;
      if (res.ok && id) {
        afterRender.ids = [id];
        closeDialog();
      }
    }
    const tools = h(
      "div",
      { class: "chart-tools" },
      h(
        "button",
        {
          type: "button",
          class: "pbtn",
          onclick: () => {
            grid = addRow(grid);
            renderAll();
            focusCell2(grid.rows.length - 1, 0);
          }
        },
        icon("plus", 14),
        "Row"
      ),
      h(
        "button",
        {
          type: "button",
          class: "pbtn",
          onclick: () => {
            grid = addColumn(grid);
            renderAll();
            focusCell2(-1, grid.columns.length - 1);
          }
        },
        icon("plus", 14),
        "Column"
      ),
      h(
        "span",
        { class: "hint chart-tools-hint" },
        "Paste cells copied from a spreadsheet into any cell."
      )
    );
    const body3 = h(
      "div",
      { class: "chart-dialog" },
      h(
        "div",
        { class: "chart-data" },
        tools,
        h("div", { class: "chart-grid-wrap" }, table)
      ),
      h(
        "div",
        { class: "chart-side" },
        fields,
        h("h3", {}, "Preview"),
        preview2,
        status3
      ),
      h(
        "div",
        { class: "chart-actions" },
        target.kind === "edit" && target.src ? h(
          "span",
          { class: "hint chart-actions-hint" },
          `Saved to ${target.src}`
        ) : target.kind === "insert" ? h(
          "span",
          { class: "hint chart-actions-hint" },
          "The data is saved as a CSV file in data/."
        ) : null,
        h(
          "button",
          { type: "button", class: "pbtn", onclick: () => closeDialog() },
          "Cancel"
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn primary",
            onclick: () => void save5()
          },
          target.kind === "insert" ? "Insert chart" : "Save"
        )
      )
    );
    openDialog(target.kind === "insert" ? "Insert chart" : "Chart data", body3, {
      large: true
    });
    renderAll();
    focusCell2(0, 0);
  }

  // src/ts/editor/crop.ts
  function pictureOf(el2) {
    if (el2.localName === "image") return el2;
    if (el2.localName !== "svg" || !el2.getAttribute("viewBox")) return null;
    const images = [...el2.children].filter((c2) => c2.localName === "image");
    return images.length === 1 ? images[0] : null;
  }
  function isCropped(el2) {
    return el2.localName === "svg" && pictureOf(el2) !== null;
  }
  function setCropMode(on2) {
    if (ed.cropMode === on2) return;
    ed.cropMode = on2;
    document.body.classList.toggle("crop-mode", on2);
    drawOverlay();
    emit("crop");
  }
  async function startCrop(sel) {
    if (isCropped(sel.el)) {
      setCropMode(true);
      return;
    }
    if (sel.el.localName !== "image") return;
    const src = sourceOf(sel.key);
    const slide = currentSlide();
    if (!src?.writable || !slide) return;
    const result = await edit({
      action: "svg",
      file: src.path,
      hash: src.hash,
      ops: [
        { kind: "ensure-id", loc: sel.loc, base: "image", key: "img" },
        { kind: "crop-frame", loc: sel.loc }
      ],
      label: "Crop"
    });
    const id = result.ids?.img;
    if (!result.ok || !id) return;
    afterRender.ids = [id];
    ed.cropMode = true;
    document.body.classList.add("crop-mode");
    toast("Drag the handles to crop; Enter or Esc when done");
  }
  async function resetCrop(sel) {
    if (!isCropped(sel.el)) return;
    setCropMode(false);
    await sendSvgOps(
      [{ sel, ops: [{ kind: "uncrop", loc: sel.loc }] }],
      "Reset crop"
    );
  }

  // src/ts/editor/drawio.ts
  function diagramOf(el2) {
    const drawn2 = drawnDiagram(el2);
    if (drawn2) return drawn2;
    const image = pictureOf(el2);
    return image && isDiagramHref(hrefOf(image)) ? image : null;
  }
  function drawnDiagram(el2) {
    return el2.localName === "svg" && el2.hasAttribute("data-drawio") ? el2 : null;
  }
  function isDiagramHref(href) {
    return /\.drawio\.svg$/i.test(href.split(/[?#]/)[0]);
  }
  function hrefOf(el2) {
    return (el2.getAttribute("data-drawio") ?? el2.getAttribute("href") ?? el2.getAttribute("xlink:href") ?? "").split(/[?#]/)[0];
  }
  var DIAGRAM_MODES = [
    { value: "picture", label: "Picture" },
    { value: "inline", label: "Drawn on the slide" },
    { value: "themed", label: "In the deck's theme" }
  ];
  function diagramMode(el2) {
    const mode2 = drawnDiagram(el2)?.getAttribute("data-drawio-mode");
    return mode2 === "inline" || mode2 === "themed" ? mode2 : "picture";
  }
  var open3 = null;
  function editDiagram(sel) {
    const image = diagramOf(sel.el);
    const src = sourceOf(sel.key);
    if (!image || !src) return;
    if (!src.writable) {
      toast(
        "This picture lives in a layout: edit it in the Slide master",
        "error"
      );
      return;
    }
    void openDrawio({
      path: hrefOf(image),
      image: {
        file: src.path,
        hash: src.hash,
        loc: image.getAttribute("data-ink") ?? sel.loc
      },
      id: image.getAttribute("id")
    });
  }
  function newDiagram() {
    if (!currentSlide()) return;
    void openDrawio({ path: null });
  }
  async function openDrawio(target) {
    if (open3) return;
    const res = await request({ action: "drawio-load", path: target.path });
    if (!res.ok) {
      toast(res.error ?? "Cannot open that diagram", "error");
      return;
    }
    const base2 = String(res.url);
    let origin2;
    try {
      origin2 = new URL(base2).origin;
    } catch {
      toast(`INKFLOW_DRAWIO_URL is not a web address: ${base2}`, "error");
      return;
    }
    const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin2);
    if (!navigator.onLine && !local) {
      offerDesktop(
        target,
        `This computer is offline, and draw.io loads from ${origin2}.`
      );
      return;
    }
    const dark = document.documentElement.dataset.theme !== "light";
    const params = new URLSearchParams({
      embed: "1",
      proto: "json",
      spin: "1",
      configure: "1",
      saveAndExit: "1",
      noSaveBtn: "0",
      libraries: "1",
      modified: "unsavedChanges",
      ui: dark ? "dark" : "kennedy"
    });
    const frame = h("iframe", {
      class: "drawio-frame",
      src: `${base2}${base2.includes("?") ? "&" : "?"}${params}`,
      title: "draw.io"
    });
    let path = target.path;
    let exitAfterSave = false;
    let saving = false;
    let loaded = false;
    const status3 = h("p", {}, `Loading draw.io from ${origin2}\u2026`);
    const note2 = h(
      "div",
      { class: "drawio-note" },
      h(
        "div",
        { class: "drawio-note-card" },
        status3,
        h(
          "div",
          { class: "btn-row" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              title: "Draw it in the draw.io app on this computer (no internet needed)",
              onclick: () => {
                close2();
                void useDesktop({ ...target, path });
              }
            },
            "Use draw.io desktop instead"
          ),
          h(
            "button",
            { type: "button", class: "pbtn", onclick: () => close2() },
            "Cancel"
          )
        )
      )
    );
    const wrap2 = h("div", { id: "drawio", class: "drawio" }, frame, note2);
    document.body.append(wrap2);
    open3 = wrap2;
    const slow = window.setTimeout(() => {
      if (loaded) return;
      status3.textContent = `draw.io did not load from ${origin2}. Is this computer offline? Draw the diagram in draw.io desktop instead.`;
      note2.classList.add("failed");
    }, 15e3);
    const post = (msg) => frame.contentWindow?.postMessage(JSON.stringify(msg), origin2);
    const close2 = () => {
      window.clearTimeout(slow);
      window.removeEventListener("message", onMessage2);
      wrap2.remove();
      open3 = null;
    };
    const save5 = async (svg) => {
      const first = path === null;
      const step2 = `drawio-save-${Date.now()}`;
      const result = await edit({
        action: "drawio-save",
        path,
        svg,
        image: first ? void 0 : target.image,
        coalesce: step2
      });
      if (result.ok && !first && target.id) followArrows(target.id, step2);
      saving = false;
      if (!result.ok) {
        post({ action: "status", message: "Not saved", modified: true });
        return;
      }
      if (first && typeof result.rel === "string") {
        path = result.rel;
        await insertDiagramImage(
          String(result.path),
          Number(result.width) || 640,
          Number(result.height) || 360
        );
      }
      if (exitAfterSave) close2();
      else post({ action: "status", message: "Saved", modified: false });
    };
    const onMessage2 = (e2) => {
      if (e2.source !== frame.contentWindow || e2.origin !== origin2) return;
      let msg;
      try {
        msg = JSON.parse(String(e2.data));
      } catch {
        return;
      }
      switch (msg.event) {
        case "configure":
          loaded = true;
          post({ action: "configure", config: { compressXml: false } });
          break;
        case "init":
          loaded = true;
          note2.remove();
          post({
            action: "load",
            xml: String(res.xml ?? ""),
            autosave: 0,
            title: String(res.name ?? "Diagram")
          });
          break;
        case "save":
          if (saving) break;
          saving = true;
          exitAfterSave = !!msg.exit;
          post({ action: "export", format: "xmlsvg", spin: "Saving" });
          break;
        case "export": {
          const data = String(msg.data ?? "");
          const svg = decodeSvg(data);
          if (svg) void save5(svg);
          else {
            saving = false;
            toast("draw.io sent something other than an SVG", "error");
          }
          break;
        }
        case "exit":
          close2();
          break;
      }
    };
    window.addEventListener("message", onMessage2);
  }
  function followArrows(id, step2) {
    const rendered2 = () => {
      off("render", rendered2);
      window.clearTimeout(give);
      const stale = connectorsTo(id).filter(isStale);
      if (stale.length)
        void rerouteConnectors(stale, "Re-route arrows", step2);
    };
    const give = window.setTimeout(() => off("render", rendered2), 1e4);
    on("render", rendered2);
  }
  var redraws = /* @__PURE__ */ new Map();
  var redrawCount = 0;
  function diagramEdited(diagram, step2) {
    const id = diagram.getAttribute("id");
    if (!id) return;
    const n3 = ++redrawCount;
    window.clearTimeout(timers.get(id));
    redraws.set(id, n3);
    timers.set(
      id,
      window.setTimeout(() => void redraw3(id, step2, n3), 600)
    );
  }
  var timers = /* @__PURE__ */ new Map();
  function drawnById(id) {
    return slideRoot()?.querySelector(
      `svg[data-drawio][id="${CSS.escape(id)}"]`
    ) ?? null;
  }
  function rendered(ms = 4e3) {
    return new Promise((resolve) => {
      const done = () => {
        off("render", done);
        window.clearTimeout(give);
        resolve();
      };
      const give = window.setTimeout(done, ms);
      on("render", done);
    });
  }
  async function redraw3(id, step2, n3) {
    const latest = () => redraws.get(id) === n3;
    await rendered(1500);
    const diagram = drawnById(id);
    const path = diagram?.getAttribute("data-drawio");
    if (!diagram || !path || !latest()) return;
    const res = await request({ action: "drawio-load", path });
    if (!res.ok || !latest()) return;
    let svg;
    try {
      svg = await renderDiagram(String(res.xml ?? ""), String(res.url));
    } catch (err) {
      if (latest()) {
        toast(
          `${err instanceof Error ? err.message : String(err)}: the shape changed, and draw.io's own arrows follow it the next time draw.io opens the diagram`,
          "error"
        );
      }
      return;
    }
    const now = drawnById(id);
    const src = now ? sourceOf(keyOf(now)) : null;
    const box2 = now ? alignedBox(now, svg) : null;
    if (!now || !src || !box2 || !latest()) return;
    const result = await edit(
      {
        action: "drawio-save",
        path,
        svg,
        expect: res.hash,
        image: {
          file: src.path,
          hash: src.hash,
          loc: now.getAttribute("data-ink") ?? ""
        },
        box: box2,
        coalesce: step2
      },
      { retrying: true }
    );
    if (result.ok) {
      redraws.delete(id);
      followArrows(id, step2);
    }
  }
  function alignedBox(diagram, svgText) {
    const holder = h("div", {
      style: "position:fixed;left:-30000px;top:0;visibility:hidden",
      "aria-hidden": "true"
    });
    holder.innerHTML = svgText;
    document.body.append(holder);
    try {
      const fresh = holder.querySelector("svg");
      const oldRoot = diagram.querySelector(":scope > g");
      const newRoot = fresh?.querySelector(":scope > g");
      if (!fresh || !oldRoot || !newRoot) return null;
      const dx = [];
      const dy = [];
      for (const cell of diagram.querySelectorAll(
        'g[data-cell-kind="vertex"][data-cell-id]'
      )) {
        const id = cell.getAttribute("data-cell-id") ?? "";
        const other = newRoot.querySelector(
          `g[data-cell-id="${CSS.escape(id)}"]`
        );
        const a2 = drawnBox(cell, oldRoot);
        const b2 = other ? drawnBox(other, newRoot) : null;
        if (!a2 || !b2) continue;
        dx.push(b2.x - a2.x);
        dy.push(b2.y - a2.y);
      }
      const vbOld = diagram.viewBox.baseVal;
      const vbNew = fresh.viewBox.baseVal;
      if (!dx.length || !vbOld?.width || !vbNew?.width) return null;
      const num3 = (name2) => Number.parseFloat(diagram.getAttribute(name2) ?? "0") || 0;
      const sx = num3("width") / vbOld.width;
      const sy = num3("height") / vbOld.height;
      const r2 = (v2) => Math.round(v2 * 100) / 100;
      return {
        x: r2(num3("x") + (vbNew.x - vbOld.x - median(dx)) * sx),
        y: r2(num3("y") + (vbNew.y - vbOld.y - median(dy)) * sy),
        width: r2(vbNew.width * sx),
        height: r2(vbNew.height * sy)
      };
    } finally {
      holder.remove();
    }
  }
  var renderer = null;
  var renderQueue = Promise.resolve();
  function closeRenderer() {
    renderer?.frame.remove();
    renderer = null;
  }
  function hiddenFrame(base2) {
    if (renderer && renderer.base === base2) {
      window.clearTimeout(renderer.closeTimer);
      renderer.closeTimer = window.setTimeout(closeRenderer, 18e4);
      return renderer;
    }
    closeRenderer();
    const origin2 = new URL(base2).origin;
    const params = new URLSearchParams({
      embed: "1",
      proto: "json",
      configure: "1",
      spin: "0"
    });
    const frame = h("iframe", {
      src: `${base2}${base2.includes("?") ? "&" : "?"}${params}`,
      title: "draw.io (drawing the diagram)",
      "aria-hidden": "true",
      tabindex: "-1",
      style: "position:fixed;left:-30000px;top:0;width:1200px;height:800px;border:0"
    });
    frame.inert = true;
    const ready = new Promise((resolve, reject) => {
      const give = window.setTimeout(() => {
        window.removeEventListener("message", onMessage2);
        reject(new Error("draw.io did not load"));
      }, 2e4);
      const onMessage2 = (e2) => {
        if (e2.source !== frame.contentWindow || e2.origin !== origin2) return;
        const msg = parseMessage(e2.data);
        if (msg?.event === "configure") {
          frame.contentWindow?.postMessage(
            JSON.stringify({
              action: "configure",
              config: { compressXml: false }
            }),
            origin2
          );
        } else if (msg?.event === "init") {
          window.clearTimeout(give);
          window.removeEventListener("message", onMessage2);
          resolve();
        }
      };
      window.addEventListener("message", onMessage2);
    });
    document.body.append(frame);
    renderer = {
      base: base2,
      frame,
      origin: origin2,
      ready,
      closeTimer: window.setTimeout(closeRenderer, 18e4)
    };
    ready.catch(() => closeRenderer());
    return renderer;
  }
  function parseMessage(data) {
    try {
      return JSON.parse(String(data));
    } catch {
      return null;
    }
  }
  function renderDiagram(xml, base2) {
    const run = renderQueue.then(async () => {
      let origin2;
      try {
        origin2 = new URL(base2).origin;
      } catch {
        throw new Error(`INKFLOW_DRAWIO_URL is not a web address: ${base2}`);
      }
      const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin2);
      if (!navigator.onLine && !local)
        throw new Error("This computer is offline");
      const r2 = hiddenFrame(base2);
      await r2.ready;
      return new Promise((resolve, reject) => {
        const post = (msg) => r2.frame.contentWindow?.postMessage(
          JSON.stringify(msg),
          r2.origin
        );
        const finish2 = () => {
          window.clearTimeout(give);
          window.removeEventListener("message", onMessage2);
          if (document.activeElement === r2.frame) r2.frame.blur();
        };
        const give = window.setTimeout(() => {
          finish2();
          reject(new Error("draw.io did not draw the diagram"));
        }, 2e4);
        const onMessage2 = (e2) => {
          if (e2.source !== r2.frame.contentWindow || e2.origin !== r2.origin)
            return;
          const msg = parseMessage(e2.data);
          if (msg?.event === "load") {
            post({ action: "export", format: "xmlsvg", spin: "0" });
          } else if (msg?.event === "export") {
            finish2();
            const svg = decodeSvg(String(msg.data ?? ""));
            if (svg) resolve(svg);
            else reject(new Error("draw.io sent no SVG"));
          }
        };
        window.addEventListener("message", onMessage2);
        post({ action: "load", xml, autosave: 0 });
      });
    });
    renderQueue = run.catch(() => void 0);
    return run;
  }
  function offerDesktop(target, why) {
    openDialog(
      "Draw in draw.io desktop?",
      h(
        "div",
        { class: "deck-form" },
        h("p", {}, why),
        h(
          "p",
          { class: "hint" },
          "The diagram can be drawn in the draw.io app on this computer instead: save there, and the slide updates."
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => closeDialog()
            },
            "Cancel"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              onclick: () => {
                closeDialog();
                void useDesktop(target);
              }
            },
            "Open in draw.io desktop"
          )
        )
      )
    );
  }
  async function useDesktop(target) {
    let path = target.path;
    const apps = path ? await request({ action: "open-apps", path }) : null;
    if (path && !hasDesktop(apps?.apps)) {
      desktopMissing();
      return;
    }
    if (!path) {
      const made = await edit({ action: "drawio-new" });
      if (!made.ok || typeof made.rel !== "string") return;
      path = made.rel;
      const placed = await insertDiagramImage(
        String(made.path),
        Number(made.width) || 640,
        Number(made.height) || 360
      );
      if (!placed) return;
      const found = await request({ action: "open-apps", path });
      if (!hasDesktop(found.apps)) {
        desktopMissing();
        return;
      }
    }
    const res = await request({ action: "open-file", path, app: "drawio" });
    if (!res.ok) {
      toast(res.error ?? "draw.io desktop did not start", "error");
      return;
    }
    toast("Opened in draw.io desktop: save there and the slide updates", "ok");
  }
  function hasDesktop(apps) {
    return Array.isArray(apps) && apps.some((a2) => a2.id === "drawio");
  }
  function desktopMissing() {
    openDialog(
      "draw.io desktop is not installed",
      h(
        "div",
        { class: "deck-form" },
        h(
          "p",
          {},
          "Install the draw.io app (free) on this computer, then try again:"
        ),
        h(
          "ul",
          {},
          h(
            "li",
            {},
            h(
              "a",
              {
                href: "https://www.drawio.com/",
                target: "_blank",
                rel: "noopener"
              },
              "drawio.com"
            ),
            " (Windows, macOS, Linux)"
          ),
          h(
            "li",
            {},
            "Linux: flatpak install flathub com.jgraph.drawio.desktop"
          )
        ),
        h(
          "p",
          { class: "hint" },
          "Or run draw.io on your own network (the jgraph/drawio Docker image) and start inkflow with INKFLOW_DRAWIO_URL pointing at it."
        )
      )
    );
  }
  function decodeSvg(data) {
    const m2 = data.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
    if (!m2) return data.trimStart().startsWith("<") ? data : null;
    if (!m2[1]) return decodeURIComponent(m2[2]);
    const bytes = Uint8Array.from(atob(m2[2]), (c2) => c2.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // src/ts/editor/objects.ts
  var host4 = document.getElementById("objects");
  var body = document.getElementById("props-body");
  var tabs = document.getElementById("panel-tabs");
  var NAMES = {
    g: "Group",
    rect: "Rectangle",
    circle: "Circle",
    ellipse: "Ellipse",
    line: "Line",
    polyline: "Polyline",
    polygon: "Polygon",
    path: "Path",
    text: "Text",
    image: "Image",
    svg: "Image",
    use: "Clone",
    foreignObject: "Content",
    a: "Link"
  };
  var collapsed = /* @__PURE__ */ new Set();
  function label2(el2) {
    if (isZone(el2)) return `Zone \xB7 ${zoneName(el2)}`;
    const id = el2.getAttribute("id");
    const kind = el2.hasAttribute("data-ink-layer") ? "Layer" : NAMES[el2.localName] ?? el2.localName;
    if (el2.localName === "text") {
      const t2 = (el2.textContent ?? "").trim().replace(/\s+/g, " ");
      return id ? `${id} \xB7 \u201C${t2.slice(0, 24)}\u201D` : `\u201C${t2.slice(0, 32)}\u201D`;
    }
    return id ?? kind;
  }
  function isHidden(el2) {
    return el2.style?.display === "none" || el2.getAttribute("display") === "none";
  }
  function children(el2) {
    return [...el2.children].filter(
      (c2) => c2.hasAttribute("data-ink") && !["title", "desc", "defs", "style", "metadata"].includes(
        c2.localName
      ) && // A cropped picture's own <image> is part of the picture.
      el2.localName !== "svg"
    );
  }
  function selFor(el2) {
    return {
      el: el2,
      key: keyOf(el2),
      loc: el2.getAttribute("data-ink") ?? ""
    };
  }
  async function toggleHidden2(el2) {
    await sendSvgOps(
      [
        {
          sel: selFor(el2),
          ops: [
            {
              kind: "style",
              loc: el2.getAttribute("data-ink") ?? "",
              set: { display: isHidden(el2) ? null : "none" }
            }
          ]
        }
      ],
      isHidden(el2) ? "Show" : "Hide"
    );
  }
  async function toggleLocked(el2) {
    const own = el2.hasAttribute("data-ink-locked");
    if (!own && isLocked(el2)) {
      toast("It is inside a locked layer or group: unlock that instead");
      return;
    }
    await sendSvgOps(
      [
        {
          sel: selFor(el2),
          ops: [
            {
              kind: "lock",
              loc: el2.getAttribute("data-ink") ?? "",
              locked: !own
            }
          ]
        }
      ],
      own ? "Unlock" : "Lock"
    );
  }
  function rename(el2, nameEl) {
    const src = sourceOf(keyOf(el2));
    if (!src?.writable || isZone(el2)) return;
    const id = el2.getAttribute("id") ?? "";
    const input = h("input", { type: "text", class: "obj-rename", value: id });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish2 = (save5) => {
      if (done) return;
      done = true;
      const v2 = input.value.trim();
      if (save5 && v2 && v2 !== id) {
        void edit({
          action: "svg",
          file: src.path,
          hash: src.hash,
          ops: [
            {
              kind: "id",
              loc: el2.getAttribute("data-ink"),
              id: v2,
              from: id || void 0
            }
          ],
          label: "Rename"
        });
      }
      renderObjects();
    };
    input.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Enter") finish2(true);
      else if (e2.key === "Escape") finish2(false);
    });
    input.addEventListener("blur", () => finish2(true));
  }
  function pickFromList(el2) {
    if (isLocked(el2)) {
      toast("Locked: unlock it to select it");
      return;
    }
    const parent = el2.parentElement;
    if (parent && !el2.hasAttribute("data-ink-top") && parent.localName === "g" && !parent.hasAttribute("data-ink-layer")) {
      enterGroup(parent);
    } else if (ed.scope && !ed.scope.contains(el2)) {
      enterGroup(null);
    }
    if (!selectable(el2)) {
      toast(
        ed.layoutMode ? "This object cannot be edited here" : "From a layout or overlay: change it in the Slide master"
      );
      return;
    }
    select([el2]);
  }
  function row5(el2, depth) {
    const loc = el2.getAttribute("data-ink") ?? "";
    const src = sourceOf(keyOf(el2));
    const writable = !!src?.writable && (canTransform(el2) || ed.layoutMode || isOwnObject(el2));
    const kids = children(el2);
    const group2 = kids.length > 0;
    const open5 = group2 && !collapsed.has(loc);
    const selected = ed.selection.some((s2) => s2.el === el2);
    const locked = el2.hasAttribute("data-ink-locked");
    const hidden = isHidden(el2);
    const name2 = h("span", { class: "obj-name" }, label2(el2));
    const out = [];
    const item2 = h(
      "div",
      {
        class: `obj-row${selected ? " on" : ""}${writable ? "" : " foreign"}${hidden ? " hidden-obj" : ""}`,
        title: src ? `${label2(el2)} \xB7 ${src.rel}` : label2(el2),
        style: `padding-left:${8 + depth * 14}px`
      },
      h(
        "button",
        {
          type: "button",
          class: `obj-twisty${group2 ? "" : " none"}`,
          title: open5 ? "Collapse" : "Expand",
          onclick: (e2) => {
            e2.stopPropagation();
            if (collapsed.has(loc)) collapsed.delete(loc);
            else collapsed.add(loc);
            renderObjects();
          }
        },
        group2 ? open5 ? "\u25BE" : "\u25B8" : ""
      ),
      name2,
      writable ? h(
        "button",
        {
          type: "button",
          class: `obj-toggle${hidden ? " on" : ""}`,
          title: hidden ? "Hidden: click to show" : "Hide (on the slide and in the presentation)",
          onclick: (e2) => {
            e2.stopPropagation();
            void toggleHidden2(el2);
          }
        },
        icon(hidden ? "eyeOff" : "eye", 14)
      ) : null,
      writable ? h(
        "button",
        {
          type: "button",
          class: `obj-toggle${locked ? " on" : ""}`,
          title: locked ? "Locked: click to unlock" : "Lock (cannot be selected on the slide)",
          onclick: (e2) => {
            e2.stopPropagation();
            void toggleLocked(el2);
          }
        },
        icon(locked ? "lock" : "unlock", 14)
      ) : h("span", { class: "obj-badge" }, src?.role ?? "")
    );
    item2.addEventListener("click", () => pickFromList(el2));
    item2.addEventListener("dblclick", () => rename(el2, name2));
    item2.addEventListener("mouseenter", () => setHover(el2));
    item2.addEventListener("mouseleave", () => setHover(null));
    out.push(item2);
    if (open5) {
      for (const k2 of [...kids].reverse()) out.push(...row5(k2, depth + 1));
    }
    return out;
  }
  function isOwnObject(el2) {
    const src = sourceOf(keyOf(el2));
    return !!src && (src.role === "slide" || src.role === "ink") && src.writable;
  }
  function renderObjects() {
    if (host4.hidden) return;
    clear(host4);
    const svg = slideRoot();
    if (!svg) return;
    const top = [...svg.querySelectorAll("[data-ink-top], [data-ink-layer]")].filter((el2) => {
      const parent = el2.parentElement?.closest(
        "[data-ink-top], [data-ink-layer]"
      );
      return !parent || !svg.contains(parent);
    }).reverse();
    if (!top.length) {
      host4.append(h("p", { class: "hint" }, "No objects on this slide."));
      return;
    }
    host4.append(
      h(
        "p",
        { class: "hint" },
        "Top of the stack first. Middle-click (or Alt+click) on the slide steps through overlapping objects."
      )
    );
    for (const el2 of top) host4.append(...row5(el2, 0));
  }
  function showTab(tab) {
    for (const b2 of tabs.querySelectorAll("[data-tab]")) {
      b2.classList.toggle("on", b2.dataset.tab === tab);
      b2.setAttribute("aria-selected", String(b2.dataset.tab === tab));
    }
    host4.hidden = tab !== "objects";
    body.hidden = tab === "objects";
    try {
      localStorage.setItem("inkflow-editor-tab", tab);
    } catch {
    }
    renderObjects();
  }
  function initObjects() {
    tabs.addEventListener("click", (e2) => {
      const tab = e2.target.closest("[data-tab]")?.dataset.tab;
      if (tab) showTab(tab);
    });
    let saved = "props";
    try {
      saved = localStorage.getItem("inkflow-editor-tab") ?? "props";
    } catch {
    }
    showTab(saved === "objects" ? "objects" : "props");
    on("render", renderObjects);
    on("selection", renderObjects);
  }

  // src/ts/editor/stepcycle.ts
  function nextStep(step2, max, back = false) {
    if (max <= 0) return null;
    if (step2 == null) return back ? max : 0;
    const s2 = Math.min(step2, max);
    if (back) return s2 === 0 ? null : s2 - 1;
    return s2 >= max ? null : s2 + 1;
  }
  function wrapped(from, to) {
    return from != null && to == null;
  }
  function stepLabel(step2, max) {
    return step2 == null ? "Steps" : `Step ${Math.min(step2, max)}/${max}`;
  }
  function stepTitle(step2, max) {
    if (max <= 0) return "Nothing on this slide appears step by step";
    const how = "Click: next step; Shift+click or right-click: back";
    if (step2 == null) {
      return `Every object is shown, for editing. ${how}: the slide as the audience sees it, click by click (${max} ${max === 1 ? "click" : "clicks"}).`;
    }
    const where = step2 === 0 ? "as the slide appears, before the first click" : `after click ${step2} of ${max}`;
    return `Previewing ${where}; editing is paused. ${how}; after the last step it shows every object again.`;
  }

  // src/ts/editor/stepbutton.ts
  var flash = 0;
  function button4() {
    return document.getElementById("btn-step");
  }
  function slideMax() {
    const svg = slideRoot();
    return svg ? maxStep(svg) : 0;
  }
  function showStepLabel(step2) {
    const b2 = button4();
    if (!b2 || flash) return;
    const max = slideMax();
    b2.textContent = stepLabel(step2, max);
    b2.title = stepTitle(step2, max);
    b2.classList.toggle("on", step2 != null);
    b2.disabled = max === 0 && step2 == null;
  }
  function renderStepButton() {
    showStepLabel(ed.step);
  }
  function setStep(step2) {
    const from = ed.step;
    ed.step = step2;
    document.body.classList.toggle("previewing", step2 != null);
    render();
    emit("step");
    if (wrapped(from, step2)) cameRound();
  }
  function cameRound() {
    const b2 = button4();
    if (!b2) return;
    window.clearTimeout(flash);
    b2.classList.remove("came-round");
    void b2.offsetWidth;
    b2.classList.add("came-round");
    b2.textContent = "\u21BA All objects";
    flash = window.setTimeout(() => {
      flash = 0;
      b2.classList.remove("came-round");
      renderStepButton();
    }, 900);
  }
  function initStepButton() {
    const b2 = button4();
    if (!b2) return;
    b2.addEventListener("click", (e2) => {
      setStep(nextStep(ed.step, slideMax(), e2.shiftKey));
    });
    b2.addEventListener("contextmenu", (e2) => {
      e2.preventDefault();
      setStep(nextStep(ed.step, slideMax(), true));
    });
  }

  // src/ts/editor/animsteps.ts
  function cueSteps(cues, svg) {
    const seen = /* @__PURE__ */ new Map();
    return cues.map((cue) => {
      if (!svg) return null;
      const byId2 = (id) => svg.querySelector(`[id="${CSS.escape(id)}"]`);
      if (cue.kind === "video") {
        const zone = byId2(`zone-${cue.element}`) ?? byId2(cue.element);
        const v2 = zone?.querySelector("[data-play-on-step]");
        const s2 = Number(v2?.getAttribute("data-play-on-step"));
        return Number.isFinite(s2) && s2 > 0 ? s2 : null;
      }
      const el2 = byId2(cue.element) ?? byId2(`zone-${cue.element}`);
      const n3 = seen.get(cue.element) ?? 0;
      seen.set(cue.element, n3 + 1);
      try {
        const list4 = JSON.parse(el2?.getAttribute("data-cues") ?? "[]");
        const steps = list4.map((c2) => c2.step).sort((a2, b2) => a2 - b2);
        return steps[n3] ?? null;
      } catch {
        return null;
      }
    });
  }

  // src/ts/editor/animpreview.ts
  var current2 = null;
  function previewPlaying() {
    return current2 !== null;
  }
  function stopPreview() {
    current2?.cancel();
  }
  function wait(ms, cancelled) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (cancelled() || now - t0 >= ms) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  function playRun(root2, from, to, cancelled) {
    const run = buildStepRun(root2, from, to);
    if (!run.totalMs) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (cancelled()) {
          resolve();
          return;
        }
        const v2 = Math.min(1, (now - t0) / run.totalMs);
        seekStepRun(run, v2);
        if (v2 < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }
  function showStep(step2) {
    showStepLabel(step2);
    for (const row7 of document.querySelectorAll(
      ".anim-row[data-step]"
    )) {
      row7.classList.toggle(
        "playing",
        step2 != null && row7.dataset.step === String(step2)
      );
    }
  }
  async function playAnimations(from = 1) {
    stopPreview();
    const first = slideRoot();
    const last = first ? maxStep(first) : 0;
    if (!first || last === 0) {
      toast("Nothing on this slide is animated yet");
      return;
    }
    const before = ed.step;
    let cancelled = false;
    const run = { cancel: () => cancelled = true };
    current2 = run;
    const stopOnClick = (e2) => {
      if (!e2.target.closest?.(".anim-preview-ctl")) run.cancel();
    };
    const stopOnKey = (e2) => {
      if (e2.key === "Escape") run.cancel();
    };
    document.addEventListener("pointerdown", stopOnClick, true);
    document.addEventListener("keydown", stopOnKey, true);
    document.body.classList.add("previewing", "anim-playing");
    emit("preview");
    ed.step = Math.max(0, Math.min(from, last) - 1);
    render();
    const root2 = slideRoot();
    const gone = () => cancelled || slideRoot() !== root2;
    if (root2) {
      for (let s2 = ed.step + 1; s2 <= last && !gone(); s2++) {
        showStep(s2);
        await playRun(root2, s2 - 1, s2, gone);
        if (gone()) break;
        applyStepInstant(root2, s2);
        ed.step = s2;
        await wait(s2 < last ? 450 : 900, gone);
      }
    }
    document.removeEventListener("pointerdown", stopOnClick, true);
    document.removeEventListener("keydown", stopOnKey, true);
    if (current2 === run) current2 = null;
    document.body.classList.remove("anim-playing");
    document.body.classList.toggle("previewing", before != null);
    ed.step = before;
    showStep(null);
    render();
    emit("preview");
  }

  // src/ts/editor/videopreview.ts
  function videoOf(el2) {
    if (!el2) return null;
    return el2.localName === "video" ? el2 : el2.querySelector("video");
  }
  function isPreviewing(video) {
    return !video.paused && !video.ended;
  }
  function togglePreview(video) {
    if (isPreviewing(video)) {
      video.pause();
      return;
    }
    const start = parseFloat(video.dataset.start ?? "") || 0;
    const end = parseFloat(video.dataset.end ?? "");
    if (video.currentTime < start || end > 0 && video.currentTime >= end) {
      video.currentTime = start;
    }
    if (end > 0) {
      const stop2 = () => {
        if (video.currentTime >= end) {
          video.pause();
          video.removeEventListener("timeupdate", stop2);
        }
      };
      video.addEventListener("timeupdate", stop2);
    }
    void video.play().catch(() => {
    });
  }
  function previewButton(video, make) {
    const btn = make(
      "\u25B6 Play preview",
      "Play the video here (the presenter plays it as the deck says)",
      () => togglePreview(video)
    );
    const sync = () => {
      btn.textContent = isPreviewing(video) ? "\u23F8 Pause preview" : "\u25B6 Play preview";
    };
    for (const ev of ["play", "pause", "ended"])
      video.addEventListener(ev, sync);
    sync();
    return btn;
  }

  // src/ts/editor/props.ts
  var panel = document.getElementById("props-body");
  function section2(title3, ...body3) {
    return h(
      "section",
      { class: "props-section" },
      h("h3", {}, title3),
      ...body3.filter((b2) => !!b2)
    );
  }
  function row6(label4, ...controls) {
    return h(
      "label",
      { class: "prop-row" },
      h("span", { class: "prop-label" }, label4),
      ...controls
    );
  }
  function numberInput(value, commit, opts2 = {}) {
    const input = h("input", {
      type: "number",
      class: "num",
      step: opts2.step ?? 1,
      min: opts2.min ?? null,
      placeholder: opts2.placeholder ?? "",
      value: value == null ? "" : String(Math.round(value * 100) / 100)
    });
    const fire = () => {
      const v2 = parseFloat(input.value);
      if (Number.isFinite(v2)) commit(v2);
      else if (input.value.trim() === "") opts2.onClear?.();
    };
    input.addEventListener("change", fire);
    input.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Enter") input.blur();
    });
    return input;
  }
  function textInput(value, commit, placeholder = "") {
    const input = h("input", { type: "text", value, placeholder });
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Enter") input.blur();
    });
    return input;
  }
  function selectInput(options, value, commit) {
    const sel = h("select", {});
    for (const o2 of options) {
      const opt = h("option", { value: o2.value }, o2.label);
      if (o2.value === value) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => commit(sel.value));
    return sel;
  }
  function button5(label4, title3, fn, cls = "") {
    return h(
      "button",
      { type: "button", class: `pbtn ${cls}`, title: title3, onclick: fn },
      label4
    );
  }
  function fieldControl(f2, value, commit) {
    switch (f2.kind) {
      case "trigger": {
        const labels = {
          "on-click": "On click",
          "with-previous": "With previous",
          "after-previous": "After previous"
        };
        const v2 = String(value ?? f2.default ?? "on-click");
        const opts2 = f2.choices.map((c2) => ({
          value: c2,
          label: labels[c2] ?? c2
        }));
        if (!f2.choices.includes(v2))
          opts2.push({ value: v2, label: `At step ${v2}` });
        return selectInput(opts2, v2, commit);
      }
      case "enum":
      case "easing": {
        const v2 = String(value ?? f2.default ?? "");
        const opts2 = f2.choices.map((c2) => ({ value: c2, label: c2 }));
        if (v2 && !f2.choices.includes(v2)) opts2.push({ value: v2, label: v2 });
        return selectInput(opts2, v2, commit);
      }
      case "bool": {
        const cb = h("input", { type: "checkbox" });
        cb.checked = Boolean(value);
        cb.addEventListener("change", () => commit(cb.checked));
        return cb;
      }
      case "int":
      case "float":
        return numberInput(
          typeof value === "number" ? value : null,
          (v2) => commit(f2.kind === "int" ? Math.round(v2) : v2),
          {
            step: f2.kind === "int" ? 1 : 0.05,
            placeholder: f2.optional ? "none" : "",
            onClear: f2.optional ? () => commit(null) : void 0
          }
        );
      default:
        return textInput(value == null ? "" : String(value), commit);
    }
  }
  function fieldsEditor(schema, values, commit) {
    const box2 = h("div", { class: "fields" });
    for (const f2 of schema) {
      const label4 = f2.name.replace(/_/g, " ");
      box2.append(
        row6(
          label4,
          fieldControl(
            f2,
            values[f2.name] ?? f2.default,
            (v2) => commit({ ...values, [f2.name]: v2 })
          )
        )
      );
    }
    return box2;
  }
  var MEDIA_LABELS = {
    fit: "Fit",
    align: "Anchor",
    controls: "Controls",
    autoplay: "Autoplay",
    muted: "Mute",
    loop: "Loop",
    poster: "Poster",
    start: "Trim start",
    end: "Trim end"
  };
  function mediaSection(slide, zone, media) {
    const kind = media.kind === "video" ? "video" : "image";
    const schema = ed.model?.mediaTypes?.[kind] ?? [];
    const values = media.fields ?? {};
    const commit = (name2, v2) => void edit({
      action: "media-props",
      slide: slide.deckIndex,
      zone,
      fields: { [name2]: v2 }
    });
    const rows = [];
    for (const f2 of schema) {
      const label4 = MEDIA_LABELS[f2.name] ?? f2.name.replace(/_/g, " ");
      if (f2.name === "poster") {
        const poster = values.poster;
        rows.push(
          h(
            "div",
            { class: "prop-row" },
            h("span", { class: "prop-label" }, label4),
            h(
              "span",
              { class: "media-poster" },
              poster ? String(poster).split("/").pop() : "None"
            ),
            button5(
              poster ? "Change\u2026" : "Pick\u2026",
              poster ? `Poster: ${poster}` : "Still image shown before playback",
              async () => {
                const file = await pickFile("image/*");
                const up = file ? await upload(file) : null;
                if (up) commit("poster", up.path);
              }
            ),
            poster ? button5(
              "\u2715",
              "Remove the poster",
              () => commit("poster", null)
            ) : null
          )
        );
        continue;
      }
      if (f2.name === "background") {
        rows.push(
          backgroundRow(
            values.background ?? null,
            (v2) => commit("background", v2)
          )
        );
        continue;
      }
      if (f2.name === "muted") {
        const opts2 = [
          { value: "auto", label: "When autoplaying" },
          { value: "on", label: "Always" },
          { value: "off", label: "Never" }
        ];
        rows.push(
          row6(
            label4,
            selectInput(
              opts2,
              String(values.muted ?? "auto"),
              (v2) => commit("muted", v2)
            )
          )
        );
        continue;
      }
      if (f2.name === "start" || f2.name === "end") {
        const v2 = values[f2.name];
        rows.push(
          row6(
            label4,
            numberInput(
              typeof v2 === "number" ? v2 : null,
              (n3) => commit(f2.name, n3),
              {
                step: 0.1,
                min: 0,
                placeholder: "seconds",
                onClear: () => commit(f2.name, null)
              }
            )
          )
        );
        continue;
      }
      rows.push(
        row6(
          label4,
          fieldControl(
            f2,
            values[f2.name] ?? f2.default,
            (v2) => commit(f2.name, v2)
          )
        )
      );
    }
    if (kind === "video") {
      rows.push(
        h(
          "p",
          { class: "hint" },
          "To start it on a click instead, add a Play video animation below."
        )
      );
    }
    return section2(kind === "video" ? "Video" : "Image", ...rows);
  }
  function zonePageRow(slide, zone, ref) {
    const file = projectFile(ref);
    const page = pdfPage(ref);
    const show2 = (n3) => {
      if (!file || n3 === page) return;
      void edit({
        action: "zone-media",
        slide: slide.deckIndex,
        zone,
        src: file,
        page: n3
      });
    };
    return h(
      "div",
      { class: "prop-row" },
      h("span", { class: "prop-label" }, "Page"),
      numberInput(page, (n3) => show2(Math.max(1, Math.round(n3))), { min: 1 }),
      button5("Pages\u2026", "See the PDF's pages and pick one", async () => {
        const choice = file ? await choosePage(file, page) : null;
        if (choice) show2(choice.page);
      })
    );
  }
  function chartSection(slide, zone, value) {
    const s2 = chartSettings(value);
    const commit = (fields) => void edit({
      action: "chart-props",
      slide: slide.deckIndex,
      zone,
      fields
    });
    const grid = {
      columns: value.columns ?? [],
      rows: []
    };
    const numeric = value.numeric ?? [];
    const x2 = xColumn(grid, s2);
    const shown3 = s2.y ?? numeric.filter((c2) => c2 !== x2);
    const check = (label4, on2, fn) => {
      const box2 = h("input", { type: "checkbox" });
      box2.checked = on2;
      box2.addEventListener("change", () => fn(box2.checked));
      return row6(label4, box2);
    };
    const series = h("div", { class: "chart-series" });
    const twoAxes = secondAxisAllowed(s2);
    for (const c2 of grid.columns.filter((c3) => c3 !== x2)) {
      const box2 = h("input", { type: "checkbox" });
      box2.checked = shown3.includes(c2);
      box2.disabled = !numeric.includes(c2);
      box2.addEventListener("change", () => {
        const next = grid.columns.filter(
          (n3) => n3 === c2 ? box2.checked : shown3.includes(n3)
        );
        const auto = numeric.filter((n3) => n3 !== x2);
        const same = next.length === auto.length && next.every((n3, i2) => n3 === auto[i2]);
        commit({
          y: same ? null : next,
          ...box2.checked ? {} : { y2: toggleRight(s2, c2, false) }
        });
      });
      const entry = h("label", { class: "chart-check" }, box2, c2);
      if (twoAxes && shown3.includes(c2) && numeric.includes(c2)) {
        const right = h("input", { type: "checkbox" });
        right.checked = (s2.y2 ?? []).includes(c2);
        right.addEventListener(
          "change",
          () => commit({ y2: toggleRight(s2, c2, right.checked) })
        );
        series.append(
          h(
            "span",
            { class: "chart-series-row" },
            entry,
            h(
              "label",
              {
                class: "chart-check chart-right",
                title: `Draw ${c2} against a second axis, on the right`
              },
              right,
              "right axis"
            )
          )
        );
      } else series.append(entry);
    }
    const rows = [
      row6(
        "Kind",
        selectInput(CHART_KINDS, s2.kind, (v2) => commit({ kind: v2 }))
      ),
      row6(
        s2.kind === "scatter" ? "X values" : "Categories",
        selectInput(
          grid.columns.map((c2) => ({ value: c2, label: c2 })),
          x2 ?? "",
          (v2) => commit({ x: v2 === grid.columns[0] ? null : v2 })
        )
      ),
      h(
        "div",
        { class: "prop-row" },
        h(
          "span",
          { class: "prop-label" },
          s2.kind === "pie" ? "Sizes" : "Series"
        ),
        series
      ),
      row6(
        "Title",
        textInput(s2.title ?? "", (v2) => commit({ title: v2 }), "none")
      )
    ];
    const range = (label4, lo, hi) => h(
      "div",
      { class: "prop-row" },
      h(
        "span",
        {
          class: "prop-label",
          title: "Where the axis starts and ends; empty: from the data"
        },
        label4
      ),
      h(
        "span",
        { class: "chart-range-row" },
        rangeInput(s2[lo], (v2) => commit({ [lo]: v2 }), "from"),
        h("span", { class: "hint" }, "to"),
        rangeInput(s2[hi], (v2) => commit({ [hi]: v2 }), "auto")
      )
    );
    if (s2.kind !== "pie") {
      rows.push(range(s2.y2 ? "Left axis" : "Value axis", "y_min", "y_max"));
      if (s2.y2 && twoAxes) rows.push(range("Right axis", "y2_min", "y2_max"));
    }
    if (s2.kind === "bar" || s2.kind === "area") {
      rows.push(check("Stacked", s2.stacked, (v2) => commit({ stacked: v2 })));
    }
    if (s2.kind === "bar") {
      rows.push(
        check("Horizontal", s2.horizontal, (v2) => commit({ horizontal: v2 }))
      );
    }
    if (s2.kind === "pie") {
      rows.push(check("Donut", s2.donut, (v2) => commit({ donut: v2 })));
    }
    rows.push(
      check("Value labels", s2.labels, (v2) => commit({ labels: v2 })),
      row6(
        "Legend",
        selectInput(
          [
            { value: "auto", label: "Auto" },
            { value: "on", label: "Show" },
            { value: "off", label: "Hide" }
          ],
          s2.legend == null ? "auto" : s2.legend ? "on" : "off",
          (v2) => commit({ legend: v2 === "auto" ? null : v2 === "on" })
        )
      ),
      h(
        "p",
        { class: "hint" },
        `Each series is a group with the id ${zone}-series-<column>: animate them one by one.`
      )
    );
    if (value.error) {
      rows.unshift(h("p", { class: "hint error" }, value.error));
    }
    return section2("Chart", ...rows);
  }
  function typeInfo(list4, type) {
    return list4.find((t2) => t2.type === type) ?? null;
  }
  function renderSlidePanel() {
    const slide = currentSlide();
    const model2 = ed.model;
    if (!slide || !model2) return;
    const editable = model2.deckEditable;
    const di = slide.deckIndex;
    const root2 = slideRoot();
    const parent = root2?.getAttribute("inkflow:parent") ?? null;
    const currentLayout = slide.srcShared ? slide.src.replace(/\.svg$/, "") : parent;
    panel.append(
      section2(
        "Slide",
        row6(
          "Title",
          textInput(slide.title ?? "", (v2) => {
            void edit({
              action: "slide",
              op: "title",
              slide: di,
              title: v2
            });
          })
        ),
        row6(
          "Layout",
          button5(
            `${currentLayout ? layoutLabel(currentLayout) : "None"} \u25BE`,
            "Pick a layout from previews",
            () => void openGallery({
              mode: "change",
              current: currentLayout
            }),
            "wide"
          )
        ),
        editable && h(
          "div",
          { class: "prop-buttons" },
          button5(
            "Save as layout\u2026",
            "Make a new layout (a template) from this slide: new slides can start from it",
            () => saveAsLayout(di)
          ),
          currentLayout ? button5(
            "Edit its layout",
            "Open the slide master at the layout this slide is built on: edits change every slide on it",
            () => void openMaster()
          ) : null
        ),
        row6(
          "Font size",
          numberInput(
            slide.fontSize,
            (v2) => void edit({
              action: "slide",
              op: "font-size",
              slide: di,
              size: v2
            }),
            { placeholder: "deck default" }
          )
        ),
        slide.visible && row6(
          "Starred",
          (() => {
            const cb = h("input", { type: "checkbox" });
            cb.checked = isStarred(di);
            cb.title = "Your own mark, kept outside the deck (S)";
            cb.addEventListener("change", () => {
              void toggleStar([di]);
            });
            return cb;
          })()
        ),
        row6(
          "Hidden",
          (() => {
            const cb = h("input", { type: "checkbox" });
            cb.checked = !slide.visible;
            cb.disabled = !editable;
            cb.addEventListener("change", () => {
              void edit({
                action: "slide",
                op: "hide",
                slide: di,
                hidden: cb.checked
              });
            });
            return cb;
          })()
        ),
        !editable && h(
          "p",
          { class: "hint" },
          "deck.py builds its slide list in code, so slide-level settings are read-only here."
        )
      )
    );
    panel.append(transitionSection(slide.transition, di));
    panel.append(animationList(slide.animations, slide.animationsEditable, di));
    const files2 = h("div", { class: "files" });
    const addFile = (label4, rel, path) => {
      if (rel)
        files2.append(
          h(
            "div",
            { class: "file" },
            h("span", {}, label4),
            h("code", { title: path ?? rel }, rel),
            openButton(path)
          )
        );
    };
    addFile("Drawing", slide.srcShared ? null : slide.srcRel, slide.srcPath);
    addFile("Layout", slide.srcShared ? slide.srcRel : null, slide.srcPath);
    addFile("Markdown", slide.md?.rel, slide.md?.path);
    addFile("Notes", slide.notes.rel, slide.notes.path);
    const deckPath = ed.model?.deckPath;
    if (deckPath) addFile("Deck", fileName2(deckPath), deckPath);
    if (editable)
      files2.append(
        button5(
          "Rename files\u2026",
          "Give this slide's drawing, Markdown, notes and ink one new name (its id follows)",
          () => renameSlideFiles(di)
        )
      );
    const textInDeck = slide.md?.kind !== "file" && (slide.md?.kind === "inline" || Object.values(slide.zones).some((z) => z.kind === "text"));
    if (textInDeck && editable)
      files2.append(
        button5(
          "Move text to Markdown",
          "Move this slide's text out of deck.py into its own .md file",
          () => void edit({ action: "to-markdown", slide: di })
        )
      );
    panel.append(section2("Files", files2));
    const arrows = attachedConnectors();
    if (arrows.length) {
      const stale = arrows.filter((a2) => isStale(a2.el)).length;
      panel.append(
        section2(
          "Arrows",
          h(
            "p",
            { class: "hint" },
            `${arrows.length} arrow${arrows.length === 1 ? " is" : "s are"} attached to shapes and follow them when they move here. After moving shapes in another editor, re-route them:`
          ),
          stale ? h(
            "p",
            { class: "hint warn" },
            `${stale} ${stale === 1 ? "arrow no longer meets its shape" : "arrows no longer meet their shapes"} (moved in draw.io or another editor).`
          ) : null,
          button5(
            "Re-route all",
            "Re-attach every arrow to its shapes",
            () => reroute(arrows)
          )
        )
      );
    }
    if (slide.srcShared) {
      panel.append(
        h(
          "p",
          { class: "hint" },
          "This slide is drawn by a shared layout. Draw on it (or insert anything) and it gets its own SVG built on that layout. Use the \u201CSlide master\u201D to change the layout itself, for every slide on it."
        )
      );
    }
  }
  function transitionSection(current3, di) {
    const model2 = ed.model;
    const types = model2.transitionTypes;
    const value = current3?.type ?? "";
    const opts2 = [
      { value: "", label: `Deck default (${model2.defaultTransition.type})` },
      ...types.map((t2) => ({ value: t2.type, label: t2.type }))
    ];
    const send2 = (spec) => void edit({ action: "slide", op: "transition", slide: di, spec });
    const body3 = [
      row6(
        "Type",
        selectInput(opts2, value, (v2) => {
          if (!v2) send2(null);
          else send2({ type: v2, fields: {} });
        })
      )
    ];
    if (current3) {
      const info4 = typeInfo(types, current3.type);
      if (info4) {
        body3.push(
          fieldsEditor(
            info4.fields,
            current3.fields,
            (fields) => send2({ type: current3.type, fields })
          )
        );
      }
    }
    return section2("Transition into this slide", ...body3);
  }
  function triggerLabel(t2) {
    if (t2 === "with-previous") return "with previous";
    if (t2 === "after-previous") return "after previous";
    if (t2 === "on-click" || t2 == null) return "on click";
    return `step ${t2}`;
  }
  function animationList(cues, editable, di) {
    const model2 = ed.model;
    const list4 = h("div", { class: "anim-list" });
    if (!cues.length)
      list4.append(h("p", { class: "hint" }, "No animations on this slide."));
    const steps = cueSteps(cues, slideRoot());
    const replace2 = (i2, type, fields) => void edit({
      action: "anim",
      slide: di,
      op: "replace",
      index: i2,
      spec: { type, element: cues[i2].element, fields }
    });
    cues.forEach((cue, i2) => {
      const step2 = steps[i2];
      const info4 = typeInfo(model2.animationTypes, cue.type);
      const trigger = cue.fields.trigger ?? "on-click";
      const typeSelect = selectInput(
        model2.animationTypes.filter((t2) => t2.kind === "video" === (cue.kind === "video")).map((t2) => ({ value: t2.type, label: t2.type })),
        cue.type,
        (v2) => {
          const names2 = new Set(
            typeInfo(model2.animationTypes, v2)?.fields.map(
              (f2) => f2.name
            )
          );
          const kept = Object.fromEntries(
            Object.entries(cue.fields).filter(([k2]) => names2.has(k2))
          );
          replace2(i2, v2, { ...kept, trigger });
        }
      );
      const triggerField = info4?.fields.find((f2) => f2.kind === "trigger");
      const triggerSelect = triggerField ? fieldControl(
        triggerField,
        trigger,
        (v2) => replace2(i2, cue.type, { ...cue.fields, trigger: v2 })
      ) : null;
      const item2 = h(
        "div",
        {
          class: "anim-row",
          "data-step": step2 == null ? null : String(step2)
        },
        h(
          "div",
          { class: "anim-item" },
          h("span", {
            class: `anim-kind k-${cue.kind}`,
            title: cue.kind
          }),
          h(
            "span",
            {
              class: "anim-step",
              title: step2 == null ? "Not on the slide" : `Plays on click ${step2}`
            },
            step2 == null ? "\u2013" : String(step2)
          ),
          h(
            "button",
            {
              type: "button",
              class: "anim-target",
              title: "Select this element",
              onclick: () => selectById(cue.element)
            },
            `#${cue.element}`
          ),
          step2 != null && button5(
            icon("play", 12),
            "Preview from this animation",
            () => void playAnimations(step2),
            "anim-preview-ctl"
          ),
          editable && button5(icon("up", 12), "Earlier", () => {
            if (i2 > 0)
              void edit({
                action: "anim",
                slide: di,
                op: "move",
                index: i2,
                to: i2 - 1
              });
          }),
          editable && button5(icon("down", 12), "Later", () => {
            if (i2 < cues.length - 1) {
              void edit({
                action: "anim",
                slide: di,
                op: "move",
                index: i2,
                to: i2 + 1
              });
            }
          }),
          editable && button5(icon("trash", 12), "Remove", () => {
            void edit({
              action: "anim",
              slide: di,
              op: "remove",
              index: i2
            });
          })
        ),
        editable ? h("div", { class: "anim-edit" }, typeSelect, triggerSelect) : h(
          "div",
          { class: "anim-edit" },
          h("span", { class: "anim-type" }, cue.type),
          h(
            "span",
            { class: "anim-trigger" },
            triggerLabel(cue.fields.trigger ?? null)
          )
        )
      );
      list4.append(item2);
    });
    if (!editable && cues.length) {
      list4.append(
        h(
          "p",
          { class: "hint" },
          "Animations are built in code in deck.py; read-only."
        )
      );
    }
    const svg = slideRoot();
    const animated = !!svg && maxStep(svg) > 0;
    const playing = previewPlaying();
    const controls = h(
      "div",
      { class: "btn-row anim-preview" },
      playing ? button5(
        "\u25A0 Stop",
        "Stop the preview (Esc)",
        () => stopPreview(),
        "anim-preview-ctl"
      ) : button5(
        "\u25B6 Play",
        "Play this slide's animations here, click by click",
        () => void playAnimations(1),
        "anim-preview-ctl"
      )
    );
    if (!animated && !playing)
      controls.firstChild.disabled = true;
    return section2("Animation order", controls, list4);
  }
  function selectById(id) {
    const svg = slideRoot();
    const found = svg?.querySelector(`[id="${CSS.escape(id)}"]`);
    const el2 = found?.closest("[data-ink]") ?? null;
    if (el2) {
      enterGroup(null);
      select([el2]);
    } else toast(`#${id} is not on this slide`, "error");
  }
  function elementAnimations(sel) {
    const slide = currentSlide();
    const model2 = ed.model;
    const id = sel.el.getAttribute("id");
    const di = slide.deckIndex;
    const editable = slide.animationsEditable && model2.deckEditable;
    const body3 = h("div", { class: "anim-list" });
    const elementName = isZone(sel.el) ? zoneName(sel.el) : id;
    const steps = cueSteps(slide.animations, slideRoot());
    slide.animations.forEach((cue, index) => {
      if (!elementName || cue.element !== (cue.kind === "video" ? zoneName(sel.el) : id))
        return;
      const info4 = typeInfo(model2.animationTypes, cue.type);
      const send2 = (type, fields) => void edit({
        action: "anim",
        slide: di,
        op: "replace",
        index,
        spec: { type, element: cue.element, fields }
      });
      const header2 = h(
        "div",
        { class: "anim-head" },
        h("span", { class: `anim-kind k-${cue.kind}` }),
        editable ? selectInput(
          model2.animationTypes.map((t2) => ({
            value: t2.type,
            label: t2.type
          })),
          cue.type,
          (v2) => send2(v2, {
            trigger: cue.fields.trigger ?? "on-click"
          })
        ) : h("span", {}, cue.type),
        steps[index] != null && button5(
          icon("play", 12),
          `Preview (click ${steps[index]})`,
          () => void playAnimations(steps[index] ?? 1),
          "anim-preview-ctl"
        ),
        editable && button5(icon("trash", 12), "Remove", () => {
          void edit({
            action: "anim",
            slide: di,
            op: "remove",
            index
          });
        })
      );
      body3.append(
        h(
          "div",
          { class: "anim-card" },
          header2,
          info4 && editable ? fieldsEditor(
            info4.fields,
            cue.fields,
            (f2) => send2(cue.type, f2)
          ) : null
        )
      );
    });
    if (editable) {
      const add = animationPicker(
        model2.animationTypes,
        isZone(sel.el),
        "+ Add animation\u2026"
      );
      add.addEventListener("change", () => {
        const type = add.value;
        if (!type) return;
        const video = typeInfo(model2.animationTypes, type)?.kind === "video";
        const element = video ? zoneName(sel.el) : id;
        const src = sourceOf(sel.key);
        void edit({
          action: "anim",
          slide: di,
          op: "insert",
          index: slide.animations.length,
          spec: { type, element: element ?? "", fields: {} },
          target: element || !src ? void 0 : {
            file: src.path,
            loc: sel.loc,
            base: sel.el.localName
          }
        });
      });
      body3.append(add);
    } else if (!slide.animationsEditable) {
      body3.append(
        h(
          "p",
          { class: "hint" },
          "This slide's animations are built in code."
        )
      );
    }
    return section2("Animations", body3);
  }
  function animationPicker(all, video, prompt) {
    const groups = {};
    for (const t2 of all) {
      if (t2.kind === "video" && !video) continue;
      const kind = t2.kind ?? "other";
      groups[kind] = [...groups[kind] ?? [], t2];
    }
    const add = h("select", { class: "add-anim" });
    add.append(h("option", { value: "" }, prompt));
    for (const [kind, types] of Object.entries(groups)) {
      const og = h("optgroup", { label: kind });
      for (const t2 of types)
        og.append(h("option", { value: t2.type }, t2.type));
      add.append(og);
    }
    return add;
  }
  var TAG_NAMES = {
    g: "Group",
    rect: "Rectangle",
    circle: "Circle",
    ellipse: "Ellipse",
    line: "Line",
    polyline: "Polyline",
    polygon: "Polygon",
    path: "Path",
    text: "Text",
    image: "Image",
    svg: "Image (cropped)",
    use: "Clone",
    foreignObject: "Embedded content"
  };
  function tokenOf(el2, prop) {
    for (const c2 of el2.classList) {
      const m2 = c2.match(/^inkflow-(fill|stroke)-(.+)$/);
      if (m2 && m2[1] === prop) return m2[2];
    }
    return null;
  }
  function rgbToHex(rgb) {
    const m2 = rgb.match(/\d+(\.\d+)?/g);
    if (!m2 || m2.length < 3) return "#000000";
    return `#${m2.slice(0, 3).map((v2) => Math.round(Number(v2)).toString(16).padStart(2, "0")).join("")}`;
  }
  function boxOps(s2) {
    return isZone(s2.el) ? [{ kind: "attrs", loc: s2.loc, set: { "inkflow:show-shape": "true" } }] : [];
  }
  function boxShown(el2) {
    return !isZone(el2) || el2.hasAttribute("inkflow:show-shape");
  }
  function paintRow(sel, prop) {
    const first = sel[0].el;
    const shown3 = boxShown(first);
    const token = shown3 ? tokenOf(first, prop) : null;
    const computed = shown3 ? getComputedStyle(first)[prop] : "none";
    const send2 = (paint4) => {
      const plans = sel.map((s2) => ({
        sel: s2,
        ops: [
          ...boxOps(s2),
          { kind: "paint", loc: s2.loc, prop, ...paint4 }
        ]
      }));
      void sendSvgOps(plans, prop === "fill" ? "Fill" : "Stroke");
    };
    const swatches = h("div", { class: "swatches" });
    for (const t2 of ed.model?.colorTokens ?? []) {
      swatches.append(
        h("button", {
          type: "button",
          class: `swatch${t2 === token ? " active" : ""}`,
          title: t2,
          style: `background: var(--inkflow-${t2})`,
          onclick: () => send2({ token: t2 })
        })
      );
    }
    const custom = h("input", {
      type: "color",
      value: computed && computed !== "none" ? rgbToHex(computed) : "#000000",
      title: "Custom colour"
    });
    custom.addEventListener("change", () => send2({ color: custom.value }));
    swatches.append(custom);
    swatches.append(
      button5("\u2205", "None", () => send2({ color: "none" }), "none-btn")
    );
    return row6(prop === "fill" ? "Fill" : "Stroke", swatches);
  }
  function styleOps(sel, set, label4) {
    void sendSvgOps(
      sel.map((s2) => ({
        sel: s2,
        ops: [...boxOps(s2), { kind: "style", loc: s2.loc, set }]
      })),
      label4
    );
  }
  function focusCellLabel(_el) {
    const area2 = panel.querySelector(".cell-label");
    area2?.focus();
    area2?.select();
  }
  function tokenHex(token) {
    const probe = h("span", { style: `color: var(--inkflow-${token})` });
    (slideRoot()?.parentElement ?? document.body).append(probe);
    const hex = rgbToHex(getComputedStyle(probe).color);
    probe.remove();
    return hex;
  }
  function cellColorRow(label4, current3, pick2) {
    const swatches = h("div", { class: "swatches" });
    for (const t2 of ed.model?.colorTokens ?? []) {
      swatches.append(
        h("button", {
          type: "button",
          class: "swatch",
          title: `${t2} (as its colour now)`,
          style: `background: var(--inkflow-${t2})`,
          onclick: () => pick2(tokenHex(t2))
        })
      );
    }
    const custom = h("input", {
      type: "color",
      value: current3,
      title: "Custom colour"
    });
    custom.addEventListener("change", () => pick2(custom.value));
    swatches.append(custom);
    return row6(label4, swatches);
  }
  function renderCellPanel(sel) {
    const el2 = sel.el;
    const cell = el2.getAttribute("data-cell-id") ?? "";
    const themed = el2.closest("svg[data-drawio]")?.getAttribute("data-drawio-mode") === "themed";
    const send2 = (op, label4) => void sendSvgOps([{ sel, ops: [op] }], label4);
    const style = (key, value, label4) => send2({ kind: "cell-style", cell, key, value }, label4);
    const painted2 = cellShape(el2).querySelector(
      "rect, ellipse, path, polygon, circle"
    );
    const look = painted2 ? getComputedStyle(painted2) : null;
    const hex = (v2) => v2 && v2 !== "none" ? rgbToHex(v2) : "#ffffff";
    const area2 = h("textarea", {
      class: "cell-label",
      rows: 2,
      spellcheck: "true"
    });
    area2.value = cellLabel(el2);
    area2.addEventListener(
      "change",
      () => send2({ kind: "cell-label", cell, text: area2.value }, "Shape label")
    );
    area2.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" && !e2.shiftKey) {
        e2.preventDefault();
        area2.blur();
      }
    });
    panel.append(
      section2(
        "draw.io shape",
        row6("Id", h("code", {}, el2.getAttribute("id") ?? "")),
        row6("Label", area2),
        cellColorRow(
          "Fill",
          hex(look?.fill),
          (v2) => style("fillColor", v2, "Shape fill")
        ),
        cellColorRow(
          "Line",
          hex(look?.stroke),
          (v2) => style("strokeColor", v2, "Shape line")
        ),
        row6(
          "Line width",
          numberInput(
            parseFloat(look?.strokeWidth ?? "1") || 1,
            (v2) => style("strokeWidth", v2, "Shape line width")
          )
        ),
        h(
          "p",
          { class: "hint" },
          `Changes go into the diagram's draw.io source, and draw.io redraws it (its arrows follow).${themed ? " In the deck's theme, colours show as the nearest theme colour." : ""} Copying, grouping, rotating and stacking shapes stay in draw.io. Enter keeps a label; Esc leaves the diagram.`
        ),
        h(
          "div",
          { class: "btn-row" },
          button5("Leave the diagram", "Esc", () => enterGroup(null))
        )
      )
    );
    panel.append(geometrySection([sel]));
    panel.append(elementAnimations(sel));
  }
  function renderObjectPanel(sel) {
    const el2 = sel.el;
    if (isDiagramCell(el2)) {
      renderCellPanel(sel);
      return;
    }
    const src = sourceOf(sel.key);
    const zone = isZone(el2);
    const movable = canTransform(el2);
    const id = el2.getAttribute("id") ?? "";
    const tag = zone ? `Zone \xB7 ${zoneName(el2)}` : drawnDiagram(el2) ? "Diagram" : TAG_NAMES[el2.localName] ?? el2.localName;
    panel.append(
      section2(
        tag,
        row6(
          "Id",
          zone ? h("code", {}, id) : textInput(
            id,
            (v2) => {
              if (!src || !v2 || v2 === id) return;
              void edit({
                action: "svg",
                file: src.path,
                hash: src.hash,
                ops: [
                  {
                    kind: "id",
                    loc: sel.loc,
                    id: v2,
                    from: id
                  }
                ],
                label: "Rename"
              });
            },
            "no id"
          )
        ),
        src && h(
          "div",
          { class: "source-hint" },
          h(
            "p",
            { class: "hint" },
            `In ${src.rel}${src.role !== "slide" && src.role !== "ink" || currentSlide()?.srcShared ? ` \xB7 shared by ${src.usedBy.length} slide${src.usedBy.length === 1 ? "" : "s"}` : ""}`
          ),
          openButton(src.path)
        )
      )
    );
    if (zone && ed.master) panel.append(placeholderSection(sel));
    if (!zone && ed.master) {
      const make = makePlaceholderSection(sel);
      if (make) panel.append(make);
    }
    if (zone && !ed.master) {
      const slide = currentSlide();
      const name2 = zoneName(el2);
      const origin2 = slide.zoneOrigins?.[name2];
      const media = slide.zones[name2];
      const where = origin2 === "deck" ? "deck.py zones=" : origin2 === "md-file" ? `${slide.md?.rel ?? "Markdown"} (whole file)` : slide.md?.rel ? `${slide.md.rel} \xB7 ::${name2}::` : "deck.py";
      const textFile = origin2 === "deck" || !slide.md?.path ? ed.model?.deckPath : slide.md.path;
      const isMedia = !!media && (media.kind === "image" || media.kind === "video" || media.kind === "chart");
      const body3 = [
        h(
          "div",
          { class: "source-hint" },
          h("p", { class: "hint" }, `Content from ${where}`),
          isMedia ? null : openButton(textFile)
        )
      ];
      if (media?.kind === "chart") {
        body3.push(
          h(
            "div",
            { class: "source-hint" },
            h(
              "p",
              { class: "hint media-src" },
              media.inline ? "Data written in deck.py" : media.src ?? ""
            ),
            media.path ? openButton(media.path) : null,
            media.inline ? null : renameButton(media.path)
          ),
          button5(
            "Edit data\u2026",
            "Edit the chart's table (double-click)",
            () => void editChart(name2)
          )
        );
      } else if (media && (media.kind === "image" || media.kind === "video")) {
        body3.push(
          h(
            "div",
            { class: "source-hint" },
            h("p", { class: "hint media-src" }, media.src ?? ""),
            openButton(projectFile(media.src)),
            renameButton(projectFile(media.src))
          ),
          ...media.kind === "image" && isPdfRef(media.src ?? "") ? [zonePageRow(slide, name2, media.src ?? "")] : [],
          button5(
            "Replace media\u2026",
            "Pick another image or video",
            () => void zoneMedia(name2)
          ),
          button5("Clear", "Empty this zone", () => {
            void edit({
              action: "zone-media",
              slide: slide.deckIndex,
              zone: name2,
              src: null
            });
          })
        );
        const video = media.kind === "video" ? videoOf(el2) : null;
        if (video) body3.push(previewButton(video, button5));
        if (media.kind === "video" && media.src) {
          const src2 = media.src;
          body3.push(
            button5(
              "Check & convert\u2026",
              "Can every browser play it? Convert it to MP4 or WebM, smaller or at another resolution",
              () => void openVideoCheck({
                path: src2,
                slide: slide.deckIndex,
                zone: name2
              })
            )
          );
        }
      } else {
        body3.push(
          button5(
            "Edit text",
            "Edit this zone's Markdown (double-click)",
            () => {
              emit("edit-zone");
            }
          )
        );
      }
      panel.append(section2("Content", ...body3));
      if (media && (media.kind === "image" || media.kind === "video")) {
        panel.append(mediaSection(slide, name2, media));
      }
      if (media?.kind === "chart") {
        panel.append(chartSection(slide, name2, media));
      }
    }
    const innerVideo = zone ? null : videoOf(el2);
    if (innerVideo) {
      panel.append(section2("Video", previewButton(innerVideo, button5)));
    }
    const textZone = zone && el2.localName === "foreignObject" && !!el2.querySelector(".inkflow-content");
    if (textZone) {
      const sizes = textSizeSection(
        sel,
        !!src?.writable && (movable || ed.layoutMode)
      );
      if (sizes) panel.append(sizes);
    }
    if (movable) panel.append(geometrySection([sel]));
    const shapeTag = textZone ? el2.getAttribute("data-ink-tag") ?? "rect" : el2.localName;
    if ((!zone || textZone) && src?.writable && (movable || ed.layoutMode)) {
      const picture = !!pictureOf(el2) || !!drawnDiagram(el2);
      const fills = ![
        "line",
        "polyline",
        "image",
        "foreignObject",
        "g"
      ].includes(shapeTag);
      const strokeWidth = parseFloat(getComputedStyle(el2).strokeWidth) || 0;
      const opacity = parseFloat(getComputedStyle(el2).opacity);
      panel.append(
        section2(
          "Style",
          fills && !picture && paintRow([sel], "fill"),
          !picture && el2.localName !== "g" && paintRow([sel], "stroke"),
          !picture && el2.localName !== "g" && row6(
            "Stroke width",
            numberInput(
              strokeWidth,
              (v2) => styleOps(
                [sel],
                { "stroke-width": String(v2) },
                "Stroke width"
              )
            )
          ),
          row6(
            "Opacity",
            (() => {
              const r2 = h("input", {
                type: "range",
                min: 0,
                max: 1,
                step: 0.05,
                value: String(
                  Number.isFinite(opacity) ? opacity : 1
                )
              });
              r2.addEventListener(
                "change",
                () => styleOps(
                  [sel],
                  { opacity: r2.value === "1" ? null : r2.value },
                  "Opacity"
                )
              );
              return r2;
            })()
          ),
          shapeTag === "rect" && row6(
            "Corner radius",
            numberInput(
              parseFloat(el2.getAttribute("rx") ?? "0") || 0,
              (v2) => {
                void sendSvgOps(
                  [
                    {
                      sel,
                      ops: [
                        ...boxOps(sel),
                        {
                          kind: "attrs",
                          loc: sel.loc,
                          set: {
                            rx: String(v2),
                            ry: null
                          }
                        }
                      ]
                    }
                  ],
                  "Corner radius"
                );
              }
            )
          )
        )
      );
      if (el2.localName === "text") panel.append(textSection(sel));
      if (textZone) panel.append(textBoxSection(sel));
    }
    if (!zone && src?.writable && movable && isConnector(el2)) {
      panel.append(connectorSection(sel));
    }
    if (src?.writable && (movable || ed.layoutMode) && !isConnector(el2) && el2.localName !== "line") {
      panel.append(connectionPointsSection(sel));
    }
    if (!zone && src?.writable && pictureOf(el2)) {
      panel.append(pictureSection(sel));
    }
    if (!zone && src?.writable && drawnDiagram(el2)) {
      panel.append(diagramSection(sel));
      const shapes2 = diagramShapesSection(sel);
      if (shapes2) panel.append(shapes2);
    }
    if (!zone && src?.writable && (movable || ed.layoutMode)) {
      panel.append(detailsSection(sel));
    }
    if (movable) panel.append(arrangeSection([sel]));
    if (!ed.master && (id || zone || src?.writable))
      panel.append(elementAnimations(sel));
  }
  var ARROW = "url(#inkflow-arrow)";
  function attachedConnectors() {
    const svg = slideRoot();
    if (!svg) return [];
    return [...svg.querySelectorAll("[data-ink]")].filter(
      (el2) => isConnector(el2) && canTransform(el2) && (el2.hasAttribute("inkflow:connect-start") || el2.hasAttribute("inkflow:connect-end"))
    ).map((el2) => ({
      el: el2,
      key: parseInt(
        (el2.getAttribute("data-ink") ?? "").split(":")[0],
        10
      ),
      loc: el2.getAttribute("data-ink") ?? ""
    }));
  }
  function reroute(sels) {
    const plans = sels.map((s2) => ({ s: s2, d: connectorPath(s2.el) })).filter((x2) => !!x2.d).map(({ s: s2, d: d2 }) => ({
      sel: s2,
      ops: [{ kind: "attrs", loc: s2.loc, set: { d: d2 } }]
    }));
    if (plans.length) void sendSvgOps(plans, "Re-route arrows");
  }
  function connectorSection(sel) {
    const el2 = sel.el;
    const has = (attr) => (el2.getAttribute(attr) ?? "").includes("inkflow-arrow");
    const heads = has("marker-start") ? has("marker-end") ? "both" : "start" : has("marker-end") ? "end" : "none";
    const send2 = (set, label4, marker = false) => void sendSvgOps(
      [
        {
          sel,
          ops: [
            ...marker ? [{ kind: "ensure-marker" }] : [],
            { kind: "attrs", loc: sel.loc, set }
          ]
        }
      ],
      label4
    );
    const describe2 = (which) => {
      const c2 = parseConnection(el2.getAttribute(`inkflow:connect-${which}`));
      return c2 ? `${c2.id} (${c2.site})` : "free";
    };
    return section2(
      "Connector",
      row6(
        "Route",
        selectInput(
          [
            { value: "straight", label: "Straight" },
            { value: "elbow", label: "Elbow" },
            { value: "curved", label: "Curved" }
          ],
          connectorStyle(el2),
          (v2) => {
            const style = v2;
            const d2 = connectorPath(el2, {}, style, null);
            send2(
              {
                "inkflow:connector": v2,
                "inkflow:bend": null,
                ...d2 ? { d: d2 } : {}
              },
              "Connector route"
            );
          }
        )
      ),
      row6(
        "Arrowheads",
        selectInput(
          [
            { value: "none", label: "None" },
            { value: "end", label: "At the end" },
            { value: "start", label: "At the start" },
            { value: "both", label: "Both ends" }
          ],
          heads,
          (v2) => send2(
            {
              "marker-start": v2 === "start" || v2 === "both" ? ARROW : null,
              "marker-end": v2 === "end" || v2 === "both" ? ARROW : null
            },
            "Arrowheads",
            v2 !== "none"
          )
        )
      ),
      h(
        "p",
        { class: "hint" },
        `Start: ${describe2("start")} \xB7 End: ${describe2("end")}. Drag an end onto a shape's dot to attach it; Alt while dragging keeps it free.${connectorStyle(el2) === "elbow" ? " Drag the yellow handle to move the elbow's middle segment." : ""}`
      ),
      h(
        "div",
        { class: "btn-row" },
        button5(
          "Re-route",
          "Re-attach to the shapes where they are now",
          () => reroute([sel])
        ),
        el2.hasAttribute("inkflow:bend") && button5(
          "Reset bend",
          "Put the elbow's middle segment back where it goes by default",
          () => {
            const d2 = connectorPath(el2, {}, "elbow", null);
            send2(
              { "inkflow:bend": null, ...d2 ? { d: d2 } : {} },
              "Reset bend"
            );
          }
        ),
        button5(
          "Detach",
          "Free both ends",
          () => send2(
            {
              "inkflow:connect-start": null,
              "inkflow:connect-end": null
            },
            "Detach"
          )
        )
      )
    );
  }
  function connectionPointsSection(sel) {
    const n3 = sitesPerSide(sel.el);
    const box2 = section2(
      "Connection points",
      row6(
        "Per side",
        selectInput(
          [1, 2, 3, 4, 5, 7, 9].map((k2) => ({
            value: String(k2),
            label: k2 === 1 ? "1 (middle)" : String(k2)
          })),
          String(n3),
          (v2) => void sendSvgOps(
            [
              {
                sel,
                ops: [
                  {
                    kind: "attrs",
                    loc: sel.loc,
                    set: {
                      "inkflow:sites": v2 === "1" ? null : v2
                    }
                  }
                ]
              }
            ],
            "Connection points"
          )
        )
      )
    );
    box2.addEventListener(
      "mouseenter",
      () => showSites([{ el: sel.el, active: null }])
    );
    box2.addEventListener("mouseleave", () => showSites([]));
    return box2;
  }
  function textBoxSection(sel) {
    const el2 = sel.el;
    const value = (name2) => el2.style.getPropertyValue(name2).trim();
    const setVar = (name2, v2, label4) => void sendSvgOps(
      [
        {
          sel,
          ops: [{ kind: "style", loc: sel.loc, set: { [name2]: v2 } }]
        }
      ],
      label4
    );
    const shown3 = el2.hasAttribute("inkflow:show-shape");
    const box2 = h("input", { type: "checkbox" });
    box2.checked = shown3;
    box2.addEventListener(
      "change",
      () => void sendSvgOps(
        [
          {
            sel,
            ops: [
              {
                kind: "attrs",
                loc: sel.loc,
                set: {
                  "inkflow:show-shape": box2.checked ? "true" : null
                }
              }
            ]
          }
        ],
        box2.checked ? "Show box" : "Hide box"
      )
    );
    const padding = parseFloat(value("--inkflow-padding"));
    return section2(
      "Text box",
      row6("Draw the box", box2),
      row6(
        "Padding",
        numberInput(
          Number.isFinite(padding) ? padding : null,
          (v2) => setVar(
            "--inkflow-padding",
            `${Math.max(0, v2)}px`,
            "Padding"
          ),
          {
            min: 0,
            placeholder: "auto",
            onClear: () => setVar("--inkflow-padding", null, "Padding")
          }
        )
      ),
      row6(
        "Align",
        selectInput(
          [
            { value: "", label: "Default" },
            { value: "left", label: "Left" },
            { value: "center", label: "Centre" },
            { value: "right", label: "Right" },
            { value: "justify", label: "Justify" }
          ],
          value("--inkflow-align"),
          (v2) => setVar("--inkflow-align", v2 || null, "Text align")
        )
      ),
      row6(
        "Vertical",
        selectInput(
          [
            { value: "", label: "Default" },
            { value: "start", label: "Top" },
            { value: "center", label: "Middle" },
            { value: "end", label: "Bottom" }
          ],
          value("--inkflow-valign"),
          (v2) => setVar("--inkflow-valign", v2 || null, "Vertical align")
        )
      )
    );
  }
  function textSizeSection(sel, shapeWritable) {
    const fo = sel.el;
    const wrapper = fo.querySelector(
      ":scope > .inkflow-wrapper"
    );
    const slide = currentSlide();
    const onSlide2 = !!slide && !ed.master && !ed.layoutMode;
    if (!wrapper || !shapeWritable && !onSlide2) return null;
    const name2 = zoneName(fo);
    const SCALE = "--inkflow-font-scale";
    const FIT = "--inkflow-fit";
    const without = (holder, prop) => {
      const style = holder.style;
      const own = style.getPropertyValue(prop);
      style.removeProperty(prop);
      const v2 = getComputedStyle(holder).getPropertyValue(prop).trim();
      if (own) style.setProperty(prop, own);
      return v2;
    };
    const onContent = (prop) => onSlide2 && (wrapper.style.getPropertyValue(prop).trim() !== "" || !shapeWritable);
    const write2 = (prop, value2, label4) => {
      if (onContent(prop)) {
        const key = prop === SCALE ? "size" : "fit";
        void edit({
          action: "zone-format",
          slide: slide.deckIndex,
          zone: name2,
          [key]: value2 == null ? null : key === "size" ? Number(value2) : value2
        });
        return;
      }
      void sendSvgOps(
        [
          {
            sel,
            ops: [
              { kind: "style", loc: sel.loc, set: { [prop]: value2 } }
            ]
          }
        ],
        label4
      );
    };
    const holderOf = (prop) => onContent(prop) ? wrapper : fo;
    const computed = getComputedStyle(wrapper);
    const current3 = Number.parseFloat(computed.getPropertyValue(SCALE)) || 1;
    const fitting = computed.getPropertyValue(FIT).trim() !== "none";
    const setSize2 = (v2) => {
      const base2 = Number.parseFloat(without(holderOf(SCALE), SCALE)) || 1;
      write2(SCALE, Math.abs(v2 - base2) < 1e-6 ? null : String(v2), "Text size");
    };
    const setFit = (on2) => {
      const base2 = without(holderOf(FIT), FIT) !== "none";
      write2(
        FIT,
        on2 === base2 ? null : on2 ? "shrink" : "none",
        on2 ? "Shrink text to fit" : "Keep text size"
      );
    };
    const value = button5(
      formatTextSize(current3),
      "Type a size (25\u2013300 %)",
      () => {
        const input = h("input", {
          type: "text",
          class: "num text-size-input",
          value: String(Math.round(current3 * 100))
        });
        const commit = () => {
          const v2 = parseTextSize(input.value);
          if (v2 == null) {
            toast("A text size from 25 to 300 %", "error");
            input.replaceWith(value);
            return;
          }
          if (Math.abs(v2 - current3) > 1e-6) setSize2(v2);
          else input.replaceWith(value);
        };
        input.addEventListener("keydown", (e2) => {
          e2.stopPropagation();
          if (e2.key === "Enter") input.blur();
          if (e2.key === "Escape") {
            input.value = String(Math.round(current3 * 100));
            input.blur();
          }
        });
        input.addEventListener("change", commit);
        input.addEventListener("blur", () => {
          if (input.isConnected) input.replaceWith(value);
        });
        value.replaceWith(input);
        input.focus();
        input.select();
      },
      "text-size-value"
    );
    const smaller = nextTextSize(current3, -1);
    const larger = nextTextSize(current3, 1);
    const down = button5(
      "A\u2212",
      "Smaller text",
      () => setSize2(smaller),
      "text-size-step"
    );
    const up = button5(
      "A+",
      "Larger text",
      () => setSize2(larger),
      "text-size-step"
    );
    down.disabled = smaller === current3;
    up.disabled = larger === current3;
    const sizeRow = h(
      "div",
      { class: "prop-row" },
      h("span", { class: "prop-label" }, "Text size"),
      h("span", { class: "text-size" }, down, value, up)
    );
    const box2 = h("input", { type: "checkbox" });
    box2.checked = fitting;
    box2.addEventListener("change", () => setFit(box2.checked));
    const shrunk = Number.parseFloat(fo.getAttribute("data-inkflow-fit") ?? "");
    const overflow = fo.hasAttribute("data-inkflow-overflow");
    const status3 = [];
    if (overflow || shrunk > 0) {
      status3.push(
        h(
          "p",
          {
            class: overflow ? "hint fit-status fit-warn" : "hint fit-status"
          },
          overflow ? shrunk > 0 ? `Doesn't fit, even shrunk to ${formatTextSize(shrunk)}` : "Doesn't fit its box" : `Shrunk to ${formatTextSize(shrunk)} to fit`
        )
      );
      const taller = shapeWritable && (fo.getAttribute("data-ink-tag") ?? "rect") === "rect" ? neededBoxHeight(fo) : null;
      const have = Number.parseFloat(fo.getAttribute("height") ?? "");
      const actions = h("div", { class: "prop-buttons" });
      if (taller != null && have > 0 && taller > have + 1) {
        actions.append(
          button5(
            "Make box taller",
            "Grow the box so the text fits at its size",
            () => void sendSvgOps(
              [
                {
                  sel,
                  ops: [
                    {
                      kind: "attrs",
                      loc: sel.loc,
                      set: {
                        height: String(
                          Math.ceil(taller)
                        )
                      }
                    }
                  ]
                }
              ],
              "Make box taller"
            )
          )
        );
      }
      if (smaller !== current3) {
        actions.append(
          button5(
            "Smaller text",
            "One step smaller",
            () => setSize2(smaller)
          )
        );
      }
      if (actions.childElementCount) status3.push(actions);
    }
    return section2(
      "Text size",
      sizeRow,
      h("label", { class: "fit-check" }, box2, "Shrink text to fit"),
      ...status3
    );
  }
  var FITS = [
    { value: "contain", label: "Fit inside", par: "xMidYMid meet" },
    { value: "cover", label: "Fill (crop edges)", par: "xMidYMid slice" },
    { value: "stretch", label: "Stretch", par: "none" }
  ];
  function pictureSection(sel) {
    const image = pictureOf(sel.el);
    const loc = image.getAttribute("data-ink") ?? sel.loc;
    const src = sourceOf(sel.key);
    const href = sourceRef(image);
    const pdf = isPdfRef(href) ? projectFile(href) : null;
    const par = image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f2) => f2.par === par)?.value ?? "contain";
    const imageOps = (set, label4) => void sendSvgOps([{ sel, ops: [{ kind: "attrs", loc, set }] }], label4);
    const cropped = isCropped(sel.el);
    return section2(
      "Picture",
      h(
        "div",
        { class: "source-hint" },
        h("p", { class: "hint media-src" }, pictureName(href)),
        openButton(projectFile(href)),
        renameButton(projectFile(href))
      ),
      pdf ? pdfPageRow(sel, image, pdf, pdfPage(href), imageOps) : null,
      isDiagramHref(href) ? h(
        "div",
        { class: "btn-row" },
        button5(
          "Edit diagram",
          "Open it in draw.io (or double-click it)",
          () => editDiagram(sel),
          "on"
        )
      ) : null,
      isDiagramHref(href) && !cropped ? showAsRow(sel, "picture") : null,
      h(
        "div",
        { class: "btn-row" },
        button5(
          "Replace\u2026",
          "Pick another picture; it keeps this size and place",
          async () => {
            const file = await pickFile(IMAGE_ACCEPT);
            const up = file && src ? await upload(file) : null;
            if (!up || !src) return;
            let page = 1;
            if (isPdfRef(up.path)) {
              const choice = await choosePage(up.path);
              if (!choice) return;
              page = choice.page;
            }
            imageOps(
              {
                href: withPage(
                  relativePath(refBase(src), up.path),
                  page
                ),
                "xlink:href": null
              },
              "Replace picture"
            );
          }
        ),
        ed.cropMode ? button5(
          "Done cropping",
          "Enter",
          () => setCropMode(false),
          "on"
        ) : button5(
          "Crop",
          "Crop (double-click the picture)",
          () => void startCrop(sel)
        ),
        cropped ? button5(
          "Reset crop",
          "Show the whole picture again",
          () => void resetCrop(sel)
        ) : null
      ),
      row6(
        "Fit",
        selectInput(
          FITS.map((f2) => ({ value: f2.value, label: f2.label })),
          fit,
          (v2) => imageOps(
            {
              preserveAspectRatio: FITS.find((f2) => f2.value === v2)?.par ?? null
            },
            "Picture fit"
          )
        )
      ),
      backgroundRow(
        image.getAttribute("inkflow:background"),
        (v2) => imageOps({ "inkflow:background": v2 }, "Picture background")
      )
    );
  }
  function pictureName(ref) {
    const name2 = ref.replace(/#.*$/, "").split("/").pop() ?? ref;
    return isPdfRef(ref) ? `${name2} \xB7 page ${pdfPage(ref)}` : name2;
  }
  function pdfPageRow(sel, image, file, page, imageOps) {
    const show2 = async (n3, shown3) => {
      const url = shown3 ?? await pageUrl(file, n3);
      const src = sourceOf(sel.key);
      const root2 = ed.model?.projectDir;
      if (!url || !src || !root2 || n3 === page) return;
      const set = {
        href: withPage(relativePath(refBase(src), `${root2}/${file}`), n3),
        "xlink:href": null
      };
      const width = Number.parseFloat(image.getAttribute("width") ?? "");
      if (!isCropped(sel.el) && width > 0) {
        const size4 = await naturalSize(url);
        set.height = fmt(width * size4.h / size4.w);
      }
      imageOps(set, `Show page ${n3}`);
    };
    return h(
      "div",
      { class: "prop-row" },
      h("span", { class: "prop-label" }, "Page"),
      numberInput(page, (n3) => void show2(Math.max(1, Math.round(n3))), {
        min: 1
      }),
      button5("Pages\u2026", "See the PDF's pages and pick one", async () => {
        const choice = await choosePage(file, page);
        if (choice) void show2(choice.page, choice.url);
      })
    );
  }
  function showAsRow(sel, mode2) {
    return row6(
      "Show as",
      selectInput(
        DIAGRAM_MODES.map((m2) => ({ value: m2.value, label: m2.label })),
        mode2,
        (v2) => void sendSvgOps(
          [
            {
              sel,
              ops: [
                // Its shapes are named after it.
                {
                  kind: "ensure-id",
                  loc: sel.loc,
                  base: "diagram",
                  key: "diagram"
                },
                {
                  kind: "attrs",
                  loc: sel.loc,
                  set: {
                    "inkflow:drawio": v2 === "picture" ? null : v2
                  }
                }
              ]
            }
          ],
          "Show diagram as"
        )
      )
    );
  }
  function diagramSection(sel) {
    const svg = drawnDiagram(sel.el);
    const href = svg.getAttribute("data-drawio") ?? "";
    const par = svg.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f2) => f2.par === par)?.value ?? "contain";
    return section2(
      "draw.io",
      h(
        "div",
        { class: "source-hint" },
        h("p", { class: "hint media-src" }, href.split("/").pop() ?? href),
        openButton(projectFile(href)),
        renameButton(projectFile(href))
      ),
      h(
        "div",
        { class: "btn-row" },
        button5(
          "Edit diagram",
          "Open it in draw.io (or double-click it)",
          () => editDiagram(sel),
          "on"
        )
      ),
      showAsRow(sel, diagramMode(svg)),
      editShapesRow(sel, svg),
      row6(
        "Fit",
        selectInput(
          FITS.map((f2) => ({ value: f2.value, label: f2.label })),
          fit,
          (v2) => void sendSvgOps(
            [
              {
                sel,
                ops: [
                  {
                    kind: "attrs",
                    loc: sel.loc,
                    set: {
                      preserveAspectRatio: FITS.find((f2) => f2.value === v2)?.par ?? null
                    }
                  }
                ]
              }
            ],
            "Diagram fit"
          )
        )
      ),
      backgroundRow(
        svg.getAttribute("inkflow:background"),
        (v2) => void sendSvgOps(
          [
            {
              sel,
              ops: [
                {
                  kind: "attrs",
                  loc: sel.loc,
                  set: { "inkflow:background": v2 }
                }
              ]
            }
          ],
          "Diagram background"
        )
      )
    );
  }
  function editShapesRow(sel, svg) {
    const on2 = shapesEditable(svg);
    const box2 = h("input", { type: "checkbox" });
    box2.checked = on2;
    box2.addEventListener("change", () => {
      void sendSvgOps(
        [
          {
            sel,
            ops: [
              {
                kind: "attrs",
                loc: sel.loc,
                set: {
                  "inkflow:drawio-edit": box2.checked ? "shapes" : null
                }
              }
            ]
          }
        ],
        box2.checked ? "Edit diagram shapes here" : "Edit diagram in draw.io"
      );
    });
    return h(
      "div",
      {},
      h("label", { class: "check-row" }, box2, " Edit shapes here"),
      h(
        "p",
        { class: "hint" },
        on2 ? "Double-click the diagram to select its shapes: move, resize, relabel, recolour or delete them here. draw.io redraws the diagram after each change (it needs to load, like Edit diagram)." : "Double-click opens draw.io. Turn this on to edit the diagram's shapes on the slide instead; the diagram stays a draw.io diagram."
      )
    );
  }
  function diagramShapesSection(sel) {
    const slide = currentSlide();
    const model2 = ed.model;
    const svg = drawnDiagram(sel.el);
    if (!slide || !model2 || !svg) return null;
    const shapes2 = diagramShapes(svg);
    if (!shapes2.length) return null;
    const editable = slide.animationsEditable && model2.deckEditable;
    const list4 = h("div", { class: "diagram-shapes" });
    const flash2 = (el2, on2) => setHover(on2 ? el2 : null);
    for (const shape of shapes2) {
      const count = slide.animations.filter(
        (c2) => c2.element === shape.id
      ).length;
      const name2 = shape.label || `(${shape.id.slice(svg.id.length + 1)})`;
      const item2 = h(
        "div",
        { class: "diagram-shape" },
        h(
          "span",
          { class: "diagram-shape-name", title: `#${shape.id}` },
          name2
        ),
        count ? h(
          "span",
          {
            class: "hint",
            title: "Animations on this shape (see Animation order)"
          },
          `${count} \u2726`
        ) : null
      );
      item2.addEventListener("mouseenter", () => flash2(shape.el, true));
      item2.addEventListener("mouseleave", () => flash2(shape.el, false));
      if (editable) {
        const add = animationPicker(
          model2.animationTypes,
          false,
          "Animate\u2026"
        );
        add.addEventListener("change", () => {
          if (!add.value) return;
          flash2(shape.el, false);
          void edit({
            action: "anim",
            slide: slide.deckIndex,
            op: "insert",
            index: slide.animations.length,
            spec: { type: add.value, element: shape.id, fields: {} }
          });
        });
        item2.append(add);
      }
      list4.append(item2);
    }
    return section2(
      "Shapes",
      h(
        "p",
        { class: "hint" },
        "Animate the diagram's shapes one by one. To change a shape, edit the diagram in draw.io."
      ),
      list4
    );
  }
  function backgroundRow(current3, commit) {
    const value = typeof current3 === "string" ? current3 : "";
    const named = ["", "paper", "surface"];
    const choice = named.includes(value) ? value : "custom";
    const colour = h("input", {
      type: "color",
      title: "Background colour",
      value: /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"
    });
    colour.hidden = choice !== "custom";
    colour.addEventListener("change", () => commit(colour.value));
    const select2 = selectInput(
      [
        { value: "", label: "None" },
        { value: "paper", label: "Paper (white)" },
        { value: "surface", label: "Theme surface" },
        { value: "custom", label: "Colour\u2026" }
      ],
      choice,
      (v2) => {
        if (v2 === "custom") {
          colour.hidden = false;
          commit(colour.value);
        } else commit(v2 || null);
      }
    );
    return h(
      "div",
      { class: "prop-row" },
      h(
        "span",
        {
          class: "prop-label",
          title: "Painted behind the picture, so a figure with a transparent background stays visible on a dark slide"
        },
        "Background"
      ),
      select2,
      colour
    );
  }
  function linkOf(el2) {
    const a2 = el2.parentElement;
    if (a2?.localName !== "a") return "";
    const slide = a2.getAttribute("data-inkflow-slide");
    if (slide) return `slide:${slide}`;
    return a2.getAttribute("href") ?? a2.getAttribute("xlink:href") ?? "";
  }
  function slideLinkByNumber(n3) {
    const s2 = ed.model?.slides[n3 - 1];
    return s2?.id ? `slide:${s2.id}` : null;
  }
  function slideOptions() {
    const list4 = h("datalist", { id: "slide-link-list" });
    for (const s2 of ed.model?.slides ?? []) {
      if (!s2.id) continue;
      list4.append(h("option", { value: `slide:${s2.id}` }, s2.title ?? s2.id));
    }
    return list4;
  }
  function detailsSection(sel) {
    const title3 = [...sel.el.children].find((c2) => c2.localName === "title")?.textContent ?? "";
    const link = textInput(
      linkOf(sel.el),
      (v2) => void sendSvgOps(
        [
          {
            sel,
            ops: [
              {
                kind: "link",
                loc: sel.loc,
                href: /^\d+$/.test(v2.trim()) ? slideLinkByNumber(Number(v2)) : v2.trim() || null
              }
            ]
          }
        ],
        v2.trim() ? "Link" : "Remove link"
      ),
      "https://\u2026 or slide:id"
    );
    link.setAttribute("list", "slide-link-list");
    return section2(
      "Link & alt text",
      slideOptions(),
      row6("Link", link),
      row6(
        "Alt text",
        textInput(
          title3,
          (v2) => void sendSvgOps(
            [
              {
                sel,
                ops: [{ kind: "title", loc: sel.loc, text: v2 }]
              }
            ],
            "Alt text"
          ),
          "Describe it for screen readers"
        )
      )
    );
  }
  function textSection(sel) {
    const el2 = sel.el;
    const cs = getComputedStyle(el2);
    const spans = [...el2.querySelectorAll("tspan")];
    const setAll = (set, label4) => {
      const plans = [
        { sel, ops: [{ kind: "style", loc: sel.loc, set }] }
      ];
      for (const t2 of spans) {
        const loc = t2.getAttribute("data-ink");
        const style = t2.getAttribute("style") ?? "";
        const touched = Object.keys(set).some(
          (k2) => style.includes(`${k2}:`) || t2.hasAttribute(k2)
        );
        if (loc && touched) {
          plans[0].ops.push({ kind: "style", loc, set });
        }
      }
      void sendSvgOps(plans, label4);
    };
    const bold = parseInt(cs.fontWeight, 10) >= 600;
    const italic = cs.fontStyle === "italic";
    const anchor2 = cs.textAnchor;
    return section2(
      "Text",
      row6(
        "Size",
        numberInput(
          parseFloat(cs.fontSize),
          (v2) => setAll({ "font-size": `${v2}px` }, "Font size")
        )
      ),
      row6(
        "Font",
        textInput(
          cs.fontFamily,
          (v2) => setAll({ "font-family": v2 || null }, "Font"),
          "font-family"
        )
      ),
      h(
        "div",
        { class: "btn-row" },
        button5(
          h("b", {}, "B"),
          "Bold",
          () => setAll({ "font-weight": bold ? null : "bold" }, "Bold"),
          bold ? "on" : ""
        ),
        button5(
          h("i", {}, "I"),
          "Italic",
          () => setAll(
            { "font-style": italic ? null : "italic" },
            "Italic"
          ),
          italic ? "on" : ""
        ),
        button5(
          "\u27F8",
          "Align start",
          () => setAll({ "text-anchor": null }, "Align"),
          anchor2 === "start" ? "on" : ""
        ),
        button5(
          "\u21D4",
          "Align middle",
          () => setAll({ "text-anchor": "middle" }, "Align"),
          anchor2 === "middle" ? "on" : ""
        ),
        button5(
          "\u27F9",
          "Align end",
          () => setAll({ "text-anchor": "end" }, "Align"),
          anchor2 === "end" ? "on" : ""
        ),
        button5("Edit", "Edit text (double-click)", () => emit("edit-text"))
      )
    );
  }
  function geometrySection(sels) {
    const box2 = sels.length === 1 ? slideBox(sels[0].el) : selectionBox();
    if (!box2) return h("div");
    const resizeTo = (to) => {
      const plans = sels.map((s2) => {
        const b2 = slideBox(s2.el);
        const sx = box2.width ? to.width / box2.width : 1;
        const sy = box2.height ? to.height / box2.height : 1;
        const target = {
          x: to.x + (b2.x - box2.x) * sx,
          y: to.y + (b2.y - box2.y) * sy,
          width: b2.width * sx,
          height: b2.height * sy
        };
        const plan2 = planResize(elementGeom(s2.el), b2, target);
        return {
          sel: s2,
          ops: [{ kind: "attrs", loc: s2.loc, set: plan2 }]
        };
      });
      void sendSvgOps(plans, "Resize");
    };
    const rot = sels.length === 1 ? rotationOf(parseTransform(sels[0].el.getAttribute("transform"))) : 0;
    return section2(
      "Position & size",
      h(
        "div",
        { class: "grid2" },
        row6(
          "X",
          numberInput(box2.x, (v2) => resizeTo({ ...box2, x: v2 }))
        ),
        row6(
          "Y",
          numberInput(box2.y, (v2) => resizeTo({ ...box2, y: v2 }))
        ),
        row6(
          "W",
          numberInput(
            box2.width,
            (v2) => resizeTo({ ...box2, width: Math.max(1, v2) }),
            { min: 1 }
          )
        ),
        row6(
          "H",
          numberInput(
            box2.height,
            (v2) => resizeTo({ ...box2, height: Math.max(1, v2) }),
            { min: 1 }
          )
        )
      ),
      sels.length === 1 && row6(
        "Rotation",
        numberInput(
          rot,
          (v2) => {
            const s2 = sels[0];
            const center = {
              x: box2.x + box2.width / 2,
              y: box2.y + box2.height / 2
            };
            const plan2 = planRotate(
              elementGeom(s2.el),
              v2 - rot,
              center
            );
            void sendSvgOps(
              [
                {
                  sel: s2,
                  ops: [
                    {
                      kind: "attrs",
                      loc: s2.loc,
                      set: plan2
                    }
                  ]
                }
              ],
              "Rotate"
            );
          },
          { step: 1 }
        )
      )
    );
  }
  function arrangeSection(sels) {
    const order2 = (to) => void sendSvgOps(
      sels.map((s2) => ({
        sel: s2,
        ops: [{ kind: "order", loc: s2.loc, to }]
      })),
      "Arrange"
    );
    const isGroup = sels.length === 1 && sels[0].el.localName === "g";
    return section2(
      "Arrange",
      h(
        "div",
        { class: "btn-row" },
        button5("\u21C8", "Bring to front (Ctrl+Shift+\u2191)", () => order2("front")),
        button5("\u2191", "Bring forward (Ctrl+\u2191)", () => order2("forward")),
        button5("\u2193", "Send backward (Ctrl+\u2193)", () => order2("backward")),
        button5("\u21CA", "Send to back (Ctrl+Shift+\u2193)", () => order2("back")),
        button5(
          icon("copy", 14),
          "Duplicate (Ctrl+D)",
          () => emit("duplicate")
        ),
        sels.length > 1 && button5(
          icon("group", 14),
          "Group (Ctrl+G)",
          () => emit("group")
        ),
        isGroup && button5(
          "Ungroup",
          "Ungroup (Ctrl+Shift+G)",
          () => emit("ungroup")
        ),
        button5(
          icon("trash", 14),
          "Delete (Del)",
          () => emit("delete"),
          "danger"
        )
      )
    );
  }
  function alignSelection(how) {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    if (!sels.length) return;
    const boxes = sels.map((s2) => slideBox(s2.el));
    const ref = sels.length === 1 ? slideSize() : selectionBox();
    let targetsX = boxes.map((b2) => b2.x);
    let targetsY = boxes.map((b2) => b2.y);
    switch (how) {
      case "left":
        targetsX = boxes.map(() => ref.x);
        break;
      case "center":
        targetsX = boxes.map((b2) => ref.x + (ref.width - b2.width) / 2);
        break;
      case "right":
        targetsX = boxes.map((b2) => ref.x + ref.width - b2.width);
        break;
      case "top":
        targetsY = boxes.map(() => ref.y);
        break;
      case "middle":
        targetsY = boxes.map((b2) => ref.y + (ref.height - b2.height) / 2);
        break;
      case "bottom":
        targetsY = boxes.map((b2) => ref.y + ref.height - b2.height);
        break;
      case "hspace":
        targetsX = distribute(boxes, "x");
        break;
      case "vspace":
        targetsY = distribute(boxes, "y");
        break;
    }
    const plans = sels.map((s2, i2) => ({
      sel: s2,
      ops: moveOps(s2, targetsX[i2] - boxes[i2].x, targetsY[i2] - boxes[i2].y)
    }));
    void sendSvgOps(plans, "Align");
  }
  function renderMultiPanel() {
    const sels = ed.selection;
    const movable = sels.every((s2) => canTransform(s2.el));
    panel.append(section2(`${sels.length} objects`));
    if (movable) {
      const a2 = (label4, title3, how) => button5(label4, title3, () => alignSelection(how));
      panel.append(
        section2(
          "Align",
          h(
            "div",
            { class: "btn-row" },
            a2("\u21E4", "Align left", "left"),
            a2("\u2194", "Align centre", "center"),
            a2("\u21E5", "Align right", "right"),
            a2("\u2912", "Align top", "top"),
            a2("\u2195", "Align middle", "middle"),
            a2("\u2913", "Align bottom", "bottom")
          ),
          h(
            "div",
            { class: "btn-row" },
            a2("\u21F9 Distribute", "Distribute horizontally", "hspace"),
            a2("\u21F3 Distribute", "Distribute vertically", "vspace")
          )
        )
      );
      panel.append(geometrySection(sels));
      const styleable = sels.filter(
        (s2) => !isZone(s2.el) && s2.el.localName !== "image"
      );
      if (styleable.length === sels.length) {
        panel.append(
          section2(
            "Style",
            paintRow(sels, "fill"),
            paintRow(sels, "stroke")
          )
        );
      }
      panel.append(arrangeSection(sels));
    }
  }
  function renderProps() {
    const active3 = document.activeElement;
    if (active3 && panel.contains(active3) && typingIn(active3)) {
      refreshOnBlur = true;
      return;
    }
    clear(panel);
    if (!ed.model) return;
    if (ed.selection.length === 0 && ed.master) {
      const master = masterPanel();
      if (master) panel.append(master);
    } else if (ed.selection.length === 0) renderSlidePanel();
    else if (ed.selection.length === 1) renderObjectPanel(ed.selection[0]);
    else renderMultiPanel();
  }
  var refreshOnBlur = false;
  function typingIn(el2) {
    if (el2.localName === "textarea" || el2.isContentEditable)
      return true;
    if (el2.localName !== "input") return false;
    const type = el2.type;
    return !["checkbox", "radio", "range", "button", "color"].includes(type);
  }
  function initProps() {
    on("selection", renderProps);
    on("stars", renderProps);
    on("render", renderProps);
    on("preview", renderProps);
    panel.addEventListener("keydown", (e2) => {
      const field2 = e2.target;
      if (e2.key !== "Escape" || !typingIn(field2)) return;
      e2.preventDefault();
      field2.blur();
      if (ed.scope?.closest("svg[data-drawio]")) enterGroup(null);
    });
    panel.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (refreshOnBlur && !panel.contains(document.activeElement)) {
          refreshOnBlur = false;
          renderProps();
        }
      }, 0);
    });
  }

  // src/ts/editor/stylecopy.ts
  var PAINT_CLASS = /^inkflow-(fill|stroke)-[\w-]+$/;
  var COMMON = ["opacity", "filter"];
  var PAINT = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin"
  ];
  var MARKERS = ["marker-start", "marker-mid", "marker-end"];
  var FONT = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-decoration",
    "letter-spacing"
  ];
  var BOX_VARS = ["--inkflow-padding", "--inkflow-align", "--inkflow-valign"];
  var SHAPES = "rect, ellipse, circle, path, line, polyline, polygon, text";
  var LINES = /* @__PURE__ */ new Set(["path", "line", "polyline"]);
  var SHOW_SHAPE = "inkflow:show-shape";
  var copied2 = null;
  function kindOf2(el2) {
    if (el2.localName === "text") return "text";
    if (isZone(el2)) return "box";
    return "shape";
  }
  function read2(el2, prop) {
    const inline2 = el2.style?.getPropertyValue(prop).trim();
    return inline2 || el2.getAttribute(prop);
  }
  function painted(el2) {
    if (["g", "a", "svg"].includes(el2.localName)) {
      return el2.querySelector(SHAPES);
    }
    return el2;
  }
  function targets(sel) {
    if (!["g", "a", "svg"].includes(sel.el.localName)) return [sel];
    return [...sel.el.querySelectorAll(SHAPES)].filter((el2) => el2.hasAttribute("data-ink")).map((el2) => ({ ...sel, el: el2, loc: el2.getAttribute("data-ink") ?? "" }));
  }
  function hasCopiedStyle() {
    return copied2 !== null;
  }
  function copyStyle() {
    const sel = ed.selection[0];
    const el2 = sel ? painted(sel.el) : null;
    if (!el2) {
      toast("Select an object to copy its style from");
      return;
    }
    const kind = kindOf2(el2);
    const names2 = [...COMMON, ...PAINT, ...MARKERS, ...FONT, ...BOX_VARS];
    copied2 = {
      kind,
      tag: el2.localName,
      classes: [...el2.classList].filter((c2) => PAINT_CLASS.test(c2)),
      props: Object.fromEntries(names2.map((n3) => [n3, read2(el2, n3)])),
      radius: { rx: el2.getAttribute("rx"), ry: el2.getAttribute("ry") },
      showShape: el2.getAttribute(SHOW_SHAPE) === "true"
    };
    toast("Style copied: select objects and press Ctrl+Alt+V to apply it");
  }
  function propsFor(style, el2) {
    const kind = kindOf2(el2);
    const props = [...COMMON];
    const shapeLike = (k2) => k2 === "shape" || k2 === "box";
    if (kind === "text" && style.kind === "text") props.push(...PAINT, ...FONT);
    else if (shapeLike(kind) && shapeLike(style.kind)) props.push(...PAINT);
    if (LINES.has(el2.localName) && LINES.has(style.tag)) props.push(...MARKERS);
    if (kind === "box" && style.kind === "box") props.push(...BOX_VARS);
    return props;
  }
  function opsFor(style, sel) {
    const el2 = sel.el;
    const props = propsFor(style, el2);
    const set = {};
    for (const p2 of props) set[p2] = style.props[p2] ?? null;
    const ops = [];
    for (const prop of ["fill", "stroke"]) {
      if (!props.includes(prop)) continue;
      const token = style.classes.find((c2) => c2.startsWith(`inkflow-${prop}-`))?.slice(`inkflow-${prop}-`.length);
      ops.push({ kind: "paint", loc: sel.loc, prop, token });
      if (token) set[prop] = null;
    }
    const attrs2 = {};
    if (el2.localName === "rect" && style.tag === "rect") {
      attrs2.rx = style.radius.rx;
      attrs2.ry = style.radius.ry;
    }
    if (kindOf2(el2) === "box" && style.kind === "box") {
      attrs2[SHOW_SHAPE] = style.showShape ? "true" : null;
    }
    if (Object.keys(attrs2).length) {
      ops.push({ kind: "attrs", loc: sel.loc, set: attrs2 });
    }
    ops.push({ kind: "style", loc: sel.loc, set });
    return ops;
  }
  async function pasteStyle() {
    const style = copied2;
    if (!style) {
      toast("Copy a style first: select an object and press Ctrl+Alt+C");
      return;
    }
    const sels = ed.selection.filter((s2) => canTransform(s2.el)).flatMap(targets);
    if (!sels.length) {
      toast("Select the objects to apply the style to");
      return;
    }
    await sendSvgOps(
      sels.map((sel) => ({ sel, ops: opsFor(style, sel) })),
      "Paste style"
    );
  }

  // src/ts/editor/find.ts
  var panel2 = document.getElementById("find-panel");
  var hits = [];
  var active = -1;
  var timer3 = 0;
  var opts = { matchCase: false, wholeWord: false, regex: false };
  var scope = "deck";
  function el(sel) {
    return panel2.querySelector(sel);
  }
  function slideFiles(s2) {
    const out = (s2.sources ?? []).filter((src) => src.writable).map((src) => src.path);
    if (s2.srcPath) out.push(s2.srcPath);
    if (s2.md?.path) out.push(s2.md.path);
    if (s2.notes?.path) out.push(s2.notes.path);
    return out;
  }
  function files() {
    const slides = scope === "slide" ? [currentSlide()].filter((s2) => !!s2) : ed.model?.slides ?? [];
    return [...new Set(slides.flatMap(slideFiles))];
  }
  function slidesOf(hit) {
    if (hit.kind === "deck") return hit.slide != null ? [hit.slide] : [];
    return (ed.model?.slides ?? []).filter((s2) => slideFiles(s2).includes(hit.file)).map((s2) => s2.deckIndex);
  }
  function query() {
    return el(".find-input").value;
  }
  function base() {
    const deckSlide = scope === "slide" ? currentSlide()?.deckIndex : void 0;
    return { query: query(), files: files(), deckSlide, ...opts };
  }
  async function search() {
    const q = query();
    if (!q) {
      hits = [];
      renderResults();
      return;
    }
    const result = await request({ action: "find", ...base() });
    if (q !== query()) return;
    if (!result.ok) {
      hits = [];
      renderResults(result.error ?? "search failed");
      return;
    }
    hits = result.hits;
    active = Math.min(active, hits.length - 1);
    renderResults();
  }
  function schedule() {
    window.clearTimeout(timer3);
    timer3 = window.setTimeout(() => void search(), 220);
  }
  function fileLabel(path) {
    const root2 = ed.model?.projectDir ?? "";
    return path.startsWith(root2) ? path.slice(root2.length + 1) : path;
  }
  function renderResults(error2) {
    const list4 = el(".find-results");
    const status3 = el(".find-status");
    clear(list4);
    if (error2) {
      status3.textContent = error2;
      return;
    }
    if (!query()) {
      status3.textContent = "";
      return;
    }
    const slides = new Set(hits.flatMap(slidesOf));
    status3.textContent = hits.length ? `${hits.length}${hits.length >= 500 ? "+" : ""} match${hits.length === 1 ? "" : "es"} on ${slides.size} slide${slides.size === 1 ? "" : "s"}` : "No matches";
    let lastGroup = "";
    hits.forEach((hit, i2) => {
      const on2 = slidesOf(hit);
      const first = on2[0];
      const slide = first != null ? ed.model?.slides[first] : null;
      const group2 = slide != null ? `${first + 1} \xB7 ${slide.title ?? slide.id ?? ""}` : fileLabel(hit.file);
      if (group2 !== lastGroup) {
        list4.append(h("div", { class: "find-group" }, group2));
        lastGroup = group2;
      }
      const where = hit.kind === "deck" ? "deck.py" : `${fileLabel(hit.file)}${on2.length > 1 ? ` \xB7 ${on2.length} slides` : ""}`;
      const row7 = h(
        "button",
        {
          type: "button",
          class: `find-hit${i2 === active ? " on" : ""}`,
          title: where,
          onclick: () => goTo(i2)
        },
        h(
          "span",
          { class: "find-snippet" },
          hit.before,
          h("mark", {}, hit.match),
          hit.after
        ),
        h("span", { class: "find-where" }, where)
      );
      list4.append(row7);
    });
  }
  function goTo(i2) {
    const hit = hits[i2];
    if (!hit) return;
    active = i2;
    renderResults();
    const on2 = slidesOf(hit);
    const cur = currentSlide()?.deckIndex;
    const target = cur != null && on2.includes(cur) ? cur : on2[0];
    if (target != null) gotoSlide(target);
    if (hit.kind === "svg" && hit.loc != null) {
      const slide = currentSlide();
      const key = slide?.sources?.findIndex((s2) => s2.path === hit.file) ?? -1;
      const node = key >= 0 ? slideRoot()?.querySelector(`[data-ink="${key}:${hit.loc}"]`) : null;
      if (node && selectable(node)) select([node]);
    }
    panel2.querySelector(".find-hit.on")?.scrollIntoView({ block: "nearest" });
  }
  async function replace(all) {
    const q = query();
    if (!q) return;
    if (!all && active < 0) {
      goTo(0);
      return;
    }
    const replacement = el(".replace-input").value;
    const hit = hits[active];
    if (all && hits.length > 1) {
      const n3 = hits.length;
      if (!window.confirm(
        `Replace ${n3} matches of \u201C${q}\u201D with \u201C${replacement}\u201D?`
      )) {
        return;
      }
    }
    const result = await edit({
      action: "replace",
      replacement,
      ...base(),
      only: all ? void 0 : { file: hit.file, index: hit.index }
    });
    if (result.ok) {
      const n3 = result.replaced;
      toast(`Replaced ${n3} match${n3 === 1 ? "" : "es"}`);
    }
  }
  function toggle2(name2, btn) {
    opts[name2] = !opts[name2];
    btn.classList.toggle("on", opts[name2]);
    schedule();
  }
  function build() {
    const flag = (label4, title3, name2) => {
      const b2 = h(
        "button",
        { type: "button", class: "find-flag", title: title3 },
        label4
      );
      b2.addEventListener("click", () => toggle2(name2, b2));
      return b2;
    };
    const find2 = h("input", {
      type: "text",
      class: "find-input",
      placeholder: "Find in slides, notes and deck.py",
      spellcheck: "false"
    });
    const repl = h("input", {
      type: "text",
      class: "replace-input",
      placeholder: "Replace with",
      spellcheck: "false"
    });
    const where = h("select", { class: "find-scope", title: "Where to look" });
    where.append(
      h("option", { value: "deck" }, "All slides"),
      h("option", { value: "slide" }, "This slide")
    );
    where.addEventListener("change", () => {
      scope = where.value === "slide" ? "slide" : "deck";
      schedule();
    });
    find2.addEventListener("input", () => {
      active = -1;
      schedule();
    });
    find2.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") {
        e2.preventDefault();
        if (hits.length)
          goTo(
            (active + (e2.shiftKey ? -1 : 1) + hits.length) % hits.length
          );
      }
    });
    repl.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") {
        e2.preventDefault();
        void replace(e2.ctrlKey || e2.metaKey);
      }
    });
    panel2.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Escape") closeFind();
    });
    panel2.append(
      h(
        "div",
        { class: "find-row" },
        find2,
        flag("Aa", "Match case", "matchCase"),
        flag("ab", "Whole words", "wholeWord"),
        flag(".*", "Regular expression", "regex"),
        h(
          "button",
          {
            type: "button",
            class: "find-close",
            title: "Close (Esc)",
            onclick: closeFind
          },
          "\xD7"
        )
      ),
      h(
        "div",
        { class: "find-row" },
        repl,
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Replace this match (Enter)",
            onclick: () => void replace(false)
          },
          "Replace"
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Replace every match (Ctrl+Enter)",
            onclick: () => void replace(true)
          },
          "All"
        )
      ),
      h(
        "div",
        { class: "find-row" },
        where,
        h("span", { class: "find-status" })
      ),
      h("div", { class: "find-results" })
    );
  }
  function openFind(replaceMode = false) {
    if (!panel2.childElementCount) build();
    panel2.hidden = false;
    const input = el(
      replaceMode ? ".replace-input" : ".find-input"
    );
    const picked = window.getSelection()?.toString().trim();
    if (picked && !picked.includes("\n")) {
      el(".find-input").value = picked;
    }
    input.focus();
    input.select();
    schedule();
  }
  function closeFind() {
    panel2.hidden = true;
  }
  function initFind() {
    document.getElementById("btn-find")?.addEventListener("click", () => openFind());
    on("model", () => {
      if (!panel2.hidden && query()) schedule();
    });
  }

  // src/ts/shared/sections.ts
  function verticalNeighbor(boxes, i2, dir) {
    const me = boxes[i2];
    if (!me) return i2;
    const tops = [...new Set(boxes.map((b2) => b2.top))].sort((a2, b2) => a2 - b2);
    const row7 = tops.indexOf(me.top) + dir;
    if (row7 < 0 || row7 >= tops.length) return i2;
    const center = me.left + me.width / 2;
    let best2 = i2;
    let bestD = Number.POSITIVE_INFINITY;
    boxes.forEach((b2, j2) => {
      if (b2.top !== tops[row7]) return;
      const d2 = Math.abs(b2.left + b2.width / 2 - center);
      if (d2 < bestD) {
        best2 = j2;
        bestD = d2;
      }
    });
    return best2;
  }

  // src/ts/editor/grid.ts
  var view2 = document.getElementById("grid-view");
  var list3 = document.getElementById("grid-list");
  var sizeInput = document.getElementById("grid-size");
  var starFilter = document.getElementById("grid-starred");
  var changedFilter = document.getElementById("grid-changed");
  var thumbs4 = new Thumbs(list3);
  var STARRED_KEY = "inkflow-editor-grid-starred";
  var starredOnly = false;
  var changedOnly = false;
  function toggleGrid(on2 = view2.hidden === true) {
    view2.hidden = !on2;
    document.body.classList.toggle("grid-mode", on2);
    document.getElementById("btn-grid")?.classList.toggle("on", on2);
    if (on2) {
      ed.focus = "sorter";
      renderGrid();
      view2.focus();
    } else {
      ed.focus = "canvas";
      emit("slide");
    }
  }
  function open4(i2) {
    ed.slideSelection.clear();
    toggleGrid(false);
    gotoSlide(i2);
  }
  function lastMark() {
    return list3.lastElementChild;
  }
  function gridItem(slide, i2) {
    const item2 = h(
      "div",
      {
        class: `grid-item${i2 === ed.current ? " active" : ""}${ed.slideSelection.has(i2) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
        // Among the starred only, a drop would have no place to mean.
        draggable: ed.model?.deckEditable && !starredOnly && !changedOnly ? "true" : null,
        "data-index": i2
      },
      thumbs4.thumb(slide),
      h(
        "div",
        { class: "grid-caption" },
        slide.visible ? starButton(i2) : null,
        h("span", { class: "grid-num" }, String(i2 + 1)),
        h(
          "span",
          { class: "grid-title" },
          slide.title ?? slide.id ?? slide.src
        ),
        slide.animations.length ? h(
          "span",
          {
            class: "grid-badge",
            title: `${slide.animations.length} animation(s)`
          },
          "\u2726"
        ) : null,
        changeBadge(i2),
        problemBadge(i2),
        commentBadge(i2)
      )
    );
    item2.classList.toggle("starred", isStarred(i2));
    item2.addEventListener("click", (e2) => {
      pickSlide(i2, e2);
      ed.focus = "sorter";
    });
    item2.addEventListener("contextmenu", (e2) => {
      e2.preventDefault();
      if (!ed.slideSelection.has(i2)) {
        ed.slideSelection.clear();
        gotoSlide(i2);
      }
      ed.focus = "sorter";
      openSlideMenu(e2.clientX, e2.clientY, i2);
    });
    item2.addEventListener("dragstart", (e2) => {
      dragging.now = { kind: "slides", slides: dragSlides(i2) };
      e2.dataTransfer?.setData("text/plain", String(i2));
      item2.classList.add("dragging");
    });
    item2.addEventListener("dragend", () => {
      dragging.now = null;
      clearDropMarks(list3);
      item2.classList.remove("dragging");
    });
    item2.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        markGap(list3, sectionGapAtSlide(sections(), i2), lastMark());
        return;
      }
      const r2 = item2.getBoundingClientRect();
      clearDropMarks(list3);
      item2.classList.add(
        e2.clientX > r2.left + r2.width / 2 ? "drop-after" : "drop-before"
      );
    });
    item2.addEventListener("drop", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      const drag = dragging.now;
      clearDropMarks(list3);
      if (!drag) return;
      if (drag.kind === "section") {
        void moveSectionToGap(
          drag.section,
          sectionGapAtSlide(sections(), i2)
        );
        return;
      }
      const r2 = item2.getBoundingClientRect();
      const after = e2.clientX > r2.left + r2.width / 2;
      const target = dropOnSlide(sections(), i2, after);
      void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return item2;
  }
  function gridHeader(k2) {
    const head = sectionHeader(k2, "grid", () => selectSection(k2));
    head.addEventListener("dragstart", (e2) => {
      dragging.now = { kind: "section", section: k2 };
      e2.dataTransfer?.setData("text/plain", `section:${k2}`);
      head.closest(".grid-section")?.classList.add("dragging");
    });
    head.addEventListener("dragend", () => {
      dragging.now = null;
      head.closest(".grid-section")?.classList.remove("dragging");
      clearDropMarks(list3);
    });
    head.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        markGap(list3, headerGap(head, k2, e2), lastMark());
        return;
      }
      clearDropMarks(list3);
      head.classList.add("drop-into");
    });
    head.addEventListener("drop", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      const drag = dragging.now;
      clearDropMarks(list3);
      if (!drag) return;
      if (drag.kind === "section") {
        void moveSectionToGap(drag.section, headerGap(head, k2, e2));
        return;
      }
      const target = dropOnHeader(sections(), k2);
      void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return head;
  }
  function renderFilter() {
    starFilter.textContent = `\u2605 ${filterLabel(starCount())}`;
    starFilter.classList.toggle("on", starredOnly);
    starFilter.setAttribute("aria-pressed", String(starredOnly));
    const marked2 = markedCount();
    changedFilter.hidden = !marked2 && !changedOnly;
    changedFilter.textContent = `Changed only (${marked2})`;
    changedFilter.classList.toggle("on", changedOnly);
    changedFilter.setAttribute("aria-pressed", String(changedOnly));
  }
  function setStarredOnly(on2) {
    starredOnly = on2;
    try {
      localStorage.setItem(STARRED_KEY, on2 ? "1" : "");
    } catch {
    }
    renderGrid();
  }
  function renderGrid() {
    if (view2.hidden) return;
    renderFilter();
    const top = list3.scrollTop;
    clear(list3);
    thumbs4.begin();
    const slides = ed.model?.slides ?? [];
    const all = sections();
    for (const block of sectionBlocks(slides.length, all)) {
      const k2 = block.section;
      let shownSlides = starredOnly ? onlyStarred(block.slides, isStarred) : block.slides;
      if (changedOnly) shownSlides = shownSlides.filter(isMarked);
      if ((starredOnly || changedOnly) && !shownSlides.length) continue;
      const wrap2 = h("div", {
        class: `grid-section${k2 == null ? " unsectioned" : ""}`
      });
      if (k2 != null) wrap2.append(gridHeader(k2));
      if (k2 == null || !isCollapsed(k2)) {
        const grid = h("div", { class: "grid-section-list" });
        for (const i2 of shownSlides) grid.append(gridItem(slides[i2], i2));
        if (k2 != null && !block.slides.length) {
          grid.append(
            h(
              "div",
              { class: "grid-empty" },
              "No slides: drop some on the heading"
            )
          );
        }
        wrap2.append(grid);
      }
      list3.append(wrap2);
    }
    thumbs4.end();
    if (changedOnly && !markedCount()) {
      list3.append(
        h(
          "div",
          { class: "grid-empty" },
          "No slide has changes since the last commit"
        )
      );
    } else if (starredOnly && !starCount()) {
      list3.append(
        h(
          "div",
          { class: "grid-empty" },
          "No starred slides yet: S stars the slide you are on, or click the \u2606 under a slide"
        )
      );
    }
    list3.scrollTop = top;
    list3.querySelector(".grid-item.active")?.scrollIntoView({
      block: "nearest"
    });
  }
  function shown() {
    return [...list3.querySelectorAll(".grid-item")];
  }
  function onKey2(e2) {
    if (view2.hidden) return;
    const target = e2.target;
    if (target.closest("input, textarea, select, #dialog, #find-panel")) return;
    const items2 = shown();
    const indices = items2.map((el2) => Number(el2.dataset.index));
    const here = indices.indexOf(ed.current);
    const move = (to) => {
      e2.preventDefault();
      e2.stopPropagation();
      if (to == null) return;
      ed.slideSelection.clear();
      gotoSlide(to);
    };
    const vertical = (dir) => {
      if (here === -1) return indices[0];
      const boxes = items2.map((el2) => {
        const r2 = el2.getBoundingClientRect();
        return { left: r2.left, top: Math.round(r2.top), width: r2.width };
      });
      return indices[verticalNeighbor(boxes, here, dir)];
    };
    switch (e2.key) {
      case "ArrowLeft":
        move(indices[Math.max(0, here - 1)]);
        break;
      case "ArrowRight":
        move(indices[Math.min(indices.length - 1, here + 1)]);
        break;
      case "ArrowUp":
        move(vertical(-1));
        break;
      case "ArrowDown":
        move(vertical(1));
        break;
      case "Home":
        move(indices[0]);
        break;
      case "End":
        move(indices[indices.length - 1]);
        break;
      case "Enter":
        e2.preventDefault();
        e2.stopPropagation();
        open4(ed.current);
        break;
      case "Escape":
        e2.preventDefault();
        e2.stopPropagation();
        toggleGrid(false);
        break;
    }
  }
  function setSize(px2) {
    view2.style.setProperty("--grid-w", `${px2}px`);
    try {
      localStorage.setItem("inkflow-editor-grid", String(px2));
    } catch {
    }
  }
  var DOUBLE_MS = 450;
  var lastPress = null;
  function onListPress(e2) {
    if (e2.button !== 0 || e2.shiftKey || e2.ctrlKey || e2.metaKey || e2.altKey) {
      lastPress = null;
      return;
    }
    const target = e2.target;
    if (target.closest("button, .git-mark, .problem-mark, .comment-mark")) {
      lastPress = null;
      return;
    }
    const tile = target.closest(".grid-item");
    if (!tile) {
      lastPress = null;
      return;
    }
    const index = Number(tile.dataset.index);
    const prev = lastPress;
    lastPress = { index, at: e2.timeStamp, x: e2.clientX, y: e2.clientY };
    if (prev && prev.index === index && e2.timeStamp - prev.at < DOUBLE_MS && Math.hypot(e2.clientX - prev.x, e2.clientY - prev.y) < 8) {
      lastPress = null;
      e2.preventDefault();
      open4(index);
    }
  }
  function initListDrop2() {
    list3.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag || e2.target !== list3) return;
      e2.preventDefault();
      if (drag.kind === "section") {
        markGap(list3, sections().length, lastMark());
      } else {
        clearDropMarks(list3);
        lastMark()?.classList.add("drop-after");
      }
    });
    list3.addEventListener("drop", (e2) => {
      const drag = dragging.now;
      if (!drag || e2.target !== list3) return;
      e2.preventDefault();
      clearDropMarks(list3);
      dropAtEnd(drag);
    });
  }
  function initGrid() {
    document.getElementById("btn-grid")?.addEventListener("click", () => toggleGrid());
    document.getElementById("grid-close")?.addEventListener("click", () => toggleGrid(false));
    document.addEventListener("keydown", onKey2, true);
    let saved = 280;
    try {
      saved = Number(localStorage.getItem("inkflow-editor-grid")) || 280;
    } catch {
    }
    sizeInput.value = String(saved);
    setSize(saved);
    sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
    initListDrop2();
    list3.addEventListener("pointerdown", onListPress);
    on("model", renderGrid);
    on("slide", renderGrid);
    on("slide-selection", renderGrid);
    on("stars", renderGrid);
    on("slide-git", renderGrid);
    on("problems", renderGrid);
    on("comments", renderGrid);
    try {
      starredOnly = localStorage.getItem(STARRED_KEY) === "1";
    } catch {
    }
    starFilter.addEventListener("click", () => setStarredOnly(!starredOnly));
    changedFilter.addEventListener("click", () => {
      changedOnly = !changedOnly;
      renderGrid();
    });
    on("sections", renderGrid);
  }

  // src/ts/editor/panelstext.ts
  var PANELS = ["left", "bottom", "right"];
  var ALL_SHOWN = { left: true, bottom: true, right: true };
  var PANEL_KEYS = {
    left: "1",
    bottom: "2",
    right: "3"
  };
  var PANEL_NAMES = {
    left: "slide list",
    bottom: "speaker notes",
    right: "properties"
  };
  function parseShown(stored2) {
    const shown3 = { ...ALL_SHOWN };
    if (!stored2) return shown3;
    try {
      const hidden = JSON.parse(stored2);
      if (!Array.isArray(hidden)) return shown3;
      for (const panel4 of PANELS) {
        if (hidden.includes(panel4)) shown3[panel4] = false;
      }
    } catch {
    }
    return shown3;
  }
  function storeShown(shown3) {
    return JSON.stringify(PANELS.filter((panel4) => !shown3[panel4]));
  }
  function panelTitle(panel4, shown3, key = PANEL_KEYS[panel4]) {
    const name2 = PANEL_NAMES[panel4];
    const what = `${shown3 ? "Hide" : "Show"} the ${name2}`;
    return key ? `${what} (${key})` : what;
  }

  // src/ts/editor/panels.ts
  var KEY2 = "inkflow-editor-panels";
  var shown2 = parseShown(null);
  function button6(panel4) {
    return document.getElementById(`btn-panel-${panel4}`);
  }
  function apply2() {
    for (const panel4 of PANELS) {
      document.body.classList.toggle(`hide-${panel4}`, !shown2[panel4]);
      const b2 = button6(panel4);
      if (!b2) continue;
      b2.classList.toggle("on", shown2[panel4]);
      b2.setAttribute("aria-pressed", String(shown2[panel4]));
    }
    titles();
    layoutPaper();
    emit("zoom");
  }
  function togglePanel(panel4) {
    shown2 = { ...shown2, [panel4]: !shown2[panel4] };
    try {
      localStorage.setItem(KEY2, storeShown(shown2));
    } catch {
    }
    apply2();
  }
  function titles() {
    for (const panel4 of PANELS) {
      const b2 = button6(panel4);
      if (b2)
        b2.title = panelTitle(
          panel4,
          shown2[panel4],
          keyLabel(`view.${panel4}`)
        );
    }
  }
  function initPanels() {
    on("keys", titles);
    try {
      shown2 = parseShown(localStorage.getItem(KEY2));
    } catch {
    }
    for (const panel4 of PANELS) {
      button6(panel4)?.addEventListener("click", () => togglePanel(panel4));
    }
    apply2();
  }

  // src/ts/editor/conflict.ts
  function showConflict(why, mine, useMine) {
    const area2 = h("textarea", {
      readonly: true,
      "aria-label": "Your version"
    });
    area2.value = mine;
    const copy3 = () => {
      area2.select();
      const done = () => toast("Your version copied", "ok");
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(mine).then(done, () => {
          document.execCommand("copy");
          done();
        });
      } else {
        document.execCommand("copy");
        done();
      }
    };
    const body3 = h(
      "div",
      { class: "conflict-dialog" },
      h(
        "p",
        {},
        `${why.replace(/[.;:]?\s*$/, ".")} Yours is below: copy what you need, or put it back in place of theirs.`
      ),
      area2,
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          { type: "button", class: "pbtn", onclick: copy3 },
          "Copy"
        ),
        useMine ? h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: async () => {
              if (await useMine()) closeDialog();
            }
          },
          "Use mine instead"
        ) : null,
        h(
          "button",
          {
            type: "button",
            class: "pbtn primary",
            onclick: () => closeDialog()
          },
          "Keep theirs"
        )
      )
    );
    openDialog("Changed by someone else", body3, { wide: true });
  }

  // src/ts/editor/richtext.ts
  var Unsupported = class extends Error {
  };
  var COLOR_CLASS = /^inkflow-color-[\w-]+$/;
  var RAW_INLINE = /* @__PURE__ */ new Set(["u", "mark", "sub", "sup"]);
  function attrs(el2) {
    return [...el2.attributes].map((a2) => a2.name);
  }
  function plain(el2, allowed = []) {
    return attrs(el2).every(
      (a2) => allowed.includes(a2) || a2 === "style" || a2 === "dir"
    );
  }
  function escapeText(text) {
    return text.replace(/\\/g, "\\\\").replace(/([*`[\]<~$])/g, "\\$1").replace(/(^|\W)_|_(?=\W|$)/g, (m2) => m2.replace("_", "\\_")).replace(/ /g, " ");
  }
  function codeSpan(text) {
    const ticks = text.includes("`") ? "``" : "`";
    const pad2 = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${ticks}${pad2}${text}${pad2}${ticks}`;
  }
  function wrap(inner, mark) {
    const m2 = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m2?.[2]) return inner;
    return `${m2[1]}${mark}${m2[2]}${mark}${m2[3]}`;
  }
  function inline(node) {
    let out = "";
    for (const child of node.childNodes) out += inlineNode(child);
    return out.replace(/\\\n\n/g, "\\\n");
  }
  function inlineNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText(
        (node.textContent ?? "").replace(/[ \t]*\n\s*/g, "\n")
      );
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el2 = node;
    const tag = el2.localName;
    switch (tag) {
      case "strong":
      case "b":
        if (!plain(el2)) throw new Unsupported(tag);
        return wrap(inline(el2), "**");
      case "em":
      case "i":
        if (!plain(el2)) throw new Unsupported(tag);
        return wrap(inline(el2), "*");
      case "s":
      case "del":
      case "strike":
        if (!plain(el2)) throw new Unsupported(tag);
        return wrap(inline(el2), "~~");
      case "code":
        if (!plain(el2)) throw new Unsupported(tag);
        return codeSpan(el2.textContent ?? "");
      case "br":
        return "\\\n";
      case "a": {
        const slide = el2.getAttribute("data-inkflow-slide");
        if (slide && plain(el2, ["data-inkflow-slide", "title"])) {
          return `[${inline(el2)}](slide:${slide})`;
        }
        if (!plain(el2, ["href", "title"])) throw new Unsupported(tag);
        const href = el2.getAttribute("href") ?? "";
        const title3 = el2.getAttribute("title");
        const t2 = title3 ? ` "${title3.replace(/"/g, '\\"')}"` : "";
        return `[${inline(el2)}](${href.replace(/[()\s]/g, encodeURIComponent)}${t2})`;
      }
      case "span": {
        const cls = el2.getAttribute("class") ?? "";
        const latex = formula(el2, "inline");
        if (latex !== null) return `$${latex}$`;
        if (!cls && plain(el2)) return inline(el2);
        if (COLOR_CLASS.test(cls) && plain(el2, ["class"])) {
          return `<span class="${cls}">${inline(el2)}</span>`;
        }
        throw new Unsupported(`span.${cls}`);
      }
      case "font":
        return inline(el2);
      default:
        if (RAW_INLINE.has(tag) && plain(el2)) {
          return `<${tag}>${inline(el2)}</${tag}>`;
        }
        throw new Unsupported(tag);
    }
  }
  function formula(el2, kind) {
    const cls = (el2.getAttribute("class") ?? "").split(/\s+/);
    if (!cls.includes("math") || !cls.includes(kind)) return null;
    const latex = el2.querySelector("math")?.getAttribute("data-latex");
    if (latex == null) throw new Unsupported("math without its LaTeX");
    return latex.trim();
  }
  var BLOCK = /* @__PURE__ */ new Set([
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "blockquote",
    "hr",
    "table",
    "pre"
  ]);
  function isBlank(node) {
    return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim();
  }
  function cellText(cell) {
    return inline(cell).replace(/\|/g, "\\|").replace(/\\\n/g, " ").trim();
  }
  function align(cell) {
    const a2 = cell.style?.textAlign || cell.getAttribute("align");
    return a2 === "center" || a2 === "right" || a2 === "left" ? a2 : "";
  }
  function tableMarkdown(table) {
    const rows = [...table.querySelectorAll("tr")];
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r2) => r2.children.length));
    const cells = rows.map((r2) => {
      const out = [...r2.children].map(cellText);
      while (out.length < width) out.push("");
      return out;
    });
    const aligns = [...rows[0].children].map(align);
    while (aligns.length < width) aligns.push("");
    const rule = aligns.map(
      (a2) => a2 === "center" ? ":---:" : a2 === "right" ? "---:" : a2 === "left" ? ":---" : "---"
    );
    const line = (r2) => `| ${r2.join(" | ")} |`;
    return [line(cells[0]), line(rule), ...cells.slice(1).map(line)].join("\n");
  }
  var TASK_LIST = "contains-task-list";
  var TASK_ITEM = "task-list-item";
  function isCheckbox(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.localName === "input" && node.type === "checkbox";
  }
  function listMarkdown(list4) {
    const ordered = list4.localName === "ol";
    const tasks = list4.classList.contains(TASK_LIST);
    let n3 = parseInt(list4.getAttribute("start") ?? "1", 10) || 1;
    const lines = [];
    for (const li of list4.children) {
      if (li.localName !== "li") throw new Unsupported(li.localName);
      const cls = li.getAttribute("class") ?? "";
      if (!plain(li, cls === TASK_ITEM || !cls ? ["class"] : [])) {
        throw new Unsupported("li with attributes");
      }
      const box2 = [...li.childNodes].find(isCheckbox);
      const task = tasks || cls === TASK_ITEM || box2 !== void 0;
      const bullet = ordered ? `${n3++}. ` : "- ";
      const marker = `${bullet}${task ? box2?.checked ? "[x] " : "[ ] " : ""}`;
      const pad2 = " ".repeat(bullet.length);
      const own = [];
      const nested = [];
      for (const c2 of li.childNodes) {
        const el2 = c2;
        if (isCheckbox(c2)) continue;
        if (c2.nodeType === Node.ELEMENT_NODE && /^[ou]l$/.test(el2.localName)) {
          nested.push(listMarkdown(el2));
        } else if (c2.nodeType === Node.ELEMENT_NODE && (el2.localName === "p" || el2.localName === "div")) {
          own.push(inline(el2));
        } else {
          own.push(inlineNode(c2));
        }
      }
      const text = own.join("").replace(/(\\\n\s*)+$/, "").trim().replace(/\n/g, `
${pad2}`);
      lines.push(`${marker}${text}`);
      for (const sub of nested) {
        lines.push(
          sub.split("\n").map((l2) => pad2 + l2).join("\n")
        );
      }
    }
    return lines.join("\n");
  }
  function blockMarkdown(el2) {
    const tag = el2.localName;
    if (/^h[1-6]$/.test(tag)) {
      if (!plain(el2)) throw new Unsupported(tag);
      return `${"#".repeat(Number(tag[1]))} ${inline(el2).trim()}`;
    }
    const latex = formula(el2, "block");
    if (latex !== null) return `$$
${latex}
$$`;
    switch (tag) {
      case "p":
      case "div":
        if (!plain(el2)) throw new Unsupported(tag);
        if ([...el2.children].some((c2) => BLOCK.has(c2.localName))) {
          return blocks(el2);
        }
        return escapeLineStart(inline(el2).replace(/\\\n$/, "").trim());
      case "ul":
      case "ol": {
        const cls = el2.getAttribute("class");
        if (cls && cls !== TASK_LIST)
          throw new Unsupported(`${tag}.${cls}`);
        if (!plain(el2, ["start", "class"])) throw new Unsupported(tag);
        return listMarkdown(el2);
      }
      case "blockquote":
        if (!plain(el2)) throw new Unsupported(tag);
        return blocks(el2).split("\n").map((l2) => l2 ? `> ${l2}` : ">").join("\n");
      case "hr":
        return "---";
      case "table":
        if (!plain(el2)) throw new Unsupported(tag);
        return tableMarkdown(el2);
      default:
        throw new Unsupported(tag);
    }
  }
  function escapeLineStart(md) {
    const ordered = md.match(/^(\d+)([.)]) /);
    if (ordered) {
      return `${ordered[1]}\\${ordered[2]} ${md.slice(ordered[0].length)}`;
    }
    return /^(#{1,6} |[-+] |> )/.test(md) ? `\\${md}` : md;
  }
  function blocks(root2) {
    const out = [];
    let run = "";
    const flush = () => {
      if (run.trim()) out.push(run.trim());
      run = "";
    };
    for (const node of root2.childNodes) {
      if (isBlank(node)) continue;
      const el2 = node;
      if (node.nodeType === Node.ELEMENT_NODE && BLOCK.has(el2.localName)) {
        flush();
        const md = blockMarkdown(el2);
        if (md.trim()) out.push(md);
      } else if (node.nodeType === Node.ELEMENT_NODE && el2.localName === "br") {
        flush();
      } else {
        run += inlineNode(node);
      }
    }
    flush();
    return out.join("\n\n");
  }
  function htmlToMarkdown(root2) {
    return blocks(root2);
  }
  function normalizeMarkdown(md) {
    return md.replace(/\r/g, "").replace(/ {2,}\n(?=[^\n])/g, "\\\n").split("\n").map(
      (l2) => l2.replace(/\s+$/, "").replace(/^(\s*)[*+] /, "$1- ").replace(/^(\s*)\d+[.)] /, "$11. ")
    ).join("\n").replace(/__(.+?)__/g, "**$1**").replace(/(^|\W)_(\S.*?)_(?=\W|$)/g, "$1*$2*").replace(/\\([\\`*_{}[\]()#+\-.!<>~$|])/g, "$1").replace(/ *\| */g, "|").replace(/\|:?-+:?/g, "|-").replace(/\n{3,}/g, "\n\n").trim();
  }
  function sameMarkdown(a2, b2) {
    return normalizeMarkdown(a2) === normalizeMarkdown(b2);
  }

  // src/ts/editor/textedit.ts
  var layer = document.getElementById("text-layer");
  var dock = document.getElementById("zone-dock");
  function closeDock() {
    clear(dock);
    document.body.classList.remove("editing-zone");
  }
  var active2 = null;
  function isEditingText() {
    return active2 !== null;
  }
  async function finishTextEdit() {
    const a2 = active2;
    if (!a2) return;
    active2 = null;
    clear(layer);
    closeDock();
    await a2.commit();
  }
  function cancel() {
    const a2 = active2;
    if (!a2) return;
    active2 = null;
    clear(layer);
    closeDock();
    a2.cancel();
  }
  function linesOf(el2) {
    const spans = [...el2.children].filter((c2) => c2.localName === "tspan");
    const loose = [...el2.childNodes].some(
      (n3) => n3.nodeType === Node.TEXT_NODE && (n3.textContent ?? "").trim()
    );
    if (!spans.length || loose) return [el2.textContent ?? ""];
    return spans.map((s2) => s2.textContent ?? "");
  }
  async function zoneUnchanged(refused, deckIndex, zone, seen) {
    if (!await newerBuild(refused)) return false;
    const now = ed.model?.slides[deckIndex]?.zoneText?.[zone];
    return now != null && sameMarkdown(now, seen);
  }
  var CHANGED = /changed (on disk|.* meanwhile)/;
  function editSvgText(el2, sourcePath, hash, loc) {
    void finishTextEdit();
    const rect = el2.getBoundingClientRect();
    const style = getComputedStyle(el2);
    const ctm = el2.getScreenCTM();
    const fontPx = parseFloat(style.fontSize) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
    const original = linesOf(el2);
    const area2 = h("textarea", {
      class: "svg-text-editor",
      spellcheck: "true"
    });
    area2.value = original.join("\n");
    const anchor2 = style.textAnchor;
    Object.assign(area2.style, {
      left: `${rect.left - 6}px`,
      top: `${rect.top - 4}px`,
      minWidth: `${Math.max(rect.width + 24, 80)}px`,
      minHeight: `${rect.height + 8}px`,
      fontSize: `${fontPx}px`,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      lineHeight: "1.2",
      color: style.fill.startsWith("rgb") ? style.fill : "inherit",
      textAlign: anchor2 === "middle" ? "center" : anchor2 === "end" ? "right" : "left"
    });
    const autosize = () => {
      area2.style.height = "auto";
      area2.style.height = `${area2.scrollHeight}px`;
      area2.style.width = "auto";
      area2.style.width = `${Math.max(area2.scrollWidth + 8, rect.width + 24)}px`;
    };
    area2.addEventListener("input", autosize);
    el2.style.visibility = "hidden";
    layer.append(area2);
    autosize();
    area2.focus();
    area2.select();
    const startHash = hash();
    const startBuild = ed.model?.build;
    active2 = {
      commit: async () => {
        el2.style.visibility = "";
        const lines = area2.value.replace(/\r/g, "").split("\n");
        if (lines.join("\n") === original.join("\n")) return;
        if (lines.length === 1 && !el2.querySelector("tspan")) {
          el2.textContent = lines[0];
        }
        const request2 = {
          action: "svg",
          file: sourcePath,
          hash: startHash,
          ops: [{ kind: "text", loc, lines }],
          label: "Edit text",
          ...startBuild != null ? { baseBuild: startBuild } : {}
        };
        const result = await edit(request2);
        if (!result.ok && (result.stale || CHANGED.test(result.error ?? ""))) {
          showConflict(result.error ?? "", lines.join("\n"), null);
        }
      },
      cancel: () => {
        el2.style.visibility = "";
      }
    };
    area2.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Escape") {
        e2.preventDefault();
        cancel();
      } else if (e2.key === "Enter" && (e2.ctrlKey || e2.metaKey)) {
        e2.preventDefault();
        void finishTextEdit();
      }
    });
    area2.addEventListener("blur", () => void finishTextEdit());
  }
  function wrapSelection(area2, before, after = before) {
    const { selectionStart: s2, selectionEnd: e2, value } = area2;
    const inner = value.slice(s2, e2) || "text";
    area2.value = value.slice(0, s2) + before + inner + after + value.slice(e2);
    area2.selectionStart = s2 + before.length;
    area2.selectionEnd = s2 + before.length + inner.length;
    area2.dispatchEvent(new Event("input"));
    area2.focus();
  }
  function prefixLines(area2, prefix) {
    const { selectionStart: s2, selectionEnd: e2, value } = area2;
    const start = value.lastIndexOf("\n", s2 - 1) + 1;
    const end = value.indexOf("\n", e2);
    const stop2 = end === -1 ? value.length : end;
    const block = value.slice(start, stop2).split("\n").map(
      (line) => line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line
    ).join("\n");
    area2.value = value.slice(0, start) + block + value.slice(stop2);
    area2.selectionStart = start;
    area2.selectionEnd = start + block.length;
    area2.dispatchEvent(new Event("input"));
    area2.focus();
  }
  async function putBack(deckIndex, zone, text, origin2) {
    const result = await edit({
      action: "zone-text",
      slide: deckIndex,
      zone,
      text,
      origin: origin2
    });
    return result.ok;
  }
  function editZoneText(zone) {
    void finishTextEdit();
    const slide = currentSlide();
    if (!slide) return;
    const origin2 = slide.zoneOrigins?.[zone];
    const original = slide.zoneText?.[zone] ?? "";
    const deckIndex = slide.deckIndex;
    if (!ed.model?.deckEditable && (origin2 === "deck" || !slide.md)) {
      toast(
        "deck.py builds its slides in code; edit this zone there",
        "error"
      );
      return;
    }
    const area2 = h("textarea", { class: "zone-editor", spellcheck: "true" });
    area2.value = original;
    let sent2 = original;
    let timer6 = 0;
    const coalesce = `zone-${deckIndex}-${zone}-${Date.now()}`;
    let base2 = ed.model?.build;
    const follow = () => {
      const now = ed.model?.slides[deckIndex]?.zoneText?.[zone];
      if (ed.model?.build != null && now != null && sameMarkdown(now, sent2)) {
        base2 = ed.model.build;
      }
    };
    on("model", follow);
    const send2 = async () => {
      window.clearTimeout(timer6);
      if (area2.value === sent2) return;
      const before = sent2;
      sent2 = area2.value;
      const refused = base2;
      const result = await edit(
        {
          action: "zone-text",
          slide: deckIndex,
          zone,
          text: area2.value,
          origin: origin2,
          coalesce,
          ...base2 != null ? { baseBuild: base2 } : {}
        },
        { retrying: true, quietStale: true }
      );
      if (!result.ok && result.stale && await zoneUnchanged(refused, deckIndex, zone, before)) {
        base2 = ed.model?.build;
        sent2 = before;
        void send2();
        return;
      }
      if (!result.ok && result.stale) {
        const mine = area2.value;
        stopped2 = true;
        void finishTextEdit();
        showConflict(
          result.error ?? "",
          mine,
          () => putBack(deckIndex, zone, mine, origin2)
        );
        return;
      }
      if (!result.ok) {
        sent2 = before;
        timer6 = window.setTimeout(() => {
          if (!stopped2) void send2();
        }, 800);
      }
    };
    let stopped2 = false;
    area2.addEventListener("input", () => {
      window.clearTimeout(timer6);
      timer6 = window.setTimeout(() => void send2(), 450);
    });
    const button10 = (name2, title3, fn) => h(
      "button",
      {
        type: "button",
        class: "fmt-btn",
        title: title3,
        onmousedown: (e2) => {
          e2.preventDefault();
          fn();
        }
      },
      name2
    );
    const bar = h(
      "div",
      { class: "zone-toolbar" },
      h("span", { class: "zone-label" }, `${zone} \xB7 Markdown`),
      button10("B", "Bold (Ctrl+B)", () => wrapSelection(area2, "**")),
      button10("I", "Italic (Ctrl+I)", () => wrapSelection(area2, "*")),
      button10("H", "Heading", () => prefixLines(area2, "## ")),
      button10("\u2022", "Bullet list", () => prefixLines(area2, "- ")),
      button10("1.", "Numbered list", () => prefixLines(area2, "1. ")),
      button10("`", "Code", () => wrapSelection(area2, "`")),
      button10("\u2211", "Math", () => wrapSelection(area2, "$")),
      button10("\u23F5", "Reveal on click: insert a ::step:: marker", () => {
        const pos = area2.selectionStart;
        area2.value = `${area2.value.slice(0, pos)}
::step::
${area2.value.slice(pos)}`;
        area2.dispatchEvent(new Event("input"));
      }),
      h(
        "button",
        {
          type: "button",
          class: "fmt-btn done",
          title: "Done (Ctrl+Enter)",
          onmousedown: (e2) => {
            e2.preventDefault();
            void finishTextEdit();
          }
        },
        icon("select", 13),
        " Done"
      )
    );
    const wrap2 = h("div", { class: "zone-edit-wrap" }, bar, area2);
    dock.append(wrap2);
    document.body.classList.add("editing-zone");
    area2.focus();
    active2 = {
      commit: async () => {
        await send2();
        off("model", follow);
      },
      cancel: () => {
        window.clearTimeout(timer6);
        off("model", follow);
        if (sent2 !== original) {
          area2.value = original;
          void send2();
        }
      }
    };
    area2.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Escape") {
        e2.preventDefault();
        cancel();
      } else if (e2.key === "Enter" && (e2.ctrlKey || e2.metaKey)) {
        e2.preventDefault();
        void finishTextEdit();
      } else if ((e2.ctrlKey || e2.metaKey) && e2.key.toLowerCase() === "b") {
        e2.preventDefault();
        wrapSelection(area2, "**");
      } else if ((e2.ctrlKey || e2.metaKey) && e2.key.toLowerCase() === "i") {
        e2.preventDefault();
        wrapSelection(area2, "*");
      }
    });
    area2.addEventListener("blur", (e2) => {
      const next = e2.relatedTarget;
      if (next && wrap2.contains(next)) return;
      void finishTextEdit();
    });
  }
  var richHost = null;
  function editingHost() {
    return richHost;
  }
  function editZone(zone, el2, opts2 = {}) {
    void finishTextEdit();
    if (el2 && editZoneRich(zone, el2, opts2)) return;
    editZoneText(zone);
  }
  var COLORS = [
    "text",
    "text-muted",
    "accent",
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "grey"
  ];
  function editZoneRich(zone, el2, opts2) {
    const slide = currentSlide();
    const content2 = el2.querySelector(".inkflow-content");
    if (!slide || !content2 || ed.step != null) return false;
    const origin2 = slide.zoneOrigins?.[zone];
    if (!ed.model?.deckEditable && (origin2 === "deck" || !slide.md)) {
      return false;
    }
    let start;
    try {
      start = htmlToMarkdown(content2);
    } catch {
      return false;
    }
    if (!sameMarkdown(start, slide.zoneText?.[zone] ?? "")) return false;
    const fo = el2;
    const deckIndex = slide.deckIndex;
    const startBuild = ed.model?.build;
    ed.richEditing = true;
    richHost = content2;
    fo.classList.add("rich-editing");
    fo.style.overflow = "visible";
    content2.contentEditable = "true";
    for (const box2 of content2.querySelectorAll(
      "input[type=checkbox]"
    )) {
      box2.disabled = false;
    }
    content2.addEventListener("input", () => fixChecklists(content2));
    content2.spellcheck = true;
    document.execCommand("defaultParagraphSeparator", false, "p");
    content2.focus();
    placeCaret(content2, opts2);
    const bar = richToolbar(content2, () => {
      void finishTextEdit().then(() => editZoneText(zone));
    });
    layer.append(bar);
    positionBar(bar, fo);
    const cleanup = () => {
      closeFormula(false, false);
      richHost = null;
      content2.contentEditable = "false";
      fo.classList.remove("rich-editing");
      fo.style.overflow = "";
      bar.remove();
      document.removeEventListener("selectionchange", onSelection);
    };
    const onSelection = () => syncToolbar(bar, content2);
    document.addEventListener("selectionchange", onSelection);
    syncToolbar(bar, content2);
    active2 = {
      commit: async () => {
        let md;
        try {
          md = htmlToMarkdown(content2);
        } catch (err) {
          cleanup();
          ed.richEditing = false;
          emit("rerender");
          toast(
            `Not saved: ${err instanceof Unsupported ? `<${err.message}>` : "this content"} cannot be written as Markdown`,
            "error"
          );
          return;
        }
        const grow = growOp(fo, content2);
        cleanup();
        ed.richEditing = false;
        if (opts2.placeholder !== void 0 && (md === start || !md.trim())) {
          await takeBackPlaceholder();
          return;
        }
        if (md === start && !grow) {
          emit("rerender");
          return;
        }
        if (!md.trim() && removeEmptyBox(fo, zone, deckIndex)) return;
        const save5 = (base2) => edit(
          {
            action: "zone-text",
            slide: deckIndex,
            zone,
            text: md,
            origin: origin2,
            svg: grow,
            ...base2 != null ? { baseBuild: base2 } : {}
          },
          { quietStale: true }
        );
        let result = await save5(startBuild);
        if (!result.ok && result.stale && await zoneUnchanged(startBuild, deckIndex, zone, start)) {
          result = await save5(ed.model?.build);
        }
        if (!result.ok) emit("rerender");
        if (!result.ok && result.stale) {
          showConflict(
            result.error ?? "",
            md,
            () => putBack(deckIndex, zone, md, origin2)
          );
        }
      },
      cancel: () => {
        cleanup();
        ed.richEditing = false;
        if (opts2.placeholder !== void 0) {
          void takeBackPlaceholder();
          return;
        }
        emit("rerender");
      }
    };
    content2.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      const mod = e2.ctrlKey || e2.metaKey;
      if (e2.key === "Escape") {
        e2.preventDefault();
        cancel();
      } else if (e2.key === "Enter" && mod) {
        e2.preventDefault();
        void finishTextEdit();
      } else if (mod && e2.key.toLowerCase() === "k") {
        e2.preventDefault();
        editLink(content2);
      } else if (e2.key === "Tab") {
        e2.preventDefault();
        const cell = caretElement(content2)?.closest("td, th");
        if (cell) moveCell(cell, e2.shiftKey ? -1 : 1);
        else if (caretElement(content2)?.closest("li")) {
          document.execCommand(e2.shiftKey ? "outdent" : "indent");
        }
      }
    });
    content2.addEventListener("paste", (e2) => {
      e2.preventDefault();
      const text = e2.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, text);
    });
    content2.addEventListener("focusout", (e2) => {
      const next = e2.relatedTarget;
      if (next && (layer.contains(next) || content2.contains(next))) return;
      if (bar.matches(":hover")) return;
      void finishTextEdit();
    });
    for (const m2 of content2.querySelectorAll(".math")) {
      makeChip(m2);
    }
    content2.addEventListener("click", (e2) => {
      const chip = e2.target.closest?.(".math");
      if (chip && content2.contains(chip)) {
        openFormula(content2, chip);
      }
    });
    return true;
  }
  async function takeBackPlaceholder() {
    const result = await edit({ action: "undo" });
    if (!result.ok) emit("rerender");
  }
  function placeCaret(content2, opts2) {
    const sel = window.getSelection();
    if (!sel) return;
    let range = null;
    if (opts2.at && !opts2.selectAll) {
      range = document.caretRangeFromPoint?.(opts2.at.x, opts2.at.y) ?? null;
      if (range && !content2.contains(range.startContainer)) range = null;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(content2);
      if (!opts2.selectAll) range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function positionBar(bar, fo) {
    const r2 = fo.getBoundingClientRect();
    const top = r2.top - 44 < 52 ? r2.bottom + 8 : r2.top - 44;
    bar.style.left = `${Math.max(8, Math.min(r2.left, window.innerWidth - 640))}px`;
    bar.style.top = `${top}px`;
  }
  function removeEmptyBox(fo, zone, deckIndex) {
    const slide = currentSlide();
    const loc = fo.getAttribute("data-ink");
    if (!slide || !loc || !/^text(-\d+)?$/.test(zone)) return false;
    const src = slide.sources?.[parseInt(loc.split(":")[0] ?? "", 10)];
    if (src?.role !== "slide" || slide.srcShared || !src.writable) return false;
    void edit({
      action: "svg",
      file: src.path,
      hash: src.hash,
      zoneSlide: deckIndex,
      ops: [{ kind: "delete", loc }],
      label: "Delete text box"
    });
    return true;
  }
  function growOp(fo, content2) {
    const slide = currentSlide();
    const loc = fo.getAttribute("data-ink");
    if (!slide || !loc || fo.getAttribute("data-ink-tag") !== "rect") return;
    const src = slide.sources?.[parseInt(loc.split(":")[0] ?? "", 10)];
    if (!src?.writable || src.role === "slide" && slide.srcShared) return;
    if (src.role !== "slide" && !ed.layoutMode) return;
    const wrapper = content2.parentElement;
    const have = parseFloat(fo.getAttribute("height") ?? "0");
    const need = wrapper ? wrapper.scrollHeight : 0;
    if (!have || need <= have + 2) return;
    return {
      file: src.path,
      hash: src.hash,
      ops: [{ kind: "attrs", loc, set: { height: String(Math.ceil(need)) } }]
    };
  }
  function caretElement(content2) {
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    if (!node || !content2.contains(node)) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }
  function changed(content2) {
    content2.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function selectionRange(content2) {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return content2.contains(range.commonAncestorContainer) ? range : null;
  }
  function unwrap(el2) {
    el2.replaceWith(...el2.childNodes);
  }
  function wrapRange(content2, make, same) {
    const range = selectionRange(content2);
    if (!range || range.collapsed) return;
    const frag = range.extractContents();
    frag.querySelectorAll(same).forEach(unwrap);
    const sel = window.getSelection();
    if (make) {
      const el2 = make();
      el2.append(frag);
      range.insertNode(el2);
      range.selectNodeContents(el2);
    } else {
      const first = frag.firstChild;
      const last = frag.lastChild;
      range.insertNode(frag);
      if (first && last) {
        range.setStartBefore(first);
        range.setEndAfter(last);
      }
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
    content2.querySelectorAll(same).forEach((el2) => {
      if (!el2.textContent) el2.remove();
    });
    changed(content2);
  }
  function setColor(content2, token) {
    wrapRange(
      content2,
      token ? () => h("span", { class: `inkflow-color-${token}` }) : null,
      'span[class^="inkflow-color-"]'
    );
  }
  function toggleCode(content2) {
    const inCode = caretElement(content2)?.closest("code");
    if (inCode && content2.contains(inCode)) {
      unwrap(inCode);
      changed(content2);
      return;
    }
    wrapRange(content2, () => h("code", {}), "code");
  }
  function editLink(content2) {
    const a2 = caretElement(content2)?.closest("a");
    const range = selectionRange(content2);
    const current3 = a2?.getAttribute("href") ?? "";
    const url = window.prompt(
      a2 ? "Link address: https://\u2026 or slide:<id> (empty removes the link)" : "Link address: https://\u2026 or slide:<id>",
      current3 || "https://"
    );
    if (url == null) return;
    const sel = window.getSelection();
    if (range) {
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    if (a2 && !url.trim()) {
      unwrap(a2);
    } else if (a2) {
      a2.setAttribute("href", url.trim());
    } else if (url.trim() && range && !range.collapsed) {
      document.execCommand("createLink", false, url.trim());
    } else if (url.trim()) {
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${encodeURI(url.trim())}">${url.trim().replace(/</g, "&lt;")}</a>`
      );
    }
    changed(content2);
  }
  function cellOf(content2) {
    const cell = caretElement(content2)?.closest("td, th");
    return cell && content2.contains(cell) ? cell : null;
  }
  function focusCell(cell) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  function moveCell(cell, by) {
    const table = cell.closest("table");
    if (!table) return;
    const cells = [...table.querySelectorAll("th, td")];
    const next = cells[cells.indexOf(cell) + by];
    if (next) focusCell(next);
    else if (by > 0) {
      addRow2(cell);
      const after = [...table.querySelectorAll("th, td")];
      focusCell(after[cells.length]);
    }
  }
  function newCell(tag, like) {
    const cell = document.createElement(tag);
    const align2 = like?.style.textAlign;
    if (align2) cell.style.textAlign = align2;
    cell.append(document.createElement("br"));
    return cell;
  }
  function addRow2(cell) {
    const row7 = cell.parentElement;
    const table = row7.closest("table");
    let body3 = table.tBodies[0];
    if (!body3) {
      body3 = document.createElement("tbody");
      table.append(body3);
    }
    const tr = document.createElement("tr");
    for (const c2 of row7.children) tr.append(newCell("td", c2));
    if (row7.parentElement?.localName === "thead") body3.prepend(tr);
    else row7.after(tr);
  }
  function addColumn2(cell) {
    const table = cell.closest("table");
    const index = cell.cellIndex;
    for (const row7 of table.rows) {
      const ref = row7.cells[index];
      const tag = row7.parentElement?.localName === "thead" ? "th" : "td";
      const c2 = newCell(tag, ref);
      if (ref) ref.after(c2);
      else row7.append(c2);
    }
  }
  function deleteRow(cell) {
    const row7 = cell.parentElement;
    const table = row7.closest("table");
    if (table.rows.length <= 1) {
      table.remove();
      return;
    }
    if (row7.parentElement?.localName === "thead") {
      const next = table.tBodies[0]?.rows[0];
      if (!next) return;
      const head = document.createElement("tr");
      for (const c2 of next.cells) {
        const th = newCell("th", c2);
        th.replaceChildren(...c2.childNodes);
        head.append(th);
      }
      row7.replaceWith(head);
      next.remove();
      return;
    }
    row7.remove();
  }
  function deleteColumn(cell) {
    const table = cell.closest("table");
    const index = cell.cellIndex;
    if (table.rows[0]?.cells.length <= 1) {
      table.remove();
      return;
    }
    for (const row7 of [...table.rows]) row7.cells[index]?.remove();
  }
  function alignColumn(cell, align2) {
    const table = cell.closest("table");
    for (const row7 of table.rows) {
      const c2 = row7.cells[cell.cellIndex];
      if (c2) c2.style.textAlign = align2;
    }
  }
  function makeChip(el2) {
    el2.contentEditable = "false";
    el2.classList.add("math-chip");
  }
  var formula2 = null;
  function closeFormula(revert2, refocus = true) {
    if (!formula2) return;
    const f2 = formula2;
    formula2 = null;
    f2.pop.remove();
    f2.chip.classList.remove("editing");
    if (revert2) f2.revert();
    if (refocus && f2.chip.isConnected) f2.done();
  }
  function insertFormula(content2) {
    const range = selectionRange(content2);
    const chip = h("span", { class: "math inline" });
    chip.innerHTML = '<math data-latex=""></math>';
    makeChip(chip);
    if (range) {
      range.deleteContents();
      range.insertNode(chip);
    } else {
      content2.append(chip);
    }
    openFormula(content2, chip, true);
  }
  function openFormula(content2, chip, isNew = false) {
    closeFormula(false);
    const original = chip.querySelector("math")?.getAttribute("data-latex") ?? "";
    const before = chip.cloneNode(true);
    const field2 = h("textarea", {
      class: "formula-input",
      rows: 2,
      spellcheck: "false",
      placeholder: "LaTeX, e.g. \\frac{a}{b}"
    });
    field2.value = original || (isNew ? "x" : "");
    const block = h("input", { type: "checkbox" });
    block.checked = chip.classList.contains("block");
    const status3 = h("span", { class: "formula-status" });
    const pop = h(
      "div",
      { class: "formula-pop" },
      field2,
      h(
        "div",
        { class: "formula-row" },
        h("label", {}, block, " On its own line"),
        status3,
        h(
          "button",
          {
            type: "button",
            class: "fmt-btn done",
            onmousedown: (e2) => {
              e2.preventDefault();
              closeFormula(false);
            }
          },
          "Done"
        )
      )
    );
    const self = {
      pop,
      chip,
      revert: () => {
        if (isNew) self.chip.remove();
        else self.chip.replaceWith(before);
        changed(content2);
      },
      done: () => {
        content2.focus();
        const range = document.createRange();
        range.setStartAfter(self.chip);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    };
    pop.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Escape") {
        e2.preventDefault();
        closeFormula(true);
      } else if (e2.key === "Enter" && !e2.shiftKey) {
        e2.preventDefault();
        closeFormula(false);
      }
    });
    let timer6 = 0;
    let seq = 0;
    const renderNow = async () => {
      window.clearTimeout(timer6);
      const latex = field2.value.trim();
      if (!latex) return;
      const mine = ++seq;
      const wantBlock = block.checked;
      const result = await request({
        action: "math",
        latex,
        block: wantBlock
      });
      if (mine !== seq || formula2 !== self) return;
      if (!result.ok) {
        status3.textContent = result.error ?? "cannot render";
        pop.classList.add("error");
        return;
      }
      status3.textContent = "";
      pop.classList.remove("error");
      if (wantBlock !== self.chip.classList.contains("block")) {
        self.chip = swapKind(content2, self.chip, wantBlock);
      }
      self.chip.innerHTML = String(
        result.mathml
      );
      changed(content2);
      placePop(pop, self.chip);
    };
    field2.addEventListener("input", () => {
      window.clearTimeout(timer6);
      timer6 = window.setTimeout(() => void renderNow(), 250);
    });
    block.addEventListener("change", () => void renderNow());
    chip.classList.add("editing");
    layer.append(pop);
    placePop(pop, chip);
    formula2 = self;
    field2.focus();
    field2.select();
    if (isNew) void renderNow();
  }
  function swapKind(content2, chip, block) {
    const next = h(block ? "div" : "span", {
      class: `math ${block ? "block" : "inline"}`
    });
    makeChip(next);
    next.classList.add("editing");
    if (block) {
      const para = chip.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote");
      chip.remove();
      if (para && content2.contains(para)) para.after(next);
      else content2.append(next);
    } else {
      const p2 = h("p", {});
      chip.replaceWith(p2);
      p2.append(next);
    }
    return next;
  }
  function placePop(pop, chip) {
    const r2 = chip.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r2.left, window.innerWidth - 420))}px`;
    pop.style.top = `${Math.min(r2.bottom + 8, window.innerHeight - 140)}px`;
  }
  function checkbox() {
    const box2 = h("input", {
      type: "checkbox",
      class: "task-list-item-checkbox"
    });
    return box2;
  }
  function fixChecklists(content2) {
    for (const li of content2.querySelectorAll("ul.contains-task-list > li")) {
      li.classList.add("task-list-item");
      const first = li.firstChild;
      if (!(first instanceof HTMLInputElement)) {
        li.prepend(checkbox(), " ");
      }
    }
  }
  function toggleChecklist(content2) {
    let li = caretElement(content2)?.closest("li");
    if (!li || !content2.contains(li)) {
      document.execCommand("insertUnorderedList");
      li = caretElement(content2)?.closest("li");
    }
    const list4 = li?.parentElement;
    if (list4?.localName !== "ul") return;
    if (list4.classList.contains("contains-task-list")) {
      list4.classList.remove("contains-task-list");
      if (!list4.classList.length) list4.removeAttribute("class");
      for (const item2 of list4.children) {
        item2.classList.remove("task-list-item");
        if (!item2.classList.length) item2.removeAttribute("class");
        item2.querySelector(":scope > input[type=checkbox]")?.remove();
      }
    } else {
      list4.classList.add("contains-task-list");
      fixChecklists(content2);
    }
    changed(content2);
  }
  function insertReveal(content2) {
    const block = caretElement(content2)?.closest(
      "p, h1, h2, h3, h4, h5, h6, ul, ol, table, blockquote"
    );
    const marker = h("p", {}, "::step::");
    if (block && content2.contains(block)) {
      block.before(marker);
    } else {
      content2.append(marker);
    }
    changed(content2);
    toast("Saved when you finish: what follows appears one click later");
  }
  function insertTable(content2) {
    const head = "<th>Header</th><th>Header</th><th>Header</th>";
    const row7 = "<td><br></td><td><br></td><td><br></td>";
    document.execCommand(
      "insertHTML",
      false,
      `<table><thead><tr>${head}</tr></thead><tbody><tr>${row7}</tr><tr>${row7}</tr></tbody></table><p><br></p>`
    );
    const after = caretElement(content2)?.closest("p");
    const table = after?.previousElementSibling;
    const first = table?.localName === "table" ? table.querySelector("th") : null;
    if (first) {
      const range = document.createRange();
      range.selectNodeContents(first);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    changed(content2);
  }
  function tableCommand(content2, fn) {
    const cell = cellOf(content2);
    if (!cell) return;
    fn(cell);
    changed(content2);
    syncToolbar(document.querySelector(".rich-bar"), content2);
  }
  function richToolbar(content2, toSource) {
    const btn = (label4, title3, fn, cls = "") => h(
      "button",
      {
        type: "button",
        class: `fmt-btn ${cls}`,
        title: title3,
        onmousedown: (e2) => {
          e2.preventDefault();
          fn();
          syncToolbar(bar, content2);
        }
      },
      label4
    );
    const exec = (cmd, value) => () => {
      document.execCommand(cmd, false, value);
      changed(content2);
    };
    const block = h("select", { class: "fmt-block", title: "Paragraph style" });
    for (const [v2, l2] of [
      ["p", "Text"],
      ["h1", "Title"],
      ["h2", "Heading"],
      ["h3", "Subheading"],
      ["blockquote", "Quote"]
    ]) {
      block.append(h("option", { value: v2 }, l2));
    }
    block.addEventListener("mousedown", (e2) => e2.stopPropagation());
    block.addEventListener("change", () => {
      content2.focus();
      document.execCommand("formatBlock", false, `<${block.value}>`);
      changed(content2);
    });
    const swatches = h("div", { class: "fmt-colors" });
    const host5 = content2.closest("svg");
    const css = host5 ? getComputedStyle(host5) : null;
    swatches.append(
      btn(
        "A",
        "Default colour",
        () => setColor(content2, null),
        "swatch none"
      )
    );
    for (const t2 of COLORS) {
      const b2 = btn("", t2, () => setColor(content2, t2), "swatch");
      b2.style.background = css?.getPropertyValue(`--inkflow-${t2}`).trim() || "currentColor";
      swatches.append(b2);
    }
    const colorBtn = btn(
      h("span", { class: "fmt-color-a" }, "A"),
      "Text colour",
      () => swatches.classList.toggle("open")
    );
    const tableTools = h(
      "span",
      { class: "fmt-table" },
      h("span", { class: "fmt-sep" }),
      btn("+row", "Add a row below", () => tableCommand(content2, addRow2)),
      btn(
        "+col",
        "Add a column to the right",
        () => tableCommand(content2, addColumn2)
      ),
      btn("\u2212row", "Delete this row", () => tableCommand(content2, deleteRow)),
      btn(
        "\u2212col",
        "Delete this column",
        () => tableCommand(content2, deleteColumn)
      ),
      btn(
        "\u21E4",
        "Align column left",
        () => tableCommand(content2, (c2) => alignColumn(c2, "left"))
      ),
      btn(
        "\u21D4",
        "Centre column",
        () => tableCommand(content2, (c2) => alignColumn(c2, "center"))
      ),
      btn(
        "\u21E5",
        "Align column right",
        () => tableCommand(content2, (c2) => alignColumn(c2, "right"))
      )
    );
    const bar = h(
      "div",
      { class: "rich-bar" },
      block,
      h("span", { class: "fmt-sep" }),
      btn(h("b", {}, "B"), "Bold (Ctrl+B)", exec("bold"), "fmt-bold"),
      btn(h("i", {}, "I"), "Italic (Ctrl+I)", exec("italic"), "fmt-italic"),
      btn(
        h("s", {}, "S"),
        "Strikethrough",
        exec("strikeThrough"),
        "fmt-strike"
      ),
      btn("</>", "Inline code", () => toggleCode(content2), "fmt-code"),
      h("span", { class: "fmt-color-wrap" }, colorBtn, swatches),
      btn("\u{1F517}", "Link (Ctrl+K)", () => editLink(content2), "fmt-link"),
      h("span", { class: "fmt-sep" }),
      btn("\u2022", "Bullet list", exec("insertUnorderedList"), "fmt-ul"),
      btn("1.", "Numbered list", exec("insertOrderedList"), "fmt-ol"),
      btn("\u2611", "Checklist", () => toggleChecklist(content2), "fmt-task"),
      btn("\u2211", "Formula (LaTeX)", () => insertFormula(content2)),
      btn("\u25A6", "Insert a table", () => insertTable(content2)),
      tableTools,
      h("span", { class: "fmt-sep" }),
      btn("Tx", "Clear formatting", exec("removeFormat")),
      btn(
        "\u23F5",
        "Reveal on click: what follows appears one click later (a ::step:: marker; afterwards this text is edited as Markdown)",
        () => insertReveal(content2)
      ),
      btn(
        "M\u2193",
        "Edit the Markdown source (code, images, reveals\u2026)",
        toSource
      ),
      btn(
        h("span", {}, icon("select", 13), " Done"),
        "Done (Ctrl+Enter)",
        () => void finishTextEdit(),
        "done"
      )
    );
    return bar;
  }
  function syncToolbar(bar, content2) {
    if (!bar) return;
    const el2 = caretElement(content2);
    const state = (cmd) => {
      try {
        return document.queryCommandState(cmd);
      } catch {
        return false;
      }
    };
    const on2 = (cls, v2) => bar.querySelector(`.${cls}`)?.classList.toggle("on", v2);
    on2("fmt-bold", state("bold"));
    on2("fmt-italic", state("italic"));
    on2("fmt-strike", state("strikeThrough"));
    on2("fmt-code", !!el2?.closest("code"));
    on2("fmt-link", !!el2?.closest("a"));
    on2("fmt-ul", !!el2?.closest("ul"));
    on2("fmt-ol", !!el2?.closest("ol"));
    on2("fmt-task", !!el2?.closest("ul.contains-task-list"));
    const blockEl = el2?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, li");
    const select2 = bar.querySelector(".fmt-block");
    if (select2 && blockEl) {
      const tag = blockEl.closest("blockquote") ? "blockquote" : blockEl.localName;
      select2.value = ["p", "h1", "h2", "h3", "blockquote"].includes(tag) ? tag : "p";
    }
    bar.querySelector(".fmt-table")?.classList.toggle(
      "show",
      !!el2?.closest("td, th")
    );
  }

  // src/ts/editor/toolbar.ts
  var $ = (id) => document.getElementById(id);
  async function undo() {
    await edit({ action: "undo" });
  }
  async function redo() {
    await edit({ action: "redo" });
  }
  async function deleteSelection() {
    const slide = currentSlide();
    if (!slide || !ed.selection.length) return;
    const zones = ed.selection.filter(
      (s2) => isZone(s2.el) && !canTransform(s2.el)
    );
    const shapes2 = ed.selection.filter((s2) => !zones.includes(s2));
    for (const z of zones) {
      const name2 = zoneName(z.el);
      const value = slide.zones[name2];
      if (slide.zoneOrigins?.[name2] === "md-file") {
        toast(
          "This zone shows the whole Markdown file: edit its text instead"
        );
        continue;
      }
      if (value && (value.kind === "image" || value.kind === "video" || value.kind === "chart")) {
        await edit({
          action: "zone-media",
          slide: slide.deckIndex,
          zone: name2,
          src: null
        });
      } else {
        await edit({
          action: "zone-text",
          slide: slide.deckIndex,
          zone: name2,
          text: "",
          origin: slide.zoneOrigins?.[name2]
        });
      }
    }
    if (shapes2.length) {
      await sendSvgOps(
        shapes2.map((s2) => ({
          sel: s2,
          ops: [{ kind: "delete", loc: s2.loc }]
        })),
        "Delete"
      );
    }
    clearSelection();
  }
  async function duplicateSelection() {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    if (!sels.length) return;
    const k2 = 1 / (scale() || 1);
    const off2 = Math.round(24 * Math.max(1, k2 * 0.5));
    await sendSvgOps(
      sels.map((s2, i2) => ({
        sel: s2,
        ops: [
          {
            kind: "duplicate",
            loc: s2.loc,
            offset: [off2, off2],
            key: `dup${i2}`
          }
        ]
      })),
      "Duplicate"
    );
  }
  async function groupSelection() {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    if (sels.length < 2) return;
    const key = sels[0].key;
    const parent = sels[0].el.parentElement;
    if (sels.some((s2) => s2.key !== key || s2.el.parentElement !== parent)) {
      toast(
        "Only objects side by side in the same file can be grouped",
        "error"
      );
      return;
    }
    await sendSvgOps(
      [
        {
          sel: sels[0],
          ops: [{ kind: "group", locs: sels.map((s2) => s2.loc) }]
        }
      ],
      "Group"
    );
  }
  async function ungroupSelection() {
    const s2 = ed.selection[0];
    if (s2?.el.localName !== "g" || !canTransform(s2.el)) return;
    await sendSvgOps(
      [{ sel: s2, ops: [{ kind: "ungroup", loc: s2.loc }] }],
      "Ungroup"
    );
  }
  async function order(to) {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    if (!sels.length) return;
    await sendSvgOps(
      sels.map((s2) => ({ sel: s2, ops: [{ kind: "order", loc: s2.loc, to }] })),
      "Arrange"
    );
  }
  function present() {
    const slide = currentSlide();
    const n3 = (slide?.visibleIndex ?? 0) + 1;
    window.open(`/#slide=${n3}`, "inkflow-present");
  }
  function toggleTheme() {
    const root2 = document.documentElement;
    root2.dataset.theme = root2.dataset.theme === "light" ? "" : "light";
    render();
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {
    });
  }
  function updateFullscreen() {
    const on2 = !!document.fullscreenElement;
    const b2 = $("btn-fullscreen");
    b2.classList.toggle("on", on2);
    const k2 = firstKey("view.fullscreen");
    const what = on2 ? "Leave full screen" : "Full screen";
    b2.title = k2 ? `${what} (${k2})` : what;
  }
  function updateZoomLabel() {
    $("zoom-label").textContent = `${Math.round(scale() * 100)}%`;
  }
  function updateHistory() {
    const undoBtn = $("btn-undo");
    const redoBtn = $("btn-redo");
    undoBtn.disabled = !ed.canUndo;
    redoBtn.disabled = !ed.canRedo;
    undoBtn.title = historyTitle("Undo", ed.canUndo && ed.undoLabel, "Ctrl+Z");
    if (ed.canUndo && ed.undoBlockedBy) {
      undoBtn.title += ` \u2014 ${ed.undoBlockedBy} changed the same file after you`;
    }
    undoBtn.classList.toggle("blocked", !!(ed.canUndo && ed.undoBlockedBy));
    redoBtn.title = historyTitle(
      "Redo",
      ed.canRedo && ed.redoLabel,
      "Ctrl+Shift+Z"
    );
  }
  function historyTitle(verb, label4, keys) {
    return label4 ? `${verb} ${label4} (${keys})` : `${verb} (${keys})`;
  }
  function updateTools() {
    document.querySelectorAll("[data-tool]").forEach((b2) => {
      b2.classList.toggle("on", b2.dataset.tool === ed.tool);
    });
  }
  function newSlide2() {
    if (ed.model?.deckEditable) void newSlideLike(ed.current);
    else toast("deck.py builds its slides in code; add slides there", "error");
  }
  var COMMANDS = {
    "tool.select": () => setTool("select"),
    "tool.text": () => setTool("text"),
    "tool.rect": () => setTool("rect"),
    "tool.ellipse": () => setTool("ellipse"),
    "tool.line": () => setTool("line"),
    "tool.arrow": () => setTool("arrow"),
    "tool.elbow": () => setTool("elbow"),
    "tool.curve": () => setTool("curve"),
    "tool.pen": () => setTool("pen"),
    "insert.image": () => void insertImage(),
    "insert.video": () => void insertVideo(),
    "edit.duplicate": () => void duplicateSelection(),
    "edit.copy-style": copyStyle,
    "edit.paste-style": () => void pasteStyle(),
    "edit.find": () => openFind(false),
    "edit.replace": () => openFind(true),
    "arrange.group": () => void groupSelection(),
    "arrange.ungroup": () => void ungroupSelection(),
    "arrange.forward": () => void order("forward"),
    "arrange.backward": () => void order("backward"),
    "arrange.front": () => void order("front"),
    "arrange.back": () => void order("back"),
    "slide.new": newSlide2,
    "slide.gallery": () => void openGallery({ mode: "insert", after: ed.current }),
    "slide.star": starSelection,
    "slide.present": present,
    "view.grid": () => toggleGrid(),
    "view.fullscreen": toggleFullscreen,
    "view.left": () => togglePanel("left"),
    "view.bottom": () => togglePanel("bottom"),
    "view.right": () => togglePanel("right"),
    "view.zoom-in": () => setZoom(scale() * 1.25),
    "view.zoom-out": () => setZoom(scale() / 1.25),
    "view.zoom-fit": () => setZoom(0),
    "help.shortcuts": openShortcuts
  };
  function readingNotes() {
    const picked = window.getSelection();
    const preview2 = document.getElementById("notes-preview");
    return !!picked && !picked.isCollapsed && !!preview2 && preview2.contains(picked.anchorNode);
  }
  function onKey3(e2) {
    const target = e2.target;
    if (target.closest("input, textarea, select, [contenteditable]") || isEditingText()) {
      return;
    }
    const mod = e2.ctrlKey || e2.metaKey;
    const key = e2.key;
    const lower = key.toLowerCase();
    const handled = () => e2.preventDefault();
    const command = commandFor(e2);
    if (command && COMMANDS[command]) {
      handled();
      COMMANDS[command]();
      return;
    }
    if (mod && lower === "z") {
      handled();
      void (e2.shiftKey ? redo() : undo());
    } else if (mod && lower === "y") {
      handled();
      void redo();
    } else if (mod && lower === "a") {
      handled();
      selectAll();
    } else if (mod && lower === "c" && readingNotes()) {
    } else if (mod && lower === "c") {
      handled();
      if (ed.focus === "sorter") void copySlides();
      else copy();
    } else if (mod && lower === "x") {
      handled();
      if (ed.focus === "sorter") void cutSlides();
      else cut();
    } else if ((key === "Delete" || key === "Backspace") && ed.focus === "sorter") {
      handled();
      void deleteSlides();
    } else if (key === "Delete" || key === "Backspace") {
      if (ed.selection.length) {
        handled();
        void deleteSelection();
      }
    } else if (mod) {
    } else if (key.startsWith("Arrow") && ed.selection.length) {
      handled();
      const d2 = e2.shiftKey ? 10 : 1;
      const dx = key === "ArrowLeft" ? -d2 : key === "ArrowRight" ? d2 : 0;
      const dy = key === "ArrowUp" ? -d2 : key === "ArrowDown" ? d2 : 0;
      void nudge(dx, dy);
    } else if (key === "PageDown" || key === "ArrowDown" && !ed.selection.length) {
      handled();
      gotoSlide(ed.current + 1);
    } else if (key === "PageUp" || key === "ArrowUp" && !ed.selection.length) {
      handled();
      gotoSlide(ed.current - 1);
    } else if (ed.cropMode && (key === "Escape" || key === "Enter")) {
      handled();
      setCropMode(false);
    } else if (key === "Escape" && ed.step != null && !document.body.classList.contains("anim-playing")) {
      setStep(null);
    } else if (key === "Escape") {
      if (ed.tool !== "select") setTool("select");
      else if (ed.scope) enterGroup(null);
      else clearSelection();
    } else if (key === "Enter" && ed.selection.length === 1 && canTypeInto(ed.selection[0].el)) {
      handled();
      void typeInto(ed.selection[0].el);
    } else if (key === "Enter" && ed.selection.length === 1) {
      handled();
      const el2 = ed.selection[0].el;
      emit(
        isZone(el2) ? "edit-zone" : el2.localName === "text" ? "edit-text" : "noop"
      );
      if (el2.localName === "g") enterGroup(el2);
    }
  }
  function initToolbar() {
    $("btn-undo").addEventListener("click", () => void undo());
    $("btn-redo").addEventListener("click", () => void redo());
    document.querySelectorAll("[data-tool]").forEach((b2) => {
      b2.addEventListener("click", () => setTool(b2.dataset.tool));
    });
    $("btn-image").addEventListener("click", () => void insertImage());
    $("btn-video").addEventListener("click", () => void insertVideo());
    $("btn-diagram").addEventListener("click", () => newDiagram());
    $("btn-chart").addEventListener("click", () => void insertChart());
    $("zoom-in").addEventListener("click", () => setZoom(scale() * 1.25));
    $("zoom-out").addEventListener("click", () => setZoom(scale() / 1.25));
    $("zoom-fit").addEventListener("click", () => setZoom(0));
    $("btn-theme").addEventListener("click", toggleTheme);
    $("btn-present").addEventListener("click", present);
    $("btn-fullscreen").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", updateFullscreen);
    initStepButton();
    document.addEventListener("keydown", onKey3);
    on("render", renderStepButton);
    on("render", updateZoomLabel);
    on("zoom", updateZoomLabel);
    on("history", updateHistory);
    on("keys", updateFullscreen);
    on("tool", updateTools);
    on("delete", () => void deleteSelection());
    on("duplicate", () => void duplicateSelection());
    on("group", () => void groupSelection());
    on("ungroup", () => void ungroupSelection());
    on("align", () => alignSelection("center"));
    on("slide-duplicate", () => void duplicateSlide());
    on("slide-delete", () => void deleteSlide());
    window.addEventListener("resize", layoutPaper);
    updateHistory();
    updateTools();
  }

  // src/ts/editor/canvasmenu.ts
  var menu5 = document.getElementById("context-menu");
  var at = { x: 0, y: 0 };
  function sep() {
    return h("div", { class: "menu-sep" });
  }
  function title2(text) {
    return h("div", { class: "menu-title" }, text);
  }
  function objectMenu() {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    const one = sels.length === 1 ? sels[0] : null;
    const el2 = one?.el ?? null;
    const items2 = [];
    if (el2) {
      if (canTypeInto(el2)) {
        items2.push(menuItem("Type text into it", () => void typeInto(el2)));
      } else if (isZone(el2)) {
        items2.push(menuItem("Edit text", () => emit("edit-zone")));
      } else if (el2.localName === "text") {
        items2.push(menuItem("Edit text", () => emit("edit-text")));
      } else if (el2.localName === "g") {
        items2.push(
          menuItem(
            "Enter group",
            () => enterGroup(el2)
          )
        );
      }
      const video = videoOf(el2);
      if (video) {
        items2.push(
          menuItem(
            isPreviewing(video) ? "Pause preview" : "Play preview",
            () => togglePreview(video)
          )
        );
        const zone = isZone(el2) ? zoneName(el2) : null;
        const media = zone ? currentSlide()?.zones[zone] : null;
        const slide = currentSlide();
        if (zone && slide && media?.kind === "video" && media.src) {
          const src = media.src;
          items2.push(
            menuItem(
              "Check & convert\u2026",
              () => void openVideoCheck({
                path: src,
                slide: slide.deckIndex,
                zone
              })
            )
          );
        }
      }
      if (diagramOf(el2)) {
        items2.push(menuItem("Edit diagram", () => editDiagram(one)));
      }
      const chartZone = isZone(el2) ? zoneName(el2) : null;
      if (chartZone && currentSlide()?.zones[chartZone]?.kind === "chart") {
        items2.push(
          menuItem("Edit chart data\u2026", () => void editChart(chartZone))
        );
      }
      if (pictureOf(el2)) {
        items2.push(menuItem("Crop", () => void startCrop(one)));
      }
    }
    const only = ed.selection.length === 1 ? ed.selection[0].el : null;
    const file = only ? fileOf(only) : null;
    if (file) {
      const name2 = file.split("/").pop() ?? file;
      items2.push(menuItem(`Rename ${name2}\u2026`, () => void renameFile(file)));
    }
    if (items2.length) items2.push(sep());
    items2.push(
      menuItem("Cut", () => cut()),
      menuItem("Copy", () => copy()),
      menuItem("Paste", () => void pasteFromClipboard()),
      menuItem("Duplicate", () => void duplicateSelection(), !sels.length),
      menuItem("Delete", () => void deleteSelection()),
      sep(),
      menuItem("Copy style", () => copyStyle(), !one),
      menuItem(
        "Paste style",
        () => void pasteStyle(),
        !sels.length || !hasCopiedStyle()
      ),
      sep(),
      menuItem("Bring to front", () => void order("front"), !sels.length),
      menuItem("Bring forward", () => void order("forward"), !sels.length),
      menuItem("Send backward", () => void order("backward"), !sels.length),
      menuItem("Send to back", () => void order("back"), !sels.length)
    );
    if (sels.length > 1) {
      items2.push(
        sep(),
        menuItem("Group", () => void groupSelection()),
        title2("Align"),
        ...[
          ["left", "Left edges"],
          ["center", "Centres (horizontally)"],
          ["right", "Right edges"],
          ["top", "Top edges"],
          ["middle", "Middles (vertically)"],
          ["bottom", "Bottom edges"]
        ].map(([how, label4]) => menuItem(label4, () => alignSelection(how)))
      );
    } else if (el2?.localName === "g") {
      items2.push(
        sep(),
        menuItem("Ungroup", () => void ungroupSelection())
      );
    }
    if (el2 && one) {
      const src = sourceOf(one.key);
      items2.push(
        sep(),
        menuItem(
          isHidden(el2) ? "Show" : "Hide",
          () => void toggleHidden2(el2)
        ),
        menuItem(
          el2.hasAttribute("data-ink-locked") ? "Unlock" : "Lock",
          () => void toggleLocked(el2)
        )
      );
      if (src) {
        const name2 = src.rel.split("/").pop() ?? src.rel;
        items2.push(
          menuItem(`Open ${name2} in\u2026`, () => {
            void openMenu(src.path, at.x, at.y);
          })
        );
      }
    }
    return items2;
  }
  function fileOf(el2) {
    const drawn2 = drawnDiagram(el2);
    if (drawn2) return projectFile(drawn2.getAttribute("data-drawio"));
    const image = pictureOf(el2);
    if (image) return projectFile(sourceRef(image));
    if (!isZone(el2)) return null;
    const media = currentSlide()?.zones[zoneName(el2)];
    if (media?.kind === "image" || media?.kind === "video") {
      return projectFile(media.src);
    }
    if (media?.kind === "chart" && !media.inline) return media.path ?? null;
    return null;
  }
  function clickedAt() {
    return clientToSlide(at.x, at.y);
  }
  async function insertFromDisk() {
    const start = ed.model?.projectDir ?? "";
    const path = await pickVideoFromDisk(start);
    if (!path) return;
    const name2 = path.split(/[\\/]/).pop() ?? path;
    await insertVideoFile({ path, name: name2 });
  }
  function slideMenu() {
    const slide = currentSlide();
    const editable = !!ed.model?.deckEditable;
    const i2 = slide?.deckIndex ?? ed.current;
    if (ed.master) {
      return [
        menuItem("Paste", () => void pasteFromClipboard()),
        menuItem("Select all", () => selectAll()),
        menuItem("New diagram (draw.io)\u2026", () => newDiagram())
      ];
    }
    return [
      menuItem("Paste", () => void pasteFromClipboard()),
      menuItem("Select all", () => selectAll()),
      menuItem("Insert video from a folder\u2026", () => void insertFromDisk()),
      menuItem("New diagram (draw.io)\u2026", () => newDiagram()),
      menuItem("Insert chart\u2026", () => void insertChart(clickedAt())),
      sep(),
      title2("Slide"),
      menuItem(
        "New slide after\u2026",
        () => void openGallery({ mode: "insert", after: ed.current }),
        !editable
      ),
      menuItem(
        "Change layout\u2026",
        () => {
          const parent = document.querySelector("#slide-host svg")?.getAttribute("inkflow:parent") ?? null;
          void openGallery({ mode: "change", current: parent });
        },
        !editable
      ),
      menuItem(
        "Duplicate slide",
        () => void duplicateSlide(ed.current),
        !editable
      ),
      menuItem(
        "Save slide as layout\u2026",
        () => saveAsLayout(ed.current),
        !editable
      ),
      menuItem(
        slide?.visible === false ? "Show slide" : "Hide slide",
        () => void edit({
          action: "slide",
          op: "hide",
          slide: i2,
          hidden: slide?.visible !== false
        }),
        !editable
      ),
      menuItem("Delete slide", () => void deleteSlide(ed.current), !editable)
    ];
  }
  function onContextMenu(e2) {
    const target = e2.target;
    if (e2.shiftKey || target.closest("input, textarea, select, [contenteditable]")) {
      return;
    }
    e2.preventDefault();
    ed.focus = "canvas";
    at = { x: e2.clientX, y: e2.clientY };
    const hit = pick(e2.clientX, e2.clientY);
    if (hit) {
      if (!ed.selection.some((s2) => s2.el === hit)) select([hit]);
    } else {
      clearSelection();
    }
    clear(menu5);
    menu5.append(...hit ? objectMenu() : slideMenu());
    showMenu(e2.clientX, e2.clientY);
  }
  function initCanvasMenu() {
    document.getElementById("canvas")?.addEventListener("contextmenu", onContextMenu);
  }

  // src/ts/editor/context.ts
  var timer4 = 0;
  function snapshot2() {
    const slide = currentSlide();
    const visible = ed.model?.slides.filter((s2) => s2.visible).length ?? 0;
    return {
      deck: ed.model?.deckPath,
      slide: slide && {
        number: (slide.visibleIndex ?? -1) + 1 || null,
        total: visible,
        deckIndex: slide.deckIndex,
        id: slide.id ?? slide.explicitId,
        title: slide.title,
        svg: slide.srcRel,
        sharedLayout: slide.srcShared,
        md: slide.md?.rel ?? (slide.md ? "inline in deck.py" : null),
        notes: slide.notes.rel
      },
      step: ed.step,
      layoutMode: ed.layoutMode,
      selection: ed.selection.map((s2) => {
        const box2 = slideBox(s2.el);
        const text = (s2.el.textContent ?? "").replace(/\s+/g, " ").trim();
        return {
          id: s2.el.getAttribute("id"),
          tag: s2.el.localName,
          zone: isZone(s2.el) ? zoneName(s2.el) : null,
          file: sourceOf(s2.key)?.rel,
          locator: s2.loc,
          box: box2 && {
            x: Math.round(box2.x),
            y: Math.round(box2.y),
            width: Math.round(box2.width),
            height: Math.round(box2.height)
          },
          text: text.slice(0, 200) || null
        };
      })
    };
  }
  function report() {
    window.clearTimeout(timer4);
    timer4 = window.setTimeout(() => {
      sendRaw({ type: "editor-context", context: snapshot2() });
    }, 250);
  }
  function initContext() {
    on("selection", report);
    on("slide", report);
    on("model", report);
    on("step", report);
    onCommand((msg) => {
      if (msg.command === "goto") {
        const n3 = Number(msg.slide);
        const slides = ed.model?.slides ?? [];
        const target = slides.find((s2) => s2.visibleIndex === n3 - 1);
        if (target) gotoSlide(target.deckIndex);
      } else if (msg.command === "select") {
        const ids = msg.ids ?? [];
        const svg = slideRoot();
        if (!svg) return;
        const els = ids.map((id) => svg.querySelector(`[id="${CSS.escape(id)}"]`)).filter(
          (el2) => el2 instanceof SVGGraphicsElement
        );
        enterGroup(null);
        select(els);
        emit("flash");
      }
    });
  }

  // src/ts/editor/decks.ts
  var menu6 = document.getElementById("context-menu");
  var button7 = document.getElementById("btn-deck");
  function lookThumb(look) {
    const c2 = look.preview;
    if (!c2) return null;
    const bar = (cls, colour) => {
      const el2 = h("span", { class: cls });
      el2.style.background = colour;
      return el2;
    };
    const thumb3 = h(
      "span",
      { class: `look-thumb${look.id === "poster" ? " portrait" : ""}` },
      bar("look-thumb-title", c2.heading),
      bar("look-thumb-line", c2.muted),
      bar("look-thumb-line short", c2.muted),
      bar("look-thumb-card", c2.surface),
      bar("look-thumb-accent", c2.accent)
    );
    thumb3.style.background = c2.bg;
    thumb3.style.borderColor = c2.surface;
    return thumb3;
  }
  function baseName2(path) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  }
  function join(dir, name2) {
    return `${dir.replace(/[\\/]+$/, "")}/${name2}`;
  }
  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "my-deck";
  }
  function renderButton2() {
    const dir = ed.model?.projectDir;
    button7.textContent = `${dir ? baseName2(dir) : "deck"} \u25BE`;
    button7.title = dir ? `${dir}
Decks: new, open, recent` : "Decks";
  }
  async function info2() {
    const res = await request({ action: "project-info" });
    if (!res.ok) {
      toast(res.error ?? "Cannot read the deck's folder", "error");
      return null;
    }
    return res;
  }
  async function openMenu3() {
    const data = await info2();
    if (!data) return;
    clear(menu6);
    menu6.append(
      menuItem("New deck\u2026", () => newDeckDialog(data)),
      menuItem("Open deck\u2026", () => openDeckDialog(data))
    );
    if (data.recent.length) {
      menu6.append(h("div", { class: "menu-title" }, "Recent decks"));
      for (const path of data.recent) {
        const dir = path.replace(/[\\/]deck\.py$/, "");
        const item2 = menuItem(baseName2(dir), () => void openDeck(path));
        item2.title = `${dir}
Ctrl+click: open in a new tab`;
        item2.addEventListener(
          "click",
          (e2) => {
            if (!(e2.ctrlKey || e2.metaKey)) return;
            e2.stopImmediatePropagation();
            closeMenu();
            void openDeckInTab(path);
          },
          { capture: true }
        );
        item2.addEventListener("auxclick", (e2) => {
          if (e2.button !== 1) return;
          e2.preventDefault();
          closeMenu();
          void openDeckInTab(path);
        });
        const tab = h(
          "button",
          {
            type: "button",
            class: "menu-side",
            title: "Open in a new tab (with a server of its own; this deck stays open here)",
            onclick: () => {
              closeMenu();
              void openDeckInTab(path);
            }
          },
          "\u29C9"
        );
        menu6.append(h("div", { class: "menu-row" }, item2, tab));
      }
    }
    if (ed.model) {
      menu6.append(
        h("div", { class: "menu-sep" }),
        menuItem("Files\u2026", () => void openFiles())
      );
    }
    menu6.append(
      h("div", { class: "menu-sep" }),
      menuItem("Quit Inkflow", () => void quit())
    );
    const r2 = button7.getBoundingClientRect();
    showMenu(r2.left, r2.bottom + 4);
  }
  async function openDeckInTab(path) {
    const tab = window.open("", "_blank");
    if (tab) {
      tab.document.title = "Opening deck\u2026";
      tab.document.body.textContent = `Starting inkflow for ${baseName2(path.replace(/[\\/]deck\.py$/, ""))}\u2026`;
    }
    toast("Opening the deck in a new tab\u2026");
    const res = await request({ action: "open-deck-tab", path });
    if (!res.ok || typeof res.url !== "string") {
      tab?.close();
      toast(res.error ?? "Cannot open that deck", "error");
      return false;
    }
    closeDialog();
    const url = new URL(res.url, location.href).href;
    if (tab && !tab.closed) {
      tab.opener = null;
      tab.location.href = url;
    } else if (!window.open(url, "_blank", "noopener")) {
      toast(`Open it at ${url}`, "error");
    }
    return true;
  }
  async function deckCommands() {
    const data = await info2();
    if (!data) return [];
    const group2 = "Deck";
    const out = [
      { label: "New deck\u2026", group: group2, run: () => newDeckDialog(data) },
      { label: "Open deck\u2026", group: group2, run: () => openDeckDialog(data) }
    ];
    for (const path of data.recent) {
      const name2 = baseName2(path.replace(/[\\/]deck\.py$/, ""));
      out.push(
        {
          label: `Open ${name2}`,
          group: group2,
          hint: path,
          run: () => void openDeck(path)
        },
        {
          label: `Open ${name2} in a new tab`,
          group: group2,
          hint: path,
          run: () => void openDeckInTab(path)
        }
      );
    }
    if (ed.model)
      out.push({ label: "Files\u2026", group: group2, run: () => void openFiles() });
    out.push({ label: "Quit Inkflow", group: group2, run: () => void quit() });
    return out;
  }
  async function openDeck(path) {
    const res = await request({ action: "open-deck", path });
    if (!res.ok) {
      toast(res.error ?? "Cannot open that deck", "error");
      return false;
    }
    closeDialog();
    if (res.redirect) {
      toast("That deck is already open: switching to it\u2026");
      location.assign(String(res.redirect));
      return true;
    }
    if (!res.opening) {
      toast("That deck is the one open here");
      return true;
    }
    toast(
      `Opening ${baseName2(String(res.deck ?? path).replace(/[\\/]deck\.py$/, ""))}\u2026`
    );
    return true;
  }
  function newDeckDialog(data) {
    const title3 = h("input", {
      type: "text",
      value: "My presentation"
    });
    const name2 = h("input", {
      type: "text",
      value: data.name
    });
    let nameEdited = false;
    name2.addEventListener("input", () => {
      nameEdited = true;
      update();
    });
    let titleEdited = false;
    title3.addEventListener("input", () => {
      titleEdited = true;
      if (!nameEdited) name2.value = slug(title3.value);
      update();
    });
    let look = data.themes.some((t2) => t2.id === "current") ? "current" : "starter";
    const size4 = h(
      "select",
      {},
      ...(data.posterSizes ?? []).map(
        (s2) => h("option", { value: s2.id }, s2.label)
      )
    );
    const sizeRow = h(
      "label",
      { class: "field inline poster-size" },
      h("span", { class: "field-label" }, "Paper size"),
      size4
    );
    sizeRow.hidden = true;
    const looks = h(
      "div",
      { class: "look-list" },
      ...data.themes.map((t2) => {
        const radio = h("input", {
          type: "radio",
          name: "deck-look",
          value: t2.id
        });
        radio.checked = t2.id === look;
        radio.addEventListener("change", () => {
          look = t2.id;
          sizeRow.hidden = look !== "poster";
          if (look === "poster" && !titleEdited) {
            title3.value = "My poster";
            if (!nameEdited) name2.value = slug(title3.value);
            update();
          }
        });
        return h(
          "label",
          { class: "look" },
          radio,
          lookThumb(t2),
          h(
            "span",
            { class: "look-text" },
            h("strong", {}, t2.label),
            h("span", { class: "hint" }, t2.description)
          )
        );
      })
    );
    const git2 = h("input", { type: "checkbox" });
    git2.checked = true;
    git2.addEventListener("change", () => update());
    const gitRow = h(
      "label",
      { class: "check-row" },
      git2,
      "Create a git repository for this deck"
    );
    const gitNote = h("p", { class: "hint" });
    const lfs = h("input", { type: "checkbox" });
    lfs.checked = data.lfs;
    const lfsRow = h(
      "label",
      { class: "check-row" },
      lfs,
      "Store videos, images and fonts with Git LFS"
    );
    const lfsNote = h(
      "p",
      { class: "hint" },
      data.lfs ? "Untick for git only: media is kept in git itself, fine for a small repository." : "git-lfs is not installed, so this deck uses git only (its .gitattributes says so; install git-lfs to switch later)."
    );
    const full = h("p", { class: "hint full-path" });
    const picker = folderPicker(data.parent, () => update());
    function update() {
      const folder = picker.current();
      const parent = folder?.path ?? data.parent;
      full.textContent = `New deck: ${join(parent, name2.value || "\u2026")}`;
      const inRepo = !!folder?.repo;
      gitRow.hidden = inRepo || !data.git;
      lfsRow.hidden = !data.git || !inRepo && !git2.checked;
      lfsNote.hidden = lfsRow.hidden;
      gitNote.textContent = inRepo ? `It becomes a new folder of the git repository at ${folder?.repo}, versioned with it.` : data.git ? "" : "git is not installed, so the deck gets no repository.";
    }
    const create = h(
      "button",
      { type: "button", class: "pbtn primary" },
      "Create and open"
    );
    create.addEventListener("click", async () => {
      const folder = picker.current();
      if (!folder || !name2.value.trim()) {
        toast("Choose a folder and a name for the deck", "error");
        return;
      }
      create.disabled = true;
      create.textContent = "Creating\u2026";
      const res = await request({
        action: "new-deck",
        path: join(folder.path, name2.value.trim()),
        title: title3.value,
        theme: look,
        size: look === "poster" ? size4.value : null,
        git: !folder.repo && git2.checked,
        lfs: lfs.checked
      });
      create.disabled = false;
      create.textContent = "Create and open";
      if (!res.ok) {
        toast(res.error ?? "Could not create the deck", "error");
        return;
      }
      closeDialog();
      toast(`Created ${name2.value.trim()}; opening it\u2026`, "ok");
    });
    openDialog(
      "New deck",
      h(
        "div",
        { class: "deck-form" },
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Title"),
          title3
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Look"),
          h("div", {}, looks, sizeRow)
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Where"),
          h(
            "div",
            {},
            picker.el,
            h(
              "label",
              { class: "field inline" },
              h("span", { class: "field-label" }, "Folder name"),
              name2
            ),
            full,
            gitRow,
            gitNote,
            lfsRow,
            lfsNote
          )
        ),
        h("div", { class: "btn-row end" }, create)
      ),
      { large: true }
    );
    update();
    title3.select();
  }
  function openDeckDialog(data) {
    const open5 = h(
      "button",
      { type: "button", class: "pbtn primary", disabled: true },
      "Open this deck"
    );
    const inTab = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        disabled: true,
        title: "With a server of its own; this deck stays open here"
      },
      "Open in a new tab"
    );
    const picker = folderPicker(
      data.places?.default ?? data.current.replace(/[\\/][^\\/]*$/, ""),
      (f2) => {
        open5.disabled = !f2.isDeck;
        inTab.disabled = !f2.isDeck || !ed.model;
        open5.textContent = f2.isDeck ? `Open ${baseName2(f2.path)}` : "No deck.py in this folder";
      }
    );
    open5.addEventListener("click", () => {
      const f2 = picker.current();
      if (f2?.isDeck) void openDeck(join(f2.path, "deck.py"));
    });
    inTab.addEventListener("click", () => {
      const f2 = picker.current();
      if (f2?.isDeck) void openDeckInTab(join(f2.path, "deck.py"));
    });
    openDialog(
      "Open deck",
      h(
        "div",
        { class: "deck-form" },
        h("p", { class: "hint" }, "Go to a folder with a deck.py in it."),
        picker.el,
        h("div", { class: "btn-row end" }, inTab, open5)
      ),
      { large: true }
    );
    picker.focus();
  }
  async function quit() {
    const res = await request({ action: "quit" });
    if (!res.ok) {
      toast(res.error ?? "Cannot stop inkflow from here", "error");
      return;
    }
    stopReconnecting();
    document.getElementById("start")?.remove();
    document.body.classList.add("start-mode");
    document.body.append(
      h(
        "div",
        { id: "start", class: "start" },
        h(
          "div",
          { class: "start-card" },
          h("div", { class: "start-logo" }, "ink", h("b", {}, "flow")),
          h(
            "p",
            { class: "start-lead" },
            "Inkflow has stopped. Everything was saved as you went; you can close this tab."
          )
        )
      )
    );
  }
  async function showStart() {
    document.body.classList.add("start-mode");
    await whenConnected();
    const data = await info2();
    const recent = h("div", { class: "start-recent" });
    if (data?.recent.length) {
      recent.append(h("h2", {}, "Recent decks"));
      for (const path of data.recent) {
        const dir = path.replace(/[\\/]deck\.py$/, "");
        recent.append(
          h(
            "button",
            {
              type: "button",
              class: "start-deck",
              title: dir,
              onclick: () => void openDeck(path)
            },
            h("span", { class: "start-deck-name" }, baseName2(dir)),
            h("span", { class: "start-deck-path" }, dir)
          )
        );
      }
    }
    const action = (label4, hint, fn) => h(
      "button",
      { type: "button", class: "start-action", onclick: fn },
      h("span", { class: "start-action-label" }, label4),
      h("span", { class: "start-action-hint" }, hint)
    );
    const page = h(
      "div",
      { id: "start", class: "start" },
      h(
        "div",
        { class: "start-card" },
        h("div", { class: "start-logo" }, "ink", h("b", {}, "flow")),
        h(
          "p",
          { class: "start-lead" },
          "Slides you draw, write and version."
        ),
        h(
          "div",
          { class: "start-actions" },
          // Asked afresh each time: a default location saved in the
          // picker since counts.
          action(
            "New deck\u2026",
            "Start from one of seven looks",
            async () => {
              const fresh = await info2();
              if (fresh) newDeckDialog(fresh);
            }
          ),
          action("Open deck\u2026", "A folder with a deck.py", async () => {
            const fresh = await info2();
            if (fresh) openDeckDialog(fresh);
          })
        ),
        recent,
        h(
          "button",
          {
            type: "button",
            class: "start-quit",
            onclick: () => void quit()
          },
          "Quit Inkflow"
        )
      )
    );
    document.body.append(page);
  }
  function initDecks() {
    button7.addEventListener("click", () => void openMenu3());
    on("model", renderButton2);
    renderButton2();
  }

  // src/ts/editor/exportdlg.ts
  var FORMATS = [
    {
      format: "single",
      title: "HTML file",
      text: "One file with everything inside: slides, pictures, videos and fonts. Opens offline in any browser, looks the same everywhere, easy to email or share.",
      placeholder: (stem) => `${stem}.html`
    },
    {
      format: "html",
      title: "Web page with an assets folder",
      text: "index.html with the pictures and videos as files beside it, for a large deck on a web host: the first slide shows at once and each video loads when needed.",
      placeholder: () => "build"
    },
    {
      format: "pdf",
      title: "PDF",
      text: "One page per slide, every build step shown. Needs Chromium or Chrome on this computer.",
      placeholder: (stem) => `${stem}.pdf`
    },
    {
      format: "handout",
      title: "Handout (PDF)",
      text: "Each slide with its speaker notes, to read or hand out: one per page with the notes below, or three per page with the notes beside.",
      placeholder: (stem) => `${stem}-handout.pdf`
    }
  ];
  function handoutOptions() {
    const layout2 = h(
      "select",
      {},
      h("option", { value: "notes" }, "One slide per page, notes below"),
      h("option", { value: "compact" }, "Three per page, notes beside")
    );
    const paper2 = h(
      "select",
      {},
      h("option", { value: "a4" }, "A4"),
      h("option", { value: "letter" }, "Letter")
    );
    const line = h(
      "div",
      { class: "export-print" },
      layout2,
      " ",
      paper2,
      " ",
      h(
        "a",
        {
          href: "/handout",
          target: "_blank",
          rel: "noopener",
          class: "link-btn",
          title: "The handout in a tab of its own, to read or print from the browser"
        },
        "Open the handout view"
      )
    );
    return { line, layout: layout2, paper: paper2 };
  }
  function size3(bytes) {
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }
  function printOptions() {
    const deck = ed.model?.deckSize;
    if (!deck?.print) return null;
    const marks = h("input", { type: "checkbox" });
    const line = h(
      "div",
      { class: "export-print" },
      h("p", { class: "hint" }, `Page: ${deck.label}, at its final size.`),
      h(
        "label",
        {
          title: "For a print shop that asks for bleed: the background runs 3 mm past each edge, and the corners are marked where to cut"
        },
        marks,
        " 3 mm bleed and crop marks"
      )
    );
    return { line, marks };
  }
  function option(f2, stem) {
    const print = f2.format === "pdf" ? printOptions() : null;
    const handout = f2.format === "handout" ? handoutOptions() : null;
    const output = h("input", {
      type: "text",
      placeholder: f2.placeholder(stem),
      spellcheck: "false",
      title: "Where to save it, relative to deck.py"
    });
    const status3 = h("div", { class: "export-status" });
    const go = h("button", { type: "button", class: "pbtn primary" }, "Export");
    go.addEventListener("click", async () => {
      go.disabled = true;
      status3.textContent = f2.format === "pdf" || f2.format === "handout" ? "Rendering pages\u2026" : "Building\u2026";
      status3.className = "export-status busy";
      const result = await request({
        action: "export",
        format: f2.format,
        output: output.value.trim() || null,
        printMarks: print?.marks.checked ?? false,
        layout: handout?.layout.value,
        paper: handout?.paper.value
      });
      go.disabled = false;
      if (!result.ok) {
        status3.className = "export-status error";
        status3.textContent = result.error ?? "export failed";
        return;
      }
      const r2 = result;
      status3.className = "export-status done";
      status3.replaceChildren(
        h("span", {}, `Saved to ${r2.rel} \xB7 ${size3(r2.size)}`),
        h(
          "a",
          { href: r2.download, class: "pbtn", download: "" },
          f2.format === "html" ? "Download .zip" : "Download"
        )
      );
    });
    return h(
      "div",
      { class: "export-option" },
      h(
        "div",
        { class: "export-text" },
        h("strong", {}, f2.title),
        h("p", { class: "hint" }, f2.text),
        print?.line ?? null,
        handout?.line ?? null
      ),
      h("div", { class: "export-row" }, output, go),
      status3
    );
  }
  function openExport() {
    const stem = ed.model?.deckPath.split(/[\\/]/).pop()?.replace(/\.py$/, "") ?? "deck";
    openDialog(
      "Export",
      h(
        "div",
        { class: "export-body" },
        ...FORMATS.map((f2) => option(f2, stem))
      ),
      { hint: "Saved next to deck.py; the paths can be changed" }
    );
  }
  function initExport() {
    document.getElementById("btn-export")?.addEventListener("click", openExport);
  }

  // node_modules/.pnpm/perfect-freehand@1.2.3/node_modules/perfect-freehand/dist/esm/index.mjs
  var { PI: e } = Math;
  var t = e + 1e-4;
  var n2 = 0.5;
  var r = [1, 1];
  function i(e2, t2, n3, r2 = (e3) => e3) {
    return e2 * r2(0.5 - t2 * (0.5 - n3));
  }
  var { min: a } = Math;
  function o(e2, t2, n3) {
    let r2 = a(1, t2 / n3);
    return a(1, e2 + (a(1, 1 - r2) - e2) * (r2 * 0.275));
  }
  function s(e2) {
    return [-e2[0], -e2[1]];
  }
  function c(e2, t2) {
    return [e2[0] + t2[0], e2[1] + t2[1]];
  }
  function l(e2, t2, n3) {
    return e2[0] = t2[0] + n3[0], e2[1] = t2[1] + n3[1], e2;
  }
  function u(e2, t2) {
    return [e2[0] - t2[0], e2[1] - t2[1]];
  }
  function d(e2, t2, n3) {
    return e2[0] = t2[0] - n3[0], e2[1] = t2[1] - n3[1], e2;
  }
  function f(e2, t2) {
    return [e2[0] * t2, e2[1] * t2];
  }
  function p(e2, t2, n3) {
    return e2[0] = t2[0] * n3, e2[1] = t2[1] * n3, e2;
  }
  function m(e2, t2) {
    return [e2[0] / t2, e2[1] / t2];
  }
  function h2(e2) {
    return [e2[1], -e2[0]];
  }
  function g(e2, t2) {
    let n3 = t2[0];
    return e2[0] = t2[1], e2[1] = -n3, e2;
  }
  function ee(e2, t2) {
    return e2[0] * t2[0] + e2[1] * t2[1];
  }
  function _(e2, t2) {
    return e2[0] === t2[0] && e2[1] === t2[1];
  }
  function v(e2) {
    return Math.hypot(e2[0], e2[1]);
  }
  function y(e2, t2) {
    let n3 = e2[0] - t2[0], r2 = e2[1] - t2[1];
    return n3 * n3 + r2 * r2;
  }
  function b(e2) {
    return m(e2, v(e2));
  }
  function x(e2, t2) {
    return Math.hypot(e2[1] - t2[1], e2[0] - t2[0]);
  }
  function S(e2, t2, n3) {
    let r2 = Math.sin(n3), i2 = Math.cos(n3), a2 = e2[0] - t2[0], o2 = e2[1] - t2[1], s2 = a2 * i2 - o2 * r2, c2 = a2 * r2 + o2 * i2;
    return [s2 + t2[0], c2 + t2[1]];
  }
  function C(e2, t2, n3, r2) {
    let i2 = Math.sin(r2), a2 = Math.cos(r2), o2 = t2[0] - n3[0], s2 = t2[1] - n3[1], c2 = o2 * a2 - s2 * i2, l2 = o2 * i2 + s2 * a2;
    return e2[0] = c2 + n3[0], e2[1] = l2 + n3[1], e2;
  }
  function w(e2, t2, n3) {
    return c(e2, f(u(t2, e2), n3));
  }
  function te(e2, t2, n3, r2) {
    let i2 = n3[0] - t2[0], a2 = n3[1] - t2[1];
    return e2[0] = t2[0] + i2 * r2, e2[1] = t2[1] + a2 * r2, e2;
  }
  function T(e2, t2, n3) {
    return c(e2, f(t2, n3));
  }
  var E = [0, 0];
  var D = [0, 0];
  var O = [0, 0];
  function k(e2, n3) {
    let r2 = T(e2, b(h2(u(e2, c(e2, [1, 1])))), -n3), i2 = [], a2 = 1 / 13;
    for (let n4 = a2; n4 <= 1; n4 += a2) i2.push(S(r2, e2, t * 2 * n4));
    return i2;
  }
  function A(e2, n3, r2) {
    let i2 = [], a2 = 1 / r2;
    for (let r3 = a2; r3 <= 1; r3 += a2) i2.push(S(n3, e2, t * r3));
    return i2;
  }
  function j(e2, t2, n3) {
    let r2 = u(t2, n3), i2 = f(r2, 0.5), a2 = f(r2, 0.51);
    return [u(e2, i2), u(e2, a2), c(e2, a2), c(e2, i2)];
  }
  function M(e2, n3, r2, i2) {
    let a2 = [], o2 = T(e2, n3, r2), s2 = 1 / i2;
    for (let n4 = s2; n4 < 1; n4 += s2) a2.push(S(o2, e2, t * 3 * n4));
    return a2;
  }
  function ne(e2, t2, n3) {
    return [c(e2, f(t2, n3)), c(e2, f(t2, n3 * 0.99)), u(e2, f(t2, n3 * 0.99)), u(e2, f(t2, n3))];
  }
  function N(e2, t2, n3) {
    return e2 === false || e2 === void 0 ? 0 : e2 === true ? Math.max(t2, n3) : e2;
  }
  function re(e2, t2, n3) {
    return e2.slice(0, 10).reduce((e3, r2) => {
      let i2 = r2.pressure;
      return t2 && (i2 = o(e3, r2.distance, n3)), (e3 + i2) / 2;
    }, e2[0].pressure);
  }
  function P(e2, n3 = {}) {
    let { size: r2 = 16, smoothing: a2 = 0.5, thinning: f2 = 0.5, simulatePressure: m2 = true, easing: _2 = (e3) => e3, start: v2 = {}, end: b2 = {}, last: x2 = false } = n3, { cap: S2 = true, easing: w2 = (e3) => e3 * (2 - e3) } = v2, { cap: T2 = true, easing: P2 = (e3) => --e3 * e3 * e3 + 1 } = b2;
    if (e2.length === 0 || r2 <= 0) return [];
    let F2 = e2[e2.length - 1].runningLength, I2 = N(v2.taper, r2, F2), L2 = N(b2.taper, r2, F2), R2 = (r2 * a2) ** 2, z = [], B = [], V = re(e2, m2, r2), H = i(r2, f2, e2[e2.length - 1].pressure, _2), U, W = e2[0].vector, G = e2[0].point, K = G, q = G, J = K, Y = false;
    for (let n4 = 0; n4 < e2.length; n4++) {
      let { pressure: a3 } = e2[n4], { point: s2, vector: h3, distance: v3, runningLength: b3 } = e2[n4], x3 = n4 === e2.length - 1;
      if (!x3 && F2 - b3 < 3) continue;
      f2 ? (m2 && (a3 = o(V, v3, r2)), H = i(r2, f2, a3, _2)) : H = r2 / 2, U === void 0 && (U = H);
      let S3 = b3 < I2 ? w2(b3 / I2) : 1, T3 = F2 - b3 < L2 ? P2((F2 - b3) / L2) : 1;
      H = Math.max(0.01, H * Math.min(S3, T3));
      let k2 = (x3 ? e2[n4] : e2[n4 + 1]).vector, A2 = x3 ? 1 : ee(h3, k2), j2 = ee(h3, W) < 0 && !Y, M2 = A2 !== null && A2 < 0;
      if (j2 || M2) {
        g(E, W), p(E, E, H);
        for (let e3 = 0; e3 <= 1; e3 += 0.07692307692307693) d(D, s2, E), C(D, D, s2, t * e3), q = [D[0], D[1]], z.push(q), l(O, s2, E), C(O, O, s2, t * -e3), J = [O[0], O[1]], B.push(J);
        G = q, K = J, M2 && (Y = true);
        continue;
      }
      if (Y = false, x3) {
        g(E, h3), p(E, E, H), z.push(u(s2, E)), B.push(c(s2, E));
        continue;
      }
      te(E, k2, h3, A2), g(E, E), p(E, E, H), d(D, s2, E), q = [D[0], D[1]], (n4 <= 1 || y(G, q) > R2) && (z.push(q), G = q), l(O, s2, E), J = [O[0], O[1]], (n4 <= 1 || y(K, J) > R2) && (B.push(J), K = J), V = a3, W = h3;
    }
    let X = [e2[0].point[0], e2[0].point[1]], Z = e2.length > 1 ? [e2[e2.length - 1].point[0], e2[e2.length - 1].point[1]] : c(e2[0].point, [1, 1]), Q = [], $2 = [];
    if (e2.length === 1) {
      if (!(I2 || L2) || x2) return k(X, U || H);
    } else {
      I2 || L2 && e2.length === 1 || (S2 ? Q.push(...A(X, B[0], 13)) : Q.push(...j(X, z[0], B[0])));
      let t2 = h2(s(e2[e2.length - 1].vector));
      L2 || I2 && e2.length === 1 ? $2.push(Z) : T2 ? $2.push(...M(Z, t2, H, 29)) : $2.push(...ne(Z, t2, H));
    }
    return z.concat($2, B.reverse(), Q);
  }
  var F = [0, 0];
  function I(e2) {
    return e2 != null && e2 >= 0;
  }
  function L(e2, t2 = {}) {
    let { streamline: i2 = 0.5, size: a2 = 16, last: o2 = false } = t2;
    if (e2.length === 0) return [];
    let s2 = 0.15 + (1 - i2) * 0.85, l2 = Array.isArray(e2[0]) ? e2 : e2.map(({ x: e3, y: t3, pressure: r2 = n2 }) => [e3, t3, r2]);
    if (l2.length === 2) {
      let e3 = l2[1];
      l2 = l2.slice(0, -1);
      for (let t3 = 1; t3 < 5; t3++) l2.push(w(l2[0], e3, t3 / 4));
    }
    l2.length === 1 && (l2 = [...l2, [...c(l2[0], r), ...l2[0].slice(2)]]);
    let u2 = [{ point: [l2[0][0], l2[0][1]], pressure: I(l2[0][2]) ? l2[0][2] : 0.25, vector: [...r], distance: 0, runningLength: 0 }], f2 = false, p2 = 0, m2 = u2[0], h3 = l2.length - 1;
    for (let e3 = 1; e3 < l2.length; e3++) {
      let t3 = o2 && e3 === h3 ? [l2[e3][0], l2[e3][1]] : w(m2.point, l2[e3], s2);
      if (_(m2.point, t3)) continue;
      let r2 = x(t3, m2.point);
      if (p2 += r2, e3 < h3 && !f2) {
        if (p2 < a2) continue;
        f2 = true;
      }
      d(F, m2.point, t3), m2 = { point: t3, pressure: I(l2[e3][2]) ? l2[e3][2] : n2, vector: b(F), distance: r2, runningLength: p2 }, u2.push(m2);
    }
    return u2[0].vector = u2[1]?.vector || [0, 0], u2;
  }
  function R(e2, t2 = {}) {
    return P(L(e2, t2), t2);
  }

  // src/ts/shared/ink.ts
  var HIGHLIGHTER_OPACITY = 0.35;
  var REFERENCE_WIDTH = 1920;
  var REFERENCE_HEIGHT = 1080;
  function inkScale(width, height2 = 0) {
    const w2 = width > 0 ? width / REFERENCE_WIDTH : 0;
    const h3 = height2 > 0 ? height2 / REFERENCE_HEIGHT : 0;
    return Math.max(w2, h3) || 1;
  }
  var PEN_SIZES = [3, 6, 12];
  var HIGHLIGHTER_SIZES = [20, 36, 60];
  var SWATCHES = [
    { label: "Black", token: null, hex: "#000000" },
    { label: "White", token: null, hex: "#ffffff" },
    { label: "Red", token: "red", hex: "#e64553" },
    { label: "Orange", token: "orange", hex: "#fe640b" },
    { label: "Yellow", token: "yellow", hex: "#df8e1d" },
    { label: "Green", token: "green", hex: "#40a02b" },
    { label: "Blue", token: "blue", hex: "#1e66f5" },
    { label: "Purple", token: "purple", hex: "#8839ef" }
  ];
  var easeOutSine = (t2) => Math.sin(t2 * Math.PI / 2);
  function strokeOptions(style, simulate, last) {
    if (style.tool === "highlighter") {
      return {
        size: style.size,
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.4,
        simulatePressure: false,
        start: { cap: false },
        end: { cap: false },
        last
      };
    }
    return {
      size: style.size,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: simulate ? 0.5 : 0.35,
      easing: easeOutSine,
      simulatePressure: simulate,
      last
    };
  }
  function outlineOf2(points, style, simulate, last) {
    return R(points, strokeOptions(style, simulate, last));
  }
  function round(v2, decimals) {
    const f2 = 10 ** decimals;
    const r2 = Math.round(v2 * f2) / f2;
    return String(Object.is(r2, -0) ? 0 : r2);
  }
  function pathData2(outline, decimals = 1) {
    const n3 = outline.length;
    if (n3 < 2) return "";
    const mid = (a2, b2) => [
      (a2[0] + b2[0]) / 2,
      (a2[1] + b2[1]) / 2
    ];
    const pt = (p2) => `${round(p2[0], decimals)} ${round(p2[1], decimals)}`;
    const parts = [`M${pt(mid(outline[n3 - 1], outline[0]))}Q`];
    for (let i2 = 0; i2 < n3; i2++) {
      const next = outline[(i2 + 1) % n3];
      parts.push(`${pt(outline[i2])} ${pt(mid(outline[i2], next))}`);
    }
    return `${parts[0]}${parts.slice(1).join(" ")}Z`;
  }
  function simplify2(outline, tolerance) {
    if (outline.length < 4 || tolerance <= 0) return outline;
    const keep = new Uint8Array(outline.length);
    keep[0] = 1;
    keep[outline.length - 1] = 1;
    const t2 = tolerance * tolerance;
    const stack = [[0, outline.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      const [ax, ay] = outline[first];
      const [bx, by] = outline[last];
      let worst2 = -1;
      let index = -1;
      for (let i2 = first + 1; i2 < last; i2++) {
        const d2 = pointSegment2(
          outline[i2][0],
          outline[i2][1],
          ax,
          ay,
          bx,
          by
        );
        if (d2 > worst2) {
          worst2 = d2;
          index = i2;
        }
      }
      if (worst2 > t2) {
        keep[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }
    return outline.filter((_2, i2) => keep[i2]);
  }
  function polygonOf(d2) {
    const nums = d2.match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? [];
    const out = [];
    for (let i2 = 0; i2 + 1 < nums.length; i2 += 2) {
      out.push(Number(nums[i2]), Number(nums[i2 + 1]));
    }
    return out;
  }
  function bboxOf(poly2) {
    const box2 = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
    for (let i2 = 0; i2 + 1 < poly2.length; i2 += 2) {
      box2.minX = Math.min(box2.minX, poly2[i2]);
      box2.maxX = Math.max(box2.maxX, poly2[i2]);
      box2.minY = Math.min(box2.minY, poly2[i2 + 1]);
      box2.maxY = Math.max(box2.maxY, poly2[i2 + 1]);
    }
    return box2;
  }
  function insidePolygon(poly2, x2, y2) {
    let winding = 0;
    const n3 = poly2.length / 2;
    for (let i2 = 0; i2 < n3; i2++) {
      const x1 = poly2[2 * i2];
      const y1 = poly2[2 * i2 + 1];
      const x22 = poly2[(2 * i2 + 2) % poly2.length];
      const y22 = poly2[(2 * i2 + 3) % poly2.length];
      const cross = (x22 - x1) * (y2 - y1) - (x2 - x1) * (y22 - y1);
      if (y1 <= y2) {
        if (y22 > y2 && cross > 0) winding++;
      } else if (y22 <= y2 && cross < 0) {
        winding--;
      }
    }
    return winding !== 0;
  }
  function pointSegment2(px2, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t2 = len2 === 0 ? 0 : Math.max(
      0,
      Math.min(1, ((px2 - ax) * dx + (py - ay) * dy) / len2)
    );
    const ex = ax + t2 * dx - px2;
    const ey = ay + t2 * dy - py;
    return ex * ex + ey * ey;
  }
  function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }
  function eraserHits(poly2, box2, a2, b2, r2) {
    if (Math.max(a2.x, b2.x) + r2 < box2.minX || Math.min(a2.x, b2.x) - r2 > box2.maxX || Math.max(a2.y, b2.y) + r2 < box2.minY || Math.min(a2.y, b2.y) - r2 > box2.maxY) {
      return false;
    }
    if (insidePolygon(poly2, a2.x, a2.y) || insidePolygon(poly2, b2.x, b2.y)) {
      return true;
    }
    const r22 = r2 * r2;
    const n3 = poly2.length / 2;
    for (let i2 = 0; i2 < n3; i2++) {
      const cx = poly2[2 * i2];
      const cy = poly2[2 * i2 + 1];
      const dx = poly2[(2 * i2 + 2) % poly2.length];
      const dy = poly2[(2 * i2 + 3) % poly2.length];
      if (segmentsCross(a2.x, a2.y, b2.x, b2.y, cx, cy, dx, dy) || pointSegment2(cx, cy, a2.x, a2.y, b2.x, b2.y) <= r22 || pointSegment2(a2.x, a2.y, cx, cy, dx, dy) <= r22 || pointSegment2(b2.x, b2.y, cx, cy, dx, dy) <= r22) {
        return true;
      }
    }
    return false;
  }
  function newInkId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return `ink-${Array.from(bytes, (b2) => b2.toString(36).padStart(2, "0")).join("")}`;
  }
  function finish(live, points, tolerance = 0.1) {
    const outline = outlineOf2(points, live, live.simulate, true);
    const stroke = {
      id: live.id,
      tool: live.tool,
      fill: live.fill,
      token: live.token,
      size: live.size,
      d: pathData2(simplify2(outline, tolerance), 1)
    };
    if (live.tool === "highlighter") stroke.opacity = HIGHLIGHTER_OPACITY;
    return stroke;
  }

  // src/ts/shared/inkpad.ts
  var SVG_NS3 = "http://www.w3.org/2000/svg";
  var ERASER_RADIUS_PX = 10;
  var PALM_MS = 1500;
  var SWALLOW_MS = 400;
  function paintStroke(el2, s2) {
    if (s2.id) el2.id = s2.id;
    if (s2.d !== void 0) el2.setAttribute("d", s2.d);
    el2.setAttribute("fill", s2.fill);
    const classes = [
      ...s2.token ? [`inkflow-fill-${s2.token}`] : [],
      ...s2.tool === "highlighter" ? ["inkflow-highlighter"] : []
    ];
    el2.setAttribute("class", classes.join(" "));
    const opacity = s2.opacity ?? (s2.tool === "highlighter" ? HIGHLIGHTER_OPACITY : void 0);
    if (opacity !== void 0 && opacity < 1)
      el2.setAttribute("fill-opacity", String(opacity));
    else el2.removeAttribute("fill-opacity");
    el2.setAttribute("inkflow:tool", s2.tool);
    el2.setAttribute("inkflow:size", String(Math.round(s2.size * 100) / 100));
    return el2;
  }
  function strokeElement(stroke) {
    return paintStroke(
      document.createElementNS(SVG_NS3, "path"),
      stroke
    );
  }
  var shapes = /* @__PURE__ */ new WeakMap();
  function shapeOf(el2) {
    const d2 = el2.getAttribute("d") ?? "";
    let shape = shapes.get(el2);
    if (!shape || shape.d !== d2) {
      const poly2 = polygonOf(d2);
      shape = { d: d2, poly: poly2, box: bboxOf(poly2) };
      shapes.set(el2, shape);
    }
    return shape;
  }
  var InkPad = class {
    host;
    gesture = null;
    frame = 0;
    lastPenAt = -Infinity;
    swallowUntil = -Infinity;
    swallowAt = { x: Number.NaN, y: Number.NaN };
    constructor(host5) {
      this.host = host5;
      const s2 = host5.surface;
      s2.addEventListener("pointerdown", (e2) => this.down(e2), {
        capture: true
      });
      s2.addEventListener("pointermove", (e2) => this.move(e2), {
        capture: true
      });
      s2.addEventListener("pointerup", (e2) => this.up(e2, false), {
        capture: true
      });
      s2.addEventListener("pointercancel", (e2) => this.up(e2, true), {
        capture: true
      });
      for (const type of ["touchstart", "touchmove", "touchend"]) {
        s2.addEventListener(type, (e2) => this.claimTouch(e2), {
          capture: true,
          passive: false
        });
      }
      window.addEventListener("click", (e2) => this.claimClick(e2), true);
      s2.addEventListener("contextmenu", (e2) => this.claimClick(e2), true);
    }
    // A stroke or an erase is in progress.
    get busy() {
      return this.gesture !== null;
    }
    // Drop the gesture in progress (the slide is going away).
    cancel() {
      const g2 = this.gesture;
      if (!g2) return;
      this.gesture = null;
      cancelAnimationFrame(this.frame);
      if (g2.kind === "draw") {
        g2.path.remove();
        this.host.onAbandon?.(g2.live);
      } else {
        for (const el2 of g2.hits.values())
          el2.style.removeProperty("display");
        g2.cursor.remove();
      }
    }
    claimTouch(e2) {
      if (this.gesture || performance.now() < this.swallowUntil) {
        e2.stopPropagation();
        if (e2.cancelable && e2.type !== "touchstart") e2.preventDefault();
      }
    }
    // Only the click the browser makes of a gesture's own press and release
    // (where the pointer let go, just after): a click elsewhere, such as on
    // the palette right after a stroke, is the user's.
    claimClick(e2) {
      const near = Math.hypot(
        e2.clientX - this.swallowAt.x,
        e2.clientY - this.swallowAt.y
      ) < 16;
      if (this.gesture || performance.now() < this.swallowUntil && near) {
        e2.stopPropagation();
        e2.preventDefault();
      }
    }
    swallow(e2) {
      e2.preventDefault();
      e2.stopPropagation();
      this.swallowUntil = performance.now() + SWALLOW_MS;
      this.swallowAt = { x: e2.clientX, y: e2.clientY };
    }
    down(e2) {
      if (e2.pointerType === "pen") this.lastPenAt = performance.now();
      if (this.gesture) {
        if (e2.pointerId !== this.gesture.pointerId) this.swallow(e2);
        return;
      }
      if (!this.host.active() || this.host.allows?.(e2) === false) return;
      if (e2.pointerType !== "pen" && !this.host.fingers()) {
        if (e2.pointerType === "touch" && performance.now() - this.lastPenAt < PALM_MS) {
          this.swallow(e2);
        }
        return;
      }
      if (e2.button !== 0 && e2.button !== 5) return;
      const tool = e2.button === 5 ? "eraser" : this.host.tool();
      const svg = this.host.svg();
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return;
      this.swallow(e2);
      try {
        this.host.surface.setPointerCapture(e2.pointerId);
      } catch {
      }
      const inv = ctm.inverse();
      const unitsPerPx = Math.hypot(inv.a, inv.b);
      const at3 = new DOMPoint(e2.clientX, e2.clientY).matrixTransform(inv);
      if (tool === "eraser") {
        const cursor = document.createElementNS(
          SVG_NS3,
          "circle"
        );
        cursor.setAttribute("class", "inkflow-eraser-cursor");
        cursor.setAttribute("r", String(ERASER_RADIUS_PX * unitsPerPx));
        cursor.setAttribute("cx", String(at3.x));
        cursor.setAttribute("cy", String(at3.y));
        cursor.setAttribute("stroke-width", String(1.5 * unitsPerPx));
        svg.appendChild(cursor);
        this.gesture = {
          kind: "erase",
          pointerId: e2.pointerId,
          svg,
          inv,
          last: { x: e2.clientX, y: e2.clientY },
          hits: /* @__PURE__ */ new Map(),
          local: /* @__PURE__ */ new Map(),
          cursor
        };
        this.erase(e2.clientX, e2.clientY);
        return;
      }
      const pen = e2.pointerType === "pen";
      const style = this.host.style(tool, svg);
      const simulate = tool === "pen" && (!pen || e2.pressure === 0 || e2.pressure === 0.5);
      const live = { ...style, id: newInkId(), simulate };
      const path = paintStroke(
        document.createElementNS(SVG_NS3, "path"),
        live
      );
      path.classList.add("inkflow-live-stroke");
      svg.appendChild(path);
      this.gesture = {
        kind: "draw",
        pointerId: e2.pointerId,
        inv,
        minDist: 0.4 * unitsPerPx,
        live,
        points: [[at3.x, at3.y, simulate ? 0.5 : e2.pressure]],
        predicted: [],
        sent: 0,
        path
      };
      this.schedule();
    }
    move(e2) {
      if (e2.pointerType === "pen") this.lastPenAt = performance.now();
      const g2 = this.gesture;
      if (!g2 || e2.pointerId !== g2.pointerId) return;
      e2.preventDefault();
      e2.stopPropagation();
      const samples = e2.getCoalescedEvents?.() ?? [];
      const events = samples.length ? samples : [e2];
      if (g2.kind === "erase") {
        for (const s2 of events) this.erase(s2.clientX, s2.clientY);
        return;
      }
      for (const s2 of events) this.sample(g2, s2, g2.points);
      g2.predicted = [];
      for (const p2 of e2.getPredictedEvents?.() ?? []) {
        this.sample(g2, p2, g2.predicted);
      }
      this.schedule();
    }
    sample(g2, e2, into) {
      const p2 = new DOMPoint(e2.clientX, e2.clientY).matrixTransform(g2.inv);
      const prev = into[into.length - 1] ?? g2.points[g2.points.length - 1];
      if (prev && Math.hypot(p2.x - prev[0], p2.y - prev[1]) < g2.minDist)
        return;
      into.push([p2.x, p2.y, g2.live.simulate ? 0.5 : e2.pressure]);
    }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const g2 = this.gesture;
        if (g2?.kind !== "draw") return;
        const pts = g2.predicted.length ? g2.points.concat(g2.predicted) : g2.points;
        g2.path.setAttribute(
          "d",
          pathData2(outlineOf2(pts, g2.live, g2.live.simulate, false), 2)
        );
        if (g2.points.length > g2.sent) {
          this.host.onDraw?.(g2.live, g2.sent, g2.points.slice(g2.sent));
          g2.sent = g2.points.length;
        }
      });
    }
    erase(clientX, clientY) {
      const g2 = this.gesture;
      if (g2?.kind !== "erase") return;
      const at3 = new DOMPoint(clientX, clientY).matrixTransform(g2.inv);
      g2.cursor.setAttribute("cx", String(at3.x));
      g2.cursor.setAttribute("cy", String(at3.y));
      const a2 = new DOMPoint(g2.last.x, g2.last.y);
      const b2 = new DOMPoint(clientX, clientY);
      g2.last = { x: clientX, y: clientY };
      for (const el2 of this.host.erasables(g2.svg)) {
        if (g2.hits.has(el2.id) || el2.style.display === "none") continue;
        let local = g2.local.get(el2);
        if (!local) {
          const m2 = el2.getScreenCTM();
          if (!m2) continue;
          local = m2.inverse();
          g2.local.set(el2, local);
        }
        const shape = shapeOf(el2);
        const r2 = ERASER_RADIUS_PX * Math.hypot(local.a, local.b);
        if (eraserHits(
          shape.poly,
          shape.box,
          a2.matrixTransform(local),
          b2.matrixTransform(local),
          r2
        )) {
          el2.style.display = "none";
          g2.hits.set(el2.id, el2);
        }
      }
    }
    up(e2, cancelled) {
      const g2 = this.gesture;
      if (!g2 || e2.pointerId !== g2.pointerId) return;
      this.swallow(e2);
      if (cancelled) {
        this.cancel();
        return;
      }
      this.gesture = null;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (g2.kind === "erase") {
        g2.cursor.remove();
        if (g2.hits.size)
          this.host.onErase([...g2.hits.keys()], [...g2.hits.values()]);
        return;
      }
      const stroke = finish(g2.live, g2.points);
      g2.path.remove();
      if (stroke.d) this.host.onStroke(stroke, g2.live);
      else this.host.onAbandon?.(g2.live);
    }
  };

  // src/ts/shared/inksettings.ts
  function defaultSettings2(fingers) {
    return {
      tool: "pen",
      pen: { swatch: 2, custom: "#e64553", size: 1 },
      highlighter: { swatch: 4, custom: "#df8e1d", size: 1 },
      fingers,
      keep: false
    };
  }
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;
  function toolFrom(raw, fallback, sizes) {
    if (typeof raw !== "object" || raw === null) return { ...fallback };
    const r2 = raw;
    const swatch = r2.swatch === null ? null : Number.isInteger(r2.swatch) && r2.swatch >= 0 && r2.swatch < SWATCHES.length ? r2.swatch : fallback.swatch;
    return {
      swatch,
      custom: typeof r2.custom === "string" && HEX_RE.test(r2.custom) ? r2.custom : fallback.custom,
      size: Number.isInteger(r2.size) && r2.size >= 0 && r2.size < sizes ? r2.size : fallback.size
    };
  }
  function settingsFrom(raw, fallback) {
    if (typeof raw !== "object" || raw === null)
      return structuredClone(fallback);
    const r2 = raw;
    return {
      tool: r2.tool === "pen" || r2.tool === "highlighter" || r2.tool === "eraser" ? r2.tool : fallback.tool,
      pen: toolFrom(r2.pen, fallback.pen, PEN_SIZES.length),
      highlighter: toolFrom(
        r2.highlighter,
        fallback.highlighter,
        HIGHLIGHTER_SIZES.length
      ),
      fingers: typeof r2.fingers === "boolean" ? r2.fingers : fallback.fingers,
      keep: typeof r2.keep === "boolean" ? r2.keep : fallback.keep
    };
  }
  function sizesOf(tool) {
    return tool === "highlighter" ? HIGHLIGHTER_SIZES : PEN_SIZES;
  }
  function styleFor(s2, tool, width, tokenColor2, height2 = 0) {
    const t2 = s2[tool];
    const swatch = t2.swatch === null ? null : SWATCHES[t2.swatch];
    const fill = swatch ? swatch.token && tokenColor2(swatch.token) || swatch.hex : t2.custom;
    return {
      tool,
      fill: normalizeHex(fill) ?? "#000000",
      token: swatch?.token ?? null,
      size: sizesOf(tool)[t2.size] * inkScale(width, height2)
    };
  }
  function normalizeHex(color) {
    const c2 = color.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(c2)) return c2;
    if (/^#[0-9a-f]{3}$/.test(c2))
      return `#${[...c2.slice(1)].map((x2) => x2 + x2).join("")}`;
    const m2 = c2.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (m2) {
      return `#${m2.slice(1, 4).map((v2) => Math.min(255, Number(v2)).toString(16).padStart(2, "0")).join("")}`;
    }
    return null;
  }

  // src/ts/shared/inkpalette.ts
  var ICONS = {
    pen: '<path d="M3 13.5 4 10l7-7 2.5 2.5-7 7Z"/><path d="m9.5 4.5 2 2"/>',
    highlighter: '<path d="M5 11 3.5 14h4l.8-1.8"/><path d="m5 11 6.5-8.5 3 2.4L8.3 12.2Z"/>',
    eraser: '<path d="M6.5 14H14"/><path d="M2.8 10.2 9 4l4 4-6 6H5.6Z"/><path d="m6 7 4 4"/>',
    undo: '<path d="M4 7h7a3.5 3.5 0 0 1 0 7H8"/><path d="M6.5 4.5 4 7l2.5 2.5"/>',
    clear: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
    fingers: '<path d="M6 8.5V3.2a1.1 1.1 0 0 1 2.2 0V7.5"/><path d="M8.2 7V6a1.1 1.1 0 0 1 2.2 0v1.5"/><path d="M10.4 7.2a1.1 1.1 0 0 1 2.1.3V10c0 2.5-1.6 4-4 4H8c-1.7 0-2.6-.8-3.6-2.3L3.2 9.8a1 1 0 0 1 1.6-1.2L6 9.8"/>',
    keep: '<path d="M4 2.5h6.5L13 5v8.5H4Z"/><path d="M6 2.5v3.5h4V2.5M6 13.5V9.5h5v4"/>',
    close: '<path d="m4 4 8 8M12 4l-8 8"/>'
  };
  function icon2(name2) {
    return `<svg aria-hidden="true" viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name2]}</svg>`;
  }
  function button8(title3, content2, data) {
    const b2 = document.createElement("button");
    b2.type = "button";
    b2.className = "ink-btn";
    b2.title = title3;
    b2.setAttribute("aria-label", title3);
    b2.innerHTML = content2;
    for (const [k2, v2] of Object.entries(data)) b2.dataset[k2] = v2;
    return b2;
  }
  function group(...children2) {
    const g2 = document.createElement("div");
    g2.className = "ink-group";
    g2.append(...children2);
    return g2;
  }
  var TOOL_TITLES = {
    pen: "Pen",
    highlighter: "Highlighter",
    eraser: "Eraser (also a pen's eraser end): wipe over strokes to remove them"
  };
  var InkPalette = class {
    el;
    opts;
    custom;
    sizes;
    constructor(opts2) {
      this.opts = opts2;
      const el2 = document.createElement("div");
      el2.className = "ink-palette";
      el2.setAttribute("role", "toolbar");
      el2.setAttribute("aria-label", "Ink");
      this.el = el2;
      const tools = group(
        ...["pen", "highlighter", "eraser"].map(
          (t2) => button8(TOOL_TITLES[t2], icon2(t2), { inkTool: t2 })
        )
      );
      const swatches = group(
        ...SWATCHES.map((s2, i2) => {
          const b2 = button8(
            s2.label,
            `<span class="ink-swatch" style="background:${s2.token ? `var(--inkflow-${s2.token}, ${s2.hex})` : s2.hex}"></span>`,
            { inkSwatch: String(i2) }
          );
          return b2;
        })
      );
      swatches.classList.add("ink-colours");
      const customLabel = document.createElement("label");
      customLabel.className = "ink-btn ink-custom";
      customLabel.title = "Another colour";
      customLabel.dataset.inkCustom = "";
      this.custom = document.createElement("input");
      this.custom.type = "color";
      this.custom.setAttribute("aria-label", "Another colour");
      customLabel.append(this.custom);
      swatches.append(customLabel);
      this.sizes = group();
      this.sizes.classList.add("ink-sizes");
      const actions = group(
        button8(opts2.undoTitle, icon2("undo"), { inkAction: "undo" }),
        button8(opts2.clearTitle, icon2("clear"), { inkAction: "clear" })
      );
      const toggles = group(
        button8(
          "Draw with a mouse or a finger too (off: only a pen draws, so clicks and swipes still navigate)",
          icon2("fingers"),
          { inkToggle: "fingers" }
        )
      );
      if (opts2.keep) {
        toggles.append(
          button8(
            "Keep: save new strokes with the slide (off: they last for this talk only)",
            icon2("keep"),
            { inkToggle: "keep" }
          )
        );
      }
      if (opts2.close) {
        toggles.append(
          button8("Leave ink mode (i)", icon2("close"), {
            inkAction: "close"
          })
        );
      }
      el2.append(tools, swatches, this.sizes, actions, toggles);
      el2.addEventListener("pointerdown", (e2) => e2.stopPropagation());
      el2.addEventListener("click", (e2) => {
        e2.stopPropagation();
        const b2 = e2.target.closest(".ink-btn");
        if (!b2) return;
        this.press(b2.dataset);
      });
      this.custom.addEventListener("input", () => {
        const s2 = this.settings;
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], swatch: null, custom: this.custom.value };
        if (s2.tool === "eraser") s2.tool = tool;
        this.commit(s2);
      });
      this.render();
    }
    get settings() {
      return structuredClone(this.opts.settings);
    }
    set(settings2) {
      this.opts.settings = settings2;
      this.render();
    }
    // The pen tool colour and width apply to: the current one, or the pen
    // while the eraser is picked.
    penTool() {
      return this.opts.settings.tool === "highlighter" ? "highlighter" : "pen";
    }
    press(data) {
      const s2 = this.settings;
      if (data.inkTool) {
        s2.tool = data.inkTool;
      } else if (data.inkSwatch !== void 0) {
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], swatch: Number(data.inkSwatch) };
        if (s2.tool === "eraser") s2.tool = tool;
      } else if (data.inkSize !== void 0) {
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], size: Number(data.inkSize) };
        if (s2.tool === "eraser") s2.tool = tool;
      } else if (data.inkCustom !== void 0) {
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], swatch: null };
        if (s2.tool === "eraser") s2.tool = tool;
      } else if (data.inkToggle === "fingers") {
        s2.fingers = !s2.fingers;
      } else if (data.inkToggle === "keep") {
        s2.keep = !s2.keep;
      } else if (data.inkAction === "undo") {
        this.opts.undo();
        return;
      } else if (data.inkAction === "clear") {
        this.opts.clear();
        return;
      } else if (data.inkAction === "close") {
        this.opts.close?.();
        return;
      }
      this.commit(s2);
    }
    commit(s2) {
      this.opts.settings = s2;
      this.render();
      this.opts.onChange(structuredClone(s2));
    }
    render() {
      const s2 = this.opts.settings;
      const tool = this.penTool();
      const t2 = s2[tool];
      for (const b2 of this.el.querySelectorAll(
        "[data-ink-tool]"
      )) {
        b2.setAttribute(
          "aria-pressed",
          String(b2.dataset.inkTool === s2.tool)
        );
      }
      for (const b2 of this.el.querySelectorAll(
        "[data-ink-swatch]"
      )) {
        b2.setAttribute(
          "aria-pressed",
          String(t2.swatch === Number(b2.dataset.inkSwatch))
        );
      }
      this.custom.parentElement.classList.toggle("on", t2.swatch === null);
      this.custom.value = t2.custom;
      const sizes = sizesOf(tool);
      const largest = sizes[sizes.length - 1];
      this.sizes.replaceChildren(
        ...sizes.map((size4, i2) => {
          const px2 = Math.max(3, Math.round(size4 / largest * 16));
          const b2 = button8(
            ["Thin", "Medium", "Thick"][i2] ?? `Size ${i2 + 1}`,
            `<span class="ink-dot ${tool}" style="width:${px2}px;height:${tool === "highlighter" ? Math.max(3, Math.round(px2 / 2.5)) : px2}px"></span>`,
            { inkSize: String(i2) }
          );
          b2.setAttribute("aria-pressed", String(t2.size === i2));
          return b2;
        })
      );
      this.el.classList.toggle("erasing", s2.tool === "eraser");
      for (const b2 of this.el.querySelectorAll(
        "[data-ink-toggle]"
      )) {
        const key = b2.dataset.inkToggle;
        b2.setAttribute("aria-pressed", String(s2[key]));
      }
    }
  };
  function loadSettings(key, fingers) {
    const fallback = defaultSettings2(fingers);
    try {
      const raw = localStorage.getItem(key);
      return raw ? settingsFrom(JSON.parse(raw), fallback) : fallback;
    } catch {
      return fallback;
    }
  }
  function saveSettings(key, settings2) {
    try {
      localStorage.setItem(key, JSON.stringify(settings2));
    } catch {
    }
  }

  // src/ts/editor/ink.ts
  var SETTINGS_KEY = "inkflow-ink-editor";
  var SVG_NS4 = "http://www.w3.org/2000/svg";
  var settings = loadSettings(SETTINGS_KEY, true);
  var pad = null;
  function fingersDraw() {
    return penActive() && settings.fingers;
  }
  function cancelStroke() {
    pad?.cancel();
  }
  function penActive() {
    return ed.tool === "pen" && ed.step == null && !ed.richEditing && !ed.master;
  }
  var pending3 = /* @__PURE__ */ new Map();
  function liveLayer(svg) {
    let layer2 = svg.querySelector(":scope > g.inkflow-live-ink");
    if (!layer2) {
      layer2 = document.createElementNS(SVG_NS4, "g");
      layer2.setAttribute("class", "inkflow-live-ink");
      svg.appendChild(layer2);
    }
    return layer2;
  }
  function showPending() {
    const svg = slideRoot();
    const slide = currentSlide();
    if (!svg || !slide) return;
    for (const [id, p2] of pending3) {
      if (p2.deckIndex !== slide.deckIndex) continue;
      if (svg.querySelector(`.inkflow-ink [id="${CSS.escape(id)}"]`)) {
        pending3.delete(id);
      } else if (!svg.getElementById(id)) {
        liveLayer(svg).appendChild(strokeElement(p2.stroke));
      }
    }
  }
  async function save2(stroke) {
    const slide = currentSlide();
    if (!slide) return;
    pending3.set(stroke.id, { deckIndex: slide.deckIndex, stroke });
    showPending();
    const result = await edit({
      action: "ink",
      op: "add",
      slide: slide.deckIndex,
      strokes: [stroke]
    });
    if (!result.ok) {
      pending3.delete(stroke.id);
      slideRoot()?.getElementById(stroke.id)?.remove();
    }
  }
  async function erase(ids, hidden) {
    const slide = currentSlide();
    if (!slide) return;
    for (const id of ids) pending3.delete(id);
    const result = await edit({
      action: "ink",
      op: "erase",
      slide: slide.deckIndex,
      ids
    });
    if (!result.ok) for (const el2 of hidden) el2.style.removeProperty("display");
  }
  async function clear2() {
    const slide = currentSlide();
    if (!slide?.ink?.exists && !pending3.size) {
      toast("This slide has no ink");
      return;
    }
    if (!slide || !window.confirm("Remove all ink from this slide?")) return;
    pending3.clear();
    await edit({ action: "ink", op: "clear", slide: slide.deckIndex });
  }
  function tokenColor(token) {
    const value = getComputedStyle(slideRoot() ?? document.documentElement).getPropertyValue(`--inkflow-${token}`).trim();
    return value ? normalizeHex(value) : null;
  }
  function initInk() {
    const paper2 = document.getElementById("paper");
    const palette = new InkPalette({
      settings,
      keep: false,
      undoTitle: "Undo (Ctrl+Z)",
      clearTitle: "Clear this slide's ink",
      onChange(next) {
        settings = next;
        saveSettings(SETTINGS_KEY, settings);
      },
      undo: () => void edit({ action: "undo" }),
      clear: () => void clear2()
    });
    palette.el.classList.add("editor-ink");
    palette.el.hidden = true;
    document.body.appendChild(palette.el);
    pad = new InkPad({
      surface: paper2,
      active: penActive,
      fingers: () => settings.fingers,
      tool: () => settings.tool,
      svg: () => currentSlide()?.ink ? slideRoot() : null,
      style: (tool, svg) => styleFor(
        settings,
        tool,
        svg.viewBox.baseVal.width,
        tokenColor,
        svg.viewBox.baseVal.height
      ),
      *erasables(svg) {
        yield* svg.querySelectorAll(
          ".inkflow-ink path[id], .inkflow-live-ink path[id]"
        );
      },
      onStroke: (stroke) => void save2(stroke),
      onErase: (ids, hidden) => void erase(ids, hidden)
    });
    on("tool", () => {
      if (ed.tool === "pen" && ed.master) {
        toast(
          "The pen draws on a slide: close the slide master to draw ink, or use the shapes here"
        );
      }
      palette.el.hidden = ed.tool !== "pen";
    });
    on("render", showPending);
  }

  // src/ts/editor/notestext.ts
  var NOTES_DEFAULT = 150;
  var NOTES_MIN = 72;
  var CANVAS_MIN = 160;
  function clampHeight(px2, available) {
    const most = Math.max(NOTES_MIN, available - CANVAS_MIN);
    return Math.round(Math.min(Math.max(px2, NOTES_MIN), most));
  }
  function readNumber(stored2) {
    if (stored2 == null || stored2.trim() === "") return null;
    const n3 = Number(stored2);
    return Number.isFinite(n3) && n3 > 0 ? n3 : null;
  }

  // src/ts/editor/notes.ts
  var area = document.getElementById("notes-input");
  var preview = document.getElementById("notes-preview");
  var label3 = document.getElementById("notes-file");
  var handle = document.getElementById("notes-resize");
  var writeBtn = document.getElementById("notes-write");
  var readBtn = document.getElementById("notes-read");
  var workspace = document.getElementById("workspace");
  var panel3 = document.getElementById("notes");
  var HEIGHT_KEY = "inkflow-editor-notes-height";
  var VIEW_KEY = "inkflow-editor-notes-view";
  var timer5 = 0;
  var slideIndex = -1;
  var sent = "";
  var burst = "";
  var reading = false;
  async function save3() {
    window.clearTimeout(timer5);
    const slide = ed.model?.slides[slideIndex];
    if (!slide || area.value === sent) return;
    const before = sent;
    sent = area.value;
    const result = await edit(
      {
        action: "notes",
        slide: slide.deckIndex,
        text: area.value,
        name: slide.id ?? "slide",
        coalesce: burst
      },
      { retrying: true }
    );
    if (!result.ok) {
      sent = before;
      timer5 = window.setTimeout(() => void save3(), 800);
    }
  }
  function load2() {
    const slide = currentSlide();
    if (!slide) return;
    showPreview();
    if (document.activeElement === area && slideIndex === slide.deckIndex)
      return;
    slideIndex = slide.deckIndex;
    area.value = slide.notes.text;
    sent = area.value;
    label3.textContent = slide.notes.kind === "file" ? slide.notes.rel ?? "" : slide.notes.kind === "inline" ? "inline in deck.py" : "new notes file on first edit";
  }
  function emptyNote(text) {
    const p2 = document.createElement("p");
    p2.className = "notes-empty";
    p2.textContent = text;
    return p2;
  }
  function showPreview() {
    if (!reading) return;
    const slide = currentSlide();
    if (slide && !slide.visible) {
      delete preview.dataset.shown;
      preview.replaceChildren(
        emptyNote("A hidden slide is not built: show it to read its notes")
      );
      return;
    }
    const html = currentRendered()?.notes ?? "";
    if (preview.dataset.shown === html) return;
    preview.dataset.shown = html;
    if (!html.trim()) {
      preview.replaceChildren(emptyNote("No speaker notes on this slide"));
      return;
    }
    preview.innerHTML = html;
    preview.scrollTop = 0;
    for (const a2 of preview.querySelectorAll("a[href]")) {
      a2.setAttribute("target", "_blank");
      a2.setAttribute("rel", "noopener noreferrer");
    }
  }
  function setView(read3, remember = true) {
    reading = read3;
    area.hidden = read3;
    preview.hidden = !read3;
    writeBtn.classList.toggle("on", !read3);
    readBtn.classList.toggle("on", read3);
    writeBtn.setAttribute("aria-pressed", String(!read3));
    readBtn.setAttribute("aria-pressed", String(read3));
    if (remember) {
      try {
        localStorage.setItem(VIEW_KEY, read3 ? "read" : "write");
      } catch {
      }
    }
    if (!read3) return;
    delete preview.dataset.shown;
    void save3();
    showPreview();
  }
  function followLink(e2) {
    const link = e2.target.closest?.("[data-inkflow-slide]");
    if (!link) return;
    e2.preventDefault();
    const id = link.getAttribute("data-inkflow-slide");
    const to = ed.model?.slides.find((s2) => s2.id === id);
    if (to) gotoSlide(to.deckIndex);
  }
  function setHeight(px2, remember = true) {
    const h3 = clampHeight(px2, workspace.getBoundingClientRect().height);
    workspace.style.setProperty("--notes-h", `${h3}px`);
    handle.setAttribute("aria-valuenow", String(h3));
    if (!remember) return;
    try {
      localStorage.setItem(HEIGHT_KEY, String(h3));
    } catch {
    }
  }
  function height() {
    return panel3.getBoundingClientRect().height;
  }
  function initResize() {
    let from = null;
    handle.addEventListener("pointerdown", (e2) => {
      if (e2.button !== 0) return;
      e2.preventDefault();
      from = { y: e2.clientY, height: height() };
      try {
        handle.setPointerCapture(e2.pointerId);
      } catch {
      }
      document.body.classList.add("notes-resizing");
    });
    handle.addEventListener("pointermove", (e2) => {
      if (from) setHeight(from.height + from.y - e2.clientY, false);
    });
    const done = () => {
      if (!from) return;
      from = null;
      document.body.classList.remove("notes-resizing");
      setHeight(height());
    };
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
    handle.addEventListener("dblclick", () => setHeight(NOTES_DEFAULT));
    handle.addEventListener("keydown", (e2) => {
      const step2 = e2.shiftKey ? 80 : 20;
      if (e2.key === "ArrowUp") setHeight(height() + step2);
      else if (e2.key === "ArrowDown") setHeight(height() - step2);
      else if (e2.key === "Home") setHeight(NOTES_DEFAULT);
      else return;
      e2.preventDefault();
      e2.stopPropagation();
    });
    window.addEventListener("resize", () => {
      if (workspace.style.getPropertyValue("--notes-h"))
        setHeight(height(), false);
    });
  }
  function initNotes() {
    area.addEventListener("focus", () => {
      burst = `notes-${Date.now()}`;
    });
    area.addEventListener("input", () => {
      window.clearTimeout(timer5);
      timer5 = window.setTimeout(() => void save3(), 600);
    });
    area.addEventListener("blur", () => void save3());
    area.addEventListener("keydown", (e2) => e2.stopPropagation());
    writeBtn.addEventListener("click", () => {
      setView(false);
      area.focus();
    });
    readBtn.addEventListener("click", () => setView(true));
    preview.addEventListener("click", followLink);
    preview.addEventListener("dblclick", (e2) => {
      if (e2.target.closest?.("a")) return;
      setView(false);
      area.focus();
    });
    initResize();
    let view3 = null;
    let stored2 = null;
    try {
      view3 = localStorage.getItem(VIEW_KEY);
      stored2 = readNumber(localStorage.getItem(HEIGHT_KEY));
    } catch {
    }
    if (stored2 != null) setHeight(stored2, false);
    if (view3 === "read") setView(true, false);
    on("slide", () => {
      void save3().then(load2);
    });
    on("model", load2);
  }

  // src/ts/editor/palettetext.ts
  function score(query2, text) {
    const q = query2.toLowerCase().replace(/\s+/g, " ").trim();
    if (!q) return 0;
    const t2 = text.toLowerCase();
    const direct = t2.indexOf(q);
    if (direct === 0) return 1e3 - t2.length;
    if (direct > 0) {
      const wordStart = /[\s\-_/.:(]/.test(t2[direct - 1]);
      return (wordStart ? 800 : 600) - direct - t2.length / 10;
    }
    let s2 = 0;
    let at3 = 0;
    let run = 0;
    for (const ch of q) {
      if (ch === " ") continue;
      const found = t2.indexOf(ch, at3);
      if (found < 0) return null;
      const start = found === 0 || /[\s\-_/.:(]/.test(t2[found - 1]);
      run = found === at3 ? run + 1 : 0;
      s2 += 10 + (start ? 15 : 0) + run * 5 - Math.min(found - at3, 10);
      at3 = found + 1;
    }
    return s2 - t2.length / 10;
  }
  function rank2(entries, query2, limit = 60) {
    const scored = [];
    entries.forEach((e2, k2) => {
      const best2 = Math.max(
        score(query2, e2.label) ?? -Infinity,
        (score(query2, `${e2.group} ${e2.label}`) ?? -Infinity) - 50,
        e2.hint ? (score(query2, e2.hint) ?? -Infinity) - 100 : -Infinity
      );
      if (best2 > -Infinity) scored.push({ e: e2, s: best2, k: k2 });
    });
    const n3 = /^\d+$/.test(query2.trim()) ? Number(query2.trim()) : null;
    if (n3 != null) {
      for (const item2 of scored) {
        if (item2.e.group === "Slide" && item2.e.label.startsWith(`${n3} `))
          item2.s += 5e3;
      }
    }
    scored.sort((a2, b2) => b2.s - a2.s || a2.k - b2.k);
    return scored.slice(0, limit).map((x2) => x2.e);
  }
  function fromTitle(title3) {
    const m2 = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(title3.split("\n")[0]);
    if (m2 && /^(Ctrl|Shift|Alt|⌘|[A-Z0-9]$|F\d|Esc)/.test(m2[2])) {
      return { label: m2[1].trim(), keys: m2[2].trim() };
    }
    return { label: title3.split("\n")[0].trim() };
  }

  // src/ts/editor/theme.ts
  var SEMANTIC = [
    ["bg", "Background"],
    ["surface", "Surface (cards)"],
    ["border", "Border"],
    ["text", "Text"],
    ["text_muted", "Muted text"],
    ["heading", "Headings"],
    ["accent", "Accent"],
    ["accent_fg", "Text on accent"],
    ["link", "Links"],
    ["code_bg", "Code background"],
    ["code_text", "Code text"],
    ["blockquote", "Quote bar"]
  ];
  var NAMED = [
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "grey"
  ];
  var FONTS = [
    ["body_font", "Body", "sans-serif"],
    ["heading_font", "Headings", "sans-serif"],
    ["mono_font", "Code", "monospace"],
    ["math_font", "Maths", "math"]
  ];
  var info3 = null;
  var report2 = null;
  var content = null;
  var cssVar = (name2) => `--inkflow-${name2.replace(/_/g, "-")}`;
  function toHex(value) {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return `#${[...value.slice(1)].map((c2) => c2 + c2).join("")}`.toLowerCase();
    }
    const probe = h("span", {});
    probe.style.color = value;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? ["0", "0", "0"];
    probe.remove();
    return `#${rgb.slice(0, 3).map((n3) => Number(n3).toString(16).padStart(2, "0")).join("")}`;
  }
  async function save4(body3, label4) {
    await edit({ action: "theme-set", label: label4, ...body3 });
  }
  function setToken(group2, name2, value) {
    void save4({ changes: { [group2]: { [name2]: value } } }, "Theme");
  }
  function colorCell(mode2, name2) {
    const t2 = info3;
    const own = t2.overrides[mode2][name2];
    const value = own ?? t2.values[mode2][name2] ?? "#000000";
    const input = h("input", {
      type: "color",
      value: toHex(value),
      title: `${cssVar(name2)} (${mode2})${own ? " \xB7 changed" : ""}`
    });
    input.addEventListener("input", () => {
      const showing = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      if (showing === mode2) {
        document.documentElement.style.setProperty(
          cssVar(name2),
          input.value
        );
      }
    });
    input.addEventListener("change", () => setToken(mode2, name2, input.value));
    return h(
      "span",
      { class: `theme-color${own ? " changed" : ""}` },
      input,
      own ? h(
        "button",
        {
          type: "button",
          class: "theme-reset",
          title: "Back to the theme's colour",
          onclick: () => setToken(mode2, name2, null)
        },
        "\u21BA"
      ) : null
    );
  }
  function colorsTable() {
    const rows = [
      h(
        "div",
        { class: "theme-row head" },
        h("span", {}, ""),
        h("span", {}, "Dark"),
        h("span", {}, "Light")
      )
    ];
    const add = (name2, label4) => rows.push(
      h(
        "div",
        { class: "theme-row" },
        h("span", { class: "theme-label" }, label4),
        colorCell("dark", name2),
        colorCell("light", name2)
      )
    );
    for (const [name2, label4] of SEMANTIC) add(name2, label4);
    rows.push(h("div", { class: "theme-sub" }, "Named colours"));
    for (const name2 of NAMED) add(name2, name2[0].toUpperCase() + name2.slice(1));
    return h("div", { class: "theme-colors" }, ...rows);
  }
  function fontRow(name2, label4, generic) {
    const t2 = info3;
    const own = t2.overrides.typography[name2];
    const value = own ?? t2.values.typography[name2] ?? generic;
    const input = h("input", {
      type: "text",
      list: "theme-font-list",
      value,
      placeholder: generic,
      spellcheck: "false"
    });
    input.addEventListener("change", () => {
      const v2 = input.value.trim();
      if (!v2) {
        setToken("typography", name2, null);
        return;
      }
      void (async () => {
        const res = await edit({
          action: "fonts",
          op: "set",
          role: name2.replace(/_font$/, ""),
          family: v2,
          label: `Font: ${label4}`
        });
        if (!res.ok) {
          input.value = value;
          return;
        }
        const bundle = res.bundle;
        if (bundle?.families?.length) {
          toast(`Copied ${bundle.families.join(", ")} into fonts/`, "ok");
        } else if (typeof res.note === "string") {
          toast(res.note, "info");
        }
      })();
    });
    const sample = h("span", { class: "theme-font-sample" }, "Aa Bb 123");
    sample.style.fontFamily = value;
    return h(
      "div",
      { class: "theme-font" },
      h("span", { class: "theme-label" }, label4),
      input,
      sample,
      own ? h(
        "button",
        {
          type: "button",
          class: "theme-reset",
          title: "Back to the theme's font",
          onclick: () => setToken("typography", name2, null)
        },
        "\u21BA"
      ) : null
    );
  }
  function render4() {
    if (!content || !info3) return;
    const t2 = info3;
    clear(content);
    const theme = h("select", {});
    for (const { id, label: label4 } of t2.themes) {
      theme.append(h("option", { value: id }, label4));
    }
    if (t2.theme === null) {
      theme.append(
        h("option", { value: "", disabled: true }, `${t2.name} (deck.py)`)
      );
    }
    theme.value = t2.theme ?? "";
    theme.disabled = !ed.model?.deckEditable;
    theme.addEventListener(
      "change",
      () => void save4({ theme: theme.value }, "Theme")
    );
    const mode2 = h("select", {});
    for (const [v2, l2] of [
      ["", `Theme default (${t2.themeMode})`],
      ["dark", "Dark"],
      ["light", "Light"]
    ]) {
      mode2.append(h("option", { value: v2 }, l2));
    }
    mode2.value = t2.deckMode ?? "";
    mode2.disabled = !ed.model?.deckEditable;
    mode2.addEventListener(
      "change",
      () => void save4({ mode: mode2.value || null }, "Colour mode")
    );
    const size4 = h("input", {
      type: "number",
      min: 8,
      max: 200,
      value: t2.fontSize ?? "",
      placeholder: String(t2.themeFontSize)
    });
    size4.disabled = !ed.model?.deckEditable;
    size4.addEventListener("change", () => {
      const n3 = parseInt(size4.value, 10);
      void save4({ fontSize: Number.isFinite(n3) ? n3 : null }, "Font size");
    });
    const list4 = h("datalist", { id: "theme-font-list" });
    for (const f2 of ["sans-serif", "serif", "monospace", ...t2.fonts]) {
      list4.append(h("option", { value: f2 }));
    }
    content.append(
      h(
        "div",
        { class: "theme-top" },
        h("label", {}, h("span", {}, "Theme"), theme),
        h("label", {}, h("span", {}, "Colour mode"), mode2),
        h("label", {}, h("span", {}, "Base font size (px)"), size4)
      ),
      h("h3", {}, "Fonts"),
      list4,
      ...FONTS.map(([n3, l2, g2]) => fontRow(n3, l2, g2)),
      h(
        "p",
        { class: "hint" },
        "Inter, JetBrains Mono, STIX Two Math and Twemoji come with inkflow and look the same everywhere. Fonts found in fonts/, the theme or this computer are embedded in the deck too."
      ),
      fontsReport(),
      h("h3", {}, "Colours"),
      colorsTable(),
      h(
        "p",
        { class: "hint" },
        "Changes are written to styles.css (one marked block) and deck.py; \u21BA goes back to the theme."
      )
    );
  }
  var WHERE = {
    project: "in the deck (fonts/)",
    theme: "ships with inkflow / the theme",
    machine: "this computer only",
    missing: "not installed",
    generic: "each machine's own"
  };
  function fontsReport() {
    const families = report2?.families ?? [];
    const box2 = h("div", { class: "theme-fonts-report" });
    if (!report2) {
      box2.append(
        h("p", { class: "hint" }, "Checking where the fonts come from\u2026")
      );
      return box2;
    }
    if (!families.length) {
      box2.append(h("p", { class: "hint" }, "The deck names no font."));
      return box2;
    }
    box2.append(
      h(
        "div",
        { class: "theme-sub" },
        "Where each font comes from (on another machine only the deck's and inkflow's fonts are there)"
      ),
      ...families.map(
        (f2) => h(
          "div",
          {
            class: `font-source ${f2.where}`,
            "data-family": f2.family,
            title: f2.message || f2.files.map((x2) => x2.path).join("\n")
          },
          h("span", { class: "font-family" }, f2.family),
          h("span", { class: `font-where ${f2.where}` }, WHERE[f2.where]),
          h("span", { class: "font-faces" }, f2.faces.join(", ")),
          f2.message ? h("span", { class: "font-message hint" }, f2.message) : null
        )
      )
    );
    const machine = families.filter((f2) => f2.where === "machine");
    const bundle = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        "data-fonts": "bundle",
        title: "Copy the fonts only this computer has into the deck's fonts/, with their licences",
        onclick: () => void bundleFonts()
      },
      "Bundle fonts into the deck"
    );
    bundle.disabled = machine.length === 0;
    box2.append(h("div", { class: "btn-row" }, bundle));
    return box2;
  }
  async function bundleFonts() {
    const plan2 = await request({ action: "fonts", op: "bundle", dryRun: true });
    if (!plan2.ok) {
      toast(plan2.error ?? "cannot bundle fonts", "error");
      return;
    }
    const b2 = plan2.bundle;
    if (!b2.copies.length) {
      toast("No font comes from this computer only", "info");
      return;
    }
    const question = [
      `Copy ${b2.families.join(", ")} into fonts/ (${b2.copies.length} file${b2.copies.length === 1 ? "" : "s"})?`,
      ...b2.warnings.map((w2) => `\u26A0 ${w2}`)
    ].join("\n\n");
    if (!confirm(question)) return;
    const res = await edit({ action: "fonts", op: "bundle" });
    if (res.ok) {
      toast(`Copied ${b2.families.join(", ")} into fonts/`, "ok");
      await refresh2();
    }
  }
  async function refresh2() {
    const result = await request({ action: "theme-get" });
    if (!result.ok) return;
    info3 = result.theme;
    render4();
    const fonts = await request({ action: "fonts" });
    if (fonts.ok) {
      report2 = fonts.fonts;
      render4();
    }
  }
  async function openTheme() {
    report2 = null;
    content = h(
      "div",
      { class: "theme-body" },
      h("p", { class: "hint" }, "Loading\u2026")
    );
    openDialog("Theme", content, {
      hint: "Colours, fonts and size for the whole deck",
      onClose: () => {
        content = null;
        document.documentElement.removeAttribute("style");
      }
    });
    await refresh2();
  }
  function initTheme() {
    document.getElementById("btn-theme-panel")?.addEventListener("click", () => {
      void openTheme();
    });
    on("model", () => {
      document.documentElement.removeAttribute("style");
      if (content) void refresh2();
    });
  }

  // src/ts/editor/palette.ts
  var box = null;
  function slideCommands() {
    const slides = ed.model?.slides ?? [];
    return slides.map((s2, i2) => ({
      label: `${i2 + 1} ${s2.title ?? s2.id ?? s2.src}${s2.visible ? "" : " (hidden)"}`,
      group: "Slide",
      hint: `${s2.id ?? ""} ${s2.src}`,
      run: () => {
        ed.slideSelection.clear();
        gotoSlide(i2);
      }
    }));
  }
  function toolbarCommands() {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const b2 of document.querySelectorAll(
      "#toolbar button[title]"
    )) {
      if (b2.disabled || b2.hidden || !b2.offsetParent || b2.id === "btn-deck")
        continue;
      const { label: label4, keys } = fromTitle(b2.title);
      if (!label4 || seen.has(label4)) continue;
      seen.add(label4);
      out.push({ label: label4, group: "Toolbar", keys, run: () => b2.click() });
    }
    return out;
  }
  function editorCommands() {
    const i2 = ed.current;
    const editable = !!ed.model?.deckEditable;
    const out = [
      {
        label: "Undo",
        group: "Edit",
        keys: "Ctrl+Z",
        run: () => void undo()
      },
      {
        label: "Redo",
        group: "Edit",
        keys: "Ctrl+Shift+Z",
        run: () => void redo()
      },
      {
        label: "Find and replace",
        group: "Edit",
        keys: keyLabel("edit.find"),
        run: () => openFind()
      },
      { label: "Theme\u2026", group: "Deck", run: () => void openTheme() },
      { label: "Export\u2026", group: "Deck", run: () => openExport() },
      {
        label: "Handout view (slides with their notes)",
        group: "Deck",
        run: () => window.open("/handout", "_blank", "noopener")
      },
      {
        label: "Slide master",
        group: "View",
        run: () => void openMaster()
      },
      {
        label: "Grid view",
        group: "View",
        keys: keyLabel("view.grid"),
        run: () => toggleGrid()
      },
      {
        label: "Show / hide the slide list",
        group: "View",
        keys: keyLabel("view.left"),
        run: () => togglePanel("left")
      },
      {
        label: "Show / hide the notes",
        group: "View",
        keys: keyLabel("view.bottom"),
        run: () => togglePanel("bottom")
      },
      {
        label: "Show / hide the properties",
        group: "View",
        keys: keyLabel("view.right"),
        run: () => togglePanel("right")
      },
      {
        label: "Full screen",
        group: "View",
        keys: keyLabel("view.fullscreen"),
        run: () => toggleFullscreen()
      },
      {
        label: "Keyboard shortcuts\u2026",
        group: "Help",
        keys: keyLabel("help.shortcuts"),
        run: () => openShortcuts()
      },
      { label: "Problems\u2026", group: "Check", run: () => openProblems() },
      {
        label: "Problems on this slide\u2026",
        group: "Check",
        run: () => openProblems(i2)
      },
      {
        label: "Add comment",
        group: "Comments",
        keys: keyLabel("review.comment"),
        run: () => addComment()
      },
      {
        label: "Comments on this slide\u2026",
        group: "Comments",
        run: () => openComments(i2)
      },
      {
        label: "Next slide with changes",
        group: "Git",
        keys: keyLabel("review.next-change"),
        run: () => jumpToChange(1)
      },
      {
        label: "Previous slide with changes",
        group: "Git",
        keys: keyLabel("review.prev-change"),
        run: () => jumpToChange(-1)
      },
      {
        label: "Compare this slide with the last commit",
        group: "Git",
        run: () => compareSlide(i2)
      },
      {
        label: "Commit this slide\u2026",
        group: "Git",
        run: () => void commitSlides([i2])
      },
      {
        label: "Discard changes to this slide\u2026",
        group: "Git",
        run: () => void discardSlides([i2])
      },
      {
        label: "Compare the deck with the last commit",
        group: "Git",
        run: () => openCompare({ kind: "commit", rev: "HEAD" }, { kind: "live" })
      },
      {
        label: "Star / unstar this slide",
        group: "Slide",
        keys: keyLabel("slide.star"),
        run: () => void toggleStar([i2])
      }
    ];
    if (editable) {
      out.push(
        {
          label: "New slide like this one",
          group: "Slide",
          keys: keyLabel("slide.new"),
          run: () => void newSlideLike(i2)
        },
        {
          label: "Duplicate this slide",
          group: "Slide",
          run: () => void duplicateSlide(i2)
        },
        {
          label: "Hide / show this slide",
          group: "Slide",
          run: () => void toggleHidden(i2)
        },
        {
          label: "Delete this slide",
          group: "Slide",
          run: () => void deleteSlide(i2)
        },
        {
          label: "Add a section here",
          group: "Slide",
          run: () => void addSectionAt(i2)
        }
      );
    }
    return out;
  }
  function closePalette() {
    box?.remove();
    box = null;
  }
  async function openPalette(query2 = "") {
    if (box) {
      box.querySelector("input")?.focus();
      return;
    }
    const input = h("input", {
      type: "text",
      class: "palette-input",
      placeholder: "Type a command or a slide\u2026",
      "aria-label": "Command or slide"
    });
    input.value = query2;
    const list4 = h("div", { class: "palette-list", role: "listbox" });
    box = h(
      "div",
      {
        id: "palette",
        onpointerdown: (e2) => {
          if (e2.target === box) closePalette();
        }
      },
      h("div", { class: "palette-box" }, input, list4)
    );
    document.body.append(box);
    input.focus();
    let all = [
      ...editorCommands(),
      ...toolbarCommands(),
      ...slideCommands()
    ];
    let shown3 = [];
    let at3 = 0;
    const draw = () => {
      shown3 = rank2(all, input.value);
      at3 = Math.min(at3, Math.max(0, shown3.length - 1));
      clear(list4);
      shown3.forEach((c2, k2) => {
        const row7 = h(
          "div",
          {
            class: `palette-row${k2 === at3 ? " on" : ""}`,
            role: "option",
            "aria-selected": String(k2 === at3),
            onpointerdown: (e2) => {
              e2.preventDefault();
              run(c2);
            },
            onpointermove: () => {
              if (at3 === k2) return;
              at3 = k2;
              mark();
            }
          },
          h("span", { class: "palette-label" }, c2.label),
          h("span", { class: "palette-group" }, c2.group),
          c2.keys ? h("kbd", {}, c2.keys) : null
        );
        list4.append(row7);
      });
      if (!shown3.length)
        list4.append(
          h("div", { class: "palette-empty" }, "Nothing matches")
        );
    };
    const mark = () => {
      list4.querySelectorAll(".palette-row").forEach((r2, k2) => {
        r2.classList.toggle("on", k2 === at3);
        r2.setAttribute("aria-selected", String(k2 === at3));
      });
      list4.children[at3]?.scrollIntoView({ block: "nearest" });
    };
    const run = (c2) => {
      closePalette();
      c2.run();
    };
    input.addEventListener("input", () => {
      at3 = 0;
      draw();
    });
    input.addEventListener("keydown", (e2) => {
      if (e2.key === "ArrowDown" || e2.key === "ArrowUp") {
        e2.preventDefault();
        const n3 = shown3.length;
        if (n3) at3 = (at3 + (e2.key === "ArrowDown" ? 1 : n3 - 1)) % n3;
        mark();
      } else if (e2.key === "Enter") {
        e2.preventDefault();
        if (shown3[at3]) run(shown3[at3]);
      } else if (e2.key === "Escape") {
        e2.preventDefault();
        closePalette();
      }
      e2.stopPropagation();
    });
    draw();
    const more = await Promise.all([
      gitCommands().catch(() => []),
      deckCommands().catch(() => [])
    ]);
    if (!box) return;
    all = [...all, ...more.flat()];
    draw();
  }
  function wantsPalette(e2) {
    if (!matches(e2, "help.palette")) return false;
    if (e2.ctrlKey || e2.metaKey || e2.altKey) return true;
    const target = e2.target;
    if (target?.closest(
      "input, textarea, select, button, a, [contenteditable], #dialog"
    ))
      return false;
    return !document.body.classList.contains("compare-mode") && !ed.richEditing;
  }
  function initPalette() {
    on("palette", () => void openPalette());
    document.addEventListener(
      "keydown",
      (e2) => {
        if (!wantsPalette(e2)) return;
        e2.preventDefault();
        e2.stopImmediatePropagation();
        void openPalette();
      },
      true
    );
  }

  // node_modules/.pnpm/qrcode-generator@2.0.4/node_modules/qrcode-generator/dist/qrcode.mjs
  var qrcode = function(typeNumber, errorCorrectionLevel) {
    const PAD0 = 236;
    const PAD1 = 17;
    let _typeNumber = typeNumber;
    const _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    let _modules = null;
    let _moduleCount = 0;
    let _dataCache = null;
    const _dataList = [];
    const _this = {};
    const makeImpl = function(test, maskPattern) {
      _moduleCount = _typeNumber * 4 + 17;
      _modules = (function(moduleCount) {
        const modules = new Array(moduleCount);
        for (let row7 = 0; row7 < moduleCount; row7 += 1) {
          modules[row7] = new Array(moduleCount);
          for (let col = 0; col < moduleCount; col += 1) {
            modules[row7][col] = null;
          }
        }
        return modules;
      })(_moduleCount);
      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);
      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }
      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }
      mapData(_dataCache, maskPattern);
    };
    const setupPositionProbePattern = function(row7, col) {
      for (let r2 = -1; r2 <= 7; r2 += 1) {
        if (row7 + r2 <= -1 || _moduleCount <= row7 + r2) continue;
        for (let c2 = -1; c2 <= 7; c2 += 1) {
          if (col + c2 <= -1 || _moduleCount <= col + c2) continue;
          if (0 <= r2 && r2 <= 6 && (c2 == 0 || c2 == 6) || 0 <= c2 && c2 <= 6 && (r2 == 0 || r2 == 6) || 2 <= r2 && r2 <= 4 && 2 <= c2 && c2 <= 4) {
            _modules[row7 + r2][col + c2] = true;
          } else {
            _modules[row7 + r2][col + c2] = false;
          }
        }
      }
    };
    const getBestMaskPattern = function() {
      let minLostPoint = 0;
      let pattern = 0;
      for (let i2 = 0; i2 < 8; i2 += 1) {
        makeImpl(true, i2);
        const lostPoint = QRUtil.getLostPoint(_this);
        if (i2 == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i2;
        }
      }
      return pattern;
    };
    const setupTimingPattern = function() {
      for (let r2 = 8; r2 < _moduleCount - 8; r2 += 1) {
        if (_modules[r2][6] != null) {
          continue;
        }
        _modules[r2][6] = r2 % 2 == 0;
      }
      for (let c2 = 8; c2 < _moduleCount - 8; c2 += 1) {
        if (_modules[6][c2] != null) {
          continue;
        }
        _modules[6][c2] = c2 % 2 == 0;
      }
    };
    const setupPositionAdjustPattern = function() {
      const pos = QRUtil.getPatternPosition(_typeNumber);
      for (let i2 = 0; i2 < pos.length; i2 += 1) {
        for (let j2 = 0; j2 < pos.length; j2 += 1) {
          const row7 = pos[i2];
          const col = pos[j2];
          if (_modules[row7][col] != null) {
            continue;
          }
          for (let r2 = -2; r2 <= 2; r2 += 1) {
            for (let c2 = -2; c2 <= 2; c2 += 1) {
              if (r2 == -2 || r2 == 2 || c2 == -2 || c2 == 2 || r2 == 0 && c2 == 0) {
                _modules[row7 + r2][col + c2] = true;
              } else {
                _modules[row7 + r2][col + c2] = false;
              }
            }
          }
        }
      }
    };
    const setupTypeNumber = function(test) {
      const bits = QRUtil.getBCHTypeNumber(_typeNumber);
      for (let i2 = 0; i2 < 18; i2 += 1) {
        const mod = !test && (bits >> i2 & 1) == 1;
        _modules[Math.floor(i2 / 3)][i2 % 3 + _moduleCount - 8 - 3] = mod;
      }
      for (let i2 = 0; i2 < 18; i2 += 1) {
        const mod = !test && (bits >> i2 & 1) == 1;
        _modules[i2 % 3 + _moduleCount - 8 - 3][Math.floor(i2 / 3)] = mod;
      }
    };
    const setupTypeInfo = function(test, maskPattern) {
      const data = _errorCorrectionLevel << 3 | maskPattern;
      const bits = QRUtil.getBCHTypeInfo(data);
      for (let i2 = 0; i2 < 15; i2 += 1) {
        const mod = !test && (bits >> i2 & 1) == 1;
        if (i2 < 6) {
          _modules[i2][8] = mod;
        } else if (i2 < 8) {
          _modules[i2 + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i2][8] = mod;
        }
      }
      for (let i2 = 0; i2 < 15; i2 += 1) {
        const mod = !test && (bits >> i2 & 1) == 1;
        if (i2 < 8) {
          _modules[8][_moduleCount - i2 - 1] = mod;
        } else if (i2 < 9) {
          _modules[8][15 - i2 - 1 + 1] = mod;
        } else {
          _modules[8][15 - i2 - 1] = mod;
        }
      }
      _modules[_moduleCount - 8][8] = !test;
    };
    const mapData = function(data, maskPattern) {
      let inc = -1;
      let row7 = _moduleCount - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      const maskFunc = QRUtil.getMaskFunction(maskPattern);
      for (let col = _moduleCount - 1; col > 0; col -= 2) {
        if (col == 6) col -= 1;
        while (true) {
          for (let c2 = 0; c2 < 2; c2 += 1) {
            if (_modules[row7][col - c2] == null) {
              let dark = false;
              if (byteIndex < data.length) {
                dark = (data[byteIndex] >>> bitIndex & 1) == 1;
              }
              const mask = maskFunc(row7, col - c2);
              if (mask) {
                dark = !dark;
              }
              _modules[row7][col - c2] = dark;
              bitIndex -= 1;
              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }
          row7 += inc;
          if (row7 < 0 || _moduleCount <= row7) {
            row7 -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };
    const createBytes = function(buffer, rsBlocks) {
      let offset = 0;
      let maxDcCount = 0;
      let maxEcCount = 0;
      const dcdata = new Array(rsBlocks.length);
      const ecdata = new Array(rsBlocks.length);
      for (let r2 = 0; r2 < rsBlocks.length; r2 += 1) {
        const dcCount = rsBlocks[r2].dataCount;
        const ecCount = rsBlocks[r2].totalCount - dcCount;
        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);
        dcdata[r2] = new Array(dcCount);
        for (let i2 = 0; i2 < dcdata[r2].length; i2 += 1) {
          dcdata[r2][i2] = 255 & buffer.getBuffer()[i2 + offset];
        }
        offset += dcCount;
        const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        const rawPoly = qrPolynomial(dcdata[r2], rsPoly.getLength() - 1);
        const modPoly = rawPoly.mod(rsPoly);
        ecdata[r2] = new Array(rsPoly.getLength() - 1);
        for (let i2 = 0; i2 < ecdata[r2].length; i2 += 1) {
          const modIndex = i2 + modPoly.getLength() - ecdata[r2].length;
          ecdata[r2][i2] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
        }
      }
      let totalCodeCount = 0;
      for (let i2 = 0; i2 < rsBlocks.length; i2 += 1) {
        totalCodeCount += rsBlocks[i2].totalCount;
      }
      const data = new Array(totalCodeCount);
      let index = 0;
      for (let i2 = 0; i2 < maxDcCount; i2 += 1) {
        for (let r2 = 0; r2 < rsBlocks.length; r2 += 1) {
          if (i2 < dcdata[r2].length) {
            data[index] = dcdata[r2][i2];
            index += 1;
          }
        }
      }
      for (let i2 = 0; i2 < maxEcCount; i2 += 1) {
        for (let r2 = 0; r2 < rsBlocks.length; r2 += 1) {
          if (i2 < ecdata[r2].length) {
            data[index] = ecdata[r2][i2];
            index += 1;
          }
        }
      }
      return data;
    };
    const createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
      const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
      const buffer = qrBitBuffer();
      for (let i2 = 0; i2 < dataList.length; i2 += 1) {
        const data = dataList[i2];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
        data.write(buffer);
      }
      let totalDataCount = 0;
      for (let i2 = 0; i2 < rsBlocks.length; i2 += 1) {
        totalDataCount += rsBlocks[i2].dataCount;
      }
      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
      }
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }
      while (true) {
        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);
        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }
      return createBytes(buffer, rsBlocks);
    };
    _this.addData = function(data, mode2) {
      mode2 = mode2 || "Byte";
      let newData = null;
      switch (mode2) {
        case "Numeric":
          newData = qrNumber(data);
          break;
        case "Alphanumeric":
          newData = qrAlphaNum(data);
          break;
        case "Byte":
          newData = qr8BitByte(data);
          break;
        case "Kanji":
          newData = qrKanji(data);
          break;
        default:
          throw "mode:" + mode2;
      }
      _dataList.push(newData);
      _dataCache = null;
    };
    _this.isDark = function(row7, col) {
      if (row7 < 0 || _moduleCount <= row7 || col < 0 || _moduleCount <= col) {
        throw row7 + "," + col;
      }
      return _modules[row7][col];
    };
    _this.getModuleCount = function() {
      return _moduleCount;
    };
    _this.make = function() {
      if (_typeNumber < 1) {
        let typeNumber2 = 1;
        for (; typeNumber2 < 40; typeNumber2++) {
          const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
          const buffer = qrBitBuffer();
          for (let i2 = 0; i2 < _dataList.length; i2++) {
            const data = _dataList[i2];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
            data.write(buffer);
          }
          let totalDataCount = 0;
          for (let i2 = 0; i2 < rsBlocks.length; i2++) {
            totalDataCount += rsBlocks[i2].dataCount;
          }
          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }
        _typeNumber = typeNumber2;
      }
      makeImpl(false, getBestMaskPattern());
    };
    _this.createTableTag = function(cellSize, margin) {
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      let qrHtml = "";
      qrHtml += '<table style="';
      qrHtml += " border-width: 0px; border-style: none;";
      qrHtml += " border-collapse: collapse;";
      qrHtml += " padding: 0px; margin: " + margin + "px;";
      qrHtml += '">';
      qrHtml += "<tbody>";
      for (let r2 = 0; r2 < _this.getModuleCount(); r2 += 1) {
        qrHtml += "<tr>";
        for (let c2 = 0; c2 < _this.getModuleCount(); c2 += 1) {
          qrHtml += '<td style="';
          qrHtml += " border-width: 0px; border-style: none;";
          qrHtml += " border-collapse: collapse;";
          qrHtml += " padding: 0px; margin: 0px;";
          qrHtml += " width: " + cellSize + "px;";
          qrHtml += " height: " + cellSize + "px;";
          qrHtml += " background-color: ";
          qrHtml += _this.isDark(r2, c2) ? "#000000" : "#ffffff";
          qrHtml += ";";
          qrHtml += '"/>';
        }
        qrHtml += "</tr>";
      }
      qrHtml += "</tbody>";
      qrHtml += "</table>";
      return qrHtml;
    };
    _this.createSvgTag = function(cellSize, margin, alt, title3) {
      let opts2 = {};
      if (typeof arguments[0] == "object") {
        opts2 = arguments[0];
        cellSize = opts2.cellSize;
        margin = opts2.margin;
        alt = opts2.alt;
        title3 = opts2.title;
      }
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      alt = typeof alt === "string" ? { text: alt } : alt || {};
      alt.text = alt.text || null;
      alt.id = alt.text ? alt.id || "qrcode-description" : null;
      title3 = typeof title3 === "string" ? { text: title3 } : title3 || {};
      title3.text = title3.text || null;
      title3.id = title3.text ? title3.id || "qrcode-title" : null;
      const size4 = _this.getModuleCount() * cellSize + margin * 2;
      let c2, mc, r2, mr, qrSvg2 = "", rect;
      rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
      qrSvg2 += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg2 += !opts2.scalable ? ' width="' + size4 + 'px" height="' + size4 + 'px"' : "";
      qrSvg2 += ' viewBox="0 0 ' + size4 + " " + size4 + '" ';
      qrSvg2 += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg2 += title3.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([title3.id, alt.id].join(" ").trim()) + '"' : "";
      qrSvg2 += ">";
      qrSvg2 += title3.text ? '<title id="' + escapeXml(title3.id) + '">' + escapeXml(title3.text) + "</title>" : "";
      qrSvg2 += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
      qrSvg2 += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg2 += '<path d="';
      for (r2 = 0; r2 < _this.getModuleCount(); r2 += 1) {
        mr = r2 * cellSize + margin;
        for (c2 = 0; c2 < _this.getModuleCount(); c2 += 1) {
          if (_this.isDark(r2, c2)) {
            mc = c2 * cellSize + margin;
            qrSvg2 += "M" + mc + "," + mr + rect;
          }
        }
      }
      qrSvg2 += '" stroke="transparent" fill="black"/>';
      qrSvg2 += "</svg>";
      return qrSvg2;
    };
    _this.createDataURL = function(cellSize, margin) {
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      const size4 = _this.getModuleCount() * cellSize + margin * 2;
      const min = margin;
      const max = size4 - margin;
      return createDataURL(size4, size4, function(x2, y2) {
        if (min <= x2 && x2 < max && min <= y2 && y2 < max) {
          const c2 = Math.floor((x2 - min) / cellSize);
          const r2 = Math.floor((y2 - min) / cellSize);
          return _this.isDark(r2, c2) ? 0 : 1;
        } else {
          return 1;
        }
      });
    };
    _this.createImgTag = function(cellSize, margin, alt) {
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      const size4 = _this.getModuleCount() * cellSize + margin * 2;
      let img = "";
      img += "<img";
      img += ' src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += ' width="';
      img += size4;
      img += '"';
      img += ' height="';
      img += size4;
      img += '"';
      if (alt) {
        img += ' alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += "/>";
      return img;
    };
    const escapeXml = function(s2) {
      let escaped = "";
      for (let i2 = 0; i2 < s2.length; i2 += 1) {
        const c2 = s2.charAt(i2);
        switch (c2) {
          case "<":
            escaped += "&lt;";
            break;
          case ">":
            escaped += "&gt;";
            break;
          case "&":
            escaped += "&amp;";
            break;
          case '"':
            escaped += "&quot;";
            break;
          default:
            escaped += c2;
            break;
        }
      }
      return escaped;
    };
    const _createHalfASCII = function(margin) {
      const cellSize = 1;
      margin = typeof margin == "undefined" ? cellSize * 2 : margin;
      const size4 = _this.getModuleCount() * cellSize + margin * 2;
      const min = margin;
      const max = size4 - margin;
      let y2, x2, r1, r2, p2;
      const blocks2 = {
        "\u2588\u2588": "\u2588",
        "\u2588 ": "\u2580",
        " \u2588": "\u2584",
        "  ": " "
      };
      const blocksLastLineNoMargin = {
        "\u2588\u2588": "\u2580",
        "\u2588 ": "\u2580",
        " \u2588": " ",
        "  ": " "
      };
      let ascii = "";
      for (y2 = 0; y2 < size4; y2 += 2) {
        r1 = Math.floor((y2 - min) / cellSize);
        r2 = Math.floor((y2 + 1 - min) / cellSize);
        for (x2 = 0; x2 < size4; x2 += 1) {
          p2 = "\u2588";
          if (min <= x2 && x2 < max && min <= y2 && y2 < max && _this.isDark(r1, Math.floor((x2 - min) / cellSize))) {
            p2 = " ";
          }
          if (min <= x2 && x2 < max && min <= y2 + 1 && y2 + 1 < max && _this.isDark(r2, Math.floor((x2 - min) / cellSize))) {
            p2 += " ";
          } else {
            p2 += "\u2588";
          }
          ascii += margin < 1 && y2 + 1 >= max ? blocksLastLineNoMargin[p2] : blocks2[p2];
        }
        ascii += "\n";
      }
      if (size4 % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size4 - 1) + Array(size4 + 1).join("\u2580");
      }
      return ascii.substring(0, ascii.length - 1);
    };
    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;
      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }
      cellSize -= 1;
      margin = typeof margin == "undefined" ? cellSize * 2 : margin;
      const size4 = _this.getModuleCount() * cellSize + margin * 2;
      const min = margin;
      const max = size4 - margin;
      let y2, x2, r2, p2;
      const white = Array(cellSize + 1).join("\u2588\u2588");
      const black = Array(cellSize + 1).join("  ");
      let ascii = "";
      let line = "";
      for (y2 = 0; y2 < size4; y2 += 1) {
        r2 = Math.floor((y2 - min) / cellSize);
        line = "";
        for (x2 = 0; x2 < size4; x2 += 1) {
          p2 = 1;
          if (min <= x2 && x2 < max && min <= y2 && y2 < max && _this.isDark(r2, Math.floor((x2 - min) / cellSize))) {
            p2 = 0;
          }
          line += p2 ? white : black;
        }
        for (r2 = 0; r2 < cellSize; r2 += 1) {
          ascii += line + "\n";
        }
      }
      return ascii.substring(0, ascii.length - 1);
    };
    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      const length = _this.getModuleCount();
      for (let row7 = 0; row7 < length; row7++) {
        for (let col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row7, col) ? "black" : "white";
          context.fillRect(col * cellSize, row7 * cellSize, cellSize, cellSize);
        }
      }
    };
    return _this;
  };
  qrcode.stringToBytes = function(s2) {
    const bytes = [];
    for (let i2 = 0; i2 < s2.length; i2 += 1) {
      const c2 = s2.charCodeAt(i2);
      bytes.push(c2 & 255);
    }
    return bytes;
  };
  qrcode.createStringToBytes = function(unicodeData, numChars) {
    const unicodeMap = (function() {
      const bin = base64DecodeInputStream(unicodeData);
      const read3 = function() {
        const b2 = bin.read();
        if (b2 == -1) throw "eof";
        return b2;
      };
      let count = 0;
      const unicodeMap2 = {};
      while (true) {
        const b0 = bin.read();
        if (b0 == -1) break;
        const b1 = read3();
        const b2 = read3();
        const b3 = read3();
        const k2 = String.fromCharCode(b0 << 8 | b1);
        const v2 = b2 << 8 | b3;
        unicodeMap2[k2] = v2;
        count += 1;
      }
      if (count != numChars) {
        throw count + " != " + numChars;
      }
      return unicodeMap2;
    })();
    const unknownChar = "?".charCodeAt(0);
    return function(s2) {
      const bytes = [];
      for (let i2 = 0; i2 < s2.length; i2 += 1) {
        const c2 = s2.charCodeAt(i2);
        if (c2 < 128) {
          bytes.push(c2);
        } else {
          const b2 = unicodeMap[s2.charAt(i2)];
          if (typeof b2 == "number") {
            if ((b2 & 255) == b2) {
              bytes.push(b2);
            } else {
              bytes.push(b2 >>> 8);
              bytes.push(b2 & 255);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };
  var QRMode = {
    MODE_NUMBER: 1 << 0,
    MODE_ALPHA_NUM: 1 << 1,
    MODE_8BIT_BYTE: 1 << 2,
    MODE_KANJI: 1 << 3
  };
  var QRErrorCorrectionLevel = {
    L: 1,
    M: 0,
    Q: 3,
    H: 2
  };
  var QRMaskPattern = {
    PATTERN000: 0,
    PATTERN001: 1,
    PATTERN010: 2,
    PATTERN011: 3,
    PATTERN100: 4,
    PATTERN101: 5,
    PATTERN110: 6,
    PATTERN111: 7
  };
  var QRUtil = (function() {
    const PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    const G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
    const G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
    const G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
    const _this = {};
    const getBCHDigit = function(data) {
      let digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };
    _this.getBCHTypeInfo = function(data) {
      let d2 = data << 10;
      while (getBCHDigit(d2) - getBCHDigit(G15) >= 0) {
        d2 ^= G15 << getBCHDigit(d2) - getBCHDigit(G15);
      }
      return (data << 10 | d2) ^ G15_MASK;
    };
    _this.getBCHTypeNumber = function(data) {
      let d2 = data << 12;
      while (getBCHDigit(d2) - getBCHDigit(G18) >= 0) {
        d2 ^= G18 << getBCHDigit(d2) - getBCHDigit(G18);
      }
      return data << 12 | d2;
    };
    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };
    _this.getMaskFunction = function(maskPattern) {
      switch (maskPattern) {
        case QRMaskPattern.PATTERN000:
          return function(i2, j2) {
            return (i2 + j2) % 2 == 0;
          };
        case QRMaskPattern.PATTERN001:
          return function(i2, j2) {
            return i2 % 2 == 0;
          };
        case QRMaskPattern.PATTERN010:
          return function(i2, j2) {
            return j2 % 3 == 0;
          };
        case QRMaskPattern.PATTERN011:
          return function(i2, j2) {
            return (i2 + j2) % 3 == 0;
          };
        case QRMaskPattern.PATTERN100:
          return function(i2, j2) {
            return (Math.floor(i2 / 2) + Math.floor(j2 / 3)) % 2 == 0;
          };
        case QRMaskPattern.PATTERN101:
          return function(i2, j2) {
            return i2 * j2 % 2 + i2 * j2 % 3 == 0;
          };
        case QRMaskPattern.PATTERN110:
          return function(i2, j2) {
            return (i2 * j2 % 2 + i2 * j2 % 3) % 2 == 0;
          };
        case QRMaskPattern.PATTERN111:
          return function(i2, j2) {
            return (i2 * j2 % 3 + (i2 + j2) % 2) % 2 == 0;
          };
        default:
          throw "bad maskPattern:" + maskPattern;
      }
    };
    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      let a2 = qrPolynomial([1], 0);
      for (let i2 = 0; i2 < errorCorrectLength; i2 += 1) {
        a2 = a2.multiply(qrPolynomial([1, QRMath.gexp(i2)], 0));
      }
      return a2;
    };
    _this.getLengthInBits = function(mode2, type) {
      if (1 <= type && type < 10) {
        switch (mode2) {
          case QRMode.MODE_NUMBER:
            return 10;
          case QRMode.MODE_ALPHA_NUM:
            return 9;
          case QRMode.MODE_8BIT_BYTE:
            return 8;
          case QRMode.MODE_KANJI:
            return 8;
          default:
            throw "mode:" + mode2;
        }
      } else if (type < 27) {
        switch (mode2) {
          case QRMode.MODE_NUMBER:
            return 12;
          case QRMode.MODE_ALPHA_NUM:
            return 11;
          case QRMode.MODE_8BIT_BYTE:
            return 16;
          case QRMode.MODE_KANJI:
            return 10;
          default:
            throw "mode:" + mode2;
        }
      } else if (type < 41) {
        switch (mode2) {
          case QRMode.MODE_NUMBER:
            return 14;
          case QRMode.MODE_ALPHA_NUM:
            return 13;
          case QRMode.MODE_8BIT_BYTE:
            return 16;
          case QRMode.MODE_KANJI:
            return 12;
          default:
            throw "mode:" + mode2;
        }
      } else {
        throw "type:" + type;
      }
    };
    _this.getLostPoint = function(qrcode2) {
      const moduleCount = qrcode2.getModuleCount();
      let lostPoint = 0;
      for (let row7 = 0; row7 < moduleCount; row7 += 1) {
        for (let col = 0; col < moduleCount; col += 1) {
          let sameCount = 0;
          const dark = qrcode2.isDark(row7, col);
          for (let r2 = -1; r2 <= 1; r2 += 1) {
            if (row7 + r2 < 0 || moduleCount <= row7 + r2) {
              continue;
            }
            for (let c2 = -1; c2 <= 1; c2 += 1) {
              if (col + c2 < 0 || moduleCount <= col + c2) {
                continue;
              }
              if (r2 == 0 && c2 == 0) {
                continue;
              }
              if (dark == qrcode2.isDark(row7 + r2, col + c2)) {
                sameCount += 1;
              }
            }
          }
          if (sameCount > 5) {
            lostPoint += 3 + sameCount - 5;
          }
        }
      }
      ;
      for (let row7 = 0; row7 < moduleCount - 1; row7 += 1) {
        for (let col = 0; col < moduleCount - 1; col += 1) {
          let count = 0;
          if (qrcode2.isDark(row7, col)) count += 1;
          if (qrcode2.isDark(row7 + 1, col)) count += 1;
          if (qrcode2.isDark(row7, col + 1)) count += 1;
          if (qrcode2.isDark(row7 + 1, col + 1)) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }
      for (let row7 = 0; row7 < moduleCount; row7 += 1) {
        for (let col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode2.isDark(row7, col) && !qrcode2.isDark(row7, col + 1) && qrcode2.isDark(row7, col + 2) && qrcode2.isDark(row7, col + 3) && qrcode2.isDark(row7, col + 4) && !qrcode2.isDark(row7, col + 5) && qrcode2.isDark(row7, col + 6)) {
            lostPoint += 40;
          }
        }
      }
      for (let col = 0; col < moduleCount; col += 1) {
        for (let row7 = 0; row7 < moduleCount - 6; row7 += 1) {
          if (qrcode2.isDark(row7, col) && !qrcode2.isDark(row7 + 1, col) && qrcode2.isDark(row7 + 2, col) && qrcode2.isDark(row7 + 3, col) && qrcode2.isDark(row7 + 4, col) && !qrcode2.isDark(row7 + 5, col) && qrcode2.isDark(row7 + 6, col)) {
            lostPoint += 40;
          }
        }
      }
      let darkCount = 0;
      for (let col = 0; col < moduleCount; col += 1) {
        for (let row7 = 0; row7 < moduleCount; row7 += 1) {
          if (qrcode2.isDark(row7, col)) {
            darkCount += 1;
          }
        }
      }
      const ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;
      return lostPoint;
    };
    return _this;
  })();
  var QRMath = (function() {
    const EXP_TABLE = new Array(256);
    const LOG_TABLE = new Array(256);
    for (let i2 = 0; i2 < 8; i2 += 1) {
      EXP_TABLE[i2] = 1 << i2;
    }
    for (let i2 = 8; i2 < 256; i2 += 1) {
      EXP_TABLE[i2] = EXP_TABLE[i2 - 4] ^ EXP_TABLE[i2 - 5] ^ EXP_TABLE[i2 - 6] ^ EXP_TABLE[i2 - 8];
    }
    for (let i2 = 0; i2 < 255; i2 += 1) {
      LOG_TABLE[EXP_TABLE[i2]] = i2;
    }
    const _this = {};
    _this.glog = function(n3) {
      if (n3 < 1) {
        throw "glog(" + n3 + ")";
      }
      return LOG_TABLE[n3];
    };
    _this.gexp = function(n3) {
      while (n3 < 0) {
        n3 += 255;
      }
      while (n3 >= 256) {
        n3 -= 255;
      }
      return EXP_TABLE[n3];
    };
    return _this;
  })();
  var qrPolynomial = function(num3, shift) {
    if (typeof num3.length == "undefined") {
      throw num3.length + "/" + shift;
    }
    const _num = (function() {
      let offset = 0;
      while (offset < num3.length && num3[offset] == 0) {
        offset += 1;
      }
      const _num2 = new Array(num3.length - offset + shift);
      for (let i2 = 0; i2 < num3.length - offset; i2 += 1) {
        _num2[i2] = num3[i2 + offset];
      }
      return _num2;
    })();
    const _this = {};
    _this.getAt = function(index) {
      return _num[index];
    };
    _this.getLength = function() {
      return _num.length;
    };
    _this.multiply = function(e2) {
      const num4 = new Array(_this.getLength() + e2.getLength() - 1);
      for (let i2 = 0; i2 < _this.getLength(); i2 += 1) {
        for (let j2 = 0; j2 < e2.getLength(); j2 += 1) {
          num4[i2 + j2] ^= QRMath.gexp(QRMath.glog(_this.getAt(i2)) + QRMath.glog(e2.getAt(j2)));
        }
      }
      return qrPolynomial(num4, 0);
    };
    _this.mod = function(e2) {
      if (_this.getLength() - e2.getLength() < 0) {
        return _this;
      }
      const ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e2.getAt(0));
      const num4 = new Array(_this.getLength());
      for (let i2 = 0; i2 < _this.getLength(); i2 += 1) {
        num4[i2] = _this.getAt(i2);
      }
      for (let i2 = 0; i2 < e2.getLength(); i2 += 1) {
        num4[i2] ^= QRMath.gexp(QRMath.glog(e2.getAt(i2)) + ratio);
      }
      return qrPolynomial(num4, 0).mod(e2);
    };
    return _this;
  };
  var QRRSBlock = (function() {
    const RS_BLOCK_TABLE = [
      // L
      // M
      // Q
      // H
      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],
      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],
      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],
      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],
      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],
      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],
      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],
      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],
      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],
      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],
      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],
      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],
      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],
      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],
      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],
      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],
      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],
      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],
      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],
      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],
      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],
      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],
      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],
      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],
      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],
      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],
      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],
      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],
      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],
      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],
      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],
      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],
      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],
      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],
      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],
      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],
      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],
      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],
      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],
      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];
    const qrRSBlock = function(totalCount, dataCount) {
      const _this2 = {};
      _this2.totalCount = totalCount;
      _this2.dataCount = dataCount;
      return _this2;
    };
    const _this = {};
    const getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case QRErrorCorrectionLevel.L:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
        case QRErrorCorrectionLevel.M:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
        case QRErrorCorrectionLevel.Q:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
        case QRErrorCorrectionLevel.H:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
      const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
      if (typeof rsBlock == "undefined") {
        throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
      }
      const length = rsBlock.length / 3;
      const list4 = [];
      for (let i2 = 0; i2 < length; i2 += 1) {
        const count = rsBlock[i2 * 3 + 0];
        const totalCount = rsBlock[i2 * 3 + 1];
        const dataCount = rsBlock[i2 * 3 + 2];
        for (let j2 = 0; j2 < count; j2 += 1) {
          list4.push(qrRSBlock(totalCount, dataCount));
        }
      }
      return list4;
    };
    return _this;
  })();
  var qrBitBuffer = function() {
    const _buffer = [];
    let _length = 0;
    const _this = {};
    _this.getBuffer = function() {
      return _buffer;
    };
    _this.getAt = function(index) {
      const bufIndex = Math.floor(index / 8);
      return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
    };
    _this.put = function(num3, length) {
      for (let i2 = 0; i2 < length; i2 += 1) {
        _this.putBit((num3 >>> length - i2 - 1 & 1) == 1);
      }
    };
    _this.getLengthInBits = function() {
      return _length;
    };
    _this.putBit = function(bit) {
      const bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }
      if (bit) {
        _buffer[bufIndex] |= 128 >>> _length % 8;
      }
      _length += 1;
    };
    return _this;
  };
  var qrNumber = function(data) {
    const _mode = QRMode.MODE_NUMBER;
    const _data = data;
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return _data.length;
    };
    _this.write = function(buffer) {
      const data2 = _data;
      let i2 = 0;
      while (i2 + 2 < data2.length) {
        buffer.put(strToNum(data2.substring(i2, i2 + 3)), 10);
        i2 += 3;
      }
      if (i2 < data2.length) {
        if (data2.length - i2 == 1) {
          buffer.put(strToNum(data2.substring(i2, i2 + 1)), 4);
        } else if (data2.length - i2 == 2) {
          buffer.put(strToNum(data2.substring(i2, i2 + 2)), 7);
        }
      }
    };
    const strToNum = function(s2) {
      let num3 = 0;
      for (let i2 = 0; i2 < s2.length; i2 += 1) {
        num3 = num3 * 10 + chatToNum(s2.charAt(i2));
      }
      return num3;
    };
    const chatToNum = function(c2) {
      if ("0" <= c2 && c2 <= "9") {
        return c2.charCodeAt(0) - "0".charCodeAt(0);
      }
      throw "illegal char :" + c2;
    };
    return _this;
  };
  var qrAlphaNum = function(data) {
    const _mode = QRMode.MODE_ALPHA_NUM;
    const _data = data;
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return _data.length;
    };
    _this.write = function(buffer) {
      const s2 = _data;
      let i2 = 0;
      while (i2 + 1 < s2.length) {
        buffer.put(
          getCode(s2.charAt(i2)) * 45 + getCode(s2.charAt(i2 + 1)),
          11
        );
        i2 += 2;
      }
      if (i2 < s2.length) {
        buffer.put(getCode(s2.charAt(i2)), 6);
      }
    };
    const getCode = function(c2) {
      if ("0" <= c2 && c2 <= "9") {
        return c2.charCodeAt(0) - "0".charCodeAt(0);
      } else if ("A" <= c2 && c2 <= "Z") {
        return c2.charCodeAt(0) - "A".charCodeAt(0) + 10;
      } else {
        switch (c2) {
          case " ":
            return 36;
          case "$":
            return 37;
          case "%":
            return 38;
          case "*":
            return 39;
          case "+":
            return 40;
          case "-":
            return 41;
          case ".":
            return 42;
          case "/":
            return 43;
          case ":":
            return 44;
          default:
            throw "illegal char :" + c2;
        }
      }
    };
    return _this;
  };
  var qr8BitByte = function(data) {
    const _mode = QRMode.MODE_8BIT_BYTE;
    const _data = data;
    const _bytes = qrcode.stringToBytes(data);
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return _bytes.length;
    };
    _this.write = function(buffer) {
      for (let i2 = 0; i2 < _bytes.length; i2 += 1) {
        buffer.put(_bytes[i2], 8);
      }
    };
    return _this;
  };
  var qrKanji = function(data) {
    const _mode = QRMode.MODE_KANJI;
    const _data = data;
    const stringToBytes2 = qrcode.stringToBytes;
    !(function(c2, code) {
      const test = stringToBytes2(c2);
      if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
        throw "sjis not supported.";
      }
    })("\u53CB", 38726);
    const _bytes = stringToBytes2(data);
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };
    _this.write = function(buffer) {
      const data2 = _bytes;
      let i2 = 0;
      while (i2 + 1 < data2.length) {
        let c2 = (255 & data2[i2]) << 8 | 255 & data2[i2 + 1];
        if (33088 <= c2 && c2 <= 40956) {
          c2 -= 33088;
        } else if (57408 <= c2 && c2 <= 60351) {
          c2 -= 49472;
        } else {
          throw "illegal char at " + (i2 + 1) + "/" + c2;
        }
        c2 = (c2 >>> 8 & 255) * 192 + (c2 & 255);
        buffer.put(c2, 13);
        i2 += 2;
      }
      if (i2 < data2.length) {
        throw "illegal char at " + (i2 + 1);
      }
    };
    return _this;
  };
  var byteArrayOutputStream = function() {
    const _bytes = [];
    const _this = {};
    _this.writeByte = function(b2) {
      _bytes.push(b2 & 255);
    };
    _this.writeShort = function(i2) {
      _this.writeByte(i2);
      _this.writeByte(i2 >>> 8);
    };
    _this.writeBytes = function(b2, off2, len) {
      off2 = off2 || 0;
      len = len || b2.length;
      for (let i2 = 0; i2 < len; i2 += 1) {
        _this.writeByte(b2[i2 + off2]);
      }
    };
    _this.writeString = function(s2) {
      for (let i2 = 0; i2 < s2.length; i2 += 1) {
        _this.writeByte(s2.charCodeAt(i2));
      }
    };
    _this.toByteArray = function() {
      return _bytes;
    };
    _this.toString = function() {
      let s2 = "";
      s2 += "[";
      for (let i2 = 0; i2 < _bytes.length; i2 += 1) {
        if (i2 > 0) {
          s2 += ",";
        }
        s2 += _bytes[i2];
      }
      s2 += "]";
      return s2;
    };
    return _this;
  };
  var base64EncodeOutputStream = function() {
    let _buffer = 0;
    let _buflen = 0;
    let _length = 0;
    let _base64 = "";
    const _this = {};
    const writeEncoded = function(b2) {
      _base64 += String.fromCharCode(encode(b2 & 63));
    };
    const encode = function(n3) {
      if (n3 < 0) {
        throw "n:" + n3;
      } else if (n3 < 26) {
        return 65 + n3;
      } else if (n3 < 52) {
        return 97 + (n3 - 26);
      } else if (n3 < 62) {
        return 48 + (n3 - 52);
      } else if (n3 == 62) {
        return 43;
      } else if (n3 == 63) {
        return 47;
      } else {
        throw "n:" + n3;
      }
    };
    _this.writeByte = function(n3) {
      _buffer = _buffer << 8 | n3 & 255;
      _buflen += 8;
      _length += 1;
      while (_buflen >= 6) {
        writeEncoded(_buffer >>> _buflen - 6);
        _buflen -= 6;
      }
    };
    _this.flush = function() {
      if (_buflen > 0) {
        writeEncoded(_buffer << 6 - _buflen);
        _buffer = 0;
        _buflen = 0;
      }
      if (_length % 3 != 0) {
        const padlen = 3 - _length % 3;
        for (let i2 = 0; i2 < padlen; i2 += 1) {
          _base64 += "=";
        }
      }
    };
    _this.toString = function() {
      return _base64;
    };
    return _this;
  };
  var base64DecodeInputStream = function(str) {
    const _str = str;
    let _pos = 0;
    let _buffer = 0;
    let _buflen = 0;
    const _this = {};
    _this.read = function() {
      while (_buflen < 8) {
        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw "unexpected end of file./" + _buflen;
        }
        const c2 = _str.charAt(_pos);
        _pos += 1;
        if (c2 == "=") {
          _buflen = 0;
          return -1;
        } else if (c2.match(/^\s$/)) {
          continue;
        }
        _buffer = _buffer << 6 | decode(c2.charCodeAt(0));
        _buflen += 6;
      }
      const n3 = _buffer >>> _buflen - 8 & 255;
      _buflen -= 8;
      return n3;
    };
    const decode = function(c2) {
      if (65 <= c2 && c2 <= 90) {
        return c2 - 65;
      } else if (97 <= c2 && c2 <= 122) {
        return c2 - 97 + 26;
      } else if (48 <= c2 && c2 <= 57) {
        return c2 - 48 + 52;
      } else if (c2 == 43) {
        return 62;
      } else if (c2 == 47) {
        return 63;
      } else {
        throw "c:" + c2;
      }
    };
    return _this;
  };
  var gifImage = function(width, height2) {
    const _width = width;
    const _height = height2;
    const _data = new Array(width * height2);
    const _this = {};
    _this.setPixel = function(x2, y2, pixel) {
      _data[y2 * _width + x2] = pixel;
    };
    _this.write = function(out) {
      out.writeString("GIF87a");
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(128);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(255);
      out.writeByte(255);
      out.writeByte(255);
      out.writeString(",");
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);
      const lzwMinCodeSize = 2;
      const raster = getLZWRaster(lzwMinCodeSize);
      out.writeByte(lzwMinCodeSize);
      let offset = 0;
      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }
      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0);
      out.writeString(";");
    };
    const bitOutputStream = function(out) {
      const _out = out;
      let _bitLength = 0;
      let _bitBuffer = 0;
      const _this2 = {};
      _this2.write = function(data, length) {
        if (data >>> length != 0) {
          throw "length over";
        }
        while (_bitLength + length >= 8) {
          _out.writeByte(255 & (data << _bitLength | _bitBuffer));
          length -= 8 - _bitLength;
          data >>>= 8 - _bitLength;
          _bitBuffer = 0;
          _bitLength = 0;
        }
        _bitBuffer = data << _bitLength | _bitBuffer;
        _bitLength = _bitLength + length;
      };
      _this2.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };
      return _this2;
    };
    const getLZWRaster = function(lzwMinCodeSize) {
      const clearCode = 1 << lzwMinCodeSize;
      const endCode = (1 << lzwMinCodeSize) + 1;
      let bitLength = lzwMinCodeSize + 1;
      const table = lzwTable();
      for (let i2 = 0; i2 < clearCode; i2 += 1) {
        table.add(String.fromCharCode(i2));
      }
      table.add(String.fromCharCode(clearCode));
      table.add(String.fromCharCode(endCode));
      const byteOut = byteArrayOutputStream();
      const bitOut = bitOutputStream(byteOut);
      bitOut.write(clearCode, bitLength);
      let dataIndex = 0;
      let s2 = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;
      while (dataIndex < _data.length) {
        const c2 = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;
        if (table.contains(s2 + c2)) {
          s2 = s2 + c2;
        } else {
          bitOut.write(table.indexOf(s2), bitLength);
          if (table.size() < 4095) {
            if (table.size() == 1 << bitLength) {
              bitLength += 1;
            }
            table.add(s2 + c2);
          }
          s2 = c2;
        }
      }
      bitOut.write(table.indexOf(s2), bitLength);
      bitOut.write(endCode, bitLength);
      bitOut.flush();
      return byteOut.toByteArray();
    };
    const lzwTable = function() {
      const _map = {};
      let _size = 0;
      const _this2 = {};
      _this2.add = function(key) {
        if (_this2.contains(key)) {
          throw "dup key:" + key;
        }
        _map[key] = _size;
        _size += 1;
      };
      _this2.size = function() {
        return _size;
      };
      _this2.indexOf = function(key) {
        return _map[key];
      };
      _this2.contains = function(key) {
        return typeof _map[key] != "undefined";
      };
      return _this2;
    };
    return _this;
  };
  var createDataURL = function(width, height2, getPixel) {
    const gif = gifImage(width, height2);
    for (let y2 = 0; y2 < height2; y2 += 1) {
      for (let x2 = 0; x2 < width; x2 += 1) {
        gif.setPixel(x2, y2, getPixel(x2, y2));
      }
    }
    const b2 = byteArrayOutputStream();
    gif.write(b2);
    const base64 = base64EncodeOutputStream();
    const bytes = b2.toByteArray();
    for (let i2 = 0; i2 < bytes.length; i2 += 1) {
      base64.writeByte(bytes[i2]);
    }
    base64.flush();
    return "data:image/gif;base64," + base64;
  };
  var qrcode_default = qrcode;
  var stringToBytes = qrcode.stringToBytes;

  // src/ts/editor/sharetext.ts
  var GUIDE_URL = "https://ll-nick.github.io/inkflow/editor/share-online/";
  function onlineSummary(o2) {
    const host5 = o2.relay ? o2.relay.replace(/^https?:\/\//, "") : "";
    if (!o2.sharing) {
      return {
        text: `Not shared online. Share it to get links that work from anywhere, through ${host5}.`,
        error: null
      };
    }
    switch (o2.state) {
      case "open": {
        const n3 = o2.guests ?? 0;
        const who = n3 === 0 ? "no one has joined yet" : n3 === 1 ? "1 guest connected" : `${n3} guests connected`;
        return {
          text: `Shared online through ${host5}: ${who}.`,
          error: null
        };
      }
      case "retrying":
        return {
          text: `Reconnecting to ${host5}\u2026 (the links work again once it is back)`,
          error: o2.error ?? null
        };
      case "error":
        return {
          text: `Could not share through ${host5}.`,
          error: o2.error ?? "the relay refused"
        };
      default:
        return { text: `Connecting to ${host5}\u2026`, error: null };
    }
  }

  // src/ts/editor/sshtext.ts
  var DEFAULT_PORT = 7777;
  var LOGIN_PLACEHOLDER = "you@server";
  var USER_PLACEHOLDER = "<your-user>";
  var SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
  function shellQuote2(text) {
    if (text === "") return "''";
    if (SAFE.test(text)) return text;
    if (!text.includes("'")) return `'${text}'`;
    if (!/[$`"\\!]/.test(text)) return `"${text}"`;
    return `'${text.replaceAll("'", `'"'"'`)}'`;
  }
  function parsePort(text, fallback) {
    const t2 = text.trim();
    if (!/^\d{1,5}$/.test(t2)) return fallback;
    const n3 = Number(t2);
    return n3 >= 1 && n3 <= 65535 ? n3 : fallback;
  }
  function forward(local, remote) {
    return `-L ${local}:localhost:${remote}`;
  }
  function linkAt(url, port) {
    try {
      const u2 = new URL(url);
      u2.port = String(port);
      return u2.toString();
    } catch {
      return url;
    }
  }
  function codeParts(text) {
    return text.split("`").map((part, i2) => ({ text: part, code: i2 % 2 === 1 })).filter((p2) => p2.text !== "");
  }
  function login(text) {
    const t2 = text.trim();
    return shellQuote2(t2 || LOGIN_PLACEHOLDER);
  }
  function inkflowCommand(info4) {
    if (!info4.pinned) return "inkflow";
    const project = info4.project ? ` --project ${shellQuote2(info4.project)}` : "";
    return `uv run${project} inkflow`;
  }
  function startCommand(info4, port) {
    const parts = [inkflowCommand(info4), "edit", "--no-open", "--ssh"];
    if (port !== DEFAULT_PORT) parts.push("--port", String(port));
    if (info4.deck !== "deck.py") parts.push("--deck", shellQuote2(info4.deck));
    return parts.join(" ");
  }
  function folderOf(info4) {
    return info4.folder || "deck";
  }
  function moveSteps(info4, loginText, port) {
    const to = login(loginText);
    const folder = shellQuote2(folderOf(info4));
    const remote = info4.remote ? shellQuote2(info4.remote) : "<repository URL>";
    const steps = [];
    if (info4.inRepo && info4.remote) {
      steps.push({
        title: "Push your latest changes",
        text: "The server clones the deck from its repository: commit and push what you changed (Git menu \u2192 Commit, then Push).",
        commands: [],
        notes: []
      });
    } else {
      steps.push({
        title: "Give the deck a repository the server can clone",
        text: info4.inRepo ? "The deck's repository has no remote yet. Create an empty repository (on GitHub or GitLab, say), then add it here and push:" : "The deck is not in a git repository yet: commit it first (Git menu), then create an empty repository (on GitHub or GitLab, say), add it and push:",
        commands: [
          "git remote add origin <repository URL>",
          `git push -u origin ${shellQuote2(info4.branch || "main")}`
        ],
        notes: []
      });
    }
    steps.push({
      title: "Log in to the server with the port forwarded",
      text: `Everything below runs on the server, in this login. The tunnel brings its port ${port} to this computer.`,
      commands: [`ssh ${forward(port, port)} ${to}`],
      notes: [
        "To keep inkflow running when the connection drops, start `tmux new -A -s inkflow` (or `screen`) first and run the next steps in it; the same command gets back to it after logging in again.",
        "A private repository: `ssh -A` lets the server clone with your own keys (whoever administers the server can use them while you are logged in), or clone with an HTTPS access token."
      ]
    });
    const install = ["curl -LsSf https://astral.sh/uv/install.sh | sh"];
    install.push("source $HOME/.local/bin/env");
    if (!info4.pinned)
      install.push(`uv tool install ${shellQuote2(info4.requirement)}`);
    install.push(`git clone ${remote} ${folder}`, `cd ${folder}`);
    steps.push({
      title: "On the server, once: install inkflow and get the deck",
      text: info4.pinned ? "uv runs inkflow; the deck's pyproject.toml pins the version, which `uv run` installs the first time. Skip what the server has already." : "uv installs inkflow, at the version this deck runs on. Skip what the server has already.",
      commands: install,
      notes: []
    });
    steps.push({
      title: "Start the editor",
      text: `It prints an owner link, \`http://localhost:${port}/edit?k=\u2026\`. If it says port ${port} is taken, it uses the next free one: log in again forwarding that one.`,
      commands: [startCommand(info4, port)],
      notes: []
    });
    steps.push({
      title: "On this computer, open the owner link",
      text: "Open the link it printed in your browser here. You are the owner there, editing the server's copy of the deck; nobody else on the server is.",
      commands: [],
      notes: []
    });
    steps.push({
      title: "Invite others",
      text: "There, Share \u2192 Share via SSH writes the commands and the message for your collaborators. They need an SSH login on the server.",
      commands: [],
      notes: []
    });
    steps.push({
      title: "When you are done",
      text: "Commit and push on the server (its Git menu), then pull here:",
      commands: ["git pull"],
      notes: []
    });
    return steps;
  }
  function nextTimeCommand(info4, loginText, port) {
    const inner = `cd ${shellQuote2(folderOf(info4))} && git pull && ${startCommand(info4, port)}`;
    const remote = `bash -lc ${shellQuote2(inner)}`;
    return `ssh -t ${forward(port, port)} ${login(loginText)} ${shellQuote2(remote)}`;
  }
  function guestTunnel(server, localPort, serverPort) {
    const host5 = server.trim() || "server";
    const at3 = SAFE.test(host5) ? `${USER_PLACEHOLDER}@${host5}` : shellQuote2(`${USER_PLACEHOLDER}@${host5}`);
    return `ssh -N ${forward(localPort, serverPort)} ${at3}`;
  }
  function guestMessage(role, link, server, localPort, serverPort) {
    const host5 = server.trim() || "server";
    const what = role === "editor" ? "To edit the deck with me" : "To watch the presentation";
    return [
      `${what} (you need an SSH login on ${host5}):`,
      "",
      `1. In a terminal, run this, with your own login on ${host5} in place of ${USER_PLACEHOLDER}. Keep it open; it shows nothing. (On Windows, the same command works in PowerShell.)`,
      "",
      `   ${guestTunnel(host5, localPort, serverPort)}`,
      "",
      "2. Open this link in your browser:",
      "",
      `   ${linkAt(link, localPort)}`,
      "",
      localPort === serverPort ? `If port ${localPort} is taken on your computer, use another one in both places (the first number in the command and the one in the link).` : ""
    ].join("\n").trimEnd();
  }

  // src/ts/editor/sshdialog.ts
  var LOGIN_KEY = "inkflow-ssh-login";
  var SERVER_KEY = "inkflow-ssh-server";
  function stored(key) {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  }
  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  }
  function rich(text) {
    return codeParts(text).map(
      (p2) => p2.code ? h("code", {}, p2.text) : p2.text
    );
  }
  function commandBlock(text, what, copy3) {
    return h(
      "div",
      { class: "ssh-copy" },
      h("pre", { class: "ssh-command" }, text),
      h(
        "button",
        { type: "button", class: "pbtn", onclick: () => copy3(text, what) },
        "Copy"
      )
    );
  }
  function field(label4, input, hint) {
    return h(
      "label",
      { class: "ssh-field" },
      h("span", { class: "field-label" }, label4),
      input,
      hint ? h("span", { class: "hint" }, hint) : null
    );
  }
  function textInput2(value, placeholder, width) {
    return h("input", {
      type: "text",
      value,
      placeholder,
      spellcheck: "false",
      autocomplete: "off",
      style: width ? `width:${width}` : void 0
    });
  }
  function stepList(steps, copy3) {
    const list4 = h("ol", { class: "ssh-steps" });
    for (const step2 of steps) {
      list4.append(
        h(
          "li",
          {},
          h("strong", {}, step2.title),
          h("p", {}, ...rich(step2.text)),
          step2.commands.length ? commandBlock(step2.commands.join("\n"), "Command", copy3) : null,
          ...step2.notes.map((n3) => h("p", { class: "hint" }, ...rich(n3)))
        )
      );
    }
    return list4;
  }
  function header(title3, back) {
    return h(
      "div",
      { class: "ssh-head" },
      h("button", { type: "button", class: "pbtn", onclick: back }, "\u2190 Back"),
      h("h3", {}, title3)
    );
  }
  function setupPicture(here) {
    const box2 = (title3, lines, mark) => h(
      "div",
      { class: `ssh-box${mark ? " here" : ""}` },
      mark ? h("span", { class: "ssh-here" }, "you are here") : null,
      h("strong", {}, title3),
      ...lines.map((l2) => h("span", {}, l2))
    );
    const tunnel = (dir) => h(
      "div",
      { class: "ssh-tunnel" },
      h(
        "span",
        { class: "ssh-across" },
        dir === "right" ? "SSH tunnel \u2192" : "\u2190 SSH tunnel"
      ),
      h(
        "span",
        { class: "ssh-down" },
        dir === "right" ? "\u2193 SSH tunnel" : "\u2191 SSH tunnel"
      )
    );
    return h(
      "div",
      { class: "ssh-picture" },
      h(
        "div",
        { class: "ssh-machines" },
        box2(
          "Your computer",
          ["a browser", "opens the owner link"],
          here === "laptop"
        ),
        tunnel("right"),
        box2(
          "The server",
          ["runs inkflow", "holds the deck (a git clone)"],
          here === "server"
        ),
        tunnel("left"),
        box2(
          "Each collaborator's computer",
          ["a browser + ssh", "opens an editor or view link"],
          false
        )
      ),
      h(
        "p",
        { class: "hint" },
        "Your collaborators install nothing: no inkflow, no git, no copy of the deck. They need an SSH login on the server and a browser. Give each their own login: someone logged in with your account is you there (your files, your shell, your owner link)."
      )
    );
  }
  function moveView(status3, opts2) {
    let current3 = status3;
    const login2 = textInput2(
      stored(LOGIN_KEY),
      "you@server.example.com",
      "100%"
    );
    const port = textInput2(String(status3.port), String(status3.port), "7em");
    const out = h("div", { class: "ssh-out" });
    const draw = () => {
      clear(out);
      const info4 = current3.sshInfo;
      if (!info4) {
        out.append(h("p", { class: "hint" }, "\u2026"));
        return;
      }
      const p2 = parsePort(port.value, current3.port);
      out.append(stepList(moveSteps(info4, login2.value, p2), opts2.copy));
      out.append(
        h("h3", {}, "Next time"),
        h(
          "p",
          {},
          "Log in, update the deck and start the editor in one go (it stops when the connection closes):"
        ),
        commandBlock(
          nextTimeCommand(info4, login2.value, p2),
          "Command",
          opts2.copy
        )
      );
    };
    login2.addEventListener("input", () => {
      store(LOGIN_KEY, login2.value.trim());
      draw();
    });
    port.addEventListener("input", draw);
    const element = h(
      "div",
      { class: "ssh-view" },
      header(
        "Move this deck to a server and edit it there together",
        opts2.back
      ),
      h(
        "p",
        {},
        "On a server you and your collaborators can log in to over SSH, the deck runs once for everyone: each of you opens it through an SSH tunnel, and nothing listens on the network. The steps below are yours; the last ones give you the message to send your collaborators."
      ),
      setupPicture("laptop"),
      h(
        "div",
        { class: "ssh-fields" },
        field("Server login", login2),
        field("Port", port)
      ),
      out
    );
    draw();
    return {
      element,
      update: (s2) => {
        const had = current3.sshInfo;
        current3 = s2;
        if (!had && s2.sshInfo) draw();
      }
    };
  }
  function inviteView(status3, opts2) {
    let current3 = status3;
    const info4 = status3.sshInfo;
    const guess = stored(SERVER_KEY) || info4?.serverNames[0] || "";
    const server = textInput2(guess, "server.example.com", "100%");
    const localPort = textInput2(
      String(status3.port),
      String(status3.port),
      "7em"
    );
    const out = h("div", { class: "ssh-out" });
    let drawn2 = "";
    const draw = (force = false) => {
      const s2 = current3;
      const key = JSON.stringify([
        s2.sharing,
        s2.links,
        server.value,
        localPort.value
      ]);
      if (!force && key === drawn2) return;
      drawn2 = key;
      clear(out);
      if (!s2.sharing || !s2.links.length) {
        out.append(
          h(
            "div",
            { class: "share-state" },
            h(
              "p",
              {},
              "The links are off. Turn them on to invite people; they still reach the deck only through SSH."
            ),
            h(
              "button",
              {
                type: "button",
                class: "pbtn primary",
                onclick: opts2.turnOn
              },
              "Turn on links"
            )
          )
        );
        return;
      }
      const link = s2.links[0];
      const local = parsePort(localPort.value, s2.port);
      const host5 = server.value.trim();
      for (const [role, url, title3] of [
        ["editor", link.editor, "For an editor"],
        ["viewer", link.view, "For a viewer"]
      ]) {
        const message = guestMessage(role, url, host5, local, s2.port);
        out.append(
          h("h3", {}, title3),
          h(
            "p",
            { class: "hint" },
            role === "editor" ? "Edits the deck with you." : "Watches the presentation and follows your slide."
          ),
          commandBlock(message, "Message", opts2.copy),
          h(
            "details",
            { class: "ssh-parts" },
            h("summary", {}, "The command and the link alone"),
            commandBlock(
              guestTunnel(host5, local, s2.port),
              "Command",
              opts2.copy
            ),
            commandBlock(linkAt(url, local), "Link", opts2.copy)
          )
        );
      }
      out.append(
        h(
          "p",
          { class: "hint" },
          "Whoever has the editor link and a login on this server can edit the deck's files (not the server's, and not git or programs). New links in the Share dialog disconnects everyone holding the old ones."
        )
      );
    };
    server.addEventListener("input", () => {
      store(SERVER_KEY, server.value.trim());
      draw();
    });
    localPort.addEventListener("input", () => draw());
    const user = info4?.user ? ` (you logged in as ${info4.user})` : "";
    const element = h(
      "div",
      { class: "ssh-view" },
      header("Invite collaborators through SSH", opts2.back),
      h(
        "p",
        {},
        `This editor runs on a server in SSH mode${user}. Each collaborator logs in to it with their own SSH account, forwarding a port, and opens their link through that tunnel. Nothing listens on the network.`
      ),
      setupPicture("server"),
      h(
        "div",
        { class: "ssh-fields" },
        field(
          "Server address",
          server,
          info4?.serverNames.length ? `The name they log in to (guessed: ${info4.serverNames.join(", ")}).` : "The name they log in to."
        ),
        field(
          "Their local port",
          localPort,
          "Where the tunnel ends on their computer; another one if theirs is busy."
        )
      ),
      out
    );
    draw(true);
    return {
      element,
      update: (s2) => {
        current3 = s2;
        const names2 = s2.sshInfo?.serverNames ?? [];
        if (!server.value && names2.length) server.value = names2[0];
        draw();
      }
    };
  }
  function sshView(status3, opts2) {
    return status3.ssh ? inviteView(status3, opts2) : moveView(status3, opts2);
  }

  // src/ts/editor/share.ts
  var status2 = null;
  var body2 = null;
  var ssh = null;
  var button9 = document.getElementById("btn-share");
  function qrSvg(text) {
    const qr = qrcode_default(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  }
  function copy2(text, what) {
    const done = () => toast(`${what} copied`, "ok");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const area2 = h("textarea", {}, text);
      document.body.append(area2);
      area2.select();
      try {
        document.execCommand("copy");
        done();
      } catch {
        toast("Select the link and copy it", "error");
      }
      area2.remove();
    }
  }
  function linkRow(label4, url, hint, withQr = true) {
    const qr = h("div", { class: "share-qr", title: `QR code: ${label4}` });
    qr.innerHTML = qrSvg(url);
    return h(
      "div",
      { class: "share-link" },
      withQr ? qr : null,
      h(
        "div",
        { class: "share-link-text" },
        h("strong", {}, label4),
        h("span", { class: "hint" }, hint),
        h("input", {
          type: "text",
          readonly: true,
          value: url,
          onfocus: (e2) => e2.target.select()
        }),
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => copy2(url, label4)
          },
          "Copy"
        )
      )
    );
  }
  function openSsh() {
    if (!body2 || !status2) return;
    ssh = sshView(status2, {
      back: () => {
        ssh = null;
        render5();
      },
      copy: copy2,
      turnOn: () => sendRaw({ type: "share", op: "on" })
    });
    clear(body2);
    body2.append(ssh.element);
  }
  function sshSection(s2) {
    return h(
      "section",
      { class: "share-ssh" },
      h("h3", { class: "share-section" }, "Over SSH"),
      h(
        "div",
        { class: "share-state" },
        h(
          "p",
          { class: "hint" },
          s2.ssh ? "The commands and the message for each collaborator's tunnel." : "Move the deck to a server you and others can log in to, and edit it there together through SSH tunnels."
        ),
        h(
          "button",
          { type: "button", class: "pbtn", onclick: openSsh },
          "Share via SSH"
        )
      )
    );
  }
  function stateText(s2) {
    if (s2.ssh) {
      return s2.sharing ? "SSH mode: people with a link below join through an SSH tunnel to this server." : "SSH mode: this server is reached through SSH tunnels only. Turn the links on to invite people.";
    }
    return s2.sharing ? "Shared on the network: people with a link below can join." : "Only this computer can open the deck. Share it to give people on the same network (or VPN) a link.";
  }
  function render5() {
    if (!body2 || !status2) return;
    if (ssh) {
      ssh.update(status2);
      return;
    }
    clear(body2);
    const s2 = status2;
    const onLabel = s2.ssh ? "Turn on links" : "Share on the network";
    body2.append(
      h(
        "h3",
        { class: "share-section" },
        s2.ssh ? "Through SSH tunnels" : "On this network"
      )
    );
    body2.append(
      h(
        "div",
        { class: "share-state" },
        h("p", {}, stateText(s2)),
        h(
          "button",
          {
            type: "button",
            class: s2.sharing ? "pbtn" : "pbtn primary",
            onclick: () => sendRaw({
              type: "share",
              op: s2.sharing ? "off" : "on"
            })
          },
          s2.sharing ? "Stop sharing" : onLabel
        )
      )
    );
    if (s2.error) body2.append(h("p", { class: "share-error" }, s2.error));
    if (s2.sharing) {
      if (!s2.links.length) {
        body2.append(
          h(
            "p",
            { class: "hint" },
            "No network address found. Start inkflow with --host <address>."
          )
        );
      }
      for (const link of s2.links) {
        body2.append(
          h(
            "section",
            { class: "share-address" },
            h(
              "h3",
              {},
              s2.ssh ? "Through each guest's tunnel" : link.address
            ),
            linkRow(
              "Editor link",
              link.editor,
              "Edits the deck with you (not your computer's files, git or programs).",
              !s2.ssh
            ),
            linkRow(
              "View link",
              link.view,
              "Watches the presentation and follows your slide.",
              !s2.ssh
            )
          )
        );
      }
      if (s2.names.length) {
        body2.append(
          h(
            "p",
            { class: "hint" },
            `The same links also work with ${s2.names.join(", ")} in place of the address, where the network supports it.`
          )
        );
      }
      body2.append(
        h(
          "div",
          { class: "share-actions" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => {
                if (confirm(
                  "Make new links? Everyone who joined with the current ones is disconnected."
                )) {
                  sendRaw({ type: "share", op: "rotate" });
                }
              }
            },
            "New links"
          )
        ),
        h(
          "p",
          { class: "hint" },
          s2.ssh ? "Each guest needs a login on this server for their tunnel; the links travel inside it, encrypted." : "The links travel unencrypted on the network: on a network you do not trust, share over SSH or a VPN instead."
        )
      );
    }
    body2.append(sshSection(s2));
    if (s2.online) renderOnline(body2, s2.online);
    const people = s2.people.filter((p2) => p2.id !== collab.me?.id);
    body2.append(
      h("h3", {}, people.length ? "Connected" : "No one else is connected")
    );
    const list4 = h("ul", { class: "share-people" });
    for (const p2 of people) {
      const where = p2.slide == null ? "" : p2.page === "presenter" ? `presenting slide ${p2.slide + 1}` : `on slide ${p2.slide + 1}`;
      list4.append(
        h(
          "li",
          {},
          h("span", { class: "who" }, p2.name),
          h(
            "span",
            { class: "hint" },
            `${p2.role}${p2.online ? " \xB7 online" : ""}${where ? ` \xB7 ${where}` : ""}`
          ),
          p2.role === "owner" ? null : h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => sendRaw({
                type: "share",
                op: "kick",
                id: p2.id
              })
            },
            "Disconnect"
          )
        )
      );
    }
    body2.append(list4);
  }
  var editingRelay = false;
  function renderOnline(into, o2) {
    const sharing = o2.sharing;
    into.append(h("h3", { class: "share-section" }, "Online"));
    if (!o2.available) {
      into.append(
        h("p", {}, "Sharing online needs one more package here:"),
        h("p", {}, h("code", {}, o2.installHint))
      );
      return;
    }
    if (!o2.relay || editingRelay) {
      into.append(relayForm(o2));
      return;
    }
    const summary2 = onlineSummary(o2);
    into.append(
      h(
        "div",
        { class: "share-state" },
        h("p", {}, summary2.text),
        h(
          "button",
          {
            type: "button",
            class: sharing ? "pbtn" : "pbtn primary",
            "data-op": sharing ? "online-off" : "online-on",
            onclick: () => sendRaw({
              type: "share",
              op: sharing ? "online-off" : "online-on"
            })
          },
          sharing ? "Stop sharing online" : "Share online"
        )
      )
    );
    if (summary2.error) {
      into.append(h("p", { class: "share-error" }, summary2.error));
    }
    if (o2.links) {
      into.append(
        h(
          "section",
          { class: "share-online-links" },
          linkRow(
            "Online editor link",
            o2.links.editor,
            "Edits the deck with you from anywhere (not your computer's files, git or programs)."
          ),
          linkRow(
            "Online view link",
            o2.links.view,
            "Watches the presentation from anywhere and follows your slide."
          )
        )
      );
    }
    const rotate = () => {
      if (confirm(
        "Make new online links? Everyone who joined online with the current ones is disconnected."
      )) {
        sendRaw({ type: "share", op: "online-rotate" });
      }
    };
    into.append(
      h(
        "div",
        { class: "share-actions" },
        sharing && o2.links ? h(
          "button",
          { type: "button", class: "pbtn", onclick: rotate },
          "New online links"
        ) : null,
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            disabled: sharing,
            title: sharing ? "Stop sharing online to change the relay" : null,
            onclick: () => {
              editingRelay = true;
              render5();
            }
          },
          "Change relay\u2026"
        )
      ),
      h(
        "p",
        { class: "hint" },
        "End-to-end encrypted: the relay passes the deck on without being able to read it. A link is its key: anyone with the editor link can edit until you make new links."
      )
    );
  }
  function relayForm(o2) {
    const url = h("input", {
      type: "url",
      placeholder: "https://inkflow-relay.you.workers.dev",
      value: o2.relay ?? "",
      "aria-label": "Relay address"
    });
    const token = h("input", {
      type: "password",
      placeholder: "Access token (if the relay has one)",
      "aria-label": "Access token",
      autocomplete: "off"
    });
    const save5 = () => {
      editingRelay = false;
      sendRaw({
        type: "share",
        op: "relay-set",
        url: url.value.trim(),
        token: token.value.trim()
      });
    };
    return h(
      "div",
      { class: "share-relay" },
      h(
        "p",
        {},
        o2.relay ? "The relay sharing online goes through: " : "Sharing online goes through a relay of your own: a free Cloudflare Worker, or a server you run. ",
        h(
          "a",
          { href: GUIDE_URL, target: "_blank", rel: "noopener" },
          "How to set one up"
        )
      ),
      h(
        "div",
        { class: "share-relay-fields" },
        url,
        token,
        h(
          "button",
          { type: "button", class: "pbtn primary", onclick: save5 },
          "Use this relay"
        ),
        o2.relay ? h(
          "button",
          {
            type: "button",
            class: "pbtn",
            onclick: () => {
              editingRelay = false;
              render5();
            }
          },
          "Cancel"
        ) : null
      ),
      h(
        "p",
        { class: "hint" },
        "Or in a terminal: ",
        h("code", {}, "inkflow relay deploy cloudflare"),
        " deploys one and sets it here."
      )
    );
  }
  function setStatus(msg) {
    status2 = msg;
    if (button9) {
      button9.classList.toggle(
        "on",
        status2.sharing || Boolean(status2.online?.sharing)
      );
    }
    if (status2.error) toast(status2.error, "error");
    if (body2 && dialogOpen()) render5();
  }
  function openShare() {
    body2 = h("div", { class: "share-dialog" }, h("p", {}, "\u2026"));
    ssh = null;
    openDialog("Share", body2, {
      wide: true,
      onClose: () => {
        body2 = null;
        ssh = null;
      }
    });
    sendRaw({ type: "share", op: "status" });
    render5();
  }
  function initShare() {
    onMessage("share-status", setStatus);
    button9?.addEventListener("click", openShare);
  }

  // src/ts/shared/gesturepad.ts
  var CLICK_AFTER_MS = 400;
  var PALM_MS2 = 1500;
  var WHEEL_END_MS = 160;
  function at2(e2) {
    return { x: e2.clientX, y: e2.clientY };
  }
  function replica(type, src, pos = src) {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: src.pointerId,
      pointerType: src.pointerType,
      isPrimary: src.isPrimary,
      clientX: pos.clientX,
      clientY: pos.clientY,
      screenX: pos.screenX,
      screenY: pos.screenY,
      width: pos.width,
      height: pos.height,
      pressure: type === "pointerup" ? 0 : pos.pressure || 0.5,
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" ? 0 : 1,
      ctrlKey: pos.ctrlKey,
      shiftKey: pos.shiftKey,
      altKey: pos.altKey,
      metaKey: pos.metaKey
    });
  }
  function stop(e2) {
    e2.stopImmediatePropagation();
    if (e2.cancelable) e2.preventDefault();
  }
  var GesturePad = class {
    touch;
    host;
    // Touch pointers in the current sequence.
    ours = /* @__PURE__ */ new Set();
    deferred = null;
    replaying = false;
    timer = 0;
    clicksAfter = -Infinity;
    penNear = -Infinity;
    pensDown = /* @__PURE__ */ new Set();
    // This frame's batch.
    frame = 0;
    zoomLog = 0;
    from = null;
    to = null;
    source = "wheel";
    panX = 0;
    panY = 0;
    wheelTimer = 0;
    safariScale = 1;
    constructor(host5, tracker = new TouchTracker()) {
      this.host = host5;
      this.touch = tracker;
      const opts2 = { capture: true };
      window.addEventListener("pointerdown", (e2) => this.down(e2), opts2);
      window.addEventListener("pointermove", (e2) => this.move(e2), opts2);
      window.addEventListener("pointerup", (e2) => this.up(e2, false), opts2);
      window.addEventListener("pointercancel", (e2) => this.up(e2, true), opts2);
      window.addEventListener("click", (e2) => this.claimClick(e2), opts2);
      window.addEventListener("dblclick", (e2) => this.claimClick(e2), opts2);
      const s2 = host5.surface;
      s2.addEventListener("wheel", (e2) => this.wheel(e2), { passive: false });
      s2.addEventListener("gesturestart", (e2) => this.gesture(e2, "start"));
      s2.addEventListener("gesturechange", (e2) => this.gesture(e2, "change"));
      s2.addEventListener("gestureend", (e2) => this.gesture(e2, "end"));
    }
    // The touch sequence in progress (or the one that just ended) had a
    // second finger: it is no swipe and no tap.
    get multiTouch() {
      return this.touch.multiTouch;
    }
    // Two fingers are zooming, or one is left over from them.
    get claimed() {
      return this.touch.claimed;
    }
    // ── Touch ──
    palm() {
      return this.pensDown.size > 0 || performance.now() - this.penNear < PALM_MS2;
    }
    down(e2) {
      if (e2.pointerType === "pen") {
        this.penNear = performance.now();
        this.pensDown.add(e2.pointerId);
        return;
      }
      if (e2.pointerType !== "touch" || this.replaying) return;
      const target = e2.target;
      if (!target || !this.host.surface.contains(target)) return;
      if (!this.touch.active) {
        if (this.palm() || this.host.accepts?.(e2) === false) return;
      }
      const v2 = this.touch.down(e2.pointerId, at2(e2), performance.now());
      this.ours.add(e2.pointerId);
      if (v2.cancelSingle) this.rollback();
      if (v2.pinchStart) {
        this.source = "pinch";
        this.clicksAfter = Infinity;
      }
      if (!v2.pass) {
        stop(e2);
        return;
      }
      if (this.host.defer?.(e2)) {
        this.deferred = { target, down: e2, last: e2 };
        stop(e2);
        clearTimeout(this.timer);
        this.timer = window.setTimeout(
          () => this.tick(),
          this.touch.opts.windowMs + 10
        );
      }
    }
    rollback() {
      if (this.deferred) {
        this.deferred = null;
        clearTimeout(this.timer);
      } else {
        this.host.cancelSingle?.();
      }
    }
    move(e2) {
      if (e2.pointerType === "pen") {
        this.penNear = performance.now();
        return;
      }
      if (this.replaying || !this.ours.has(e2.pointerId)) return;
      const v2 = this.touch.move(e2.pointerId, at2(e2), performance.now());
      this.queuePinch(v2);
      if (!v2.pass) {
        stop(e2);
        return;
      }
      const d2 = this.deferred;
      if (d2 && d2.down.pointerId === e2.pointerId) {
        if (v2.commit) {
          this.replayDown();
        } else {
          d2.last = e2;
          stop(e2);
        }
      }
    }
    tick() {
      const d2 = this.deferred;
      if (!d2) return;
      const v2 = this.touch.tick(performance.now());
      if (!v2.commit) {
        return;
      }
      this.replayDown();
      this.replay(replica("pointermove", d2.down, d2.last), d2.target);
    }
    replayDown() {
      const d2 = this.deferred;
      if (!d2) return;
      this.deferred = null;
      clearTimeout(this.timer);
      this.replay(replica("pointerdown", d2.down), d2.target);
    }
    replay(e2, target) {
      const aim = target.isConnected ? target : document.elementFromPoint(e2.clientX, e2.clientY);
      if (!aim) return;
      this.replaying = true;
      try {
        aim.dispatchEvent(e2);
      } finally {
        this.replaying = false;
      }
    }
    up(e2, cancelled) {
      if (e2.pointerType === "pen") {
        this.penNear = performance.now();
        this.pensDown.delete(e2.pointerId);
        return;
      }
      if (this.replaying || !this.ours.has(e2.pointerId)) return;
      const v2 = this.touch.up(
        e2.pointerId,
        at2(e2),
        performance.now(),
        cancelled
      );
      this.ours.delete(e2.pointerId);
      if (!this.touch.active) this.ours.clear();
      if (v2.pinchEnd) {
        this.flush();
        this.host.zoomEnd?.("pinch");
      }
      if (this.touch.multiTouch) {
        this.clicksAfter = this.touch.active ? Infinity : performance.now() + CLICK_AFTER_MS;
      }
      if (!v2.pass) {
        stop(e2);
        return;
      }
      const d2 = this.deferred;
      if (d2 && d2.down.pointerId === e2.pointerId) {
        if (cancelled) {
          this.deferred = null;
          clearTimeout(this.timer);
          stop(e2);
          return;
        }
        this.replayDown();
        if (v2.moved)
          this.replay(replica("pointermove", d2.down, e2), d2.target);
      }
      if (v2.doubleTap) {
        this.host.doubleTap?.(v2.doubleTap, e2.target);
      }
    }
    claimClick(e2) {
      if (this.touch.claimed || performance.now() < this.clicksAfter) {
        e2.stopImmediatePropagation();
        e2.preventDefault();
      }
    }
    // ── Wheel and Safari gestures ──
    wheel(e2) {
      if (this.host.acceptsWheel?.(e2) === false) return;
      if (e2.ctrlKey || e2.metaKey) {
        e2.preventDefault();
        this.zoomLog += wheelZoomLog(e2.deltaY, e2.deltaMode);
        this.source = "wheel";
        this.from = at2(e2);
        this.to = at2(e2);
        clearTimeout(this.wheelTimer);
        this.wheelTimer = window.setTimeout(() => {
          this.flush();
          this.host.zoomEnd?.("wheel");
        }, WHEEL_END_MS);
        this.schedule();
        return;
      }
      if (!this.host.pan || !this.host.canPan?.(e2)) return;
      e2.preventDefault();
      const page = this.host.surface.clientHeight || void 0;
      this.panX += wheelPixels(e2.deltaX, e2.deltaMode, page);
      this.panY += wheelPixels(e2.deltaY, e2.deltaMode, page);
      this.schedule();
    }
    gesture(raw, phase) {
      const e2 = raw;
      e2.preventDefault();
      if (this.touch.active) return;
      if (phase === "start") {
        this.safariScale = 1;
        return;
      }
      if (phase === "end") {
        this.flush();
        this.host.zoomEnd?.("gesture");
        return;
      }
      if (!(e2.scale > 0)) return;
      this.zoomLog += Math.log(e2.scale / this.safariScale);
      this.safariScale = e2.scale;
      this.source = "gesture";
      this.from = at2(e2);
      this.to = at2(e2);
      this.schedule();
    }
    // ── Frames ──
    queuePinch(v2) {
      if (!v2.pinch) return;
      this.zoomLog += Math.log(v2.pinch.scale);
      this.from ??= v2.pinch.from;
      this.to = v2.pinch.to;
      this.source = "pinch";
      this.schedule();
    }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => this.flush());
    }
    // Apply this frame's batch now.
    flush() {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      const log = this.zoomLog;
      const from = this.from;
      const to = this.to;
      const dx = this.panX;
      const dy = this.panY;
      this.zoomLog = 0;
      this.from = null;
      this.to = null;
      this.panX = 0;
      this.panY = 0;
      if (from && to && (log !== 0 || from.x !== to.x || from.y !== to.y)) {
        this.host.zoom(Math.exp(log), from, to, this.source);
      }
      if (dx || dy) this.host.pan?.(dx, dy);
    }
  };

  // src/ts/editor/touchzoom.ts
  function initTouchZoom() {
    const canvas2 = document.getElementById("canvas");
    new GesturePad({
      surface: canvas2,
      // Text being edited in place keeps the browser's caret and selection.
      defer: (e2) => !fingersDraw() && !hooks.editingHost()?.contains(e2.target),
      cancelSingle: cancelStroke,
      zoom: (factor, from, to) => zoomAbout(factor, from, to),
      zoomEnd: zoomEnded,
      doubleTap: (at3) => {
        if (ed.tool !== "select" || ed.richEditing) return;
        if (!pick(at3.x, at3.y)) setZoom(0);
      }
    });
  }

  // src/ts/editor/main.ts
  var INITIAL_MODEL = __MODEL_JSON__;
  var INITIAL_SLIDES = __SLIDES_JSON__;
  var WS_PORT = __WS_PORT__;
  var INITIAL_ERROR = __ERROR_JSON__;
  var errorBox = document.getElementById("build-error");
  function showError() {
    errorBox.textContent = ed.error ?? "";
    errorBox.classList.toggle("show", !!ed.error);
  }
  function editTextOf(el2) {
    const slide = currentSlide();
    const loc = el2.getAttribute("data-ink");
    if (!slide || !loc) return;
    const key = parseInt(loc.split(":")[0] ?? "", 10);
    const src = slide.sources?.[key];
    if (!src?.writable) {
      toast(
        "This text lives in a layout: edit it in the Slide master",
        "error"
      );
      return;
    }
    editSvgText(el2, src.path, () => slide.sources?.[key]?.hash ?? "", loc);
  }
  function readHash() {
    const m2 = location.hash.match(/slide=(\d+)/);
    if (!m2 || !ed.model) return;
    const n3 = Number(m2[1]);
    const s2 = ed.model.slides.find((x2) => x2.visibleIndex === n3 - 1);
    if (s2) ed.current = s2.deckIndex;
  }
  function writeHash() {
    const s2 = currentSlide();
    if (s2?.visibleIndex == null) return;
    const hash = `#slide=${s2.visibleIndex + 1}`;
    if (location.hash !== hash) {
      try {
        history.replaceState(null, "", hash);
      } catch {
      }
    }
  }
  function selectPending() {
    if (!afterRender.ids.length) return;
    const svg = slideRoot();
    if (!svg) return;
    const els = afterRender.ids.map((id) => svg.querySelector(`[id="${CSS.escape(id)}"]`)).filter(
      (el2) => el2 instanceof SVGGraphicsElement
    );
    if (!els.length) return;
    const { editText, placeholder } = afterRender;
    afterRender.ids = [];
    afterRender.editText = false;
    afterRender.placeholder = void 0;
    select(els);
    if (editText && els[0].localName === "text") editTextOf(els[0]);
    else if (editText && isZone(els[0])) {
      editZone(zoneName(els[0]), els[0], { selectAll: true, placeholder });
    }
  }
  function boot() {
    ed.model = INITIAL_MODEL;
    ed.slides = INITIAL_SLIDES;
    ed.error = INITIAL_ERROR;
    readHash();
    hooks.editText = editTextOf;
    hooks.editZone = (zone, el2, at3) => {
      if (ed.master) {
        toast(
          `\u201C${zone}\u201D is a placeholder: each slide on this layout fills it with its own content. Drag it to move it.`
        );
        return;
      }
      if (currentSlide()?.zones[zone]?.kind === "chart") void editChart(zone);
      else editZone(zone, el2, { at: at3 });
    };
    hooks.editingHost = editingHost;
    hooks.crop = (el2) => {
      const sel = ed.selection.find((s2) => s2.el === el2);
      if (sel) void startCrop(sel);
    };
    hooks.finishEditing = () => void finishTextEdit();
    hooks.diagram = (el2) => {
      const sel = ed.selection.find((s2) => s2.el === el2);
      if (!sel || !diagramOf(el2)) return false;
      editDiagram(sel);
      return true;
    };
    hooks.diagramEdited = diagramEdited;
    hooks.cellLabel = focusCellLabel;
    initCanvas();
    initInsert();
    initInk();
    initTouchZoom();
    initSorter();
    initProps();
    initObjects();
    initNotes();
    initKeys();
    initPanels();
    initStars();
    initToolbar();
    initContext();
    initGallery();
    initDialog();
    initExport();
    initFind();
    initGrid();
    initTheme();
    initDecks();
    initGit();
    initProblems();
    initComments();
    initPalette();
    initCanvasMenu();
    initCompare();
    initMaster();
    on("slide", () => {
      void finishTextEdit();
      render();
      writeHash();
    });
    on("render", selectPending);
    on("selection", () => {
      const one = ed.selection.length === 1 ? ed.selection[0].el : null;
      if (ed.cropMode && !(one && isCropped(one))) setCropMode(false);
    });
    on("error", showError);
    on("edit-zone", () => {
      const el2 = ed.selection[0]?.el;
      if (el2 && isZone(el2)) hooks.editZone(zoneName(el2), el2);
    });
    on("edit-text", () => {
      const el2 = ed.selection[0]?.el;
      if (el2?.localName === "text") editTextOf(el2);
    });
    window.addEventListener("hashchange", () => {
      const before = ed.current;
      readHash();
      if (ed.current !== before) emit("slide");
    });
    initCollab();
    initShare();
    on("stale", () => render());
    showError();
    renderSorter();
    render();
    writeHash();
    if (WS_PORT != null) connect(WS_PORT);
    if (!ed.model && !ed.error) void showStart();
  }
  boot();
})();
