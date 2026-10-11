// The editor's keyboard shortcuts as data (keys.ts shows and changes them):
// every command with its default keys, which keys a press is, and what a
// person's own keys make of the defaults. Pure, tested.

export interface Shortcut {
    id: string;
    label: string;
    group: string;
    keys: string[]; // the defaults, as `comboOf` writes them
    // Keys only shown: what they do depends on where they are pressed
    // (arrows, Delete, Enter), or every program has them (Ctrl+Z, Ctrl+C).
    fixed?: boolean;
}

export const GROUPS = [
    "Tools",
    "Insert",
    "Edit",
    "Arrange",
    "Slides",
    "View",
    "Review",
    "Help",
] as const;

export const SHORTCUTS: readonly Shortcut[] = [
    { id: "tool.select", group: "Tools", label: "Select", keys: ["V"] },
    { id: "tool.text", group: "Tools", label: "Text", keys: ["T"] },
    { id: "tool.rect", group: "Tools", label: "Rectangle", keys: ["R"] },
    { id: "tool.ellipse", group: "Tools", label: "Ellipse", keys: ["O"] },
    { id: "tool.line", group: "Tools", label: "Line", keys: ["L"] },
    { id: "tool.arrow", group: "Tools", label: "Arrow", keys: ["A"] },
    { id: "tool.elbow", group: "Tools", label: "Elbow arrow", keys: ["E"] },
    { id: "tool.curve", group: "Tools", label: "Curved arrow", keys: ["C"] },
    { id: "tool.pen", group: "Tools", label: "Pen", keys: ["P"] },
    { id: "insert.image", group: "Insert", label: "Image", keys: ["I"] },
    { id: "insert.video", group: "Insert", label: "Video", keys: ["Shift+I"] },
    {
        id: "edit.undo",
        group: "Edit",
        label: "Undo",
        keys: ["Ctrl+Z"],
        fixed: true,
    },
    {
        id: "edit.redo",
        group: "Edit",
        label: "Redo",
        keys: ["Ctrl+Shift+Z", "Ctrl+Y"],
        fixed: true,
    },
    {
        id: "edit.clipboard",
        group: "Edit",
        label: "Copy, cut, paste (objects, or slides in the slide list)",
        keys: ["Ctrl+C", "Ctrl+X", "Ctrl+V"],
        fixed: true,
    },
    {
        id: "edit.all",
        group: "Edit",
        label: "Select everything on the slide",
        keys: ["Ctrl+A"],
        fixed: true,
    },
    {
        id: "edit.delete",
        group: "Edit",
        label: "Delete the selection (in the slide list: the slides)",
        keys: ["Delete", "Backspace"],
        fixed: true,
    },
    {
        id: "edit.enter",
        group: "Edit",
        label: "Edit the selected text or zone, type into a shape",
        keys: ["Enter"],
        fixed: true,
    },
    {
        id: "edit.escape",
        group: "Edit",
        label: "Back to Select, leave a group, select nothing",
        keys: ["Escape"],
        fixed: true,
    },
    {
        id: "edit.nudge",
        group: "Edit",
        label: "Move the selection (Shift: by 10)",
        keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
        fixed: true,
    },
    {
        id: "edit.duplicate",
        group: "Edit",
        label: "Duplicate",
        keys: ["Ctrl+D"],
    },
    {
        id: "edit.copy-style",
        group: "Edit",
        label: "Copy an object's style",
        keys: ["Ctrl+Alt+C"],
    },
    {
        id: "edit.paste-style",
        group: "Edit",
        label: "Paste the style onto the selection",
        keys: ["Ctrl+Alt+V"],
    },
    { id: "edit.find", group: "Edit", label: "Find", keys: ["Ctrl+F"] },
    { id: "edit.replace", group: "Edit", label: "Replace", keys: ["Ctrl+H"] },
    { id: "arrange.group", group: "Arrange", label: "Group", keys: ["Ctrl+G"] },
    {
        id: "arrange.ungroup",
        group: "Arrange",
        label: "Ungroup",
        keys: ["Ctrl+Shift+G"],
    },
    {
        id: "arrange.forward",
        group: "Arrange",
        label: "Bring forward",
        keys: ["Ctrl+ArrowUp"],
    },
    {
        id: "arrange.backward",
        group: "Arrange",
        label: "Send backward",
        keys: ["Ctrl+ArrowDown"],
    },
    {
        id: "arrange.front",
        group: "Arrange",
        label: "Bring to front",
        keys: ["Ctrl+Shift+ArrowUp"],
    },
    {
        id: "arrange.back",
        group: "Arrange",
        label: "Send to back",
        keys: ["Ctrl+Shift+ArrowDown"],
    },
    {
        id: "slide.next",
        group: "Slides",
        label: "Next / previous slide",
        keys: ["PageDown", "PageUp"],
        fixed: true,
    },
    {
        id: "slide.new",
        group: "Slides",
        label: "New slide on this slide's layout",
        keys: ["Ctrl+M"],
    },
    {
        id: "slide.gallery",
        group: "Slides",
        label: "New slide from the layout gallery",
        keys: ["Ctrl+Shift+M"],
    },
    {
        id: "slide.star",
        group: "Slides",
        label: "Star / unstar the slide",
        keys: ["S"],
    },
    {
        id: "slide.present",
        group: "Slides",
        label: "Present from this slide",
        keys: ["Ctrl+Enter"],
    },
    {
        id: "view.grid",
        group: "View",
        label: "Grid view of all slides",
        keys: ["G"],
    },
    {
        id: "view.fullscreen",
        group: "View",
        label: "Full screen",
        keys: ["F"],
    },
    {
        id: "view.left",
        group: "View",
        label: "Hide / show the slide list",
        keys: ["1"],
    },
    {
        id: "view.bottom",
        group: "View",
        label: "Hide / show the speaker notes",
        keys: ["2"],
    },
    {
        id: "view.right",
        group: "View",
        label: "Hide / show the properties",
        keys: ["3"],
    },
    { id: "view.zoom-in", group: "View", label: "Zoom in", keys: ["+", "="] },
    { id: "view.zoom-out", group: "View", label: "Zoom out", keys: ["-"] },
    { id: "view.zoom-fit", group: "View", label: "Fit the slide", keys: ["0"] },
    {
        id: "review.comment",
        group: "Review",
        label: "Add a review comment",
        keys: ["Shift+C"],
    },
    {
        id: "review.next-change",
        group: "Review",
        label: "Next slide with changes since the last commit",
        keys: ["Alt+F5"],
    },
    {
        id: "review.prev-change",
        group: "Review",
        label: "Previous slide with changes",
        keys: ["Alt+Shift+F5"],
    },
    {
        id: "help.palette",
        group: "Help",
        label: "Command palette",
        keys: ["Space", "Ctrl+K", "Ctrl+Shift+P"],
    },
    {
        id: "help.shortcuts",
        group: "Help",
        label: "Keyboard shortcuts",
        keys: ["?"],
    },
];

