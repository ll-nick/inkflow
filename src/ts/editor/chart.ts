// Charts in the editor: the chart dialog (a spreadsheet-like grid for the
// data, the chart's settings, and a live preview the server draws with the
// build's own renderer, so what it shows is what the slide will show).
//
// "Insert chart" places a new chart: the server writes the grid to a new
// data/chart-N.csv, adds a zone rect to the slide's SVG and fills it with
// Chart(...) through zones={...}, in one undoable step. "Edit data…" on a
// placed chart opens the same dialog on its file and writes it back.

import { slideBox, slideRoot } from "./canvas";
import {
    addColumn,
    addRow,
    CHART_KINDS,
    type ChartSettings,
    defaultSettings,
    type Grid,
    isMultiCell,
    numericColumns,
    parseClipboard,
    pasteCells,
    plotted,
    removeColumn,
    removeRow,
    renameColumn,
    sampleGrid,
    secondAxisAllowed,
    toggleRight,
    toggleSeries,
    trimmed,
    xColumn,
} from "./chartgrid";
import { closeDialog, openDialog } from "./dialog";
import { clear, h, icon, toast } from "./dom";
import {
    afterRender,
    ensureOwnDrawing,
    insertParent,
    ownSource,
    toParent,
} from "./insert";
import { edit, request } from "./net";
import { currentSlide, ed } from "./state";
import type { FieldValue, ZoneValue } from "./types";

type Target =
    | { kind: "insert"; at?: { x: number; y: number } }
    | { kind: "edit"; slide: number; zone: string; src: string | null };

/** A chart zone's settings, as the editor model sends them. */
export function chartSettings(value: ZoneValue): ChartSettings {
    const f = (value.fields ?? {}) as Record<string, FieldValue | string[]>;
    const s = defaultSettings();
    return {
        kind: typeof f.kind === "string" ? f.kind : s.kind,
        x: typeof f.x === "string" ? f.x : null,
        y: Array.isArray(f.y) ? f.y : null,
        title: typeof f.title === "string" ? f.title : null,
        stacked: f.stacked === true,
        horizontal: f.horizontal === true,
        legend: typeof f.legend === "boolean" ? f.legend : null,
        labels: f.labels === true,
        donut: f.donut === true,
        y_min: typeof f.y_min === "number" ? f.y_min : null,
        y_max: typeof f.y_max === "number" ? f.y_max : null,
        y2: Array.isArray(f.y2) ? f.y2 : null,
        y2_min: typeof f.y2_min === "number" ? f.y2_min : null,
        y2_max: typeof f.y2_max === "number" ? f.y2_max : null,
    };
}

