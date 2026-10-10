// Creating things: the shape and text tools, images and videos (picked, dropped
// or pasted), and copy/paste of selected objects.
//
// New objects are written into the slide's own SVG. A slide that is still drawn
// straight from a shared layout gets its own SVG first (built on that layout,
// so it looks the same), which is what makes "just draw on any slide" possible.

import {
    attachTargetAt,
    clearSelection,
    clientToSlide,
    drawOverlay,
    hooks,
    keyOf,
    mediaZoneAt,
    newConnectorPath,
    showSites,
    siteAt,
    slideRoot,
    slideToPaper,
} from "./canvas";
import { pasteText } from "./clipboard";
import { type End, pathData, route, type Site } from "./connectors";
import { svgEl, toast } from "./dom";
import { fmt, invert, mat, multiply, relativePath, transformBox } from "./geom";
import { edit, request } from "./net";
import { assetRef, isPdfRef, withPage } from "./pathtext";
import { choosePage, sourceRef } from "./pdfpages";
import {
    CONNECTOR_TOOLS,
    currentSlide,
    ed,
    emit,
    off,
    on,
    type Tool,
} from "./state";
import type { SlideModel } from "./types";
import { checkVideo, convertForInsert } from "./videocheck";

const overlay = document.getElementById("overlay") as unknown as SVGSVGElement;

// Ids to select once the rebuild that contains them has rendered; with
// editText, the first is edited in place. A placeholder is text written only
// to have something to edit: left as it is, the edit is undone.
export const afterRender: {
    ids: string[];
    editText: boolean;
    placeholder?: string;
} = {
    ids: [],
    editText: false,
};

export function setTool(tool: typeof ed.tool): void {
    ed.tool = tool;
    document.body.dataset.tool = tool;
    emit("tool");
}

function waitForModel(
    pred: (s: SlideModel) => boolean,
    ms = 5000,
): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            off("model", check);
            resolve(ok);
        };
        const deadline = window.setTimeout(() => finish(false), ms);
        const check = () => {
            const s = currentSlide();
            if (s && pred(s)) {
                window.clearTimeout(deadline);
                finish(true);
            }
        };
        on("model", check);
    });
}

// Make sure the current slide has an SVG of its own to draw into.
export async function ensureOwnDrawing(): Promise<boolean> {
    const slide = currentSlide();
    if (!slide) return false;
    if (!slide.srcShared) return true;
    if (!ed.model?.deckEditable) {
        toast(
            "deck.py builds its slides in code; cannot add a drawing here",
            "error",
        );
        return false;
    }
    const deckIndex = slide.deckIndex;
    const result = await edit({
        action: "slide",
        op: "detach",
        slide: deckIndex,
        name: slide.id ?? slide.explicitId ?? "slide",
    });
    if (!result.ok) return false;
    toast("This slide now has its own SVG (built on its layout)");
    return waitForModel((s) => s.deckIndex === deckIndex && !s.srcShared);
}

export function ownSource() {
    return currentSlide()?.sources?.find((s) => s.role === "slide") ?? null;
}

// Where new objects go: the entered group, else the topmost unlocked layer of
// the slide's own file, else its root.
export function insertParent(): { loc: string; el: Element | null } {
    const svg = slideRoot();
    if (ed.scope?.getAttribute("data-ink")?.startsWith("0:")) {
        return { loc: ed.scope.getAttribute("data-ink")!, el: ed.scope };
    }
    const layers = svg
        ? [...svg.querySelectorAll('[data-ink-layer][data-ink^="0:"]')].filter(
              (l) => !l.hasAttribute("data-ink-locked"),
          )
        : [];
    const layer = layers[layers.length - 1];
    if (layer) return { loc: layer.getAttribute("data-ink")!, el: layer };
    return { loc: "0:", el: null };
}

