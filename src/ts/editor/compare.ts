// The compare view: two versions of the deck side by side, the slides that
// differ highlighted. The server builds both (editor/comparehub.py) and sends
// a "compare-model" whenever either side rebuilds; this page only shows it.
//
// Each slide is drawn in a shadow root with its own deck's stylesheet (made
// once per side as a constructed sheet), so another theme or styles.css never
// reaches the editor and the editor's never reaches it. Entry points: the Git
// menu's "Compare…" picker, a history row's "Compare", the
// `inkflow:compare` event (the worktrees list) and `?compare=REV|PATH`
// (`inkflow edit --compare`). Editing stays off while it is open, except
// "Take this slide" (one undoable step) and undo/redo.

import { parseViewBox } from "../shared/viewbox";
import {
    type Box,
    badge,
    type CmpSlide,
    type CompareModel,
    counts,
    countText,
    firstRow,
    followRow,
    isChange,
    type Loc,
    mergeBranch,
    mergeTarget,
    newFontRules,
    nextChange,
    type PairModel,
    rowNumber,
    rowSlide,
    type SideModel,
    type Source,
    swapSources,
    takeState,
    toSlideBox,
    visibleRows,
    whatChanged,
    wordDiff,
} from "./comparelib";
import { closeDialog, dialogOpen, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { folderPicker } from "./folderpicker";
import { UNDO_NOTICE, undoNoticeDue, undoNoticeShown } from "./gitnotice";
import {
    edit,
    onConnect,
    onMessage,
    request,
    sendRaw,
    whenConnected,
} from "./net";
import { joinPath } from "./pathtext";
import { ed, emit } from "./state";

type Mode = "side" | "slider" | "diff";

const view = document.getElementById("compare-view")!;
let model: CompareModel | null = null;
let viewId = 0;
let open: [Source, Source] | null = null;
let row = 0;
let onlyChanges = readPref("inkflow-compare-only", "0") === "1";
let mode: Mode = (readPref("inkflow-compare-mode", "side") as Mode) || "side";
let outlines = readPref("inkflow-compare-outlines", "1") === "1";
let wipe = 50;
let error: string | null = null;

function readPref(key: string, fallback: string): string {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function writePref(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // not remembered
    }
}

export function compareOpen(): boolean {
    return !view.hidden;
}

/** Compare two sides (usually the working copy and something else). */
export function openCompare(left: Source, right: Source): void {
    viewId += 1;
    open = [left, right];
    error = null;
    if (!model) {
        view.hidden = false;
        document.body.classList.add("compare-mode");
        renderLoading("Building both versions…");
    } else {
        view.classList.add("busy");
    }
    view.focus();
    void whenConnected().then(() =>
        sendRaw({ type: "compare-open", view: viewId, left, right }),
    );
}

export function closeCompare(): void {
    if (view.hidden) return;
    sendRaw({ type: "compare-close" });
    model = null;
    open = null;
    view.hidden = true;
    view.classList.remove("busy");
    clear(view);
    document.body.classList.remove("compare-mode");
    document.getElementById("cmp-fonts")?.remove();
    emit("slide");
}

function renderLoading(text: string): void {
    clear(view);
    view.append(
        h(
            "div",
            { class: "cmp-head" },
            h("strong", { class: "cmp-title" }, "Compare"),
            h("span", { class: "cmp-spacer" }),
            closeButton(),
        ),
        h("div", { class: "cmp-loading" }, text),
    );
}

function closeButton(): HTMLElement {
    return h(
        "button",
        {
            type: "button",
            class: "pbtn",
            title: "Back to editing (Esc)",
            onclick: () => closeCompare(),
        },
        "Close",
    );
}

// ── Slides in shadow roots ──

const BASE_CSS = `
:host { display: block; position: relative; }
.cmp-root {
    all: initial;
    display: block;
    width: 100%;
    height: 100%;
    /* A slide's text that names no font: the deck's body font, as on a slide. */
    font-family: var(--inkflow-body-font);
}
.cmp-root > svg { display: block; width: 100%; height: 100%; }
`;
let baseSheet: CSSStyleSheet | null = null;
const sideSheets = new Map<string, { css: string; sheet: CSSStyleSheet }>();

function sheets(side: SideModel): CSSStyleSheet[] {
    if (!baseSheet) {
        baseSheet = new CSSStyleSheet();
        baseSheet.replaceSync(BASE_CSS);
    }
    let entry = sideSheets.get(side.token);
    if (!entry || entry.css !== side.css) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(side.css);
        entry = { css: side.css, sheet };
        sideSheets.set(side.token, entry);
    }
    return [baseSheet, entry.sheet];
}

