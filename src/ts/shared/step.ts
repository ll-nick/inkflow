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
