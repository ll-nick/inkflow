// The top toolbar and the keyboard: tools, undo/redo, zoom, build-step preview,
// layout mode, and the object commands (delete, duplicate, group, z-order) that
// both the panel buttons and shortcuts trigger.

import { maxStep } from "../shared/step";
import {
    canTransform,
    canTypeInto,
    clearSelection,
    drawOverlay,
    enterGroup,
    isZone,
    layoutPaper,
    nudge,
    render,
    scale,
    selectAll,
    sendSvgOps,
    setZoom,
    slideRoot,
    zoneName,
} from "./canvas";
import { insertChart } from "./chart";
import { copy, copySlides, cut, cutSlides } from "./clipboard";
import { setCropMode } from "./crop";
import { toast } from "./dom";
import { newDiagram } from "./drawio";
import { openFind } from "./find";
import { openGallery } from "./gallery";
import { toggleGrid } from "./grid";
import { insertImage, insertVideo, setTool, typeInto } from "./insert";
import { edit } from "./net";
import { alignSelection } from "./props";
import {
    deleteSlide,
    deleteSlides,
    duplicateSlide,
    gotoSlide,
    newSlideLike,
} from "./sorter";
import { currentSlide, ed, emit, on, type Tool } from "./state";
import { copyStyle, pasteStyle } from "./stylecopy";
import { isEditingText } from "./textedit";
import type { SvgOp } from "./types";

const $ = (id: string) => document.getElementById(id)!;

export async function undo(): Promise<void> {
    await edit({ action: "undo" });
}

export async function redo(): Promise<void> {
    await edit({ action: "redo" });
}

export async function deleteSelection(): Promise<void> {
    const slide = currentSlide();
    if (!slide || !ed.selection.length) return;
    const zones = ed.selection.filter(
        (s) => isZone(s.el) && !canTransform(s.el),
    );
    const shapes = ed.selection.filter((s) => !zones.includes(s));
    for (const z of zones) {
        const name = zoneName(z.el);
        const value = slide.zones[name];
        if (slide.zoneOrigins?.[name] === "md-file") {
            toast(
                "This zone shows the whole Markdown file: edit its text instead",
            );
            continue;
        }
        if (
            value &&
            (value.kind === "image" ||
                value.kind === "video" ||
                value.kind === "chart")
        ) {
            await edit({
                action: "zone-media",
                slide: slide.deckIndex,
                zone: name,
                src: null,
            });
        } else {
            await edit({
                action: "zone-text",
                slide: slide.deckIndex,
                zone: name,
                text: "",
                origin: slide.zoneOrigins?.[name],
            });
        }
    }
    if (shapes.length) {
        await sendSvgOps(
            shapes.map((s) => ({
                sel: s,
                ops: [{ kind: "delete", loc: s.loc } as SvgOp],
            })),
            "Delete",
        );
    }
    clearSelection();
}

export async function duplicateSelection(): Promise<void> {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    const k = 1 / (scale() || 1);
    const off = Math.round(24 * Math.max(1, k * 0.5));
    await sendSvgOps(
        sels.map((s, i) => ({
            sel: s,
            ops: [
                {
                    kind: "duplicate",
                    loc: s.loc,
                    offset: [off, off],
                    key: `dup${i}`,
                },
            ],
        })),
        "Duplicate",
    );
}

export async function groupSelection(): Promise<void> {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (sels.length < 2) return;
    const key = sels[0].key;
    const parent = sels[0].el.parentElement;
    if (sels.some((s) => s.key !== key || s.el.parentElement !== parent)) {
        toast(
            "Only objects side by side in the same file can be grouped",
            "error",
        );
        return;
    }
    await sendSvgOps(
        [
            {
                sel: sels[0],
                ops: [{ kind: "group", locs: sels.map((s) => s.loc) }],
            },
        ],
        "Group",
    );
}

export async function ungroupSelection(): Promise<void> {
    const s = ed.selection[0];
    if (s?.el.localName !== "g" || !canTransform(s.el)) return;
    await sendSvgOps(
        [{ sel: s, ops: [{ kind: "ungroup", loc: s.loc }] }],
        "Ungroup",
    );
}

