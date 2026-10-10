// Ink mode in the presenter: draw on the slide with a pen while presenting.
//
// Strokes belong to their slide. They are drawn into the mounted slide's own
// <svg> (a `g.inkflow-live-ink` appended last), so they sit in slide units,
// follow the zoom camera and resizes, and leave with the slide in its
// transition; mountInk() puts the slide's strokes back whenever it is shown.
//
// By default ink lasts for the talk: it is held in memory (inkstore.ts) and
// relayed to the other windows like the position, so the projector shows what
// is drawn in the presenter-panel window. With "Keep" on, each finished
// stroke is also written to the slide's ink file through the server's editor
// session (only for a page on this machine; the server checks), and the
// rebuild then shows it from the file. A static build has no server: its ink
// is never saved, and travels only to the window it opened.

import {
    flatten,
    type InkStroke,
    type InputPoint,
    type LiveStroke,
    outlineOf,
    pathData,
    strokeFrom,
    styleFrom,
    unflatten,
} from "../shared/ink";
import { InkPad, paintStroke, strokeElement, strokeOf } from "../shared/inkpad";
import { InkPalette, loadSettings, saveSettings } from "../shared/inkpalette";
import {
    type InkSettings,
    normalizeHex,
    styleFor,
} from "../shared/inksettings";
import type { InkMessage } from "../shared/types";
import { type HeldStroke, InkStore, type SlideInk } from "./inkstore";
import { onSlideLeaving, onSlideMounted } from "./slidehooks";
import { state } from "./state";
import { showNotify } from "./ui";
import { isCameraGesture, onTouchCancel } from "./zoom";

const SETTINGS_KEY = "inkflow-ink-presenter";
const SVG_NS = "http://www.w3.org/2000/svg";

const stage = document.getElementById("stage");
const stageWrap = document.getElementById("stage-wrap");
const overviewEl = document.getElementById("overview");
const button = document.getElementById("btn-ink");

const store = new InkStore();
let settings: InkSettings = loadSettings(SETTINGS_KEY, false);
let active = false;
let palette: InkPalette | null = null;
let pad: InkPad | null = null;
// A second finger made the touch a pinch: the stroke its first finger began
// is abandoned (the other windows drop it too), never kept.
onTouchCancel(() => pad?.cancel());
let send: (msg: InkMessage) => void = () => {};
let saving = false; // a server that may save ink: served, and this machine's

// Strokes another window is drawing right now, by stroke id.
const drawing = new Map<
    string,
    { slide: string; live: LiveStroke; points: InputPoint[] }
>();
// Saved strokes erased here, hidden until the rebuild drops them from the file.
const hiddenSaved = new Set<string>();
// Saves the server has not answered yet, so a refusal can be undone.
const pendingSaves = new Map<
    string,
    { slide: string; op: "add" | "erase"; ids: string[] }
>();
let saveCount = 0;

function slideId(): string | null {
    return state.slides[state.slideIndex]?.id ?? null;
}

// The mounted slide, unless a transition holds the stage (two slides at once).
function slideSvg(): SVGSVGElement | null {
    return stage?.querySelector<SVGSVGElement>(":scope > svg") ?? null;
}

function current(): SlideInk | null {
    const id = slideId();
    return id === null ? null : store.get(id);
}

// ── Showing ink ──────────────────────────────────────────────────────────────

function group(parent: Element, name: string): SVGGElement {
    let g = parent.querySelector<SVGGElement>(`:scope > g[data-${name}]`);
    if (!g) {
        g = document.createElementNS(SVG_NS, "g") as SVGGElement;
        g.setAttribute(`data-${name}`, "");
        parent.appendChild(g);
    }
    return g;
}

