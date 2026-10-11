import type { SlideData } from "../shared/types";
import type { PlaceholderList } from "./placeholdertext";
import type { EditorModel, Selected, SlideModel, SourceInfo } from "./types";

export type Tool =
    | "select"
    | "text"
    | "rect"
    | "ellipse"
    | "line"
    | "arrow"
    | "elbow"
    | "curve"
    | "pen";

/** The tools that draw a connector, and the route each draws. */
export const CONNECTOR_TOOLS: Partial<
    Record<Tool, "straight" | "elbow" | "curved">
> = {
    line: "straight",
    arrow: "straight",
    elbow: "elbow",
    curve: "curved",
};

/** What the slide master shows on the canvas (master.ts): a layout or an
 * overlay drawn alone (`master-render`), or with a slide's content
 * (`onSlide`), and the one file whose objects are edited there. */
export interface MasterView {
    kind: "layout" | "overlay";
    path: string; // the file edited (the deck's copy once one is made)
    name: string;
    slide: SlideModel;
    data: SlideData;
    onSlide: number | null; // deck index of the slide shown, else null
    // Its placeholders (`master-placeholders`), for the props panel.
    placeholders?: PlaceholderList;
}

// All mutable editor state, in one place (mirrors presenter/state.ts).
export const ed = {
    model: null as EditorModel | null,
    slides: [] as SlideData[], // rendered SVG per *visible* slide
    current: 0, // deck index of the slide being edited
    selection: [] as Selected[],
    scope: null as SVGGElement | null, // group entered by double-click
    layoutMode: false,
    // The slide master is open (its list replaces the slide list).
    masterMode: false,
    master: null as MasterView | null,
    step: null as number | null, // null: every element shown, no build state
    zoom: 0, // 0 = fit to window, else device px per slide unit
    tool: "select" as Tool,
    interacting: false, // a drag is in progress: defer re-renders
    richEditing: false, // a zone is being edited in place: defer re-renders
    cropMode: false, // the selected image's handles crop instead of scaling
    renderPending: false,
    canUndo: false,
    canRedo: false,
    undoLabel: null as string | null, // what Undo would take back ("Move slide")
    redoLabel: null as string | null,
    // Someone else's later edit to the same files keeps Undo from taking
    // this person's last step back (their name), else null.
    undoBlockedBy: null as string | null,
    slideSelection: new Set<number>(), // deck indices picked in the slide list
    focus: "canvas" as "canvas" | "sorter", // where Delete / copy apply
    error: null as string | null,
    // A structural edit was sent and its rebuild has not been rendered yet.
    structuralPending: false,
    rebuilt: false, // a model arrived since the last render
    restyled: false, // so did a new stylesheet or colour mode (text fits anew)
};

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

// Tiny event bus: "render" (slide DOM replaced), "selection", "model", "tool".
export function on(event: string, fn: Listener): void {
    let set = listeners.get(event);
    if (!set) {
        set = new Set();
        listeners.set(event, set);
    }
    set.add(fn);
}

export function off(event: string, fn: Listener): void {
    listeners.get(event)?.delete(fn);
}

export function emit(event: string): void {
    for (const fn of [...(listeners.get(event) ?? [])]) fn();
}

export function currentSlide(): SlideModel | null {
    if (ed.master) return ed.master.slide;
    return ed.model?.slides[ed.current] ?? null;
}

export function currentRendered(): SlideData | null {
    if (ed.master) return ed.master.data;
    const s = currentSlide();
    if (!s || s.visibleIndex == null) return null;
    return ed.slides[s.visibleIndex] ?? null;
}

export function sourceOf(key: number): SourceInfo | null {
    return currentSlide()?.sources?.[key] ?? null;
}

export function slideByDeckIndex(i: number): SlideModel | null {
    return ed.model?.slides[i] ?? null;
}