// Slide coordinates → the insertion parent's user space.
export function toParent(
    el: Element | null,
    x: number,
    y: number,
): { x: number; y: number } {
    const svg = slideRoot();
    if (!el || !svg) return { x, y };
    const p = (el as SVGGraphicsElement).getScreenCTM?.();
    const r = svg.getScreenCTM();
    if (!p || !r) return { x, y };
    const m = multiply(invert(mat(p)), mat(r));
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export async function insertXml(
    xml: string | (() => string),
    base: string,
    opts: {
        editText?: boolean;
        marker?: boolean;
        before?: () => Record<string, unknown>[];
    } = {},
): Promise<boolean> {
    if (!(await ensureOwnDrawing())) return false;
    const src = ownSource();
    if (!src) return false;
    const parent = insertParent();
    const ops: Record<string, unknown>[] = [...(opts.before?.() ?? [])];
    if (opts.marker) ops.push({ kind: "ensure-marker" });
    if (typeof xml === "function") xml = xml();
    ops.push({ kind: "insert", parent: parent.loc, xml, base, key: "new" });
    const result = await edit({
        action: "svg",
        file: src.path,
        hash: src.hash,
        ops,
        label: `Insert ${base}`,
    });
    if (!result.ok) return false;
    const id = result.ids?.new;
    if (id) {
        afterRender.ids = [id];
        afterRender.editText = !!opts.editText;
    }
    return true;
}

// ── Shape tools ──

// Strokes and text are sized for a 1080-high slide and grow with a larger
// canvas (a poster's is 3179 wide), so a new shape reads the same on any deck.
function drawScale(): number {
    const vb = slideRoot()?.viewBox.baseVal;
    const short = vb && vb.width > 0 ? Math.min(vb.width, vb.height) : 1080;
    return Math.max(1, Math.round((short / 1080) * 10) / 10);
}

function textScale(): number {
    return (ed.model?.deckSize?.fontSize ?? 36) / 36;
}

const SHAPE_STYLE = {
    get rect() {
        return `class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:${fmt(4 * drawScale())}"`;
    },
    get ellipse() {
        return `class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:${fmt(4 * drawScale())}"`;
    },
    get line() {
        return `class="inkflow-stroke-text" style="fill:none;stroke-width:${fmt(6 * drawScale())};stroke-linecap:round"`;
    },
};

function shapeXml(
    tool: string,
    a: { x: number; y: number },
    b: { x: number; y: number },
): string {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    switch (tool) {
        case "rect":
            return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(16 * drawScale())}" ${SHAPE_STYLE.rect}/>`;
        default:
            return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}" ${SHAPE_STYLE.ellipse}/>`;
    }
}

function textXml(p: { x: number; y: number }): string {
    return `<text x="${fmt(p.x)}" y="${fmt(p.y)}" class="inkflow-fill-text" style="font-size:${fmt(56 * textScale())}px;font-family:var(--inkflow-body-font, sans-serif)">Text</text>`;
}

let draft: SVGElement | null = null;

function drawDraft(
    tool: string,
    a: { x: number; y: number },
    b: { x: number; y: number },
    ends?: { a: End; b: End },
) {
    draft?.remove();
    const m = slideToPaper();
    const style = CONNECTOR_TOOLS[tool as Tool];
    if (style) {
        // The route the connector will take, ends facing their sites.
        const r = route(style, ends?.a ?? a, ends?.b ?? b);
        const toPaper = (p: { x: number; y: number }) => ({
            x: m.a * p.x + m.e,
            y: m.d * p.y + m.f,
        });
        draft = svgEl("path", {
            d: pathData({ ...r, points: r.points.map(toPaper) }),
            class: "draft",
            fill: "none",
        });
    } else {
        const box = transformBox(m, {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x),
            height: Math.abs(b.y - a.y),
        });
        draft =
            tool === "ellipse"
                ? svgEl("ellipse", {
                      cx: box.x + box.width / 2,
                      cy: box.y + box.height / 2,
                      rx: box.width / 2,
                      ry: box.height / 2,
                      class: "draft",
                  })
                : svgEl("rect", {
                      x: box.x,
                      y: box.y,
                      width: box.width,
                      height: box.height,
                      class: "draft",
                  });
    }
    overlay.append(draft);
}