// Bring the mounted slide's ink up to date: called whenever a slide is
// mounted, and after anything changes the current slide's ink.
function mountInk(): void {
    const svg = slideSvg();
    const id = slideId();
    if (!svg || id === null) return;
    const ink = store.get(id);
    const inFile = new Set(
        [...svg.querySelectorAll(".inkflow-ink [id]")].map((el) => el.id),
    );
    ink.settle(inFile);
    for (const hidden of [...hiddenSaved]) {
        const el = inFile.has(hidden) ? svg.getElementById(hidden) : null;
        if (el instanceof SVGElement) el.style.display = "none";
        else hiddenSaved.delete(hidden);
    }
    let layer = svg.querySelector<SVGGElement>(":scope > g.inkflow-live-ink");
    if (!layer) {
        layer = document.createElementNS(SVG_NS, "g") as SVGGElement;
        layer.setAttribute("class", "inkflow-live-ink");
        svg.appendChild(layer);
    }
    // Held strokes are rebuilt only when they changed.
    const held = group(layer, "held");
    const rev = `${id}:${ink.rev}`;
    if (held.dataset.rev !== rev) {
        held.replaceChildren(...ink.strokes.map(strokeElement));
        held.dataset.rev = rev;
    }
    // Strokes another window is drawing: one path each, reshaped in place.
    const relayed = group(layer, "relayed");
    const shown = new Map(
        [...relayed.children].map((el) => [el.getAttribute("data-stroke"), el]),
    );
    for (const [strokeId, d] of drawing) {
        if (d.slide !== id) continue;
        let path = shown.get(strokeId) as SVGPathElement | undefined;
        if (!path) {
            path = paintStroke(
                document.createElementNS(SVG_NS, "path") as SVGPathElement,
                d.live,
            );
            path.setAttribute("data-stroke", strokeId);
            relayed.appendChild(path);
        }
        shown.delete(strokeId);
        path.setAttribute(
            "d",
            pathData(outlineOf(d.points, d.live, d.live.simulate, false), 2),
        );
    }
    for (const stale of shown.values()) stale?.remove();
}

let mountFrame = 0;
function remount(): void {
    if (mountFrame) return;
    mountFrame = requestAnimationFrame(() => {
        mountFrame = 0;
        mountInk();
    });
}

// ── Changing ink ─────────────────────────────────────────────────────────────

function save(
    slide: string,
    op: "add" | "erase",
    payload: Record<string, unknown>,
    ids: string[],
): boolean {
    const ws = state.ws;
    if (!saving || !ws || ws.readyState !== WebSocket.OPEN) {
        showNotify("Ink not saved: no connection to the inkflow server", "red");
        return false;
    }
    const id = `ink-${++saveCount}`;
    pendingSaves.set(id, { slide, op, ids });
    ws.send(
        JSON.stringify({
            type: "edit-op",
            id,
            action: "ink",
            op,
            slideId: slide,
            ...payload,
        }),
    );
    return true;
}

// The server's answer to a save (an `edit-result` with one of save()'s ids).
// A refused stroke stays shown for the talk instead of being lost; a refused
// erase shows the stroke again.
export function inkSaveResult(msg: Record<string, unknown>): boolean {
    const pending =
        typeof msg.id === "string" ? pendingSaves.get(msg.id) : undefined;
    if (!pending) return false;
    pendingSaves.delete(msg.id as string);
    if (msg.ok) return true;
    showNotify(`Ink not saved: ${String(msg.error ?? "refused")}`, "red");
    const ids = new Set(pending.ids);
    if (pending.op === "add") {
        for (const s of store.get(pending.slide).strokes) {
            if (ids.has(s.id)) s.saved = false;
        }
    } else {
        for (const id of ids) hiddenSaved.delete(id);
        for (const id of ids) {
            const el = slideSvg()?.getElementById(id);
            if (el instanceof SVGElement) el.style.removeProperty("display");
        }
    }
    return true;
}

function plain(s: HeldStroke): InkStroke {
    const { saved: _, ...stroke } = s;
    return stroke;
}

function addStrokes(ink: SlideInk, strokes: HeldStroke[], slide: string): void {
    ink.add(strokes);
    const keep = strokes.filter((s) => s.saved);
    if (
        keep.length &&
        !save(
            slide,
            "add",
            { strokes: keep.map(plain) },
            keep.map((s) => s.id),
        )
    ) {
        for (const s of keep) s.saved = false;
    }
    send({ type: "ink", op: "add", slide, strokes: strokes.map(plain) });
}

