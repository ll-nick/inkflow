// The properties panel on the right. With nothing selected it edits the slide
// (title, layout, transition, visibility, animation order); with one object
// selected, that object (position, colours, text, arrangement, animations);
// with several, alignment and distribution.

import { maxStep } from "../shared/step";
import {
    cueSteps,
    playAnimations,
    previewPlaying,
    stopPreview,
} from "./animpreview";
import {
    canTransform,
    connectorPath,
    connectorStyle,
    elementGeom,
    enterGroup,
    isConnector,
    isStale,
    isZone,
    moveOps,
    select,
    selectionBox,
    sendSvgOps,
    setHover,
    showSites,
    sitesPerSide,
    slideBox,
    slideRoot,
    slideSize,
    zoneName,
} from "./canvas";
import { chartSettings, editChart, rangeInput } from "./chart";
import {
    CHART_KINDS,
    secondAxisAllowed,
    toggleRight,
    xColumn,
} from "./chartgrid";
import { parseConnection } from "./connectors";
import {
    isCropped,
    pictureOf,
    resetCrop,
    setCropMode,
    startCrop,
} from "./crop";
import { clear, h, icon, toast } from "./dom";
import {
    DIAGRAM_MODES,
    type DiagramMode,
    diagramMode,
    drawnDiagram,
    editDiagram,
    isDiagramHref,
} from "./drawio";
import {
    cellLabel,
    cellShape,
    diagramShapes,
    isDiagramCell,
    shapesEditable,
} from "./drawioshapes";
import { layoutLabel, openGallery } from "./gallery";
import {
    type Box,
    fmt,
    parseTransform,
    planResize,
    planRotate,
    projectFile,
    relativePath,
    rotationOf,
} from "./geom";
import {
    IMAGE_ACCEPT,
    naturalSize,
    pickFile,
    upload,
    zoneMedia,
} from "./insert";
import { edit } from "./net";
import { fileName, openButton } from "./openwith";
import { isPdfRef, pdfPage, withPage } from "./pathtext";
import { choosePage, pageUrl, sourceRef } from "./pdfpages";
import { renameButton, renameSlideFiles } from "./rename";
import { distribute } from "./snap";
import { currentSlide, ed, emit, on, sourceOf } from "./state";
import type {
    CueInfo,
    FieldSchema,
    FieldValue,
    Selected,
    SlideModel,
    SvgOp,
    TransitionInfo,
    TypeInfo,
    ZoneValue,
} from "./types";
import { openVideoCheck } from "./videocheck";
import { previewButton, videoOf } from "./videopreview";

const panel = document.getElementById("props-body")!;

// ── Small widgets ──

function section(title: string, ...body: (Node | null | false)[]): HTMLElement {
    return h(
        "section",
        { class: "props-section" },
        h("h3", {}, title),
        ...body.filter((b): b is Node => !!b),
    );
}

function row(label: string, ...controls: Node[]): HTMLElement {
    return h(
        "label",
        { class: "prop-row" },
        h("span", { class: "prop-label" }, label),
        ...controls,
    );
}

function numberInput(
    value: number | null,
    commit: (v: number) => void,
    opts: {
        step?: number;
        min?: number;
        placeholder?: string;
        // Called when the box is emptied (for fields that accept None).
        onClear?: () => void;
    } = {},
): HTMLInputElement {
    const input = h("input", {
        type: "number",
        class: "num",
        step: opts.step ?? 1,
        min: opts.min ?? null,
        placeholder: opts.placeholder ?? "",
        value: value == null ? "" : String(Math.round(value * 100) / 100),
    });
    const fire = () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) commit(v);
        else if (input.value.trim() === "") opts.onClear?.();
    };
    input.addEventListener("change", fire);
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") input.blur();
    });
    return input;
}

function textInput(
    value: string,
    commit: (v: string) => void,
    placeholder = "",
): HTMLInputElement {
    const input = h("input", { type: "text", value, placeholder });
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") input.blur();
    });
    return input;
}

function selectInput(
    options: { value: string; label: string }[],
    value: string,
    commit: (v: string) => void,
): HTMLSelectElement {
    const sel = h("select", {});
    for (const o of options) {
        const opt = h("option", { value: o.value }, o.label);
        if (o.value === value) opt.selected = true;
        sel.append(opt);
    }
    sel.addEventListener("change", () => commit(sel.value));
    return sel;
}

function button(
    label: string | Node,
    title: string,
    fn: () => void,
    cls = "",
): HTMLButtonElement {
    return h(
        "button",
        { type: "button", class: `pbtn ${cls}`, title, onclick: fn },
        label,
    );
}

// ── Field editors (animations, transitions) ──

function fieldControl(
    f: FieldSchema,
    value: FieldValue,
    commit: (v: FieldValue) => void,
): Node {
    switch (f.kind) {
        case "trigger": {
            const labels: Record<string, string> = {
                "on-click": "On click",
                "with-previous": "With previous",
                "after-previous": "After previous",
            };
            const v = String(value ?? f.default ?? "on-click");
            const opts = f.choices.map((c) => ({
                value: c,
                label: labels[c] ?? c,
            }));
            if (!f.choices.includes(v))
                opts.push({ value: v, label: `At step ${v}` });
            return selectInput(opts, v, commit);
        }
        case "enum":
        case "easing": {
            const v = String(value ?? f.default ?? "");
            const opts = f.choices.map((c) => ({ value: c, label: c }));
            if (v && !f.choices.includes(v)) opts.push({ value: v, label: v });
            return selectInput(opts, v, commit);
        }
        case "bool": {
            const cb = h("input", { type: "checkbox" });
            cb.checked = Boolean(value);
            cb.addEventListener("change", () => commit(cb.checked));
            return cb;
        }
        case "int":
        case "float":
            return numberInput(
                typeof value === "number" ? value : null,
                (v) => commit(f.kind === "int" ? Math.round(v) : v),
                {
                    step: f.kind === "int" ? 1 : 0.05,
                    placeholder: f.optional ? "none" : "",
                    onClear: f.optional ? () => commit(null) : undefined,
                },
            );
        default:
            return textInput(value == null ? "" : String(value), commit);
    }
}

function fieldsEditor(
    schema: FieldSchema[],
    values: Record<string, FieldValue>,
    commit: (values: Record<string, FieldValue>) => void,
): HTMLElement {
    const box = h("div", { class: "fields" });
    for (const f of schema) {
        const label = f.name.replace(/_/g, " ");
        box.append(
            row(
                label,
                fieldControl(f, values[f.name] ?? f.default, (v) =>
                    commit({ ...values, [f.name]: v }),
                ),
            ),
        );
    }
    return box;
}

// Settings of an image or video zone (fit, alignment; for a video autoplay,
// loop, sound, controls, trim and poster), written back as its Image(...) /
// Video(...) call in deck.py.
const MEDIA_LABELS: Record<string, string> = {
    fit: "Fit",
    align: "Anchor",
    controls: "Controls",
    autoplay: "Autoplay",
    muted: "Mute",
    loop: "Loop",
    poster: "Poster",
    start: "Trim start",
    end: "Trim end",
};

function mediaSection(
    slide: SlideModel,
    zone: string,
    media: ZoneValue,
): HTMLElement {
    const kind = media.kind === "video" ? "video" : "image";
    const schema = ed.model?.mediaTypes?.[kind] ?? [];
    const values = (media.fields ?? {}) as Record<string, FieldValue>;
    const commit = (name: string, v: FieldValue) =>
        void edit({
            action: "media-props",
            slide: slide.deckIndex,
            zone,
            fields: { [name]: v },
        });
    const rows: Node[] = [];
    for (const f of schema) {
        const label = MEDIA_LABELS[f.name] ?? f.name.replace(/_/g, " ");
        if (f.name === "poster") {
            const poster = values.poster;
            // A <div>, not row()'s <label>: a label would forward clicks on
            // its text to the first button.
            rows.push(
                h(
                    "div",
                    { class: "prop-row" },
                    h("span", { class: "prop-label" }, label),
                    h(
                        "span",
                        { class: "media-poster" },
                        poster ? String(poster).split("/").pop() : "None",
                    ),
                    button(
                        poster ? "Change…" : "Pick…",
                        poster
                            ? `Poster: ${poster}`
                            : "Still image shown before playback",
                        async () => {
                            const file = await pickFile("image/*");
                            const up = file ? await upload(file) : null;
                            if (up) commit("poster", up.path);
                        },
                    ),
                    poster
                        ? button("✕", "Remove the poster", () =>
                              commit("poster", null),
                          )
                        : null,
                ),
            );
            continue;
        }
        if (f.name === "background") {
            rows.push(
                backgroundRow(values.background ?? null, (v) =>
                    commit("background", v),
                ),
            );
            continue;
        }
        if (f.name === "muted") {
            // Muted.AUTO mutes exactly when the video autoplays.
            const opts = [
                { value: "auto", label: "When autoplaying" },
                { value: "on", label: "Always" },
                { value: "off", label: "Never" },
            ];
            rows.push(
                row(
                    label,
                    selectInput(opts, String(values.muted ?? "auto"), (v) =>
                        commit("muted", v),
                    ),
                ),
            );
            continue;
        }
        if (f.name === "start" || f.name === "end") {
            const v = values[f.name];
            rows.push(
                row(
                    label,
                    numberInput(
                        typeof v === "number" ? v : null,
                        (n) => commit(f.name, n),
                        {
                            step: 0.1,
                            min: 0,
                            placeholder: "seconds",
                            onClear: () => commit(f.name, null),
                        },
                    ),
                ),
            );
            continue;
        }
        rows.push(
            row(
                label,
                fieldControl(f, values[f.name] ?? f.default, (v) =>
                    commit(f.name, v),
                ),
            ),
        );
    }
    if (kind === "video") {
        rows.push(
            h(
                "p",
                { class: "hint" },
                "To start it on a click instead, add a Play video animation below.",
            ),
        );
    }
    return section(kind === "video" ? "Video" : "Image", ...rows);
}

