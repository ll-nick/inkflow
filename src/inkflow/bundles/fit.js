"use strict";
(() => {
  // src/ts/shared/viewbox.ts
  var deckCanvas = { w: 1920, h: 1080 };
  function parseViewBox(attr, fallback = `0 0 ${deckCanvas.w} ${deckCanvas.h}`) {
    const parts = (attr ?? "").trim().split(/[\s,]+/).map(Number);
    const valid = parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0;
    const [x, y, w, h] = valid ? parts : fallback.split(/[\s,]+/).map(Number);
    return { x, y, w, h };
  }

  // src/ts/shared/fit.ts
  var MIN_TEXT_FRACTION = 1 / 80;
  var FIT_FLOOR = 0.33;
  var FIT_TOLERANCE = 0.01;
  var SLACK = 1;
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
  function neededHeight(children) {
    let total = 0;
    for (const c of children) {
      if (c.inFlow) total += c.height + c.marginTop + c.marginBottom;
    }
    return total;
  }
  var px = (v) => Number.parseFloat(v) || 0;
  function slideSvg(el) {
    let svg = el.ownerSVGElement ?? null;
    while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
    return svg ?? (el instanceof SVGSVGElement ? el : null);
  }
  function minTextSize(svg) {
    const own = Number.parseFloat(
      svg.getAttribute("data-inkflow-min-text") ?? ""
    );
    if (own > 0) return own;
    return parseViewBox(svg.getAttribute("viewBox")).h * MIN_TEXT_FRACTION;
  }
  function unitScale(fo) {
    const root = slideSvg(fo);
    const a = fo.getScreenCTM?.();
    const b = root?.getScreenCTM();
    if (!a || !b) return 1;
    const da = Math.sqrt(Math.abs(a.a * a.d - a.b * a.c));
    const db = Math.sqrt(Math.abs(b.a * b.d - b.b * b.c));
    return da > 0 && db > 0 ? da / db : 1;
  }
  function laidOut(wrapper) {
    return Array.from(wrapper.children, (el) => {
      const s = getComputedStyle(el);
      return {
        height: el.offsetHeight ?? 0,
        marginTop: px(s.marginTop),
        marginBottom: px(s.marginBottom),
        inFlow: s.display !== "none" && s.position !== "absolute" && s.position !== "fixed"
      };
    });
  }
  function overflows(wrapper, content) {
    const ws = getComputedStyle(wrapper);
    const avail = wrapper.clientHeight - px(ws.paddingTop) - px(ws.paddingBottom);
    if (neededHeight(laidOut(wrapper)) > avail + SLACK) return true;
    const width = content.clientWidth;
    for (const el of Array.from(content.querySelectorAll("pre, table"))) {
      const box = el;
      if (box.localName === "pre") {
        if (box.scrollWidth > box.clientWidth + SLACK) return true;
      } else if (box.offsetWidth > width + SLACK) {
        return true;
      }
    }
    return false;
  }
  function fitZone(fo, minText) {
    const wrapper = fo.querySelector(
      ":scope > .inkflow-wrapper"
    );
    const content = wrapper?.querySelector(
      ":scope > .inkflow-content"
    );
    if (!wrapper || !content) return null;
    wrapper.style.removeProperty("--inkflow-fit-scale");
    fo.removeAttribute("data-inkflow-fit");
    fo.removeAttribute("data-inkflow-overflow");
    const cs = getComputedStyle(wrapper);
    if (cs.display === "none" || wrapper.clientHeight === 0) return null;
    const apply = (scale) => {
      if (scale < 1)
        wrapper.style.setProperty("--inkflow-fit-scale", String(scale));
      else wrapper.style.removeProperty("--inkflow-fit-scale");
    };
    const fits = (scale) => {
      apply(scale);
      return !overflows(wrapper, content);
    };
    const off = cs.getPropertyValue("--inkflow-fit").trim() === "none";
    const result = off ? { scale: 1, overflow: !fits(1) } : searchScale(
      fits,
      floorScale(px(cs.fontSize) * unitScale(fo), minText)
    );
    apply(result.scale);
    if (result.scale < 1)
      fo.setAttribute("data-inkflow-fit", result.scale.toFixed(3));
    if (result.overflow) fo.setAttribute("data-inkflow-overflow", "");
    return result;
  }
  function fitSlide(root) {
    if (!root) return;
    const svg = root instanceof SVGSVGElement ? root : root.querySelector("svg");
    if (!svg) return;
    const min = minTextSize(slideSvg(svg) ?? svg);
    for (const wrapper of Array.from(
      svg.querySelectorAll("foreignObject > .inkflow-wrapper")
    )) {
      const fo = wrapper.parentElement;
      if (fo) fitZone(fo, min);
    }
  }

  // src/ts/fit/main.ts
  function fitAll() {
    for (const svg of Array.from(document.querySelectorAll(".trim > svg"))) {
      fitSlide(svg);
    }
  }
  fitAll();
  window.addEventListener("load", fitAll);
  void document.fonts?.ready.then(fitAll);
})();
