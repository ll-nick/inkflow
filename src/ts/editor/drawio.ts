// draw.io diagrams on slides. A diagram is a draw.io "editable SVG"
// (diagrams/<name>.drawio.svg: a picture with the diagram's source inside),
// shown on the slide as an <image>. Double-click (or "Edit diagram") opens
// draw.io full screen in embed mode, which talks to this page by
// postMessage; saving exports the editable SVG and the server writes it back
// (editor/session.py `drawio-save`: one undo step, source uncompressed).
//
// draw.io is loaded from embed.diagrams.net unless INKFLOW_DRAWIO_URL names
// another copy (self-hosted, offline). Messages are only taken from that
// frame and that origin.

import {
    connectorsTo,
    isStale,
    keyOf,
    rerouteConnectors,
    slideRoot,
} from "./canvas";
import { pictureOf } from "./crop";
import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { drawnBox, median } from "./drawioshapes";
import { insertDiagramImage } from "./insert";
import { edit, request } from "./net";
import { currentSlide, off, on, sourceOf } from "./state";
import type { Selected } from "./types";

/**
 * A draw.io diagram on the slide: its picture, or the diagram drawn into the
 * slide (an <svg> standing in for that picture, see drawio_inline.py).
 */
export function diagramOf(el: Element): SVGGraphicsElement | null {
    const drawn = drawnDiagram(el);
    if (drawn) return drawn;
    const image = pictureOf(el);
    return image && isDiagramHref(hrefOf(image)) ? image : null;
}

/** A diagram drawn into the slide (inkflow:drawio="inline" / "themed"). */
export function drawnDiagram(el: Element): SVGSVGElement | null {
    return el.localName === "svg" && el.hasAttribute("data-drawio")
        ? (el as SVGSVGElement)
        : null;
}