function eraseStrokes(
    ink: SlideInk,
    strokes: HeldStroke[],
    slide: string,
): void {
    const ids = strokes.map((s) => s.id);
    ink.remove(ids);
    const saved = strokes.filter((s) => s.saved).map((s) => s.id);
    if (saved.length && save(slide, "erase", { ids: saved }, saved)) {
        for (const id of saved) hiddenSaved.add(id);
    }
    send({ type: "ink", op: "erase", slide, ids });
}

function undoInk(): void {
    const ink = current();
    const slide = slideId();
    const action = ink?.popUndo();
    if (!ink || !action || slide === null) return;
    if (action.kind === "add") eraseStrokes(ink, action.strokes, slide);
    else addStrokes(ink, action.strokes, slide);
    mountInk();
}

// The saved strokes on the mounted slide, as strokes that can be put back.
function savedStrokes(els: Iterable<Element>): HeldStroke[] {
    return [...els]
        .filter((el) => !hiddenSaved.has(el.id))
        .map(strokeOf)
        .filter((s): s is InkStroke => s !== null)
        .map((s) => ({ ...s, saved: true }));
}

function clearInk(): void {
    const ink = current();
    const svg = slideSvg();
    const slide = slideId();
    if (!ink || !svg || slide === null) return;
    // The ink file's strokes go too, but only while "Keep" is on: without it
    // nothing drawn here touches the deck's files.
    const saved =
        settings.keep && saving
            ? savedStrokes(svg.querySelectorAll(".inkflow-ink path[id]"))
            : [];
    const all = [...ink.strokes, ...saved];
    if (!all.length) return;
    if (
        saved.length &&
        !window.confirm(
            "Clear this slide's ink, including the strokes saved with the deck?",
        )
    )
        return;
    eraseStrokes(ink, all, slide);
    ink.record({ kind: "erase", strokes: all });
    mountInk();
}

// ── Relayed ink ──────────────────────────────────────────────────────────────

// A change another window made. Every field is checked first: relayed ink is
// drawn into this page.
export function applyIncomingInk(msg: InkMessage): void {
    if (msg.op === "request") {
        const slides = store.snapshot();
        if (Object.keys(slides).length)
            send({ type: "ink", op: "state", slides });
        return;
    }
    if (msg.op === "state") {
        if (typeof msg.slides !== "object" || msg.slides === null) return;
        for (const [slide, raw] of Object.entries(msg.slides)) {
            if (!Array.isArray(raw)) continue;
            store.get(slide).add(raw.map(strokeFrom).filter((s) => s !== null));
        }
        remount();
        return;
    }
    if (typeof msg.slide !== "string") return;
    const ink = store.get(msg.slide);
    if (msg.op === "draw") {
        const style = styleFrom(msg.stroke);
        const points = unflatten(msg.points);
        if (!style || !points || typeof msg.from !== "number") return;
        const simulate = (msg.stroke as { simulate?: unknown }).simulate;
        const live: LiveStroke = { ...style, simulate: simulate === true };
        const d = drawing.get(live.id) ?? {
            slide: msg.slide,
            live,
            points: [],
        };
        d.points = d.points.slice(0, Math.max(0, msg.from)).concat(points);
        drawing.set(live.id, d);
    } else if (msg.op === "abandon") {
        drawing.delete(String(msg.id));
    } else if (msg.op === "add") {
        if (!Array.isArray(msg.strokes)) return;
        const strokes = msg.strokes.map(strokeFrom).filter((s) => s !== null);
        for (const s of strokes) drawing.delete(s.id);
        ink.add(strokes);
    } else if (msg.op === "erase") {
        if (!Array.isArray(msg.ids)) return;
        ink.remove(msg.ids.filter((i): i is string => typeof i === "string"));
    }
    if (msg.slide === slideId()) remount();
}

