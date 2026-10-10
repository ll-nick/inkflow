// Copy and paste through the system clipboard, so it works between two editor
// tabs on different decks (each served by its own `inkflow edit`), as between
// two PowerPoint windows.
//
// Copying asks the server that owns the deck for a self-contained bundle
// (inkflow/editor/transfer.py): the Slide(...) calls and every file they need,
// or the copied objects plus the images they show. The bundle goes on the
// clipboard as text with a recognisable prefix. Pasting hands it to *this*
// tab's server, which checks it, places the files and rewrites references.

import { canTransform, clearSelection } from "./canvas";
import { toast } from "./dom";
import {
    afterRender,
    cleanForPaste,
    ensureOwnDrawing,
    insertParent,
    ownSource,
} from "./insert";
import { edit, request } from "./net";
import { gotoSlide } from "./sorter";
import { currentSlide, ed, emit } from "./state";

const PREFIX = "inkflow-clipboard:";

// The last copy, kept for when the system clipboard refuses (a browser without
// clipboard permission): pasting in the same tab still works.
let lastCopied: string | null = null;

async function put(payload: Record<string, unknown>): Promise<void> {
    const text = PREFIX + JSON.stringify(payload);
    lastCopied = text;
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        toast("Copied for this tab only: the browser blocked the clipboard");
    }
}

// Slides selected in the slide list (deck indices); the current slide if none.
export function selectedSlides(): number[] {
    const picked = [...ed.slideSelection].sort((a, b) => a - b);
    return picked.length ? picked : [ed.current];
}

export async function copySlides(indices = selectedSlides()): Promise<boolean> {
    const result = await request({ action: "copy-slides", slides: indices });
    if (!result.ok) {
        toast(result.error ?? "could not copy", "error");
        return false;
    }
    const bundle = (result as unknown as { bundle: Record<string, unknown> })
        .bundle;
    await put(bundle);
    const dropped = (bundle.dropped as string[]) ?? [];
    const n = indices.length;
    toast(
        `Copied ${n} slide${n > 1 ? "s" : ""}` +
            (dropped.length ? `; left out ${dropped.join(", ")}` : ""),
    );
    return true;
}

export async function cutSlides(): Promise<void> {
    const indices = selectedSlides();
    if (!(await copySlides(indices))) return;
    const result = await edit({
        action: "slide",
        op: "delete",
        slides: indices,
    });
    if (result.ok) {
        ed.slideSelection.clear();
        ed.current = Math.max(0, Math.min(...indices) - 1);
        emit("slide");
    }
}

function imageRefs(xml: string): string[] {
    const refs = new Set<string>();
    for (const m of xml.matchAll(
        /<image\b[^>]*?\b(?:xlink:)?href="([^"]*)"/g,
    )) {
        if (!/^(data:|https?:|#|\/)/.test(m[1])) refs.add(m[1]);
    }
    return [...refs];
}

export async function copyObjects(cut = false): Promise<boolean> {
    // Filled zones are content, not objects: they stay with their layout.
    const sels = ed.selection.filter((s) => s.el.localName !== "foreignObject");
    if (!sels.length) return false;
    const fragments = sels.map((s) => cleanForPaste(s.el));
    const refs = fragments.flatMap(imageRefs);
    let files: Record<string, unknown> = {};
    if (refs.length) {
        const result = await request({ action: "copy-assets", refs });
        files =
            (result as unknown as { files?: Record<string, unknown> }).files ??
            {};
    }
    await put({
        type: "inkflow-objects",
        version: 1,
        project: ed.model?.projectDir,
        sourceFile: currentSlide()?.sources?.[sels[0].key]?.path ?? "",
        fragments,
        files,
    });
    const n = sels.length;
    toast(`${cut ? "Cut" : "Copied"} ${n} object${n > 1 ? "s" : ""}`);
    if (cut) emit("delete");
    return true;
}

// Ctrl+C: the selected objects, else the current (or selected) slides.
export function copy(): void {
    if (ed.selection.length) void copyObjects();
    else void copySlides();
}

export function cut(): void {
    if (ed.selection.some((s) => canTransform(s.el))) void copyObjects(true);
    else void cutSlides();
}

async function pasteSlides(bundle: Record<string, unknown>): Promise<void> {
    const after = ed.current;
    const result = await edit({ action: "paste-slides", after, bundle });
    if (!result.ok) return;
    const n = (result as unknown as { pasted: number }).pasted;
    toast(`Pasted ${n} slide${n > 1 ? "s" : ""}`, "ok");
    ed.slideSelection.clear();
    afterSlides = after + 1;
}

// Follow the first pasted slide once the rebuild lists it.
let afterSlides: number | null = null;

export function followPastedSlides(): void {
    if (afterSlides != null && afterSlides < (ed.model?.slides.length ?? 0)) {
        const target = afterSlides;
        afterSlides = null;
        gotoSlide(target);
    }
}

async function pasteObjects(bundle: Record<string, unknown>): Promise<void> {
    if (!(await ensureOwnDrawing())) return;
    const src = ownSource();
    if (!src) return;
    const sameFile = bundle.sourceFile === src.path;
    clearSelection();
    const result = await edit({
        action: "paste-objects",
        file: src.path,
        hash: src.hash,
        parent: insertParent().loc,
        fragments: bundle.fragments,
        files: bundle.files,
        // Copies on the same slide are offset so they do not hide the original.
        offset: sameFile ? [24, 24] : null,
    });
    if (result.ok && result.ids) afterRender.ids = Object.values(result.ids);
}

export async function pasteText(text: string): Promise<void> {
    const raw = text.startsWith(PREFIX) ? text : lastCopied;
    if (!raw?.startsWith(PREFIX)) return;
    let bundle: Record<string, unknown>;
    try {
        bundle = JSON.parse(raw.slice(PREFIX.length));
    } catch {
        toast("The clipboard holds damaged inkflow data", "error");
        return;
    }
    if (bundle.type === "inkflow-slides") await pasteSlides(bundle);
    else if (bundle.type === "inkflow-objects") await pasteObjects(bundle);
}

// Paste from a menu, where there is no paste event to read from.
export async function pasteFromClipboard(): Promise<void> {
    let text = "";
    try {
        text = await navigator.clipboard.readText();
    } catch {
        text = lastCopied ?? "";
    }
    await pasteText(text);
}
