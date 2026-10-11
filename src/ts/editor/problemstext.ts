// Each slide's problems in words (problems.ts shows them; the server checks
// them: editor/problems.py). Pure, tested.

export interface Problem {
    level: "error" | "warn" | "hint";
    message: string;
    source: "verify" | "layout";
    kind: string;
}

export interface LayoutState {
    on: boolean;
    contrast: boolean;
    running: boolean;
    error: string | null;
}

/** The worst level among a slide's problems, hints only counting when
 * nothing else is there; null for none. */
export function worst(
    problems: readonly Problem[] | undefined,
): Problem["level"] | null {
    if (!problems?.length) return null;
    if (problems.some((p) => p.level === "error")) return "error";
    if (problems.some((p) => p.level === "warn")) return "warn";
    return "hint";
}

/** Problems worth a mark on a slide's row: errors and warnings (a hint,
 * such as smallish text, only shows in the Problems list). */
export function marked(problems: readonly Problem[] | undefined): Problem[] {
    return (problems ?? []).filter((p) => p.level !== "hint");
}

export function countMarked(all: readonly (readonly Problem[])[]): number {
    return all.reduce((n, p) => n + marked(p).length, 0);
}

/** The tooltip of a slide's mark. */
export function problemTitle(problems: readonly Problem[] | undefined): string {
    const shown = marked(problems);
    if (!shown.length) return "";
    return shown
        .map((p) => `${p.level === "error" ? "●" : "⚠"} ${p.message}`)
        .join("\n");
}

/** The slides with problems to list, in deck order: errors and warnings,
 * and hints too with `hints`. */
export function slidesWithProblems(
    all: readonly (readonly Problem[])[],
    hints: boolean,
): number[] {
    const out: number[] = [];
    all.forEach((p, i) => {
        if ((hints ? p : marked(p)).length) out.push(i);
    });
    return out;
}

/** What the Problems list says of the layout check. */
export function layoutWords(state: LayoutState): string {
    if (state.running) return "Checking the layout…";
    if (state.error) return `The layout check failed: ${state.error}`;
    if (!state.on)
        return "The layout check (text that does not fit, objects outside the slide, text too small, coarse pictures) needs a browser run: turn it on to keep it up to date.";
    return state.contrast
        ? "Layout and contrast are checked after every change."
        : "The layout is checked after every change (contrast is not).";
}