// ── Mode and palette ─────────────────────────────────────────────────────────

export function inkActive(): boolean {
    return active;
}

export function toggleInk(): void {
    active = !active;
    if (!active) pad?.cancel();
    document.body.classList.toggle("ink-mode", active);
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-pressed", String(active));
    if (palette) palette.el.hidden = !active;
}

// Ink's keys while ink mode is on: Ctrl+Z takes back the last stroke and
// Escape leaves the mode. Returns whether the key was ink's.
export function inkKey(e: KeyboardEvent): boolean {
    if (!active) return false;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoInk();
        return true;
    }
    if (e.key === "Escape") {
        toggleInk();
        return true;
    }
    return false;
}

function tokenColor(token: string): string | null {
    const value = getComputedStyle(slideSvg() ?? document.documentElement)
        .getPropertyValue(`--inkflow-${token}`)
        .trim();
    return value ? normalizeHex(value) : null;
}

// `wsPort` is the server's (null in a static build). Saving is offered only
// where it can work: served, and opened on the server's own machine.
export function initInk(
    wsPort: number | null,
    sender: (msg: InkMessage) => void,
): void {
    send = sender;
    if (!stage || !stageWrap) return;
    onSlideMounted(mountInk);
    // A stroke in progress belongs to the slide that is going.
    onSlideLeaving(() => pad?.cancel());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(
        location.hostname,
    );
    saving = wsPort !== null && local;
    if (!saving) settings.keep = false;
    palette = new InkPalette({
        settings,
        keep: saving,
        undoTitle: "Undo the last stroke (Ctrl+Z)",
        clearTitle: "Clear this slide's ink",
        onChange(next) {
            settings = next;
            saveSettings(SETTINGS_KEY, settings);
        },
        undo: undoInk,
        clear: clearInk,
        close: toggleInk,
    });
    palette.el.hidden = true;
    stageWrap.appendChild(palette.el);

    pad = new InkPad({
        surface: stageWrap,
        active: () => active,
        fingers: () => settings.fingers,
        tool: () => settings.tool,
        allows: (e) =>
            !isCameraGesture(e) &&
            !overviewEl?.classList.contains("visible") &&
            !(e.target as Element).closest(".ink-palette"),
        svg: slideSvg,
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
                ".inkflow-live-ink [data-held] path[id]",
            );
            // The deck's saved ink only while "Keep" is on, like Clear.
            if (settings.keep && saving) {
                yield* svg.querySelectorAll<SVGGraphicsElement>(
                    ".inkflow-ink path[id]",
                );
            }
        },
        onDraw(live, from, points) {
            const slide = slideId();
            if (slide === null) return;
            send({
                type: "ink",
                op: "draw",
                slide,
                stroke: live,
                from,
                points: flatten(points),
            });
        },
        onAbandon(live) {
            const slide = slideId();
            if (slide !== null)
                send({ type: "ink", op: "abandon", slide, id: live.id });
        },
        onStroke(stroke) {
            const ink = current();
            const slide = slideId();
            if (!ink || slide === null) return;
            const held: HeldStroke = {
                ...stroke,
                saved: settings.keep && saving,
            };
            addStrokes(ink, [held], slide);
            ink.record({ kind: "add", strokes: [held] });
            mountInk();
        },
        onErase(ids, hidden) {
            const ink = current();
            const slide = slideId();
            if (!ink || slide === null) return;
            const taken = new Set(ids);
            const held = ink.strokes.filter((s) => taken.has(s.id));
            const heldIds = new Set(held.map((s) => s.id));
            const saved = savedStrokes(
                hidden.filter((el) => !heldIds.has(el.id)),
            );
            eraseStrokes(ink, [...held, ...saved], slide);
            ink.record({ kind: "erase", strokes: [...held, ...saved] });
            mountInk();
        },
    });
}

// Ask the other windows for the ink they hold (this window just connected).
export function requestInk(): void {
    send({ type: "ink", op: "request" });
}
