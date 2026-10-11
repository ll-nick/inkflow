// The chart data grid's model, without the DOM: a table of cell text (what the
// server writes back to the CSV as typed), what a spreadsheet puts on the
// clipboard (TSV) and how it lands in the grid, and a chart's settings kept in
// step when columns are renamed or removed.

export interface Grid {
    columns: string[];
    rows: string[][];
}

export interface ChartSettings {
    kind: string;
    x: string | null;
    // null: every numeric column but x (the Python default).
    y: string[] | null;
    title: string | null;
    stacked: boolean;
    horizontal: boolean;
    legend: boolean | null;
    labels: boolean;
    donut: boolean;
    // The value axis's ends (null: from the data).
    y_min: number | null;
    y_max: number | null;
    // Columns on a second value axis, on the right (null: none).
    y2: string[] | null;
    y2_min: number | null;
    y2_max: number | null;
}

export const CHART_KINDS: { value: string; label: string }[] = [
    { value: "bar", label: "Bar" },
    { value: "line", label: "Line" },
    { value: "area", label: "Area" },
    { value: "scatter", label: "Scatter" },
    { value: "pie", label: "Pie" },
];

export function defaultSettings(): ChartSettings {
    return {
        kind: "bar",
        x: null,
        y: null,
        title: null,
        stacked: false,
        horizontal: false,
        legend: null,
        labels: false,
        donut: false,
        y_min: null,
        y_max: null,
        y2: null,
        y2_min: null,
        y2_max: null,
    };
}

/** Whether these settings can have a second value axis (charts.py refuses
 * one for stacked or horizontal bars, and a pie has no axes). */
export function secondAxisAllowed(s: ChartSettings): boolean {
    if (s.kind === "pie") return false;
    if (s.stacked && (s.kind === "bar" || s.kind === "area")) return false;
    return !(s.horizontal && s.kind === "bar");
}

/** Put a series on the right axis or back on the left; none left: null. */
export function toggleRight(
    s: ChartSettings,
    column: string,
    on: boolean,
): string[] | null {
    const now = (s.y2 ?? []).filter((c) => c !== column);
    const next = on ? [...now, column] : now;
    return next.length ? next : null;
}

/** A small table to start a new chart from. */
export function sampleGrid(): Grid {
    return {
        columns: ["category", "series 1", "series 2"],
        rows: [
            ["A", "4", "2"],
            ["B", "6", "3"],
            ["C", "5", "4"],
            ["D", "8", "5"],
        ],
    };
}

// What inkflow.charts.parse_cell reads as a number: digits with an optional
// sign, thousands commas, decimals and exponent.
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

export function isNumber(text: string): boolean {
    const s = text.trim();
    return /\d/.test(s) && NUMBER.test(s);
}

/** Columns whose filled cells are all numbers (and that have one). */
export function numericColumns(grid: Grid): string[] {
    return grid.columns.filter((_, c) => {
        const cells = grid.rows.map((r) => r[c] ?? "").filter((v) => v.trim());
        return cells.length > 0 && cells.every(isNumber);
    });
}

/** The column the chart's categories come from. */
export function xColumn(grid: Grid, s: ChartSettings): string | null {
    return s.x && grid.columns.includes(s.x) ? s.x : (grid.columns[0] ?? null);
}

/** The columns plotted: the chosen ones, else every numeric one but x. */
export function plotted(grid: Grid, s: ChartSettings): string[] {
    const x = xColumn(grid, s);
    if (s.y) return s.y.filter((c) => grid.columns.includes(c));
    return numericColumns(grid).filter((c) => c !== x);
}

/** Tick or untick a series; the default set is written as null. */
export function toggleSeries(
    grid: Grid,
    s: ChartSettings,
    column: string,
    on: boolean,
): string[] | null {
    const current = plotted(grid, s);
    const next = on
        ? grid.columns.filter((c) => c === column || current.includes(c))
        : current.filter((c) => c !== column);
    const auto = plotted(grid, { ...s, y: null });
    const same =
        next.length === auto.length && next.every((c, i) => c === auto[i]);
    return same ? null : next;
}

/**
 * Text from the clipboard as rows of cells. Spreadsheets copy TSV, quoting a
 * cell that holds a tab, a newline or a quote ("a ""b"""); a plain CSV line
 * (no tab anywhere) is split on commas the same way.
 */
