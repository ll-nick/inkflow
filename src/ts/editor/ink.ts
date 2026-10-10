// The editor's pen tool: draw on the slide, saved as the slide's ink.
//
// Every stroke is written to the slide's ink file (inkflow/ink.py) through
// the session, one undoable step per stroke; an eraser gesture is one step,
// and so is "Clear". The browser never writes a file: until the rebuild that
// holds a new stroke has rendered, the stroke is drawn from here, so it never
// blinks out after the pen lifts. Saved strokes are ordinary objects of the
// slide's `ink` source, so the select tool picks, moves and deletes them too.

import type { InkStroke } from "../shared/ink";
import { InkPad, strokeElement } from "../shared/inkpad";
import { InkPalette, loadSettings, saveSettings } from "../shared/inkpalette";
import {
    type InkSettings,
    normalizeHex,
    styleFor,
} from "../shared/inksettings";
import { slideRoot } from "./canvas";
import { toast } from "./dom";
import { edit } from "./net";
import { currentSlide, ed, on } from "./state";

const SETTINGS_KEY = "inkflow-ink-editor";
const SVG_NS = "http://www.w3.org/2000/svg";

// The pen tool is picked on purpose, so a mouse draws with it by default.
let settings: InkSettings = loadSettings(SETTINGS_KEY, true);
let pad: InkPad | null = null;

// The pen tool is on and a finger draws with it (not only a pen).
export function fingersDraw(): boolean {
    return penActive() && settings.fingers;
}

// A second finger made the touch a pinch: drop the stroke the first began
// (nothing was sent yet; a stroke is saved when it ends).
export function cancelStroke(): void {
    pad?.cancel();
}

function penActive(): boolean {
    return ed.tool === "pen" && ed.step == null && !ed.richEditing;
}

// Strokes sent but not yet back from a rebuild, by id.
const pending = new Map<string, { deckIndex: number; stroke: InkStroke }>();

function liveLayer(svg: SVGSVGElement): SVGGElement {
    let layer = svg.querySelector<SVGGElement>(":scope > g.inkflow-live-ink");
    if (!layer) {
        layer = document.createElementNS(SVG_NS, "g") as SVGGElement;
        layer.setAttribute("class", "inkflow-live-ink");
        svg.appendChild(layer);
    }
    return layer;
}

// Draw the strokes the rendered slide does not hold yet.
function showPending(): void {
    const svg = slideRoot();
    const slide = currentSlide();
    if (!svg || !slide) return;
    for (const [id, p] of pending) {
        if (p.deckIndex !== slide.deckIndex) continue;
        if (svg.querySelector(`.inkflow-ink [id="${CSS.escape(id)}"]`)) {
            pending.delete(id);
        } else if (!svg.getElementById(id)) {
            liveLayer(svg).appendChild(strokeElement(p.stroke));
        }
    }
}

async function save(stroke: InkStroke): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    pending.set(stroke.id, { deckIndex: slide.deckIndex, stroke });
    showPending();
    const result = await edit({
        action: "ink",
        op: "add",
        slide: slide.deckIndex,
        strokes: [stroke],
    });
    if (!result.ok) {
        pending.delete(stroke.id);
        slideRoot()?.getElementById(stroke.id)?.remove();
    }
}

async function erase(
    ids: string[],
    hidden: SVGGraphicsElement[],
): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    for (const id of ids) pending.delete(id);
    const result = await edit({
        action: "ink",
        op: "erase",
        slide: slide.deckIndex,
        ids,
    });
    // Refused: what the eraser hid comes back.
    if (!result.ok) for (const el of hidden) el.style.removeProperty("display");
}

async function clear(): Promise<void> {
    const slide = currentSlide();
    if (!slide?.ink?.exists && !pending.size) {
        toast("This slide has no ink");
        return;
    }
    if (!slide || !window.confirm("Remove all ink from this slide?")) return;
    pending.clear();
    await edit({ action: "ink", op: "clear", slide: slide.deckIndex });
}

function tokenColor(token: string): string | null {
    const value = getComputedStyle(slideRoot() ?? document.documentElement)
        .getPropertyValue(`--inkflow-${token}`)
        .trim();
    return value ? normalizeHex(value) : null;
}

export function initInk(): void {
    const paper = document.getElementById("paper")!;
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
        clear: () => void clear(),
    });
    palette.el.classList.add("editor-ink");
    palette.el.hidden = true;
    document.body.appendChild(palette.el);

    pad = new InkPad({
        surface: paper,
        active: penActive,
        fingers: () => settings.fingers,
        tool: () => settings.tool,
        svg: () => (currentSlide()?.ink ? slideRoot() : null),
        style: (tool, svg) =>
            styleFor(
                settings,
                tool,
                svg.viewBox.baseVal.width,
                tokenColor,
                svg.viewBox.baseVal.height,
            ),
        *erasables(svg) {
            yield* svg.querySelectorAll<SVGGraphicsElement>(
                ".inkflow-ink path[id], .inkflow-live-ink path[id]",
            );
        },
        onStroke: (stroke) => void save(stroke),
        onErase: (ids, hidden) => void erase(ids, hidden),
    });

    on("tool", () => {
        palette.el.hidden = ed.tool !== "pen";
    });
    on("render", showPending);
}