// A line or arrow is a connector: a <path> whose ends attach to the shapes
// they were drawn from and to (inkflow:connect-start/-end), so it follows
// them when they move.
async function insertConnector(
    tool: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    startHit: { el: Element; site: Site } | null,
    endHit: { el: Element; site: Site } | null,
): Promise<void> {
    let a: End = startHit ? startHit.site : from;
    let b: End = endHit ? endHit.site : to;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
        // A click: a default-length line from there.
        a = { x: from.x - 150, y: from.y };
        b = { x: from.x + 150, y: from.y };
        startHit = null;
        endHit = null;
    }
    const before: Record<string, unknown>[] = [];
    const taken = new Set<string>();
    const attach = (hit: { el: Element; site: Site } | null): string | null => {
        if (!hit) return null;
        let id = hit.el.getAttribute("id");
        // A shape in the slide's own drawing gets an id if it has none; one in
        // another file without an id cannot be attached to.
        if (!id && keyOf(hit.el) === 0) {
            const svg = slideRoot();
            let n = 1;
            const base = hit.el.localName;
            while (
                svg?.querySelector(`[id="${base}-${n}"]`) ||
                taken.has(`${base}-${n}`)
            )
                n++;
            id = `${base}-${n}`;
            taken.add(id);
            hit.el.setAttribute("id", id);
            before.push({
                kind: "id",
                loc: hit.el.getAttribute("data-ink"),
                id,
            });
        }
        return id ? `${id}:${hit.site.name}` : null;
    };
    const startAt = attach(startHit);
    const endAt = attach(endHit);
    const style = CONNECTOR_TOOLS[tool as Tool] ?? "straight";
    const arrow = tool !== "line";
    const attrs = [
        `inkflow:connector="${style}"`,
        startAt ? `inkflow:connect-start="${startAt}"` : "",
        endAt ? `inkflow:connect-end="${endAt}"` : "",
        arrow ? 'marker-end="url(#inkflow-arrow)"' : "",
    ]
        .filter(Boolean)
        .join(" ");
    await insertXml(
        // Routed into the insertion parent's space once it is known (a slide
        // drawn from a layout gets its own SVG first).
        () =>
            `<path d="${newConnectorPath(style, a, b, insertParent().el)}" ${SHAPE_STYLE.line} ${attrs}/>`,
        arrow ? "arrow" : "line",
        { marker: arrow, before: () => before },
    );
}

function onToolDown(e: PointerEvent, start: { x: number; y: number }): boolean {
    const tool = ed.tool;
    // The pen draws through its own pad (ink.ts); a pointer that does not
    // draw (a mouse while only a pen does) selects as usual.
    if (tool === "select" || tool === "pen") return false;
    e.preventDefault();
    clearSelection();
    const paperEl = e.currentTarget as HTMLElement;
    try {
        paperEl.setPointerCapture(e.pointerId);
    } catch {
        // A touch replayed as it lifts (editor/touchzoom.ts): no capture.
    }
    ed.interacting = true;
    const connecting = tool in CONNECTOR_TOOLS;
    // Lines and arrows start and end on connection sites when near one.
    const startHit = connecting && !e.altKey ? siteAt(start, null) : null;
    if (startHit) start = { x: startHit.site.x, y: startHit.site.y };
    let endHit: { el: Element; site: Site } | null = null;
    let end = start;
    const move = (ev: PointerEvent) => {
        end = clientToSlide(ev.clientX, ev.clientY);
        if (connecting) {
            endHit = ev.altKey ? null : siteAt(end, null);
            if (endHit) end = { x: endHit.site.x, y: endHit.site.y };
            const under = attachTargetAt(ev.clientX, ev.clientY);
            showSites([
                ...(under
                    ? [
                          {
                              el: under as Element,
                              active: endHit?.el === under ? endHit.site : null,
                          },
                      ]
                    : []),
                ...(endHit && endHit.el !== under
                    ? [{ el: endHit.el, active: endHit.site }]
                    : []),
                ...(startHit
                    ? [{ el: startHit.el, active: startHit.site }]
                    : []),
            ]);
        }
        if (ev.shiftKey && (tool === "rect" || tool === "ellipse")) {
            const d = Math.max(
                Math.abs(end.x - start.x),
                Math.abs(end.y - start.y),
            );
            end = {
                x: start.x + Math.sign(end.x - start.x || 1) * d,
                y: start.y + Math.sign(end.y - start.y || 1) * d,
            };
        }
        drawDraft(
            tool,
            start,
            end,
            connecting
                ? {
                      a: startHit ? startHit.site : start,
                      b: endHit ? endHit.site : end,
                  }
                : undefined,
        );
    };
    const up = () => {
        paperEl.removeEventListener("pointermove", move);
        paperEl.removeEventListener("pointerup", up);
        draft?.remove();
        draft = null;
        ed.interacting = false;
        let a = start;
        let b = end;
        if (connecting) {
            showSites([]);
            void insertConnector(tool, start, end, startHit, endHit);
            setTool("select");
            drawOverlay();
            return;
        }
        if (tool === "text") {
            void insertTextBox(start, end);
            setTool("select");
            drawOverlay();
            return;
        }
        if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
            // A click: a default-sized shape centred there.
            const w = 360;
            const h = 220;
            a = { x: start.x - w / 2, y: start.y - h / 2 };
            b = { x: start.x + w / 2, y: start.y + h / 2 };
        }
        const parent = insertParent().el;
        const pa = toParent(parent, a.x, a.y);
        const pb = toParent(parent, b.x, b.y);
        void insertXml(shapeXml(tool, pa, pb), tool);
        setTool("select");
        if (ed.renderPending) emit("model");
        drawOverlay();
    };
    paperEl.addEventListener("pointermove", move);
    paperEl.addEventListener("pointerup", up);
    return true;
}

