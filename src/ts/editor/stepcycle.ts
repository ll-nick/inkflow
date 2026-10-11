// The toolbar's Steps button: pure, so the cycle and its words are tested
// without a page. `null` is every object shown (editing); 0 is the slide as
// it appears, before the first click; `max` is after the last click.

/** Where a click on Steps goes: everything → 0 → 1 … → max → everything;
 * `back` (Shift+click, right-click) the other way round. */
export function nextStep(
    step: number | null,
    max: number,
    back = false,
): number | null {
    if (max <= 0) return null;
    if (step == null) return back ? max : 0;
    const s = Math.min(step, max);
    if (back) return s === 0 ? null : s - 1;
    return s >= max ? null : s + 1;
}

/** Whether going from `from` to `to` came round to everything again. */
export function wrapped(from: number | null, to: number | null): boolean {
    return from != null && to == null;
}

export function stepLabel(step: number | null, max: number): string {
    return step == null ? "Steps" : `Step ${Math.min(step, max)}/${max}`;
}

export function stepTitle(step: number | null, max: number): string {
    if (max <= 0) return "Nothing on this slide appears step by step";
    const how = "Click: next step; Shift+click or right-click: back";
    if (step == null) {
        return `Every object is shown, for editing. ${how}: the slide as the audience sees it, click by click (${max} ${max === 1 ? "click" : "clicks"}).`;
    }
    const where =
        step === 0
            ? "as the slide appears, before the first click"
            : `after click ${step} of ${max}`;
    return `Previewing ${where}; editing is paused. ${how}; after the last step it shows every object again.`;
}
