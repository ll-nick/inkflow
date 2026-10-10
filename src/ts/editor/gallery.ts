// The layout gallery: a preview of every layout, rendered by the server in this
// deck's own theme, colour mode and overlays, for inserting a new slide or
// switching the current one to another layout.

import { parseViewBox } from "../shared/viewbox";
import { clear, h, toast } from "./dom";
import { edit, request } from "./net";
import { newSlide } from "./sorter";
import { currentSlide, ed, on } from "./state";
import type { EmptyZone } from "./types";

interface Preview {
    name: string;
    source: string;
    zones: string[];
    svg: string;
    emptyZones: EmptyZone[];
}

const LABELS: Record<string, [string, string]> = {
    numbered: ["Blank", "Background and slide number"],
    title: ["Title only", "A title; draw the rest"],
    content: ["Title and content", "The everyday text slide"],
    "two-cols": ["Two columns", "Side by side under one title"],
    "three-cols": ["Three columns", "Three short columns"],
    comparison: ["Comparison", "Two headed columns"],
    agenda: ["Agenda", "A numbered outline"],
    quad: ["Four quadrants", "A two-by-two grid"],
    "three-cards": ["Three cards", "An image over text, three times"],
    "media-left": ["Media and text", "Image or video on the left"],
    "media-right": ["Text and media", "Image or video on the right"],
    "title-media": ["Title and media", "One large image or video"],
    "full-media": ["Full-bleed media", "A photo or video edge to edge"],
    cover: ["Cover", "The opening slide"],
    section: ["Section header", "Divides the deck into parts"],
    center: ["Centered", "One centered block"],
    fact: ["Big number", "One number or claim"],
    quote: ["Quote", "A pull quote with attribution"],
    end: ["Closing", "The last slide"],
    "poster-3col": ["Poster, three columns", "Title band, sections, footer"],
    "poster-2col": ["Poster, two columns", "Title band, sections, footer"],
    "poster-landscape-3col": [
        "Landscape poster, three columns",
        "Title band, sections, footer",
    ],
    "poster-landscape-4col": [
        "Landscape poster, four columns",
        "Title band, sections, footer",
    ],
};

const root = document.getElementById("gallery")!;
let cache: Preview[] | null = null;

export function layoutLabel(name: string): string {
    return LABELS[name]?.[0] ?? name;
}

async function previews(): Promise<Preview[]> {
    if (cache) return cache;
    const result = await request({ action: "layout-previews" });
    if (!result.ok) {
        toast(result.error ?? "could not load the layouts", "error");
        return [];
    }
    cache = (result as unknown as { layouts: Preview[] }).layouts;
    return cache;
}

function thumbnail(p: Preview): HTMLElement {
    const box = h("div", { class: "gallery-thumb" });
    box.innerHTML = p.svg;
    const svg = box.querySelector("svg");
    if (svg) {
        const vb = parseViewBox(svg.getAttribute("viewBox"));
        box.style.aspectRatio = `${vb.w} / ${vb.h}`;
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.querySelectorAll(".anim-pending").forEach((el) => {
            el.classList.remove("anim-pending");
        });
        // Media zones have no sample content: mark where a picture goes.
        for (const z of p.emptyZones) {
            if (z.zone === "slide-number" || z.zone === "slide-total") continue;
            box.append(
                h(
                    "div",
                    {
                        class: "gallery-media",
                        style: `left:${(z.x / vb.w) * 100}%;top:${(z.y / vb.h) * 100}%;width:${(z.width / vb.w) * 100}%;height:${(z.height / vb.h) * 100}%`,
                    },
                    "Image or video",
                ),
            );
        }
    }
    return box;
}

// Zones the slide fills today that the layout does not have.
function lostZones(p: Preview): string[] {
    const slide = currentSlide();
    if (!slide) return [];
    const used = new Set([
        ...Object.keys(slide.zoneOrigins ?? {}),
        ...Object.keys(slide.zones),
    ]);
    return [...used].filter((z) => !p.zones.includes(z));
}

function close(): void {
    root.classList.remove("open");
    clear(root);
}

export async function openGallery(
    opts:
        | { mode: "insert"; after: number }
        | { mode: "change"; current: string | null },
): Promise<void> {
    if (!ed.model?.deckEditable) {
        toast(
            "deck.py builds its slide list in code; change it there",
            "error",
        );
        return;
    }
    clear(root);
    const grid = h(
        "div",
        { class: "gallery-grid" },
        h("p", { class: "hint" }, "Rendering layouts…"),
    );
    const title = opts.mode === "insert" ? "New slide" : "Change layout";
    root.append(
        h(
            "div",
            { class: "gallery-box", role: "dialog", "aria-label": title },
            h(
                "div",
                { class: "gallery-head" },
                h("h2", {}, title),
                h(
                    "span",
                    { class: "hint" },
                    opts.mode === "insert"
                        ? "Every layout, in this deck's theme"
                        : "The slide keeps its content; zones the new layout lacks are not shown",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: close,
                        title: "Close (Esc)",
                    },
                    "×",
                ),
            ),
            grid,
        ),
    );
    root.classList.add("open");
    const layouts = await previews();
    clear(grid);
    for (const p of layouts) {
        const [label, description] = LABELS[p.name] ?? [p.name, ""];
        const lost = opts.mode === "change" ? lostZones(p) : [];
        const current = opts.mode === "change" && p.name === opts.current;
        const card = h(
            "button",
            {
                type: "button",
                class: `gallery-card${current ? " current" : ""}`,
                title: p.name,
                onclick: () => void choose(p, opts, lost),
            },
            thumbnail(p),
            h(
                "div",
                { class: "gallery-label" },
                h("strong", {}, label),
                p.source === "local" &&
                    h("span", { class: "badge" }, "project"),
            ),
            description && h("div", { class: "gallery-desc" }, description),
            lost.length > 0 &&
                h(
                    "div",
                    { class: "gallery-warn" },
                    `Hides: ${lost.join(", ")}`,
                ),
        );
        grid.append(card);
    }
    (
        grid.querySelector(".current") ?? grid.querySelector("button")
    )?.scrollIntoView({
        block: "nearest",
    });
    (grid.querySelector(".current, button") as HTMLElement | null)?.focus();
}

async function choose(
    p: Preview,
    opts:
        | { mode: "insert"; after: number }
        | { mode: "change"; current: string | null },
    lost: string[],
): Promise<void> {
    if (opts.mode === "insert") {
        close();
        await newSlide(p.name, opts.after);
        return;
    }
    if (p.name === opts.current) {
        close();
        return;
    }
    if (
        lost.length &&
        !window.confirm(
            `${layoutLabel(p.name)} has no ${lost.join(", ")} zone; that content stays in your files but is not shown. Switch anyway?`,
        )
    ) {
        return;
    }
    close();
    const slide = currentSlide();
    if (!slide) return;
    await edit({
        action: "slide",
        op: "layout",
        slide: slide.deckIndex,
        layout: p.name,
    });
}

export function initGallery(): void {
    on("model", () => {
        cache = null;
    });
    root.addEventListener("pointerdown", (e) => {
        if (e.target === root) close();
    });
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Escape" && root.classList.contains("open")) {
                e.stopPropagation();
                close();
            }
        },
        true,
    );
}