// The page a PDF in an image zone shows (``Image("plot.pdf#page=2")``).
function zonePageRow(slide: SlideModel, zone: string, ref: string): Node {
    const file = projectFile(ref);
    const page = pdfPage(ref);
    const show = (n: number) => {
        if (!file || n === page) return;
        void edit({
            action: "zone-media",
            slide: slide.deckIndex,
            zone,
            src: file,
            page: n,
        });
    };
    return h(
        "div",
        { class: "prop-row" },
        h("span", { class: "prop-label" }, "Page"),
        numberInput(page, (n) => show(Math.max(1, Math.round(n))), { min: 1 }),
        button("Pages…", "See the PDF's pages and pick one", async () => {
            const choice = file ? await choosePage(file, page) : null;
            if (choice) show(choice.page);
        }),
    );
}

// A chart's settings, written back as its Chart(...) call in deck.py; its
// data is edited in the chart dialog ("Edit data…").
function chartSection(
    slide: SlideModel,
    zone: string,
    value: ZoneValue,
): HTMLElement {
    const s = chartSettings(value);
    const commit = (fields: Record<string, unknown>) =>
        void edit({
            action: "chart-props",
            slide: slide.deckIndex,
            zone,
            fields,
        });
    const grid = {
        columns: value.columns ?? [],
        rows: [] as string[][],
    };
    const numeric = value.numeric ?? [];
    const x = xColumn(grid, s);
    // Without rows, plotted() cannot tell numbers: the model says which.
    const shown = s.y ?? numeric.filter((c) => c !== x);
    const check = (label: string, on: boolean, fn: (v: boolean) => void) => {
        const box = h("input", { type: "checkbox" });
        box.checked = on;
        box.addEventListener("change", () => fn(box.checked));
        return row(label, box);
    };
    const series = h("div", { class: "chart-series" });
    const twoAxes = secondAxisAllowed(s);
    for (const c of grid.columns.filter((c) => c !== x)) {
        const box = h("input", { type: "checkbox" });
        box.checked = shown.includes(c);
        box.disabled = !numeric.includes(c);
        box.addEventListener("change", () => {
            const next = grid.columns.filter((n) =>
                n === c ? box.checked : shown.includes(n),
            );
            const auto = numeric.filter((n) => n !== x);
            const same =
                next.length === auto.length &&
                next.every((n, i) => n === auto[i]);
            commit({
                y: same ? null : next,
                ...(box.checked ? {} : { y2: toggleRight(s, c, false) }),
            });
        });
        const entry = h("label", { class: "chart-check" }, box, c);
        if (twoAxes && shown.includes(c) && numeric.includes(c)) {
            const right = h("input", { type: "checkbox" });
            right.checked = (s.y2 ?? []).includes(c);
            right.addEventListener("change", () =>
                commit({ y2: toggleRight(s, c, right.checked) }),
            );
            series.append(
                h(
                    "span",
                    { class: "chart-series-row" },
                    entry,
                    h(
                        "label",
                        {
                            class: "chart-check chart-right",
                            title: `Draw ${c} against a second axis, on the right`,
                        },
                        right,
                        "right axis",
                    ),
                ),
            );
        } else series.append(entry);
    }
    const rows: Node[] = [
        row(
            "Kind",
            selectInput(CHART_KINDS, s.kind, (v) => commit({ kind: v })),
        ),
        row(
            s.kind === "scatter" ? "X values" : "Categories",
            selectInput(
                grid.columns.map((c) => ({ value: c, label: c })),
                x ?? "",
                (v) => commit({ x: v === grid.columns[0] ? null : v }),
            ),
        ),
        h(
            "div",
            { class: "prop-row" },
            h(
                "span",
                { class: "prop-label" },
                s.kind === "pie" ? "Sizes" : "Series",
            ),
            series,
        ),
        row(
            "Title",
            textInput(s.title ?? "", (v) => commit({ title: v }), "none"),
        ),
    ];
    const range = (
        label: string,
        lo: "y_min" | "y2_min",
        hi: "y_max" | "y2_max",
    ) =>
        h(
            "div",
            { class: "prop-row" },
            h(
                "span",
                {
                    class: "prop-label",
                    title: "Where the axis starts and ends; empty: from the data",
                },
                label,
            ),
            h(
                "span",
                { class: "chart-range-row" },
                rangeInput(s[lo], (v) => commit({ [lo]: v }), "from"),
                h("span", { class: "hint" }, "to"),
                rangeInput(s[hi], (v) => commit({ [hi]: v }), "auto"),
            ),
        );
    if (s.kind !== "pie") {
        rows.push(range(s.y2 ? "Left axis" : "Value axis", "y_min", "y_max"));
        if (s.y2 && twoAxes) rows.push(range("Right axis", "y2_min", "y2_max"));
    }
    if (s.kind === "bar" || s.kind === "area") {
        rows.push(check("Stacked", s.stacked, (v) => commit({ stacked: v })));
    }
    if (s.kind === "bar") {
        rows.push(
            check("Horizontal", s.horizontal, (v) => commit({ horizontal: v })),
        );
    }
    if (s.kind === "pie") {
        rows.push(check("Donut", s.donut, (v) => commit({ donut: v })));
    }
    rows.push(
        check("Value labels", s.labels, (v) => commit({ labels: v })),
        row(
            "Legend",
            selectInput(
                [
                    { value: "auto", label: "Auto" },
                    { value: "on", label: "Show" },
                    { value: "off", label: "Hide" },
                ],
                s.legend == null ? "auto" : s.legend ? "on" : "off",
                (v) => commit({ legend: v === "auto" ? null : v === "on" }),
            ),
        ),
        h(
            "p",
            { class: "hint" },
            `Each series is a group with the id ${zone}-series-<column>: animate them one by one.`,
        ),
    );
    if (value.error) {
        rows.unshift(h("p", { class: "hint error" }, value.error));
    }
    return section("Chart", ...rows);
}

function typeInfo(list: TypeInfo[], type: string): TypeInfo | null {
    return list.find((t) => t.type === type) ?? null;
}

// ── Slide panel ──

function renderSlidePanel(): void {
    const slide = currentSlide();
    const model = ed.model;
    if (!slide || !model) return;
    const editable = model.deckEditable;
    const di = slide.deckIndex;
    const root = slideRoot();
    const parent = root?.getAttribute("inkflow:parent") ?? null;
    const currentLayout = slide.srcShared
        ? slide.src.replace(/\.svg$/, "")
        : parent;
    panel.append(
        section(
            "Slide",
            row(
                "Title",
                textInput(slide.title ?? "", (v) => {
                    void edit({
                        action: "slide",
                        op: "title",
                        slide: di,
                        title: v,
                    });
                }),
            ),
            row(
                "Layout",
                button(
                    `${currentLayout ? layoutLabel(currentLayout) : "None"} ▾`,
                    "Pick a layout from previews",
                    () =>
                        void openGallery({
                            mode: "change",
                            current: currentLayout,
                        }),
                    "wide",
                ),
            ),
            row(
                "Font size",
                numberInput(
                    slide.fontSize,
                    (v) =>
                        void edit({
                            action: "slide",
                            op: "font-size",
                            slide: di,
                            size: v,
                        }),
                    { placeholder: "deck default" },
                ),
            ),
            row(
                "Hidden",
                (() => {
                    const cb = h("input", { type: "checkbox" });
                    cb.checked = !slide.visible;
                    cb.disabled = !editable;
                    cb.addEventListener("change", () => {
                        void edit({
                            action: "slide",
                            op: "hide",
                            slide: di,
                            hidden: cb.checked,
                        });
                    });
                    return cb;
                })(),
            ),
            !editable &&
                h(
                    "p",
                    { class: "hint" },
                    "deck.py builds its slide list in code, so slide-level settings are read-only here.",
                ),
        ),
    );

    panel.append(transitionSection(slide.transition, di));
    panel.append(animationList(slide.animations, slide.animationsEditable, di));

    const files = h("div", { class: "files" });
    const addFile = (
        label: string,
        rel: string | null | undefined,
        path: string | null | undefined,
    ) => {
        if (rel)
            files.append(
                h(
                    "div",
                    { class: "file" },
                    h("span", {}, label),
                    h("code", { title: path ?? rel }, rel),
                    openButton(path),
                ),
            );
    };
    addFile("Drawing", slide.srcShared ? null : slide.srcRel, slide.srcPath);
    addFile("Layout", slide.srcShared ? slide.srcRel : null, slide.srcPath);
    addFile("Markdown", slide.md?.rel, slide.md?.path);
    addFile("Notes", slide.notes.rel, slide.notes.path);
    const deckPath = ed.model?.deckPath;
    if (deckPath) addFile("Deck", fileName(deckPath), deckPath);
    if (editable)
        files.append(
            button(
                "Rename files…",
                "Give this slide's drawing, Markdown, notes and ink one new name (its id follows)",
                () => renameSlideFiles(di),
            ),
        );
    const textInDeck =
        slide.md?.kind !== "file" &&
        (slide.md?.kind === "inline" ||
            Object.values(slide.zones).some((z) => z.kind === "text"));
    if (textInDeck && editable)
        files.append(
            button(
                "Move text to Markdown",
                "Move this slide's text out of deck.py into its own .md file",
                () => void edit({ action: "to-markdown", slide: di }),
            ),
        );
    panel.append(section("Files", files));
    const arrows = attachedConnectors();
    if (arrows.length) {
        const stale = arrows.filter((a) => isStale(a.el)).length;
        panel.append(
            section(
                "Arrows",
                h(
                    "p",
                    { class: "hint" },
                    `${arrows.length} arrow${arrows.length === 1 ? " is" : "s are"} attached to shapes and follow them when they move here. After moving shapes in another editor, re-route them:`,
                ),
                stale
                    ? h(
                          "p",
                          { class: "hint warn" },
                          `${stale} ${stale === 1 ? "arrow no longer meets its shape" : "arrows no longer meet their shapes"} (moved in draw.io or another editor).`,
                      )
                    : null,
                button(
                    "Re-route all",
                    "Re-attach every arrow to its shapes",
                    () => reroute(arrows),
                ),
            ),
        );
    }
    if (slide.srcShared) {
        panel.append(
            h(
                "p",
                { class: "hint" },
                "This slide is drawn by a shared layout. Draw on it (or insert anything) and it gets its own SVG built on that layout. Use “Edit layout” to change the layout itself.",
            ),
        );
    }
}

