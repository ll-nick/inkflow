"use strict";
(() => {
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
    const forward = toStep >= fromStep;
    const runStep = Math.max(fromStep, toStep);
    const items = [];
    root2.querySelectorAll("[data-cues]").forEach((el2) => {
      for (const st of cueStates(el2)) {
        if (st.cue.step !== runStep) continue;
        const anim = ensureAnim(el2, st);
        anim.pause();
        items.push({
          anim,
          offsetMs: Math.max(0, st.cue.offset) * 1e3,
          spanMs: effectEndMs(st.cue)
        });
      }
    });
    const totalMs = items.reduce(
      (m2, it) => Math.max(m2, it.offsetMs + it.spanMs),
      0
    );
    return { items, totalMs, forward, toStep };
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
  function scaleAbout(sx, sy, origin) {
    return {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      e: origin.x - sx * origin.x,
      f: origin.y - sy * origin.y
    };
  }
  function rotateAbout(degrees, origin) {
    const r2 = degrees * Math.PI / 180;
    const cos = Math.cos(r2);
    const sin = Math.sin(r2);
    return multiply(
      translate(origin.x, origin.y),
      multiply(
        { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 },
        translate(-origin.x, -origin.y)
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
  function transformBox(m2, box) {
    const pts = [
      apply(m2, { x: box.x, y: box.y }),
      apply(m2, { x: box.x + box.width, y: box.y }),
      apply(m2, { x: box.x, y: box.y + box.height }),
      apply(m2, { x: box.x + box.width, y: box.y + box.height })
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
  function transformPlan(g2, slideChange) {
    const p2 = g2.parentToSlide;
    const inParent = multiply(invert(p2), multiply(slideChange, p2));
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
          const plan = {};
          const cx = shiftList(c2.attrs.x, delta.x);
          const cy = shiftList(c2.attrs.y, delta.y);
          if (cx != null) plan.x = cx;
          if (cy != null) plan.y = cy;
          return plan;
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
    slideSelection: /* @__PURE__ */ new Set(),
    // deck indices picked in the slide list
    focus: "canvas",
    // where Delete / copy apply
    error: null,
    // A structural edit was sent and its rebuild has not been rendered yet.
    structuralPending: false,
    rebuilt: false
    // a model arrived since the last render
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
    return ed.model?.slides[ed.current] ?? null;
  }
  function currentRendered() {
    const s2 = currentSlide();
    if (!s2 || s2.visibleIndex == null) return null;
    return ed.slides[s2.visibleIndex] ?? null;
  }
  function sourceOf(key) {
    return currentSlide()?.sources?.[key] ?? null;
  }

  // src/ts/editor/net.ts
  var ws = null;
  var nextId = 1;
  var pending = /* @__PURE__ */ new Map();
  var commandHandler = () => {
  };
  var pendingSlides = null;
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
    const host4 = location.hostname || "localhost";
    const sock = new WebSocket(`ws://${host4}:${port}`);
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "hello", role: "editor" }));
      document.body.classList.remove("offline");
      for (const resolve of waiting) resolve();
      waiting = [];
      for (const fn of connectHooks) fn();
    };
    sock.onclose = () => {
      document.body.classList.add("offline");
      for (const resolve of pending.values()) {
        resolve({ ok: false, error: "disconnected from the server" });
      }
      pending.clear();
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
        case "update":
          pendingSlides = msg.slides;
          applyDeckStyles(msg);
          ed.error = null;
          emit("error");
          break;
        case "editor-model":
          if (document.body.classList.contains("start-mode") || ed.model && msg.model.deckPath !== ed.model.deckPath) {
            location.assign("/edit");
            return;
          }
          if (pendingSlides) {
            ed.slides = pendingSlides;
            pendingSlides = null;
          }
          ed.model = msg.model;
          applyDeckSize(ed.model);
          ed.rebuilt = true;
          if (msg.history) {
            setHistory(msg.history);
          }
          emit("model");
          break;
        case "error":
          ed.error = String(msg.message ?? "build error");
          emit("error");
          break;
        case "edit-result": {
          const resolve = pending.get(msg.id);
          pending.delete(msg.id);
          resolve?.(msg);
          break;
        }
        case "editor-command":
          commandHandler(msg);
          break;
        case "agent-edit":
          agentEdit(msg);
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
    emit("history");
  }
  function agentEdit(msg) {
    setHistory(msg);
    const label4 = String(msg.label ?? "Agent: changed the deck");
    const step2 = msg.step;
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
    return new Promise((resolve) => {
      pending.set(id, resolve);
      sock.send(JSON.stringify({ type: "edit-op", id, ...req }));
    });
  }
  var pendingTimer = 0;
  var TRANSIENT = /since the last build|wait for the reload/;
  async function edit(req, opts2 = {}) {
    const result = await request(req);
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
    for (const slide of ed.model?.slides ?? []) {
      for (const src of slide.sources ?? []) {
        if (src.path in hashes) src.hash = hashes[src.path];
      }
    }
  }
  function sendRaw(payload) {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(payload));
  }

  // src/ts/editor/snap.ts
  function targetsFor(slide, others) {
    const xs = [slide.x, slide.x + slide.width / 2, slide.x + slide.width];
    const ys = [slide.y, slide.y + slide.height / 2, slide.y + slide.height];
    for (const b2 of others) {
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
  function snapBox(box, targets2, threshold) {
    const x2 = best(
      [box.x, box.x + box.width / 2, box.x + box.width],
      targets2.xs,
      threshold
    );
    const y2 = best(
      [box.y, box.y + box.height / 2, box.y + box.height],
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
    const total = order2.reduce((s2, o2) => s2 + o2.b[size4], 0);
    const span = last[axis] + last[size4] - first[axis];
    const gap = (span - total) / (order2.length - 1);
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
  var host = document.getElementById("slide-host");
  var overlay = document.getElementById("overlay");
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
    toolDown: (_e, _pt) => false
  };
  function slideRoot() {
    return host.querySelector(":scope > svg");
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
    overlay.setAttribute("width", String(pw));
    overlay.setAttribute("height", String(ph));
    overlay.setAttribute("viewBox", `0 0 ${pw} ${ph}`);
    canvas.classList.toggle("zoomed", ed.zoom > 0);
    canvas.style.padding = ed.zoom > 0 ? `${Math.round(canvas.clientHeight / 2)}px ${Math.round(canvas.clientWidth / 2)}px` : "";
    drawOverlay();
  }
  function render() {
    if (ed.interacting || ed.richEditing) {
      ed.renderPending = true;
      return;
    }
    ed.renderPending = false;
    const keep = ed.selection.map((s2) => ({
      loc: s2.loc,
      id: s2.el.getAttribute("id")
    }));
    const scopeKey = ed.scope?.getAttribute("data-ink") ?? null;
    const trustLoc = !ed.structuralPending;
    if (ed.rebuilt) ed.structuralPending = false;
    ed.rebuilt = false;
    const data = currentRendered();
    host.innerHTML = data ? data.svg : "";
    const hidden = currentSlide();
    if (!data && hidden && !hidden.visible) {
      host.append(
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
    }
    ed.scope = scopeKey ? host.querySelector(`[data-ink="${scopeKey}"]`) : null;
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
    let box = { x: 0, y: 0, width: 0, height: 0 };
    try {
      box = measure(el2)?.bbox ?? box;
    } catch {
    }
    return {
      tag: el2.localName,
      sourceTag: el2.getAttribute("data-ink-tag") ?? el2.localName,
      attrs: attrs2,
      own: parseTransform(el2.getAttribute("transform")),
      parentToSlide: parentCTM ? multiply(invert(rootCTM()), mat(parentCTM)) : { ...IDENTITY },
      localBox: box
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
    for (const el2 of overlay.querySelectorAll("[data-media-zone]")) {
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
    if (src.role === "diagram") return src.writable && editableCell(el2);
    if (src.role === "ink") return src.writable;
    if (ed.layoutMode) return src.writable;
    return isOwn(el2) || el2.hasAttribute("data-ink-top") && isZone(el2);
  }
  function canTransform(el2) {
    const src = sourceOf(keyOf(el2));
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
    const current2 = ed.selection.length === 1 ? ed.selection[0].el : null;
    let index = near && cycle ? cycle.index + 1 : 0;
    if (!near && current2 && all[0] === current2) index = 1;
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
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    const svg = slideRoot();
    if (!svg) return;
    drawPlaceholders();
    if (ed.scope) {
      const c2 = elementCorners(ed.scope);
      if (c2) overlay.append(poly(c2, "scope-outline"));
    }
    if (hoverEl && !ed.selection.some((s2) => s2.el === hoverEl)) {
      const c2 = elementCorners(hoverEl);
      if (c2) overlay.append(poly(c2, "hover-outline"));
    }
    for (const s2 of ed.selection) {
      const c2 = elementCorners(s2.el);
      if (c2) {
        overlay.append(
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
    const box = !connector && transformable.length === ed.selection.length ? selectionBox() : null;
    if (connector && ed.step == null) {
      const m2 = slideToPaper();
      for (const which of ["start", "end"]) {
        const end = connectorEnd(connector, which);
        if (!end) continue;
        const p2 = apply(m2, end);
        const attached = connector.hasAttribute(ENDS[which]);
        const handle = svgEl("circle", {
          cx: p2.x,
          cy: p2.y,
          r: 6,
          class: `handle endpoint${attached ? " attached" : ""}`
        });
        handle.dataset.handle = `c-${which}`;
        overlay.append(handle);
      }
      const bend = connectorRoute(connector)?.bend;
      if (bend) {
        const p2 = apply(m2, bend.mid);
        const handle = svgEl("rect", {
          x: p2.x - 5,
          y: p2.y - 5,
          width: 10,
          height: 10,
          transform: `rotate(45 ${p2.x} ${p2.y})`,
          class: `handle bend ${bend.axis === "x" ? "ew" : "ns"}`
        });
        handle.dataset.handle = "c-bend";
        overlay.append(handle);
      }
    }
    if (box && ed.step == null) {
      const pb = toPaperBox(box);
      if (ed.selection.length > 1) {
        overlay.append(
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
      overlay.append(
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
      if (!ed.cropMode && !frames) overlay.append(rh);
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
        overlay.append(r2);
      }
    }
    for (const x2 of guides.xs) {
      const p2 = toPaperBox({ x: x2, y: 0, width: 0, height: slideSize().height });
      overlay.append(
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
      overlay.append(
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
      overlay.append(
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
    overlay.append(ghost, poly(c2, "crop-extent"));
  }
  var MEDIA_ZONES = /media|image|img|picture|photo|figure|video|logo/;
  function drawPlaceholders() {
    const slide = currentSlide();
    if (!slide?.emptyZones || ed.step != null) return;
    for (const z of slide.emptyZones) {
      const key = parseInt(z.locator.split(":")[0] ?? "", 10);
      const src = sourceOf(key);
      if (!src || z.zone === "slide-number" || z.zone === "slide-total")
        continue;
      const own = parseTransform(z.transform);
      const box = transformBox(own, z);
      const pb = toPaperBox(box);
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
      overlay.append(outline);
      const g2 = svgEl("g", { class: "placeholder" });
      const text = media ? `+ media \xB7 ${z.zone}` : `+ ${z.zone}`;
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
      const title2 = svgEl("title");
      title2.textContent = media ? `Add an image or video to the ${z.zone} zone` : `Add ${z.zone} text`;
      g2.append(title2);
      g2.addEventListener("pointerdown", (e2) => {
        e2.stopPropagation();
        e2.preventDefault();
        if (media) hooks.zoneMedia(z.zone);
        else hooks.zoneText(z.zone);
      });
      overlay.append(g2);
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
        overlay.append(
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
      const drawn = apply(m2, which === "start" ? pts.start : pts.end);
      if (Math.hypot(drawn.x - site.x, drawn.y - site.y) > 1) return true;
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
    const current2 = connectorRoute(conn)?.bend;
    if (!current2) return [];
    const bend = {
      axis: current2.axis,
      at: Math.round(current2.axis === "x" ? p2.x : p2.y)
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
      const list3 = out.get(src.path) ?? [];
      list3.push(...ops);
      out.set(src.path, list3);
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
  function applyPlanToDom(el2, plan) {
    for (const [k2, v2] of Object.entries(plan)) {
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
    const plan = planMove(
      elementGeom(sel.el),
      dx,
      dy,
      kids.map((k2) => ({
        attrs: { x: k2.getAttribute("x"), y: k2.getAttribute("y") }
      }))
    );
    const ops = [{ kind: "attrs", loc: sel.loc, set: plan.attrs }];
    applyPlanToDom(sel.el, plan.attrs);
    plan.children?.forEach((p2, i2) => {
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
  function beginDrag(handle) {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    if (!sels.length || sels.length !== ed.selection.length || ed.step != null)
      return null;
    const snaps = sels.map(snapshot);
    const start = unionBoxes(snaps.map((s2) => s2.box));
    if (!start) return null;
    if (handle === "c-bend") return { kind: "bend", snaps };
    if (handle === "c-start" || handle === "c-end") {
      return {
        kind: "endpoint",
        which: handle === "c-start" ? "start" : "end",
        snaps
      };
    }
    const targets2 = snapTargets(new Set(sels.map((s2) => s2.el)));
    if (handle === "rot") {
      return {
        kind: "rotate",
        snaps,
        center: {
          x: start.x + start.width / 2,
          y: start.y + start.height / 2
        }
      };
    }
    if (handle) return { kind: "resize", handle, snaps, start, targets: targets2 };
    return { kind: "move", snaps, start, targets: targets2 };
  }
  function resizedBox(start, handle, dx, dy, keepAspect) {
    let { x: x2, y: y2, width, height } = start;
    if (handle.includes("w")) {
      x2 += dx;
      width -= dx;
    }
    if (handle.includes("e")) width += dx;
    if (handle.includes("n")) {
      y2 += dy;
      height -= dy;
    }
    if (handle.includes("s")) height += dy;
    if (keepAspect && start.width > 0 && start.height > 0) {
      const ratio = start.width / start.height;
      const corner = handle.length === 2;
      if (corner || handle === "e" || handle === "w") {
        const h22 = width / ratio;
        if (handle.includes("n")) y2 += height - h22;
        else if (!corner) y2 = start.y + (start.height - h22) / 2;
        height = h22;
      } else {
        const w2 = height * ratio;
        x2 = start.x + (start.width - w2) / 2;
        width = w2;
      }
    }
    if (width < 0) {
      x2 += width;
      width = -width;
    }
    if (height < 0) {
      y2 += height;
      height = -height;
    }
    return { x: x2, y: y2, width: Math.max(width, 1), height: Math.max(height, 1) };
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
        const plan = cropping && planCrop(s2.geom, s2.box, target) || planResize(s2.geom, s2.box, target);
        applyPlanToDom(s2.sel.el, plan);
        return {
          sel: s2.sel,
          ops: [{ kind: "attrs", loc: s2.sel.loc, set: plan }]
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
        const plan = planRotate(s2.geom, deg, c2);
        applyPlanToDom(s2.sel.el, plan);
        return {
          sel: s2.sel,
          ops: [{ kind: "attrs", loc: s2.sel.loc, set: plan }]
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
    const handle = target.closest("[data-handle]")?.dataset.handle;
    const pt = clientToSlide(e2.clientX, e2.clientY);
    if (!handle && ed.tool !== "select") {
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
    if (handle) {
      drag = beginDrag(handle);
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
    for (const plan of plans) {
      if (sourceOf(plan.sel.key)?.role !== "diagram") {
        out.push(plan);
        continue;
      }
      const el2 = plan.sel.el;
      const diagram = el2.closest("svg[data-drawio]");
      const cell = el2.getAttribute("data-cell-id");
      if (!diagram || !cell) continue;
      const ops = [];
      let moved = false;
      for (const op of plan.ops) {
        if (op.kind === "delete") ops.push({ kind: "cell-delete", cell });
        else if (String(op.kind).startsWith("cell-")) ops.push(op);
        else if (geometryChanged([op])) moved = true;
        else refused = true;
      }
      if (moved) {
        const offset = pageOffset(diagram);
        const box = offset ? pageBox(el2, offset) : null;
        if (offset && box) {
          ops.push({
            kind: "cell-geometry",
            cell,
            ...box,
            offset: [offset.x, offset.y]
          });
        }
      }
      if (ops.length) {
        out.push({ sel: plan.sel, ops });
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
    on("model", render);
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
    const current2 = plotted(grid, s2);
    const next = on2 ? grid.columns.filter((c2) => c2 === column || current2.includes(c2)) : current2.filter((c2) => c2 !== column);
    const auto = plotted(grid, { ...s2, y: null });
    const same = next.length === auto.length && next.every((c2, i2) => c2 === auto[i2]);
    return same ? null : next;
  }
  function parseClipboard(text) {
    const body2 = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const sep2 = body2.includes("	") ? "	" : body2.includes(",") ? "," : "	";
    const rows = [];
    let row4 = [];
    let cell = "";
    let quoted = false;
    let i2 = 0;
    while (i2 < body2.length) {
      const ch = body2[i2];
      if (quoted) {
        if (ch === '"' && body2[i2 + 1] === '"') {
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
        row4.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row4.push(cell);
        rows.push(row4);
        row4 = [];
        cell = "";
      } else cell += ch;
      i2++;
    }
    row4.push(cell);
    rows.push(row4);
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
  function pasteCells(grid, row4, col, cells) {
    const columns = [...grid.columns];
    const rows = grid.rows.map((r2) => [...r2]);
    let body2 = cells;
    if (row4 < 0) {
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
      body2 = cells.slice(1);
      row4 = 0;
    }
    const width = Math.max(
      columns.length,
      col + Math.max(0, ...body2.map((r2) => r2.length))
    );
    while (columns.length < width) {
      columns.push(uniqueName(columns, `column ${columns.length + 1}`));
    }
    for (const r2 of rows) while (r2.length < width) r2.push("");
    body2.forEach((line, i2) => {
      while (rows.length <= row4 + i2) rows.push(blankRow(width));
      line.forEach((value, j2) => {
        rows[row4 + i2][col + j2] = value;
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
    const others = grid.columns.filter((_2, i2) => i2 !== at3);
    const name2 = uniqueName(others, wanted.trim() || old);
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

  // src/ts/editor/dialog.ts
  var host2 = document.getElementById("dialog");
  var onClose = null;
  function openDialog(title2, body2, opts2 = {}) {
    closeDialog();
    onClose = opts2.onClose ?? null;
    const box = h(
      "div",
      {
        class: `dialog-box${opts2.large ? " large" : opts2.wide ? " wide" : ""}`,
        role: "dialog"
      },
      h(
        "div",
        { class: "dialog-head" },
        h("h2", {}, title2),
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
      h("div", { class: "dialog-body" }, body2)
    );
    host2.append(box);
    host2.classList.add("open");
    return box;
  }
  function closeDialog() {
    if (!host2.classList.contains("open")) return;
    host2.classList.remove("open");
    clear(host2);
    const fn = onClose;
    onClose = null;
    fn?.();
  }
  function dialogOpen() {
    return host2.classList.contains("open");
  }
  function initDialog() {
    host2.addEventListener("pointerdown", (e2) => {
      if (e2.target === host2) closeDialog();
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
    host2.addEventListener("keydown", (e2) => {
      if (e2.key !== "Escape") e2.stopPropagation();
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
    return LABELS[name2]?.[0] ?? name2;
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
    const box = h("div", { class: "gallery-thumb" });
    box.innerHTML = p2.svg;
    const svg = box.querySelector("svg");
    if (svg) {
      const vb = parseViewBox(svg.getAttribute("viewBox"));
      box.style.aspectRatio = `${vb.w} / ${vb.h}`;
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
      });
      for (const z of p2.emptyZones) {
        if (z.zone === "slide-number" || z.zone === "slide-total") continue;
        box.append(
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
    return box;
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
    const title2 = opts2.mode === "insert" ? "New slide" : "Change layout";
    root.append(
      h(
        "div",
        { class: "gallery-box", role: "dialog", "aria-label": title2 },
        h(
          "div",
          { class: "gallery-head" },
          h("h2", {}, title2),
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
      const [label4, description] = LABELS[p2.name] ?? [p2.name, ""];
      const lost = opts2.mode === "change" ? lostZones(p2) : [];
      const current2 = opts2.mode === "change" && p2.name === opts2.current;
      const card = h(
        "button",
        {
          type: "button",
          class: `gallery-card${current2 ? " current" : ""}`,
          title: p2.name,
          onclick: () => void choose(p2, opts2, lost)
        },
        thumbnail(p2),
        h(
          "div",
          { class: "gallery-label" },
          h("strong", {}, label4),
          p2.source === "local" && h("span", { class: "badge" }, "project")
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
  function commonPrefix(names) {
    if (!names.length) return "";
    let prefix = names[0];
    for (const name2 of names.slice(1)) {
      let i2 = 0;
      while (i2 < prefix.length && i2 < name2.length && prefix[i2].toLowerCase() === name2[i2].toLowerCase()) {
        i2++;
      }
      prefix = prefix.slice(0, i2);
    }
    return prefix;
  }
  function startingWith(names, typed) {
    const t2 = typed.toLowerCase();
    return names.filter((n3) => n3.toLowerCase().startsWith(t2));
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

  // src/ts/editor/rename.ts
  function plural(n3, word) {
    return `${n3} ${word}${n3 === 1 ? "" : "s"}`;
  }
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
    const box = h("div", { class: "rename-preview" });
    if (opts2.moves && p2.moves.length) {
      box.append(
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
      box.append(
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
    box.append(h("p", { class: "rename-msg rename-summary" }, summaryLine(p2)));
    for (const [old, now] of Object.entries(p2.ids)) {
      box.append(
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
        const list4 = byFile.get(e2.file) ?? [];
        list4.push(e2);
        byFile.set(e2.file, list4);
      }
      const list3 = h("ul", { class: "rename-list" });
      for (const [file, edits] of byFile) {
        list3.append(
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
      box.append(
        h(
          "details",
          { class: "rename-details" },
          h("summary", {}, "Show the references"),
          list3
        )
      );
    }
    for (const w2 of p2.warnings) {
      box.append(h("p", { class: "rename-msg rename-warning" }, w2));
    }
    return box;
  }
  function renameDialog(opts2) {
    const status2 = h("div", { class: "rename-status" });
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
    let timer5 = 0;
    let last = null;
    const refresh2 = async () => {
      const mine = ++token;
      const req = opts2.build();
      go.disabled = true;
      if (typeof req === "string") {
        status2.className = "rename-status";
        status2.replaceChildren(h("p", { class: "rename-msg hint" }, req));
        return;
      }
      status2.className = "rename-status busy";
      const res = await request({ ...req, dryRun: true });
      if (mine !== token) return;
      if (!res.ok) {
        last = null;
        status2.className = "rename-status error";
        status2.replaceChildren(
          h(
            "p",
            { class: "rename-msg" },
            res.error ?? "This name cannot be used"
          )
        );
        return;
      }
      last = res.rename;
      status2.className = "rename-status";
      status2.replaceChildren(previewBody(last, { moves: opts2.moves }));
      go.disabled = false;
    };
    const schedule2 = () => {
      window.clearTimeout(timer5);
      timer5 = window.setTimeout(() => void refresh2(), 200);
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
        status2.className = "rename-status error";
        status2.replaceChildren(
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
        status2,
        h("div", { class: "rename-actions" }, cancel2, go)
      ),
      { hint: opts2.hint }
    );
    opts2.inputs[opts2.inputs.length - 1]?.focus();
    opts2.inputs[opts2.inputs.length - 1]?.select();
    status2.replaceChildren(
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
    const current2 = slide.md?.kind === "file" && slide.md.rel ? splitFileName(slide.md.rel).stem : slide.srcRel && !slide.srcShared ? splitFileName(slide.srcRel).stem : slide.id ?? "";
    const nameInput = h("input", {
      type: "text",
      value: current2,
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
  async function openFiles() {
    const res = await request({ action: "files" });
    if (!res.ok) {
      toast(res.error ?? "Cannot list the deck's files", "error");
      return;
    }
    const files2 = res.files ?? [];
    const unused = files2.filter((f2) => !f2.uses);
    const picked = /* @__PURE__ */ new Set();
    const list3 = h("div", { class: "files-list" });
    const deleteBtn = h(
      "button",
      { type: "button", class: "pbtn", disabled: true },
      "Delete unused\u2026"
    );
    const sync = () => {
      deleteBtn.disabled = !picked.size;
      deleteBtn.textContent = picked.size ? `Delete ${plural(picked.size, "file")}\u2026` : "Delete unused\u2026";
    };
    let folder = null;
    for (const f2 of files2) {
      const { folder: dir } = splitFileName(f2.path);
      if (dir !== folder) {
        folder = dir;
        list3.append(h("div", { class: "files-folder" }, `${dir || "."}/`));
      }
      const check = h("input", {
        type: "checkbox",
        disabled: f2.uses > 0,
        title: f2.uses ? "In use" : "Pick it to delete"
      });
      check.addEventListener("change", () => {
        if (check.checked) picked.add(f2.path);
        else picked.delete(f2.path);
        sync();
      });
      list3.append(
        h(
          "div",
          { class: `files-row${f2.uses ? "" : " unused"}` },
          check,
          h(
            "code",
            { class: "rename-code files-name", title: f2.path },
            f2.path.split("/").pop() ?? f2.path
          ),
          h(
            "span",
            { class: "files-uses" },
            f2.uses ? plural(f2.uses, "use") : "unused"
          ),
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
    deleteBtn.addEventListener("click", async () => {
      const paths = [...picked];
      if (!window.confirm(
        `Delete ${plural(paths.length, "file")} nothing uses?

${paths.join("\n")}

Undo brings them back.`
      )) {
        return;
      }
      const r2 = await edit({ action: "delete-files", paths });
      if (r2.ok) {
        toast(r2.label ?? "Deleted", "ok");
        void openFiles();
      }
    });
    const selectUnused = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        disabled: !unused.length,
        onclick: () => {
          for (const row4 of list3.querySelectorAll(
            ".files-row.unused input"
          )) {
            row4.checked = true;
          }
          for (const f2 of unused) picked.add(f2.path);
          sync();
        }
      },
      "Pick all unused"
    );
    const body2 = h(
      "div",
      { class: "files-body" },
      files2.length ? list3 : h("p", { class: "hint" }, "No files yet."),
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
    openDialog("Files", body2, {
      wide: true,
      hint: "Pictures, videos, data, diagrams and slide files; a use is a reference in a slide, Markdown or deck.py"
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
  function moveRequest(sections2, moved, insertAt, section2) {
    const slides = [...new Set(moved)].sort((a2, b2) => a2 - b2);
    if (!slides.length) return null;
    const to = insertAt - slides.filter((i2) => i2 < insertAt).length;
    const contiguous = slides.every((v2, j2) => v2 === slides[0] + j2);
    const sameSection = slides.every((i2) => sectionOf(sections2, i2) === section2);
    if (contiguous && sameSection && to === slides[0]) return null;
    return { slides, to, section: section2 };
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
  async function moveSlidesTo(slides, insertAt, section2) {
    const move = moveRequest(sections(), slides, insertAt, section2);
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
    if (withSlides && !window.confirm(
      `Remove section \u201C${s2.name}\u201D and its ${s2.count} slide${s2.count === 1 ? "" : "s"} from the deck? (Their files stay on disk.)`
    )) {
      return;
    }
    await sectionEdit({ op: "section-remove", section: k2, slides: withSlides });
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
  function askName(title2, initial) {
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
      openDialog(title2, form, { onClose: () => resolve(answer) });
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
  function openSectionMenu(x2, y2, k2) {
    const menu6 = document.getElementById("context-menu");
    const s2 = sections()[k2];
    if (!s2) return;
    const editable = !!ed.model?.deckEditable;
    const n3 = sections().length;
    menu6.replaceChildren();
    menu6.append(
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

  // src/ts/editor/sorter.ts
  var list = document.getElementById("sorter-list");
  var addBtn = document.getElementById("sorter-add");
  var menu = document.getElementById("context-menu");
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
    if (!window.confirm(
      `Delete ${indices.length} slides from the deck? (Their files stay on disk.)`
    )) {
      return;
    }
    const result = await edit({
      action: "slide",
      op: "delete",
      slides: indices
    });
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
    cache = /* @__PURE__ */ new Map();
    used = /* @__PURE__ */ new Map();
    begin() {
      this.used = /* @__PURE__ */ new Map();
    }
    end() {
      this.cache = this.used;
    }
    thumb(slide) {
      const box = h("div", { class: "thumb" });
      if (slide.visibleIndex == null) {
        box.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
        return box;
      }
      const data = ed.slides[slide.visibleIndex];
      if (!data) return box;
      const cached = this.cache.get(data.svg);
      if (cached && !this.used.has(data.svg)) {
        this.used.set(data.svg, cached);
        return cached;
      }
      this.used.set(data.svg, box);
      box.innerHTML = data.svg;
      const svg = box.querySelector("svg");
      if (svg) {
        const vb = parseViewBox(svg.getAttribute("viewBox"));
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
        box.style.aspectRatio = `${vb.w} / ${vb.h}`;
        svg.querySelectorAll(".anim-pending").forEach((el2) => {
          el2.classList.remove("anim-pending");
        });
        svg.querySelectorAll("video").forEach((v2) => {
          v2.removeAttribute("autoplay");
        });
      }
      return box;
    }
  };
  var thumbs = new Thumbs();
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
    const item = h(
      "div",
      {
        class: `sorter-item${i2 === ed.current ? " active" : ""}${ed.slideSelection.has(i2) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
        draggable: ed.model?.deckEditable ? "true" : null,
        title: slide.title ?? slide.id ?? slide.src,
        "data-index": i2
      },
      h("span", { class: "sorter-num" }, String(i2 + 1)),
      thumbs.thumb(slide)
    );
    item.addEventListener("click", (e2) => pickSlide(i2, e2));
    item.addEventListener("contextmenu", (e2) => {
      e2.preventDefault();
      ed.focus = "sorter";
      if (!ed.slideSelection.has(i2)) {
        ed.slideSelection.clear();
        gotoSlide(i2);
      }
      openSlideMenu(e2.clientX, e2.clientY, i2);
    });
    item.addEventListener("dragstart", (e2) => {
      dragging.now = { kind: "slides", slides: dragSlides(i2) };
      e2.dataTransfer?.setData("text/plain", String(i2));
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      dragging.now = null;
      item.classList.remove("dragging");
      clearDropMarks(list);
    });
    item.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        const gap = sectionGapAtSlide(sections(), i2);
        markGap(list, gap, list.lastElementChild);
        return;
      }
      const r2 = item.getBoundingClientRect();
      clearDropMarks(list);
      item.classList.add(
        e2.clientY > r2.top + r2.height / 2 ? "drop-after" : "drop-before"
      );
    });
    item.addEventListener("drop", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      const drag = dragging.now;
      clearDropMarks(list);
      if (!drag) return;
      if (drag.kind === "section") {
        const gap = sectionGapAtSlide(sections(), i2);
        void moveSectionToGap(drag.section, gap);
        return;
      }
      const r2 = item.getBoundingClientRect();
      const after = e2.clientY > r2.top + r2.height / 2;
      const target = dropOnSlide(sections(), i2, after);
      void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return item;
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
      clearDropMarks(list);
    });
    head.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        markGap(list, headerGap(head, k2, e2), list.lastElementChild);
        return;
      }
      clearDropMarks(list);
      head.classList.add("drop-into");
    });
    head.addEventListener("drop", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      const drag = dragging.now;
      clearDropMarks(list);
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
  function renderSorter() {
    clear(list);
    thumbs.begin();
    const slides = ed.model?.slides ?? [];
    for (const row4 of sorterRows(slides.length, sections(), isCollapsed)) {
      list.append(
        row4.kind === "header" ? headerItem(row4.section) : slideItem(slides[row4.index], row4.index)
      );
    }
    thumbs.end();
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }
  function initListDrop() {
    list.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag || e2.target !== list) return;
      e2.preventDefault();
      if (drag.kind === "section") {
        markGap(list, sections().length, list.lastElementChild);
      } else {
        clearDropMarks(list);
        list.lastElementChild?.classList.add("drop-after");
      }
    });
    list.addEventListener("drop", (e2) => {
      const drag = dragging.now;
      if (!drag || e2.target !== list) return;
      e2.preventDefault();
      clearDropMarks(list);
      dropAtEnd(drag);
    });
  }
  function followSelect(i2) {
    pendingSelect = i2;
  }
  async function newSlide(layout, after = ed.current) {
    const result = await edit({
      action: "slide",
      op: "new",
      after,
      layout,
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
    const name2 = slide.title ?? slide.id ?? `slide ${i2 + 1}`;
    if (!window.confirm(
      `Delete \u201C${name2}\u201D from the deck? (Its files stay on disk.)`
    )) {
      return;
    }
    const result = await edit({ action: "slide", op: "delete", slide: i2 });
    if (result.ok) {
      ed.current = Math.max(0, i2 - 1);
      emit("slide");
    }
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
    menu.classList.remove("open");
    clear(menu);
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
    clear(menu);
    menu.append(
      menuItem(
        many ? `Copy ${ed.slideSelection.size} slides` : "Copy",
        () => void copySlides()
      )
    );
    menu.append(
      menuItem(
        many ? "Cut slides" : "Cut",
        () => void cutSlides(),
        !editable
      )
    );
    menu.append(
      menuItem(
        "Paste after this slide",
        () => void pasteFromClipboard(),
        !editable
      )
    );
    if (many) {
      menu.append(
        menuItem(
          `Delete ${ed.slideSelection.size} slides`,
          () => void deleteSlides(),
          !editable
        )
      );
      showMenu(x2, y2);
      return;
    }
    menu.append(
      menuItem(
        "New slide after\u2026",
        () => void openGallery({ mode: "insert", after: i2 }),
        !editable
      )
    );
    menu.append(menuItem("Duplicate", () => void duplicateSlide(i2), !editable));
    menu.append(
      menuItem(
        slide?.visible ? "Hide (skip in presentation)" : "Show",
        () => void toggleHidden(i2),
        !editable
      )
    );
    menu.append(
      menuItem("Rename files\u2026", () => renameSlideFiles(i2), !editable)
    );
    menu.append(menuItem("Delete", () => void deleteSlide(i2), !editable));
    menu.append(
      menuItem("Add section here\u2026", () => void addSectionAt(i2), !editable)
    );
    showMenu(x2, y2);
  }
  function showMenu(x2, y2) {
    menu.classList.add("open");
    const r2 = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x2, window.innerWidth - r2.width - 8)}px`;
    menu.style.top = `${Math.min(y2, window.innerHeight - r2.height - 8)}px`;
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
    on("slide-selection", renderSorter);
    on("sections", renderSorter);
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
      if (!menu.contains(e2.target)) closeMenu();
    });
    document.addEventListener("keydown", (e2) => {
      if (e2.key === "Escape") closeMenu();
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
  async function choosePage(path, current2 = 1) {
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
      return { page: current2, url: null };
    }
    const pages = typeof info4.pages === "number" ? info4.pages : null;
    if (pages === 1) {
      const url = await pageUrl(path, 1);
      return url ? { page: 1, url } : null;
    }
    return pageDialog(path, name2, pages, current2);
  }
  function pageDialog(path, name2, pages, current2) {
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
              class: `pdf-page${page === current2 ? " current" : ""}`,
              title: `Page ${page}`,
              "data-page": page,
              onclick: () => void pick2(page)
            },
            h("span", { class: "pdf-thumb" }),
            h("span", {}, `Page ${page}`)
          )
        );
      }
      const field = h("input", {
        type: "number",
        min: 1,
        max: pages ?? null,
        step: 1,
        value: String(current2)
      });
      field.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter") void pick2(Math.max(1, Number(field.value)));
      });
      const body2 = h(
        "div",
        {},
        grid,
        h(
          "div",
          { class: "pdf-page-field" },
          h("label", {}, "Page ", field, pages ? ` of ${pages}` : ""),
          h(
            "button",
            {
              type: "button",
              class: "pbtn on",
              onclick: () => void pick2(Math.max(1, Number(field.value)))
            },
            "Use this page"
          )
        )
      );
      openDialog(`Which page of ${name2}?`, body2, {
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
    const list3 = h("div", { class: "folder-list", role: "listbox" });
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
    const entries = () => [...list3.querySelectorAll("button.folder")].filter(
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
      renderList2();
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
    function renderList2() {
      clear(list3);
      const f2 = folder;
      if (!f2) return;
      if (f2.parent && !filter) {
        list3.append(
          entry("\u2191 ..", "up", () => {
            if (f2.parent) void go(f2.parent, { focus: "list" });
          })
        );
      }
      const dirs = startingWith(f2.dirs, filter);
      for (const name2 of dirs) {
        list3.append(
          entry(`\u{1F4C1} ${name2}`, "dir", () => {
            void go(joinPath(f2.path, name2), { focus: "list" });
          })
        );
      }
      const shown2 = startingWith(
        (f2.files ?? []).map((x2) => x2.name),
        filter
      );
      for (const file of f2.files ?? []) {
        if (!shown2.includes(file.name)) continue;
        list3.append(
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
      if (!dirs.length && !shown2.length) {
        list3.append(
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
        renderList2();
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
      const matches = startingWith(f2.dirs, prefix);
      if (matches.length === 1) {
        await go(joinPath(f2.path, matches[0]));
        return;
      }
      const common = commonPrefix(matches);
      filter = common.length > prefix.length ? common : prefix;
      path.value = withSep(f2.path) + filter;
      renderList2();
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
        renderList2();
      }
    });
    list3.addEventListener("keydown", (e2) => {
      const items = entries();
      const at3 = items.indexOf(document.activeElement);
      if (e2.key === "ArrowDown" || e2.key === "ArrowUp") {
        e2.preventDefault();
        const next = at3 + (e2.key === "ArrowDown" ? 1 : -1);
        if (next < 0) path.focus();
        else items[Math.min(next, items.length - 1)]?.focus();
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
      list3,
      where
    );
    void go(start);
    return { el: el2, current: () => folder, focus: () => path.focus() };
  }

  // src/ts/editor/openwith.ts
  var menu2 = document.getElementById("context-menu");
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
    clear(menu2);
    menu2.append(h("div", { class: "menu-title" }, `Open ${fileName2(path)} in`));
    for (const app of apps) {
      menu2.append(menuItem(app.label, () => void open(path, app)));
    }
    menu2.append(
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
    let height = null;
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
      option2.selected = p2.height === height;
      size4.append(option2);
    }
    size4.addEventListener("change", () => {
      height = size4.value ? Number(size4.value) : null;
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
    const copy2 = h(
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
        height,
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
        height,
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
          h("div", {}, command, h("div", { class: "btn-row" }, copy2))
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
  var overlay2 = document.getElementById("overlay");
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
    return currentSlide()?.sources?.find((s2) => s2.role === "slide") ?? null;
  }
  function insertParent() {
    const svg = slideRoot();
    if (ed.scope?.getAttribute("data-ink")?.startsWith("0:")) {
      return { loc: ed.scope.getAttribute("data-ink"), el: ed.scope };
    }
    const layers = svg ? [...svg.querySelectorAll('[data-ink-layer][data-ink^="0:"]')].filter(
      (l2) => !l2.hasAttribute("data-ink-locked")
    ) : [];
    const layer2 = layers[layers.length - 1];
    if (layer2) return { loc: layer2.getAttribute("data-ink"), el: layer2 };
    return { loc: "0:", el: null };
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
      const box = transformBox(m2, {
        x: Math.min(a2.x, b2.x),
        y: Math.min(a2.y, b2.y),
        width: Math.abs(b2.x - a2.x),
        height: Math.abs(b2.y - a2.y)
      });
      draft = tool === "ellipse" ? svgEl("ellipse", {
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        rx: box.width / 2,
        ry: box.height / 2,
        class: "draft"
      }) : svgEl("rect", {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        class: "draft"
      });
    }
    overlay2.append(draft);
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
    let box = {
      x: Math.min(a2.x, b2.x),
      y: Math.min(a2.y, b2.y),
      width: Math.abs(b2.x - a2.x),
      height: Math.abs(b2.y - a2.y)
    };
    if (box.width < 40 || box.height < 20) {
      const k2 = textScale();
      box = {
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
    const current2 = currentSlide();
    if (!src || !current2) return;
    const parent = insertParent();
    const p0 = toParent(parent.el, box.x, box.y);
    const p1 = toParent(parent.el, box.x + box.width, box.y + box.height);
    const result = await edit({
      action: "insert-textbox",
      slide: current2.deckIndex,
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
    const text = zonePlaceholder(zone);
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
    const list3 = dt?.getData("text/uri-list") ?? "";
    const uri = list3.split(/\r?\n/).find((line) => line.startsWith("file://"));
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
      const timer5 = window.setTimeout(() => resolve(fallback), 3e3);
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () => {
        window.clearTimeout(timer5);
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
        window.clearTimeout(timer5);
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
    let href = relativePath(src.path, up.path);
    let shown2 = up.rel;
    if (isPdfRef(up.path)) {
      const choice = await choosePage(up.path);
      if (!choice) return;
      href = withPage(href, choice.page);
      shown2 = choice.url;
    }
    const size4 = shown2 ? await naturalSize(shown2) : { w: 400, h: 300 };
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
  async function insertDiagramImage(path, width, height) {
    if (!await ensureOwnDrawing()) return false;
    const src = ownSource();
    if (!src) return false;
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const slideW = vb?.width || 1920;
    const slideH = vb?.height || 1080;
    const k2 = Math.min(1, slideW * 0.6 / width, slideH * 0.6 / height);
    const w2 = width * k2;
    const ht = height * k2;
    const parent = insertParent().el;
    const p2 = toParent(parent, (slideW - w2) / 2, (slideH - ht) / 2);
    return insertXml(
      `<image href="${relativePath(src.path, path)}" x="${fmt(p2.x)}" y="${fmt(p2.y)}" width="${fmt(w2)}" height="${fmt(ht)}" preserveAspectRatio="xMidYMid meet"/>`,
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
    const copy2 = el2.cloneNode(true);
    for (const node of [copy2, ...copy2.querySelectorAll("*")]) {
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
    return new XMLSerializer().serializeToString(copy2);
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
    let timer5 = 0;
    let asked = 0;
    let size4 = newChartBox();
    if (target.kind === "edit") {
      const el2 = slideRoot()?.querySelector(`[id="zone-${target.zone}"]`);
      const box = el2 ? slideBox(el2) : null;
      if (box) size4 = { ...size4, width: box.width, height: box.height };
    }
    const table = h("table", { class: "chart-grid" });
    const fields = h("div", { class: "chart-fields" });
    const preview = h("div", { class: "chart-preview" });
    preview.style.aspectRatio = `${size4.width} / ${size4.height}`;
    const status2 = h("span", { class: "hint chart-status" });
    const schedule2 = () => {
      window.clearTimeout(timer5);
      timer5 = window.setTimeout(() => void drawPreview(), 200);
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
        status2.textContent = res.error ?? "Cannot draw the chart";
        return;
      }
      status2.textContent = "";
      preview.innerHTML = String(res.svg ?? "");
    }
    function cellInput(row4, col, value) {
      const input = h("input", {
        type: "text",
        value,
        "data-row": row4,
        "data-col": col,
        spellcheck: "false"
      });
      if (row4 < 0) {
        input.classList.add("chart-head");
        input.addEventListener("change", () => {
          const r2 = renameColumn(grid, col, input.value, settings2);
          grid = r2.grid;
          settings2 = r2.settings;
          renderAll();
        });
      } else {
        input.addEventListener("input", () => {
          grid.rows[row4][col] = input.value;
          schedule2();
        });
        input.addEventListener("change", renderFields);
      }
      input.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter" || e2.key === "ArrowDown" || e2.key === "ArrowUp") {
          e2.preventDefault();
          const down = e2.key !== "ArrowUp";
          let next = row4 + (down ? 1 : -1);
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
    function focusCell2(row4, col) {
      const input = table.querySelector(
        `input[data-row="${row4}"][data-col="${col}"]`
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
      const body3 = grid.rows.map(
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
      table.append(h("thead", {}, head), h("tbody", {}, ...body3));
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
      const box = h("input", { type: "checkbox" });
      box.checked = on2;
      box.addEventListener("change", () => {
        set(box.checked);
        renderFields();
      });
      return h("label", { class: "chart-check" }, box, label4);
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
    function field(label4, control) {
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
      const shown2 = plotted(grid, settings2);
      const kind = settings2.kind;
      const title2 = h("input", {
        type: "text",
        value: settings2.title ?? "",
        placeholder: "none"
      });
      title2.addEventListener("input", () => {
        settings2.title = title2.value.trim() || null;
        schedule2();
      });
      fields.append(
        field(
          "Kind",
          select2(CHART_KINDS, kind, (v2) => {
            settings2.kind = v2;
          })
        ),
        field(
          kind === "scatter" ? "X values" : kind === "pie" ? "Slices" : "Categories",
          select2(
            grid.columns.map((c2) => ({ value: c2, label: c2 })),
            x2 ?? "",
            (v2) => {
              settings2.x = v2 === grid.columns[0] ? null : v2;
            }
          )
        ),
        field("Title", title2)
      );
      const series = h("div", { class: "chart-series" });
      const choices = grid.columns.filter((c2) => c2 !== x2);
      const twoAxes = secondAxisAllowed(settings2);
      for (const c2 of choices) {
        const usable = numeric.includes(c2);
        const box = check(c2, shown2.includes(c2), (on2) => {
          settings2.y = toggleSeries(grid, settings2, c2, on2);
          if (!on2) settings2.y2 = toggleRight(settings2, c2, false);
        });
        if (!usable) {
          box.classList.add("off");
          box.title = "Not all numbers";
        }
        if (twoAxes && usable && shown2.includes(c2)) {
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
            h("span", { class: "chart-series-row" }, box, right)
          );
        } else series.append(box);
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
      const range = (label4, lo, hi) => field(
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
        field(
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
    async function save4() {
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
      const box = newChartBox(target.at);
      const parent = insertParent();
      const a2 = toParent(parent.el, box.x, box.y);
      const b2 = toParent(parent.el, box.x + box.width, box.y + box.height);
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
    const body2 = h(
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
        preview,
        status2
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
            onclick: () => void save4()
          },
          target.kind === "insert" ? "Insert chart" : "Save"
        )
      )
    );
    openDialog(target.kind === "insert" ? "Insert chart" : "Chart data", body2, {
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
    const drawn = drawnDiagram(el2);
    if (drawn) return drawn;
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
  var open2 = null;
  function editDiagram(sel) {
    const image = diagramOf(sel.el);
    const src = sourceOf(sel.key);
    if (!image || !src) return;
    if (!src.writable) {
      toast("This picture lives in a layout; switch to layout mode", "error");
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
    if (open2) return;
    const res = await request({ action: "drawio-load", path: target.path });
    if (!res.ok) {
      toast(res.error ?? "Cannot open that diagram", "error");
      return;
    }
    const base2 = String(res.url);
    let origin;
    try {
      origin = new URL(base2).origin;
    } catch {
      toast(`INKFLOW_DRAWIO_URL is not a web address: ${base2}`, "error");
      return;
    }
    const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
    if (!navigator.onLine && !local) {
      offerDesktop(
        target,
        `This computer is offline, and draw.io loads from ${origin}.`
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
    const status2 = h("p", {}, `Loading draw.io from ${origin}\u2026`);
    const note = h(
      "div",
      { class: "drawio-note" },
      h(
        "div",
        { class: "drawio-note-card" },
        status2,
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
    const wrap2 = h("div", { id: "drawio", class: "drawio" }, frame, note);
    document.body.append(wrap2);
    open2 = wrap2;
    const slow = window.setTimeout(() => {
      if (loaded) return;
      status2.textContent = `draw.io did not load from ${origin}. Is this computer offline? Draw the diagram in draw.io desktop instead.`;
      note.classList.add("failed");
    }, 15e3);
    const post = (msg) => frame.contentWindow?.postMessage(JSON.stringify(msg), origin);
    const close2 = () => {
      window.clearTimeout(slow);
      window.removeEventListener("message", onMessage2);
      wrap2.remove();
      open2 = null;
    };
    const save4 = async (svg) => {
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
      if (e2.source !== frame.contentWindow || e2.origin !== origin) return;
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
          note.remove();
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
          if (svg) void save4(svg);
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
      window.setTimeout(() => void redraw(id, step2, n3), 600)
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
  async function redraw(id, step2, n3) {
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
    const box = now ? alignedBox(now, svg) : null;
    if (!now || !src || !box || !latest()) return;
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
        box,
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
    const origin = new URL(base2).origin;
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
        if (e2.source !== frame.contentWindow || e2.origin !== origin) return;
        const msg = parseMessage(e2.data);
        if (msg?.event === "configure") {
          frame.contentWindow?.postMessage(
            JSON.stringify({
              action: "configure",
              config: { compressXml: false }
            }),
            origin
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
      origin,
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
      let origin;
      try {
        origin = new URL(base2).origin;
      } catch {
        throw new Error(`INKFLOW_DRAWIO_URL is not a web address: ${base2}`);
      }
      const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
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
  var host3 = document.getElementById("objects");
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
  function label(el2) {
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
    const finish2 = (save4) => {
      if (done) return;
      done = true;
      const v2 = input.value.trim();
      if (save4 && v2 && v2 !== id) {
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
        ed.layoutMode ? "This object cannot be edited here" : "From a layout or overlay: use Edit layout to change it"
      );
      return;
    }
    select([el2]);
  }
  function row(el2, depth) {
    const loc = el2.getAttribute("data-ink") ?? "";
    const src = sourceOf(keyOf(el2));
    const writable = !!src?.writable && (canTransform(el2) || ed.layoutMode || isOwnObject(el2));
    const kids = children(el2);
    const group2 = kids.length > 0;
    const open5 = group2 && !collapsed.has(loc);
    const selected = ed.selection.some((s2) => s2.el === el2);
    const locked = el2.hasAttribute("data-ink-locked");
    const hidden = isHidden(el2);
    const name2 = h("span", { class: "obj-name" }, label(el2));
    const out = [];
    const item = h(
      "div",
      {
        class: `obj-row${selected ? " on" : ""}${writable ? "" : " foreign"}${hidden ? " hidden-obj" : ""}`,
        title: src ? `${label(el2)} \xB7 ${src.rel}` : label(el2),
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
    item.addEventListener("click", () => pickFromList(el2));
    item.addEventListener("dblclick", () => rename(el2, name2));
    item.addEventListener("mouseenter", () => setHover(el2));
    item.addEventListener("mouseleave", () => setHover(null));
    out.push(item);
    if (open5) {
      for (const k2 of [...kids].reverse()) out.push(...row(k2, depth + 1));
    }
    return out;
  }
  function isOwnObject(el2) {
    const src = sourceOf(keyOf(el2));
    return !!src && (src.role === "slide" || src.role === "ink") && src.writable;
  }
  function renderObjects() {
    if (host3.hidden) return;
    clear(host3);
    const svg = slideRoot();
    if (!svg) return;
    const top = [...svg.querySelectorAll("[data-ink-top], [data-ink-layer]")].filter((el2) => {
      const parent = el2.parentElement?.closest(
        "[data-ink-top], [data-ink-layer]"
      );
      return !parent || !svg.contains(parent);
    }).reverse();
    if (!top.length) {
      host3.append(h("p", { class: "hint" }, "No objects on this slide."));
      return;
    }
    host3.append(
      h(
        "p",
        { class: "hint" },
        "Top of the stack first. Middle-click (or Alt+click) on the slide steps through overlapping objects."
      )
    );
    for (const el2 of top) host3.append(...row(el2, 0));
  }
  function showTab(tab) {
    for (const b2 of tabs.querySelectorAll("[data-tab]")) {
      b2.classList.toggle("on", b2.dataset.tab === tab);
      b2.setAttribute("aria-selected", String(b2.dataset.tab === tab));
    }
    host3.hidden = tab !== "objects";
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
        const list3 = JSON.parse(el2?.getAttribute("data-cues") ?? "[]");
        const steps = list3.map((c2) => c2.step).sort((a2, b2) => a2 - b2);
        return steps[n3] ?? null;
      } catch {
        return null;
      }
    });
  }

  // src/ts/editor/animpreview.ts
  var current = null;
  function previewPlaying() {
    return current !== null;
  }
  function stopPreview() {
    current?.cancel();
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
    const sel = document.getElementById("step-select");
    if (sel) sel.value = step2 == null ? "" : String(step2);
    for (const row4 of document.querySelectorAll(
      ".anim-row[data-step]"
    )) {
      row4.classList.toggle(
        "playing",
        step2 != null && row4.dataset.step === String(step2)
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
    current = run;
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
    if (current === run) current = null;
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
  function section(title2, ...body2) {
    return h(
      "section",
      { class: "props-section" },
      h("h3", {}, title2),
      ...body2.filter((b2) => !!b2)
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
  function button(label4, title2, fn, cls = "") {
    return h(
      "button",
      { type: "button", class: `pbtn ${cls}`, title: title2, onclick: fn },
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
    const box = h("div", { class: "fields" });
    for (const f2 of schema) {
      const label4 = f2.name.replace(/_/g, " ");
      box.append(
        row2(
          label4,
          fieldControl(
            f2,
            values[f2.name] ?? f2.default,
            (v2) => commit({ ...values, [f2.name]: v2 })
          )
        )
      );
    }
    return box;
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
            button(
              poster ? "Change\u2026" : "Pick\u2026",
              poster ? `Poster: ${poster}` : "Still image shown before playback",
              async () => {
                const file = await pickFile("image/*");
                const up = file ? await upload(file) : null;
                if (up) commit("poster", up.path);
              }
            ),
            poster ? button(
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
          row2(
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
          row2(
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
        row2(
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
    return section(kind === "video" ? "Video" : "Image", ...rows);
  }
  function zonePageRow(slide, zone, ref) {
    const file = projectFile(ref);
    const page = pdfPage(ref);
    const show = (n3) => {
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
      numberInput(page, (n3) => show(Math.max(1, Math.round(n3))), { min: 1 }),
      button("Pages\u2026", "See the PDF's pages and pick one", async () => {
        const choice = file ? await choosePage(file, page) : null;
        if (choice) show(choice.page);
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
    const shown2 = s2.y ?? numeric.filter((c2) => c2 !== x2);
    const check = (label4, on2, fn) => {
      const box = h("input", { type: "checkbox" });
      box.checked = on2;
      box.addEventListener("change", () => fn(box.checked));
      return row2(label4, box);
    };
    const series = h("div", { class: "chart-series" });
    const twoAxes = secondAxisAllowed(s2);
    for (const c2 of grid.columns.filter((c3) => c3 !== x2)) {
      const box = h("input", { type: "checkbox" });
      box.checked = shown2.includes(c2);
      box.disabled = !numeric.includes(c2);
      box.addEventListener("change", () => {
        const next = grid.columns.filter(
          (n3) => n3 === c2 ? box.checked : shown2.includes(n3)
        );
        const auto = numeric.filter((n3) => n3 !== x2);
        const same = next.length === auto.length && next.every((n3, i2) => n3 === auto[i2]);
        commit({
          y: same ? null : next,
          ...box.checked ? {} : { y2: toggleRight(s2, c2, false) }
        });
      });
      const entry = h("label", { class: "chart-check" }, box, c2);
      if (twoAxes && shown2.includes(c2) && numeric.includes(c2)) {
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
      row2(
        "Kind",
        selectInput(CHART_KINDS, s2.kind, (v2) => commit({ kind: v2 }))
      ),
      row2(
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
      row2(
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
      row2(
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
    return section("Chart", ...rows);
  }
  function typeInfo(list3, type) {
    return list3.find((t2) => t2.type === type) ?? null;
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
      section(
        "Slide",
        row2(
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
        row2(
          "Layout",
          button(
            `${currentLayout ? layoutLabel(currentLayout) : "None"} \u25BE`,
            "Pick a layout from previews",
            () => void openGallery({
              mode: "change",
              current: currentLayout
            }),
            "wide"
          )
        ),
        row2(
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
        row2(
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
        button(
          "Rename files\u2026",
          "Give this slide's drawing, Markdown, notes and ink one new name (its id follows)",
          () => renameSlideFiles(di)
        )
      );
    const textInDeck = slide.md?.kind !== "file" && (slide.md?.kind === "inline" || Object.values(slide.zones).some((z) => z.kind === "text"));
    if (textInDeck && editable)
      files2.append(
        button(
          "Move text to Markdown",
          "Move this slide's text out of deck.py into its own .md file",
          () => void edit({ action: "to-markdown", slide: di })
        )
      );
    panel.append(section("Files", files2));
    const arrows = attachedConnectors();
    if (arrows.length) {
      const stale = arrows.filter((a2) => isStale(a2.el)).length;
      panel.append(
        section(
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
          button(
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
          "This slide is drawn by a shared layout. Draw on it (or insert anything) and it gets its own SVG built on that layout. Use \u201CEdit layout\u201D to change the layout itself."
        )
      );
    }
  }
  function transitionSection(current2, di) {
    const model2 = ed.model;
    const types = model2.transitionTypes;
    const value = current2?.type ?? "";
    const opts2 = [
      { value: "", label: `Deck default (${model2.defaultTransition.type})` },
      ...types.map((t2) => ({ value: t2.type, label: t2.type }))
    ];
    const send = (spec) => void edit({ action: "slide", op: "transition", slide: di, spec });
    const body2 = [
      row2(
        "Type",
        selectInput(opts2, value, (v2) => {
          if (!v2) send(null);
          else send({ type: v2, fields: {} });
        })
      )
    ];
    if (current2) {
      const info4 = typeInfo(types, current2.type);
      if (info4) {
        body2.push(
          fieldsEditor(
            info4.fields,
            current2.fields,
            (fields) => send({ type: current2.type, fields })
          )
        );
      }
    }
    return section("Transition into this slide", ...body2);
  }
  function triggerLabel(t2) {
    if (t2 === "with-previous") return "with previous";
    if (t2 === "after-previous") return "after previous";
    if (t2 === "on-click" || t2 == null) return "on click";
    return `step ${t2}`;
  }
  function animationList(cues, editable, di) {
    const model2 = ed.model;
    const list3 = h("div", { class: "anim-list" });
    if (!cues.length)
      list3.append(h("p", { class: "hint" }, "No animations on this slide."));
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
          const names = new Set(
            typeInfo(model2.animationTypes, v2)?.fields.map(
              (f2) => f2.name
            )
          );
          const kept = Object.fromEntries(
            Object.entries(cue.fields).filter(([k2]) => names.has(k2))
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
      const item = h(
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
          step2 != null && button(
            icon("play", 12),
            "Preview from this animation",
            () => void playAnimations(step2),
            "anim-preview-ctl"
          ),
          editable && button(icon("up", 12), "Earlier", () => {
            if (i2 > 0)
              void edit({
                action: "anim",
                slide: di,
                op: "move",
                index: i2,
                to: i2 - 1
              });
          }),
          editable && button(icon("down", 12), "Later", () => {
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
          editable && button(icon("trash", 12), "Remove", () => {
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
      list3.append(item);
    });
    if (!editable && cues.length) {
      list3.append(
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
      playing ? button(
        "\u25A0 Stop",
        "Stop the preview (Esc)",
        () => stopPreview(),
        "anim-preview-ctl"
      ) : button(
        "\u25B6 Play",
        "Play this slide's animations here, click by click",
        () => void playAnimations(1),
        "anim-preview-ctl"
      )
    );
    if (!animated && !playing)
      controls.firstChild.disabled = true;
    return section("Animation order", controls, list3);
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
    const body2 = h("div", { class: "anim-list" });
    const elementName = isZone(sel.el) ? zoneName(sel.el) : id;
    const steps = cueSteps(slide.animations, slideRoot());
    slide.animations.forEach((cue, index) => {
      if (!elementName || cue.element !== (cue.kind === "video" ? zoneName(sel.el) : id))
        return;
      const info4 = typeInfo(model2.animationTypes, cue.type);
      const send = (type, fields) => void edit({
        action: "anim",
        slide: di,
        op: "replace",
        index,
        spec: { type, element: cue.element, fields }
      });
      const header = h(
        "div",
        { class: "anim-head" },
        h("span", { class: `anim-kind k-${cue.kind}` }),
        editable ? selectInput(
          model2.animationTypes.map((t2) => ({
            value: t2.type,
            label: t2.type
          })),
          cue.type,
          (v2) => send(v2, {
            trigger: cue.fields.trigger ?? "on-click"
          })
        ) : h("span", {}, cue.type),
        steps[index] != null && button(
          icon("play", 12),
          `Preview (click ${steps[index]})`,
          () => void playAnimations(steps[index] ?? 1),
          "anim-preview-ctl"
        ),
        editable && button(icon("trash", 12), "Remove", () => {
          void edit({
            action: "anim",
            slide: di,
            op: "remove",
            index
          });
        })
      );
      body2.append(
        h(
          "div",
          { class: "anim-card" },
          header,
          info4 && editable ? fieldsEditor(
            info4.fields,
            cue.fields,
            (f2) => send(cue.type, f2)
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
      body2.append(add);
    } else if (!slide.animationsEditable) {
      body2.append(
        h(
          "p",
          { class: "hint" },
          "This slide's animations are built in code."
        )
      );
    }
    return section("Animations", body2);
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
    const shown2 = boxShown(first);
    const token = shown2 ? tokenOf(first, prop) : null;
    const computed = shown2 ? getComputedStyle(first)[prop] : "none";
    const send = (paint) => {
      const plans = sel.map((s2) => ({
        sel: s2,
        ops: [
          ...boxOps(s2),
          { kind: "paint", loc: s2.loc, prop, ...paint }
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
          onclick: () => send({ token: t2 })
        })
      );
    }
    const custom = h("input", {
      type: "color",
      value: computed && computed !== "none" ? rgbToHex(computed) : "#000000",
      title: "Custom colour"
    });
    custom.addEventListener("change", () => send({ color: custom.value }));
    swatches.append(custom);
    swatches.append(
      button("\u2205", "None", () => send({ color: "none" }), "none-btn")
    );
    return row2(prop === "fill" ? "Fill" : "Stroke", swatches);
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
  function cellColorRow(label4, current2, pick2) {
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
      value: current2,
      title: "Custom colour"
    });
    custom.addEventListener("change", () => pick2(custom.value));
    swatches.append(custom);
    return row2(label4, swatches);
  }
  function renderCellPanel(sel) {
    const el2 = sel.el;
    const cell = el2.getAttribute("data-cell-id") ?? "";
    const themed = el2.closest("svg[data-drawio]")?.getAttribute("data-drawio-mode") === "themed";
    const send = (op, label4) => void sendSvgOps([{ sel, ops: [op] }], label4);
    const style = (key, value, label4) => send({ kind: "cell-style", cell, key, value }, label4);
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
      () => send({ kind: "cell-label", cell, text: area2.value }, "Shape label")
    );
    area2.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" && !e2.shiftKey) {
        e2.preventDefault();
        area2.blur();
      }
    });
    panel.append(
      section(
        "draw.io shape",
        row2("Id", h("code", {}, el2.getAttribute("id") ?? "")),
        row2("Label", area2),
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
        row2(
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
          button("Leave the diagram", "Esc", () => enterGroup(null))
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
      section(
        tag,
        row2(
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
    if (zone) {
      const slide = currentSlide();
      const name2 = zoneName(el2);
      const origin = slide.zoneOrigins?.[name2];
      const media = slide.zones[name2];
      const where = origin === "deck" ? "deck.py zones=" : origin === "md-file" ? `${slide.md?.rel ?? "Markdown"} (whole file)` : slide.md?.rel ? `${slide.md.rel} \xB7 ::${name2}::` : "deck.py";
      const textFile = origin === "deck" || !slide.md?.path ? ed.model?.deckPath : slide.md.path;
      const isMedia = !!media && (media.kind === "image" || media.kind === "video" || media.kind === "chart");
      const body2 = [
        h(
          "div",
          { class: "source-hint" },
          h("p", { class: "hint" }, `Content from ${where}`),
          isMedia ? null : openButton(textFile)
        )
      ];
      if (media?.kind === "chart") {
        body2.push(
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
          button(
            "Edit data\u2026",
            "Edit the chart's table (double-click)",
            () => void editChart(name2)
          )
        );
      } else if (media && (media.kind === "image" || media.kind === "video")) {
        body2.push(
          h(
            "div",
            { class: "source-hint" },
            h("p", { class: "hint media-src" }, media.src ?? ""),
            openButton(projectFile(media.src)),
            renameButton(projectFile(media.src))
          ),
          ...media.kind === "image" && isPdfRef(media.src ?? "") ? [zonePageRow(slide, name2, media.src ?? "")] : [],
          button(
            "Replace media\u2026",
            "Pick another image or video",
            () => void zoneMedia(name2)
          ),
          button("Clear", "Empty this zone", () => {
            void edit({
              action: "zone-media",
              slide: slide.deckIndex,
              zone: name2,
              src: null
            });
          })
        );
        const video = media.kind === "video" ? videoOf(el2) : null;
        if (video) body2.push(previewButton(video, button));
        if (media.kind === "video" && media.src) {
          const src2 = media.src;
          body2.push(
            button(
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
        body2.push(
          button(
            "Edit text",
            "Edit this zone's Markdown (double-click)",
            () => {
              emit("edit-zone");
            }
          )
        );
      }
      panel.append(section("Content", ...body2));
      if (media && (media.kind === "image" || media.kind === "video")) {
        panel.append(mediaSection(slide, name2, media));
      }
      if (media?.kind === "chart") {
        panel.append(chartSection(slide, name2, media));
      }
    }
    const innerVideo = zone ? null : videoOf(el2);
    if (innerVideo) {
      panel.append(section("Video", previewButton(innerVideo, button)));
    }
    if (movable) panel.append(geometrySection([sel]));
    const textZone = zone && el2.localName === "foreignObject" && !!el2.querySelector(".inkflow-content");
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
        section(
          "Style",
          fills && !picture && paintRow([sel], "fill"),
          !picture && el2.localName !== "g" && paintRow([sel], "stroke"),
          !picture && el2.localName !== "g" && row2(
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
          row2(
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
          shapeTag === "rect" && row2(
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
    if (id || zone || src?.writable) panel.append(elementAnimations(sel));
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
    const send = (set, label4, marker = false) => void sendSvgOps(
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
    return section(
      "Connector",
      row2(
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
            send(
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
      row2(
        "Arrowheads",
        selectInput(
          [
            { value: "none", label: "None" },
            { value: "end", label: "At the end" },
            { value: "start", label: "At the start" },
            { value: "both", label: "Both ends" }
          ],
          heads,
          (v2) => send(
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
        button(
          "Re-route",
          "Re-attach to the shapes where they are now",
          () => reroute([sel])
        ),
        el2.hasAttribute("inkflow:bend") && button(
          "Reset bend",
          "Put the elbow's middle segment back where it goes by default",
          () => {
            const d2 = connectorPath(el2, {}, "elbow", null);
            send(
              { "inkflow:bend": null, ...d2 ? { d: d2 } : {} },
              "Reset bend"
            );
          }
        ),
        button(
          "Detach",
          "Free both ends",
          () => send(
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
    const box = section(
      "Connection points",
      row2(
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
    box.addEventListener(
      "mouseenter",
      () => showSites([{ el: sel.el, active: null }])
    );
    box.addEventListener("mouseleave", () => showSites([]));
    return box;
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
    const shown2 = el2.hasAttribute("inkflow:show-shape");
    const box = h("input", { type: "checkbox" });
    box.checked = shown2;
    box.addEventListener(
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
                  "inkflow:show-shape": box.checked ? "true" : null
                }
              }
            ]
          }
        ],
        box.checked ? "Show box" : "Hide box"
      )
    );
    const padding = parseFloat(value("--inkflow-padding"));
    return section(
      "Text box",
      row2("Draw the box", box),
      row2(
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
      row2(
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
      row2(
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
    return section(
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
        button(
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
        button(
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
                  relativePath(src.path, up.path),
                  page
                ),
                "xlink:href": null
              },
              "Replace picture"
            );
          }
        ),
        ed.cropMode ? button(
          "Done cropping",
          "Enter",
          () => setCropMode(false),
          "on"
        ) : button(
          "Crop",
          "Crop (double-click the picture)",
          () => void startCrop(sel)
        ),
        cropped ? button(
          "Reset crop",
          "Show the whole picture again",
          () => void resetCrop(sel)
        ) : null
      ),
      row2(
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
    const show = async (n3, shown2) => {
      const url = shown2 ?? await pageUrl(file, n3);
      const src = sourceOf(sel.key);
      const root2 = ed.model?.projectDir;
      if (!url || !src || !root2 || n3 === page) return;
      const set = {
        href: withPage(relativePath(src.path, `${root2}/${file}`), n3),
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
      numberInput(page, (n3) => void show(Math.max(1, Math.round(n3))), {
        min: 1
      }),
      button("Pages\u2026", "See the PDF's pages and pick one", async () => {
        const choice = await choosePage(file, page);
        if (choice) void show(choice.page, choice.url);
      })
    );
  }
  function showAsRow(sel, mode2) {
    return row2(
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
    return section(
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
        button(
          "Edit diagram",
          "Open it in draw.io (or double-click it)",
          () => editDiagram(sel),
          "on"
        )
      ),
      showAsRow(sel, diagramMode(svg)),
      editShapesRow(sel, svg),
      row2(
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
    const box = h("input", { type: "checkbox" });
    box.checked = on2;
    box.addEventListener("change", () => {
      void sendSvgOps(
        [
          {
            sel,
            ops: [
              {
                kind: "attrs",
                loc: sel.loc,
                set: {
                  "inkflow:drawio-edit": box.checked ? "shapes" : null
                }
              }
            ]
          }
        ],
        box.checked ? "Edit diagram shapes here" : "Edit diagram in draw.io"
      );
    });
    return h(
      "div",
      {},
      h("label", { class: "check-row" }, box, " Edit shapes here"),
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
    const list3 = h("div", { class: "diagram-shapes" });
    const flash = (el2, on2) => setHover(on2 ? el2 : null);
    for (const shape of shapes2) {
      const count = slide.animations.filter(
        (c2) => c2.element === shape.id
      ).length;
      const name2 = shape.label || `(${shape.id.slice(svg.id.length + 1)})`;
      const item = h(
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
      item.addEventListener("mouseenter", () => flash(shape.el, true));
      item.addEventListener("mouseleave", () => flash(shape.el, false));
      if (editable) {
        const add = animationPicker(
          model2.animationTypes,
          false,
          "Animate\u2026"
        );
        add.addEventListener("change", () => {
          if (!add.value) return;
          flash(shape.el, false);
          void edit({
            action: "anim",
            slide: slide.deckIndex,
            op: "insert",
            index: slide.animations.length,
            spec: { type: add.value, element: shape.id, fields: {} }
          });
        });
        item.append(add);
      }
      list3.append(item);
    }
    return section(
      "Shapes",
      h(
        "p",
        { class: "hint" },
        "Animate the diagram's shapes one by one. To change a shape, edit the diagram in draw.io."
      ),
      list3
    );
  }
  function backgroundRow(current2, commit) {
    const value = typeof current2 === "string" ? current2 : "";
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
    const list3 = h("datalist", { id: "slide-link-list" });
    for (const s2 of ed.model?.slides ?? []) {
      if (!s2.id) continue;
      list3.append(h("option", { value: `slide:${s2.id}` }, s2.title ?? s2.id));
    }
    return list3;
  }
  function detailsSection(sel) {
    const title2 = [...sel.el.children].find((c2) => c2.localName === "title")?.textContent ?? "";
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
    return section(
      "Link & alt text",
      slideOptions(),
      row2("Link", link),
      row2(
        "Alt text",
        textInput(
          title2,
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
    return section(
      "Text",
      row2(
        "Size",
        numberInput(
          parseFloat(cs.fontSize),
          (v2) => setAll({ "font-size": `${v2}px` }, "Font size")
        )
      ),
      row2(
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
        button(
          h("b", {}, "B"),
          "Bold",
          () => setAll({ "font-weight": bold ? null : "bold" }, "Bold"),
          bold ? "on" : ""
        ),
        button(
          h("i", {}, "I"),
          "Italic",
          () => setAll(
            { "font-style": italic ? null : "italic" },
            "Italic"
          ),
          italic ? "on" : ""
        ),
        button(
          "\u27F8",
          "Align start",
          () => setAll({ "text-anchor": null }, "Align"),
          anchor2 === "start" ? "on" : ""
        ),
        button(
          "\u21D4",
          "Align middle",
          () => setAll({ "text-anchor": "middle" }, "Align"),
          anchor2 === "middle" ? "on" : ""
        ),
        button(
          "\u27F9",
          "Align end",
          () => setAll({ "text-anchor": "end" }, "Align"),
          anchor2 === "end" ? "on" : ""
        ),
        button("Edit", "Edit text (double-click)", () => emit("edit-text"))
      )
    );
  }
  function geometrySection(sels) {
    const box = sels.length === 1 ? slideBox(sels[0].el) : selectionBox();
    if (!box) return h("div");
    const resizeTo = (to) => {
      const plans = sels.map((s2) => {
        const b2 = slideBox(s2.el);
        const sx = box.width ? to.width / box.width : 1;
        const sy = box.height ? to.height / box.height : 1;
        const target = {
          x: to.x + (b2.x - box.x) * sx,
          y: to.y + (b2.y - box.y) * sy,
          width: b2.width * sx,
          height: b2.height * sy
        };
        const plan = planResize(elementGeom(s2.el), b2, target);
        return {
          sel: s2,
          ops: [{ kind: "attrs", loc: s2.loc, set: plan }]
        };
      });
      void sendSvgOps(plans, "Resize");
    };
    const rot = sels.length === 1 ? rotationOf(parseTransform(sels[0].el.getAttribute("transform"))) : 0;
    return section(
      "Position & size",
      h(
        "div",
        { class: "grid2" },
        row2(
          "X",
          numberInput(box.x, (v2) => resizeTo({ ...box, x: v2 }))
        ),
        row2(
          "Y",
          numberInput(box.y, (v2) => resizeTo({ ...box, y: v2 }))
        ),
        row2(
          "W",
          numberInput(
            box.width,
            (v2) => resizeTo({ ...box, width: Math.max(1, v2) }),
            { min: 1 }
          )
        ),
        row2(
          "H",
          numberInput(
            box.height,
            (v2) => resizeTo({ ...box, height: Math.max(1, v2) }),
            { min: 1 }
          )
        )
      ),
      sels.length === 1 && row2(
        "Rotation",
        numberInput(
          rot,
          (v2) => {
            const s2 = sels[0];
            const center = {
              x: box.x + box.width / 2,
              y: box.y + box.height / 2
            };
            const plan = planRotate(
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
                      set: plan
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
    return section(
      "Arrange",
      h(
        "div",
        { class: "btn-row" },
        button("\u21C8", "Bring to front (Ctrl+Shift+\u2191)", () => order2("front")),
        button("\u2191", "Bring forward (Ctrl+\u2191)", () => order2("forward")),
        button("\u2193", "Send backward (Ctrl+\u2193)", () => order2("backward")),
        button("\u21CA", "Send to back (Ctrl+Shift+\u2193)", () => order2("back")),
        button(
          icon("copy", 14),
          "Duplicate (Ctrl+D)",
          () => emit("duplicate")
        ),
        sels.length > 1 && button(
          icon("group", 14),
          "Group (Ctrl+G)",
          () => emit("group")
        ),
        isGroup && button(
          "Ungroup",
          "Ungroup (Ctrl+Shift+G)",
          () => emit("ungroup")
        ),
        button(
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
    panel.append(section(`${sels.length} objects`));
    if (movable) {
      const a2 = (label4, title2, how) => button(label4, title2, () => alignSelection(how));
      panel.append(
        section(
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
          section(
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
    if (ed.selection.length === 0) renderSlidePanel();
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
    on("render", renderProps);
    on("preview", renderProps);
    panel.addEventListener("keydown", (e2) => {
      const field = e2.target;
      if (e2.key !== "Escape" || !typingIn(field)) return;
      e2.preventDefault();
      field.blur();
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
  var copied = null;
  function kindOf(el2) {
    if (el2.localName === "text") return "text";
    if (isZone(el2)) return "box";
    return "shape";
  }
  function read(el2, prop) {
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
    return copied !== null;
  }
  function copyStyle() {
    const sel = ed.selection[0];
    const el2 = sel ? painted(sel.el) : null;
    if (!el2) {
      toast("Select an object to copy its style from");
      return;
    }
    const kind = kindOf(el2);
    const names = [...COMMON, ...PAINT, ...MARKERS, ...FONT, ...BOX_VARS];
    copied = {
      kind,
      tag: el2.localName,
      classes: [...el2.classList].filter((c2) => PAINT_CLASS.test(c2)),
      props: Object.fromEntries(names.map((n3) => [n3, read(el2, n3)])),
      radius: { rx: el2.getAttribute("rx"), ry: el2.getAttribute("ry") },
      showShape: el2.getAttribute(SHOW_SHAPE) === "true"
    };
    toast("Style copied: select objects and press Ctrl+Alt+V to apply it");
  }
  function propsFor(style, el2) {
    const kind = kindOf(el2);
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
    if (kindOf(el2) === "box" && style.kind === "box") {
      attrs2[SHOW_SHAPE] = style.showShape ? "true" : null;
    }
    if (Object.keys(attrs2).length) {
      ops.push({ kind: "attrs", loc: sel.loc, set: attrs2 });
    }
    ops.push({ kind: "style", loc: sel.loc, set });
    return ops;
  }
  async function pasteStyle() {
    const style = copied;
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
  var timer = 0;
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
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 220);
  }
  function fileLabel(path) {
    const root2 = ed.model?.projectDir ?? "";
    return path.startsWith(root2) ? path.slice(root2.length + 1) : path;
  }
  function renderResults(error2) {
    const list3 = el(".find-results");
    const status2 = el(".find-status");
    clear(list3);
    if (error2) {
      status2.textContent = error2;
      return;
    }
    if (!query()) {
      status2.textContent = "";
      return;
    }
    const slides = new Set(hits.flatMap(slidesOf));
    status2.textContent = hits.length ? `${hits.length}${hits.length >= 500 ? "+" : ""} match${hits.length === 1 ? "" : "es"} on ${slides.size} slide${slides.size === 1 ? "" : "s"}` : "No matches";
    let lastGroup = "";
    hits.forEach((hit, i2) => {
      const on2 = slidesOf(hit);
      const first = on2[0];
      const slide = first != null ? ed.model?.slides[first] : null;
      const group2 = slide != null ? `${first + 1} \xB7 ${slide.title ?? slide.id ?? ""}` : fileLabel(hit.file);
      if (group2 !== lastGroup) {
        list3.append(h("div", { class: "find-group" }, group2));
        lastGroup = group2;
      }
      const where = hit.kind === "deck" ? "deck.py" : `${fileLabel(hit.file)}${on2.length > 1 ? ` \xB7 ${on2.length} slides` : ""}`;
      const row4 = h(
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
      list3.append(row4);
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
  function toggle(name2, btn) {
    opts[name2] = !opts[name2];
    btn.classList.toggle("on", opts[name2]);
    schedule();
  }
  function build() {
    const flag = (label4, title2, name2) => {
      const b2 = h(
        "button",
        { type: "button", class: "find-flag", title: title2 },
        label4
      );
      b2.addEventListener("click", () => toggle(name2, b2));
      return b2;
    };
    const find = h("input", {
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
    find.addEventListener("input", () => {
      active = -1;
      schedule();
    });
    find.addEventListener("keydown", (e2) => {
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
        find,
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
    const row4 = tops.indexOf(me.top) + dir;
    if (row4 < 0 || row4 >= tops.length) return i2;
    const center = me.left + me.width / 2;
    let best2 = i2;
    let bestD = Number.POSITIVE_INFINITY;
    boxes.forEach((b2, j2) => {
      if (b2.top !== tops[row4]) return;
      const d2 = Math.abs(b2.left + b2.width / 2 - center);
      if (d2 < bestD) {
        best2 = j2;
        bestD = d2;
      }
    });
    return best2;
  }

  // src/ts/editor/grid.ts
  var view = document.getElementById("grid-view");
  var list2 = document.getElementById("grid-list");
  var sizeInput = document.getElementById("grid-size");
  var thumbs2 = new Thumbs();
  function toggleGrid(on2 = view.hidden === true) {
    view.hidden = !on2;
    document.body.classList.toggle("grid-mode", on2);
    document.getElementById("btn-grid")?.classList.toggle("on", on2);
    if (on2) {
      ed.focus = "sorter";
      renderGrid();
      view.focus();
    } else {
      ed.focus = "canvas";
      emit("slide");
    }
  }
  function open3(i2) {
    ed.slideSelection.clear();
    toggleGrid(false);
    gotoSlide(i2);
  }
  function lastMark() {
    return list2.lastElementChild;
  }
  function gridItem(slide, i2) {
    const item = h(
      "div",
      {
        class: `grid-item${i2 === ed.current ? " active" : ""}${ed.slideSelection.has(i2) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
        draggable: ed.model?.deckEditable ? "true" : null,
        "data-index": i2
      },
      thumbs2.thumb(slide),
      h(
        "div",
        { class: "grid-caption" },
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
        ) : null
      )
    );
    item.addEventListener("click", (e2) => {
      pickSlide(i2, e2);
      ed.focus = "sorter";
    });
    item.addEventListener("dblclick", () => open3(i2));
    item.addEventListener("contextmenu", (e2) => {
      e2.preventDefault();
      if (!ed.slideSelection.has(i2)) {
        ed.slideSelection.clear();
        gotoSlide(i2);
      }
      ed.focus = "sorter";
      openSlideMenu(e2.clientX, e2.clientY, i2);
    });
    item.addEventListener("dragstart", (e2) => {
      dragging.now = { kind: "slides", slides: dragSlides(i2) };
      e2.dataTransfer?.setData("text/plain", String(i2));
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      dragging.now = null;
      clearDropMarks(list2);
      item.classList.remove("dragging");
    });
    item.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        markGap(list2, sectionGapAtSlide(sections(), i2), lastMark());
        return;
      }
      const r2 = item.getBoundingClientRect();
      clearDropMarks(list2);
      item.classList.add(
        e2.clientX > r2.left + r2.width / 2 ? "drop-after" : "drop-before"
      );
    });
    item.addEventListener("drop", (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      const drag = dragging.now;
      clearDropMarks(list2);
      if (!drag) return;
      if (drag.kind === "section") {
        void moveSectionToGap(
          drag.section,
          sectionGapAtSlide(sections(), i2)
        );
        return;
      }
      const r2 = item.getBoundingClientRect();
      const after = e2.clientX > r2.left + r2.width / 2;
      const target = dropOnSlide(sections(), i2, after);
      void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return item;
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
      clearDropMarks(list2);
    });
    head.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag) return;
      e2.preventDefault();
      e2.stopPropagation();
      if (drag.kind === "section") {
        markGap(list2, headerGap(head, k2, e2), lastMark());
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
  function renderGrid() {
    if (view.hidden) return;
    clear(list2);
    thumbs2.begin();
    const slides = ed.model?.slides ?? [];
    const all = sections();
    for (const block of sectionBlocks(slides.length, all)) {
      const k2 = block.section;
      const wrap2 = h("div", {
        class: `grid-section${k2 == null ? " unsectioned" : ""}`
      });
      if (k2 != null) wrap2.append(gridHeader(k2));
      if (k2 == null || !isCollapsed(k2)) {
        const grid = h("div", { class: "grid-section-list" });
        for (const i2 of block.slides) grid.append(gridItem(slides[i2], i2));
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
      list2.append(wrap2);
    }
    thumbs2.end();
    list2.querySelector(".grid-item.active")?.scrollIntoView({
      block: "nearest"
    });
  }
  function shown() {
    return [...list2.querySelectorAll(".grid-item")];
  }
  function onKey(e2) {
    if (view.hidden) return;
    const target = e2.target;
    if (target.closest("input, textarea, select, #dialog, #find-panel")) return;
    const items = shown();
    const indices = items.map((el2) => Number(el2.dataset.index));
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
      const boxes = items.map((el2) => {
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
        open3(ed.current);
        break;
      case "Escape":
        e2.preventDefault();
        e2.stopPropagation();
        toggleGrid(false);
        break;
    }
  }
  function setSize(px) {
    view.style.setProperty("--grid-w", `${px}px`);
    try {
      localStorage.setItem("inkflow-editor-grid", String(px));
    } catch {
    }
  }
  function initListDrop2() {
    list2.addEventListener("dragover", (e2) => {
      const drag = dragging.now;
      if (!drag || e2.target !== list2) return;
      e2.preventDefault();
      if (drag.kind === "section") {
        markGap(list2, sections().length, lastMark());
      } else {
        clearDropMarks(list2);
        lastMark()?.classList.add("drop-after");
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
  function initGrid() {
    document.getElementById("btn-grid")?.addEventListener("click", () => toggleGrid());
    document.getElementById("grid-close")?.addEventListener("click", () => toggleGrid(false));
    document.addEventListener("keydown", onKey, true);
    let saved = 280;
    try {
      saved = Number(localStorage.getItem("inkflow-editor-grid")) || 280;
    } catch {
    }
    sizeInput.value = String(saved);
    setSize(saved);
    sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
    initListDrop2();
    on("model", renderGrid);
    on("slide", renderGrid);
    on("slide-selection", renderGrid);
    on("sections", renderGrid);
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
        const title2 = el2.getAttribute("title");
        const t2 = title2 ? ` "${title2.replace(/"/g, '\\"')}"` : "";
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
  function listMarkdown(list3) {
    const ordered = list3.localName === "ol";
    const tasks = list3.classList.contains(TASK_LIST);
    let n3 = parseInt(list3.getAttribute("start") ?? "1", 10) || 1;
    const lines = [];
    for (const li of list3.children) {
      if (li.localName !== "li") throw new Unsupported(li.localName);
      const cls = li.getAttribute("class") ?? "";
      if (!plain(li, cls === TASK_ITEM || !cls ? ["class"] : [])) {
        throw new Unsupported("li with attributes");
      }
      const box = [...li.childNodes].find(isCheckbox);
      const task = tasks || cls === TASK_ITEM || box !== void 0;
      const bullet = ordered ? `${n3++}. ` : "- ";
      const marker = `${bullet}${task ? box?.checked ? "[x] " : "[ ] " : ""}`;
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
    active2 = {
      commit: async () => {
        el2.style.visibility = "";
        const lines = area2.value.replace(/\r/g, "").split("\n");
        if (lines.join("\n") === original.join("\n")) return;
        if (lines.length === 1 && !el2.querySelector("tspan")) {
          el2.textContent = lines[0];
        }
        await edit({
          action: "svg",
          file: sourcePath,
          hash: hash(),
          ops: [{ kind: "text", loc, lines }],
          label: "Edit text"
        });
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
  function editZoneText(zone) {
    void finishTextEdit();
    const slide = currentSlide();
    if (!slide) return;
    const origin = slide.zoneOrigins?.[zone];
    const original = slide.zoneText?.[zone] ?? "";
    const deckIndex = slide.deckIndex;
    if (!ed.model?.deckEditable && (origin === "deck" || !slide.md)) {
      toast(
        "deck.py builds its slides in code; edit this zone there",
        "error"
      );
      return;
    }
    const area2 = h("textarea", { class: "zone-editor", spellcheck: "true" });
    area2.value = original;
    let sent2 = original;
    let timer5 = 0;
    const coalesce = `zone-${deckIndex}-${zone}-${Date.now()}`;
    const send = async () => {
      window.clearTimeout(timer5);
      if (area2.value === sent2) return;
      const before = sent2;
      sent2 = area2.value;
      const result = await edit(
        {
          action: "zone-text",
          slide: deckIndex,
          zone,
          text: area2.value,
          origin,
          coalesce
        },
        { retrying: true }
      );
      if (!result.ok) {
        sent2 = before;
        timer5 = window.setTimeout(() => void send(), 800);
      }
    };
    area2.addEventListener("input", () => {
      window.clearTimeout(timer5);
      timer5 = window.setTimeout(() => void send(), 450);
    });
    const button5 = (name2, title2, fn) => h(
      "button",
      {
        type: "button",
        class: "fmt-btn",
        title: title2,
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
      button5("B", "Bold (Ctrl+B)", () => wrapSelection(area2, "**")),
      button5("I", "Italic (Ctrl+I)", () => wrapSelection(area2, "*")),
      button5("H", "Heading", () => prefixLines(area2, "## ")),
      button5("\u2022", "Bullet list", () => prefixLines(area2, "- ")),
      button5("1.", "Numbered list", () => prefixLines(area2, "1. ")),
      button5("`", "Code", () => wrapSelection(area2, "`")),
      button5("\u2211", "Math", () => wrapSelection(area2, "$")),
      button5("\u23F5", "Reveal on click: insert a ::step:: marker", () => {
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
        await send();
      },
      cancel: () => {
        window.clearTimeout(timer5);
        if (sent2 !== original) {
          area2.value = original;
          void send();
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
    const origin = slide.zoneOrigins?.[zone];
    if (!ed.model?.deckEditable && (origin === "deck" || !slide.md)) {
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
    ed.richEditing = true;
    richHost = content2;
    fo.classList.add("rich-editing");
    fo.style.overflow = "visible";
    content2.contentEditable = "true";
    for (const box of content2.querySelectorAll(
      "input[type=checkbox]"
    )) {
      box.disabled = false;
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
        const result = await edit({
          action: "zone-text",
          slide: deckIndex,
          zone,
          text: md,
          origin,
          svg: grow
        });
        if (!result.ok) emit("rerender");
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
    const current2 = a2?.getAttribute("href") ?? "";
    const url = window.prompt(
      a2 ? "Link address: https://\u2026 or slide:<id> (empty removes the link)" : "Link address: https://\u2026 or slide:<id>",
      current2 || "https://"
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
    const row4 = cell.parentElement;
    const table = row4.closest("table");
    let body2 = table.tBodies[0];
    if (!body2) {
      body2 = document.createElement("tbody");
      table.append(body2);
    }
    const tr = document.createElement("tr");
    for (const c2 of row4.children) tr.append(newCell("td", c2));
    if (row4.parentElement?.localName === "thead") body2.prepend(tr);
    else row4.after(tr);
  }
  function addColumn2(cell) {
    const table = cell.closest("table");
    const index = cell.cellIndex;
    for (const row4 of table.rows) {
      const ref = row4.cells[index];
      const tag = row4.parentElement?.localName === "thead" ? "th" : "td";
      const c2 = newCell(tag, ref);
      if (ref) ref.after(c2);
      else row4.append(c2);
    }
  }
  function deleteRow(cell) {
    const row4 = cell.parentElement;
    const table = row4.closest("table");
    if (table.rows.length <= 1) {
      table.remove();
      return;
    }
    if (row4.parentElement?.localName === "thead") {
      const next = table.tBodies[0]?.rows[0];
      if (!next) return;
      const head = document.createElement("tr");
      for (const c2 of next.cells) {
        const th = newCell("th", c2);
        th.replaceChildren(...c2.childNodes);
        head.append(th);
      }
      row4.replaceWith(head);
      next.remove();
      return;
    }
    row4.remove();
  }
  function deleteColumn(cell) {
    const table = cell.closest("table");
    const index = cell.cellIndex;
    if (table.rows[0]?.cells.length <= 1) {
      table.remove();
      return;
    }
    for (const row4 of [...table.rows]) row4.cells[index]?.remove();
  }
  function alignColumn(cell, align2) {
    const table = cell.closest("table");
    for (const row4 of table.rows) {
      const c2 = row4.cells[cell.cellIndex];
      if (c2) c2.style.textAlign = align2;
    }
  }
  function makeChip(el2) {
    el2.contentEditable = "false";
    el2.classList.add("math-chip");
  }
  var formula2 = null;
  function closeFormula(revert, refocus = true) {
    if (!formula2) return;
    const f2 = formula2;
    formula2 = null;
    f2.pop.remove();
    f2.chip.classList.remove("editing");
    if (revert) f2.revert();
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
    const field = h("textarea", {
      class: "formula-input",
      rows: 2,
      spellcheck: "false",
      placeholder: "LaTeX, e.g. \\frac{a}{b}"
    });
    field.value = original || (isNew ? "x" : "");
    const block = h("input", { type: "checkbox" });
    block.checked = chip.classList.contains("block");
    const status2 = h("span", { class: "formula-status" });
    const pop = h(
      "div",
      { class: "formula-pop" },
      field,
      h(
        "div",
        { class: "formula-row" },
        h("label", {}, block, " On its own line"),
        status2,
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
    let timer5 = 0;
    let seq = 0;
    const renderNow = async () => {
      window.clearTimeout(timer5);
      const latex = field.value.trim();
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
        status2.textContent = result.error ?? "cannot render";
        pop.classList.add("error");
        return;
      }
      status2.textContent = "";
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
    field.addEventListener("input", () => {
      window.clearTimeout(timer5);
      timer5 = window.setTimeout(() => void renderNow(), 250);
    });
    block.addEventListener("change", () => void renderNow());
    chip.classList.add("editing");
    layer.append(pop);
    placePop(pop, chip);
    formula2 = self;
    field.focus();
    field.select();
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
    const box = h("input", {
      type: "checkbox",
      class: "task-list-item-checkbox"
    });
    return box;
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
    const list3 = li?.parentElement;
    if (list3?.localName !== "ul") return;
    if (list3.classList.contains("contains-task-list")) {
      list3.classList.remove("contains-task-list");
      if (!list3.classList.length) list3.removeAttribute("class");
      for (const item of list3.children) {
        item.classList.remove("task-list-item");
        if (!item.classList.length) item.removeAttribute("class");
        item.querySelector(":scope > input[type=checkbox]")?.remove();
      }
    } else {
      list3.classList.add("contains-task-list");
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
    const row4 = "<td><br></td><td><br></td><td><br></td>";
    document.execCommand(
      "insertHTML",
      false,
      `<table><thead><tr>${head}</tr></thead><tbody><tr>${row4}</tr><tr>${row4}</tr></tbody></table><p><br></p>`
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
    const btn = (label4, title2, fn, cls = "") => h(
      "button",
      {
        type: "button",
        class: `fmt-btn ${cls}`,
        title: title2,
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
    const host4 = content2.closest("svg");
    const css = host4 ? getComputedStyle(host4) : null;
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
  function setLayoutMode(on2) {
    ed.layoutMode = on2;
    document.body.classList.toggle("layout-mode", on2);
    $("btn-layout").classList.toggle("on", on2);
    enterGroup(null);
    clearSelection();
    drawOverlay();
    emit("layout-mode");
    if (on2) toast("Layout mode: edits change the shared layout files");
  }
  function renderStepSelect() {
    const sel = $("step-select");
    const svg = slideRoot();
    const max = svg ? maxStep(svg) : 0;
    sel.innerHTML = "";
    sel.append(new Option("All objects", ""));
    for (let i2 = 0; i2 <= max; i2++)
      sel.append(new Option(`Build step ${i2}`, String(i2)));
    sel.value = ed.step == null ? "" : String(Math.min(ed.step, max));
    sel.disabled = max === 0 && ed.step == null;
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
    b2.title = on2 ? "Leave full screen (F)" : "Full screen (F)";
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
  var TOOL_KEYS = {
    v: "select",
    t: "text",
    r: "rect",
    o: "ellipse",
    l: "line",
    a: "arrow",
    e: "elbow",
    c: "curve",
    p: "pen"
  };
  function onKey2(e2) {
    const target = e2.target;
    if (target.closest("input, textarea, select, [contenteditable]") || isEditingText()) {
      return;
    }
    const mod = e2.ctrlKey || e2.metaKey;
    const key = e2.key;
    const lower = key.toLowerCase();
    const handled = () => e2.preventDefault();
    if (mod && lower === "z") {
      handled();
      void (e2.shiftKey ? redo() : undo());
    } else if (mod && lower === "y") {
      handled();
      void redo();
    } else if (mod && lower === "a") {
      handled();
      selectAll();
    } else if (mod && lower === "d") {
      handled();
      void duplicateSelection();
    } else if (mod && e2.altKey && (e2.code === "KeyC" || e2.code === "KeyV")) {
      handled();
      if (e2.code === "KeyC") copyStyle();
      else void pasteStyle();
    } else if (mod && lower === "c") {
      handled();
      if (ed.focus === "sorter") void copySlides();
      else copy();
    } else if (mod && lower === "x") {
      handled();
      if (ed.focus === "sorter") void cutSlides();
      else cut();
    } else if (mod && (lower === "f" || lower === "h")) {
      handled();
      openFind(lower === "h");
    } else if (mod && lower === "g") {
      handled();
      void (e2.shiftKey ? ungroupSelection() : groupSelection());
    } else if (mod && lower === "m") {
      handled();
      if (e2.shiftKey) void openGallery({ mode: "insert", after: ed.current });
      else if (ed.model?.deckEditable) void newSlideLike(ed.current);
      else
        toast(
          "deck.py builds its slides in code; add slides there",
          "error"
        );
    } else if (mod && key === "Enter") {
      handled();
      present();
    } else if (mod && (key === "ArrowUp" || key === "ArrowDown")) {
      handled();
      const up = key === "ArrowUp";
      void order(
        e2.shiftKey ? up ? "front" : "back" : up ? "forward" : "backward"
      );
    } else if ((key === "Delete" || key === "Backspace") && ed.focus === "sorter") {
      handled();
      void deleteSlides();
    } else if (key === "Delete" || key === "Backspace") {
      if (ed.selection.length) {
        handled();
        void deleteSelection();
      }
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
    } else if (!mod && (key === "+" || key === "=")) {
      setZoom(scale() * 1.25);
    } else if (!mod && key === "-") {
      setZoom(scale() / 1.25);
    } else if (!mod && key === "0") {
      setZoom(0);
    } else if (!mod && !e2.altKey && lower in TOOL_KEYS) {
      setTool(TOOL_KEYS[lower]);
    } else if (!mod && !e2.altKey && lower === "g") {
      toggleGrid();
    } else if (!mod && !e2.altKey && lower === "f") {
      handled();
      toggleFullscreen();
    } else if (!mod && lower === "i") {
      void (e2.shiftKey ? insertVideo() : insertImage());
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
    $("btn-layout").addEventListener(
      "click",
      () => setLayoutMode(!ed.layoutMode)
    );
    $("btn-theme").addEventListener("click", toggleTheme);
    $("btn-present").addEventListener("click", present);
    $("btn-fullscreen").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", updateFullscreen);
    $("step-select").addEventListener("change", (e2) => {
      const v2 = e2.target.value;
      ed.step = v2 === "" ? null : Number(v2);
      document.body.classList.toggle("previewing", ed.step != null);
      render();
      emit("step");
    });
    document.addEventListener("keydown", onKey2);
    on("render", renderStepSelect);
    on("render", updateZoomLabel);
    on("zoom", updateZoomLabel);
    on("history", updateHistory);
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
  var menu3 = document.getElementById("context-menu");
  var at = { x: 0, y: 0 };
  function sep() {
    return h("div", { class: "menu-sep" });
  }
  function title(text) {
    return h("div", { class: "menu-title" }, text);
  }
  function objectMenu() {
    const sels = ed.selection.filter((s2) => canTransform(s2.el));
    const one = sels.length === 1 ? sels[0] : null;
    const el2 = one?.el ?? null;
    const items = [];
    if (el2) {
      if (canTypeInto(el2)) {
        items.push(menuItem("Type text into it", () => void typeInto(el2)));
      } else if (isZone(el2)) {
        items.push(menuItem("Edit text", () => emit("edit-zone")));
      } else if (el2.localName === "text") {
        items.push(menuItem("Edit text", () => emit("edit-text")));
      } else if (el2.localName === "g") {
        items.push(
          menuItem(
            "Enter group",
            () => enterGroup(el2)
          )
        );
      }
      const video = videoOf(el2);
      if (video) {
        items.push(
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
          items.push(
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
        items.push(menuItem("Edit diagram", () => editDiagram(one)));
      }
      const chartZone = isZone(el2) ? zoneName(el2) : null;
      if (chartZone && currentSlide()?.zones[chartZone]?.kind === "chart") {
        items.push(
          menuItem("Edit chart data\u2026", () => void editChart(chartZone))
        );
      }
      if (pictureOf(el2)) {
        items.push(menuItem("Crop", () => void startCrop(one)));
      }
    }
    const only = ed.selection.length === 1 ? ed.selection[0].el : null;
    const file = only ? fileOf(only) : null;
    if (file) {
      const name2 = file.split("/").pop() ?? file;
      items.push(menuItem(`Rename ${name2}\u2026`, () => void renameFile(file)));
    }
    if (items.length) items.push(sep());
    items.push(
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
      items.push(
        sep(),
        menuItem("Group", () => void groupSelection()),
        title("Align"),
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
      items.push(
        sep(),
        menuItem("Ungroup", () => void ungroupSelection())
      );
    }
    if (el2 && one) {
      const src = sourceOf(one.key);
      items.push(
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
        items.push(
          menuItem(`Open ${name2} in\u2026`, () => {
            void openMenu(src.path, at.x, at.y);
          })
        );
      }
    }
    return items;
  }
  function fileOf(el2) {
    const drawn = drawnDiagram(el2);
    if (drawn) return projectFile(drawn.getAttribute("data-drawio"));
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
    return [
      menuItem("Paste", () => void pasteFromClipboard()),
      menuItem("Select all", () => selectAll()),
      menuItem("Insert video from a folder\u2026", () => void insertFromDisk()),
      menuItem("New diagram (draw.io)\u2026", () => newDiagram()),
      menuItem("Insert chart\u2026", () => void insertChart(clickedAt())),
      sep(),
      title("Slide"),
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
    clear(menu3);
    menu3.append(...hit ? objectMenu() : slideMenu());
    showMenu(e2.clientX, e2.clientY);
  }
  function initCanvasMenu() {
    document.getElementById("canvas")?.addEventListener("contextmenu", onContextMenu);
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
  function followRow(before, row4, after) {
    const old = before?.pairs[row4];
    if (!before || !old) return firstRow(after.pairs);
    const lid = old.left != null ? before.left.slides[old.left]?.id : null;
    const rid = old.right != null ? before.right.slides[old.right]?.id : null;
    const same = after.pairs.findIndex(
      (p2) => lid != null && p2.left != null && after.left.slides[p2.left]?.id === lid || rid != null && p2.right != null && after.right.slides[p2.right]?.id === rid
    );
    if (same >= 0) return same;
    return Math.min(row4, Math.max(0, after.pairs.length - 1));
  }
  function badge(p2) {
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
  function takeState(m2, row4) {
    const p2 = m2.pairs[row4];
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
  async function mergeBranch(branch, send) {
    const res = await send({ action: "worktree", op: "merge", branch });
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
  var view2 = document.getElementById("compare-view");
  var model = null;
  var viewId = 0;
  var open4 = null;
  var row3 = 0;
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
  function openCompare(left, right) {
    viewId += 1;
    open4 = [left, right];
    error = null;
    if (!model) {
      view2.hidden = false;
      document.body.classList.add("compare-mode");
      renderLoading("Building both versions\u2026");
    } else {
      view2.classList.add("busy");
    }
    view2.focus();
    void whenConnected().then(
      () => sendRaw({ type: "compare-open", view: viewId, left, right })
    );
  }
  function closeCompare() {
    if (view2.hidden) return;
    sendRaw({ type: "compare-close" });
    model = null;
    open4 = null;
    view2.hidden = true;
    view2.classList.remove("busy");
    clear(view2);
    document.body.classList.remove("compare-mode");
    document.getElementById("cmp-fonts")?.remove();
    emit("slide");
  }
  function renderLoading(text) {
    clear(view2);
    view2.append(
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
    const host4 = h("div", {
      class: `cmp-slide ${cls}`
    });
    if (!slide?.svg) {
      host4.classList.add("empty");
      host4.textContent = slide ? "hidden slide" : `not in ${side.label || "this version"}`;
      return host4;
    }
    const root2 = host4.attachShadow({ mode: "open" });
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
      host4.style.aspectRatio = `${vb.w} / ${vb.h}`;
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
      });
      svg.querySelectorAll("video").forEach((v2) => {
        v2.removeAttribute("autoplay");
        v2.removeAttribute("controls");
      });
      host4.svg = svg;
    }
    root2.append(wrap2);
    return host4;
  }
  var thumbs3 = /* @__PURE__ */ new Map();
  function thumb(side, index) {
    const slide = index != null ? side.slides[index] ?? null : null;
    if (!slide) return h("div", { class: "cmp-thumb none" });
    const key = `${side.token}\0${slide.svg ?? `hidden:${slide.id}`}`;
    const cached = thumbs3.get(key);
    if (cached && !cached.isConnected) return cached;
    const el2 = slideView(side, slide, "cmp-thumb");
    thumbs3.set(key, el2);
    return el2;
  }
  function onModel(msg) {
    if (msg.view !== viewId || view2.hidden) return;
    const next = msg;
    const before = model;
    row3 = before ? followRow(before, row3, next) : firstRow(next.pairs);
    model = next;
    view2.classList.remove("busy");
    const tokens2 = /* @__PURE__ */ new Set([next.left.token, next.right.token]);
    for (const key of [...thumbs3.keys()]) {
      if (!tokens2.has(key.split("\0")[0])) thumbs3.delete(key);
    }
    addFonts(next.left);
    addFonts(next.right);
    render2();
  }
  function onError(msg) {
    if (msg.for !== "compare-open" || msg.view !== viewId) return;
    error = String(msg.message ?? "could not compare");
    view2.classList.remove("busy");
    if (!model) {
      renderLoading(`Cannot compare: ${error}`);
      view2.querySelector(".cmp-loading")?.classList.add("error");
    } else {
      toast(`Cannot compare: ${error}`, "error");
    }
  }
  var listEl = null;
  var mainEl = null;
  function render2() {
    if (!model) return;
    const m2 = model;
    clear(view2);
    const c2 = counts(m2.pairs);
    const merge2 = mergeTarget(m2);
    const only = h("input", { type: "checkbox" });
    only.checked = onlyChanges;
    only.addEventListener("change", () => {
      onlyChanges = only.checked;
      writePref("inkflow-compare-only", onlyChanges ? "1" : "0");
      renderList();
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
    view2.append(head, h("div", { class: "cmp-body" }, listEl, mainEl));
    renderList();
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
  function renderList() {
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
      const b2 = badge(p2);
      const slide = rowSlide(m2, p2);
      listEl.append(
        h(
          "div",
          {
            class: `cmp-row s-${b2.cls.replace(/ /g, " s-")}${i2 === row3 ? " active" : ""}`,
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
            thumb(m2.left, p2.left),
            thumb(m2.right, p2.right)
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
    row3 = i2;
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
    const next = nextChange(model.pairs, row3, dir);
    if (next == null) {
      toast(dir > 0 ? "No more changes below" : "No more changes above");
      return;
    }
    if (onlyChanges || isChange(model.pairs[next])) selectRow(next);
  }
  function step(dir) {
    if (!model) return;
    const rows = visibleRows(model.pairs, onlyChanges);
    const at3 = rows.indexOf(row3);
    const next = rows[at3 < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at3 + dir))];
    if (next != null) selectRow(next);
  }
  function renderMain() {
    if (!model || !mainEl) return;
    const m2 = model;
    clear(mainEl);
    const p2 = m2.pairs[row3];
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
      const handle = h("div", { class: "cmp-handle" });
      const place = () => {
        b2.style.clipPath = `inset(0 0 0 ${wipe}%)`;
        handle.style.left = `${wipe}%`;
      };
      place();
      frame.append(handle);
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
      const box = toSlideBox(
        el2.getBoundingClientRect(),
        svg.getBoundingClientRect(),
        parseViewBox(svg.getAttribute("viewBox"))
      );
      if (box && box[2] > 0 && box[3] > 0) return box;
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
      const box = loc ? locate(target, loc) : null;
      if (!box) return;
      const rect = document.createElementNS(SVG_NS2, "rect");
      rect.setAttribute("x", String(box[0] - pad2));
      rect.setAttribute("y", String(box[1] - pad2));
      rect.setAttribute("width", String(box[2] + 2 * pad2));
      rect.setAttribute("height", String(box[3] + 2 * pad2));
      rect.setAttribute("rx", String(pad2));
      rect.setAttribute("class", `mark ${cls}`);
      const title2 = document.createElementNS(SVG_NS2, "title");
      title2.textContent = label4;
      rect.append(title2);
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
    const b2 = badge(p2);
    const take = takeState(m2, row3);
    const what = p2.status === "changed" ? whatChanged(p2) : [];
    const summary2 = p2.status === "added" ? `Only in ${m2.right.label}` : p2.status === "removed" ? `Only in ${m2.left.label}` : p2.status === "same" ? p2.moved ? "The same slide, moved" : "No differences" : `${p2.moved ? "Moved, and changed: " : "Changed: "}${what.join(", ")}`;
    const box = h(
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
            disabled: !take.enabled,
            title: take.title,
            onclick: () => void taking()
          },
          "Take this slide"
        )
      )
    );
    if (p2.files.length) {
      box.append(
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
      box.append(
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
      box.append(
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
      box.append(
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
    return box;
  }
  async function taking() {
    if (!model) return;
    const m2 = model;
    const p2 = m2.pairs[row3];
    const state = takeState(m2, row3);
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
      pair: row3,
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
    view2.classList.add("busy");
    const res = await mergeBranch(branch, request);
    view2.classList.remove("busy");
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
    const current2 = model;
    const pick2 = (chosen) => {
      closeDialog();
      if (side && current2) {
        const [l2, r2] = [current2.left.source, current2.right.source];
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
      const others = (data.worktrees ?? []).filter(
        (w2) => !w2.current && w2.deck
      );
      const inTree = new Set(others.map((w2) => w2.branch));
      const branches = (data.branches ?? []).filter(
        (b2) => b2 !== data.branch && !inTree.has(b2)
      );
      if (others.length || branches.length) {
        sections2.push(
          h("h3", {}, "A branch or worktree"),
          h(
            "div",
            { class: "git-list" },
            ...others.map(
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
  function onKey3(e2) {
    if (view2.hidden) return;
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
      if (open4 && !view2.hidden) {
        viewId += 1;
        sendRaw({
          type: "compare-open",
          view: viewId,
          left: open4[0],
          right: open4[1]
        });
      }
    });
    document.addEventListener("keydown", onKey3, true);
    new MutationObserver(() => {
      if (!model || view2.hidden) return;
      thumbs3.clear();
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

  // src/ts/editor/context.ts
  var timer2 = 0;
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
        const box = slideBox(s2.el);
        const text = (s2.el.textContent ?? "").replace(/\s+/g, " ").trim();
        return {
          id: s2.el.getAttribute("id"),
          tag: s2.el.localName,
          zone: isZone(s2.el) ? zoneName(s2.el) : null,
          file: sourceOf(s2.key)?.rel,
          locator: s2.loc,
          box: box && {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height)
          },
          text: text.slice(0, 200) || null
        };
      })
    };
  }
  function report() {
    window.clearTimeout(timer2);
    timer2 = window.setTimeout(() => {
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
  var menu4 = document.getElementById("context-menu");
  var button2 = document.getElementById("btn-deck");
  function baseName2(path) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  }
  function join(dir, name2) {
    return `${dir.replace(/[\\/]+$/, "")}/${name2}`;
  }
  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "my-deck";
  }
  function renderButton() {
    const dir = ed.model?.projectDir;
    button2.textContent = `${dir ? baseName2(dir) : "deck"} \u25BE`;
    button2.title = dir ? `${dir}
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
  async function openMenu2() {
    const data = await info2();
    if (!data) return;
    clear(menu4);
    menu4.append(
      menuItem("New deck\u2026", () => newDeckDialog(data)),
      menuItem("Open deck\u2026", () => openDeckDialog(data))
    );
    if (data.recent.length) {
      menu4.append(h("div", { class: "menu-title" }, "Recent decks"));
      for (const path of data.recent) {
        const dir = path.replace(/[\\/]deck\.py$/, "");
        const item = menuItem(baseName2(dir), () => void openDeck(path));
        item.title = dir;
        menu4.append(item);
      }
    }
    if (ed.model) {
      menu4.append(
        h("div", { class: "menu-sep" }),
        menuItem("Files\u2026", () => void openFiles())
      );
    }
    menu4.append(
      h("div", { class: "menu-sep" }),
      menuItem("Quit Inkflow", () => void quit())
    );
    const r2 = button2.getBoundingClientRect();
    showMenu(r2.left, r2.bottom + 4);
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
    const title2 = h("input", {
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
    title2.addEventListener("input", () => {
      titleEdited = true;
      if (!nameEdited) name2.value = slug(title2.value);
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
            title2.value = "My poster";
            if (!nameEdited) name2.value = slug(title2.value);
            update();
          }
        });
        return h(
          "label",
          { class: "look" },
          radio,
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
        title: title2.value,
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
          title2
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
    title2.select();
  }
  function openDeckDialog(data) {
    const open5 = h(
      "button",
      { type: "button", class: "pbtn primary", disabled: true },
      "Open this deck"
    );
    const picker = folderPicker(
      data.places?.default ?? data.current.replace(/[\\/][^\\/]*$/, ""),
      (f2) => {
        open5.disabled = !f2.isDeck;
        open5.textContent = f2.isDeck ? `Open ${baseName2(f2.path)}` : "No deck.py in this folder";
      }
    );
    open5.addEventListener("click", () => {
      const f2 = picker.current();
      if (f2?.isDeck) void openDeck(join(f2.path, "deck.py"));
    });
    openDialog(
      "Open deck",
      h(
        "div",
        { class: "deck-form" },
        h("p", { class: "hint" }, "Go to a folder with a deck.py in it."),
        picker.el,
        h("div", { class: "btn-row end" }, open5)
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
            "Start from one of five looks",
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
    button2.addEventListener("click", () => void openMenu2());
    on("model", renderButton);
    renderButton();
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
    }
  ];
  function size2(bytes) {
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
    const output = h("input", {
      type: "text",
      placeholder: f2.placeholder(stem),
      spellcheck: "false",
      title: "Where to save it, relative to deck.py"
    });
    const status2 = h("div", { class: "export-status" });
    const go = h("button", { type: "button", class: "pbtn primary" }, "Export");
    go.addEventListener("click", async () => {
      go.disabled = true;
      status2.textContent = f2.format === "pdf" ? "Rendering pages\u2026" : "Building\u2026";
      status2.className = "export-status busy";
      const result = await request({
        action: "export",
        format: f2.format,
        output: output.value.trim() || null,
        printMarks: print?.marks.checked ?? false
      });
      go.disabled = false;
      if (!result.ok) {
        status2.className = "export-status error";
        status2.textContent = result.error ?? "export failed";
        return;
      }
      const r2 = result;
      status2.className = "export-status done";
      status2.replaceChildren(
        h("span", {}, `Saved to ${r2.rel} \xB7 ${size2(r2.size)}`),
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
        print?.line ?? null
      ),
      h("div", { class: "export-row" }, output, go),
      status2
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

  // src/ts/editor/publishtext.ts
  function defaultHost(info4) {
    return info4.configured?.host ?? info4.suggested ?? "github";
  }
  function filesFor(info4, host4, release) {
    return info4.hosts[host4].files.filter((f2) => release || !f2.release);
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
  function address(url, note) {
    return h(
      "div",
      { class: "publish-url" },
      url ? h("a", { href: url, target: "_blank", rel: "noopener" }, url) : h("span", { class: "hint" }, "not known yet"),
      note ? h("p", { class: "hint publish-note" }, `(${note})`) : null
    );
  }
  async function openPublishDialog(commit, canPush) {
    const res = await request({ action: "publish", op: "status" });
    if (!res.ok) {
      toast(res.error ?? "could not read the publishing setup", "error");
      return;
    }
    const info4 = res.publish;
    let host4 = defaultHost(info4);
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
      radio.checked = value === host4;
      radio.addEventListener("change", () => {
        host4 = value;
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
    const write = h(
      "button",
      { type: "button", class: "pbtn primary", onclick: () => void run() },
      "Write files"
    );
    release.addEventListener("change", () => update());
    readme.addEventListener("change", () => update());
    function update() {
      const hostInfo = info4.hosts[host4];
      const list3 = filesFor(info4, host4, release.checked);
      const rows = list3.map((f2) => fileRow(fileAction(f2), f2.path));
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
      write.textContent = list3.some((f2) => f2.exists !== "none") ? "Update files" : "Write files";
    }
    async function run() {
      const list3 = filesFor(info4, host4, release.checked);
      const theirs = list3.filter((f2) => f2.exists === "other");
      if (theirs.length && !confirm(
        `${theirs.map((f2) => f2.path).join(", ")} exists already and was not written by inkflow. Replace it?`
      ))
        return;
      write.disabled = true;
      const out = await edit({
        action: "publish",
        op: "setup",
        host: host4,
        release: release.checked,
        readme: readme.checked,
        force: list3.some((f2) => f2.exists !== "none")
      });
      write.disabled = false;
      if (!out.ok) return;
      done(out);
    }
    function done(out) {
      const written = out.written ?? [];
      const steps = out.steps ?? [];
      const url = out.url ?? null;
      const note = out.note ?? null;
      const message = `Publish the slides on ${HOST_NAMES[host4]}`;
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
        `Publishing on ${HOST_NAMES[host4]}`,
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
            address(url, note)
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
        h("div", { class: "btn-row end" }, write)
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
  var menu5 = document.getElementById("context-menu");
  var button3 = document.getElementById("btn-git");
  var label2 = button3.querySelector(".git-label");
  var badge2 = button3.querySelector(".git-badge");
  var status = { repo: false, git: false };
  function render3() {
    button3.hidden = !status.git;
    if (!status.repo) {
      label2.textContent = "Git";
      badge2.hidden = true;
      button3.title = "Not versioned: create a git repository for this deck";
      return;
    }
    label2.textContent = status.branch ?? `@${status.detached ?? "?"}`;
    const n3 = status.changes?.length ?? 0;
    const lfsIssues = lfsFiles().length;
    button3.classList.toggle("warn", lfsIssues > 0);
    badge2.hidden = n3 === 0 && lfsIssues === 0;
    badge2.textContent = n3 ? String(n3) : "!";
    const sync = [
      status.ahead ? `${status.ahead} to push` : "",
      status.behind ? `${status.behind} to pull` : ""
    ].filter(Boolean).join(", ");
    button3.title = [
      status.branch ? `Branch ${status.branch}` : `Viewing ${status.detached}`,
      n3 ? `${n3} changed file${n3 === 1 ? "" : "s"}` : "No changes",
      sync,
      lfsIssues ? `${lfsIssues} media file${lfsIssues === 1 ? "" : "s"} not in Git LFS` : ""
    ].filter(Boolean).join(" \xB7 ");
  }
  async function refreshGit() {
    if (!connected()) return status;
    const res = await request({ action: "git", op: "status" });
    if (res.ok && res.git) status = res.git;
    render3();
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
    return res;
  }
  async function openMenu3() {
    await refreshGit();
    clear(menu5);
    if (!status.repo) {
      menu5.append(
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
        )
      );
    } else {
      const n3 = status.changes?.length ?? 0;
      const deckChanges = (status.changes ?? []).filter((c2) => c2.inDeck);
      const where = status.branch ? `On ${status.branch}` : `Viewing ${status.detached} (no branch)`;
      menu5.append(
        h(
          "div",
          { class: "menu-title" },
          `${where} \xB7 ${n3 ? `${n3} change${n3 === 1 ? "" : "s"}` : "no changes"}`
        )
      );
      if (status.last) {
        menu5.append(
          h(
            "div",
            { class: "menu-note" },
            `Last: ${status.last.subject} (${status.last.when})`
          )
        );
      }
      const lfsCount = lfsFiles().length;
      if (lfsCount) {
        const item = menuItem(
          `\u26A0 ${lfsCount} media file${lfsCount === 1 ? "" : "s"} not in Git LFS\u2026`,
          () => lfsDialog()
        );
        item.classList.add("warn");
        menu5.append(item);
      } else if (status.lfs?.mode === "on" && !status.lfs.installed) {
        menu5.append(
          h(
            "div",
            { class: "menu-note warn" },
            "git-lfs is not installed: this deck's media needs it"
          )
        );
      }
      menu5.append(
        menuItem(
          "Commit\u2026",
          () => commitDialog(),
          n3 === 0 || !status.branch
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
      if (status.hasCommits) menu5.append(...await worktreeSection());
    }
    const r2 = button3.getBoundingClientRect();
    showMenu(Math.max(8, r2.right - 260), r2.bottom + 4);
  }
  function publishItems() {
    const pages = status.pages;
    const items = [];
    if (pages?.url) {
      items.push(
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
    items.push(
      menuItem(pages ? "Publish\u2026 (update)" : "Publish\u2026", () => {
        void openPublishDialog(commitFiles, !!status.remotes?.length);
      })
    );
    return items;
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
  function size3(bytes) {
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
          h("span", { class: "hint git-size" }, size3(f2.size))
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
    const box = h("input", {
      type: "checkbox",
      value: change.path
    });
    box.checked = checked;
    return h(
      "label",
      { class: `git-file${change.inDeck ? "" : " outside"}` },
      box,
      h("span", { class: `git-status s-${change.status}` }, change.status),
      h("code", { class: "git-path" }, change.path)
    );
  }
  function checkedPaths(list3) {
    return [...list3.querySelectorAll("input:checked")].map(
      (b2) => b2.value
    );
  }
  function commitDialog(ticked, text) {
    const changes = status.changes ?? [];
    const message = h("textarea", {
      class: "git-message",
      rows: "3"
    });
    message.value = text ?? status.suggestedMessage ?? "Update slides";
    const files2 = h(
      "div",
      { class: "git-files" },
      ...changes.map(
        (c2) => fileRow2(c2, ticked ? ticked.includes(c2.path) : c2.inDeck)
      )
    );
    const outside = changes.some((c2) => !c2.inDeck);
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
    const run = async (push) => {
      const paths = checkedPaths(files2);
      const res = await git("commit", {
        message: message.value,
        paths,
        ...identity ? { name: name2.value, email: email.value } : {}
      });
      if (!res) return;
      closeDialog();
      if (push) await git("push");
    };
    const canPush = !!status.remotes?.length;
    const changed2 = new Set(changes.map((c2) => c2.path));
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
    const changes = (status.changes ?? []).filter((c2) => c2.inDeck);
    const files2 = h(
      "div",
      { class: "git-files" },
      ...changes.map((c2) => fileRow2(c2, true))
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
    const others = (await worktreeList()).filter((w2) => !w2.main);
    return [
      h("div", { class: "menu-sep" }),
      h("div", { class: "menu-title" }, "Worktrees"),
      ...others.map(
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
  var timer3 = 0;
  function initGit() {
    button3.addEventListener("click", () => void openMenu3());
    on("model", () => {
      window.clearTimeout(timer3);
      timer3 = window.setTimeout(() => void refreshGit(), 600);
    });
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
  function inkScale(width, height = 0) {
    const w2 = width > 0 ? width / REFERENCE_WIDTH : 0;
    const h3 = height > 0 ? height / REFERENCE_HEIGHT : 0;
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
  function outlineOf(points, style, simulate, last) {
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
      let worst = -1;
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
        if (d2 > worst) {
          worst = d2;
          index = i2;
        }
      }
      if (worst > t2) {
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
    const box = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
    for (let i2 = 0; i2 + 1 < poly2.length; i2 += 2) {
      box.minX = Math.min(box.minX, poly2[i2]);
      box.maxX = Math.max(box.maxX, poly2[i2]);
      box.minY = Math.min(box.minY, poly2[i2 + 1]);
      box.maxY = Math.max(box.maxY, poly2[i2 + 1]);
    }
    return box;
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
  function pointSegment2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t2 = len2 === 0 ? 0 : Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)
    );
    const ex = ax + t2 * dx - px;
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
  function eraserHits(poly2, box, a2, b2, r2) {
    if (Math.max(a2.x, b2.x) + r2 < box.minX || Math.min(a2.x, b2.x) - r2 > box.maxX || Math.max(a2.y, b2.y) + r2 < box.minY || Math.min(a2.y, b2.y) - r2 > box.maxY) {
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
    const outline = outlineOf(points, live, live.simulate, true);
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
    constructor(host4) {
      this.host = host4;
      const s2 = host4.surface;
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
          pathData2(outlineOf(pts, g2.live, g2.live.simulate, false), 2)
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
  function styleFor(s2, tool, width, tokenColor2, height = 0) {
    const t2 = s2[tool];
    const swatch = t2.swatch === null ? null : SWATCHES[t2.swatch];
    const fill = swatch ? swatch.token && tokenColor2(swatch.token) || swatch.hex : t2.custom;
    return {
      tool,
      fill: normalizeHex(fill) ?? "#000000",
      token: swatch?.token ?? null,
      size: sizesOf(tool)[t2.size] * inkScale(width, height)
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
  function button4(title2, content2, data) {
    const b2 = document.createElement("button");
    b2.type = "button";
    b2.className = "ink-btn";
    b2.title = title2;
    b2.setAttribute("aria-label", title2);
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
          (t2) => button4(TOOL_TITLES[t2], icon2(t2), { inkTool: t2 })
        )
      );
      const swatches = group(
        ...SWATCHES.map((s2, i2) => {
          const b2 = button4(
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
        button4(opts2.undoTitle, icon2("undo"), { inkAction: "undo" }),
        button4(opts2.clearTitle, icon2("clear"), { inkAction: "clear" })
      );
      const toggles = group(
        button4(
          "Draw with a mouse or a finger too (off: only a pen draws, so clicks and swipes still navigate)",
          icon2("fingers"),
          { inkToggle: "fingers" }
        )
      );
      if (opts2.keep) {
        toggles.append(
          button4(
            "Keep: save new strokes with the slide (off: they last for this talk only)",
            icon2("keep"),
            { inkToggle: "keep" }
          )
        );
      }
      if (opts2.close) {
        toggles.append(
          button4("Leave ink mode (i)", icon2("close"), {
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
          const px = Math.max(3, Math.round(size4 / largest * 16));
          const b2 = button4(
            ["Thin", "Medium", "Thick"][i2] ?? `Size ${i2 + 1}`,
            `<span class="ink-dot ${tool}" style="width:${px}px;height:${tool === "highlighter" ? Math.max(3, Math.round(px / 2.5)) : px}px"></span>`,
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
    return ed.tool === "pen" && ed.step == null && !ed.richEditing;
  }
  var pending2 = /* @__PURE__ */ new Map();
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
    for (const [id, p2] of pending2) {
      if (p2.deckIndex !== slide.deckIndex) continue;
      if (svg.querySelector(`.inkflow-ink [id="${CSS.escape(id)}"]`)) {
        pending2.delete(id);
      } else if (!svg.getElementById(id)) {
        liveLayer(svg).appendChild(strokeElement(p2.stroke));
      }
    }
  }
  async function save(stroke) {
    const slide = currentSlide();
    if (!slide) return;
    pending2.set(stroke.id, { deckIndex: slide.deckIndex, stroke });
    showPending();
    const result = await edit({
      action: "ink",
      op: "add",
      slide: slide.deckIndex,
      strokes: [stroke]
    });
    if (!result.ok) {
      pending2.delete(stroke.id);
      slideRoot()?.getElementById(stroke.id)?.remove();
    }
  }
  async function erase(ids, hidden) {
    const slide = currentSlide();
    if (!slide) return;
    for (const id of ids) pending2.delete(id);
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
    if (!slide?.ink?.exists && !pending2.size) {
      toast("This slide has no ink");
      return;
    }
    if (!slide || !window.confirm("Remove all ink from this slide?")) return;
    pending2.clear();
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
      onStroke: (stroke) => void save(stroke),
      onErase: (ids, hidden) => void erase(ids, hidden)
    });
    on("tool", () => {
      palette.el.hidden = ed.tool !== "pen";
    });
    on("render", showPending);
  }

  // src/ts/editor/notes.ts
  var area = document.getElementById("notes-input");
  var label3 = document.getElementById("notes-file");
  var timer4 = 0;
  var slideIndex = -1;
  var sent = "";
  var burst = "";
  async function save2() {
    window.clearTimeout(timer4);
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
      timer4 = window.setTimeout(() => void save2(), 800);
    }
  }
  function load() {
    const slide = currentSlide();
    if (!slide) return;
    if (document.activeElement === area && slideIndex === slide.deckIndex)
      return;
    slideIndex = slide.deckIndex;
    area.value = slide.notes.text;
    sent = area.value;
    label3.textContent = slide.notes.kind === "file" ? slide.notes.rel ?? "" : slide.notes.kind === "inline" ? "inline in deck.py" : "new notes file on first edit";
  }
  function initNotes() {
    area.addEventListener("focus", () => {
      burst = `notes-${Date.now()}`;
    });
    area.addEventListener("input", () => {
      window.clearTimeout(timer4);
      timer4 = window.setTimeout(() => void save2(), 600);
    });
    area.addEventListener("blur", () => void save2());
    area.addEventListener("keydown", (e2) => e2.stopPropagation());
    on("slide", () => {
      void save2().then(load);
    });
    on("model", load);
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
  async function save3(body2, label4) {
    await edit({ action: "theme-set", label: label4, ...body2 });
  }
  function setToken(group2, name2, value) {
    void save3({ changes: { [group2]: { [name2]: value } } }, "Theme");
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
      const withFallback = v2.includes(",") || v2 === generic ? v2 : `${v2}, ${generic}`;
      setToken("typography", name2, withFallback);
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
      () => void save3({ mode: mode2.value || null }, "Colour mode")
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
      void save3({ fontSize: Number.isFinite(n3) ? n3 : null }, "Font size");
    });
    const list3 = h("datalist", { id: "theme-font-list" });
    for (const f2 of ["sans-serif", "serif", "monospace", ...t2.fonts]) {
      list3.append(h("option", { value: f2 }));
    }
    content.append(
      h(
        "div",
        { class: "theme-top" },
        h("label", {}, h("span", {}, "Colour mode"), mode2),
        h("label", {}, h("span", {}, "Base font size (px)"), size4)
      ),
      h("h3", {}, "Fonts"),
      list3,
      ...FONTS.map(([n3, l2, g2]) => fontRow(n3, l2, g2)),
      h(
        "p",
        { class: "hint" },
        "Inter, JetBrains Mono, STIX Two Math and Twemoji come with inkflow and look the same everywhere. Fonts found in fonts/, the theme or this computer are embedded in the deck too."
      ),
      h("h3", {}, "Colours"),
      colorsTable(),
      h(
        "p",
        { class: "hint" },
        "Changes are written to styles.css (one marked block) and deck.py; \u21BA goes back to the theme."
      )
    );
  }
  async function refresh() {
    const result = await request({ action: "theme-get" });
    if (!result.ok) return;
    info3 = result.theme;
    render4();
  }
  async function openTheme() {
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
    await refresh();
  }
  function initTheme() {
    document.getElementById("btn-theme-panel")?.addEventListener("click", () => {
      void openTheme();
    });
    on("model", () => {
      document.documentElement.removeAttribute("style");
      if (content) void refresh();
    });
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
    constructor(host4, tracker = new TouchTracker()) {
      this.host = host4;
      this.touch = tracker;
      const opts2 = { capture: true };
      window.addEventListener("pointerdown", (e2) => this.down(e2), opts2);
      window.addEventListener("pointermove", (e2) => this.move(e2), opts2);
      window.addEventListener("pointerup", (e2) => this.up(e2, false), opts2);
      window.addEventListener("pointercancel", (e2) => this.up(e2, true), opts2);
      window.addEventListener("click", (e2) => this.claimClick(e2), opts2);
      window.addEventListener("dblclick", (e2) => this.claimClick(e2), opts2);
      const s2 = host4.surface;
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
        "This text lives in a layout; switch to layout mode to edit it",
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
    initCanvasMenu();
    initCompare();
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
    showError();
    renderSorter();
    render();
    writeHash();
    if (WS_PORT != null) connect(WS_PORT);
    if (!ed.model && !ed.error) void showStart();
  }
  boot();
})();