function addFonts(side: SideModel): void {
    if (!side.fonts) return;
    let style = document.getElementById("cmp-fonts");
    if (!style) {
        style = h("style", { id: "cmp-fonts" });
        document.head.append(style);
    }
    const present =
        (document.getElementById("deck-styles")?.textContent ?? "") +
        style.textContent;
    const rules = newFontRules(side.fonts, present);
    if (rules) style.textContent += `\n${rules}`;
}

/** One slide, drawn with its own deck's styles; its `<svg>` is `.svg`. */
function slideView(
    side: SideModel,
    slide: CmpSlide | null,
    cls: string,
): HTMLElement & { svg?: SVGSVGElement } {
    const host: HTMLElement & { svg?: SVGSVGElement } = h("div", {
        class: `cmp-slide ${cls}`,
    });
    if (!slide?.svg) {
        host.classList.add("empty");
        host.textContent = slide
            ? "hidden slide"
            : `not in ${side.label || "this version"}`;
        return host;
    }
    const root = host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = sheets(side);
    const wrap = document.createElement("div");
    wrap.className = "cmp-root";
    // Both sides in the colour mode the editor shows (its light/dark
    // button); a deck whose own mode differs says so in the deck line.
    if (document.documentElement.dataset.theme === "light") {
        wrap.dataset.theme = "light";
    }
    wrap.innerHTML = slide.svg;
    const svg = wrap.querySelector("svg");
    if (svg) {
        const vb = parseViewBox(svg.getAttribute("viewBox"));
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        host.style.aspectRatio = `${vb.w} / ${vb.h}`;
        // The final state, as the slide list shows it.
        svg.querySelectorAll(".anim-pending").forEach((el) => {
            el.classList.remove("anim-pending");
        });
        svg.querySelectorAll("video").forEach((v) => {
            v.removeAttribute("autoplay");
            v.removeAttribute("controls");
        });
        host.svg = svg;
    }
    root.append(wrap);
    return host;
}

// Thumbnails keyed by side and SVG: a rebuild redraws only what changed.
const thumbs = new Map<string, HTMLElement>();

function thumb(side: SideModel, index: number | null): HTMLElement {
    const slide = index != null ? (side.slides[index] ?? null) : null;
    if (!slide) return h("div", { class: "cmp-thumb none" });
    const key = `${side.token}\0${slide.svg ?? `hidden:${slide.id}`}`;
    const cached = thumbs.get(key);
    if (cached && !cached.isConnected) return cached;
    const el = slideView(side, slide, "cmp-thumb");
    thumbs.set(key, el);
    return el;
}

// ── The model ──

function onModel(msg: Record<string, unknown>): void {
    if (msg.view !== viewId || view.hidden) return;
    const next = msg as unknown as CompareModel;
    const before = model;
    row = before ? followRow(before, row, next) : firstRow(next.pairs);
    model = next;
    view.classList.remove("busy");
    // Thumbnails of sides no longer shown go.
    const tokens = new Set([next.left.token, next.right.token]);
    for (const key of [...thumbs.keys()]) {
        if (!tokens.has(key.split("\0")[0])) thumbs.delete(key);
    }
    addFonts(next.left);
    addFonts(next.right);
    render();
}

function onError(msg: Record<string, unknown>): void {
    if (msg.for !== "compare-open" || msg.view !== viewId) return;
    error = String(msg.message ?? "could not compare");
    view.classList.remove("busy");
    if (!model) {
        renderLoading(`Cannot compare: ${error}`);
        view.querySelector(".cmp-loading")?.classList.add("error");
    } else {
        toast(`Cannot compare: ${error}`, "error");
    }
}

// ── Drawing ──

let listEl: HTMLElement | null = null;
let mainEl: HTMLElement | null = null;