function transitionSection(
    current: TransitionInfo | null,
    di: number,
): HTMLElement {
    const model = ed.model!;
    const types = model.transitionTypes;
    const value = current?.type ?? "";
    const opts = [
        { value: "", label: `Deck default (${model.defaultTransition.type})` },
        ...types.map((t) => ({ value: t.type, label: t.type })),
    ];
    const send = (
        spec: { type: string; fields: Record<string, FieldValue> } | null,
    ) => void edit({ action: "slide", op: "transition", slide: di, spec });
    const body: Node[] = [
        row(
            "Type",
            selectInput(opts, value, (v) => {
                if (!v) send(null);
                else send({ type: v, fields: {} });
            }),
        ),
    ];
    if (current) {
        const info = typeInfo(types, current.type);
        if (info) {
            body.push(
                fieldsEditor(info.fields, current.fields, (fields) =>
                    send({ type: current.type, fields }),
                ),
            );
        }
    }
    return section("Transition into this slide", ...body);
}

// ── Animations ──

function triggerLabel(t: FieldValue): string {
    if (t === "with-previous") return "with previous";
    if (t === "after-previous") return "after previous";
    if (t === "on-click" || t == null) return "on click";
    return `step ${t}`;
}

function animationList(
    cues: CueInfo[],
    editable: boolean,
    di: number,
): HTMLElement {
    const model = ed.model!;
    const list = h("div", { class: "anim-list" });
    if (!cues.length)
        list.append(h("p", { class: "hint" }, "No animations on this slide."));
    const steps = cueSteps(cues, slideRoot());
    const replace = (
        i: number,
        type: string,
        fields: Record<string, FieldValue>,
    ) =>
        void edit({
            action: "anim",
            slide: di,
            op: "replace",
            index: i,
            spec: { type, element: cues[i].element, fields },
        });
    cues.forEach((cue, i) => {
        const step = steps[i];
        const info = typeInfo(model.animationTypes, cue.type);
        const trigger = cue.fields.trigger ?? "on-click";
        const typeSelect = selectInput(
            model.animationTypes
                .filter((t) => (t.kind === "video") === (cue.kind === "video"))
                .map((t) => ({ value: t.type, label: t.type })),
            cue.type,
            (v) => {
                // Keep what the new type also has (its trigger, timing…).
                const names = new Set(
                    typeInfo(model.animationTypes, v)?.fields.map(
                        (f) => f.name,
                    ),
                );
                const kept = Object.fromEntries(
                    Object.entries(cue.fields).filter(([k]) => names.has(k)),
                );
                replace(i, v, { ...kept, trigger });
            },
        );
        const triggerField = info?.fields.find((f) => f.kind === "trigger");
        const triggerSelect = triggerField
            ? fieldControl(triggerField, trigger, (v) =>
                  replace(i, cue.type, { ...cue.fields, trigger: v }),
              )
            : null;
        const item = h(
            "div",
            {
                class: "anim-row",
                "data-step": step == null ? null : String(step),
            },
            h(
                "div",
                { class: "anim-item" },
                h("span", {
                    class: `anim-kind k-${cue.kind}`,
                    title: cue.kind,
                }),
                h(
                    "span",
                    {
                        class: "anim-step",
                        title:
                            step == null
                                ? "Not on the slide"
                                : `Plays on click ${step}`,
                    },
                    step == null ? "–" : String(step),
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "anim-target",
                        title: "Select this element",
                        onclick: () => selectById(cue.element),
                    },
                    `#${cue.element}`,
                ),
                step != null &&
                    button(
                        icon("play", 12),
                        "Preview from this animation",
                        () => void playAnimations(step),
                        "anim-preview-ctl",
                    ),
                editable &&
                    button(icon("up", 12), "Earlier", () => {
                        if (i > 0)
                            void edit({
                                action: "anim",
                                slide: di,
                                op: "move",
                                index: i,
                                to: i - 1,
                            });
                    }),
                editable &&
                    button(icon("down", 12), "Later", () => {
                        if (i < cues.length - 1) {
                            void edit({
                                action: "anim",
                                slide: di,
                                op: "move",
                                index: i,
                                to: i + 1,
                            });
                        }
                    }),
                editable &&
                    button(icon("trash", 12), "Remove", () => {
                        void edit({
                            action: "anim",
                            slide: di,
                            op: "remove",
                            index: i,
                        });
                    }),
            ),
            editable
                ? h("div", { class: "anim-edit" }, typeSelect, triggerSelect)
                : h(
                      "div",
                      { class: "anim-edit" },
                      h("span", { class: "anim-type" }, cue.type),
                      h(
                          "span",
                          { class: "anim-trigger" },
                          triggerLabel(cue.fields.trigger ?? null),
                      ),
                  ),
        );
        list.append(item);
    });
    if (!editable && cues.length) {
        list.append(
            h(
                "p",
                { class: "hint" },
                "Animations are built in code in deck.py; read-only.",
            ),
        );
    }
    const svg = slideRoot();
    const animated = !!svg && maxStep(svg) > 0;
    const playing = previewPlaying();
    const controls = h(
        "div",
        { class: "btn-row anim-preview" },
        playing
            ? button(
                  "■ Stop",
                  "Stop the preview (Esc)",
                  () => stopPreview(),
                  "anim-preview-ctl",
              )
            : button(
                  "▶ Play",
                  "Play this slide's animations here, click by click",
                  () => void playAnimations(1),
                  "anim-preview-ctl",
              ),
    );
    if (!animated && !playing)
        (controls.firstChild as HTMLButtonElement).disabled = true;
    return section("Animation order", controls, list);
}

function selectById(id: string): void {
    const svg = slideRoot();
    const found = svg?.querySelector(`[id="${CSS.escape(id)}"]`);
    // A shape of a drawn-in diagram is part of that one object.
    const el = found?.closest("[data-ink]") ?? null;
    if (el) {
        enterGroup(null);
        select([el as SVGGraphicsElement]);
    } else toast(`#${id} is not on this slide`, "error");
}

function elementAnimations(sel: Selected): HTMLElement {
    const slide = currentSlide()!;
    const model = ed.model!;
    const id = sel.el.getAttribute("id");
    const di = slide.deckIndex;
    const editable = slide.animationsEditable && model.deckEditable;
    const body = h("div", { class: "anim-list" });
    const elementName = isZone(sel.el) ? zoneName(sel.el) : id;
    const steps = cueSteps(slide.animations, slideRoot());
    slide.animations.forEach((cue, index) => {
        if (
            !elementName ||
            cue.element !== (cue.kind === "video" ? zoneName(sel.el) : id)
        )
            return;
        const info = typeInfo(model.animationTypes, cue.type);
        const send = (type: string, fields: Record<string, FieldValue>) =>
            void edit({
                action: "anim",
                slide: di,
                op: "replace",
                index,
                spec: { type, element: cue.element, fields },
            });
        const header = h(
            "div",
            { class: "anim-head" },
            h("span", { class: `anim-kind k-${cue.kind}` }),
            editable
                ? selectInput(
                      model.animationTypes.map((t) => ({
                          value: t.type,
                          label: t.type,
                      })),
                      cue.type,
                      (v) =>
                          send(v, {
                              trigger: cue.fields.trigger ?? "on-click",
                          }),
                  )
                : h("span", {}, cue.type),
            steps[index] != null &&
                button(
                    icon("play", 12),
                    `Preview (click ${steps[index]})`,
                    () => void playAnimations(steps[index] ?? 1),
                    "anim-preview-ctl",
                ),
            editable &&
                button(icon("trash", 12), "Remove", () => {
                    void edit({
                        action: "anim",
                        slide: di,
                        op: "remove",
                        index,
                    });
                }),
        );
        body.append(
            h(
                "div",
                { class: "anim-card" },
                header,
                info && editable
                    ? fieldsEditor(info.fields, cue.fields, (f) =>
                          send(cue.type, f),
                      )
                    : null,
            ),
        );
    });
    if (editable) {
        const add = animationPicker(
            model.animationTypes,
            isZone(sel.el),
            "+ Add animation…",
        );
        add.addEventListener("change", () => {
            const type = add.value;
            if (!type) return;
            const video =
                typeInfo(model.animationTypes, type)?.kind === "video";
            const element = video ? zoneName(sel.el) : id;
            const src = sourceOf(sel.key);
            void edit({
                action: "anim",
                slide: di,
                op: "insert",
                index: slide.animations.length,
                spec: { type, element: element ?? "", fields: {} },
                target:
                    element || !src
                        ? undefined
                        : {
                              file: src.path,
                              loc: sel.loc,
                              base: sel.el.localName,
                          },
            });
        });
        body.append(add);
    } else if (!slide.animationsEditable) {
        body.append(
            h(
                "p",
                { class: "hint" },
                "This slide's animations are built in code.",
            ),
        );
    }
    return section("Animations", body);
}

