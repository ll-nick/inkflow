export function maxStep(root: Element): number {
    let m = 0;
    root.querySelectorAll("[data-step]").forEach((el) => {
        const s = +(el.getAttribute("data-step") ?? "0");
        if (s > m) m = s;
    });
    return m;
}

export function applyStep(root: Element, step: number): void {
    root.querySelectorAll("[data-step]").forEach((el) => {
        el.classList.toggle(
            "active",
            +(el.getAttribute("data-step") ?? "0") <= step,
        );
    });
}

// Apply a step and immediately fast-forward whatever the class change scheduled,
// so the result is the final built state with no visible playback. Works for any
// animation kind — CSS transitions and @keyframes alike, including custom ones —
// because it finishes the live Animation objects the browser created rather than
// relying on per-animation CSS. Animations stay re-armable: a later applyStep
// schedules fresh ones that play normally.
//
// Used when arriving at a slide non-sequentially (backward navigation, overview
// thumbnails, deep-link on load) where the build animations should appear done.
export function applyStepInstant(root: Element, step: number): void {
    applyStep(root, step);
    if (typeof root.getAnimations !== "function") return;
    for (const anim of root.getAnimations({ subtree: true })) {
        try {
            anim.finish();
        } catch {
            // finish() throws on infinite animations — leave those running.
        }
    }
}
