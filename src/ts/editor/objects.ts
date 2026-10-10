// The Objects tab: every object on the current slide in stacking order (top
// first), like PowerPoint's selection pane. Click to select (also objects
// hidden under others), double-click a name to rename it, and toggle
// visibility (display:none, which the presentation honours too) and locking
// (inkflow:locked, which only the editor reads: a locked object cannot be
// selected on the canvas). Objects from layouts and overlays are listed, dimmed,
// for orientation.

import {
    canTransform,
    enterGroup,
    isLocked,
    isZone,
    keyOf,
    select,
    selectable,
    sendSvgOps,
    setHover,
    slideRoot,
    zoneName,
} from "./canvas";
import { clear, h, icon, toast } from "./dom";
import { edit } from "./net";
import { ed, on, sourceOf } from "./state";
import type { Selected } from "./types";

const host = document.getElementById("objects")!;
const body = document.getElementById("props-body")!;
const tabs = document.getElementById("panel-tabs")!;

const NAMES: Record<string, string> = {
    g: "Group",
    rect: "Rectangle",
    circle: "Circle",
    ellipse: "Ellipse",
    line: "Line",
    polyline: "Polyline",
    polygon: "Polygon",
    path: "Path",
    text: "Text",
    image: "Image",
    svg: "Image",
    use: "Clone",
    foreignObject: "Content",
    a: "Link",
};

const collapsed = new Set<string>();

function label(el: Element): string {
    if (isZone(el)) return `Zone · ${zoneName(el)}`;
    const id = el.getAttribute("id");
    const kind = el.hasAttribute("data-ink-layer")
        ? "Layer"
        : (NAMES[el.localName] ?? el.localName);
    if (el.localName === "text") {
        const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        return id ? `${id} · “${t.slice(0, 24)}”` : `“${t.slice(0, 32)}”`;
    }
    return id ?? kind;
}

export function isHidden(el: Element): boolean {
    return (
        (el as SVGElement).style?.display === "none" ||
        el.getAttribute("display") === "none"
    );
}

function children(el: Element): Element[] {
    return [...el.children].filter(
        (c) =>
            c.hasAttribute("data-ink") &&
            !["title", "desc", "defs", "style", "metadata"].includes(
                c.localName,
            ) &&
            // A cropped picture's own <image> is part of the picture.
            el.localName !== "svg",
    );
}

function selFor(el: Element): Selected {
    return {
        el: el as SVGGraphicsElement,
        key: keyOf(el),
        loc: el.getAttribute("data-ink") ?? "",
    };
}

export async function toggleHidden(el: Element): Promise<void> {
    await sendSvgOps(
        [
            {
                sel: selFor(el),
                ops: [
                    {
                        kind: "style",
                        loc: el.getAttribute("data-ink") ?? "",
                        set: { display: isHidden(el) ? null : "none" },
                    },
                ],
            },
        ],
        isHidden(el) ? "Show" : "Hide",
    );
}

export async function toggleLocked(el: Element): Promise<void> {
    const own = el.hasAttribute("data-ink-locked");
    if (!own && isLocked(el)) {
        toast("It is inside a locked layer or group: unlock that instead");
        return;
    }
    await sendSvgOps(
        [
            {
                sel: selFor(el),
                ops: [
                    {
                        kind: "lock",
                        loc: el.getAttribute("data-ink") ?? "",
                        locked: !own,
                    },
                ],
            },
        ],
        own ? "Unlock" : "Lock",
    );
}

function rename(el: Element, nameEl: HTMLElement): void {
    const src = sourceOf(keyOf(el));
    if (!src?.writable || isZone(el)) return;
    const id = el.getAttribute("id") ?? "";
    const input = h("input", { type: "text", class: "obj-rename", value: id });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (save && v && v !== id) {
            void edit({
                action: "svg",
                file: src.path,
                hash: src.hash,
                ops: [
                    {
                        kind: "id",
                        loc: el.getAttribute("data-ink"),
                        id: v,
                        from: id || undefined,
                    },
                ],
                label: "Rename",
            });
        }
        renderObjects();
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
}

function pickFromList(el: Element): void {
    if (isLocked(el)) {
        toast("Locked: unlock it to select it");
        return;
    }
    // An object inside a group is selected inside that group.
    const parent = el.parentElement;
    if (
        parent &&
        !el.hasAttribute("data-ink-top") &&
        parent.localName === "g" &&
        !parent.hasAttribute("data-ink-layer")
    ) {
        enterGroup(parent as unknown as SVGGElement);
    } else if (ed.scope && !ed.scope.contains(el)) {
        enterGroup(null);
    }
    if (!selectable(el)) {
        toast(
            ed.layoutMode
                ? "This object cannot be edited here"
                : "From a layout or overlay: use Edit layout to change it",
        );
        return;
    }
    select([el as SVGGraphicsElement]);
}

