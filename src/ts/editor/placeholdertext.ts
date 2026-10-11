// A layout's placeholders in words, pure (tested): the zone a typed name
// gives and why it cannot be used, what the panel says about who fills it
// and what a rename changes. The rules mirror editor/placeholders.py, which
// has the last word; these let the dialog say it as the name is typed.

export type PlaceholderKind = "text" | "picture";

/** One placeholder as `master-placeholders` lists it. */
export interface PlaceholderInfo {
    name: string;
    zone: string;
    kind: PlaceholderKind;
    prompt: string | null;
    box: number[];
    tag: string;
    shape: boolean; // drawn as a box of its own (inkflow:show-shape)
    layout: string; // the file it is written in
    own: boolean; // in the file shown, not in a layout it is built on
    filled: number[]; // deck indices of the slides that fill it
}

/** What the master shows has, and the ids a new placeholder must not take. */
export interface PlaceholderList {
    placeholders: PlaceholderInfo[];
    ids: string[];
}

/** What a rename (or its dry run) says it changes. */
export interface PlaceholderPlan {
    slides: number[];
    slideNames: string[];
    files: string[];
    edits: string[];
    warnings: string[];
}

const MEDIA = /media|image|img|picture|photo|figure|video|logo/;
const RESERVED = new Set(["notes", "slide", "slide-number", "slide-total"]);

/** `master.slug_name`: "codeExamples" and "Code examples" → "code-examples". */
export function slugName(name: string): string {
    return name
        .trim()
        .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "-")
        .replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, "-")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function kindOf(name: string): PlaceholderKind {
    return MEDIA.test(name) ? "picture" : "text";
}

/** The zone name a typed name gives; a picture placeholder's says it is one
 * ("hero" → "picture-hero"), which is how a slide knows to offer a picture. */
export function zoneNameFor(kind: PlaceholderKind, typed: string): string {
    const name = slugName(typed.trim().replace(/^zone-/, ""));
    return name && kind === "picture" && !MEDIA.test(name)
        ? `picture-${name}`
        : name;
}

/** Why `name` cannot name a zone, or null. */
export function nameProblem(name: string): string | null {
    if (!name) return "Give the placeholder a name";
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return "Start the name with a letter";
    if (RESERVED.has(name)) return `“${name}” is a reserved zone name`;
    if (/^steps?(?![\w])/.test(name))
        return "A zone name cannot start with “step”: Markdown reads that as a reveal";
    return null;
}

/** The name typed, checked: `taken` holds the ids around the layout
 * (`zone-…` among them), `current` the zone being renamed. */
export function checkName(
    kind: PlaceholderKind,
    typed: string,
    taken: Iterable<string>,
    current: string | null = null,
): { name: string; problem: string | null } {
    const name = zoneNameFor(kind, typed);
    const problem = nameProblem(name);
    if (problem) return { name, problem };
    if (name === current) return { name, problem: null };
    for (const id of taken) {
        if (id === `zone-${name}`) {
            return { name, problem: `zone-${name} is already used here` };
        }
    }
    return { name, problem: null };
}

/** "No slide fills it yet", "Filled on slide 2", "Filled on 3 slides: 2, 5, 7". */
export function fillsText(
    filled: number[],
    number: (index: number) => string,
): string {
    if (!filled.length) return "No slide fills it yet";
    const list = filled.map(number).join(", ");
    return filled.length === 1
        ? `Filled on slide ${list}`
        : `Filled on ${filled.length} slides: ${list}`;
}

/** What a rename's dry run says, in one line. */
export function renameSummary(plan: PlaceholderPlan): string {
    const n = plan.slides.length;
    if (!n) return "No slide fills it: only the layout changes";
    return `Renames the zone on ${n} slide${n === 1 ? "" : "s"} (${plan.slideNames.join(", ")})`;
}
