// The slide master's list, pure (tested): the deck's layouts as a tree under
// the background they are all built on, in the order a slide editor lists
// them, with the words each row says. master.ts draws it.

export interface MasterLayout {
    name: string;
    label: string | null; // a template's name as typed
    path: string;
    rel: string | null;
    source: "local" | "theme" | "builtin" | string;
    copyOf: string | null; // the deck's copy of a theme's layout
    shadows: boolean;
    parent: string | null;
    slides: number[]; // deck indices built directly on it
    reach: number[]; // deck indices whose chain goes through it
    zones: string[];
}

export interface MasterOverlay {
    src: string;
    name: string;
    path: string | null;
    rel: string | null;
    source: string;
    copyOf: string | null;
    deck: boolean; // one of the deck's default overlays
    slides: number[];
}

export interface MasterTree {
    background: string | null;
    layouts: MasterLayout[];
    overlays: MasterOverlay[];
    overlaysFromTheme: boolean;
    overrides: { slide: number; overlays: string[] }[];
    canvas: [number, number];
}

export interface LayoutRow {
    layout: MasterLayout;
    depth: number;
}

// The order the gallery lists the built-in layouts in (editor/previews.py).
const ORDER = [
    "numbered",
    "title",
    "content",
    "two-cols",
    "three-cols",
    "comparison",
    "agenda",
    "quad",
    "three-cards",
    "media-left",
    "media-right",
    "title-media",
    "full-media",
    "cover",
    "section",
    "center",
    "fact",
    "quote",
    "end",
    "poster-3col",
    "poster-2col",
    "poster-landscape-3col",
    "poster-landscape-4col",
];

function rank(l: MasterLayout): [number, number, string] {
    // The deck's own layouts that are not copies (templates) come last, so
    // the theme's familiar order stays put; a copy keeps its place.
    const own = l.source === "local" && !l.copyOf && !ORDER.includes(l.name);
    const at = ORDER.indexOf(l.name);
    return [own ? 1 : 0, at < 0 ? ORDER.length : at, l.name];
}

function compare(a: MasterLayout, b: MasterLayout): number {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
}

/**
 * Every layout but the background, depth-first under the layout it is built
 * on: the background's children are the roots (depth 0). A layout whose
 * parent is not listed (another shape's, a broken reference) is a root too.
 */
export function layoutRows(tree: MasterTree): LayoutRow[] {
    const names = new Set(tree.layouts.map((l) => l.name));
    const children = new Map<string | null, MasterLayout[]>();
    for (const l of tree.layouts) {
        if (l.name === tree.background) continue;
        const parent =
            l.parent && names.has(l.parent) && l.parent !== tree.background
                ? l.parent
                : null;
        const list = children.get(parent) ?? [];
        list.push(l);
        children.set(parent, list);
    }
    const rows: LayoutRow[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null, depth: number) => {
        for (const l of (children.get(parent) ?? []).sort(compare)) {
            if (seen.has(l.name)) continue;
            seen.add(l.name);
            rows.push({ layout: l, depth });
            walk(l.name, depth + 1);
        }
    };
    walk(null, 0);
    return rows;
}

/** Where a layout comes from, as its row's badge says it. */
export function origin(l: MasterLayout | MasterOverlay): {
    text: string;
    kind: "copy" | "theme" | "own";
    title: string;
} {
    if (l.copyOf) {
        return {
            text: "Deck's copy",
            kind: "copy",
            title: `This deck's own copy of ${l.copyOf}: slides on it follow your copy. Revert to go back to the theme's.`,
        };
    }
    if (l.source === "local") {
        return {
            text: "Deck's own",
            kind: "own",
            title: "A layout of this deck's own (layouts/ in the project)",
        };
    }
    return {
        text: "Theme",
        kind: "theme",
        title: "From the theme: your first edit gives this deck its own copy, which every slide on it then follows",
    };
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** How many slides a row's edits reach, in a few words; the background's
 * against the deck's `total` (a slide drawn without a layout has none). */
export function usage(l: MasterLayout, background: boolean, total = 0): string {
    if (background) {
        if (!l.reach.length) return "no slides";
        return l.reach.length >= total
            ? "behind every slide"
            : `behind ${l.reach.length} of ${total} slides`;
    }
    if (!l.slides.length && !l.reach.length) return "no slides";
    const direct = plural(l.slides.length, "slide");
    const through = l.reach.length - l.slides.length;
    return through > 0 ? `${direct} (+${through} built on it)` : direct;
}

/** Where the deck's own copy of a theme's file goes (`master.copy_target`). */
export function copyTarget(
    path: string,
    projectDir: string,
    kind: "layout" | "overlay",
): string | null {
    const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    const root = projectDir.replace(/[\\/]+$/, "");
    if (path.startsWith(`${root}${sep}`)) return null;
    const file = path.split(/[\\/]/).pop() ?? "";
    return `${root}${sep}${kind === "overlay" ? "overlays" : "layouts"}${sep}${file}`;
}

/** The layout's name as the list shows it: a template's typed name, the
 * gallery's words for a built-in one, else its file name. */
export function layoutTitle(
    l: { name: string; label: string | null },
    labels: Record<string, string>,
): string {
    return l.label || labels[l.name] || l.name;
}