function render(): void {
    if (!model) return;
    const m = model;
    clear(view);
    const c = counts(m.pairs);
    const merge = mergeTarget(m);
    const only = h("input", { type: "checkbox" }) as HTMLInputElement;
    only.checked = onlyChanges;
    only.addEventListener("change", () => {
        onlyChanges = only.checked;
        writePref("inkflow-compare-only", onlyChanges ? "1" : "0");
        renderList();
    });
    const head = h(
        "div",
        { class: "cmp-head" },
        h("strong", { class: "cmp-title" }, "Compare"),
        sideChip(m.left, "left"),
        h(
            "button",
            {
                type: "button",
                class: "tb-btn cmp-swap",
                title: "Swap the two sides",
                onclick: () => {
                    const [l, r] = swapSources(m);
                    openCompare(l, r);
                },
            },
            "⇄",
        ),
        sideChip(m.right, "right"),
        h("span", { class: "cmp-counts" }, countText(c)),
        m.deck.length
            ? h(
                  "span",
                  {
                      class: "cmp-deckdiff",
                      title: "Deck-wide settings that differ",
                  },
                  `Deck: ${m.deck.map((s) => s.replace(/_/g, " ")).join(", ")}`,
              )
            : null,
        h("span", { class: "cmp-spacer" }),
        h("label", { class: "cmp-only" }, only, "Only changes"),
        h(
            "button",
            {
                type: "button",
                class: "tb-btn",
                title: "Previous change (P)",
                onclick: () => jump(-1),
            },
            "↑",
        ),
        h(
            "button",
            {
                type: "button",
                class: "tb-btn",
                title: "Next change (N)",
                onclick: () => jump(1),
            },
            "↓",
        ),
        merge
            ? h(
                  "button",
                  {
                      type: "button",
                      class: "pbtn",
                      title: `Merge ${merge} into the working copy's branch`,
                      onclick: () => void merging(merge),
                  },
                  "Merge branch",
              )
            : null,
        closeButton(),
    );
    listEl = h("div", { class: "cmp-list", role: "listbox" });
    mainEl = h("div", { class: "cmp-main" });
    view.append(head, h("div", { class: "cmp-body" }, listEl, mainEl));
    renderList();
    renderMain();
}

function sideChip(side: SideModel, which: string): HTMLElement {
    const kind =
        side.kind === "live"
            ? "working copy"
            : side.kind === "commit"
              ? "commit"
              : "folder";
    const notes = [
        side.error ? `does not build: ${side.error}` : "",
        side.missing.length
            ? `${side.missing.length} Git LFS file(s) missing`
            : "",
    ].filter(Boolean);
    return h(
        "button",
        {
            type: "button",
            class: `cmp-chip ${which}${side.error ? " error" : ""}`,
            title: [
                side.deckPath,
                ...notes,
                "Click to show something else on this side",
            ].join("\n"),
            onclick: () => void openComparePicker(which as "left" | "right"),
        },
        h("span", { class: "cmp-chip-kind" }, which === "left" ? "L" : "R"),
        side.label,
        side.kind !== "live" && side.kind !== "commit"
            ? h("span", { class: "hint" }, ` (${kind})`)
            : null,
        notes.length ? h("span", { class: "cmp-warn" }, " ⚠") : null,
    );
}

function renderList(): void {
    if (!model || !listEl) return;
    const m = model;
    clear(listEl);
    const rows = visibleRows(m.pairs, onlyChanges);
    const broken = [m.left, m.right].filter((s) => s.error);
    for (const s of broken) {
        listEl.append(
            h(
                "div",
                { class: "cmp-empty error" },
                `${s.label} does not build: ${s.error}`,
            ),
        );
    }
    if (!rows.length && !broken.length) {
        listEl.append(h("div", { class: "cmp-empty" }, "No differences"));
    }
    for (const i of rows) {
        const p = m.pairs[i];
        const b = badge(p);
        const slide = rowSlide(m, p);
        listEl.append(
            h(
                "div",
                {
                    class: `cmp-row s-${b.cls.replace(/ /g, " s-")}${i === row ? " active" : ""}`,
                    role: "option",
                    "data-row": i,
                    title: `${b.title}${p.status === "changed" ? `: ${whatChanged(p).join(", ")}` : ""}`,
                    onclick: () => selectRow(i),
                },
                h(
                    "div",
                    { class: "cmp-row-head" },
                    h("span", { class: "cmp-num" }, rowNumber(m, p)),
                    h("span", { class: "cmp-id" }, slide?.id ?? ""),
                    b.symbol
                        ? h("span", { class: `cmp-badge ${b.cls}` }, b.symbol)
                        : null,
                ),
                h(
                    "div",
                    { class: "cmp-row-thumbs" },
                    thumb(m.left, p.left),
                    thumb(m.right, p.right),
                ),
            ),
        );
    }
    revealRow();
}

/** Scroll the list (only the list: scrollIntoView would also scroll the
 * page sideways when the toolbar is wider than the window). */