export function isDiagramHref(href: string): boolean {
    return /\.drawio\.svg$/i.test(href.split(/[?#]/)[0]);
}

function hrefOf(el: Element): string {
    return (
        el.getAttribute("data-drawio") ??
        el.getAttribute("href") ??
        el.getAttribute("xlink:href") ??
        ""
    ).split(/[?#]/)[0];
}

export type DiagramMode = "picture" | "inline" | "themed";

export const DIAGRAM_MODES: { value: DiagramMode; label: string }[] = [
    { value: "picture", label: "Picture" },
    { value: "inline", label: "Drawn on the slide" },
    { value: "themed", label: "In the deck's theme" },
];

export function diagramMode(el: Element): DiagramMode {
    const mode = drawnDiagram(el)?.getAttribute("data-drawio-mode");
    return mode === "inline" || mode === "themed" ? mode : "picture";
}

interface Target {
    // The diagram file (project-relative, as the slide shows it); none for a
    // new diagram, which gets its file on the first save.
    path: string | null;
    // The slide's picture of it: keeps its width, follows new proportions.
    image?: { file: string; hash: string; loc: string };
    // Its id: arrows attached to it or its shapes follow a save.
    id?: string | null;
}

let open: HTMLElement | null = null;

/** Edit the diagram a selected picture shows. */
export function editDiagram(sel: Selected): void {
    const image = diagramOf(sel.el);
    const src = sourceOf(sel.key);
    if (!image || !src) return;
    if (!src.writable) {
        toast("This picture lives in a layout; switch to layout mode", "error");
        return;
    }
    void openDrawio({
        path: hrefOf(image),
        image: {
            file: src.path,
            hash: src.hash,
            loc: image.getAttribute("data-ink") ?? sel.loc,
        },
        id: image.getAttribute("id"),
    });
}

/** Draw a new diagram; it is placed on the slide when first saved. */
export function newDiagram(): void {
    if (!currentSlide()) return;
    void openDrawio({ path: null });
}

async function openDrawio(target: Target): Promise<void> {
    if (open) return;
    const res = await request({ action: "drawio-load", path: target.path });
    if (!res.ok) {
        toast(res.error ?? "Cannot open that diagram", "error");
        return;
    }
    const base = String(res.url);
    let origin: string;
    try {
        origin = new URL(base).origin;
    } catch {
        toast(`INKFLOW_DRAWIO_URL is not a web address: ${base}`, "error");
        return;
    }
    const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
    if (!navigator.onLine && !local) {
        offerDesktop(
            target,
            `This computer is offline, and draw.io loads from ${origin}.`,
        );
        return;
    }
    const dark = document.documentElement.dataset.theme !== "light";
    const params = new URLSearchParams({
        embed: "1",
        proto: "json",
        spin: "1",
        configure: "1",
        saveAndExit: "1",
        noSaveBtn: "0",
        libraries: "1",
        modified: "unsavedChanges",
        ui: dark ? "dark" : "kennedy",
    });
    const frame = h("iframe", {
        class: "drawio-frame",
        src: `${base}${base.includes("?") ? "&" : "?"}${params}`,
        title: "draw.io",
    }) as HTMLIFrameElement;
    let path = target.path;
    let exitAfterSave = false;
    let saving = false;
    let loaded = false;
    const status = h("p", {}, `Loading draw.io from ${origin}…`);
    const note = h(
        "div",
        { class: "drawio-note" },
        h(
            "div",
            { class: "drawio-note-card" },
            status,
            h(
                "div",
                { class: "btn-row" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        title: "Draw it in the draw.io app on this computer (no internet needed)",
                        onclick: () => {
                            close();
                            void useDesktop({ ...target, path });
                        },
                    },
                    "Use draw.io desktop instead",
                ),
                h(
                    "button",
                    { type: "button", class: "pbtn", onclick: () => close() },
                    "Cancel",
                ),
            ),
        ),
    );
    const wrap = h("div", { id: "drawio", class: "drawio" }, frame, note);
    document.body.append(wrap);
    open = wrap;
    // No word from draw.io: most likely no internet (or a wrong address).
    const slow = window.setTimeout(() => {
        if (loaded) return;
        status.textContent = `draw.io did not load from ${origin}. Is this computer offline? Draw the diagram in draw.io desktop instead.`;
        note.classList.add("failed");
    }, 15000);

    const post = (msg: Record<string, unknown>) =>
        frame.contentWindow?.postMessage(JSON.stringify(msg), origin);

    const close = () => {
        window.clearTimeout(slow);
        window.removeEventListener("message", onMessage);
        wrap.remove();
        open = null;
    };

    const save = async (svg: string) => {
        const first = path === null;
        // The arrows' re-routing joins the save's undo step.
        const step = `drawio-save-${Date.now()}`;
        const result = await edit({
            action: "drawio-save",
            path,
            svg,
            image: first ? undefined : target.image,
            coalesce: step,
        });
        if (result.ok && !first && target.id) followArrows(target.id, step);
        saving = false;
        if (!result.ok) {
            post({ action: "status", message: "Not saved", modified: true });
            return;
        }
        if (first && typeof result.rel === "string") {
            path = result.rel;
            // Its picture goes on the slide, sized to the diagram.
            await insertDiagramImage(
                String(result.path),
                Number(result.width) || 640,
                Number(result.height) || 360,
            );
        }
        if (exitAfterSave) close();
        else post({ action: "status", message: "Saved", modified: false });
    };

    const onMessage = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || e.origin !== origin) return;
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(String(e.data));
        } catch {
            return;
        }
        switch (msg.event) {
            case "configure":
                loaded = true;
                // Uncompressed source: readable diffs (the server makes
                // sure anyway).
                post({ action: "configure", config: { compressXml: false } });
                break;
            case "init":
                loaded = true;
                note.remove();
                post({
                    action: "load",
                    xml: String(res.xml ?? ""),
                    autosave: 0,
                    title: String(res.name ?? "Diagram"),
                });
                break;
            case "save":
                if (saving) break;
                saving = true;
                exitAfterSave = !!msg.exit;
                // The editable SVG: the picture plus the diagram's source.
                post({ action: "export", format: "xmlsvg", spin: "Saving" });
                break;
            case "export": {
                const data = String(msg.data ?? "");
                const svg = decodeSvg(data);
                if (svg) void save(svg);
                else {
                    saving = false;
                    toast("draw.io sent something other than an SVG", "error");
                }
                break;
            }
            case "exit":
                close();
                break;
        }
    };
    window.addEventListener("message", onMessage);
}

// Arrows attached to a diagram (or its shapes, when drawn into the slide)
// follow it once the slide shows the saved diagram.
function followArrows(id: string, step: string): void {
    const rendered = () => {
        off("render", rendered);
        window.clearTimeout(give);
        const stale = connectorsTo(id).filter(isStale);
        if (stale.length)
            void rerouteConnectors(stale, "Re-route arrows", step);
    };
    const give = window.setTimeout(() => off("render", rendered), 10000);
    on("render", rendered);
}

// ── Redrawing a diagram whose shapes were edited on the slide ──
//
// Shapes edited here change the diagram's source (editor/drawioedit.py), and
// the server patches its picture meanwhile. draw.io then draws the picture
// from the source, in a hidden frame, into the same undo step: its arrows
// follow the shapes again. draw.io crops a picture to its drawing, so the
// slide's picture takes a box that keeps the unmoved shapes where they are.

const redraws = new Map<string, number>();
let redrawCount = 0;

export function diagramEdited(diagram: Element, step: string): void {
    const id = diagram.getAttribute("id");
    if (!id) return;
    const n = ++redrawCount;
    window.clearTimeout(timers.get(id));
    redraws.set(id, n);
    // Once edits pause (held arrow keys, a quick series of changes).
    timers.set(
        id,
        window.setTimeout(() => void redraw(id, step, n), 600),
    );
}

const timers = new Map<string, number>();

function drawnById(id: string): SVGSVGElement | null {
    return (
        (slideRoot()?.querySelector(
            `svg[data-drawio][id="${CSS.escape(id)}"]`,
        ) as SVGSVGElement | null) ?? null
    );
}

// The slide's next rendering (the patched picture), or now if it is due.
function rendered(ms = 4000): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            off("render", done);
            window.clearTimeout(give);
            resolve();
        };
        const give = window.setTimeout(done, ms);
        on("render", done);
    });
}