// ── Text boxes ──

// A text box wraps its text and holds Markdown (bold words, lists, links…):
// a zone of its own on the slide, edited in place. Where there is nowhere to
// keep its Markdown (a deck built in code, a layout being edited), the text
// tool falls back to a plain SVG text line.
async function insertTextBox(
    a: { x: number; y: number },
    b: { x: number; y: number },
): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    let box = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
    };
    if (box.width < 40 || box.height < 20) {
        // A click: a box from there to near the slide's right edge.
        const k = textScale();
        box = {
            x: a.x,
            y: a.y - 40 * k,
            width: Math.max(300 * k, Math.min(900 * k, vw - a.x - 60 * k)),
            height: 100 * k,
        };
    }
    const plain = ed.layoutMode || (!ed.model?.deckEditable && !slide.md);
    if (plain) {
        const p = toParent(insertParent().el, a.x, a.y);
        await insertXml(textXml(p), "text", { editText: true });
        return;
    }
    if (!(await ensureOwnDrawing())) return;
    const src = ownSource();
    const current = currentSlide();
    if (!src || !current) return;
    const parent = insertParent();
    const p0 = toParent(parent.el, box.x, box.y);
    const p1 = toParent(parent.el, box.x + box.width, box.y + box.height);
    const result = await edit({
        action: "insert-textbox",
        slide: current.deckIndex,
        file: src.path,
        hash: src.hash,
        parent: parent.loc,
        x: Math.round(Math.min(p0.x, p1.x)),
        y: Math.round(Math.min(p0.y, p1.y)),
        width: Math.round(Math.abs(p1.x - p0.x)),
        height: Math.round(Math.abs(p1.y - p0.y)),
        text: "Text",
    });
    const id = result.ids?.new;
    if (result.ok && id) {
        afterRender.ids = [id];
        afterRender.editText = true;
    }
}

// ── Text in shapes ──

export async function typeInto(el: Element): Promise<void> {
    const slide = currentSlide();
    const loc = el.getAttribute("data-ink");
    const src = slide?.sources?.[keyOf(el)];
    if (!slide || !loc || !src) return;
    if (!ed.model?.deckEditable && !slide.md) {
        toast(
            "deck.py builds its slides in code; there is nowhere to keep the text",
            "error",
        );
        return;
    }
    const result = await edit({
        action: "shape-text",
        slide: slide.deckIndex,
        file: src.path,
        hash: src.hash,
        loc,
    });
    const id = result.ids?.new;
    if (result.ok && id) {
        afterRender.ids = [id];
        afterRender.editText = true;
    }
}

// ── Text into an empty zone ──

/** "content-left" -> "Content left": what an empty zone first says. */
export function zonePlaceholder(zone: string): string {
    const words = zone.replace(/[-_]+/g, " ").trim() || "Text";
    return words[0].toUpperCase() + words.slice(1);
}

// A layout's empty text zone, from its "+" label: it gets its name as text,
// which is then edited in place (selected, so typing replaces it).
export async function zoneText(zone: string): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    const text = zonePlaceholder(zone);
    const result = await edit({
        action: "zone-text",
        slide: slide.deckIndex,
        zone,
        text,
    });
    if (!result.ok) return;
    afterRender.ids = [`zone-${zone}`];
    afterRender.editText = true;
    afterRender.placeholder = text;
}

// ── Images ──

function readBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const url = String(reader.result);
            resolve(url.slice(url.indexOf(",") + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// A file to bring into the deck: one the browser holds (a pick, a drop, a
// paste), or one on this computer named by its path (a drop that carried a
// file:// link, the folder browser). The server copies a path itself, so it
// costs nothing to send whatever its size.
export type MediaIn = File | { path: string; name: string; file?: File };

const CHUNK = 4 * 1024 * 1024;

/** Copy a file into the deck's assets; no size limit. A video in another
 * format (one ffmpeg reads) is converted first, in the convert dialog. */
export async function upload(
    media: MediaIn,
): Promise<{ path: string; rel: string } | null> {
    if (!(media instanceof File)) {
        const result = await request({
            action: "import-path",
            path: media.path,
        });
        if (result.ok && result.convert) {
            return convertForInsert(String(result.source));
        }
        if (result.ok && result.path && result.rel) {
            return { path: result.path, rel: result.rel };
        }
        // Not this computer, or not readable there: send the dropped file.
        if (media.file) return upload(media.file);
        toast(result.error ?? "could not copy the file", "error");
        return null;
    }
    // In chunks: one message per few MB, staged by the server until complete.
    const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const big = media.size > 3 * CHUNK;
    let result: Awaited<ReturnType<typeof request>> = { ok: false };
    for (let at = 0; at < media.size || at === 0; at += CHUNK) {
        const last = at + CHUNK >= media.size;
        const data = await readBase64(media.slice(at, at + CHUNK));
        result = await request({
            action: "upload-chunk",
            upload: id,
            name: media.name,
            data,
            last,
        });
        if (!result.ok) {
            toast(result.error ?? "upload failed", "error");
            return null;
        }
        if (big) {
            const done = Math.min(
                100,
                Math.round(((at + CHUNK) / media.size) * 100),
            );
            toast(`Copying ${media.name}… ${done}%`);
        }
        if (last) break;
    }
    if (result.convert) return convertForInsert(String(result.source));
    if (!result.path || !result.rel) return null;
    return { path: result.path, rel: result.rel as string };
}

/** A file:// link a drop carries (Firefox and others add one for files
 * dragged from a file manager), as a local path. */
export function droppedPath(dt: DataTransfer | null): string | null {
    const list = dt?.getData("text/uri-list") ?? "";
    const uri = list.split(/\r?\n/).find((line) => line.startsWith("file://"));
    if (!uri) return null;
    try {
        const url = new URL(uri);
        if (url.host && url.host !== "localhost") return null;
        return decodeURIComponent(url.pathname).replace(
            /^\/([A-Za-z]:\/)/,
            "$1",
        );
    } catch {
        return null;
    }
}

export function naturalSize(rel: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () =>
            resolve({
                w: img.naturalWidth || 400,
                h: img.naturalHeight || 300,
            });
        img.onerror = () => resolve({ w: 400, h: 300 });
        img.src = `/${rel}`;
    });
}

export interface BrowserVideo {
    w: number;
    h: number;
    // Whether this browser could read the video at all (codec, container).
    decoded: boolean;
    duration: number | null;
}

export function videoSize(rel: string): Promise<BrowserVideo> {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        const fallback = { w: 1280, h: 720, decoded: false, duration: null };
        // A format the browser cannot decode never loads its metadata.
        const timer = window.setTimeout(() => resolve(fallback), 3000);
        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () => {
            window.clearTimeout(timer);
            const duration = Number.isFinite(video.duration)
                ? video.duration
                : null;
            resolve(
                video.videoWidth && video.videoHeight
                    ? {
                          w: video.videoWidth,
                          h: video.videoHeight,
                          decoded: true,
                          duration,
                      }
                    : { ...fallback, duration },
            );
        };
        video.onerror = () => {
            window.clearTimeout(timer);
            resolve(fallback);
        };
        video.src = `/${rel}`;
    });
}

// Video formats the pickers offer: what browsers play, and what ffmpeg
// converts (the server decides, by reading the file).
const VIDEO_EXT =
    /\.(mp4|webm|ogg|ogv|mov|mkv|avi|m4v|wmv|flv|mpe?g|ts|mts|m2ts|3gp|3g2|mxf|vob|f4v|asf|dv)$/i;
export const VIDEO_ACCEPT =
    "video/*,.mkv,.avi,.m4v,.wmv,.flv,.mpg,.mpeg,.ts,.mts,.m2ts,.3gp,.mxf,.vob,.dv";

export function isVideo(file: MediaIn): boolean {
    return (
        (file instanceof File && file.type.startsWith("video/")) ||
        VIDEO_EXT.test(file.name)
    );
}

// A PDF is a picture too: the slide shows one page of it (a paper's figure).
export const IMAGE_ACCEPT = "image/*,.pdf,application/pdf";

