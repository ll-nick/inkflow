import { describe, expect, it } from "vitest";
import {
    addColumn,
    addRow,
    defaultSettings,
    type Grid,
    isMultiCell,
    isNumber,
    numericColumns,
    parseClipboard,
    pasteCells,
    plotted,
    removeColumn,
    removeRow,
    renameColumn,
    secondAxisAllowed,
    toggleRight,
    toggleSeries,
    trimmed,
    xColumn,
} from "./chartgrid";

const GRID: Grid = {
    columns: ["quarter", "revenue", "cost", "note"],
    rows: [
        ["Q1", "120", "80", "launch"],
        ["Q2", "1,500.5", "", ""],
    ],
};

describe("numbers", () => {
    it("reads what the server reads as a number", () => {
        for (const s of ["12", "-3.5", "1,234", "1e3", " 7 "]) {
            expect(isNumber(s)).toBe(true);
        }
        for (const s of ["", "Q1", "1,23", "2024-01", "-", "."]) {
            expect(isNumber(s)).toBe(false);
        }
    });

    it("finds the numeric columns, ignoring empty cells", () => {
        expect(numericColumns(GRID)).toEqual(["revenue", "cost"]);
    });
});

describe("settings", () => {
    it("plots every numeric column but x by default", () => {
        const s = defaultSettings();
        expect(xColumn(GRID, s)).toBe("quarter");
        expect(plotted(GRID, s)).toEqual(["revenue", "cost"]);
        expect(plotted(GRID, { ...s, y: ["cost", "gone"] })).toEqual(["cost"]);
    });

    it("writes the default series set as null", () => {
        const s = defaultSettings();
        const off = toggleSeries(GRID, s, "cost", false);
        expect(off).toEqual(["revenue"]);
        expect(toggleSeries(GRID, { ...s, y: off }, "cost", true)).toBeNull();
        expect(toggleSeries(GRID, s, "note", true)).toEqual([
            "revenue",
            "cost",
            "note",
        ]);
    });

    it("follows a renamed or removed column", () => {
        const s = { ...defaultSettings(), x: "quarter", y: ["cost"] };
        const renamed = renameColumn(GRID, 2, "costs", s);
        expect(renamed.grid.columns).toEqual([
            "quarter",
            "revenue",
            "costs",
            "note",
        ]);
        expect(renamed.settings.y).toEqual(["costs"]);
        // A taken name gets a number.
        expect(renameColumn(GRID, 2, "revenue", s).grid.columns[2]).toBe(
            "revenue 2",
        );
        const removed = removeColumn(GRID, 0, s);
        expect(removed.grid.columns).toEqual(["revenue", "cost", "note"]);
        expect(removed.grid.rows[0]).toEqual(["120", "80", "launch"]);
        expect(removed.settings.x).toBeNull();
    });
});

describe("clipboard", () => {
    it("parses a spreadsheet's TSV, quotes included", () => {
        expect(parseClipboard('a\tb\r\n1\t"x\ty"\n"say ""hi"""\t\n')).toEqual([
            ["a", "b"],
            ["1", "x\ty"],
            ['say "hi"', ""],
        ]);
        expect(parseClipboard("a,b\n1,2")).toEqual([
            ["a", "b"],
            ["1", "2"],
        ]);
        expect(parseClipboard('"two\nlines"')).toEqual([["two\nlines"]]);
    });

    it("tells one cell from many", () => {
        expect(isMultiCell("hello")).toBe(false);
        expect(isMultiCell("1\t2")).toBe(true);
        expect(isMultiCell("1\n2")).toBe(true);
    });

    it("pastes from a cell, growing the grid", () => {
        const out = pasteCells(GRID, 1, 3, [
            ["a", "b"],
            ["c", "d"],
        ]);
        expect(out.columns).toEqual([
            "quarter",
            "revenue",
            "cost",
            "note",
            "column 5",
        ]);
        expect(out.rows).toEqual([
            ["Q1", "120", "80", "launch", ""],
            ["Q2", "1,500.5", "", "a", "b"],
            ["", "", "", "c", "d"],
        ]);
        expect(GRID.rows[1][3]).toBe(""); // the original is untouched
    });

    it("pasting on the header row names the columns", () => {
        const out = pasteCells({ columns: ["x"], rows: [["1"]] }, -1, 0, [
            ["month", "visits"],
            ["Jan", "10"],
        ]);
        expect(out).toEqual({
            columns: ["month", "visits"],
            rows: [["Jan", "10"]],
        });
    });
});

describe("rows and columns", () => {
    it("adds and removes", () => {
        const grown = addColumn(addRow(GRID, 0));
        expect(grown.rows[0]).toEqual(["", "", "", "", ""]);
        expect(grown.columns[4]).toBe("series 4");
        expect(removeRow(grown, 0)).toEqual({
            columns: grown.columns,
            rows: GRID.rows.map((r) => [...r, ""]),
        });
    });

    it("drops blank rows before saving", () => {
        expect(
            trimmed({ columns: ["a"], rows: [["1"], [" "], [""], ["2"]] }).rows,
        ).toEqual([["1"], ["2"]]);
    });
});

describe("second axis", () => {
    it("is offered where the renderer draws one", () => {
        const s = defaultSettings();
        expect(secondAxisAllowed(s)).toBe(true);
        expect(secondAxisAllowed({ ...s, kind: "line" })).toBe(true);
        expect(secondAxisAllowed({ ...s, stacked: true })).toBe(false);
        expect(secondAxisAllowed({ ...s, horizontal: true })).toBe(false);
        expect(secondAxisAllowed({ ...s, kind: "pie" })).toBe(false);
        // Stacking only matters to bars and areas.
        expect(secondAxisAllowed({ ...s, kind: "line", stacked: true })).toBe(
            true,
        );
    });

    it("moves series right and back, none left being null", () => {
        const s = defaultSettings();
        const one = toggleRight(s, "rate", true);
        expect(one).toEqual(["rate"]);
        expect(toggleRight({ ...s, y2: one }, "rate", false)).toBeNull();
    });

    it("follows a renamed or removed column", () => {
        const grid: Grid = {
            columns: ["m", "a", "b"],
            rows: [["x", "1", "2"]],
        };
        const s = { ...defaultSettings(), y2: ["b"] };
        expect(renameColumn(grid, 2, "c", s).settings.y2).toEqual(["c"]);
        expect(removeColumn(grid, 2, s).settings.y2).toBeNull();
    });
});
