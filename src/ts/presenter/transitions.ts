import type { TransitionData } from "../shared/types";
import { state } from "./state";
import { updateStatus } from "./status";

const stage = document.getElementById("stage")!;

type Geom = Record<string, number>;

interface FromSnap {
    tag: string;
    geom: Geom | null;
    fill: string | null;
    stroke: string | null;
}

type Task =
    | {
          type: "morph";
          el: Element;
          from: FromSnap;
          toGeom: Geom;
          toFill: string | null;
          toStroke: string | null;
      }
    | { type: "fade"; el: Element; toOpacity: number }
    | { type: "exit"; el: Element };

function geomAttrs(el: Element): Geom | null {
    const g = (k: string) => parseFloat(el.getAttribute(k) ?? "0");
    switch (el.tagName.toLowerCase()) {
        case "rect":
            return {
                x: g("x"),
                y: g("y"),
                width: g("width"),
                height: g("height"),
                rx: g("rx"),
            };
        case "circle":
            return { cx: g("cx"), cy: g("cy"), r: g("r") };
        case "ellipse":
            return { cx: g("cx"), cy: g("cy"), rx: g("rx"), ry: g("ry") };
        default:
            return null;
    }
}

function parseHexColor(s: string | null) {
    const h = (s ?? "").replace("#", "");
    if (h.length === 3) return h.split("").map((c) => parseInt(c + c, 16));
    if (h.length === 6)
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return null;
}

function lerpColor(a: string | null, b: string | null, t: number): string {
    const ca = parseHexColor(a),
        cb = parseHexColor(b);
    if (!ca || !cb) return t < 0.5 ? (a ?? "") : (b ?? "");
    return (
        "#" +
        ca
            .map((c, i) =>
                Math.round(c + (cb[i] - c) * t)
                    .toString(16)
                    .padStart(2, "0"),
            )
            .join("")
    );
}

function ease(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

// Drives matched IDs via a rAF loop that sets SVG geometry attributes directly in
// SVG user units — no CSS px ↔ SVG unit conversion, no coordinate space ambiguity.
// Unmatched new elements fade in; unmatched old elements disappear immediately.
function morphSlide(duration: number, then: (() => void) | null): void {
    const ms = duration * 1000;

    // 1. Snapshot old elements in SVG user units before swap
    const fromMap = new Map<string, FromSnap>();
    stage.querySelectorAll("[id]").forEach((el) => {
        fromMap.set(el.id, {
            tag: el.tagName.toLowerCase(),
            geom: geomAttrs(el),
            fill: el.getAttribute("fill"),
            stroke: el.getAttribute("stroke"),
        });
    });

    // 2. Swap to new slide
    stage.innerHTML = state.slides[state.slideIndex].svg;
    state._maxStepCache = null;
    const newSvg = stage.querySelector("svg");
    if (!newSvg) {
        updateStatus();
        if (then) then();
        return;
    }
    updateStatus();

    // 3. Build task list; snap morph elements to old positions before first paint
    const tasks: Task[] = [];
    const seenIds = new Set<string>();
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
            (el as HTMLElement).style.opacity = "0";
            tasks.push({
                type: "fade",
                el,
                toOpacity: parseFloat(el.getAttribute("opacity") ?? "1"),
            });
        }
        // matched but unmorphable (text, group, path) → instant cut, leave as-is
    });

    // Exit elements: had geometry on old slide, absent from new — ghost them in and fade out
    for (const [id, from] of fromMap) {
        if (seenIds.has(id) || !from.geom) continue;
        const ghost = document.createElementNS(
            "http://www.w3.org/2000/svg",
            from.tag,
        );
        for (const [k, v] of Object.entries(from.geom))
            ghost.setAttribute(k, String(v));
        if (from.fill) ghost.setAttribute("fill", from.fill);
        if (from.stroke) ghost.setAttribute("stroke", from.stroke);
        newSvg.appendChild(ghost);
        tasks.push({ type: "exit", el: ghost });
    }

    // 4. Drive animation via requestAnimationFrame
    const t0 = performance.now();
    function frame(now: number) {
        const raw = Math.min((now - t0) / ms, 1);
        const e = ease(raw);
        for (const task of tasks) {
            if (task.type === "morph") {
                for (const k of Object.keys(task.toGeom))
                    task.el.setAttribute(
                        k,
                        String(
                            task.from.geom![k] +
                                (task.toGeom[k] - task.from.geom![k]) * e,
                        ),
                    );
                if (task.from.fill && task.toFill)
                    task.el.setAttribute(
                        "fill",
                        lerpColor(task.from.fill, task.toFill, e),
                    );
                if (task.from.stroke && task.toStroke)
                    task.el.setAttribute(
                        "stroke",
                        lerpColor(task.from.stroke, task.toStroke, e),
                    );
            } else if (task.type === "exit") {
                (task.el as HTMLElement).style.opacity = String(
                    1 - ease(Math.min(raw / 0.7, 1)),
                );
            } else {
                (task.el as HTMLElement).style.opacity = String(
                    ease(Math.max(0, Math.min((raw - 0.3) / 0.5, 1))) *
                        task.toOpacity,
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
                (task.el as HTMLElement).style.opacity = "";
            }
        }
        if (then) then();
    }
    requestAnimationFrame(frame);
}

const HANDLERS: Partial<
    Record<
        TransitionData["type"],
        (swap: () => void, t: TransitionData, then: (() => void) | null) => void
    >
> = {
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
        stage.style.transition = `opacity ${t.duration}s ease`;
        stage.style.opacity = "0";
        setTimeout(() => {
            swap();
            requestAnimationFrame(() => {
                stage.style.opacity = "1";
                if (then) then();
            });
        }, t.duration * 1000);
    },
};

// Replace innerHTML with new slide content. Does NOT call applyCurrentStep() —
// elements start in their pre-transition state so the next advance() triggers
// a real animated transition. Optional `then` runs after content is swapped.
// Pass `transition` to override the destination slide's declared transition (used
// when navigating backward so the outgoing slide's transition plays in reverse).
export function loadSlide(
    then: (() => void) | null = null,
    transition: TransitionData | null = null,
): void {
    const swap = () => {
        stage.innerHTML = state.slides.length
            ? state.slides[state.slideIndex].svg
            : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
        state._maxStepCache = null;
        updateStatus();
    };

    const t = transition ??
        state.transitions[state.slideIndex] ?? { type: "cut", duration: 0 };
    const handler = HANDLERS[t.type];
    if (handler) {
        handler(swap, t, then);
        return;
    }

    stage.style.transition = "none";
    stage.style.opacity = "1";
    swap();
    if (then) then();
}
