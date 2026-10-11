// The slide master (the toolbar's "Slide master"): the deck's layouts and
// overlays as PowerPoint's master view shows them. A list replaces the slide
// list: "All slides" (the background every layout is built on, and the
// overlays drawn on top of every slide) and every layout, indented by what it
// is built on. Choosing one draws it on the canvas, its ancestors and the
// overlays faded around it, and makes its own objects the editable ones;
// edits reach every slide on it through the rebuild.
//
// A theme's layout is never written: the server copies it into the deck
// (layouts/<name>.svg) in the same step as the first edit (net.ts adds
// `copyLayout`), and that copy stands in for the theme's from then on, also
// under the theme's other layouts (editor/master.py). Templates are slides
// saved as layouts ("Save as layout…").

import { scheduleFit } from "../shared/fit";
import type { SlideData } from "../shared/types";
import { clearSelection, enterGroup, keyOf, render, slideRoot } from "./canvas";
import { closeDialog, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { layoutLabel } from "./gallery";
import { setTool } from "./insert";
import {
    copyTarget,
    layoutRows,
    layoutTitle,
    type MasterLayout,
    type MasterOverlay,
    type MasterTree,
    origin,
    plural,
    usage,
} from "./mastertree";
import { edit, request } from "./net";
import { openButton } from "./openwith";
import { loadPlaceholders, placeholderDialog } from "./placeholders";
import { closeMenu, menuItem, showMenu } from "./sorter";
import { ed, emit, on } from "./state";
import type { SlideModel } from "./types";

const aside = document.getElementById("master")!;
const button = document.getElementById("btn-layout")!;
const menu = document.getElementById("context-menu")!;

interface Item {
    kind: "layout" | "overlay";
    name: string;
    path: string;
}

let tree: MasterTree | null = null;
let item: Item | null = null;
let onSlide: number | null = null;
let thumbs = new Map<string, string>();
// Edits made since the master was opened: leaving it refreshes the
// Inkscape previews of the deck's files once (`master` op `previews`).
let dirty = false;
let loading = 0;

// ── Opening and closing ──

export function masterOpen(): boolean {
    return ed.masterMode;
}

export async function openMaster(want?: Partial<Item>): Promise<void> {
    if (!ed.model) return;
    if (!ed.masterMode) {
        ed.masterMode = true;
        ed.layoutMode = true;
        dirty = false;
        document.body.classList.add("master-mode", "layout-mode");
        button.classList.add("on");
        setTool("select");
    }
    enterGroup(null);
    clearSelection();
    await loadTree();
    void loadThumbs();
    const start = want?.name ? find(want) : initialItem();
    if (start) await show(start);
    else renderList();
}

export async function closeMaster(): Promise<void> {
    if (!ed.masterMode) return;
    ed.masterMode = false;
    ed.layoutMode = false;
    ed.master = null;
    item = null;
    onSlide = null;
    document.body.classList.remove("master-mode", "layout-mode");
    button.classList.remove("on");
    enterGroup(null);
    clearSelection();
    render();
    emit("slide");
    emit("layout-mode");
    if (dirty) {
        dirty = false;
        // Part of the last edit's step: Undo takes back what was seen.
        await edit({ action: "master", op: "previews", attach: true });
    }
}

function toggle(): void {
    if (ed.masterMode) void closeMaster();
    else void openMaster();
}

// The layout the slide being edited is built on, else the background.
function initialItem(): Item | null {
    if (!tree) return null;
    const mine = tree.layouts.find((l) => l.slides.includes(ed.current));
    const chosen =
        mine ?? tree.layouts.find((l) => l.name === tree?.background);
    return chosen
        ? { kind: "layout", name: chosen.name, path: chosen.path }
        : null;
}

function find(want: Partial<Item>): Item | null {
    if (!tree) return null;
    if (want.kind === "overlay") {
        const o = tree.overlays.find((x) => x.name === want.name && x.path);
        return o?.path ? { kind: "overlay", name: o.name, path: o.path } : null;
    }
    const l = tree.layouts.find((x) => x.name === want.name);
    return l ? { kind: "layout", name: l.name, path: l.path } : null;
}

async function loadTree(): Promise<void> {
    const result = await request({ action: "master-tree" });
    if (result.ok) tree = result.master as MasterTree;
}

async function loadThumbs(): Promise<void> {
    const result = await request({ action: "layout-previews", all: true });
    if (!result.ok) return;
    const list = result.layouts as { name: string; svg: string }[];
    thumbs = new Map(list.map((p) => [p.name, p.svg]));
    if (ed.masterMode) renderList();
}

// ── Showing one layout or overlay ──

function withTarget(slide: SlideModel, path: string, kind: Item["kind"]) {
    const root = ed.model?.projectDir ?? "";
    for (const src of slide.sources ?? []) {
        if (src.path !== path) continue;
        const to = copyTarget(src.path, root, kind);
        if (to && !src.writable) src.copyTo = to;
        src.writable = true;
    }
    return slide;
}

async function show(next: Item, slideIndex = onSlide): Promise<void> {
    const ticket = ++loading;
    const changed = item?.path !== next.path || item?.kind !== next.kind;
    item = next;
    onSlide = slideIndex;
    // Its placeholders for the props panel, fetched alongside.
    const listing = loadPlaceholders(next.kind, next.path);
    let view: { slide: SlideModel; data: SlideData } | null = null;
    if (slideIndex != null) {
        const real = ed.model?.slides[slideIndex];
        const data =
            real?.visibleIndex != null ? ed.slides[real.visibleIndex] : null;
        if (real && data) {
            view = {
                slide: withTarget(structuredClone(real), next.path, next.kind),
                data,
            };
        } else {
            onSlide = null;
        }
    }
    if (!view) {
        const result = await request({
            action: "master-render",
            kind: next.kind,
            path: next.path,
        });
        if (ticket !== loading || !ed.masterMode) return;
        if (!result.ok) {
            toast(result.error ?? "could not draw it", "error");
            renderList();
            return;
        }
        view = {
            slide: withTarget(
                result.entry as SlideModel,
                result.target as string,
                next.kind,
            ),
            data: result.slide as SlideData,
        };
    }
    const placeholders = (await listing) ?? undefined;
    if (ticket !== loading || !ed.masterMode) return;
    ed.master = {
        kind: next.kind,
        name: next.name,
        path: next.path,
        onSlide,
        placeholders,
        ...view,
    };
    if (changed) {
        enterGroup(null);
        clearSelection();
    }
    render();
    renderList();
}

// After a rebuild: the list again, and the item drawn as it now is (its
// path changes when the deck got its own copy of it).
async function refresh(): Promise<void> {
    if (!ed.masterMode) return;
    await loadTree();
    void loadThumbs();
    const again = item ? find(item) : null;
    const next = again ?? initialItem();
    if (next) await show(next);
    else renderList();
}

// Objects of other files (the layouts behind, the overlays on top) are
// context: drawn faded, never picked.
function fadeContext(): void {
    const svg = slideRoot();
    if (!svg || !ed.master) return;
    const sources = ed.master.slide.sources ?? [];
    for (const el of svg.querySelectorAll("[data-ink-top]")) {
        const src = sources[keyOf(el)];
        el.classList.toggle(
            "master-context",
            !!src && src.path !== ed.master.path,
        );
    }
}

// ── The list ──

function thumb(name: string | null): HTMLElement {
    const box = h("div", { class: "master-thumb" });
    const svg = name ? thumbs.get(name) : undefined;
    if (svg) {
        box.innerHTML = svg;
        const el = box.querySelector("svg");
        el?.setAttribute("width", "100%");
        el?.setAttribute("height", "100%");
        el?.querySelectorAll(".anim-pending").forEach((x) => {
            x.classList.remove("anim-pending");
        });
        if (el) scheduleFit(el);
    }
    return box;
}

function badge(of: MasterLayout | MasterOverlay): HTMLElement {
    const o = origin(of);
    return h(
        "span",
        { class: `master-badge ${o.kind}`, title: o.title },
        o.text,
    );
}

function current(kind: Item["kind"], path: string | null): boolean {
    return !!item && item.kind === kind && item.path === path;
}

function row(
    kind: Item["kind"],
    entry: MasterLayout | MasterOverlay,
    title: string,
    sub: string,
    depth: number,
    thumbName: string | null,
): HTMLElement {
    const path = entry.path;
    const el = h(
        "div",
        {
            class: `master-row${current(kind, path) ? " active" : ""}`,
            style: `--depth:${depth}`,
            role: "button",
            tabindex: "0",
            title: entry.rel ?? entry.name,
            "data-name": entry.name,
            "data-kind": kind,
        },
        kind === "layout"
            ? thumb(thumbName)
            : h("div", { class: "master-thumb overlay-thumb" }, "On top"),
        h(
            "div",
            { class: "master-text" },
            h("div", { class: "master-title" }, title),
            h("div", { class: "master-sub" }, sub, " ", badge(entry)),
        ),
        h(
            "button",
            {
                type: "button",
                class: "master-more",
                title: "More: copy, revert, rename, delete",
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    rowMenu(kind, entry, e.clientX, e.clientY);
                },
            },
            "⋯",
        ),
    );
    const open = () => {
        if (path) void show({ kind, name: entry.name, path }, null);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
        }
    });
    el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        rowMenu(kind, entry, e.clientX, e.clientY);
    });
    return el;
}