function animationPicker(
    all: TypeInfo[],
    video: boolean,
    prompt: string,
): HTMLSelectElement {
    const groups: Record<string, TypeInfo[]> = {};
    for (const t of all) {
        if (t.kind === "video" && !video) continue;
        const kind = t.kind ?? "other";
        groups[kind] = [...(groups[kind] ?? []), t];
    }
    const add = h("select", { class: "add-anim" }) as HTMLSelectElement;
    add.append(h("option", { value: "" }, prompt));
    for (const [kind, types] of Object.entries(groups)) {
        const og = h("optgroup", { label: kind });
        for (const t of types)
            og.append(h("option", { value: t.type }, t.type));
        add.append(og);
    }
    return add;
}

// ── Object panel ──

const TAG_NAMES: Record<string, string> = {
    g: "Group",
    rect: "Rectangle",
    circle: "Circle",
    ellipse: "Ellipse",
    line: "Line",
    polyline: "Polyline",
    polygon: "Polygon",
    path: "Path",
    text: "Text",
    image: "Image",
    svg: "Image (cropped)",
    use: "Clone",
    foreignObject: "Embedded content",
};

function tokenOf(el: Element, prop: "fill" | "stroke"): string | null {
    for (const c of el.classList) {
        const m = c.match(/^inkflow-(fill|stroke)-(.+)$/);
        if (m && m[1] === prop) return m[2];
    }
    return null;
}

function rgbToHex(rgb: string): string {
    const m = rgb.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return "#000000";
    return `#${m
        .slice(0, 3)
        .map((v) => Math.round(Number(v)).toString(16).padStart(2, "0"))
        .join("")}`;
}

// A text zone's box is drawn only once it is styled (inkflow:show-shape):
// styling it turns the box on.
function boxOps(s: Selected): SvgOp[] {
    return isZone(s.el)
        ? [{ kind: "attrs", loc: s.loc, set: { "inkflow:show-shape": "true" } }]
        : [];
}

function boxShown(el: Element): boolean {
    return !isZone(el) || el.hasAttribute("inkflow:show-shape");
}

function paintRow(sel: Selected[], prop: "fill" | "stroke"): HTMLElement {
    const first = sel[0].el;
    const shown = boxShown(first);
    const token = shown ? tokenOf(first, prop) : null;
    const computed = shown ? getComputedStyle(first)[prop] : "none";
    const send = (paint: { token?: string; color?: string }) => {
        const plans = sel.map((s) => ({
            sel: s,
            ops: [
                ...boxOps(s),
                { kind: "paint", loc: s.loc, prop, ...paint } as SvgOp,
            ],
        }));
        void sendSvgOps(plans, prop === "fill" ? "Fill" : "Stroke");
    };
    const swatches = h("div", { class: "swatches" });
    for (const t of ed.model?.colorTokens ?? []) {
        swatches.append(
            h("button", {
                type: "button",
                class: `swatch${t === token ? " active" : ""}`,
                title: t,
                style: `background: var(--inkflow-${t})`,
                onclick: () => send({ token: t }),
            }),
        );
    }
    const custom = h("input", {
        type: "color",
        value: computed && computed !== "none" ? rgbToHex(computed) : "#000000",
        title: "Custom colour",
    });
    custom.addEventListener("change", () => send({ color: custom.value }));
    swatches.append(custom);
    swatches.append(
        button("∅", "None", () => send({ color: "none" }), "none-btn"),
    );
    return row(prop === "fill" ? "Fill" : "Stroke", swatches);
}

function styleOps(
    sel: Selected[],
    set: Record<string, string | null>,
    label: string,
) {
    void sendSvgOps(
        sel.map((s) => ({
            sel: s,
            ops: [...boxOps(s), { kind: "style", loc: s.loc, set }],
        })),
        label,
    );
}

// ── A draw.io diagram's shape, edited on the slide ──

/** Focus a selected diagram shape's Label field (double-click on it). */
export function focusCellLabel(_el: Element): void {
    const area = panel.querySelector<HTMLTextAreaElement>(".cell-label");
    area?.focus();
    area?.select();
}

// A theme colour as the #rrggbb draw.io stores (it has no theme tokens).
function tokenHex(token: string): string {
    const probe = h("span", { style: `color: var(--inkflow-${token})` });
    (slideRoot()?.parentElement ?? document.body).append(probe);
    const hex = rgbToHex(getComputedStyle(probe).color);
    probe.remove();
    return hex;
}

function cellColorRow(
    label: string,
    current: string,
    pick: (hex: string) => void,
): HTMLElement {
    const swatches = h("div", { class: "swatches" });
    for (const t of ed.model?.colorTokens ?? []) {
        swatches.append(
            h("button", {
                type: "button",
                class: "swatch",
                title: `${t} (as its colour now)`,
                style: `background: var(--inkflow-${t})`,
                onclick: () => pick(tokenHex(t)),
            }),
        );
    }
    const custom = h("input", {
        type: "color",
        value: current,
        title: "Custom colour",
    }) as HTMLInputElement;
    custom.addEventListener("change", () => pick(custom.value));
    swatches.append(custom);
    return row(label, swatches);
}

function renderCellPanel(sel: Selected): void {
    const el = sel.el;
    const cell = el.getAttribute("data-cell-id") ?? "";
    const themed =
        el.closest("svg[data-drawio]")?.getAttribute("data-drawio-mode") ===
        "themed";
    const send = (op: SvgOp, label: string) =>
        void sendSvgOps([{ sel, ops: [op] }], label);
    const style = (key: string, value: string | number, label: string) =>
        send({ kind: "cell-style", cell, key, value }, label);
    const painted = cellShape(el).querySelector(
        "rect, ellipse, path, polygon, circle",
    );
    const look = painted ? getComputedStyle(painted) : null;
    const hex = (v: string | undefined) =>
        v && v !== "none" ? rgbToHex(v) : "#ffffff";
    const area = h("textarea", {
        class: "cell-label",
        rows: 2,
        spellcheck: "true",
    }) as HTMLTextAreaElement;
    area.value = cellLabel(el);
    area.addEventListener("change", () =>
        send({ kind: "cell-label", cell, text: area.value }, "Shape label"),
    );
    // Enter keeps the label (Shift+Enter: a new line); Esc keeps it too and
    // leaves the diagram (see initProps).
    area.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            area.blur();
        }
    });
    panel.append(
        section(
            "draw.io shape",
            row("Id", h("code", {}, el.getAttribute("id") ?? "")),
            row("Label", area),
            cellColorRow("Fill", hex(look?.fill), (v) =>
                style("fillColor", v, "Shape fill"),
            ),
            cellColorRow("Line", hex(look?.stroke), (v) =>
                style("strokeColor", v, "Shape line"),
            ),
            row(
                "Line width",
                numberInput(parseFloat(look?.strokeWidth ?? "1") || 1, (v) =>
                    style("strokeWidth", v, "Shape line width"),
                ),
            ),
            h(
                "p",
                { class: "hint" },
                `Changes go into the diagram's draw.io source, and draw.io redraws it (its arrows follow).${themed ? " In the deck's theme, colours show as the nearest theme colour." : ""} Copying, grouping, rotating and stacking shapes stay in draw.io. Enter keeps a label; Esc leaves the diagram.`,
            ),
            h(
                "div",
                { class: "btn-row" },
                button("Leave the diagram", "Esc", () => enterGroup(null)),
            ),
        ),
    );
    panel.append(geometrySection([sel]));
    panel.append(elementAnimations(sel));
}

