// Small DOM helpers shared by the editor's panels.

type Attrs = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

// h("button", {class: "x", onclick: fn}, "Label") — attributes starting with
// "on" become listeners, booleans toggle the attribute.
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Attrs = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith("on") && typeof v === "function") {
            el.addEventListener(k.slice(2), v as EventListener);
        } else if (k === "value" && "value" in el) {
            (el as HTMLInputElement).value = String(v);
        } else if (v === true) {
            el.setAttribute(k, "");
        } else {
            el.setAttribute(k, String(v));
        }
    }
    for (const c of children) {
        if (c == null || c === false) continue;
        el.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
}

export function clear(el: Element): void {
    while (el.firstChild) el.removeChild(el.firstChild);
}

export const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
}

// Inline SVG icons (trusted, fixed markup).
const ICON_PATHS: Record<string, string> = {
    undo: '<path d="M4 7h7a3.5 3.5 0 0 1 0 7H8"/><path d="M6.5 4.5 4 7l2.5 2.5"/>',
    redo: '<path d="M12 7H5a3.5 3.5 0 0 0 0 7h3"/><path d="M9.5 4.5 12 7 9.5 9.5"/>',
    select: '<path d="M3 2l9 5-4 1.2L6.5 12z"/>',
    text: '<path d="M3 3.5h10M8 3.5V13M6 13h4"/>',
    rect: '<rect x="2.5" y="4" width="11" height="8" rx="1.2"/>',
    ellipse: '<ellipse cx="8" cy="8" rx="5.5" ry="4.2"/>',
    line: '<path d="M3 13 13 3"/>',
    arrow: '<path d="M3 13 13 3"/><path d="M7.5 3H13v5.5"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.2"/><circle cx="5.8" cy="6.5" r="1.2"/><path d="m2.5 12 4-4 3 3 2-2 2.5 2.5"/>',
    play: '<path d="M5 3.2 12.5 8 5 12.8Z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>',
    copy: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10.5V3h7.5"/>',
    layers: '<path d="M8 2 14 5.5 8 9 2 5.5 8 2Z"/><path d="M2 9 8 12.5 14 9"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
    eyeOff: '<path d="M2 2l12 12M6.5 4A6.6 6.6 0 0 1 14.5 8a9 9 0 0 1-1.8 2.3M9.9 11.9A6.3 6.3 0 0 1 1.5 8 9.5 9.5 0 0 1 4 5"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    unlock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/>',
    up: '<path d="M4 10l4-4 4 4"/>',
    down: '<path d="M4 6l4 4 4-4"/>',
    front: '<rect x="5" y="5" width="8" height="8" rx="1" fill="currentColor"/><path d="M3 10.5V3h7.5"/>',
    back: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10.5V3h7.5" /><rect x="3" y="3" width="7.5" height="7.5" fill="currentColor" opacity=".35" stroke="none"/>',
    group: '<rect x="2" y="2" width="12" height="12" rx="1" stroke-dasharray="2 1.5"/><rect x="4.5" y="4.5" width="4" height="4"/><rect x="8" y="8" width="3.5" height="3.5"/>',
    code: '<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>',
    fit: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>',
};

export function icon(name: string, size = 16): SVGSVGElement {
    const wrap = document.createElement("span");
    wrap.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ""}</svg>`;
    return wrap.firstElementChild as SVGSVGElement;
}

let toastTimer = 0;

export interface ToastAction {
    label: string;
    run: () => void;
}

// A message at the bottom; with `action`, it carries a button (an agent's
// edit offers "Undo") and stays longer, since the author has to reach it.
export function toast(
    message: string,
    kind: "info" | "error" | "ok" = "info",
    action?: ToastAction,
): void {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.className = `show ${kind}`;
    if (action) {
        el.classList.add("has-action");
        el.append(
            h(
                "button",
                {
                    type: "button",
                    class: "toast-action",
                    onclick: () => {
                        el.className = "";
                        action.run();
                    },
                },
                action.label,
            ),
        );
    }
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
        () => {
            el.className = "";
        },
        action ? 10000 : kind === "error" ? 6000 : 2600,
    );
}
