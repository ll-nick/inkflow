// Review comments: threads pinned to a slide, a point on it or one of its
// elements, for the people editing the deck to discuss, answer and resolve.
// Shift+C (or a slide's menu, or the command palette) starts one: on the
// selected element, else where you click next on the slide. Open threads
// show as numbered pins on the canvas and as a count on the slide's row and
// grid tile; a pin or the count opens the slide's comments. The server keeps
// them by slide id in .inkflow/comments.json (editor/comments.py), outside
// the deck and git, and tells every editor page of each change.

import {
    drawOverlay,
    hooks,
    outlineOf,
    slideRoot,
    slideToPaper,
} from "./canvas";
import {
    ago,
    commentTitle,
    openCount,
    slideThreads,
    type Thread,
    whereWords,
} from "./commentstext";
import { closeDialog, dialogOpen, openDialog } from "./dialog";
import { clear, h, svgEl, toast } from "./dom";
import { firstKey, matches } from "./keys";
import { edit, onMessage } from "./net";
import { ed, emit, on } from "./state";

const canvasEl = document.getElementById("canvas")!;

interface Draft {
    slide: number;
    x?: number;
    y?: number;
    target?: string;
}

let dialogBody: HTMLElement | null = null;
let dialogSlide: number | null = null;
let focusThread: string | null = null;
let draft: Draft | null = null;
let placing: ((e: PointerEvent) => void) | null = null;

function threads(): Thread[] {
    return ed.model?.comments ?? [];
}

function slideId(i: number): string | undefined {
    return ed.model?.slides[i]?.id;
}

function setThreads(next: unknown): void {
    if (!ed.model || !Array.isArray(next)) return;
    ed.model.comments = next as Thread[];
    emit("comments");
}

// ── Marks ──

function paint(badge: Element, i: number): void {
    const n = openCount(threads(), slideId(i));
    badge.textContent = n ? `💬${n > 1 ? n : ""}` : "";
    if (n)
        badge.setAttribute(
            "title",
            commentTitle(slideThreads(threads(), slideId(i))),
        );
    else badge.removeAttribute("title");
}

/** The open comments' count on a slide's row or tile; a click opens them. */
export function commentBadge(i: number): HTMLElement {
    const badge = h("span", { class: "comment-mark" });
    paint(badge, i);
    badge.addEventListener("click", (e) => {
        if (!badge.textContent) return;
        e.stopPropagation();
        openComments(i);
    });
    return badge;
}

export function markComments(item: Element, i: number): void {
    const badge = item.querySelector(".comment-mark");
    if (badge) paint(badge, i);
}

// ── Pins on the canvas ──

function pinPoint(t: Thread): { x: number; y: number } | null {
    const svg = slideRoot();
    if (!svg) return null;
    if (t.target) {
        const el = svg.querySelector(`#${CSS.escape(t.target)}`);
        if (el instanceof SVGGraphicsElement) {
            const c = outlineOf(el);
            if (c) {
                return {
                    x: Math.max(...c.map((p) => p.x)),
                    y: Math.min(...c.map((p) => p.y)),
                };
            }
        }
    }
    const m = slideToPaper();
    if (t.x != null && t.y != null) {
        return {
            x: m.a * t.x + m.c * t.y + m.e,
            y: m.b * t.x + m.d * t.y + m.f,
        };
    }
    return { x: m.e + 24, y: m.f + 24 };
}

function drawPins(overlay: SVGSVGElement): void {
    if (ed.master || ed.step != null) return;
    const list = slideThreads(threads(), slideId(ed.current)).filter(
        (t) => !t.resolved,
    );
    list.forEach((t, k) => {
        const p = pinPoint(t);
        if (!p) return;
        const g = svgEl("g", {
            class: "comment-pin",
            transform: `translate(${p.x} ${p.y})`,
        });
        g.append(svgEl("circle", { r: 11 }));
        const label = svgEl("text", { "text-anchor": "middle", y: 4 });
        label.textContent = String(k + 1);
        g.append(label);
        const title = svgEl("title", {});
        title.textContent = commentTitle([t]);
        g.append(title);
        g.addEventListener("pointerdown", (e) => e.stopPropagation());
        g.addEventListener("click", (e) => {
            e.stopPropagation();
            openComments(ed.current, t.id);
        });
        overlay.append(g);
    });
}