async function redraw(id: string, step: string, n: number): Promise<void> {
    const latest = () => redraws.get(id) === n;
    await rendered(1500);
    const diagram = drawnById(id);
    const path = diagram?.getAttribute("data-drawio");
    if (!diagram || !path || !latest()) return;
    const res = await request({ action: "drawio-load", path });
    if (!res.ok || !latest()) return;
    let svg: string;
    try {
        svg = await renderDiagram(String(res.xml ?? ""), String(res.url));
    } catch (err) {
        if (latest()) {
            toast(
                `${err instanceof Error ? err.message : String(err)}: the shape changed, and draw.io's own arrows follow it the next time draw.io opens the diagram`,
                "error",
            );
        }
        return;
    }
    const now = drawnById(id);
    const src = now ? sourceOf(keyOf(now)) : null;
    const box = now ? alignedBox(now, svg) : null;
    if (!now || !src || !box || !latest()) return;
    const result = await edit(
        {
            action: "drawio-save",
            path,
            svg,
            expect: res.hash,
            image: {
                file: src.path,
                hash: src.hash,
                loc: now.getAttribute("data-ink") ?? "",
            },
            box,
            coalesce: step,
        },
        { retrying: true },
    );
    if (result.ok) {
        redraws.delete(id);
        followArrows(id, step);
    }
}

/**
 * The slide picture's box for a new drawing of the diagram: draw.io crops
 * to the drawing, so the page moves on the picture when the drawing grows or
 * shrinks; the shapes (as the slide shows them now) stay where they are.
 */