function isImage(file: MediaIn): boolean {
    return (
        (file instanceof File &&
            (file.type.startsWith("image/") ||
                file.type === "application/pdf")) ||
        /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(file.name)
    );
}

// A video goes into a zone of its own: a new rect in the slide's SVG, filled
// through zones={...} in deck.py, so it plays like any other Video (and its
// settings show in the panel). Both files change in one undoable step.
export async function insertVideoFile(
    file: MediaIn,
    at?: { x: number; y: number },
): Promise<void> {
    if (!(await ensureOwnDrawing())) return;
    const up = await upload(file);
    const src = ownSource();
    const slide = currentSlide();
    if (!up || !src || !slide) return;
    const size = await videoSize(up.rel);
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    const vh = vb?.height || 1080;
    const k = Math.min((vw * 0.6) / size.w, (vh * 0.6) / size.h);
    const w = size.w * k;
    const h = size.h * k;
    // Centred on the drop point, but kept on the slide.
    const cx = Math.min(Math.max(at?.x ?? vw / 2, w / 2), vw - w / 2);
    const cy = Math.min(Math.max(at?.y ?? vh / 2, h / 2), vh - h / 2);
    const parent = insertParent();
    const a = toParent(parent.el, cx - w / 2, cy - h / 2);
    const b = toParent(parent.el, cx + w / 2, cy + h / 2);
    const result = await edit({
        action: "insert-video",
        slide: slide.deckIndex,
        file: src.path,
        hash: src.hash,
        parent: parent.loc,
        x: Math.round(Math.min(a.x, b.x)),
        y: Math.round(Math.min(a.y, b.y)),
        width: Math.round(Math.abs(b.x - a.x)),
        height: Math.round(Math.abs(b.y - a.y)),
        src: up.path,
    });
    const id = result.ids?.new;
    if (result.ok && id) {
        afterRender.ids = [id];
        void checkVideo({
            path: up.path,
            slide: slide.deckIndex,
            zone: id.replace(/^zone-/, ""),
            browser: size,
        });
    }
}

export async function insertVideo(): Promise<void> {
    const file = await pickFile(VIDEO_ACCEPT);
    if (file) await insertVideoFile(file);
}

// A dropped or pasted file: into the media zone under it if there is one,
// else onto the slide as a free image or video.
export async function insertFile(
    file: MediaIn,
    at?: { x: number; y: number; clientX: number; clientY: number },
): Promise<void> {
    const zone = at ? mediaZoneAt(at.clientX, at.clientY) : null;
    if (zone) {
        await fillZone(zone, file);
        return;
    }
    if (isImage(file)) await insertImageFile(file, at);
    // Anything else may be a video in a format ffmpeg reads: the server
    // reads it, and refuses what is not one.
    else await insertVideoFile(file, at);
}

export async function insertImageFile(
    file: MediaIn,
    at?: { x: number; y: number },
) {
    if (!(await ensureOwnDrawing())) return;
    const up = await upload(file);
    const src = ownSource();
    if (!up || !src) return;
    let href = relativePath(src.path, up.path);
    let shown: string | null = up.rel;
    if (isPdfRef(up.path)) {
        const choice = await choosePage(up.path);
        if (!choice) return;
        href = withPage(href, choice.page);
        shown = choice.url;
    }
    // Without a converter the picture is a placeholder: give it a page's shape.
    const size = shown ? await naturalSize(shown) : { w: 400, h: 300 };
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const maxW = (vb?.width || 1920) * 0.5;
    const maxH = (vb?.height || 1080) * 0.5;
    const k = Math.min(1, maxW / size.w, maxH / size.h);
    const w = size.w * k;
    const h = size.h * k;
    const cx = at?.x ?? (vb?.width || 1920) / 2;
    const cy = at?.y ?? (vb?.height || 1080) / 2;
    const parent = insertParent().el;
    const p = toParent(parent, cx - w / 2, cy - h / 2);
    await insertXml(
        `<image href="${href}" x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="xMidYMid meet"/>`,
        "image",
    );
}

/** A draw.io diagram's picture, in the middle of the slide (the editor
 * just saved the file, at most half the slide in either direction). */