function title(l: MasterLayout): string {
    return layoutTitle(l, { [l.name]: layoutLabel(l.name) });
}

function total(): number {
    return ed.model?.slides.length ?? 0;
}

function slideName(i: number): string {
    const s = ed.model?.slides[i];
    if (!s) return `slide ${i + 1}`;
    const n =
        s.visibleIndex != null ? `Slide ${s.visibleIndex + 1}` : "Hidden slide";
    return s.title ? `${n}: ${s.title}` : n;
}

export function renderList(): void {
    clear(aside);
    aside.append(
        h(
            "div",
            { class: "master-head" },
            h("strong", {}, "Slide master"),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "Back to the slides",
                    onclick: () => void closeMaster(),
                },
                "Close",
            ),
        ),
    );
    if (!tree) {
        aside.append(h("p", { class: "hint" }, "Loading…"));
        return;
    }
    const list = h("div", { class: "master-list" });
    list.append(h("div", { class: "master-group" }, "All slides"));
    const background = tree.layouts.find((l) => l.name === tree?.background);
    if (background) {
        list.append(
            row(
                "layout",
                background,
                "Background",
                `${background.name} · ${usage(background, true, total())}`,
                0,
                background.name,
            ),
        );
    }
    const onTop = tree.overlays.filter((o) => o.deck);
    for (const o of onTop) {
        list.append(
            row(
                "overlay",
                o,
                `On top · ${o.name}`,
                tree.overlaysFromTheme
                    ? "from the theme"
                    : plural(o.slides.length, "slide"),
                0,
                null,
            ),
        );
    }
    list.append(
        h(
            "button",
            {
                type: "button",
                class: "master-add",
                title: "An overlay: drawn on top of every slide, whatever its layout (a logo, footer text)",
                onclick: () => newOverlay(),
            },
            onTop.length
                ? "+ Another overlay"
                : "+ New overlay (logo, footer…)",
        ),
    );
    for (const o of tree.overlays.filter((x) => !x.deck)) {
        const sub = o.slides.length
            ? `on ${plural(o.slides.length, "slide")} of their own`
            : "not used";
        list.append(row("overlay", o, o.name, sub, 0, null));
    }
    for (const over of tree.overrides) {
        list.append(
            h(
                "div",
                { class: "master-note" },
                `${slideName(over.slide)} has its own overlays: ${over.overlays.join(", ") || "none"}`,
            ),
        );
    }
    list.append(h("div", { class: "master-group" }, "Layouts"));
    for (const r of layoutRows(tree)) {
        list.append(
            row(
                "layout",
                r.layout,
                title(r.layout),
                `${r.layout.name === title(r.layout) ? "" : `${r.layout.name} · `}${usage(r.layout, false)}`,
                r.depth,
                r.layout.name,
            ),
        );
    }
    aside.append(list);
    aside
        .querySelector(".master-row.active")
        ?.scrollIntoView({ block: "nearest" });
}

