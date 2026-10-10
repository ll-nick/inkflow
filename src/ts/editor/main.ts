// The visual editor's entry point (served at /edit, bundled to editor.js).

import {
    hooks,
    initCanvas,
    isZone,
    render,
    select,
    slideRoot,
    zoneName,
} from "./canvas";
import { initCanvasMenu } from "./canvasmenu";
import { editChart } from "./chart";
import { initCompare } from "./compare";
import { initContext } from "./context";
import { isCropped, setCropMode, startCrop } from "./crop";
import { initDecks, showStart } from "./decks";
import { initDialog } from "./dialog";
import { toast } from "./dom";
import { diagramEdited, diagramOf, editDiagram } from "./drawio";
import { initExport } from "./exportdlg";
import { initFind } from "./find";
import { initGallery } from "./gallery";
import { initGit } from "./git";
import { initGrid } from "./grid";
import { initInk } from "./ink";
import { afterRender, initInsert } from "./insert";
import { connect } from "./net";
import { initNotes } from "./notes";
import { initObjects } from "./objects";
import { focusCellLabel, initProps } from "./props";
import { initSorter, renderSorter } from "./sorter";
import { currentSlide, ed, emit, on } from "./state";
import { editingHost, editSvgText, editZone, finishTextEdit } from "./textedit";
import { initTheme } from "./theme";
import { initToolbar } from "./toolbar";
import { initTouchZoom } from "./touchzoom";

const INITIAL_MODEL = __MODEL_JSON__;
const INITIAL_SLIDES = __SLIDES_JSON__;
const WS_PORT = __WS_PORT__;
const INITIAL_ERROR = __ERROR_JSON__;

const errorBox = document.getElementById("build-error")!;

function showError(): void {
    errorBox.textContent = ed.error ?? "";
    errorBox.classList.toggle("show", !!ed.error);
}

function editTextOf(el: SVGGraphicsElement): void {
    const slide = currentSlide();
    const loc = el.getAttribute("data-ink");
    if (!slide || !loc) return;
    const key = parseInt(loc.split(":")[0] ?? "", 10);
    const src = slide.sources?.[key];
    if (!src?.writable) {
        toast(
            "This text lives in a layout; switch to layout mode to edit it",
            "error",
        );
        return;
    }
    editSvgText(el, src.path, () => slide.sources?.[key]?.hash ?? "", loc);
}

// The slide number in the URL fragment, like the presenter (#slide=N, 1-based).
function readHash(): void {
    const m = location.hash.match(/slide=(\d+)/);
    if (!m || !ed.model) return;
    const n = Number(m[1]);
    const s = ed.model.slides.find((x) => x.visibleIndex === n - 1);
    if (s) ed.current = s.deckIndex;
}

function writeHash(): void {
    const s = currentSlide();
    if (s?.visibleIndex == null) return;
    const hash = `#slide=${s.visibleIndex + 1}`;
    if (location.hash !== hash) {
        try {
            history.replaceState(null, "", hash);
        } catch {
            // file:// or sandboxed: the position just is not remembered.
        }
    }
}

function selectPending(): void {
    if (!afterRender.ids.length) return;
    const svg = slideRoot();
    if (!svg) return;
    const els = afterRender.ids
        .map((id) => svg.querySelector(`[id="${CSS.escape(id)}"]`))
        .filter(
            (el): el is SVGGraphicsElement => el instanceof SVGGraphicsElement,
        );
    if (!els.length) return;
    const { editText, placeholder } = afterRender;
    afterRender.ids = [];
    afterRender.editText = false;
    afterRender.placeholder = undefined;
    select(els);
    if (editText && els[0].localName === "text") editTextOf(els[0]);
    else if (editText && isZone(els[0])) {
        editZone(zoneName(els[0]), els[0], { selectAll: true, placeholder });
    }
}

function boot(): void {
    ed.model = INITIAL_MODEL;
    ed.slides = INITIAL_SLIDES;
    ed.error = INITIAL_ERROR;
    readHash();

    hooks.editText = editTextOf;
    hooks.editZone = (zone, el, at) => {
        // A chart's "text" is its data.
        if (currentSlide()?.zones[zone]?.kind === "chart") void editChart(zone);
        else editZone(zone, el, { at });
    };
    hooks.editingHost = editingHost;
    hooks.crop = (el) => {
        const sel = ed.selection.find((s) => s.el === el);
        if (sel) void startCrop(sel);
    };
    hooks.finishEditing = () => void finishTextEdit();
    hooks.diagram = (el) => {
        const sel = ed.selection.find((s) => s.el === el);
        if (!sel || !diagramOf(el)) return false;
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
    // Crop mode belongs to the one picture it was started on.
    on("selection", () => {
        const one = ed.selection.length === 1 ? ed.selection[0].el : null;
        if (ed.cropMode && !(one && isCropped(one))) setCropMode(false);
    });
    on("error", showError);
    on("edit-zone", () => {
        const el = ed.selection[0]?.el;
        if (el && isZone(el)) hooks.editZone(zoneName(el), el);
    });
    on("edit-text", () => {
        const el = ed.selection[0]?.el;
        if (el?.localName === "text") editTextOf(el);
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
    // No deck yet (the start page): pick or make one.
    if (!ed.model && !ed.error) void showStart();
}

boot();