function renderObjectPanel(sel: Selected): void {
    const el = sel.el;
    if (isDiagramCell(el)) {
        renderCellPanel(sel);
        return;
    }
    const src = sourceOf(sel.key);
    const zone = isZone(el);
    const movable = canTransform(el);
    const id = el.getAttribute("id") ?? "";
    const tag = zone
        ? `Zone · ${zoneName(el)}`
        : drawnDiagram(el)
          ? "Diagram"
          : (TAG_NAMES[el.localName] ?? el.localName);
    panel.append(
        section(
            tag,
            row(
                "Id",
                zone
                    ? h("code", {}, id)
                    : textInput(
                          id,
                          (v) => {
                              if (!src || !v || v === id) return;
                              void edit({
                                  action: "svg",
                                  file: src.path,
                                  hash: src.hash,
                                  ops: [
                                      {
                                          kind: "id",
                                          loc: sel.loc,
                                          id: v,
                                          from: id,
                                      },
                                  ],
                                  label: "Rename",
                              });
                          },
                          "no id",
                      ),
            ),
            src &&
                h(
                    "div",
                    { class: "source-hint" },
                    h(
                        "p",
                        { class: "hint" },
                        `In ${src.rel}${(src.role !== "slide" && src.role !== "ink") || currentSlide()?.srcShared ? ` · shared by ${src.usedBy.length} slide${src.usedBy.length === 1 ? "" : "s"}` : ""}`,
                    ),
                    openButton(src.path),
                ),
        ),
    );

    if (zone) {
        const slide = currentSlide()!;
        const name = zoneName(el);
        const origin = slide.zoneOrigins?.[name];
        const media = slide.zones[name];
        const where =
            origin === "deck"
                ? "deck.py zones="
                : origin === "md-file"
                  ? `${slide.md?.rel ?? "Markdown"} (whole file)`
                  : slide.md?.rel
                    ? `${slide.md.rel} · ::${name}::`
                    : "deck.py";
        const textFile =
            origin === "deck" || !slide.md?.path
                ? ed.model?.deckPath
                : slide.md.path;
        const isMedia =
            !!media &&
            (media.kind === "image" ||
                media.kind === "video" ||
                media.kind === "chart");
        const body: Node[] = [
            h(
                "div",
                { class: "source-hint" },
                h("p", { class: "hint" }, `Content from ${where}`),
                isMedia ? null : openButton(textFile),
            ),
        ];
        if (media?.kind === "chart") {
            body.push(
                h(
                    "div",
                    { class: "source-hint" },
                    h(
                        "p",
                        { class: "hint media-src" },
                        media.inline
                            ? "Data written in deck.py"
                            : (media.src ?? ""),
                    ),
                    media.path ? openButton(media.path) : null,
                    media.inline ? null : renameButton(media.path),
                ),
                button(
                    "Edit data…",
                    "Edit the chart's table (double-click)",
                    () => void editChart(name),
                ),
            );
        } else if (
            media &&
            (media.kind === "image" || media.kind === "video")
        ) {
            body.push(
                h(
                    "div",
                    { class: "source-hint" },
                    h("p", { class: "hint media-src" }, media.src ?? ""),
                    openButton(projectFile(media.src)),
                    renameButton(projectFile(media.src)),
                ),
                ...(media.kind === "image" && isPdfRef(media.src ?? "")
                    ? [zonePageRow(slide, name, media.src ?? "")]
                    : []),
                button(
                    "Replace media…",
                    "Pick another image or video",
                    () => void zoneMedia(name),
                ),
                button("Clear", "Empty this zone", () => {
                    void edit({
                        action: "zone-media",
                        slide: slide.deckIndex,
                        zone: name,
                        src: null,
                    });
                }),
            );
            const video = media.kind === "video" ? videoOf(el) : null;
            if (video) body.push(previewButton(video, button));
            if (media.kind === "video" && media.src) {
                const src = media.src;
                body.push(
                    button(
                        "Check & convert…",
                        "Can every browser play it? Convert it to MP4 or WebM, smaller or at another resolution",
                        () =>
                            void openVideoCheck({
                                path: src,
                                slide: slide.deckIndex,
                                zone: name,
                            }),
                    ),
                );
            }
        } else {
            body.push(
                button(
                    "Edit text",
                    "Edit this zone's Markdown (double-click)",
                    () => {
                        emit("edit-zone");
                    },
                ),
            );
        }
        panel.append(section("Content", ...body));
        if (media && (media.kind === "image" || media.kind === "video")) {
            panel.append(mediaSection(slide, name, media));
        }
        if (media?.kind === "chart") {
            panel.append(chartSection(slide, name, media));
        }
    }

    // A group (or other object) with a video in it: play it from here too.
    const innerVideo = zone ? null : videoOf(el);
    if (innerVideo) {
        panel.append(section("Video", previewButton(innerVideo, button)));
    }

    if (movable) panel.append(geometrySection([sel]));

    // A text zone (a text box, text typed into a shape) is styled like a shape:
    // its source rect / ellipse draws the box behind the text.
    const textZone =
        zone &&
        el.localName === "foreignObject" &&
        !!el.querySelector(".inkflow-content");
    const shapeTag = textZone
        ? (el.getAttribute("data-ink-tag") ?? "rect")
        : el.localName;
    if ((!zone || textZone) && src?.writable && (movable || ed.layoutMode)) {
        const picture = !!pictureOf(el) || !!drawnDiagram(el);
        const fills = ![
            "line",
            "polyline",
            "image",
            "foreignObject",
            "g",
        ].includes(shapeTag);
        const strokeWidth = parseFloat(getComputedStyle(el).strokeWidth) || 0;
        const opacity = parseFloat(getComputedStyle(el).opacity);
        panel.append(
            section(
                "Style",
                fills && !picture && paintRow([sel], "fill"),
                !picture && el.localName !== "g" && paintRow([sel], "stroke"),
                !picture &&
                    el.localName !== "g" &&
                    row(
                        "Stroke width",
                        numberInput(strokeWidth, (v) =>
                            styleOps(
                                [sel],
                                { "stroke-width": String(v) },
                                "Stroke width",
                            ),
                        ),
                    ),
                row(
                    "Opacity",
                    (() => {
                        const r = h("input", {
                            type: "range",
                            min: 0,
                            max: 1,
                            step: 0.05,
                            value: String(
                                Number.isFinite(opacity) ? opacity : 1,
                            ),
                        });
                        r.addEventListener("change", () =>
                            styleOps(
                                [sel],
                                { opacity: r.value === "1" ? null : r.value },
                                "Opacity",
                            ),
                        );
                        return r;
                    })(),
                ),
                shapeTag === "rect" &&
                    row(
                        "Corner radius",
                        numberInput(
                            parseFloat(el.getAttribute("rx") ?? "0") || 0,
                            (v) => {
                                void sendSvgOps(
                                    [
                                        {
                                            sel,
                                            ops: [
                                                ...boxOps(sel),
                                                {
                                                    kind: "attrs",
                                                    loc: sel.loc,
                                                    set: {
                                                        rx: String(v),
                                                        ry: null,
                                                    },
                                                },
                                            ],
                                        },
                                    ],
                                    "Corner radius",
                                );
                            },
                        ),
                    ),
            ),
        );
        if (el.localName === "text") panel.append(textSection(sel));
        if (textZone) panel.append(textBoxSection(sel));
    }
    if (!zone && src?.writable && movable && isConnector(el)) {
        panel.append(connectorSection(sel));
    }
    if (
        src?.writable &&
        (movable || ed.layoutMode) &&
        !isConnector(el) &&
        el.localName !== "line"
    ) {
        panel.append(connectionPointsSection(sel));
    }
    if (!zone && src?.writable && pictureOf(el)) {
        panel.append(pictureSection(sel));
    }
    if (!zone && src?.writable && drawnDiagram(el)) {
        panel.append(diagramSection(sel));
        const shapes = diagramShapesSection(sel);
        if (shapes) panel.append(shapes);
    }
    if (!zone && src?.writable && (movable || ed.layoutMode)) {
        panel.append(detailsSection(sel));
    }

    if (movable) panel.append(arrangeSection([sel]));
    if (id || zone || src?.writable) panel.append(elementAnimations(sel));
}

// ── Connectors ──

const ARROW = "url(#inkflow-arrow)";

function attachedConnectors(): Selected[] {
    const svg = slideRoot();
    if (!svg) return [];
    return [...svg.querySelectorAll("[data-ink]")]
        .filter(
            (el) =>
                isConnector(el) &&
                canTransform(el) &&
                (el.hasAttribute("inkflow:connect-start") ||
                    el.hasAttribute("inkflow:connect-end")),
        )
        .map((el) => ({
            el: el as SVGGraphicsElement,
            key: parseInt(
                (el.getAttribute("data-ink") ?? "").split(":")[0],
                10,
            ),
            loc: el.getAttribute("data-ink") ?? "",
        }));
}

function reroute(sels: Selected[]): void {
    const plans = sels
        .map((s) => ({ s, d: connectorPath(s.el) }))
        .filter((x): x is { s: Selected; d: string } => !!x.d)
        .map(({ s, d }) => ({
            sel: s,
            ops: [{ kind: "attrs", loc: s.loc, set: { d } }],
        }));
    if (plans.length) void sendSvgOps(plans, "Re-route arrows");
}

function connectorSection(sel: Selected): HTMLElement {
    const el = sel.el;
    const has = (attr: string) =>
        (el.getAttribute(attr) ?? "").includes("inkflow-arrow");
    const heads = has("marker-start")
        ? has("marker-end")
            ? "both"
            : "start"
        : has("marker-end")
          ? "end"
          : "none";
    const send = (
        set: Record<string, string | null>,
        label: string,
        marker = false,
    ) =>
        void sendSvgOps(
            [
                {
                    sel,
                    ops: [
                        ...(marker ? [{ kind: "ensure-marker" }] : []),
                        { kind: "attrs", loc: sel.loc, set },
                    ],
                },
            ],
            label,
        );
    const describe = (which: "start" | "end") => {
        const c = parseConnection(el.getAttribute(`inkflow:connect-${which}`));
        return c ? `${c.id} (${c.site})` : "free";
    };
    return section(
        "Connector",
        row(
            "Route",
            selectInput(
                [
                    { value: "straight", label: "Straight" },
                    { value: "elbow", label: "Elbow" },
                    { value: "curved", label: "Curved" },
                ],
                connectorStyle(el),
                (v) => {
                    const style = v as "straight" | "elbow" | "curved";
                    // A new route starts from its default shape.
                    const d = connectorPath(el, {}, style, null);
                    send(
                        {
                            "inkflow:connector": v,
                            "inkflow:bend": null,
                            ...(d ? { d } : {}),
                        },
                        "Connector route",
                    );
                },
            ),
        ),
        row(
            "Arrowheads",
            selectInput(
                [
                    { value: "none", label: "None" },
                    { value: "end", label: "At the end" },
                    { value: "start", label: "At the start" },
                    { value: "both", label: "Both ends" },
                ],
                heads,
                (v) =>
                    send(
                        {
                            "marker-start":
                                v === "start" || v === "both" ? ARROW : null,
                            "marker-end":
                                v === "end" || v === "both" ? ARROW : null,
                        },
                        "Arrowheads",
                        v !== "none",
                    ),
            ),
        ),
        h(
            "p",
            { class: "hint" },
            `Start: ${describe("start")} · End: ${describe("end")}. Drag an end onto a shape's dot to attach it; Alt while dragging keeps it free.${connectorStyle(el) === "elbow" ? " Drag the yellow handle to move the elbow's middle segment." : ""}`,
        ),
        h(
            "div",
            { class: "btn-row" },
            button(
                "Re-route",
                "Re-attach to the shapes where they are now",
                () => reroute([sel]),
            ),
            el.hasAttribute("inkflow:bend") &&
                button(
                    "Reset bend",
                    "Put the elbow's middle segment back where it goes by default",
                    () => {
                        const d = connectorPath(el, {}, "elbow", null);
                        send(
                            { "inkflow:bend": null, ...(d ? { d } : {}) },
                            "Reset bend",
                        );
                    },
                ),
            button("Detach", "Free both ends", () =>
                send(
                    {
                        "inkflow:connect-start": null,
                        "inkflow:connect-end": null,
                    },
                    "Detach",
                ),
            ),
        ),
    );
}