export async function order(to: string): Promise<void> {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    await sendSvgOps(
        sels.map((s) => ({ sel: s, ops: [{ kind: "order", loc: s.loc, to }] })),
        "Arrange",
    );
}

function present(): void {
    const slide = currentSlide();
    const n = (slide?.visibleIndex ?? 0) + 1;
    window.open(`/#slide=${n}`, "inkflow-present");
}

function toggleTheme(): void {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "light" ? "" : "light";
    render();
}

function setLayoutMode(on: boolean): void {
    ed.layoutMode = on;
    document.body.classList.toggle("layout-mode", on);
    $("btn-layout").classList.toggle("on", on);
    enterGroup(null);
    clearSelection();
    drawOverlay();
    emit("layout-mode");
    if (on) toast("Layout mode: edits change the shared layout files");
}

function renderStepSelect(): void {
    const sel = $("step-select") as HTMLSelectElement;
    const svg = slideRoot();
    const max = svg ? maxStep(svg) : 0;
    sel.innerHTML = "";
    sel.append(new Option("All objects", ""));
    for (let i = 0; i <= max; i++)
        sel.append(new Option(`Build step ${i}`, String(i)));
    sel.value = ed.step == null ? "" : String(Math.min(ed.step, max));
    sel.disabled = max === 0 && ed.step == null;
}

// The whole editor page, not the browser's own F11 full screen (which a
// page cannot leave again).
export function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
}

function updateFullscreen(): void {
    const on = !!document.fullscreenElement;
    const b = $("btn-fullscreen");
    b.classList.toggle("on", on);
    b.title = on ? "Leave full screen (F)" : "Full screen (F)";
}

function updateZoomLabel(): void {
    $("zoom-label").textContent = `${Math.round(scale() * 100)}%`;
}

function updateHistory(): void {
    const undoBtn = $("btn-undo") as HTMLButtonElement;
    const redoBtn = $("btn-redo") as HTMLButtonElement;
    undoBtn.disabled = !ed.canUndo;
    redoBtn.disabled = !ed.canRedo;
    // Named after the step, so an agent's edit reads "Undo Agent: …".
    undoBtn.title = historyTitle("Undo", ed.canUndo && ed.undoLabel, "Ctrl+Z");
    redoBtn.title = historyTitle(
        "Redo",
        ed.canRedo && ed.redoLabel,
        "Ctrl+Shift+Z",
    );
}

function historyTitle(
    verb: string,
    label: string | false | null,
    keys: string,
): string {
    return label ? `${verb} ${label} (${keys})` : `${verb} (${keys})`;
}

function updateTools(): void {
    document.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => {
        b.classList.toggle("on", b.dataset.tool === ed.tool);
    });
}

const TOOL_KEYS: Record<string, Tool> = {
    v: "select",
    t: "text",
    r: "rect",
    o: "ellipse",
    l: "line",
    a: "arrow",
    e: "elbow",
    c: "curve",
    p: "pen",
};

function onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (
        target.closest("input, textarea, select, [contenteditable]") ||
        isEditingText()
    ) {
        return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    const handled = () => e.preventDefault();
    if (mod && lower === "z") {
        handled();
        void (e.shiftKey ? redo() : undo());
    } else if (mod && lower === "y") {
        handled();
        void redo();
    } else if (mod && lower === "a") {
        handled();
        selectAll();
    } else if (mod && lower === "d") {
        handled();
        void duplicateSelection();
    } else if (mod && e.altKey && (e.code === "KeyC" || e.code === "KeyV")) {
        // Copy / paste an object's style (e.key is a symbol with Option).
        handled();
        if (e.code === "KeyC") copyStyle();
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
        void (e.shiftKey ? ungroupSelection() : groupSelection());
    } else if (mod && lower === "m") {
        handled();
        // Ctrl+M: a new slide on this slide's layout; with Shift, pick one.
        if (e.shiftKey) void openGallery({ mode: "insert", after: ed.current });
        else if (ed.model?.deckEditable) void newSlideLike(ed.current);
        else
            toast(
                "deck.py builds its slides in code; add slides there",
                "error",
            );
    } else if (mod && key === "Enter") {
        handled();
        present();
    } else if (mod && (key === "ArrowUp" || key === "ArrowDown")) {
        handled();
        const up = key === "ArrowUp";
        void order(
            e.shiftKey ? (up ? "front" : "back") : up ? "forward" : "backward",
        );
    } else if (
        (key === "Delete" || key === "Backspace") &&
        ed.focus === "sorter"
    ) {
        handled();
        void deleteSlides();
    } else if (key === "Delete" || key === "Backspace") {
        if (ed.selection.length) {
            handled();
            void deleteSelection();
        }
    } else if (key.startsWith("Arrow") && ed.selection.length) {
        handled();
        const d = e.shiftKey ? 10 : 1;
        const dx = key === "ArrowLeft" ? -d : key === "ArrowRight" ? d : 0;
        const dy = key === "ArrowUp" ? -d : key === "ArrowDown" ? d : 0;
        void nudge(dx, dy);
    } else if (
        key === "PageDown" ||
        (key === "ArrowDown" && !ed.selection.length)
    ) {
        handled();
        gotoSlide(ed.current + 1);
    } else if (
        key === "PageUp" ||
        (key === "ArrowUp" && !ed.selection.length)
    ) {
        handled();
        gotoSlide(ed.current - 1);
    } else if (ed.cropMode && (key === "Escape" || key === "Enter")) {
        handled();
        setCropMode(false);
    } else if (key === "Escape") {
        if (ed.tool !== "select") setTool("select");
        else if (ed.scope) enterGroup(null);
        else clearSelection();
    } else if (
        key === "Enter" &&
        ed.selection.length === 1 &&
        canTypeInto(ed.selection[0].el)
    ) {
        handled();
        void typeInto(ed.selection[0].el);
    } else if (key === "Enter" && ed.selection.length === 1) {
        handled();
        const el = ed.selection[0].el;
        emit(
            isZone(el)
                ? "edit-zone"
                : el.localName === "text"
                  ? "edit-text"
                  : "noop",
        );
        if (el.localName === "g") enterGroup(el as unknown as SVGGElement);
    } else if (!mod && (key === "+" || key === "=")) {
        setZoom(scale() * 1.25);
    } else if (!mod && key === "-") {
        setZoom(scale() / 1.25);
    } else if (!mod && key === "0") {
        setZoom(0);
    } else if (!mod && !e.altKey && lower in TOOL_KEYS) {
        setTool(TOOL_KEYS[lower]);
    } else if (!mod && !e.altKey && lower === "g") {
        toggleGrid();
    } else if (!mod && !e.altKey && lower === "f") {
        handled();
        toggleFullscreen();
    } else if (!mod && lower === "i") {
        void (e.shiftKey ? insertVideo() : insertImage());
    }
}

export function initToolbar(): void {
    $("btn-undo").addEventListener("click", () => void undo());
    $("btn-redo").addEventListener("click", () => void redo());
    document.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => {
        b.addEventListener("click", () => setTool(b.dataset.tool as Tool));
    });
    $("btn-image").addEventListener("click", () => void insertImage());
    $("btn-video").addEventListener("click", () => void insertVideo());
    $("btn-diagram").addEventListener("click", () => newDiagram());
    $("btn-chart").addEventListener("click", () => void insertChart());
    $("zoom-in").addEventListener("click", () => setZoom(scale() * 1.25));
    $("zoom-out").addEventListener("click", () => setZoom(scale() / 1.25));
    $("zoom-fit").addEventListener("click", () => setZoom(0));
    $("btn-layout").addEventListener("click", () =>
        setLayoutMode(!ed.layoutMode),
    );
    $("btn-theme").addEventListener("click", toggleTheme);
    $("btn-present").addEventListener("click", present);
    $("btn-fullscreen").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", updateFullscreen);
    $("step-select").addEventListener("change", (e) => {
        const v = (e.target as HTMLSelectElement).value;
        ed.step = v === "" ? null : Number(v);
        document.body.classList.toggle("previewing", ed.step != null);
        render();
        emit("step");
    });
    document.addEventListener("keydown", onKey);
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