// ── Actions ──

function layoutOf(name: string): MasterLayout | null {
    return tree?.layouts.find((l) => l.name === name) ?? null;
}

function rowMenu(
    kind: Item["kind"],
    entry: MasterLayout | MasterOverlay,
    x: number,
    y: number,
): void {
    clear(menu);
    const theme = !entry.copyOf && entry.source !== "local";
    const editable = !!ed.model?.deckEditable;
    if (theme) {
        menu.append(
            menuItem(
                "Make this deck's own copy",
                () => void copyIn(kind, entry.name),
            ),
        );
    }
    if (entry.copyOf) {
        menu.append(
            menuItem(
                `Revert to the theme's ${kind}`,
                () => void revert(kind, entry.name),
            ),
        );
    }
    if (kind === "layout" && entry.source === "local" && !entry.copyOf) {
        menu.append(
            menuItem(
                "Rename…",
                () => renameLayout(entry as MasterLayout),
                !editable,
            ),
            menuItem(
                "Delete…",
                () => deleteLayout(entry as MasterLayout),
                !editable,
            ),
        );
    }
    if (!menu.childElementCount) {
        menu.append(menuItem("Nothing to change here", () => {}, true));
    }
    showMenu(x, y);
}

async function copyIn(kind: Item["kind"], name: string): Promise<void> {
    const result = await edit({
        action: "master",
        op: "copy",
        kind,
        name,
    });
    if (result.ok) {
        const info = result.copied as { note: string } | undefined;
        if (info) toast(info.note);
        dirty = false; // the step brought the previews up to date itself
    }
}

