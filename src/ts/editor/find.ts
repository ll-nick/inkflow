// Find and replace across the deck (Ctrl+F / Ctrl+H).
//
// The server searches the files the slides are made of (their SVGs, Markdown
// and notes, and the text strings in deck.py) and replaces as one undo step
// (inkflow/editor/findreplace.py). Results are grouped by slide; clicking one
// goes to that slide and selects the text it is in.

import { select, selectable, slideRoot } from "./canvas";
import { clear, h, toast } from "./dom";
import { edit, request } from "./net";
import { gotoSlide } from "./sorter";
import { currentSlide, ed, on } from "./state";
import type { SlideModel } from "./types";

interface Hit {
    file: string;
    kind: "svg" | "md" | "deck";
    index: number;
    before: string;
    match: string;
    after: string;
    line: number;
    loc: string | null;
    id: string | null;
    slide: number | null;
}

const panel = document.getElementById("find-panel")!;

let hits: Hit[] = [];
let active = -1;
let timer = 0;
const opts = { matchCase: false, wholeWord: false, regex: false };
let scope: "deck" | "slide" = "deck";

function el<T extends HTMLElement>(sel: string): T {
    return panel.querySelector(sel) as T;
}

function slideFiles(s: SlideModel): string[] {
    const out = (s.sources ?? [])
        .filter((src) => src.writable)
        .map((src) => src.path);
    if (s.srcPath) out.push(s.srcPath);
    if (s.md?.path) out.push(s.md.path);
    if (s.notes?.path) out.push(s.notes.path);
    return out;
}

function files(): string[] {
    const slides =
        scope === "slide"
            ? [currentSlide()].filter((s): s is SlideModel => !!s)
            : (ed.model?.slides ?? []);
    return [...new Set(slides.flatMap(slideFiles))];
}

// The slides a hit shows on: the deck.py slide it is written in, or every
// slide made from its file.
function slidesOf(hit: Hit): number[] {
    if (hit.kind === "deck") return hit.slide != null ? [hit.slide] : [];
    return (ed.model?.slides ?? [])
        .filter((s) => slideFiles(s).includes(hit.file))
        .map((s) => s.deckIndex);
}

function query(): string {
    return el<HTMLInputElement>(".find-input").value;
}

function base(): Record<string, unknown> {
    // "This slide": deck.py's text of this slide only, in a search or a replace.
    const deckSlide = scope === "slide" ? currentSlide()?.deckIndex : undefined;
    return { query: query(), files: files(), deckSlide, ...opts };
}

async function search(): Promise<void> {
    const q = query();
    if (!q) {
        hits = [];
        renderResults();
        return;
    }
    const result = await request({ action: "find", ...base() });
    if (q !== query()) return; // typed on meanwhile
    if (!result.ok) {
        hits = [];
        renderResults(result.error ?? "search failed");
        return;
    }
    hits = (result as unknown as { hits: Hit[] }).hits;
    active = Math.min(active, hits.length - 1);
    renderResults();
}

function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 220);
}