// ── Adding ──

function stopPlacing(): void {
    if (placing) canvasEl.removeEventListener("pointerdown", placing, true);
    placing = null;
    document.body.classList.remove("placing-comment");
}

/** A new comment on the slide being edited: on the selected element, else
 * where the next click on the slide lands. */
export function addComment(): void {
    if (ed.master) {
        toast("Comments go on slides, not on the slide master", "error");
        return;
    }
    const slide = ed.model?.slides[ed.current];
    if (!slide?.visible) {
        toast("A hidden slide takes no comments: show it first", "error");
        return;
    }
    const sel = ed.selection.length === 1 ? ed.selection[0].el : null;
    if (sel) {
        const id = sel.getAttribute("id");
        if (id) {
            openComments(ed.current, null, { slide: ed.current, target: id });
            return;
        }
        // No id to name it by: pinned at its middle.
        const mid = middle(sel as SVGGraphicsElement);
        if (mid) {
            openComments(ed.current, null, { slide: ed.current, ...mid });
            return;
        }
    }
    stopPlacing();
    document.body.classList.add("placing-comment");
    toast("Click on the slide where the comment goes (Esc: cancel)");
    placing = (e: PointerEvent) => {
        if (!slideRoot()?.contains(e.target as Node)) {
            stopPlacing();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        stopPlacing();
        const pt = clientPoint(e);
        openComments(ed.current, null, { slide: ed.current, ...pt });
    };
    canvasEl.addEventListener("pointerdown", placing, true);
}

// An element's middle in slide units.
function middle(el: SVGGraphicsElement): { x: number; y: number } | null {
    const root = slideRoot()?.getScreenCTM();
    const own = el.getScreenCTM?.();
    if (!root || !own) return null;
    try {
        const b = el.getBBox();
        const p = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2)
            .matrixTransform(own)
            .matrixTransform(root.inverse());
        return { x: p.x, y: p.y };
    } catch {
        return null;
    }
}

// The click's point in slide units.
function clientPoint(e: PointerEvent): { x: number; y: number } {
    const svg = slideRoot();
    const m = svg?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
}

// ── The slide's comments ──

async function send(req: Record<string, unknown>): Promise<boolean> {
    const res = await edit({ action: "comment", ...req });
    if (!res.ok) return false;
    setThreads(res.comments);
    return true;
}

function composer(
    placeholder: string,
    label: string,
    onSend: (text: string) => Promise<boolean>,
): HTMLElement {
    const text = h("textarea", {
        class: "git-message",
        rows: "2",
        placeholder,
    }) as HTMLTextAreaElement;
    const go = async () => {
        if (!text.value.trim()) return;
        if (await onSend(text.value)) text.value = "";
    };
    text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void go();
        }
    });
    return h(
        "div",
        { class: "comment-compose" },
        text,
        h(
            "button",
            {
                type: "button",
                class: "pbtn primary",
                title: "Ctrl+Enter",
                onclick: () => void go(),
            },
            label,
        ),
    );
}

function threadView(t: Thread, k: number): HTMLElement {
    const box = h(
        "div",
        {
            class: `comment-thread${t.resolved ? " resolved" : ""}${t.id === focusThread ? " focus" : ""}`,
            "data-thread": t.id,
        },
        h(
            "div",
            { class: "comment-head" },
            h(
                "span",
                { class: "comment-num" },
                t.resolved ? "✓" : String(k + 1),
            ),
            h("span", { class: "hint" }, whereWords(t)),
            h("span", { class: "cmp-spacer" }),
            h(
                "button",
                {
                    type: "button",
                    class: "link-btn",
                    onclick: () =>
                        void send({
                            op: "resolve",
                            thread: t.id,
                            on: !t.resolved,
                        }),
                },
                t.resolved ? "Reopen" : "Resolve",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: "link-btn",
                    onclick: () => {
                        if (confirm("Delete this thread and its replies?"))
                            void send({ op: "delete", thread: t.id });
                    },
                },
                "Delete",
            ),
        ),
        ...t.messages.map((m) =>
            h(
                "div",
                { class: "comment-msg" },
                h(
                    "div",
                    { class: "comment-who" },
                    h("strong", {}, m.name || "someone"),
                    " ",
                    h("span", { class: "hint" }, ago(m.at)),
                ),
                h("div", { class: "comment-text" }, m.text),
            ),
        ),
    );
    if (!t.resolved) {
        box.append(
            composer("Reply…", "Reply", (text) =>
                send({ op: "reply", thread: t.id, text }),
            ),
        );
    }
    return box;
}

