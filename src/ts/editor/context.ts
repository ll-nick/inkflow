// Tell the server what the author is looking at, so an agent can act on "this":
// the server writes it to .inkflow/context.json, which `inkflow context` (and
// the Claude Code prompt hook it installs) reads back. Also receives the
// reverse direction: `inkflow goto` / `inkflow select` steer the editor.

import {
    enterGroup,
    isZone,
    select,
    slideBox,
    slideRoot,
    zoneName,
} from "./canvas";
import { onCommand, sendRaw } from "./net";
import { gotoSlide } from "./sorter";
import { currentSlide, ed, emit, on, sourceOf } from "./state";

let timer = 0;

function snapshot(): Record<string, unknown> {
    const slide = currentSlide();
    const visible = ed.model?.slides.filter((s) => s.visible).length ?? 0;
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
            notes: slide.notes.rel,
        },
        step: ed.step,
        layoutMode: ed.layoutMode,
        selection: ed.selection.map((s) => {
            const box = slideBox(s.el);
            const text = (s.el.textContent ?? "").replace(/\s+/g, " ").trim();
            return {
                id: s.el.getAttribute("id"),
                tag: s.el.localName,
                zone: isZone(s.el) ? zoneName(s.el) : null,
                file: sourceOf(s.key)?.rel,
                locator: s.loc,
                box: box && {
                    x: Math.round(box.x),
                    y: Math.round(box.y),
                    width: Math.round(box.width),
                    height: Math.round(box.height),
                },
                text: text.slice(0, 200) || null,
            };
        }),
    };
}

function report(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
        sendRaw({ type: "editor-context", context: snapshot() });
    }, 250);
}

export function initContext(): void {
    on("selection", report);
    on("slide", report);
    on("model", report);
    on("step", report);
    onCommand((msg) => {
        if (msg.command === "goto") {
            const n = Number(msg.slide);
            const slides = ed.model?.slides ?? [];
            // 1-based presentation number, like the presenter shows.
            const target = slides.find((s) => s.visibleIndex === n - 1);
            if (target) gotoSlide(target.deckIndex);
        } else if (msg.command === "select") {
            const ids = (msg.ids as string[]) ?? [];
            const svg = slideRoot();
            if (!svg) return;
            const els = ids
                .map((id) => svg.querySelector(`[id="${CSS.escape(id)}"]`))
                .filter(
                    (el): el is SVGGraphicsElement =>
                        el instanceof SVGGraphicsElement,
                );
            enterGroup(null);
            select(els);
            emit("flash");
        }
    });
}
