export function maxStep(root: Element): number {
    let m = 0;
    root.querySelectorAll("[data-step]").forEach((el) => {
        const s = +(el.getAttribute("data-step") ?? "0");
        if (s > m) m = s;
    });
    // A video that plays on a step extends the slide's step count, so forward
    // navigation lands on that step (and triggers playback) instead of skipping
    // to the next slide.
    root.querySelectorAll("[data-play-on-step]").forEach((el) => {
        const s = +(el.getAttribute("data-play-on-step") ?? "0");
        if (s > m) m = s;
    });
    root.querySelectorAll<HTMLElement>(
        ".inkflow-codeblock[data-hl-spec][data-base-step]",
    ).forEach((block) => {
        const spec: unknown[] = JSON.parse(block.dataset.hlSpec!);
        const baseStep = +(block.dataset.baseStep ?? "0");
        const last = baseStep + spec.length - 1;
        if (last > m) m = last;
    });
    return m;
}

function applyCodeHighlights(root: Element, step: number): void {
    root.querySelectorAll<HTMLElement>(
        ".inkflow-codeblock[data-hl-spec][data-base-step]",
    ).forEach((block) => {
        const spec: (number[] | null)[] = JSON.parse(block.dataset.hlSpec!);
        const baseStep = +(block.dataset.baseStep ?? "0");
        const specIdx = Math.min(Math.max(step - baseStep, 0), spec.length - 1);
        const active = spec[specIdx]; // null = all, [] = none, [1,2,…] = lines
        const hasHL = active !== null;

        block.querySelectorAll<HTMLElement>(".code-line").forEach((line) => {
            const n = +(line.dataset.line ?? "0");
            line.classList.toggle("hl-active", hasHL && active!.includes(n));
            line.classList.toggle("hl-dim", hasHL && !active!.includes(n));
            if (!hasHL) line.classList.remove("hl-active", "hl-dim");
        });
    });
}

export function applyStep(root: Element, step: number): void {
    root.querySelectorAll("[data-step]").forEach((el) => {
        el.classList.toggle(
            "active",
            +(el.getAttribute("data-step") ?? "0") <= step,
        );
    });
    applyCodeHighlights(root, step);
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
