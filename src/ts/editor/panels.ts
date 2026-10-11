// Hiding and showing the editor's panels: the slide list on the left, the
// speaker notes below the slide, the properties on the right. Each has a
// tab on its edge of the canvas (always there, so a hidden panel comes back
// with the mouse) and a key (1, 2, 3). The canvas takes the room a hidden panel
// leaves; which ones are hidden is the author's, kept from slide to slide
// and across reloads. A panel only ever hides: its own state (the notes'
// height, the list's scroll) is as it was when it comes back.

import { layoutPaper } from "./canvas";
import { keyLabel } from "./keys";
import {
    PANELS,
    type Panel,
    panelTitle,
    parseShown,
    type Shown,
    storeShown,
} from "./panelstext";
import { emit, on } from "./state";

const KEY = "inkflow-editor-panels";

let shown: Shown = parseShown(null);

function button(panel: Panel): HTMLElement | null {
    return document.getElementById(`btn-panel-${panel}`);
}

function apply(): void {
    for (const panel of PANELS) {
        document.body.classList.toggle(`hide-${panel}`, !shown[panel]);
        const b = button(panel);
        if (!b) continue;
        b.classList.toggle("on", shown[panel]);
        b.setAttribute("aria-pressed", String(shown[panel]));
    }
    titles();
    // The slide is laid out for the canvas's new size (its ResizeObserver
    // does so too, a frame later), and the zoom shown is the new one.
    layoutPaper();
    emit("zoom");
}

export function togglePanel(panel: Panel): void {
    shown = { ...shown, [panel]: !shown[panel] };
    try {
        localStorage.setItem(KEY, storeShown(shown));
    } catch {
        // not remembered
    }
    apply();
}

export function panelShown(panel: Panel): boolean {
    return shown[panel];
}

function titles(): void {
    for (const panel of PANELS) {
        const b = button(panel);
        if (b)
            b.title = panelTitle(
                panel,
                shown[panel],
                keyLabel(`view.${panel}`),
            );
    }
}

export function initPanels(): void {
    on("keys", titles);
    try {
        shown = parseShown(localStorage.getItem(KEY));
    } catch {
        // every panel shown
    }
    for (const panel of PANELS) {
        button(panel)?.addEventListener("click", () => togglePanel(panel));
    }
    apply();
}
