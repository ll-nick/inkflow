// Which click of the slide each animation of the editor's list plays on.

import type { CueInfo } from "./types";

/**
 * The step each animation of the list plays on, read off the built slide:
 * an element's cues there are its animations in order (data-cues, sorted
 * by step), a video's step is its data-play-on-step. Null when not found.
 */
export function cueSteps(
    cues: CueInfo[],
    svg: Element | null,
): (number | null)[] {
    const seen = new Map<string, number>();
    return cues.map((cue) => {
        if (!svg) return null;
        const byId = (id: string) =>
            svg.querySelector(`[id="${CSS.escape(id)}"]`);
        if (cue.kind === "video") {
            const zone = byId(`zone-${cue.element}`) ?? byId(cue.element);
            const v = zone?.querySelector("[data-play-on-step]");
            const s = Number(v?.getAttribute("data-play-on-step"));
            return Number.isFinite(s) && s > 0 ? s : null;
        }
        const el = byId(cue.element) ?? byId(`zone-${cue.element}`);
        const n = seen.get(cue.element) ?? 0;
        seen.set(cue.element, n + 1);
        try {
            const list = JSON.parse(el?.getAttribute("data-cues") ?? "[]") as {
                step: number;
            }[];
            const steps = list.map((c) => c.step).sort((a, b) => a - b);
            return steps[n] ?? null;
        } catch {
            return null;
        }
    });
}