function revealRow(): void {
    const el = listEl?.querySelector<HTMLElement>(".cmp-row.active");
    if (!listEl || !el) return;
    const top = el.offsetTop; // the list is the offset parent
    if (top < listEl.scrollTop) listEl.scrollTop = top - 8;
    else if (top + el.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
        listEl.scrollTop = top + el.offsetHeight - listEl.clientHeight + 8;
    }
}

function selectRow(i: number): void {
    if (!model || i < 0 || i >= model.pairs.length) return;
    row = i;
    listEl?.querySelectorAll(".cmp-row").forEach((el) => {
        el.classList.toggle(
            "active",
            Number(el.getAttribute("data-row")) === i,
        );
    });
    revealRow();
    renderMain();
}

function jump(dir: 1 | -1): void {
    if (!model) return;
    const next = nextChange(model.pairs, row, dir);
    if (next == null) {
        toast(dir > 0 ? "No more changes below" : "No more changes above");
        return;
    }
    if (onlyChanges || isChange(model.pairs[next])) selectRow(next);
}

function step(dir: 1 | -1): void {
    if (!model) return;
    const rows = visibleRows(model.pairs, onlyChanges);
    const at = rows.indexOf(row);
    const next =
        rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + dir))];
    if (next != null) selectRow(next);
}

// ── The selected pair ──

function renderMain(): void {
    if (!model || !mainEl) return;
    const m = model;
    clear(mainEl);
    const p = m.pairs[row];
    if (!p) {
        mainEl.append(h("div", { class: "cmp-empty" }, "Nothing to compare"));
        return;
    }
    const left = p.left != null ? (m.left.slides[p.left] ?? null) : null;
    const right = p.right != null ? (m.right.slides[p.right] ?? null) : null;
    const modes = h(
        "div",
        { class: "cmp-modes", role: "tablist" },
        ...(
            [
                ["side", "Side by side", "1"],
                ["slider", "Slider", "2"],
                ["diff", "Difference", "3"],
            ] as const
        ).map(([id, label, key]) =>
            h(
                "button",
                {
                    type: "button",
                    class: `seg${mode === id ? " on" : ""}`,
                    title: `${label} (${key})`,
                    onclick: () => setMode(id),
                },
                label,
            ),
        ),
    );
    const outlineBox = h("input", { type: "checkbox" }) as HTMLInputElement;
    outlineBox.checked = outlines;
    outlineBox.addEventListener("change", () => {
        outlines = outlineBox.checked;
        writePref("inkflow-compare-outlines", outlines ? "1" : "0");
        renderMain();
    });
    const bar = h(
        "div",
        { class: "cmp-stagebar" },
        modes,
        h(
            "label",
            { class: "cmp-only", title: "Outline what changed (O)" },
            outlineBox,
            "Outline changes",
        ),
        h("span", { class: "cmp-spacer" }),
        h(
            "span",
            { class: "cmp-legend" },
            h("i", { class: "lg changed" }),
            "changed ",
            h("i", { class: "lg added" }),
            "added ",
            h("i", { class: "lg removed" }),
            "removed",
        ),
    );
    const stage = h("div", { class: `cmp-stage mode-${mode}` });
    const both = left?.svg && right?.svg;
    if (mode === "side" || !both) {
        stage.classList.add("mode-side");
        stage.append(
            pane(m.left, left, p, "left", rowNumberOf(left)),
            pane(m.right, right, p, "right", rowNumberOf(right)),
        );
    } else {
        stage.append(stacked(m, left, right, p));
    }
    mainEl.append(bar, stage, info(m, p, left, right));
}

function rowNumberOf(s: CmpSlide | null): string {
    if (!s) return "";
    return `${s.number != null ? `${s.number} · ` : "hidden · "}${s.id}`;
}

function setMode(next: Mode): void {
    mode = next;
    writePref("inkflow-compare-mode", mode);
    renderMain();
}

function pane(
    side: SideModel,
    slide: CmpSlide | null,
    p: PairModel,
    which: "left" | "right",
    caption: string,
): HTMLElement {
    const frame = h("div", { class: "cmp-frame" });
    const sv = slideView(side, slide, "cmp-big");
    frame.append(sv);
    if (outlines && sv.svg) {
        const marks = p.elements.filter((e) =>
            which === "left" ? e.left : e.right,
        );
        afterLayout(() => drawOutlines(frame, sv.svg!, marks, which));
    }
    return h(
        "div",
        { class: `cmp-pane ${which}` },
        h(
            "div",
            { class: "cmp-pane-label" },
            h("span", { class: "cmp-chip-kind" }, which === "left" ? "L" : "R"),
            side.label,
            caption ? h("span", { class: "hint" }, `  ${caption}`) : null,
        ),
        frame,
    );
}

