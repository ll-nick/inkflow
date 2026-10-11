import { describe, expect, it } from "vitest";
import {
    assign,
    comboOf,
    commandOf,
    display,
    effective,
    filterShortcuts,
    GROUPS,
    type KeyPress,
    parseOverrides,
    reset,
    retitle,
    SHORTCUTS,
} from "./keystext";

const press = (p: Partial<KeyPress>): KeyPress => ({
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...p,
});

describe("comboOf", () => {
    it("writes letters, modifiers and named keys", () => {
        expect(comboOf(press({ key: "r", code: "KeyR" }))).toBe("R");
        expect(comboOf(press({ key: "I", code: "KeyI", shiftKey: true }))).toBe(
            "Shift+I",
        );
        expect(
            comboOf(
                press({
                    key: "G",
                    code: "KeyG",
                    ctrlKey: true,
                    shiftKey: true,
                }),
            ),
        ).toBe("Ctrl+Shift+G");
        expect(comboOf(press({ key: "k", code: "KeyK", metaKey: true }))).toBe(
            "Ctrl+K",
        );
        expect(comboOf(press({ key: "F5", code: "F5", altKey: true }))).toBe(
            "Alt+F5",
        );
        expect(
            comboOf(
                press({ key: "F5", code: "F5", altKey: true, shiftKey: true }),
            ),
        ).toBe("Alt+Shift+F5");
        expect(comboOf(press({ key: " ", code: "Space" }))).toBe("Space");
        expect(
            comboOf(press({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true })),
        ).toBe("Ctrl+ArrowUp");
        expect(comboOf(press({ key: "Shift", code: "ShiftLeft" }))).toBe("");
    });

    it("takes the key's place with Ctrl or Alt (a Mac's Option symbols)", () => {
        expect(
            comboOf(
                press({ key: "ç", code: "KeyC", ctrlKey: true, altKey: true }),
            ),
        ).toBe("Ctrl+Alt+C");
    });

    it("keeps the printed letter of the layout, else the key's place", () => {
        // AZERTY: the key printed A sits where QWERTY has Q.
        expect(comboOf(press({ key: "a", code: "KeyQ" }))).toBe("A");
        // Cyrillic: no Latin letter, so the place.
        expect(comboOf(press({ key: "к", code: "KeyR" }))).toBe("R");
    });

    it("reads a character typed with Shift as that character", () => {
        expect(
            comboOf(press({ key: "?", code: "Slash", shiftKey: true })),
        ).toBe("?");
        expect(
            comboOf(press({ key: "+", code: "Equal", shiftKey: true })),
        ).toBe("+");
        expect(comboOf(press({ key: "=", code: "Equal" }))).toBe("=");
    });
});

describe("the table", () => {
    it("has unique ids and keys, in known groups", () => {
        const ids = SHORTCUTS.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        const keys = SHORTCUTS.flatMap((s) => s.keys);
        expect(new Set(keys).size).toBe(keys.length);
        for (const s of SHORTCUTS)
            expect(GROUPS as readonly string[]).toContain(s.group);
    });

    it("finds the command a combo runs", () => {
        const keys = effective({});
        expect(commandOf(keys, "R")).toBe("tool.rect");
        expect(commandOf(keys, "Ctrl+Z")).toBe("edit.undo");
        expect(commandOf(keys, "Ctrl+Q")).toBeNull();
        expect(commandOf(keys, "")).toBeNull();
    });
});

describe("assign", () => {
    it("gives a command new keys", () => {
        const r = assign({}, "tool.rect", "Shift+R");
        expect(r).toEqual({
            ok: true,
            overrides: { "tool.rect": ["Shift+R"] },
            took: null,
        });
        if (!r.ok) return;
        const keys = effective(r.overrides);
        expect(commandOf(keys, "Shift+R")).toBe("tool.rect");
        expect(commandOf(keys, "R")).toBeNull();
    });

    it("takes keys from another command", () => {
        const r = assign({}, "view.grid", "R");
        expect(r.ok && r.took).toBe("tool.rect");
        if (!r.ok) return;
        expect(r.overrides).toEqual({ "view.grid": ["R"], "tool.rect": [] });
        expect(commandOf(effective(r.overrides), "R")).toBe("view.grid");
    });

    it("refuses fixed keys and fixed commands", () => {
        expect(assign({}, "tool.rect", "Ctrl+Z")).toEqual({
            ok: false,
            error: "Ctrl+Z is Undo",
        });
        expect(assign({}, "edit.undo", "U").ok).toBe(false);
        expect(assign({}, "tool.rect", "Tab").ok).toBe(false);
        expect(assign({}, "tool.rect", "").ok).toBe(false);
    });

    it("drops what equals the default", () => {
        const r = assign({ "tool.rect": ["Shift+R"] }, "tool.rect", "R");
        expect(r.ok && r.overrides).toEqual({});
    });
});

describe("reset", () => {
    it("brings the defaults back, taking them from whoever had them", () => {
        const first = assign({}, "view.grid", "R");
        if (!first.ok) throw new Error("refused");
        expect(reset(first.overrides, "tool.rect")).toEqual({
            "view.grid": [],
        });
        expect(reset(first.overrides, "view.grid")).toEqual({
            "tool.rect": [],
        });
    });
});

describe("parseOverrides", () => {
    it("keeps known, changeable commands only", () => {
        expect(
            parseOverrides(
                JSON.stringify({
                    "tool.rect": ["Shift+R", 3],
                    "edit.undo": ["U"],
                    nope: ["X"],
                    "view.grid": "G",
                }),
            ),
        ).toEqual({ "tool.rect": ["Shift+R"] });
        expect(parseOverrides("not json")).toEqual({});
        expect(parseOverrides(null)).toEqual({});
        expect(parseOverrides("[1]")).toEqual({});
    });
});

describe("words", () => {
    it("shows arrows and Esc, ⌘ on a Mac", () => {
        expect(display("Ctrl+Shift+ArrowUp")).toBe("Ctrl+Shift+↑");
        expect(display("Ctrl+K", true)).toBe("⌘+K");
        expect(display("Escape")).toBe("Esc");
        expect(display("+")).toBe("+");
        expect(display("Ctrl++")).toBe("Ctrl++");
    });

    it("retitles a button", () => {
        expect(retitle("Rectangle (R)", ["R"], ["Shift+R"])).toBe(
            "Rectangle (Shift+R)",
        );
        expect(retitle("Zoom in (+)", ["+", "="], ["Z"])).toBe("Zoom in (Z)");
        expect(retitle("Image (I) — or drop one", ["I"], [])).toBe(
            "Image — or drop one",
        );
        expect(retitle("No keys here", ["I"], ["J"])).toBe("No keys here");
    });

    it("filters by label, group and keys", () => {
        const keys = effective({});
        expect(filterShortcuts(keys, "ungroup").map((s) => s.id)).toEqual([
            "arrange.ungroup",
        ]);
        expect(filterShortcuts(keys, "alt+f5").map((s) => s.id)).toContain(
            "review.next-change",
        );
        expect(filterShortcuts(keys, "").length).toBe(SHORTCUTS.length);
    });
});