// How many points on each side an arrow can attach to (inkflow:sites); an
// attached arrow keeps its point when there are fewer later.
function connectionPointsSection(sel: Selected): HTMLElement {
    const n = sitesPerSide(sel.el);
    const box = section(
        "Connection points",
        row(
            "Per side",
            selectInput(
                [1, 2, 3, 4, 5, 7, 9].map((k) => ({
                    value: String(k),
                    label: k === 1 ? "1 (middle)" : String(k),
                })),
                String(n),
                (v) =>
                    void sendSvgOps(
                        [
                            {
                                sel,
                                ops: [
                                    {
                                        kind: "attrs",
                                        loc: sel.loc,
                                        set: {
                                            "inkflow:sites":
                                                v === "1" ? null : v,
                                        },
                                    },
                                ],
                            },
                        ],
                        "Connection points",
                    ),
            ),
        ),
    );
    // Show the points on the slide while the setting is in view.
    box.addEventListener("mouseenter", () =>
        showSites([{ el: sel.el, active: null }]),
    );
    box.addEventListener("mouseleave", () => showSites([]));
    return box;
}

// ── Text boxes ──

// Padding and alignment are CSS custom properties on the zone's shape (the
// same --inkflow-* a layout sets for its zones), so they apply to the text
// wherever it is written: its .md section, deck.py or Inline Markdown.
function textBoxSection(sel: Selected): HTMLElement {
    const el = sel.el as SVGGraphicsElement & ElementCSSInlineStyle;
    const value = (name: string) => el.style.getPropertyValue(name).trim();
    const setVar = (name: string, v: string | null, label: string) =>
        void sendSvgOps(
            [
                {
                    sel,
                    ops: [{ kind: "style", loc: sel.loc, set: { [name]: v } }],
                },
            ],
            label,
        );
    const shown = el.hasAttribute("inkflow:show-shape");
    const box = h("input", { type: "checkbox" });
    box.checked = shown;
    box.addEventListener(
        "change",
        () =>
            void sendSvgOps(
                [
                    {
                        sel,
                        ops: [
                            {
                                kind: "attrs",
                                loc: sel.loc,
                                set: {
                                    "inkflow:show-shape": box.checked
                                        ? "true"
                                        : null,
                                },
                            },
                        ],
                    },
                ],
                box.checked ? "Show box" : "Hide box",
            ),
    );
    const padding = parseFloat(value("--inkflow-padding"));
    return section(
        "Text box",
        row("Draw the box", box),
        row(
            "Padding",
            numberInput(
                Number.isFinite(padding) ? padding : null,
                (v) =>
                    setVar(
                        "--inkflow-padding",
                        `${Math.max(0, v)}px`,
                        "Padding",
                    ),
                {
                    min: 0,
                    placeholder: "auto",
                    onClear: () => setVar("--inkflow-padding", null, "Padding"),
                },
            ),
        ),
        row(
            "Align",
            selectInput(
                [
                    { value: "", label: "Default" },
                    { value: "left", label: "Left" },
                    { value: "center", label: "Centre" },
                    { value: "right", label: "Right" },
                    { value: "justify", label: "Justify" },
                ],
                value("--inkflow-align"),
                (v) => setVar("--inkflow-align", v || null, "Text align"),
            ),
        ),
        row(
            "Vertical",
            selectInput(
                [
                    { value: "", label: "Default" },
                    { value: "start", label: "Top" },
                    { value: "center", label: "Middle" },
                    { value: "end", label: "Bottom" },
                ],
                value("--inkflow-valign"),
                (v) => setVar("--inkflow-valign", v || null, "Vertical align"),
            ),
        ),
    );
}

// ── Pictures (free images on the slide) ──

const FITS: { value: string; label: string; par: string }[] = [
    { value: "contain", label: "Fit inside", par: "xMidYMid meet" },
    { value: "cover", label: "Fill (crop edges)", par: "xMidYMid slice" },
    { value: "stretch", label: "Stretch", par: "none" },
];

function pictureSection(sel: Selected): HTMLElement {
    const image = pictureOf(sel.el)!;
    const loc = image.getAttribute("data-ink") ?? sel.loc;
    const src = sourceOf(sel.key);
    // A PDF picture shows its page converted to SVG; this is the PDF.
    const href = sourceRef(image);
    const pdf = isPdfRef(href) ? projectFile(href) : null;
    const par = image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f) => f.par === par)?.value ?? "contain";
    const imageOps = (set: Record<string, string | null>, label: string) =>
        void sendSvgOps([{ sel, ops: [{ kind: "attrs", loc, set }] }], label);
    const cropped = isCropped(sel.el);
    return section(
        "Picture",
        h(
            "div",
            { class: "source-hint" },
            h("p", { class: "hint media-src" }, pictureName(href)),
            openButton(projectFile(href)),
            renameButton(projectFile(href)),
        ),
        pdf ? pdfPageRow(sel, image, pdf, pdfPage(href), imageOps) : null,
        isDiagramHref(href)
            ? h(
                  "div",
                  { class: "btn-row" },
                  button(
                      "Edit diagram",
                      "Open it in draw.io (or double-click it)",
                      () => editDiagram(sel),
                      "on",
                  ),
              )
            : null,
        isDiagramHref(href) && !cropped ? showAsRow(sel, "picture") : null,
        h(
            "div",
            { class: "btn-row" },
            button(
                "Replace…",
                "Pick another picture; it keeps this size and place",
                async () => {
                    const file = await pickFile(IMAGE_ACCEPT);
                    const up = file && src ? await upload(file) : null;
                    if (!up || !src) return;
                    let page = 1;
                    if (isPdfRef(up.path)) {
                        const choice = await choosePage(up.path);
                        if (!choice) return;
                        page = choice.page;
                    }
                    imageOps(
                        {
                            href: withPage(
                                relativePath(src.path, up.path),
                                page,
                            ),
                            "xlink:href": null,
                        },
                        "Replace picture",
                    );
                },
            ),
            ed.cropMode
                ? button(
                      "Done cropping",
                      "Enter",
                      () => setCropMode(false),
                      "on",
                  )
                : button(
                      "Crop",
                      "Crop (double-click the picture)",
                      () => void startCrop(sel),
                  ),
            cropped
                ? button(
                      "Reset crop",
                      "Show the whole picture again",
                      () => void resetCrop(sel),
                  )
                : null,
        ),
        row(
            "Fit",
            selectInput(
                FITS.map((f) => ({ value: f.value, label: f.label })),
                fit,
                (v) =>
                    imageOps(
                        {
                            preserveAspectRatio:
                                FITS.find((f) => f.value === v)?.par ?? null,
                        },
                        "Picture fit",
                    ),
            ),
        ),
        backgroundRow(image.getAttribute("inkflow:background"), (v) =>
            imageOps({ "inkflow:background": v }, "Picture background"),
        ),
    );
}