function stacked(
    m: CompareModel,
    left: CmpSlide | null,
    right: CmpSlide | null,
    p: PairModel,
): HTMLElement {
    const frame = h("div", { class: "cmp-frame stacked" });
    const a = slideView(m.left, left, "cmp-big under");
    const b = slideView(m.right, right, "cmp-big over");
    frame.append(a, b);
    if (mode === "slider") {
        const handle = h("div", { class: "cmp-handle" });
        const place = () => {
            b.style.clipPath = `inset(0 0 0 ${wipe}%)`;
            handle.style.left = `${wipe}%`;
        };
        place();
        frame.append(handle);
        const move = (e: PointerEvent) => {
            const r = frame.getBoundingClientRect();
            wipe = Math.max(
                0,
                Math.min(100, ((e.clientX - r.left) / r.width) * 100),
            );
            place();
        };
        frame.addEventListener("pointerdown", (e) => {
            frame.setPointerCapture(e.pointerId);
            move(e);
            frame.addEventListener("pointermove", move);
        });
        frame.addEventListener("pointerup", () =>
            frame.removeEventListener("pointermove", move),
        );
    }
    if (outlines && b.svg) {
        const marks = p.elements;
        afterLayout(() => {
            if (b.svg) drawOutlines(frame, b.svg, marks, "right", a.svg);
        });
    }
    const caption =
        mode === "slider"
            ? h(
                  "div",
                  { class: "cmp-pane-label" },
                  h("span", { class: "cmp-chip-kind" }, "L"),
                  `${m.left.label}  ◀ drag ▶  `,
                  h("span", { class: "cmp-chip-kind" }, "R"),
                  m.right.label,
              )
            : h(
                  "div",
                  { class: "cmp-pane-label" },
                  "Difference: what is the same turns black, what differs lights up",
              );
    return h("div", { class: "cmp-pane wide" }, caption, frame);
}

function afterLayout(fn: () => void): void {
    requestAnimationFrame(() => requestAnimationFrame(fn));
}