function alignedBox(
    diagram: SVGSVGElement,
    svgText: string,
): { x: number; y: number; width: number; height: number } | null {
    const holder = h("div", {
        style: "position:fixed;left:-30000px;top:0;visibility:hidden",
        "aria-hidden": "true",
    });
    holder.innerHTML = svgText;
    document.body.append(holder);
    try {
        const fresh = holder.querySelector("svg");
        const oldRoot = diagram.querySelector(":scope > g");
        const newRoot = fresh?.querySelector(":scope > g");
        if (!fresh || !oldRoot || !newRoot) return null;
        const dx: number[] = [];
        const dy: number[] = [];
        for (const cell of diagram.querySelectorAll(
            'g[data-cell-kind="vertex"][data-cell-id]',
        )) {
            const id = cell.getAttribute("data-cell-id") ?? "";
            const other = newRoot.querySelector(
                `g[data-cell-id="${CSS.escape(id)}"]`,
            );
            const a = drawnBox(cell, oldRoot);
            const b = other ? drawnBox(other, newRoot) : null;
            if (!a || !b) continue;
            dx.push(b.x - a.x);
            dy.push(b.y - a.y);
        }
        const vbOld = diagram.viewBox.baseVal;
        const vbNew = fresh.viewBox.baseVal;
        if (!dx.length || !vbOld?.width || !vbNew?.width) return null;
        const num = (name: string) =>
            Number.parseFloat(diagram.getAttribute(name) ?? "0") || 0;
        const sx = num("width") / vbOld.width;
        const sy = num("height") / vbOld.height;
        const r = (v: number) => Math.round(v * 100) / 100;
        return {
            x: r(num("x") + (vbNew.x - vbOld.x - median(dx)) * sx),
            y: r(num("y") + (vbNew.y - vbOld.y - median(dy)) * sy),
            width: r(vbNew.width * sx),
            height: r(vbNew.height * sy),
        };
    } finally {
        holder.remove();
    }
}

// One hidden draw.io frame, kept a few minutes for the next redraw.
let renderer: {
    base: string;
    frame: HTMLIFrameElement;
    origin: string;
    ready: Promise<void>;
    closeTimer: number;
} | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();

function closeRenderer(): void {
    renderer?.frame.remove();
    renderer = null;
}

function hiddenFrame(base: string): NonNullable<typeof renderer> {
    if (renderer && renderer.base === base) {
        window.clearTimeout(renderer.closeTimer);
        renderer.closeTimer = window.setTimeout(closeRenderer, 180000);
        return renderer;
    }
    closeRenderer();
    const origin = new URL(base).origin;
    const params = new URLSearchParams({
        embed: "1",
        proto: "json",
        configure: "1",
        spin: "0",
    });
    const frame = h("iframe", {
        src: `${base}${base.includes("?") ? "&" : "?"}${params}`,
        title: "draw.io (drawing the diagram)",
        "aria-hidden": "true",
        tabindex: "-1",
        style: "position:fixed;left:-30000px;top:0;width:1200px;height:800px;border:0",
    }) as HTMLIFrameElement;
    // draw.io focuses itself on load: never the hidden one (keyboard
    // shortcuts must keep reaching the editor).
    frame.inert = true;
    const ready = new Promise<void>((resolve, reject) => {
        const give = window.setTimeout(() => {
            window.removeEventListener("message", onMessage);
            reject(new Error("draw.io did not load"));
        }, 20000);
        const onMessage = (e: MessageEvent) => {
            if (e.source !== frame.contentWindow || e.origin !== origin) return;
            const msg = parseMessage(e.data);
            if (msg?.event === "configure") {
                frame.contentWindow?.postMessage(
                    JSON.stringify({
                        action: "configure",
                        config: { compressXml: false },
                    }),
                    origin,
                );
            } else if (msg?.event === "init") {
                window.clearTimeout(give);
                window.removeEventListener("message", onMessage);
                resolve();
            }
        };
        window.addEventListener("message", onMessage);
    });
    document.body.append(frame);
    renderer = {
        base,
        frame,
        origin,
        ready,
        closeTimer: window.setTimeout(closeRenderer, 180000),
    };
    ready.catch(() => closeRenderer());
    return renderer;
}