function pictureName(ref: string): string {
    const name = ref.replace(/#.*$/, "").split("/").pop() ?? ref;
    return isPdfRef(ref) ? `${name} · page ${pdfPage(ref)}` : name;
}

// The page a PDF picture shows. A new page keeps the picture's width and
// takes the page's shape (a cropped picture keeps its frame).
function pdfPageRow(
    sel: Selected,
    image: Element,
    file: string,
    page: number,
    imageOps: (set: Record<string, string | null>, label: string) => void,
): HTMLElement {
    const show = async (n: number, shown?: string | null) => {
        const url = shown ?? (await pageUrl(file, n));
        const src = sourceOf(sel.key);
        const root = ed.model?.projectDir;
        if (!url || !src || !root || n === page) return;
        const set: Record<string, string | null> = {
            href: withPage(relativePath(src.path, `${root}/${file}`), n),
            "xlink:href": null,
        };
        const width = Number.parseFloat(image.getAttribute("width") ?? "");
        if (!isCropped(sel.el) && width > 0) {
            const size = await naturalSize(url);
            set.height = fmt((width * size.h) / size.w);
        }
        imageOps(set, `Show page ${n}`);
    };
    // A <div>, not row()'s <label>, which would pass clicks to the button.
    return h(
        "div",
        { class: "prop-row" },
        h("span", { class: "prop-label" }, "Page"),
        numberInput(page, (n) => void show(Math.max(1, Math.round(n))), {
            min: 1,
        }),
        button("Pages…", "See the PDF's pages and pick one", async () => {
            const choice = await choosePage(file, page);
            if (choice) void show(choice.page, choice.url);
        }),
    );
}

// How a draw.io diagram shows on the slide: its picture, or drawn into the
// slide (the pipeline's drawio_inline.py), where its shapes can be animated
// and its text takes the deck's font, and, themed, the deck's colours.
function showAsRow(sel: Selected, mode: DiagramMode): HTMLElement {
    return row(
        "Show as",
        selectInput(
            DIAGRAM_MODES.map((m) => ({ value: m.value, label: m.label })),
            mode,
            (v) =>
                void sendSvgOps(
                    [
                        {
                            sel,
                            ops: [
                                // Its shapes are named after it.
                                {
                                    kind: "ensure-id",
                                    loc: sel.loc,
                                    base: "diagram",
                                    key: "diagram",
                                },
                                {
                                    kind: "attrs",
                                    loc: sel.loc,
                                    set: {
                                        "inkflow:drawio":
                                            v === "picture" ? null : v,
                                    },
                                },
                            ],
                        },
                    ],
                    "Show diagram as",
                ),
        ),
    );
}

function diagramSection(sel: Selected): HTMLElement {
    const svg = drawnDiagram(sel.el)!;
    const href = svg.getAttribute("data-drawio") ?? "";
    const par = svg.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f) => f.par === par)?.value ?? "contain";
    return section(
        "draw.io",
        h(
            "div",
            { class: "source-hint" },
            h("p", { class: "hint media-src" }, href.split("/").pop() ?? href),
            openButton(projectFile(href)),
            renameButton(projectFile(href)),
        ),
        h(
            "div",
            { class: "btn-row" },
            button(
                "Edit diagram",
                "Open it in draw.io (or double-click it)",
                () => editDiagram(sel),
                "on",
            ),
        ),
        showAsRow(sel, diagramMode(svg)),
        editShapesRow(sel, svg),
        row(
            "Fit",
            selectInput(
                FITS.map((f) => ({ value: f.value, label: f.label })),
                fit,
                (v) =>
                    void sendSvgOps(
                        [
                            {
                                sel,
                                ops: [
                                    {
                                        kind: "attrs",
                                        loc: sel.loc,
                                        set: {
                                            preserveAspectRatio:
                                                FITS.find((f) => f.value === v)
                                                    ?.par ?? null,
                                        },
                                    },
                                ],
                            },
                        ],
                        "Diagram fit",
                    ),
            ),
        ),
        backgroundRow(
            svg.getAttribute("inkflow:background"),
            (v) =>
                void sendSvgOps(
                    [
                        {
                            sel,
                            ops: [
                                {
                                    kind: "attrs",
                                    loc: sel.loc,
                                    set: { "inkflow:background": v },
                                },
                            ],
                        },
                    ],
                    "Diagram background",
                ),
        ),
    );
}

// "Edit shapes here": double-clicking the diagram selects its shapes, which
// are then moved, resized, relabelled, recoloured or deleted on the slide, in
// the diagram's draw.io source (editor/drawioedit.py). Off, double-click
// opens draw.io. Kept on the picture as inkflow:drawio-edit="shapes".
function editShapesRow(sel: Selected, svg: Element): HTMLElement {
    const on = shapesEditable(svg);
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = on;
    box.addEventListener("change", () => {
        void sendSvgOps(
            [
                {
                    sel,
                    ops: [
                        {
                            kind: "attrs",
                            loc: sel.loc,
                            set: {
                                "inkflow:drawio-edit": box.checked
                                    ? "shapes"
                                    : null,
                            },
                        },
                    ],
                },
            ],
            box.checked
                ? "Edit diagram shapes here"
                : "Edit diagram in draw.io",
        );
    });
    return h(
        "div",
        {},
        h("label", { class: "check-row" }, box, " Edit shapes here"),
        h(
            "p",
            { class: "hint" },
            on
                ? "Double-click the diagram to select its shapes: move, resize, relabel, recolour or delete them here. draw.io redraws the diagram after each change (it needs to load, like Edit diagram)."
                : "Double-click opens draw.io. Turn this on to edit the diagram's shapes on the slide instead; the diagram stays a draw.io diagram.",
        ),
    );
}

// The diagram's shapes, each with its animations' count and a picker that
// animates it (the shape is named <diagram id>-<draw.io cell id>).
function diagramShapesSection(sel: Selected): HTMLElement | null {
    const slide = currentSlide();
    const model = ed.model;
    const svg = drawnDiagram(sel.el);
    if (!slide || !model || !svg) return null;
    const shapes = diagramShapes(svg);
    if (!shapes.length) return null;
    const editable = slide.animationsEditable && model.deckEditable;
    const list = h("div", { class: "diagram-shapes" });
    const flash = (el: Element, on: boolean) => setHover(on ? el : null);
    for (const shape of shapes) {
        const count = slide.animations.filter(
            (c) => c.element === shape.id,
        ).length;
        const name = shape.label || `(${shape.id.slice(svg.id.length + 1)})`;
        const item = h(
            "div",
            { class: "diagram-shape" },
            h(
                "span",
                { class: "diagram-shape-name", title: `#${shape.id}` },
                name,
            ),
            count
                ? h(
                      "span",
                      {
                          class: "hint",
                          title: "Animations on this shape (see Animation order)",
                      },
                      `${count} ✦`,
                  )
                : null,
        );
        item.addEventListener("mouseenter", () => flash(shape.el, true));
        item.addEventListener("mouseleave", () => flash(shape.el, false));
        if (editable) {
            const add = animationPicker(
                model.animationTypes,
                false,
                "Animate…",
            );
            add.addEventListener("change", () => {
                if (!add.value) return;
                flash(shape.el, false);
                void edit({
                    action: "anim",
                    slide: slide.deckIndex,
                    op: "insert",
                    index: slide.animations.length,
                    spec: { type: add.value, element: shape.id, fields: {} },
                });
            });
            item.append(add);
        }
        list.append(item);
    }
    return section(
        "Shapes",
        h(
            "p",
            { class: "hint" },
            "Animate the diagram's shapes one by one. To change a shape, edit the diagram in draw.io.",
        ),
        list,
    );
}

// What a picture shows through: figures made for paper (a PDF from LaTeX, a
// plot as SVG or a transparent PNG) draw dark lines on nothing, invisible on a
// dark deck. A background behind them (backgrounds.py) fixes that.
function backgroundRow(
    current: FieldValue,
    commit: (v: string | null) => void,
): HTMLElement {
    const value = typeof current === "string" ? current : "";
    const named = ["", "paper", "surface"];
    const choice = named.includes(value) ? value : "custom";
    const colour = h("input", {
        type: "color",
        title: "Background colour",
        value: /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff",
    }) as HTMLInputElement;
    colour.hidden = choice !== "custom";
    colour.addEventListener("change", () => commit(colour.value));
    const select = selectInput(
        [
            { value: "", label: "None" },
            { value: "paper", label: "Paper (white)" },
            { value: "surface", label: "Theme surface" },
            { value: "custom", label: "Colour…" },
        ],
        choice,
        (v) => {
            if (v === "custom") {
                colour.hidden = false;
                commit(colour.value);
            } else commit(v || null);
        },
    );
    return h(
        "div",
        { class: "prop-row" },
        h(
            "span",
            {
                class: "prop-label",
                title: "Painted behind the picture, so a figure with a transparent background stays visible on a dark slide",
            },
            "Background",
        ),
        select,
        colour,
    );
}

// The object's link, as the editor writes it (an <a> around the object), and
// as the pipeline renders a slide link (data-inkflow-slide, no href).
function linkOf(el: Element): string {
    const a = el.parentElement;
    if (a?.localName !== "a") return "";
    const slide = a.getAttribute("data-inkflow-slide");
    if (slide) return `slide:${slide}`;
    return a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? "";
}

// A bare number is a slide number (as shown in the slide list).
function slideLinkByNumber(n: number): string | null {
    const s = ed.model?.slides[n - 1];
    return s?.id ? `slide:${s.id}` : null;
}

function slideOptions(): HTMLDataListElement {
    const list = h("datalist", { id: "slide-link-list" });
    for (const s of ed.model?.slides ?? []) {
        if (!s.id) continue;
        list.append(h("option", { value: `slide:${s.id}` }, s.title ?? s.id));
    }
    return list;
}

// Link and alt text. Alt text is the object's <title>, which screen readers
// read and browsers show as a tooltip.
function detailsSection(sel: Selected): HTMLElement {
    const title =
        [...sel.el.children].find((c) => c.localName === "title")
            ?.textContent ?? "";
    const link = textInput(
        linkOf(sel.el),
        (v) =>
            void sendSvgOps(
                [
                    {
                        sel,
                        ops: [
                            {
                                kind: "link",
                                loc: sel.loc,
                                href: /^\d+$/.test(v.trim())
                                    ? slideLinkByNumber(Number(v))
                                    : v.trim() || null,
                            },
                        ],
                    },
                ],
                v.trim() ? "Link" : "Remove link",
            ),
        "https://… or slide:id",
    );
    link.setAttribute("list", "slide-link-list");
    return section(
        "Link & alt text",
        slideOptions(),
        row("Link", link),
        row(
            "Alt text",
            textInput(
                title,
                (v) =>
                    void sendSvgOps(
                        [
                            {
                                sel,
                                ops: [{ kind: "title", loc: sel.loc, text: v }],
                            },
                        ],
                        "Alt text",
                    ),
                "Describe it for screen readers",
            ),
        ),
    );
}