function locate(svg: SVGSVGElement, loc: Loc): Box | null {
    let el: Element | null = svg;
    for (const i of loc.path) {
        el = el?.children[i] ?? null;
        if (!el) break;
    }
    if (
        el &&
        el !== svg &&
        el.localName.toLowerCase() === loc.tag.toLowerCase()
    ) {
        const box = toSlideBox(
            el.getBoundingClientRect(),
            svg.getBoundingClientRect(),
            parseViewBox(svg.getAttribute("viewBox")),
        );
        if (box && box[2] > 0 && box[3] > 0) return box;
    }
    return loc.box;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Outline changed elements over a slide. In side-by-side each pane shows
 * its own side's; stacked (`leftSvg` given), the right side's boxes are
 * solid and where a changed or removed element was on the left is dashed. */
function drawOutlines(
    frame: HTMLElement,
    svg: SVGSVGElement,
    marks: PairModel["elements"],
    which: "left" | "right",
    leftSvg?: SVGSVGElement,
): void {
    if (!frame.isConnected || !marks.length) return;
    const vb = parseViewBox(svg.getAttribute("viewBox"));
    const layer = document.createElementNS(SVG_NS, "svg");
    layer.setAttribute("class", "cmp-outlines");
    layer.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    layer.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const pad = Math.max(vb.w, vb.h) / 240;
    const draw = (
        target: SVGSVGElement,
        loc: Loc | null,
        cls: string,
        label: string,
    ) => {
        const box = loc ? locate(target, loc) : null;
        if (!box) return;
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", String(box[0] - pad));
        rect.setAttribute("y", String(box[1] - pad));
        rect.setAttribute("width", String(box[2] + 2 * pad));
        rect.setAttribute("height", String(box[3] + 2 * pad));
        rect.setAttribute("rx", String(pad));
        rect.setAttribute("class", `mark ${cls}`);
        const title = document.createElementNS(SVG_NS, "title");
        title.textContent = label;
        rect.append(title);
        layer.append(rect);
    };
    for (const mark of marks) {
        const label = `${mark.change}${mark.id ? ` #${mark.id}` : ""}${mark.text ? `: ${mark.text}` : ""}`;
        if (leftSvg) {
            if (mark.left && mark.change !== "added") {
                draw(
                    leftSvg,
                    mark.left,
                    `${mark.change} before`,
                    `${label} (left)`,
                );
            }
            if (mark.right) draw(svg, mark.right, mark.change, label);
            continue;
        }
        draw(
            svg,
            which === "left" ? mark.left : mark.right,
            mark.change,
            label,
        );
    }
    frame.append(layer);
}

function info(
    m: CompareModel,
    p: PairModel,
    left: CmpSlide | null,
    right: CmpSlide | null,
): HTMLElement {
    const b = badge(p);
    const take = takeState(m, row);
    const what = p.status === "changed" ? whatChanged(p) : [];
    const summary =
        p.status === "added"
            ? `Only in ${m.right.label}`
            : p.status === "removed"
              ? `Only in ${m.left.label}`
              : p.status === "same"
                ? p.moved
                    ? "The same slide, moved"
                    : "No differences"
                : `${p.moved ? "Moved, and changed: " : "Changed: "}${what.join(", ")}`;
    const box = h(
        "div",
        { class: "cmp-info" },
        h(
            "div",
            { class: "cmp-info-head" },
            b.symbol
                ? h("span", { class: `cmp-badge ${b.cls}` }, b.symbol)
                : null,
            h("strong", {}, summary),
            h("span", { class: "cmp-spacer" }),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn primary",
                    disabled: !take.enabled,
                    title: take.title,
                    onclick: () => void taking(),
                },
                "Take this slide",
            ),
        ),
    );
    if (p.files.length) {
        box.append(
            h("h4", {}, "Files"),
            h(
                "div",
                { class: "cmp-files" },
                ...p.files.map((f) =>
                    h(
                        "div",
                        { class: "cmp-file" },
                        h("span", { class: `cmp-fstat ${f.change}` }, f.change),
                        h("code", {}, f.path),
                        h("span", { class: "hint" }, f.role),
                    ),
                ),
            ),
        );
    }
    if (p.settings.length) {
        box.append(
            h("h4", {}, "In deck.py"),
            h(
                "div",
                { class: "cmp-settings" },
                p.settings.map((s) => s.replace(/_/g, " ")).join(", "),
            ),
        );
    }
    if (p.elements.length) {
        const n = (k: string) =>
            p.elements.filter((e) => e.change === k).length;
        box.append(
            h(
                "div",
                { class: "hint cmp-elcount" },
                `Elements: ${n("changed")} changed, ${n("added")} added, ${n("removed")} removed`,
            ),
        );
    }
    if (left || right) {
        const a = left?.notes ?? "";
        const bText = right?.notes ?? "";
        const parts = wordDiff(a, bText);
        box.append(
            h("h4", {}, p.notes ? "Speaker notes (changed)" : "Speaker notes"),
            parts.length
                ? h(
                      "div",
                      { class: "cmp-notes" },
                      ...parts.map((part) =>
                          part.kind === "same"
                              ? document.createTextNode(part.text)
                              : h(part.kind, {}, part.text),
                      ),
                  )
                : h("div", { class: "hint" }, "No notes"),
        );
    }
    return box;
}

// ── Actions ──

async function taking(): Promise<void> {
    if (!model) return;
    const m = model;
    const p = m.pairs[row];
    const state = takeState(m, row);
    if (!p || !state.enabled) return;
    const other = m.left.live ? m.right : m.left;
    const files = p.files.map((f) => `  ${f.path}`).join("\n");
    const question = state.replace
        ? `Replace this slide in the working copy with ${other.label}'s version?${files ? `\n\nFiles written:\n${files}` : ""}\n\nCtrl+Z takes it back.`
        : `Insert ${other.label}'s slide into the working copy?`;
    if (!confirm(question)) return;
    const res = await edit({
        action: "compare-take",
        pair: row,
        left: p.left,
        right: p.right,
    });
    if (res.ok) {
        const stepNo = res.step;
        toast(String(res.label ?? "Took the slide"), "ok", {
            label: "Undo",
            run: () =>
                void edit({
                    action: "undo",
                    ...(typeof stepNo === "number" ? { step: stepNo } : {}),
                }),
        });
    }
}

async function merging(branch: string): Promise<void> {
    const notice = undoNoticeDue();
    const question = `Merge ${branch} into the working copy's branch? Commit or discard your own changes first; git refuses a merge that would overwrite them.`;
    if (!confirm(notice ? `${question}\n\n${UNDO_NOTICE}` : question)) {
        return;
    }
    if (notice) undoNoticeShown();
    view.classList.add("busy");
    const res = await mergeBranch(branch, request);
    view.classList.remove("busy");
    if (!res.ok) {
        toast(res.error ?? `Could not merge ${branch}`, "error");
        return;
    }
    if (res.historyCleared) {
        ed.canUndo = false;
        ed.canRedo = false;
        emit("history");
    }
    toast(res.message ?? `Merged ${branch}`, "ok");
}