function renderDialog(): void {
    if (!dialogBody || dialogSlide == null) return;
    clear(dialogBody);
    if (draft) {
        const d = draft;
        const where = d.target
            ? `on #${d.target}`
            : d.x != null && d.y != null
              ? `at ${Math.round(d.x)}, ${Math.round(d.y)}`
              : "on the slide";
        dialogBody.append(
            h("div", { class: "hint" }, `New comment ${where}`),
            composer("Write a comment…", "Comment", async (text) => {
                const ok = await send({ op: "add", ...d, text });
                if (ok) draft = null;
                renderDialog();
                return ok;
            }),
        );
    }
    const list = slideThreads(threads(), slideId(dialogSlide));
    let open = 0;
    for (const t of list) {
        dialogBody.append(threadView(t, t.resolved ? -1 : open));
        if (!t.resolved) open += 1;
    }
    if (!list.length && !draft) {
        dialogBody.append(
            h("p", { class: "hint" }, "No comments on this slide yet."),
        );
    }
    if (!draft) {
        dialogBody.append(
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => {
                        closeDialog();
                        addComment();
                    },
                },
                withKey("New comment…"),
            ),
        );
    }
    dialogBody
        .querySelector(".comment-thread.focus")
        ?.scrollIntoView({ block: "nearest" });
    (
        dialogBody.querySelector(
            ".comment-compose textarea",
        ) as HTMLElement | null
    )?.focus();
}

/** Slide `i`'s comments; `thread` shown first, `start` a new one. */
export function openComments(
    i: number,
    thread: string | null = null,
    start: Draft | null = null,
): void {
    dialogSlide = i;
    focusThread = thread;
    draft = start;
    dialogBody = h("div", { class: "comment-body" });
    const slide = ed.model?.slides[i];
    openDialog(
        `Comments on slide ${i + 1}: ${slide?.title ?? slide?.id ?? ""}`,
        dialogBody,
        {
            wide: true,
            onClose: () => {
                dialogBody = null;
                draft = null;
            },
        },
    );
    renderDialog();
}

/** The slide menu's entries for slide `i`. */
export function commentItems(
    i: number,
    item: (label: string, fn: () => void, disabled?: boolean) => HTMLElement,
): HTMLElement[] {
    const slide = ed.model?.slides[i];
    if (!slide?.visible) return [];
    const n = openCount(threads(), slide.id);
    return [
        item(withKey("Add comment…"), () => addComment()),
        ...(slideThreads(threads(), slide.id).length
            ? [item(`Comments (${n} open)…`, () => openComments(i))]
            : []),
    ];
}

function withKey(label: string): string {
    const k = firstKey("review.comment");
    return k ? `${label} (${k})` : label;
}

export function initComments(): void {
    hooks.drawComments = drawPins;
    onMessage("comments", (msg) => setThreads(msg.comments));
    on("comments", () => {
        drawOverlay();
        if (dialogBody && dialogOpen()) renderDialog();
    });
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Escape" && placing) {
                stopPlacing();
                return;
            }
            const target = e.target as HTMLElement | null;
            if (
                target?.closest(
                    "input, textarea, select, [contenteditable], #dialog",
                )
            )
                return;
            if (matches(e, "review.comment")) {
                e.preventDefault();
                e.stopImmediatePropagation();
                addComment();
            }
        },
        true,
    );
}