export async function insertDiagramImage(
    path: string,
    width: number,
    height: number,
): Promise<boolean> {
    if (!(await ensureOwnDrawing())) return false;
    const src = ownSource();
    if (!src) return false;
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const slideW = vb?.width || 1920;
    const slideH = vb?.height || 1080;
    const k = Math.min(1, (slideW * 0.6) / width, (slideH * 0.6) / height);
    const w = width * k;
    const ht = height * k;
    const parent = insertParent().el;
    const p = toParent(parent, (slideW - w) / 2, (slideH - ht) / 2);
    return insertXml(
        `<image href="${relativePath(src.path, path)}" x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(w)}" height="${fmt(ht)}" preserveAspectRatio="xMidYMid meet"/>`,
        "diagram",
    );
}

export function pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.click();
    });
}

export async function insertImage(): Promise<void> {
    const file = await pickFile(IMAGE_ACCEPT);
    if (file) await insertImageFile(file);
}

const MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;

export async function fillZone(zone: string, file: MediaIn): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    const up = await upload(file);
    if (!up) return;
    const choice = isPdfRef(up.path) ? await choosePage(up.path) : null;
    if (isPdfRef(up.path) && !choice) return;
    const result = await edit({
        action: "zone-media",
        slide: slide.deckIndex,
        zone,
        src: up.path,
        page: choice?.page ?? null,
        fit: slide.zones[zone]?.fit ?? "cover",
    });
    if (result.ok && isVideo(file)) {
        void checkVideo({
            path: up.path,
            slide: slide.deckIndex,
            zone,
            browser: await videoSize(up.rel),
        });
    }
}

export async function zoneMedia(zone: string): Promise<void> {
    const file = await pickFile(MEDIA_ACCEPT);
    if (file) await fillZone(zone, file);
}

// ── Copy / paste ──

export function cleanForPaste(el: Element): string {
    const copy = el.cloneNode(true) as Element;
    for (const node of [copy, ...copy.querySelectorAll("*")]) {
        // A PDF picture shows a converted page: the copy names the PDF.
        if (node.hasAttribute("data-inkflow-pdf")) {
            node.setAttribute("href", sourceRef(node));
            node.removeAttribute("xlink:href");
        }
        for (const attr of [...node.attributes]) {
            const name = attr.name;
            if (name.startsWith("data-")) node.removeAttribute(name);
            else if (name === "xlink:href") {
                node.setAttribute("href", assetRef(attr.value));
                node.removeAttribute(name);
            } else if (["href", "src", "poster"].includes(name)) {
                // Never the version the server stamps on served slides.
                node.setAttribute(name, assetRef(attr.value));
            } else if (name.includes(":") && !name.startsWith("xml:")) {
                node.removeAttribute(name);
            } else if (name === "class") {
                const kept = attr.value
                    .split(/\s+/)
                    .filter((c) => c && !c.startsWith("anim-"));
                if (kept.length) node.setAttribute("class", kept.join(" "));
                else node.removeAttribute("class");
            }
        }
        (node as HTMLElement).style?.removeProperty?.("visibility");
    }
    return new XMLSerializer().serializeToString(copy);
}

// ── Wiring ──

export function initInsert(): void {
    hooks.toolDown = onToolDown;
    hooks.typeInto = (el) => void typeInto(el);
    hooks.zoneMedia = (zone) => void zoneMedia(zone);
    hooks.zoneText = (zone) => void zoneText(zone);
    hooks.selectAfterRender = (ids) => {
        afterRender.ids = ids;
    };
    const canvas = document.getElementById("canvas")!;
    canvas.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            canvas.classList.add("drop");
        }
    });
    canvas.addEventListener("dragleave", () => canvas.classList.remove("drop"));
    canvas.addEventListener("drop", (e) => {
        canvas.classList.remove("drop");
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        e.preventDefault();
        const at = {
            ...clientToSlide(e.clientX, e.clientY),
            clientX: e.clientX,
            clientY: e.clientY,
        };
        // With the file's path the server copies it straight from disk;
        // without one (or if that fails) the browser sends its contents.
        const path = droppedPath(e.dataTransfer);
        void insertFile(path ? { path, name: file.name, file } : file, at);
    });
    document.addEventListener("paste", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest("textarea, input")) return;
        const file = [...(e.clipboardData?.files ?? [])].find(
            (f) =>
                f.type.startsWith("image/") ||
                f.type === "application/pdf" ||
                isVideo(f),
        );
        if (file) {
            e.preventDefault();
            void insertFile(file);
            return;
        }
        e.preventDefault();
        void pasteText(e.clipboardData?.getData("text/plain") ?? "");
    });
}
