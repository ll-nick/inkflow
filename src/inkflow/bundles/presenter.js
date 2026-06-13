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
    _syncingFromServer: false,
    _laserMode: false
  };

  // src/ts/presenter/pv.ts
  var pvPanel = document.getElementById("pv");
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
  function _pvMaxStep() {
    return state._maxStepCache ?? 0;
  }
  function updatePvInfo() {
    const total = state.slides.length;
    pvSlideInfo.innerHTML = `<span class="slide-current">${total ? state.slideIndex + 1 : "\u2013"}</span> / ${total || "\u2013"}`;
    pvStepRing.innerHTML = buildStepRing(state.step, _pvMaxStep());
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
    const curMax = _pvMaxStep();
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
    if (svg) {
      svg.querySelectorAll("[data-step]").forEach((el) => {
        el.classList.toggle(
          "active",
          +(el.getAttribute("data-step") ?? "0") <= revealStep
        );
      });
    }
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
  function applyStepInstant(root, step) {
    applyStep(root, step);
    if (typeof root.getAnimations !== "function") return;
    for (const anim of root.getAnimations({ subtree: true })) {
      try {
        anim.finish();
      } catch {
      }
    }
  }

  // src/ts/presenter/status.ts
  var stage = document.getElementById("stage");
  var slideInfo = document.getElementById("slide-info");
  var stepInfo = document.getElementById("step-info");
  var mhudSlideInfo = document.getElementById("mhud-slide-info");
  var mhudStepRing = document.getElementById("mhud-step-ring");
  function maxStep2() {
    if (state._maxStepCache !== null) return state._maxStepCache;
    state._maxStepCache = maxStep(stage);
    return state._maxStepCache;
  }
  function applyCurrentStep() {
    applyStep(stage, state.step);
    updateStatus();
  }
  function applyCurrentStepInstant() {
    applyStepInstant(stage, state.step);
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
    if (!Number.isNaN(n) && n >= 1 && n <= state.slides.length)
      state.slideIndex = n - 1;
    const steps = parseInt(
      new URLSearchParams(window.location.search).get("steps") ?? "0",
      10
    );
    if (!Number.isNaN(steps) && steps >= 0) state.step = steps;
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
  function poseCenter(pose) {
    const cos = Math.cos(pose.rotation);
    const sin = Math.sin(pose.rotation);
    const halfWidth = pose.width / 2;
    const halfHeight = pose.height / 2;
    return {
      x: pose.x + halfWidth * cos - halfHeight * sin,
      y: pose.y + halfWidth * sin + halfHeight * cos
    };
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
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
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
  function compensationScale(fromPose, toPose, easedProgress) {
    const remainingProgress = 1 - easedProgress;
    return {
      x: toPose.width > 0 ? 1 + (fromPose.width / toPose.width - 1) * remainingProgress : 1,
      y: toPose.height > 0 ? 1 + (fromPose.height / toPose.height - 1) * remainingProgress : 1
    };
  }
  function buildCompensationMatrix(fromPose, toPose, parentCTM, easedProgress) {
    if (easedProgress >= 1) return null;
    const remainingProgress = 1 - easedProgress;
    const parentCTMInverse = parentCTM.inverse();
    const fromCenter = poseCenter(fromPose);
    const toCenter = poseCenter(toPose);
    const absoluteDeltaX = fromCenter.x - toCenter.x;
    const absoluteDeltaY = fromCenter.y - toCenter.y;
    const localDeltaX = (parentCTMInverse.a * absoluteDeltaX + parentCTMInverse.c * absoluteDeltaY) * remainingProgress;
    const localDeltaY = (parentCTMInverse.b * absoluteDeltaX + parentCTMInverse.d * absoluteDeltaY) * remainingProgress;
    const { x: compensationScaleX, y: compensationScaleY } = compensationScale(
      fromPose,
      toPose,
      easedProgress
    );
    const rotationDeltaDegrees = (fromPose.rotation - toPose.rotation) * (180 / Math.PI) * remainingProgress;
    const toPoseCenter = new DOMPoint(toCenter.x, toCenter.y).matrixTransform(
      parentCTMInverse
    );
    const pivotX = toPoseCenter.x;
    const pivotY = toPoseCenter.y;
    return new DOMMatrix().translate(pivotX + localDeltaX, pivotY + localDeltaY).scale(compensationScaleX, compensationScaleY).rotate(rotationDeltaDegrees).translate(-pivotX, -pivotY);
  }

  // src/ts/presenter/morph.ts
  var stage2 = document.getElementById("stage");
  var LEAF_SELECTOR = "rect, circle, ellipse, line, polyline, polygon, path, text, image, foreignObject";
  var LENGTH_ATTRIBUTES = ["stroke-width", "rx", "ry"];
  function captureAbsolutePose(element) {
    const boundingBox = element.getBBox();
    const currentMatrix = element.getScreenCTM();
    const topLeft = new DOMPoint(boundingBox.x, boundingBox.y).matrixTransform(
      currentMatrix
    );
    const topRight = new DOMPoint(
      boundingBox.x + boundingBox.width,
      boundingBox.y
    ).matrixTransform(currentMatrix);
    const bottomLeft = new DOMPoint(
      boundingBox.x,
      boundingBox.y + boundingBox.height
    ).matrixTransform(currentMatrix);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
      height: Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y),
      rotation: Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x)
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
    const ancestorIds = ancestorIdChain(element);
    const fromAttributes = readInterpolatedAttributes(element);
    if (element instanceof SVGLineElement)
      return {
        kind: "line",
        ancestorIds,
        fromAttributes,
        endpointsScreen: captureEndpointsScreen(element),
        strokeWidth: readLengthAttributes(element)["stroke-width"]
      };
    if (element instanceof SVGTextElement)
      return {
        kind: "text",
        ancestorIds,
        fromAttributes,
        textPose: captureTextScreenPose(element)
      };
    return {
      kind: "box",
      ancestorIds,
      fromAttributes,
      pose: captureAbsolutePose(element),
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
    return Array.from(svg.children).map((child) => ({
      element: child.cloneNode(true),
      html: child.outerHTML,
      ids: collectIds(child)
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
    if (snapshot.pose)
      return {
        kind: "box",
        element,
        fromAttributes,
        toAttributes,
        parentCTM: parentScreenCTM(element),
        originalTransform: element.getAttribute("transform") ?? "",
        fromPose: snapshot.pose,
        toPose: captureAbsolutePose(element),
        fromLengths: snapshot.lengths ?? {},
        toLengths: readLengthAttributes(element)
      };
    return null;
  }
  function buildLeafMorphTasks(svgRoot, oldLeaves, matchedIds) {
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
    for (const [scope, newElements] of newByScope) {
      const oldList = oldByScope.get(scope);
      if (!oldList) continue;
      const count = Math.min(newElements.length, oldList.length);
      for (let i = 0; i < count; i++) {
        const morph = createLeafMorph(newElements[i], oldList[i]);
        if (!morph) continue;
        tickMorph(morph, 0);
        tasks.push({ type: "morph", morph });
      }
    }
    return tasks;
  }
  function containsMatchedId(ids, matchedIds) {
    for (const id of ids) if (matchedIds.has(id)) return true;
    return false;
  }
  function buildCrossfadeTasks(svgRoot, oldChildren, newChildren, matchedIds) {
    const oldHtml = new Set(oldChildren.map((child) => child.html));
    const newHtml = new Set(newChildren.map((child) => child.html));
    const tasks = [];
    for (const child of oldChildren) {
      if (containsMatchedId(child.ids, matchedIds)) continue;
      if (newHtml.has(child.html)) continue;
      const clone = child.element;
      if (!(clone instanceof SVGGraphicsElement)) continue;
      svgRoot.appendChild(clone);
      tasks.push({ type: "exit", element: clone });
    }
    for (const child of newChildren) {
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
  function buildTasks(svgRoot, oldLeaves, oldChildren) {
    const newIds = collectIds(svgRoot);
    const matchedIds = /* @__PURE__ */ new Set();
    for (const id of oldLeaves.ids) if (newIds.has(id)) matchedIds.add(id);
    const newChildren = Array.from(svgRoot.children).map(
      (child) => ({
        element: child,
        html: child.outerHTML,
        ids: collectIds(child)
      })
    );
    return [
      ...buildLeafMorphTasks(svgRoot, oldLeaves, matchedIds),
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
    const compensation = buildCompensationMatrix(
      morph.fromPose,
      morph.toPose,
      morph.parentCTM,
      easedProgress
    );
    const prefix = compensation ? `${matrixToSvgTransform(compensation)} ` : "";
    morph.element.setAttribute(
      "transform",
      `${prefix}${morph.originalTransform}`.trim()
    );
    const { x: csx, y: csy } = compensationScale(
      morph.fromPose,
      morph.toPose,
      easedProgress
    );
    const uniformScale = Math.sqrt(Math.max(csx * csy, 1e-6));
    const lerp = (from, to) => from + (to - from) * easedProgress;
    const rxFrom = morph.fromLengths.rx;
    const rxTo = morph.toLengths.rx;
    if (rxFrom !== void 0 && rxTo !== void 0) {
      const ryFrom = morph.fromLengths.ry ?? rxFrom;
      const ryTo = morph.toLengths.ry ?? rxTo;
      morph.element.setAttribute("rx", String(lerp(rxFrom, rxTo) / csx));
      morph.element.setAttribute("ry", String(lerp(ryFrom, ryTo) / csy));
    }
    const swFrom = morph.fromLengths["stroke-width"];
    const swTo = morph.toLengths["stroke-width"];
    if (swFrom !== void 0 && swTo !== void 0)
      morph.element.setAttribute(
        "stroke-width",
        String(lerp(swFrom, swTo) / uniformScale)
      );
  }
  function applyText(morph, easedProgress) {
    const lerp = (from, to) => from + (to - from) * easedProgress;
    const target = new DOMMatrix().translate(
      lerp(morph.from.anchorX, morph.to.anchorX),
      lerp(morph.from.anchorY, morph.to.anchorY)
    ).rotate(lerp(morph.from.rotation, morph.to.rotation) * 180 / Math.PI).scale(lerp(morph.from.scale, morph.to.scale)).translate(-morph.anchorLocalX, -morph.anchorLocalY);
    const local = morph.parentCTM.inverse().multiply(target);
    morph.element.setAttribute("transform", matrixToSvgTransform(local));
    morph.element.style.fontSize = `${lerp(morph.from.fontSize, morph.to.fontSize)}px`;
  }
  function applyLine(morph, easedProgress) {
    const lerp = (from, to) => from + (to - from) * easedProgress;
    const element = morph.element;
    element.setAttribute("x1", String(lerp(morph.from.x1, morph.to.x1)));
    element.setAttribute("y1", String(lerp(morph.from.y1, morph.to.y1)));
    element.setAttribute("x2", String(lerp(morph.from.x2, morph.to.x2)));
    element.setAttribute("y2", String(lerp(morph.from.y2, morph.to.y2)));
    if (morph.fromStrokeWidth !== void 0 && morph.toStrokeWidth !== void 0)
      element.setAttribute(
        "stroke-width",
        String(lerp(morph.fromStrokeWidth, morph.toStrokeWidth))
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
        task.element.style.opacity = String(1 - exitProgress);
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
      else task.element.style.opacity = "";
    }
  }
  function runMorphLoop(tasks, durationMs, then) {
    const t0 = performance.now();
    function frame(now) {
      const rawProgress = Math.min((now - t0) / durationMs, 1);
      tickTasks(tasks, rawProgress);
      if (rawProgress < 1) {
        requestAnimationFrame(frame);
        return;
      }
      finalizeTasks(tasks);
      if (then) then();
    }
    requestAnimationFrame(frame);
  }
  function morphToNextSlide(swap, transition, then) {
    const beforeSvg = stage2.querySelector("svg");
    const oldLeaves = beforeSvg ? snapshotLeaves(beforeSvg) : { ids: /* @__PURE__ */ new Set(), leaves: [] };
    const oldChildren = beforeSvg ? snapshotTopLevelChildren(beforeSvg) : [];
    swap();
    const svgRoot = stage2.querySelector("svg");
    if (!svgRoot) {
      if (then) then();
      return;
    }
    const tasks = buildTasks(svgRoot, oldLeaves, oldChildren);
    runMorphLoop(tasks, transition.duration * 1e3, then);
  }

  // src/ts/presenter/transitions.ts
  var stage3 = document.getElementById("stage");
  var registry = /* @__PURE__ */ new Map();
  function registerTransition(name, handler) {
    registry.set(name, handler);
  }
  function makeLayer() {
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
    layer.style.padding = getComputedStyle(stage3).padding;
    return layer;
  }
  function sizeLayerChild(layer) {
    const child = layer.firstElementChild;
    if (child) {
      child.style.width = "100%";
      child.style.height = "100%";
    }
  }
  function cssTransition(animate) {
    return (swap, t, then) => {
      if (t.duration <= 0) {
        swap();
        then?.();
        return;
      }
      const oldHTML = stage3.innerHTML;
      swap();
      const newLayer = makeLayer();
      while (stage3.firstChild) newLayer.appendChild(stage3.firstChild);
      sizeLayerChild(newLayer);
      stage3.appendChild(newLayer);
      const oldLayer = makeLayer();
      oldLayer.innerHTML = oldHTML;
      sizeLayerChild(oldLayer);
      stage3.appendChild(oldLayer);
      animate(oldLayer, newLayer, t, () => {
        while (newLayer.firstChild)
          stage3.insertBefore(newLayer.firstChild, newLayer);
        newLayer.remove();
        oldLayer.remove();
        then?.();
      });
    };
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
  function reflow() {
    void stage3.offsetHeight;
  }
  registerTransition("cut", (swap, _t, then) => {
    swap();
    then?.();
  });
  registerTransition(
    "crossfade",
    cssTransition((oldLayer, _newLayer, t, done) => {
      const easing = t.easing ?? "ease";
      oldLayer.style.transition = `opacity ${t.duration}s ${easing}`;
      reflow();
      requestAnimationFrame(() => {
        oldLayer.style.opacity = "0";
        setTimeout(done, t.duration * 1e3);
      });
    })
  );
  registerTransition(
    "push",
    cssTransition((oldLayer, newLayer, t, done) => {
      const dir = t.reverse ? flipDir(t.direction ?? "left") : t.direction ?? "left";
      const axis = dirAxis(dir);
      const sign = incomingSign(dir);
      const easing = t.easing ?? "ease-in-out";
      const ms = t.duration * 1e3;
      oldLayer.style.transition = `transform ${t.duration}s ${easing}`;
      newLayer.style.transform = `translate${axis}(${sign * 100}%)`;
      newLayer.style.transition = `transform ${t.duration}s ${easing}`;
      reflow();
      requestAnimationFrame(() => {
        oldLayer.style.transform = `translate${axis}(${-sign * 100}%)`;
        newLayer.style.transform = `translate${axis}(0)`;
        setTimeout(done, ms);
      });
    })
  );
  registerTransition(
    "slide",
    cssTransition((oldLayer, _newLayer, t, done) => {
      const dir = t.direction ?? "left";
      const axis = dirAxis(dir);
      const sign = incomingSign(dir);
      const easing = t.easing ?? "ease-in-out";
      const ms = t.duration * 1e3;
      const exitPct = t.reverse ? sign * 100 : -sign * 100;
      oldLayer.style.transition = `transform ${t.duration}s ${easing}`;
      reflow();
      requestAnimationFrame(() => {
        oldLayer.style.transform = `translate${axis}(${exitPct}%)`;
        setTimeout(done, ms);
      });
    })
  );
  registerTransition(
    "zoom",
    cssTransition((oldLayer, newLayer, t, done) => {
      const easing = t.easing ?? "ease-in-out";
      const ms = t.duration * 1e3;
      oldLayer.style.transformOrigin = "center";
      oldLayer.style.transition = `opacity ${t.duration}s ${easing}, transform ${t.duration}s ${easing}`;
      newLayer.style.opacity = "0";
      newLayer.style.transform = "scale(0.95)";
      newLayer.style.transformOrigin = "center";
      newLayer.style.transition = `opacity ${t.duration}s ${easing}, transform ${t.duration}s ${easing}`;
      reflow();
      requestAnimationFrame(() => {
        oldLayer.style.opacity = "0";
        oldLayer.style.transform = "scale(1.05)";
        newLayer.style.opacity = "1";
        newLayer.style.transform = "scale(1)";
        setTimeout(done, ms);
      });
    })
  );
  registerTransition(
    "fade",
    cssTransition((oldLayer, newLayer, t, done) => {
      const color = t.color ?? "#000000";
      const easing = t.easing ?? "ease";
      const half = t.duration / 2;
      const halfMs = half * 1e3;
      stage3.style.backgroundColor = color;
      oldLayer.style.transition = `opacity ${half}s ${easing}`;
      newLayer.style.opacity = "0";
      reflow();
      requestAnimationFrame(() => {
        oldLayer.style.opacity = "0";
        setTimeout(() => {
          newLayer.style.transition = `opacity ${half}s ${easing}`;
          reflow();
          requestAnimationFrame(() => {
            newLayer.style.opacity = "1";
            setTimeout(() => {
              stage3.style.backgroundColor = "";
              done();
            }, halfMs);
          });
        }, halfMs);
      });
    })
  );
  registerTransition(
    "wipe",
    cssTransition((oldLayer, _newLayer, t, done) => {
      const dir = t.direction ?? "left";
      const easing = t.easing ?? "ease-in-out";
      const ms = t.duration * 1e3;
      const effectiveDir = t.reverse ? flipDir(dir) : dir;
      const exitClip = {
        left: "inset(0 0 0 100%)",
        right: "inset(0 100% 0 0)",
        up: "inset(0 0 100% 0)",
        down: "inset(100% 0 0 0)"
      }[effectiveDir] ?? "inset(0 0 0 100%)";
      oldLayer.style.clipPath = "inset(0)";
      oldLayer.style.transition = `clip-path ${t.duration}s ${easing}`;
      reflow();
      requestAnimationFrame(() => {
        oldLayer.style.clipPath = exitClip;
        setTimeout(done, ms);
      });
    })
  );
  registerTransition("morph", (swap, transition, then) => {
    if (transition.duration <= 0 || !state.slides.length) {
      swap();
      then?.();
      return;
    }
    morphToNextSlide(swap, transition, then);
  });
  function loadSlide(then = null, transition = null, onSwap = null) {
    const swap = () => {
      stage3.innerHTML = state.slides.length ? state.slides[state.slideIndex].svg : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
      state._maxStepCache = null;
      onSwap?.();
      updateStatus();
    };
    const t = transition ?? state.transitions[state.slideIndex] ?? { type: "cut", duration: 0 };
    const handler = registry.get(t.type);
    if (handler) {
      handler(swap, t, then);
      return;
    }
    swap();
    then?.();
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
        renderPv();
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
        renderPv();
      }
    };
    state.ws.onclose = () => {
      wsDot.className = "";
      state.ws = null;
      setTimeout(() => connectWS(wsPort), 2e3);
    };
    state.ws.onerror = () => state.ws?.close();
  }

  // src/ts/presenter/laser.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
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
    currentPath = document.createElementNS(SVG_NS, "path");
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
  function advance() {
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
    if (state.step > 0) {
      state.step--;
      applyCurrentStep();
      renderPvNext();
      updatePvInfo();
    } else if (state.slideIndex > 0) {
      const t = state.transitions[state.slideIndex];
      state.slideIndex--;
      loadSlide(null, t ? { ...t, reverse: true } : null, () => {
        state.step = maxStep2();
        applyCurrentStepInstant();
        sendNav();
      });
      renderPv();
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
      loadSlide(null, t ? { ...t, reverse: true } : null, () => {
        state.step = maxStep2();
        applyCurrentStepInstant();
      });
      renderPv();
    }
    sendNav();
  }
  function gotoFirst() {
    state.slideIndex = 0;
    state.step = 0;
    loadSlide();
    renderPv();
    sendNav();
  }
  function gotoLast() {
    state.slideIndex = state.slides.length - 1;
    state.step = 0;
    loadSlide();
    renderPv();
    sendNav();
  }

  // src/ts/presenter/overview.ts
  var overview = document.getElementById("overview");
  var overviewGrid = document.getElementById("overview-grid");
  var stage4 = document.getElementById("stage");
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
    let cols = n;
    for (let c = 1; c <= n; c++) {
      const thumbW = (availW - (c - 1) * gap) / c;
      const rows = Math.ceil(n / c);
      if (rows * (thumbW * (9 / 16) + gap) - gap <= availH) {
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
    state.slideIndex = state._overviewActive;
    state.step = 0;
    closeOverview();
    loadSlide(null, { type: "cut", duration: 0 }, () => {
      const maxSt = maxStep(stage4);
      applyStepInstant(stage4, maxSt);
      state.step = maxSt;
    });
    renderPv();
    sendNav();
  }
  function computeStageFlip() {
    const activeCell = overviewGrid.children[state._overviewActive];
    if (!activeCell) return null;
    const thumb = activeCell.querySelector(".overview-thumb");
    const el = thumb ?? activeCell;
    const gr = overviewGrid.getBoundingClientRect();
    const cr = el.getBoundingClientRect();
    const sr = stage4.getBoundingClientRect();
    const sp = parseFloat(getComputedStyle(stage4).paddingLeft) || 0;
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
  function openOverview() {
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
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
    requestAnimationFrame(() => {
      applyOptimalCols();
      requestAnimationFrame(() => {
        overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
        computeCols();
        overviewSetActive(state._overviewActive);
        const flip = computeStageFlip();
        const activeCell = overviewGrid.children[state._overviewActive];
        const activeThumb = activeCell?.querySelector(".overview-thumb");
        const activeNum = activeCell?.querySelector(".overview-num");
        if (flip) {
          overviewGrid.style.transformOrigin = `${flip.ox}px ${flip.oy}px`;
          overviewGrid.style.transition = "none";
          overviewGrid.style.transform = `scale(${flip.s})`;
        }
        if (activeThumb) activeThumb.style.outlineColor = "transparent";
        if (activeNum) activeNum.style.color = "transparent";
        requestAnimationFrame(() => {
          overview.style.transition = "none";
          overview.classList.add("visible");
          overviewGrid.style.transition = "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)";
          overviewGrid.style.transform = "scale(1)";
          if (activeThumb) {
            activeThumb.style.transition = "outline-color 0.6s ease";
            activeThumb.style.outlineColor = "";
          }
          if (activeNum) {
            activeNum.style.transition = "color 0.6s ease";
            activeNum.style.color = "";
          }
          const cleanup = (e) => {
            if (e.propertyName !== "transform") return;
            overviewGrid.removeEventListener("transitionend", cleanup);
            overviewGrid.style.cssText = overviewGrid.style.gridTemplateColumns ? `grid-template-columns:${overviewGrid.style.gridTemplateColumns}` : "";
            if (activeThumb) activeThumb.style.transition = "";
            if (activeNum) activeNum.style.transition = "";
            overview.style.transition = "";
          };
          overviewGrid.addEventListener("transitionend", cleanup);
        });
      });
    });
  }
  function zoomGridToStage() {
    const activeCell = overviewGrid.children[state._overviewActive];
    if (!activeCell) return;
    const thumb = activeCell.querySelector(".overview-thumb");
    const num = activeCell.querySelector(".overview-num");
    const flip = computeStageFlip();
    if (!flip) return;
    if (thumb) {
      thumb.style.transition = "outline-color 0.35s ease";
      thumb.style.outlineColor = "transparent";
    }
    if (num) {
      num.style.transition = "color 0.35s ease";
      num.style.color = "transparent";
    }
    overviewGrid.style.transformOrigin = `${flip.ox}px ${flip.oy}px`;
    overviewGrid.style.transition = "transform 0.35s cubic-bezier(0.55, 0, 1, 0.45)";
    overviewGrid.style.transform = `scale(${flip.s})`;
  }
  function closeOverview() {
    zoomGridToStage();
    setTimeout(() => {
      overview.style.transition = "opacity 0.28s ease, visibility 0s 0.28s";
      overview.classList.remove("visible");
      setTimeout(() => {
        overview.style.transition = "";
        if (!overview.classList.contains("visible")) {
          overviewGrid.innerHTML = "";
          overviewGrid.style.cssText = "";
        }
      }, 300);
    }, 370);
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
    const stage5 = document.getElementById("stage");
    state.slideIndex = state._pickerMatches[state._pickerActive];
    state.step = 0;
    closePicker();
    loadSlide(null, { type: "cut", duration: 0 }, () => {
      const maxSt = maxStep(stage5);
      applyStepInstant(stage5, maxSt);
      state.step = maxSt;
    });
    renderPv();
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
  var stageEl = document.getElementById("stage");
  var isCoarse = () => window.matchMedia("(pointer: coarse)").matches;
  stageEl.addEventListener("click", (e) => {
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
    p: { action: togglePv }
  };
  var helpEl = document.getElementById("help");
  var overviewEl2 = document.getElementById("overview");
  var pickerEl = document.getElementById("picker");
  var curtainEl = document.getElementById("curtain");
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
  window.inkflow = { registerTransition };
  readURL();
  loadSlide(() => {
    if (state.step > 0) applyCurrentStepInstant();
  });
  renderPv();
  updatePvClock();
  setInterval(updatePvClock, 1e3);
  if (INITIAL_ERROR) showError(INITIAL_ERROR);
  connectWS(WS_PORT);
})();