// ── The picker ──

interface Sources {
    repo: boolean;
    branch?: string | null;
    commits?: {
        sha: string;
        short: string;
        when: string;
        subject: string;
        author: string;
        refs: string[];
        head: boolean;
    }[];
    branches?: string[];
    worktrees?: {
        path: string;
        branch: string | null;
        deck: string | null;
        main: boolean;
        current: boolean;
    }[];
}

let sourcesWaiting: ((s: Sources) => void) | null = null;

function fetchSources(): Promise<Sources> {
    return new Promise((resolve) => {
        sourcesWaiting = resolve;
        sendRaw({ type: "compare-sources" });
    });
}

const LIVE: Source = { kind: "live" };

/** "Compare…": pick what to compare the working copy with. */
export async function openComparePicker(
    side: "left" | "right" | null = null,
): Promise<void> {
    await whenConnected();
    const data = await fetchSources();
    // With a side, it replaces that side of the open comparison (two
    // commits, a commit and a folder…); without, the working copy is left.
    const current = model;
    const pick = (chosen: Source) => {
        closeDialog();
        if (side && current) {
            const [l, r] = [current.left.source, current.right.source];
            openCompare(
                side === "left" ? chosen : l,
                side === "right" ? chosen : r,
            );
        } else {
            openCompare(LIVE, chosen);
        }
    };
    const sections: HTMLElement[] = [];
    if (side) {
        sections.push(
            h(
                "div",
                { class: "btn-row" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => pick(LIVE),
                    },
                    "The working copy",
                ),
            ),
        );
    }
    if (data.repo) {
        const rev = h("input", {
            type: "text",
            placeholder: "HEAD~2, a tag, a sha…",
            spellcheck: "false",
        }) as HTMLInputElement;
        const go = () => {
            if (rev.value.trim())
                pick({ kind: "commit", rev: rev.value.trim() });
        };
        rev.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                go();
            }
        });
        const others = (data.worktrees ?? []).filter(
            (w) => !w.current && w.deck,
        );
        const inTree = new Set(others.map((w) => w.branch));
        const branches = (data.branches ?? []).filter(
            (b) => b !== data.branch && !inTree.has(b),
        );
        if (others.length || branches.length) {
            sections.push(
                h("h3", {}, "A branch or worktree"),
                h(
                    "div",
                    { class: "git-list" },
                    ...others.map((w) =>
                        h(
                            "div",
                            { class: "git-row" },
                            h(
                                "div",
                                { class: "git-commit" },
                                h("strong", {}, w.branch ?? "(detached)"),
                                h(
                                    "span",
                                    { class: "hint" },
                                    `worktree · ${w.path}`,
                                ),
                            ),
                            h(
                                "button",
                                {
                                    type: "button",
                                    class: "pbtn",
                                    onclick: () =>
                                        pick({
                                            kind: "path",
                                            deck: w.deck,
                                            ...(w.branch
                                                ? { label: w.branch }
                                                : {}),
                                        }),
                                },
                                "Compare",
                            ),
                        ),
                    ),
                    ...branches.map((b) =>
                        h(
                            "div",
                            { class: "git-row" },
                            h(
                                "div",
                                { class: "git-commit" },
                                h("strong", {}, b),
                                h("span", { class: "hint" }, "branch"),
                            ),
                            h(
                                "button",
                                {
                                    type: "button",
                                    class: "pbtn",
                                    onclick: () =>
                                        pick({ kind: "branch", name: b }),
                                },
                                "Compare",
                            ),
                        ),
                    ),
                ),
            );
        }
        sections.push(
            h("h3", {}, "A commit"),
            h(
                "div",
                { class: "git-list history cmp-commits" },
                ...(data.commits ?? []).map((c) =>
                    h(
                        "div",
                        { class: `git-row${c.head ? " current" : ""}` },
                        h(
                            "div",
                            { class: "git-commit" },
                            h("strong", {}, c.subject),
                            h(
                                "span",
                                { class: "hint" },
                                `${c.short} · ${c.author} · ${c.when}${c.refs.length ? ` · ${c.refs.join(", ")}` : ""}`,
                            ),
                        ),
                        h(
                            "button",
                            {
                                type: "button",
                                class: "pbtn",
                                onclick: () =>
                                    pick({ kind: "commit", rev: c.sha }),
                            },
                            "Compare",
                        ),
                    ),
                ),
            ),
            h(
                "div",
                { class: "btn-row" },
                rev,
                h(
                    "button",
                    { type: "button", class: "pbtn", onclick: go },
                    "Compare",
                ),
            ),
        );
    }
    const folderBtn = h(
        "button",
        { type: "button", class: "pbtn primary", disabled: true },
        "Compare with this deck",
    ) as HTMLButtonElement;
    const start = (ed.model?.projectDir ?? "").replace(/[\\/][^\\/]*$/, "");
    const picker = folderPicker(start, (f) => {
        folderBtn.disabled = !f.isDeck;
        folderBtn.textContent = f.isDeck
            ? "Compare with this deck"
            : "No deck.py in this folder";
    });
    folderBtn.addEventListener("click", () => {
        const f = picker.current();
        if (f?.isDeck)
            pick({ kind: "path", deck: joinPath(f.path, "deck.py") });
    });
    sections.push(
        h("h3", {}, "Another deck folder"),
        picker.el,
        h("div", { class: "btn-row end" }, folderBtn),
    );
    openDialog(
        side ? `Show on the ${side}…` : "Compare the working copy with…",
        h("div", { class: "git-form cmp-picker" }, ...sections),
        { large: true },
    );
}