/** A number field where empty means "from the data" (null). */
export function rangeInput(
    value: number | null,
    commit: (v: number | null) => void,
    placeholder = "auto",
): HTMLInputElement {
    const input = h("input", {
        type: "number",
        step: "any",
        class: "chart-range",
        placeholder,
        value: value == null ? "" : String(value),
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
        const v = input.value.trim();
        commit(v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    });
    return input;
}

// The size a new chart gets: 60% of the slide's width, 16:9.
function newChartBox(at?: { x: number; y: number }) {
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    const vh = vb?.height || 1080;
    const w = Math.round(vw * 0.6);
    const ht = Math.round((w * 9) / 16);
    const cx = Math.min(Math.max(at?.x ?? vw / 2, w / 2), vw - w / 2);
    const cy = Math.min(Math.max(at?.y ?? vh / 2, ht / 2), vh - ht / 2);
    return { x: cx - w / 2, y: cy - ht / 2, width: w, height: ht };
}

export async function insertChart(at?: { x: number; y: number }) {
    const slide = currentSlide();
    if (!slide) return;
    if (!ed.model?.deckEditable) {
        toast(
            "deck.py builds its slides in code; cannot add a chart here",
            "error",
        );
        return;
    }
    openChartDialog({ kind: "insert", at }, sampleGrid(), defaultSettings());
}

/** "Edit data…": the chart in zone `zone` of the current slide. */
export async function editChart(zone: string): Promise<void> {
    const slide = currentSlide();
    const value = slide?.zones[zone];
    if (!slide || value?.kind !== "chart") return;
    const res = await request({
        action: "chart-data",
        slide: slide.deckIndex,
        zone,
    });
    if (!res.ok) {
        toast(res.error ?? "Cannot read the chart's data", "error");
        return;
    }
    const grid: Grid = {
        columns: res.columns as string[],
        rows: res.rows as string[][],
    };
    openChartDialog(
        {
            kind: "edit",
            slide: slide.deckIndex,
            zone,
            src: (res.src as string | null) ?? null,
        },
        grid,
        chartSettings(value),
    );
}

function openChartDialog(
    target: Target,
    initial: Grid,
    initialSettings: ChartSettings,
): void {
    let grid = initial;
    let settings = initialSettings;
    let timer = 0;
    let asked = 0;
    // The preview is drawn at the size the chart has (or will have).
    let size = newChartBox();
    if (target.kind === "edit") {
        const el = slideRoot()?.querySelector(`[id="zone-${target.zone}"]`);
        const box = el ? slideBox(el) : null;
        if (box) size = { ...size, width: box.width, height: box.height };
    }

    const table = h("table", { class: "chart-grid" });
    const fields = h("div", { class: "chart-fields" });
    const preview = h("div", { class: "chart-preview" });
    preview.style.aspectRatio = `${size.width} / ${size.height}`;
    const status = h("span", { class: "hint chart-status" });

    const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void drawPreview(), 200);
    };

    async function drawPreview(): Promise<void> {
        const mine = ++asked;
        const slide = currentSlide();
        const res = await request({
            action: "chart-preview",
            slide: slide?.deckIndex,
            zone: target.kind === "edit" ? target.zone : null,
            chart: settings,
            table: trimmed(grid),
            width: size.width,
            height: size.height,
        });
        if (mine !== asked) return; // a newer preview is on its way
        if (!res.ok) {
            status.textContent = res.error ?? "Cannot draw the chart";
            return;
        }
        status.textContent = "";
        // Drawn by inkflow.charts on the server: every text in it is escaped.
        preview.innerHTML = String(res.svg ?? "");
    }

    // ── The grid ──

    function cellInput(row: number, col: number, value: string) {
        const input = h("input", {
            type: "text",
            value,
            "data-row": row,
            "data-col": col,
            spellcheck: "false",
        });
        if (row < 0) {
            input.classList.add("chart-head");
            input.addEventListener("change", () => {
                const r = renameColumn(grid, col, input.value, settings);
                grid = r.grid;
                settings = r.settings;
                renderAll();
            });
        } else {
            input.addEventListener("input", () => {
                grid.rows[row][col] = input.value;
                schedule();
            });
            // Whether a column holds numbers decides the series offered.
            input.addEventListener("change", renderFields);
        }
        input.addEventListener("keydown", (e) => {
            if (
                e.key === "Enter" ||
                e.key === "ArrowDown" ||
                e.key === "ArrowUp"
            ) {
                e.preventDefault();
                const down = e.key !== "ArrowUp";
                let next = row + (down ? 1 : -1);
                if (down && next >= grid.rows.length && e.key === "Enter") {
                    grid = addRow(grid);
                    renderGrid();
                }
                next = Math.max(-1, Math.min(next, grid.rows.length - 1));
                focusCell(next, col);
            }
        });
        return input;
    }

    function focusCell(row: number, col: number): void {
        const input = table.querySelector<HTMLInputElement>(
            `input[data-row="${row}"][data-col="${col}"]`,
        );
        input?.focus();
        input?.select();
    }

    function renderGrid(): void {
        clear(table);
        const head = h(
            "tr",
            {},
            h("th", { class: "chart-corner" }),
            ...grid.columns.map((name, c) =>
                h(
                    "th",
                    {},
                    h(
                        "div",
                        { class: "chart-th" },
                        cellInput(-1, c, name),
                        h(
                            "button",
                            {
                                type: "button",
                                class: "chart-x",
                                title: `Remove column "${name}"`,
                                disabled: grid.columns.length <= 1,
                                onclick: () => {
                                    const r = removeColumn(grid, c, settings);
                                    grid = r.grid;
                                    settings = r.settings;
                                    renderAll();
                                },
                            },
                            "×",
                        ),
                    ),
                ),
            ),
        );
        const body = grid.rows.map((cells, r) =>
            h(
                "tr",
                {},
                h(
                    "th",
                    { class: "chart-rownum" },
                    h(
                        "button",
                        {
                            type: "button",
                            class: "chart-x",
                            title: `Remove row ${r + 1}`,
                            onclick: () => {
                                grid = removeRow(grid, r);
                                renderAll();
                            },
                        },
                        String(r + 1),
                    ),
                ),
                ...grid.columns.map((_, c) =>
                    h("td", {}, cellInput(r, c, cells[c] ?? "")),
                ),
            ),
        );
        table.append(h("thead", {}, head), h("tbody", {}, ...body));
    }

    // Cells copied from a spreadsheet land from the cell pasted into on.
    table.addEventListener("paste", (e) => {
        const input = e.target as HTMLInputElement;
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (!input.dataset.row || !isMultiCell(text)) return;
        e.preventDefault();
        grid = pasteCells(
            grid,
            Number(input.dataset.row),
            Number(input.dataset.col),
            parseClipboard(text),
        );
        renderAll();
    });

    // ── Settings ──

    function check(label: string, on: boolean, set: (v: boolean) => void) {
        const box = h("input", { type: "checkbox" });
        box.checked = on;
        box.addEventListener("change", () => {
            set(box.checked);
            renderFields();
        });
        return h("label", { class: "chart-check" }, box, label);
    }

    function select(
        options: { value: string; label: string }[],
        value: string,
        set: (v: string) => void,
    ) {
        const sel = h("select", {});
        for (const o of options) {
            const opt = h("option", { value: o.value }, o.label);
            opt.selected = o.value === value;
            sel.append(opt);
        }
        sel.addEventListener("change", () => {
            set(sel.value);
            renderFields();
        });
        return sel;
    }

    function field(label: string, control: Node) {
        return h(
            "label",
            { class: "chart-field" },
            h("span", {}, label),
            control,
        );
    }

    function renderFields(): void {
        clear(fields);
        const numeric = numericColumns(grid);
        const x = xColumn(grid, settings);
        const shown = plotted(grid, settings);
        const kind = settings.kind;
        const title = h("input", {
            type: "text",
            value: settings.title ?? "",
            placeholder: "none",
        });
        title.addEventListener("input", () => {
            settings.title = title.value.trim() || null;
            schedule();
        });
        fields.append(
            field(
                "Kind",
                select(CHART_KINDS, kind, (v) => {
                    settings.kind = v;
                }),
            ),
            field(
                kind === "scatter"
                    ? "X values"
                    : kind === "pie"
                      ? "Slices"
                      : "Categories",
                select(
                    grid.columns.map((c) => ({ value: c, label: c })),
                    x ?? "",
                    (v) => {
                        settings.x = v === grid.columns[0] ? null : v;
                    },
                ),
            ),
            field("Title", title),
        );
        const series = h("div", { class: "chart-series" });
        const choices = grid.columns.filter((c) => c !== x);
        const twoAxes = secondAxisAllowed(settings);
        for (const c of choices) {
            const usable = numeric.includes(c);
            const box = check(c, shown.includes(c), (on) => {
                settings.y = toggleSeries(grid, settings, c, on);
                if (!on) settings.y2 = toggleRight(settings, c, false);
            });
            if (!usable) {
                box.classList.add("off");
                box.title = "Not all numbers";
            }
            if (twoAxes && usable && shown.includes(c)) {
                const right = check(
                    "right axis",
                    (settings.y2 ?? []).includes(c),
                    (on) => {
                        settings.y2 = toggleRight(settings, c, on);
                    },
                );
                right.classList.add("chart-right");
                right.title = `Draw ${c} against a second axis, on the right`;
                series.append(
                    h("span", { class: "chart-series-row" }, box, right),
                );
            } else series.append(box);
        }
        fields.append(
            h(
                "div",
                { class: "chart-field" },
                h("span", {}, kind === "pie" ? "Sizes (first)" : "Series"),
                choices.length
                    ? series
                    : h("span", { class: "hint" }, "Add a column of numbers"),
            ),
        );
        const opts = h("div", { class: "chart-options" });
        if (kind === "bar" || kind === "area") {
            opts.append(
                check("Stacked", settings.stacked, (v) => {
                    settings.stacked = v;
                }),
            );
        }
        if (kind === "bar") {
            opts.append(
                check("Horizontal", settings.horizontal, (v) => {
                    settings.horizontal = v;
                }),
            );
        }
        if (kind === "pie") {
            opts.append(
                check("Donut", settings.donut, (v) => {
                    settings.donut = v;
                }),
            );
        }
        opts.append(
            check("Value labels", settings.labels, (v) => {
                settings.labels = v;
            }),
        );
        const range = (
            label: string,
            lo: "y_min" | "y2_min",
            hi: "y_max" | "y2_max",
        ) =>
            field(
                label,
                h(
                    "span",
                    { class: "chart-range-row" },
                    rangeInput(
                        settings[lo],
                        (v) => {
                            settings[lo] = v;
                            schedule();
                        },
                        "from",
                    ),
                    h("span", { class: "hint" }, "to"),
                    rangeInput(
                        settings[hi],
                        (v) => {
                            settings[hi] = v;
                            schedule();
                        },
                        "auto",
                    ),
                ),
            );
        if (kind !== "pie") {
            fields.append(
                range(
                    settings.y2 ? "Left axis" : "Value axis",
                    "y_min",
                    "y_max",
                ),
            );
            if (settings.y2 && twoAxes) {
                fields.append(range("Right axis", "y2_min", "y2_max"));
            }
        }
        fields.append(
            opts,
            field(
                "Legend",
                select(
                    [
                        { value: "auto", label: "Auto" },
                        { value: "on", label: "Show" },
                        { value: "off", label: "Hide" },
                    ],
                    settings.legend == null
                        ? "auto"
                        : settings.legend
                          ? "on"
                          : "off",
                    (v) => {
                        settings.legend = v === "auto" ? null : v === "on";
                    },
                ),
            ),
        );
        schedule();
    }

    function renderAll(): void {
        renderGrid();
        renderFields();
    }

    // ── Saving ──

    async function save(): Promise<void> {
        const data = trimmed(grid);
        if (!data.rows.length) {
            toast("The chart needs at least one row of data", "error");
            return;
        }
        if (target.kind === "edit") {
            const res = await edit({
                action: "chart-save-data",
                slide: target.slide,
                zone: target.zone,
                table: data,
                chart: settings,
            });
            if (res.ok) closeDialog();
            return;
        }
        if (!(await ensureOwnDrawing())) return;
        const src = ownSource();
        const slide = currentSlide();
        if (!src || !slide) return;
        const box = newChartBox(target.at);
        const parent = insertParent();
        const a = toParent(parent.el, box.x, box.y);
        const b = toParent(parent.el, box.x + box.width, box.y + box.height);
        const res = await edit({
            action: "insert-chart",
            slide: slide.deckIndex,
            file: src.path,
            hash: src.hash,
            parent: parent.loc,
            x: Math.round(Math.min(a.x, b.x)),
            y: Math.round(Math.min(a.y, b.y)),
            width: Math.round(Math.abs(b.x - a.x)),
            height: Math.round(Math.abs(b.y - a.y)),
            chart: settings,
            table: data,
        });
        const id = res.ids?.new;
        if (res.ok && id) {
            afterRender.ids = [id];
            closeDialog();
        }
    }

    const tools = h(
        "div",
        { class: "chart-tools" },
        h(
            "button",
            {
                type: "button",
                class: "pbtn",
                onclick: () => {
                    grid = addRow(grid);
                    renderAll();
                    focusCell(grid.rows.length - 1, 0);
                },
            },
            icon("plus", 14),
            "Row",
        ),
        h(
            "button",
            {
                type: "button",
                class: "pbtn",
                onclick: () => {
                    grid = addColumn(grid);
                    renderAll();
                    focusCell(-1, grid.columns.length - 1);
                },
            },
            icon("plus", 14),
            "Column",
        ),
        h(
            "span",
            { class: "hint chart-tools-hint" },
            "Paste cells copied from a spreadsheet into any cell.",
        ),
    );
    const body = h(
        "div",
        { class: "chart-dialog" },
        h(
            "div",
            { class: "chart-data" },
            tools,
            h("div", { class: "chart-grid-wrap" }, table),
        ),
        h(
            "div",
            { class: "chart-side" },
            fields,
            h("h3", {}, "Preview"),
            preview,
            status,
        ),
        h(
            "div",
            { class: "chart-actions" },
            target.kind === "edit" && target.src
                ? h(
                      "span",
                      { class: "hint chart-actions-hint" },
                      `Saved to ${target.src}`,
                  )
                : target.kind === "insert"
                  ? h(
                        "span",
                        { class: "hint chart-actions-hint" },
                        "The data is saved as a CSV file in data/.",
                    )
                  : null,
            h(
                "button",
                { type: "button", class: "pbtn", onclick: () => closeDialog() },
                "Cancel",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn primary",
                    onclick: () => void save(),
                },
                target.kind === "insert" ? "Insert chart" : "Save",
            ),
        ),
    );
    openDialog(target.kind === "insert" ? "Insert chart" : "Chart data", body, {
        large: true,
    });
    renderAll();
    focusCell(0, 0);
}