async function revert(kind: Item["kind"], name: string): Promise<void> {
    const what = kind === "layout" ? `layout “${name}”` : `overlay “${name}”`;
    if (
        !window.confirm(
            `Delete this deck's copy of the ${what}? Slides on it go back to the theme's ${kind}, and your changes to it are gone (Undo brings them back).`,
        )
    ) {
        return;
    }
    const result = await edit({ action: "master", op: "revert", kind, name });
    if (result.ok) toast(`Back to the theme's ${what}`);
}

function nameDialog(
    heading: string,
    label: string,
    value: string,
    extra: Node | null,
    run: (name: string) => Promise<boolean>,
): void {
    const input = h("input", {
        type: "text",
        class: "master-name",
        value,
        spellcheck: "false",
    }) as HTMLInputElement;
    const ok = h("button", { type: "submit", class: "pbtn primary" }, "OK");
    const form = h(
        "form",
        { class: "master-form" },
        h("label", {}, label, input),
        extra,
        h(
            "div",
            { class: "dialog-actions" },
            h(
                "button",
                { type: "button", class: "pbtn", onclick: () => closeDialog() },
                "Cancel",
            ),
            ok,
        ),
    );
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        (ok as HTMLButtonElement).disabled = true;
        void run(name).then((done) => {
            if (done) closeDialog();
            else (ok as HTMLButtonElement).disabled = false;
        });
    });
    openDialog(heading, form);
    input.focus();
    input.select();
}

function newOverlay(): void {
    const every = h(
        "p",
        { class: "hint" },
        "An overlay is drawn on top of every slide, whatever its layout: put a logo, footer text or a badge in it. It is overlays/<name>.svg, added to Deck(overlays=[…]).",
    );
    nameDialog("New overlay", "Name", "logo", every, async (name) => {
        const result = await edit({
            action: "master",
            op: "new-overlay",
            name,
        });
        if (!result.ok) return false;
        const made = result.overlay as { name: string; path: string };
        pendingItem = { kind: "overlay", name: made.name };
        toast(`Overlay “${made.name}” is on every slide: draw into it here`);
        return true;
    });
}