export function parseClipboard(text: string): string[][] {
    const body = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const sep = body.includes("\t") ? "\t" : body.includes(",") ? "," : "\t";
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let i = 0;
    while (i < body.length) {
        const ch = body[i];
        if (quoted) {
            if (ch === '"' && body[i + 1] === '"') {
                cell += '"';
                i += 2;
                continue;
            }
            if (ch === '"') quoted = false;
            else cell += ch;
            i++;
            continue;
        }
        if (ch === '"' && cell === "") quoted = true;
        else if (ch === sep) {
            row.push(cell);
            cell = "";
        } else if (ch === "\n") {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else cell += ch;
        i++;
    }
    row.push(cell);
    rows.push(row);
    return rows;
}

/** Whether pasted text is more than one cell (else the field takes it). */
export function isMultiCell(text: string): boolean {
    const rows = parseClipboard(text);
    return rows.length > 1 || (rows[0]?.length ?? 0) > 1;
}

function blankRow(width: number): string[] {
    return Array.from({ length: width }, () => "");
}

function uniqueName(columns: string[], base: string): string {
    let name = base;
    let n = 2;
    while (columns.includes(name)) name = `${base} ${n++}`;
    return name;
}

/**
 * Cells pasted with their top-left at `row`, `col` (row -1: the header row,
 * whose pasted line names the columns), growing the grid as needed.
 */
export function pasteCells(
    grid: Grid,
    row: number,
    col: number,
    cells: string[][],
): Grid {
    const columns = [...grid.columns];
    const rows = grid.rows.map((r) => [...r]);
    let body = cells;
    if (row < 0) {
        const head = cells[0] ?? [];
        head.forEach((name, j) => {
            const c = col + j;
            while (columns.length <= c) {
                columns.push(
                    uniqueName(columns, `column ${columns.length + 1}`),
                );
            }
            columns[c] = name.trim() || columns[c];
        });
        body = cells.slice(1);
        row = 0;
    }
    const width = Math.max(
        columns.length,
        col + Math.max(0, ...body.map((r) => r.length)),
    );
    while (columns.length < width) {
        columns.push(uniqueName(columns, `column ${columns.length + 1}`));
    }
    for (const r of rows) while (r.length < width) r.push("");
    body.forEach((line, i) => {
        while (rows.length <= row + i) rows.push(blankRow(width));
        line.forEach((value, j) => {
            rows[row + i][col + j] = value;
        });
    });
    return { columns, rows };
}

export function addRow(grid: Grid, at = grid.rows.length): Grid {
    const rows = grid.rows.map((r) => [...r]);
    rows.splice(at, 0, blankRow(grid.columns.length));
    return { columns: [...grid.columns], rows };
}

export function removeRow(grid: Grid, at: number): Grid {
    return {
        columns: [...grid.columns],
        rows: grid.rows.filter((_, i) => i !== at).map((r) => [...r]),
    };
}

export function addColumn(grid: Grid, name?: string): Grid {
    const columns = [
        ...grid.columns,
        uniqueName(grid.columns, name ?? `series ${grid.columns.length}`),
    ];
    return { columns, rows: grid.rows.map((r) => [...r, ""]) };
}

export function removeColumn(
    grid: Grid,
    at: number,
    s: ChartSettings,
): { grid: Grid; settings: ChartSettings } {
    const name = grid.columns[at];
    const next: Grid = {
        columns: grid.columns.filter((_, i) => i !== at),
        rows: grid.rows.map((r) => r.filter((_, i) => i !== at)),
    };
    return {
        grid: next,
        settings: {
            ...s,
            x: s.x === name ? null : s.x,
            y: s.y ? s.y.filter((c) => c !== name) : null,
            y2: toggleRight(s, name, false),
        },
    };
}

/** A column renamed (to a free name), and the settings that named it. */
export function renameColumn(
    grid: Grid,
    at: number,
    wanted: string,
    s: ChartSettings,
): { grid: Grid; settings: ChartSettings } {
    const old = grid.columns[at];
    const others = grid.columns.filter((_, i) => i !== at);
    const name = uniqueName(others, wanted.trim() || old);
    const columns = grid.columns.map((c, i) => (i === at ? name : c));
    return {
        grid: { columns, rows: grid.rows.map((r) => [...r]) },
        settings: {
            ...s,
            x: s.x === old ? name : s.x,
            y: s.y ? s.y.map((c) => (c === old ? name : c)) : null,
            y2: s.y2 ? s.y2.map((c) => (c === old ? name : c)) : null,
        },
    };
}

/** Rows with every cell blank are dropped before saving. */
export function trimmed(grid: Grid): Grid {
    return {
        columns: [...grid.columns],
        rows: grid.rows.filter((r) => r.some((v) => v.trim() !== "")),
    };
}