function textSection(sel: Selected): HTMLElement {
    const el = sel.el;
    const cs = getComputedStyle(el);
    const spans = [...el.querySelectorAll("tspan")];
    const setAll = (set: Record<string, string | null>, label: string) => {
        const plans = [
            { sel, ops: [{ kind: "style", loc: sel.loc, set } as SvgOp] },
        ];
        // Inkscape often repeats font properties on each line's tspan.
        for (const t of spans) {
            const loc = t.getAttribute("data-ink");
            const style = t.getAttribute("style") ?? "";
            const touched = Object.keys(set).some(
                (k) => style.includes(`${k}:`) || t.hasAttribute(k),
            );
            if (loc && touched) {
                plans[0].ops.push({ kind: "style", loc, set });
            }
        }
        void sendSvgOps(plans, label);
    };
    const bold = parseInt(cs.fontWeight, 10) >= 600;
    const italic = cs.fontStyle === "italic";
    const anchor = cs.textAnchor;
    return section(
        "Text",
        row(
            "Size",
            numberInput(parseFloat(cs.fontSize), (v) =>
                setAll({ "font-size": `${v}px` }, "Font size"),
            ),
        ),
        row(
            "Font",
            textInput(
                cs.fontFamily,
                (v) => setAll({ "font-family": v || null }, "Font"),
                "font-family",
            ),
        ),
        h(
            "div",
            { class: "btn-row" },
            button(
                h("b", {}, "B"),
                "Bold",
                () => setAll({ "font-weight": bold ? null : "bold" }, "Bold"),
                bold ? "on" : "",
            ),
            button(
                h("i", {}, "I"),
                "Italic",
                () =>
                    setAll(
                        { "font-style": italic ? null : "italic" },
                        "Italic",
                    ),
                italic ? "on" : "",
            ),
            button(
                "⟸",
                "Align start",
                () => setAll({ "text-anchor": null }, "Align"),
                anchor === "start" ? "on" : "",
            ),
            button(
                "⇔",
                "Align middle",
                () => setAll({ "text-anchor": "middle" }, "Align"),
                anchor === "middle" ? "on" : "",
            ),
            button(
                "⟹",
                "Align end",
                () => setAll({ "text-anchor": "end" }, "Align"),
                anchor === "end" ? "on" : "",
            ),
            button("Edit", "Edit text (double-click)", () => emit("edit-text")),
        ),
    );
}

function geometrySection(sels: Selected[]): HTMLElement {
    const box = sels.length === 1 ? slideBox(sels[0].el) : selectionBox();
    if (!box) return h("div");
    const resizeTo = (to: Box) => {
        const plans = sels.map((s) => {
            const b = slideBox(s.el)!;
            const sx = box.width ? to.width / box.width : 1;
            const sy = box.height ? to.height / box.height : 1;
            const target = {
                x: to.x + (b.x - box.x) * sx,
                y: to.y + (b.y - box.y) * sy,
                width: b.width * sx,
                height: b.height * sy,
            };
            const plan = planResize(elementGeom(s.el), b, target);
            return {
                sel: s,
                ops: [{ kind: "attrs", loc: s.loc, set: plan } as SvgOp],
            };
        });
        void sendSvgOps(plans, "Resize");
    };
    const rot =
        sels.length === 1
            ? rotationOf(parseTransform(sels[0].el.getAttribute("transform")))
            : 0;
    return section(
        "Position & size",
        h(
            "div",
            { class: "grid2" },
            row(
                "X",
                numberInput(box.x, (v) => resizeTo({ ...box, x: v })),
            ),
            row(
                "Y",
                numberInput(box.y, (v) => resizeTo({ ...box, y: v })),
            ),
            row(
                "W",
                numberInput(
                    box.width,
                    (v) => resizeTo({ ...box, width: Math.max(1, v) }),
                    { min: 1 },
                ),
            ),
            row(
                "H",
                numberInput(
                    box.height,
                    (v) => resizeTo({ ...box, height: Math.max(1, v) }),
                    { min: 1 },
                ),
            ),
        ),
        sels.length === 1 &&
            row(
                "Rotation",
                numberInput(
                    rot,
                    (v) => {
                        const s = sels[0];
                        const center = {
                            x: box.x + box.width / 2,
                            y: box.y + box.height / 2,
                        };
                        const plan = planRotate(
                            elementGeom(s.el),
                            v - rot,
                            center,
                        );
                        void sendSvgOps(
                            [
                                {
                                    sel: s,
                                    ops: [
                                        {
                                            kind: "attrs",
                                            loc: s.loc,
                                            set: plan,
                                        },
                                    ],
                                },
                            ],
                            "Rotate",
                        );
                    },
                    { step: 1 },
                ),
            ),
    );
}

function arrangeSection(sels: Selected[]): HTMLElement {
    const order = (to: string) =>
        void sendSvgOps(
            sels.map((s) => ({
                sel: s,
                ops: [{ kind: "order", loc: s.loc, to }],
            })),
            "Arrange",
        );
    const isGroup = sels.length === 1 && sels[0].el.localName === "g";
    return section(
        "Arrange",
        h(
            "div",
            { class: "btn-row" },
            button("⇈", "Bring to front (Ctrl+Shift+↑)", () => order("front")),
            button("↑", "Bring forward (Ctrl+↑)", () => order("forward")),
            button("↓", "Send backward (Ctrl+↓)", () => order("backward")),
            button("⇊", "Send to back (Ctrl+Shift+↓)", () => order("back")),
            button(icon("copy", 14), "Duplicate (Ctrl+D)", () =>
                emit("duplicate"),
            ),
            sels.length > 1 &&
                button(icon("group", 14), "Group (Ctrl+G)", () =>
                    emit("group"),
                ),
            isGroup &&
                button("Ungroup", "Ungroup (Ctrl+Shift+G)", () =>
                    emit("ungroup"),
                ),
            button(
                icon("trash", 14),
                "Delete (Del)",
                () => emit("delete"),
                "danger",
            ),
        ),
    );
}

// ── Several objects ──

export function alignSelection(how: string): void {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    const boxes = sels.map((s) => slideBox(s.el)!);
    const ref = sels.length === 1 ? slideSize() : selectionBox()!;
    let targetsX = boxes.map((b) => b.x);
    let targetsY = boxes.map((b) => b.y);
    switch (how) {
        case "left":
            targetsX = boxes.map(() => ref.x);
            break;
        case "center":
            targetsX = boxes.map((b) => ref.x + (ref.width - b.width) / 2);
            break;
        case "right":
            targetsX = boxes.map((b) => ref.x + ref.width - b.width);
            break;
        case "top":
            targetsY = boxes.map(() => ref.y);
            break;
        case "middle":
            targetsY = boxes.map((b) => ref.y + (ref.height - b.height) / 2);
            break;
        case "bottom":
            targetsY = boxes.map((b) => ref.y + ref.height - b.height);
            break;
        case "hspace":
            targetsX = distribute(boxes, "x");
            break;
        case "vspace":
            targetsY = distribute(boxes, "y");
            break;
    }
    const plans = sels.map((s, i) => ({
        sel: s,
        ops: moveOps(s, targetsX[i] - boxes[i].x, targetsY[i] - boxes[i].y),
    }));
    void sendSvgOps(plans, "Align");
}

function renderMultiPanel(): void {
    const sels = ed.selection;
    const movable = sels.every((s) => canTransform(s.el));
    panel.append(section(`${sels.length} objects`));
    if (movable) {
        const a = (label: string, title: string, how: string) =>
            button(label, title, () => alignSelection(how));
        panel.append(
            section(
                "Align",
                h(
                    "div",
                    { class: "btn-row" },
                    a("⇤", "Align left", "left"),
                    a("↔", "Align centre", "center"),
                    a("⇥", "Align right", "right"),
                    a("⤒", "Align top", "top"),
                    a("↕", "Align middle", "middle"),
                    a("⤓", "Align bottom", "bottom"),
                ),
                h(
                    "div",
                    { class: "btn-row" },
                    a("⇹ Distribute", "Distribute horizontally", "hspace"),
                    a("⇳ Distribute", "Distribute vertically", "vspace"),
                ),
            ),
        );
        panel.append(geometrySection(sels));
        const styleable = sels.filter(
            (s) => !isZone(s.el) && s.el.localName !== "image",
        );
        if (styleable.length === sels.length) {
            panel.append(
                section(
                    "Style",
                    paintRow(sels, "fill"),
                    paintRow(sels, "stroke"),
                ),
            );
        }
        panel.append(arrangeSection(sels));
    }
}

// ── Wiring ──

export function renderProps(): void {
    const active = document.activeElement;
    if (active && panel.contains(active) && typingIn(active)) {
        // Do not yank the control being typed in; refresh once it loses focus.
        // (A clicked button or checkbox keeps focus too: nothing to lose.)
        refreshOnBlur = true;
        return;
    }
    clear(panel);
    if (!ed.model) return;
    if (ed.selection.length === 0) renderSlidePanel();
    else if (ed.selection.length === 1) renderObjectPanel(ed.selection[0]);
    else renderMultiPanel();
}

let refreshOnBlur = false;

function typingIn(el: Element): boolean {
    if (el.localName === "textarea" || (el as HTMLElement).isContentEditable)
        return true;
    if (el.localName !== "input") return false;
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "range", "button", "color"].includes(type);
}

export function initProps(): void {
    on("selection", renderProps);
    on("render", renderProps);
    on("preview", renderProps);
    // Esc in a field of the panel keeps what was typed (leaving the field
    // commits it) and gives the keys back to the slide; inside a diagram's
    // shapes it also leaves the diagram, as Esc does from the slide.
    panel.addEventListener("keydown", (e) => {
        const field = e.target as HTMLElement;
        if (e.key !== "Escape" || !typingIn(field)) return;
        e.preventDefault();
        field.blur();
        if (ed.scope?.closest("svg[data-drawio]")) enterGroup(null);
    });
    panel.addEventListener("focusout", () => {
        window.setTimeout(() => {
            if (refreshOnBlur && !panel.contains(document.activeElement)) {
                refreshOnBlur = false;
                renderProps();
            }
        }, 0);
    });
}