function renameLayout(l: MasterLayout): void {
    nameDialog(
        `Rename “${title(l)}”`,
        "New name",
        title(l),
        h(
            "p",
            { class: "hint" },
            "Slides and layouts built on it follow the new name.",
        ),
        async (name) => {
            const result = await edit({
                action: "master",
                op: "rename",
                name: l.name,
                to: name,
            });
            if (result.ok && typeof result.layout === "string") {
                pendingItem = { kind: "layout", name: result.layout };
            }
            return result.ok;
        },
    );
}

function deleteLayout(l: MasterLayout): void {
    const users = l.slides.length;
    const children = (tree?.layouts ?? []).filter((x) => x.parent === l.name);
    const others = (tree?.layouts ?? []).filter(
        (x) => x.name !== l.name && !children.includes(x),
    );
    const pickTo = h(
        "select",
        { class: "master-move" },
        ...others.map((x) =>
            h("option", { value: x.name }, `${title(x)} (${x.name})`),
        ),
    ) as HTMLSelectElement;
    pickTo.value =
        l.parent && others.some((x) => x.name === l.parent)
            ? l.parent
            : (others[0]?.name ?? "");
    const used = users > 0 || children.length > 0;
    const body = h(
        "div",
        { class: "master-form" },
        h(
            "p",
            {},
            used
                ? `${[users ? plural(users, "slide") : "", children.length ? `layout ${children.map((c) => `“${c.name}”`).join(", ")}` : ""].filter(Boolean).join(" and ")} ${users + children.length === 1 ? "is" : "are"} built on “${title(l)}”. Move ${users + children.length === 1 ? "it" : "them"} to:`
                : `Delete the layout “${title(l)}” (${l.rel ?? l.name})? No slide uses it.`,
        ),
        used ? pickTo : null,
        h(
            "div",
            { class: "dialog-actions" },
            h(
                "button",
                { type: "button", class: "pbtn", onclick: () => closeDialog() },
                "Cancel",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn danger",
                    onclick: async () => {
                        const result = await edit({
                            action: "master",
                            op: "delete",
                            name: l.name,
                            ...(used ? { moveTo: pickTo.value } : {}),
                        });
                        if (!result.ok) return;
                        closeDialog();
                        if (item?.name === l.name) {
                            pendingItem = {
                                kind: "layout",
                                name: used ? pickTo.value : (l.parent ?? ""),
                            };
                        }
                    },
                },
                used ? "Move and delete" : "Delete",
            ),
        ),
    );
    openDialog(`Delete layout “${title(l)}”`, body);
}