function row(el: Element, depth: number): HTMLElement[] {
    const loc = el.getAttribute("data-ink") ?? "";
    const src = sourceOf(keyOf(el));
    const writable =
        !!src?.writable &&
        (canTransform(el) || ed.layoutMode || isOwnObject(el));
    const kids = children(el);
    const group = kids.length > 0;
    const open = group && !collapsed.has(loc);
    const selected = ed.selection.some((s) => s.el === el);
    const locked = el.hasAttribute("data-ink-locked");
    const hidden = isHidden(el);
    const name = h("span", { class: "obj-name" }, label(el));
    const out: HTMLElement[] = [];
    const item = h(
        "div",
        {
            class: `obj-row${selected ? " on" : ""}${writable ? "" : " foreign"}${hidden ? " hidden-obj" : ""}`,
            title: src ? `${label(el)} · ${src.rel}` : label(el),
            style: `padding-left:${8 + depth * 14}px`,
        },
        h(
            "button",
            {
                type: "button",
                class: `obj-twisty${group ? "" : " none"}`,
                title: open ? "Collapse" : "Expand",
                onclick: (e: Event) => {
                    e.stopPropagation();
                    if (collapsed.has(loc)) collapsed.delete(loc);
                    else collapsed.add(loc);
                    renderObjects();
                },
            },
            group ? (open ? "▾" : "▸") : "",
        ),
        name,
        writable
            ? h(
                  "button",
                  {
                      type: "button",
                      class: `obj-toggle${hidden ? " on" : ""}`,
                      title: hidden
                          ? "Hidden: click to show"
                          : "Hide (on the slide and in the presentation)",
                      onclick: (e: Event) => {
                          e.stopPropagation();
                          void toggleHidden(el);
                      },
                  },
                  icon(hidden ? "eyeOff" : "eye", 14),
              )
            : null,
        writable
            ? h(
                  "button",
                  {
                      type: "button",
                      class: `obj-toggle${locked ? " on" : ""}`,
                      title: locked
                          ? "Locked: click to unlock"
                          : "Lock (cannot be selected on the slide)",
                      onclick: (e: Event) => {
                          e.stopPropagation();
                          void toggleLocked(el);
                      },
                  },
                  icon(locked ? "lock" : "unlock", 14),
              )
            : h("span", { class: "obj-badge" }, src?.role ?? ""),
    );
    item.addEventListener("click", () => pickFromList(el));
    item.addEventListener("dblclick", () => rename(el, name));
    item.addEventListener("mouseenter", () => setHover(el));
    item.addEventListener("mouseleave", () => setHover(null));
    out.push(item);
    if (open) {
        for (const k of [...kids].reverse()) out.push(...row(k, depth + 1));
    }
    return out;
}

function isOwnObject(el: Element): boolean {
    const src = sourceOf(keyOf(el));
    // The slide's own drawing, or its ink (a file of this slide alone).
    return (
        !!src && (src.role === "slide" || src.role === "ink") && src.writable
    );
}

export function renderObjects(): void {
    if (host.hidden) return;
    clear(host);
    const svg = slideRoot();
    if (!svg) return;
    const top = [...svg.querySelectorAll("[data-ink-top], [data-ink-layer]")]
        .filter((el) => {
            // Only the outermost: a layer's objects are listed under it.
            const parent = el.parentElement?.closest(
                "[data-ink-top], [data-ink-layer]",
            );
            return !parent || !svg.contains(parent);
        })
        .reverse();
    if (!top.length) {
        host.append(h("p", { class: "hint" }, "No objects on this slide."));
        return;
    }
    host.append(
        h(
            "p",
            { class: "hint" },
            "Top of the stack first. Middle-click (or Alt+click) on the slide steps through overlapping objects.",
        ),
    );
    for (const el of top) host.append(...row(el, 0));
}

function showTab(tab: string): void {
    for (const b of tabs.querySelectorAll<HTMLElement>("[data-tab]")) {
        b.classList.toggle("on", b.dataset.tab === tab);
        b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    }
    host.hidden = tab !== "objects";
    body.hidden = tab === "objects";
    try {
        localStorage.setItem("inkflow-editor-tab", tab);
    } catch {
        // storage unavailable: the tab is just not remembered
    }
    renderObjects();
}

export function initObjects(): void {
    tabs.addEventListener("click", (e) => {
        const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")
            ?.dataset.tab;
        if (tab) showTab(tab);
    });
    let saved = "props";
    try {
        saved = localStorage.getItem("inkflow-editor-tab") ?? "props";
    } catch {
        // ignore
    }
    showTab(saved === "objects" ? "objects" : "props");
    on("render", renderObjects);
    on("selection", renderObjects);
}