function parseMessage(data: unknown): Record<string, unknown> | null {
    try {
        return JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** draw.io's editable SVG of a diagram source, drawn in the hidden frame. */
function renderDiagram(xml: string, base: string): Promise<string> {
    const run = renderQueue.then(async () => {
        let origin: string;
        try {
            origin = new URL(base).origin;
        } catch {
            throw new Error(`INKFLOW_DRAWIO_URL is not a web address: ${base}`);
        }
        const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
        if (!navigator.onLine && !local)
            throw new Error("This computer is offline");
        const r = hiddenFrame(base);
        await r.ready;
        return new Promise<string>((resolve, reject) => {
            const post = (msg: Record<string, unknown>) =>
                r.frame.contentWindow?.postMessage(
                    JSON.stringify(msg),
                    r.origin,
                );
            const finish = () => {
                window.clearTimeout(give);
                window.removeEventListener("message", onMessage);
                if (document.activeElement === r.frame) r.frame.blur();
            };
            const give = window.setTimeout(() => {
                finish();
                reject(new Error("draw.io did not draw the diagram"));
            }, 20000);
            const onMessage = (e: MessageEvent) => {
                if (e.source !== r.frame.contentWindow || e.origin !== r.origin)
                    return;
                const msg = parseMessage(e.data);
                if (msg?.event === "load") {
                    post({ action: "export", format: "xmlsvg", spin: "0" });
                } else if (msg?.event === "export") {
                    finish();
                    const svg = decodeSvg(String(msg.data ?? ""));
                    if (svg) resolve(svg);
                    else reject(new Error("draw.io sent no SVG"));
                }
            };
            window.addEventListener("message", onMessage);
            post({ action: "load", xml, autosave: 0 });
        });
    });
    renderQueue = run.catch(() => undefined);
    return run;
}

// ── draw.io desktop (no internet needed) ──

function offerDesktop(target: Target, why: string): void {
    openDialog(
        "Draw in draw.io desktop?",
        h(
            "div",
            { class: "deck-form" },
            h("p", {}, why),
            h(
                "p",
                { class: "hint" },
                "The diagram can be drawn in the draw.io app on this computer instead: save there, and the slide updates.",
            ),
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => closeDialog(),
                    },
                    "Cancel",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        onclick: () => {
                            closeDialog();
                            void useDesktop(target);
                        },
                    },
                    "Open in draw.io desktop",
                ),
            ),
        ),
    );
}

// A new diagram first gets its file (a placeholder picture on the slide),
// then draw.io desktop opens it; saving there updates the slide.
async function useDesktop(target: Target): Promise<void> {
    let path = target.path;
    const apps = path ? await request({ action: "open-apps", path }) : null;
    if (path && !hasDesktop(apps?.apps)) {
        desktopMissing();
        return;
    }
    if (!path) {
        const made = await edit({ action: "drawio-new" });
        if (!made.ok || typeof made.rel !== "string") return;
        path = made.rel;
        const placed = await insertDiagramImage(
            String(made.path),
            Number(made.width) || 640,
            Number(made.height) || 360,
        );
        if (!placed) return;
        const found = await request({ action: "open-apps", path });
        if (!hasDesktop(found.apps)) {
            desktopMissing();
            return;
        }
    }
    const res = await request({ action: "open-file", path, app: "drawio" });
    if (!res.ok) {
        toast(res.error ?? "draw.io desktop did not start", "error");
        return;
    }
    toast("Opened in draw.io desktop: save there and the slide updates", "ok");
}

function hasDesktop(apps: unknown): boolean {
    return (
        Array.isArray(apps) &&
        apps.some((a) => (a as { id?: string }).id === "drawio")
    );
}

function desktopMissing(): void {
    openDialog(
        "draw.io desktop is not installed",
        h(
            "div",
            { class: "deck-form" },
            h(
                "p",
                {},
                "Install the draw.io app (free) on this computer, then try again:",
            ),
            h(
                "ul",
                {},
                h(
                    "li",
                    {},
                    h(
                        "a",
                        {
                            href: "https://www.drawio.com/",
                            target: "_blank",
                            rel: "noopener",
                        },
                        "drawio.com",
                    ),
                    " (Windows, macOS, Linux)",
                ),
                h(
                    "li",
                    {},
                    "Linux: flatpak install flathub com.jgraph.drawio.desktop",
                ),
            ),
            h(
                "p",
                { class: "hint" },
                "Or run draw.io on your own network (the jgraph/drawio Docker image) and start inkflow with INKFLOW_DRAWIO_URL pointing at it.",
            ),
        ),
    );
}

/** An SVG data URI (base64 or plain) as text. */
export function decodeSvg(data: string): string | null {
    const m = data.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
    if (!m) return data.trimStart().startsWith("<") ? data : null;
    if (!m[1]) return decodeURIComponent(m[2]);
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function drawioOpen(): boolean {
    return open !== null;
}