// What the props panel shows while nothing is selected in the master.
export function masterPanel(): HTMLElement | null {
    if (!ed.master || !item || !tree) return null;
    const view = ed.master;
    const kind = item.kind;
    const layout = kind === "layout" ? layoutOf(item.name) : null;
    const overlay =
        kind === "overlay"
            ? (tree.overlays.find((o) => o.name === item?.name) ?? null)
            : null;
    const entry = layout ?? overlay;
    if (!entry) return null;
    const o = origin(entry);
    const isBackground = layout?.name === tree.background;
    const heading = isBackground
        ? "Background (every slide)"
        : layout
          ? `Layout: ${title(layout)}`
          : `On top: ${item.name}`;
    const explain = {
        theme:
            kind === "layout"
                ? `From the theme. Your first edit gives this deck its own copy (layouts/${item.name}.svg), which ${isBackground ? "every slide" : "every slide on it"} then follows.`
                : `From the theme. Your first edit gives this deck its own copy (overlays/${item.name}.svg).`,
        copy: `This deck's own copy of ${entry.copyOf}: ${isBackground ? "every slide" : "the slides on it"} follow your copy, not the theme's.`,
        own:
            kind === "overlay"
                ? "Drawn on top of every slide that gets it, whatever the slide's layout."
                : "A layout of this deck's own.",
    }[o.kind];
    const reach = layout ? layout.reach : (overlay?.slides ?? []);
    const shown = h(
        "select",
        { title: "See the layout with a slide's own content" },
        h(
            "option",
            { value: "" },
            kind === "layout"
                ? "Alone, with sample text"
                : "Over the background",
        ),
        ...reach.map((i) => h("option", { value: String(i) }, slideName(i))),
    ) as HTMLSelectElement;
    shown.value = view.onSlide != null ? String(view.onSlide) : "";
    shown.addEventListener("change", () => {
        const v = shown.value;
        if (item) void show(item, v === "" ? null : Number(v));
    });
    const actions: Node[] = [];
    if (o.kind === "theme") {
        actions.push(
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => void copyIn(kind, entry.name),
                },
                "Make this deck's copy",
            ),
        );
    }
    if (o.kind === "copy") {
        actions.push(
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => void revert(kind, entry.name),
                },
                `Revert to the theme's ${kind}`,
            ),
        );
    }
    if (layout && o.kind === "own") {
        actions.push(
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => renameLayout(layout),
                },
                "Rename…",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => deleteLayout(layout),
                },
                "Delete…",
            ),
        );
    }
    const opener = entry.source === "local" ? openButton(view.path) : null;
    if (opener) actions.push(opener);
    return h(
        "div",
        { class: "master-panel" },
        h("h3", {}, heading),
        h("p", { class: "hint" }, explain),
        h(
            "p",
            { class: "hint" },
            kind === "layout"
                ? usage(layout as MasterLayout, isBackground, total())
                : `${plural(reach.length, "slide")} get${reach.length === 1 ? "s" : ""} it`,
        ),
        h(
            "label",
            { class: "prop-row" },
            h("span", { class: "prop-label" }, "Show"),
            shown,
        ),
        h(
            "div",
            { class: "master-actions" },
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "An empty text zone each slide fills with its own text",
                    onclick: () => placeholderDialog("text"),
                },
                "+ Text placeholder",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "An empty zone each slide fills with a picture or video",
                    onclick: () => placeholderDialog("picture"),
                },
                "+ Picture placeholder",
            ),
        ),
        h(
            "p",
            { class: "hint" },
            "Draw shapes, text and pictures with the toolbar: they go into this file.",
        ),
        actions.length
            ? h("div", { class: "master-actions" }, ...actions)
            : null,
    );
}

// ── Save a slide as a layout ──

export function saveAsLayout(index = ed.current): void {
    const slide = ed.model?.slides[index];
    if (!slide) return;
    if (!ed.model?.deckEditable) {
        toast(
            "deck.py builds its slides in code; save the layout there",
            "error",
        );
        return;
    }
    const hints = h("input", {
        type: "checkbox",
        checked: true,
    }) as HTMLInputElement;
    const pictures = h("input", { type: "checkbox" }) as HTMLInputElement;
    const extra = h(
        "div",
        {},
        h(
            "label",
            { class: "check" },
            hints,
            "Keep the slide's text as placeholder prompts",
        ),
        h(
            "label",
            { class: "check" },
            pictures,
            "Turn its pictures into picture placeholders",
        ),
        h(
            "p",
            { class: "hint" },
            "The slide's drawing and the layout it is built on carry over; its text zones stay, empty. New slides can then start from it.",
        ),
    );
    nameDialog(
        `Save ${slideName(index)} as a layout`,
        "Layout name",
        "",
        extra,
        async (name) => {
            const result = await edit({
                action: "master",
                op: "save",
                slide: index,
                name,
                hints: hints.checked,
                pictures: pictures.checked,
            });
            if (!result.ok) return false;
            toast(
                `Saved as the layout “${name}”: “New slide” offers it now`,
                "ok",
            );
            return true;
        },
    );
}

// ── Wiring ──

let pendingItem: Partial<Item> | null = null;

export function initMaster(): void {
    button.addEventListener("click", toggle);
    on("model", () => {
        if (!ed.masterMode) return;
        if (pendingItem) {
            const want = pendingItem;
            pendingItem = null;
            void loadTree().then(() => {
                const next = find(want);
                void loadThumbs();
                if (next) void show(next, null);
                else void refresh();
            });
            return;
        }
        void refresh();
    });
    on("render", fadeContext);
    on("history", () => {
        if (ed.masterMode && ed.canUndo) dirty = true;
    });
    on("master-copied", renderList);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menu.classList.contains("open")) closeMenu();
    });
}