function fileLabel(path: string): string {
    const root = ed.model?.projectDir ?? "";
    return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

function renderResults(error?: string): void {
    const list = el<HTMLElement>(".find-results");
    const status = el<HTMLElement>(".find-status");
    clear(list);
    if (error) {
        status.textContent = error;
        return;
    }
    if (!query()) {
        status.textContent = "";
        return;
    }
    const slides = new Set(hits.flatMap(slidesOf));
    status.textContent = hits.length
        ? `${hits.length}${hits.length >= 500 ? "+" : ""} match${hits.length === 1 ? "" : "es"} on ${slides.size} slide${slides.size === 1 ? "" : "s"}`
        : "No matches";
    let lastGroup = "";
    hits.forEach((hit, i) => {
        const on = slidesOf(hit);
        const first = on[0];
        const slide = first != null ? ed.model?.slides[first] : null;
        const group =
            slide != null
                ? `${first + 1} · ${slide.title ?? slide.id ?? ""}`
                : fileLabel(hit.file);
        if (group !== lastGroup) {
            list.append(h("div", { class: "find-group" }, group));
            lastGroup = group;
        }
        const where =
            hit.kind === "deck"
                ? "deck.py"
                : `${fileLabel(hit.file)}${on.length > 1 ? ` · ${on.length} slides` : ""}`;
        const row = h(
            "button",
            {
                type: "button",
                class: `find-hit${i === active ? " on" : ""}`,
                title: where,
                onclick: () => goTo(i),
            },
            h(
                "span",
                { class: "find-snippet" },
                hit.before,
                h("mark", {}, hit.match),
                hit.after,
            ),
            h("span", { class: "find-where" }, where),
        );
        list.append(row);
    });
}

function goTo(i: number): void {
    const hit = hits[i];
    if (!hit) return;
    active = i;
    renderResults();
    const on = slidesOf(hit);
    const cur = currentSlide()?.deckIndex;
    const target = cur != null && on.includes(cur) ? cur : on[0];
    if (target != null) gotoSlide(target);
    if (hit.kind === "svg" && hit.loc != null) {
        const slide = currentSlide();
        const key = slide?.sources?.findIndex((s) => s.path === hit.file) ?? -1;
        const node =
            key >= 0
                ? slideRoot()?.querySelector(`[data-ink="${key}:${hit.loc}"]`)
                : null;
        if (node && selectable(node)) select([node as SVGGraphicsElement]);
    }
    panel.querySelector(".find-hit.on")?.scrollIntoView({ block: "nearest" });
}

async function replace(all: boolean): Promise<void> {
    const q = query();
    if (!q) return;
    if (!all && active < 0) {
        goTo(0);
        return;
    }
    const replacement = el<HTMLInputElement>(".replace-input").value;
    const hit = hits[active];
    if (all && hits.length > 1) {
        const n = hits.length;
        if (
            !window.confirm(
                `Replace ${n} matches of “${q}” with “${replacement}”?`,
            )
        ) {
            return;
        }
    }
    const result = await edit({
        action: "replace",
        replacement,
        ...base(),
        only: all ? undefined : { file: hit.file, index: hit.index },
    });
    if (result.ok) {
        const n = (result as unknown as { replaced: number }).replaced;
        toast(`Replaced ${n} match${n === 1 ? "" : "es"}`);
    }
}

function toggle(name: keyof typeof opts, btn: HTMLElement): void {
    opts[name] = !opts[name];
    btn.classList.toggle("on", opts[name]);
    schedule();
}

function build(): void {
    const flag = (label: string, title: string, name: keyof typeof opts) => {
        const b = h(
            "button",
            { type: "button", class: "find-flag", title },
            label,
        );
        b.addEventListener("click", () => toggle(name, b));
        return b;
    };
    const find = h("input", {
        type: "text",
        class: "find-input",
        placeholder: "Find in slides, notes and deck.py",
        spellcheck: "false",
    });
    const repl = h("input", {
        type: "text",
        class: "replace-input",
        placeholder: "Replace with",
        spellcheck: "false",
    });
    const where = h("select", { class: "find-scope", title: "Where to look" });
    where.append(
        h("option", { value: "deck" }, "All slides"),
        h("option", { value: "slide" }, "This slide"),
    );
    where.addEventListener("change", () => {
        scope = where.value === "slide" ? "slide" : "deck";
        schedule();
    });
    find.addEventListener("input", () => {
        active = -1;
        schedule();
    });
    find.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (hits.length)
                goTo(
                    (active + (e.shiftKey ? -1 : 1) + hits.length) %
                        hits.length,
                );
        }
    });
    repl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void replace(e.ctrlKey || e.metaKey);
        }
    });
    panel.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") closeFind();
    });
    panel.append(
        h(
            "div",
            { class: "find-row" },
            find,
            flag("Aa", "Match case", "matchCase"),
            flag("ab", "Whole words", "wholeWord"),
            flag(".*", "Regular expression", "regex"),
            h(
                "button",
                {
                    type: "button",
                    class: "find-close",
                    title: "Close (Esc)",
                    onclick: closeFind,
                },
                "×",
            ),
        ),
        h(
            "div",
            { class: "find-row" },
            repl,
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "Replace this match (Enter)",
                    onclick: () => void replace(false),
                },
                "Replace",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "Replace every match (Ctrl+Enter)",
                    onclick: () => void replace(true),
                },
                "All",
            ),
        ),
        h(
            "div",
            { class: "find-row" },
            where,
            h("span", { class: "find-status" }),
        ),
        h("div", { class: "find-results" }),
    );
}

export function openFind(replaceMode = false): void {
    if (!panel.childElementCount) build();
    panel.hidden = false;
    const input = el<HTMLInputElement>(
        replaceMode ? ".replace-input" : ".find-input",
    );
    // Start from the selected text, as editors do.
    const picked = window.getSelection()?.toString().trim();
    if (picked && !picked.includes("\n")) {
        el<HTMLInputElement>(".find-input").value = picked;
    }
    input.focus();
    input.select();
    schedule();
}

export function closeFind(): void {
    panel.hidden = true;
}

export function initFind(): void {
    document
        .getElementById("btn-find")
        ?.addEventListener("click", () => openFind());
    // Results follow the files: search again after every rebuild.
    on("model", () => {
        if (!panel.hidden && query()) schedule();
    });
}