// ── Keys and wiring ──

function onKey(e: KeyboardEvent): void {
    if (view.hidden) return;
    const target = e.target as HTMLElement;
    const typing = target.closest(
        "input:not([type=checkbox]):not([type=radio]), textarea, select, #dialog",
    );
    if (dialogOpen() || typing) {
        return;
    }
    const mod = e.ctrlKey || e.metaKey;
    // Undo and redo still work (a slide taken by mistake).
    if (mod && ["z", "y"].includes(e.key.toLowerCase())) return;
    const handled = () => {
        e.preventDefault();
        e.stopPropagation();
    };
    switch (e.key) {
        case "Escape":
            handled();
            closeCompare();
            return;
        case "ArrowDown":
            handled();
            step(1);
            return;
        case "ArrowUp":
            handled();
            step(-1);
            return;
        case "n":
        case "N":
            handled();
            jump(1);
            return;
        case "p":
        case "P":
            handled();
            jump(-1);
            return;
        case "1":
            handled();
            setMode("side");
            return;
        case "2":
            handled();
            setMode("slider");
            return;
        case "3":
            handled();
            setMode("diff");
            return;
        case "o":
        case "O":
            handled();
            outlines = !outlines;
            writePref("inkflow-compare-outlines", outlines ? "1" : "0");
            renderMain();
            return;
    }
    // Everything else would edit the slide behind the view.
    e.stopPropagation();
}

export function initCompare(): void {
    onMessage("compare-model", onModel);
    onMessage("compare-error", (msg) => {
        if (msg.for === "compare-sources") {
            toast(String(msg.message ?? "cannot list versions"), "error");
            sourcesWaiting?.({ repo: false });
            sourcesWaiting = null;
            return;
        }
        onError(msg);
    });
    onMessage("compare-sources", (msg) => {
        sourcesWaiting?.(msg as unknown as Sources);
        sourcesWaiting = null;
    });
    // A reconnected server knows nothing of the view: open it again.
    onConnect(() => {
        if (open && !view.hidden) {
            viewId += 1;
            sendRaw({
                type: "compare-open",
                view: viewId,
                left: open[0],
                right: open[1],
            });
        }
    });
    document.addEventListener("keydown", onKey, true);
    // The light/dark button: draw the slides again in the other mode.
    new MutationObserver(() => {
        if (!model || view.hidden) return;
        thumbs.clear();
        render();
    }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
    });
    // The worktrees list (Git menu) asks for a comparison with a deck.
    document.addEventListener("inkflow:compare", (e) => {
        const detail = (e as CustomEvent).detail as
            | { kind?: string; deck?: string; label?: string }
            | undefined;
        if (!detail?.deck) return;
        openCompare(LIVE, {
            kind: detail.kind ?? "path",
            deck: detail.deck,
            ...(detail.label ? { label: detail.label } : {}),
        });
    });
    // `inkflow edit --compare REV|PATH` opens the editor at ?compare=…
    const params = new URLSearchParams(location.search);
    const spec = params.get("compare");
    if (spec) {
        params.delete("compare");
        const query = params.toString();
        try {
            history.replaceState(
                null,
                "",
                `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
            );
        } catch {
            // the address keeps it
        }
        openCompare(LIVE, { kind: "spec", spec });
    }
}
