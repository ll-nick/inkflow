// Speaker notes under the canvas: the slide's notes Markdown (a file, an
// Inline(...) in deck.py, or a new notes/<slide>.md created on first input),
// saved as you type with the whole typing burst as one undo step.
//
// Two views: Write (the Markdown) and Preview (the notes as the presenter
// panel shows them: the HTML the build rendered, so the two cannot disagree).
// The panel's top edge drags to make it taller; its height and view are the
// author's, kept for every slide and across reloads.

import { edit } from "./net";
import { clampHeight, NOTES_DEFAULT, readNumber } from "./notestext";
import { gotoSlide } from "./sorter";
import { currentRendered, currentSlide, ed, on } from "./state";

const area = document.getElementById("notes-input") as HTMLTextAreaElement;
const preview = document.getElementById("notes-preview")!;
const label = document.getElementById("notes-file")!;
const handle = document.getElementById("notes-resize")!;
const writeBtn = document.getElementById("notes-write")!;
const readBtn = document.getElementById("notes-read")!;
const workspace = document.getElementById("workspace")!;
const panel = document.getElementById("notes")!;

const HEIGHT_KEY = "inkflow-editor-notes-height";
const VIEW_KEY = "inkflow-editor-notes-view";

let timer = 0;
let slideIndex = -1;
let sent = "";
let burst = "";
let reading = false;

async function save(): Promise<void> {
    window.clearTimeout(timer);
    const slide = ed.model?.slides[slideIndex];
    if (!slide || area.value === sent) return;
    const before = sent;
    sent = area.value;
    const result = await edit(
        {
            action: "notes",
            slide: slide.deckIndex,
            text: area.value,
            name: slide.id ?? "slide",
            coalesce: burst,
        },
        { retrying: true },
    );
    if (!result.ok) {
        // Most often deck.py has not rebuilt yet after the previous save
        // (the first save of a new notes file); try again shortly.
        sent = before;
        timer = window.setTimeout(() => void save(), 800);
    }
}

function load(): void {
    const slide = currentSlide();
    if (!slide) return;
    showPreview();
    if (document.activeElement === area && slideIndex === slide.deckIndex)
        return;
    slideIndex = slide.deckIndex;
    area.value = slide.notes.text;
    sent = area.value;
    label.textContent =
        slide.notes.kind === "file"
            ? (slide.notes.rel ?? "")
            : slide.notes.kind === "inline"
              ? "inline in deck.py"
              : "new notes file on first edit";
}

// ── Preview ──

function emptyNote(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "notes-empty";
    p.textContent = text;
    return p;
}

// The notes as built: the slide's notes file and any ::notes:: of its
// Markdown, rendered by the build (what the presenter panel shows).
function showPreview(): void {
    if (!reading) return;
    const slide = currentSlide();
    if (slide && !slide.visible) {
        delete preview.dataset.shown;
        preview.replaceChildren(
            emptyNote("A hidden slide is not built: show it to read its notes"),
        );
        return;
    }
    const html = currentRendered()?.notes ?? "";
    if (preview.dataset.shown === html) return;
    preview.dataset.shown = html;
    if (!html.trim()) {
        preview.replaceChildren(emptyNote("No speaker notes on this slide"));
        return;
    }
    preview.innerHTML = html;
    preview.scrollTop = 0;
    for (const a of preview.querySelectorAll("a[href]")) {
        // A web link opens beside the editor, never in its place.
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
    }
}

function setView(read: boolean, remember = true): void {
    reading = read;
    area.hidden = read;
    preview.hidden = !read;
    writeBtn.classList.toggle("on", !read);
    readBtn.classList.toggle("on", read);
    writeBtn.setAttribute("aria-pressed", String(!read));
    readBtn.setAttribute("aria-pressed", String(read));
    if (remember) {
        try {
            localStorage.setItem(VIEW_KEY, read ? "read" : "write");
        } catch {
            // not remembered
        }
    }
    if (!read) return;
    delete preview.dataset.shown;
    // What was just typed shows once its save has built (the next model).
    void save();
    showPreview();
}

function followLink(e: MouseEvent): void {
    const link = (e.target as Element).closest?.("[data-inkflow-slide]");
    if (!link) return;
    e.preventDefault();
    const id = link.getAttribute("data-inkflow-slide");
    const to = ed.model?.slides.find((s) => s.id === id);
    if (to) gotoSlide(to.deckIndex);
}

// ── Height ──

function setHeight(px: number, remember = true): void {
    const h = clampHeight(px, workspace.getBoundingClientRect().height);
    workspace.style.setProperty("--notes-h", `${h}px`);
    handle.setAttribute("aria-valuenow", String(h));
    if (!remember) return;
    try {
        localStorage.setItem(HEIGHT_KEY, String(h));
    } catch {
        // not remembered
    }
}

function height(): number {
    return panel.getBoundingClientRect().height;
}

function initResize(): void {
    let from: { y: number; height: number } | null = null;
    handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        from = { y: e.clientY, height: height() };
        try {
            handle.setPointerCapture(e.pointerId);
        } catch {
            // a replayed touch's pointer may be gone (touchzoom.ts)
        }
        document.body.classList.add("notes-resizing");
    });
    handle.addEventListener("pointermove", (e) => {
        // Up is taller: the notes grow from their top edge.
        if (from) setHeight(from.height + from.y - e.clientY, false);
    });
    const done = () => {
        if (!from) return;
        from = null;
        document.body.classList.remove("notes-resizing");
        setHeight(height());
    };
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
    handle.addEventListener("dblclick", () => setHeight(NOTES_DEFAULT));
    handle.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 80 : 20;
        if (e.key === "ArrowUp") setHeight(height() + step);
        else if (e.key === "ArrowDown") setHeight(height() - step);
        else if (e.key === "Home") setHeight(NOTES_DEFAULT);
        else return;
        e.preventDefault();
        e.stopPropagation();
    });
    // A smaller window never leaves the notes taller than it has room for.
    window.addEventListener("resize", () => {
        if (workspace.style.getPropertyValue("--notes-h"))
            setHeight(height(), false);
    });
}

export function initNotes(): void {
    area.addEventListener("focus", () => {
        burst = `notes-${Date.now()}`;
    });
    area.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void save(), 600);
    });
    area.addEventListener("blur", () => void save());
    area.addEventListener("keydown", (e) => e.stopPropagation());
    writeBtn.addEventListener("click", () => {
        setView(false);
        area.focus();
    });
    readBtn.addEventListener("click", () => setView(true));
    preview.addEventListener("click", followLink);
    // Read, then fix a word: a double click goes back to writing.
    preview.addEventListener("dblclick", (e) => {
        if ((e.target as Element).closest?.("a")) return;
        setView(false);
        area.focus();
    });
    initResize();
    let view: string | null = null;
    let stored: number | null = null;
    try {
        view = localStorage.getItem(VIEW_KEY);
        stored = readNumber(localStorage.getItem(HEIGHT_KEY));
    } catch {
        // the usual view and height
    }
    if (stored != null) setHeight(stored, false);
    if (view === "read") setView(true, false);
    on("slide", () => {
        void save().then(load);
    });
    on("model", load);
}