export function shortcut(id: string): Shortcut | undefined {
    return SHORTCUTS.find((s) => s.id === id);
}

/** What a keydown carries that decides its keys. */
export interface KeyPress {
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

const MODIFIERS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph"]);

/** A key press as it is written, "Ctrl+Shift+G", "Alt+F5", "?", "Space";
 * "" for a modifier alone. Ctrl and ⌘ are one. A letter is the letter
 * printed on the key (the layout's), but with Ctrl or Alt held the key's
 * place decides (Alt turns letters into symbols on a Mac). A character
 * typed with Shift ("?", "+") is that character, without the Shift. */
export function comboOf(e: KeyPress): string {
    if (MODIFIERS.has(e.key)) return "";
    const ctrl = e.ctrlKey || e.metaKey;
    const mods: string[] = [];
    if (ctrl) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
    const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
    let name: string;
    let shift = e.shiftKey;
    if ((ctrl || e.altKey) && (letter || digit)) name = (letter ?? digit)!;
    else if (/^[a-z]$/i.test(e.key)) name = e.key.toUpperCase();
    else if (/^[0-9]$/.test(e.key)) name = e.key;
    else if (e.key === " ") name = "Space";
    else if (e.key.length === 1) {
        // Punctuation: Shift is part of which character it is.
        if (letter) name = letter;
        else {
            name = e.key;
            shift = false;
        }
    } else name = e.key;
    if (shift) mods.push("Shift");
    return [...mods, name].join("+");
}

const SYMBOLS: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Escape: "Esc",
    Delete: "Del",
};

/** A combo as it is shown, "Ctrl+↑" (⌘ instead of Ctrl on a Mac). */
export function display(combo: string, mac = false): string {
    return combo
        .split(/\+(?=.)/)
        .map((p) => (p === "Ctrl" && mac ? "⌘" : (SYMBOLS[p] ?? p)))
        .join("+");
}

/** A person's own keys: command id -> its keys (none = taken off). */
export type Overrides = Record<string, string[]>;

/** Every command's keys: the person's own where they set some. */
export function effective(overrides: Overrides): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const s of SHORTCUTS) {
        const own = s.fixed ? undefined : overrides[s.id];
        out[s.id] = Array.isArray(own) ? own : s.keys;
    }
    return out;
}

/** The command a combo runs (fixed ones included), if any. */
export function commandOf(
    keys: Record<string, string[]>,
    combo: string,
): string | null {
    if (!combo) return null;
    for (const s of SHORTCUTS) {
        if (keys[s.id]?.includes(combo)) return s.id;
    }
    return null;
}

/** What remembered overrides say, keeping only ids that exist, are not
 * fixed and name lists of keys. */
export function parseOverrides(stored: string | null): Overrides {
    if (!stored) return {};
    try {
        const raw: unknown = JSON.parse(stored);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const out: Overrides = {};
        for (const [id, keys] of Object.entries(raw)) {
            const s = shortcut(id);
            if (!s || s.fixed || !Array.isArray(keys)) continue;
            out[id] = keys.filter(
                (k): k is string => typeof k === "string" && !!k,
            );
        }
        return out;
    } catch {
        return {};
    }
}

export type Assign =
    | { ok: true; overrides: Overrides; took: string | null }
    | { ok: false; error: string };

/** `combo` as the one key of command `id`. A combo another command has is
 * taken from it (`took` names it); one a fixed command has, or a press
 * that is only a key every text field needs, is refused. */
export function assign(
    overrides: Overrides,
    id: string,
    combo: string,
): Assign {
    const s = shortcut(id);
    if (!s || s.fixed)
        return { ok: false, error: "These keys cannot be changed" };
    if (!combo)
        return { ok: false, error: "Press a key, not only Ctrl, Alt or Shift" };
    if (combo === "Tab" || combo === "Shift+Tab")
        return {
            ok: false,
            error: "Tab moves between fields; pick another key",
        };
    const keys = effective(overrides);
    const owner = commandOf(keys, combo);
    if (owner === id) return { ok: true, overrides, took: null };
    const out: Overrides = { ...overrides, [id]: [combo] };
    let took: string | null = null;
    if (owner) {
        const other = shortcut(owner)!;
        if (other.fixed)
            return { ok: false, error: `${combo} is ${other.label}` };
        out[owner] = keys[owner].filter((k) => k !== combo);
        took = owner;
    }
    return { ok: true, overrides: tidy(out), took };
}

/** Command `id` back to its default keys; a default another command was
 * given meanwhile goes back too. */
export function reset(overrides: Overrides, id: string): Overrides {
    const s = shortcut(id);
    if (!s) return overrides;
    const out: Overrides = { ...overrides };
    delete out[id];
    const keys = effective(out);
    for (const other of SHORTCUTS) {
        if (other.id === id || other.fixed) continue;
        const kept = keys[other.id].filter((k) => !s.keys.includes(k));
        if (kept.length !== keys[other.id].length) out[other.id] = kept;
    }
    return tidy(out);
}

/** Overrides that equal the defaults are dropped. */
function tidy(overrides: Overrides): Overrides {
    const out: Overrides = {};
    for (const [id, keys] of Object.entries(overrides)) {
        const s = shortcut(id);
        if (!s) continue;
        if (
            keys.length === s.keys.length &&
            keys.every((k, i) => k === s.keys[i])
        )
            continue;
        out[id] = keys;
    }
    return out;
}

/** A button's title with its key changed: `base` names the defaults as
 * "(R)" or "(Ctrl+F)"; that part becomes the current keys, or goes. */
export function retitle(
    base: string,
    defaults: string[],
    now: string[],
): string {
    // "(+, =)" or only the first, "(+)".
    const was = [`(${defaults.join(", ")})`, `(${defaults[0]})`].find((w) =>
        base.includes(w),
    );
    if (!was) return base;
    if (!now.length) return base.replace(` ${was}`, "").replace(was, "");
    return base.replace(was, `(${now.join(", ")})`);
}

/** The shortcuts matching `query` (label, group or keys), for the dialog's
 * search box. */
export function filterShortcuts(
    keys: Record<string, string[]>,
    query: string,
): Shortcut[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...SHORTCUTS];
    return SHORTCUTS.filter((s) =>
        `${s.group} ${s.label} ${keys[s.id].join(" ")}`
            .toLowerCase()
            .includes(q),
    );
}
