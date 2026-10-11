// The grid view (G): every slide as a large thumbnail, like the presenter's
// overview and PowerPoint's slide sorter, in one block per section (its
// header names it; click selects its slides, the caret collapses it, drag
// moves it). It works like the slide list: click picks (Ctrl/Shift for
// several), drag moves the picked slides (into another section too),
// right-click has the slide menu, Ctrl+C / Ctrl+V / Delete act on the picked
// slides; double-click or Enter opens a slide for editing.

import { verticalNeighbor } from "../shared/sections";
import { commentBadge } from "./comments";
import { clear, h } from "./dom";
import { problemBadge } from "./problems";
import {
    dropOnHeader,
    dropOnSlide,
    sectionBlocks,
    sectionGapAtSlide,
} from "./sections";
import {
    isCollapsed,
    moveSectionToGap,
    moveSlidesTo,
    sectionHeader,
    sections,
    selectSection,
} from "./sectionui";
import { changeBadge, isMarked, markedCount } from "./slidegit";
import {
    clearDropMarks,
    dragging,
    dragSlides,
    dropAtEnd,
    gotoSlide,
    headerGap,
    markGap,
    openSlideMenu,
    pickSlide,
    Thumbs,
} from "./sorter";
import { isStarred, starButton, starCount } from "./stars";
import { filterLabel, onlyStarred } from "./starstext";
import { ed, emit, on } from "./state";
import type { SlideModel } from "./types";

const view = document.getElementById("grid-view")!;
const list = document.getElementById("grid-list")!;
const sizeInput = document.getElementById("grid-size") as HTMLInputElement;
const starFilter = document.getElementById("grid-starred")!;
const changedFilter = document.getElementById("grid-changed")!;
const thumbs = new Thumbs(list);

const STARRED_KEY = "inkflow-editor-grid-starred";
// Show the starred slides only (the grid's filter).
let starredOnly = false;
// Only the slides with changes since the last commit (slidegit.ts); not
// remembered: a commit empties it.
let changedOnly = false;

export function gridOpen(): boolean {
    return !view.hidden;
}

export function toggleGrid(on: boolean = view.hidden === true): void {
    view.hidden = !on;
    document.body.classList.toggle("grid-mode", on);
    document.getElementById("btn-grid")?.classList.toggle("on", on);
    if (on) {
        ed.focus = "sorter"; // Ctrl+C / Delete act on slides here
        renderGrid();
        view.focus();
    } else {
        ed.focus = "canvas";
        emit("slide"); // the canvas re-renders the current slide
    }
}

function open(i: number): void {
    ed.slideSelection.clear();
    toggleGrid(false);
    gotoSlide(i);
}

/** The last thing in the grid, which a drop past the end marks. */
function lastMark(): Element | null {
    return list.lastElementChild;
}

function gridItem(slide: SlideModel, i: number): HTMLElement {
    const item = h(
        "div",
        {
            class: `grid-item${i === ed.current ? " active" : ""}${ed.slideSelection.has(i) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
            // Among the starred only, a drop would have no place to mean.
            draggable:
                ed.model?.deckEditable && !starredOnly && !changedOnly
                    ? "true"
                    : null,
            "data-index": i,
        },
        thumbs.thumb(slide),
        h(
            "div",
            { class: "grid-caption" },
            slide.visible ? starButton(i) : null,
            h("span", { class: "grid-num" }, String(i + 1)),
            h(
                "span",
                { class: "grid-title" },
                slide.title ?? slide.id ?? slide.src,
            ),
            slide.animations.length
                ? h(
                      "span",
                      {
                          class: "grid-badge",
                          title: `${slide.animations.length} animation(s)`,
                      },
                      "✦",
                  )
                : null,
            changeBadge(i),
            problemBadge(i),
            commentBadge(i),
        ),
    );
    item.classList.toggle("starred", isStarred(i));
    item.addEventListener("click", (e) => {
        pickSlide(i, e);
        ed.focus = "sorter";
    });
    item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!ed.slideSelection.has(i)) {
            ed.slideSelection.clear();
            gotoSlide(i);
        }
        ed.focus = "sorter";
        openSlideMenu(e.clientX, e.clientY, i);
    });
    item.addEventListener("dragstart", (e) => {
        dragging.now = { kind: "slides", slides: dragSlides(i) };
        e.dataTransfer?.setData("text/plain", String(i));
        item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
        dragging.now = null;
        clearDropMarks(list);
        item.classList.remove("dragging");
    });
    item.addEventListener("dragover", (e) => {
        const drag = dragging.now;
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        if (drag.kind === "section") {
            markGap(list, sectionGapAtSlide(sections(), i), lastMark());
            return;
        }
        const r = item.getBoundingClientRect();
        clearDropMarks(list);
        item.classList.add(
            e.clientX > r.left + r.width / 2 ? "drop-after" : "drop-before",
        );
    });
    item.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const drag = dragging.now;
        clearDropMarks(list);
        if (!drag) return;
        if (drag.kind === "section") {
            void moveSectionToGap(
                drag.section,
                sectionGapAtSlide(sections(), i),
            );
            return;
        }
        const r = item.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const target = dropOnSlide(sections(), i, after);
        void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return item;
}

function gridHeader(k: number): HTMLElement {
    const head = sectionHeader(k, "grid", () => selectSection(k));
    head.addEventListener("dragstart", (e) => {
        dragging.now = { kind: "section", section: k };
        e.dataTransfer?.setData("text/plain", `section:${k}`);
        head.closest(".grid-section")?.classList.add("dragging");
    });
    head.addEventListener("dragend", () => {
        dragging.now = null;
        head.closest(".grid-section")?.classList.remove("dragging");
        clearDropMarks(list);
    });
    head.addEventListener("dragover", (e) => {
        const drag = dragging.now;
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        if (drag.kind === "section") {
            markGap(list, headerGap(head, k, e), lastMark());
            return;
        }
        clearDropMarks(list);
        head.classList.add("drop-into");
    });
    head.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const drag = dragging.now;
        clearDropMarks(list);
        if (!drag) return;
        if (drag.kind === "section") {
            void moveSectionToGap(drag.section, headerGap(head, k, e));
            return;
        }
        const target = dropOnHeader(sections(), k);
        void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return head;
}

function renderFilter(): void {
    starFilter.textContent = `★ ${filterLabel(starCount())}`;
    starFilter.classList.toggle("on", starredOnly);
    starFilter.setAttribute("aria-pressed", String(starredOnly));
    const marked = markedCount();
    changedFilter.hidden = !marked && !changedOnly;
    changedFilter.textContent = `Changed only (${marked})`;
    changedFilter.classList.toggle("on", changedOnly);
    changedFilter.setAttribute("aria-pressed", String(changedOnly));
}

function setStarredOnly(on: boolean): void {
    starredOnly = on;
    try {
        localStorage.setItem(STARRED_KEY, on ? "1" : "");
    } catch {
        // not remembered
    }
    renderGrid();
}

export function renderGrid(): void {
    if (view.hidden) return;
    renderFilter();
    const top = list.scrollTop;
    clear(list);
    thumbs.begin();
    const slides = ed.model?.slides ?? [];
    const all = sections();
    for (const block of sectionBlocks(slides.length, all)) {
        const k = block.section;
        let shownSlides = starredOnly
            ? onlyStarred(block.slides, isStarred)
            : block.slides;
        if (changedOnly) shownSlides = shownSlides.filter(isMarked);
        // Filtered: a section none of whose slides is shown is left out.
        if ((starredOnly || changedOnly) && !shownSlides.length) continue;
        const wrap = h("div", {
            class: `grid-section${k == null ? " unsectioned" : ""}`,
        });
        if (k != null) wrap.append(gridHeader(k));
        if (k == null || !isCollapsed(k)) {
            const grid = h("div", { class: "grid-section-list" });
            for (const i of shownSlides) grid.append(gridItem(slides[i], i));
            if (k != null && !block.slides.length) {
                grid.append(
                    h(
                        "div",
                        { class: "grid-empty" },
                        "No slides: drop some on the heading",
                    ),
                );
            }
            wrap.append(grid);
        }
        list.append(wrap);
    }
    thumbs.end();
    if (changedOnly && !markedCount()) {
        list.append(
            h(
                "div",
                { class: "grid-empty" },
                "No slide has changes since the last commit",
            ),
        );
    } else if (starredOnly && !starCount()) {
        list.append(
            h(
                "div",
                { class: "grid-empty" },
                "No starred slides yet: S stars the slide you are on, or click the ☆ under a slide",
            ),
        );
    }
    list.scrollTop = top;
    list.querySelector(".grid-item.active")?.scrollIntoView({
        block: "nearest",
    });
}

/** The thumbnails on screen, in reading order (collapsed sections left out). */
function shown(): HTMLElement[] {
    return [...list.querySelectorAll<HTMLElement>(".grid-item")];
}

function onKey(e: KeyboardEvent): void {
    if (view.hidden) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, #dialog, #find-panel")) return;
    const items = shown();
    const indices = items.map((el) => Number(el.dataset.index));
    const here = indices.indexOf(ed.current);
    const move = (to: number | undefined) => {
        e.preventDefault();
        e.stopPropagation();
        if (to == null) return;
        ed.slideSelection.clear();
        gotoSlide(to);
    };
    const vertical = (dir: 1 | -1) => {
        if (here === -1) return indices[0];
        const boxes = items.map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: Math.round(r.top), width: r.width };
        });
        return indices[verticalNeighbor(boxes, here, dir)];
    };
    switch (e.key) {
        case "ArrowLeft":
            move(indices[Math.max(0, here - 1)]);
            break;
        case "ArrowRight":
            move(indices[Math.min(indices.length - 1, here + 1)]);
            break;
        case "ArrowUp":
            move(vertical(-1));
            break;
        case "ArrowDown":
            move(vertical(1));
            break;
        case "Home":
            move(indices[0]);
            break;
        case "End":
            move(indices[indices.length - 1]);
            break;
        case "Enter":
            e.preventDefault();
            e.stopPropagation();
            open(ed.current);
            break;
        case "Escape":
            e.preventDefault();
            e.stopPropagation();
            toggleGrid(false);
            break;
    }
}

function setSize(px: number): void {
    view.style.setProperty("--grid-w", `${px}px`);
    try {
        localStorage.setItem("inkflow-editor-grid", String(px));
    } catch {
        // not remembered
    }
}

// A double-click opens the slide. Told from two presses on the same tile
// by the list itself, which outlives its tiles: the first click goes to the
// slide, which draws the grid again, and when that lands between the two
// presses neither tile gets the browser's own dblclick.
const DOUBLE_MS = 450;
let lastPress: { index: number; at: number; x: number; y: number } | null =
    null;

function onListPress(e: PointerEvent): void {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
        lastPress = null;
        return;
    }
    const target = e.target as HTMLElement;
    // (The star and the marks under a tile are buttons of their own.)
    if (target.closest("button, .git-mark, .problem-mark, .comment-mark")) {
        lastPress = null;
        return;
    }
    const tile = target.closest<HTMLElement>(".grid-item");
    if (!tile) {
        lastPress = null;
        return;
    }
    const index = Number(tile.dataset.index);
    const prev = lastPress;
    lastPress = { index, at: e.timeStamp, x: e.clientX, y: e.clientY };
    if (
        prev &&
        prev.index === index &&
        e.timeStamp - prev.at < DOUBLE_MS &&
        Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8
    ) {
        lastPress = null;
        e.preventDefault();
        open(index);
    }
}

function initListDrop(): void {
    list.addEventListener("dragover", (e) => {
        const drag = dragging.now;
        if (!drag || e.target !== list) return;
        e.preventDefault();
        if (drag.kind === "section") {
            markGap(list, sections().length, lastMark());
        } else {
            clearDropMarks(list);
            lastMark()?.classList.add("drop-after");
        }
    });
    list.addEventListener("drop", (e) => {
        const drag = dragging.now;
        if (!drag || e.target !== list) return;
        e.preventDefault();
        clearDropMarks(list);
        dropAtEnd(drag);
    });
}

export function initGrid(): void {
    document
        .getElementById("btn-grid")
        ?.addEventListener("click", () => toggleGrid());
    document
        .getElementById("grid-close")
        ?.addEventListener("click", () => toggleGrid(false));
    document.addEventListener("keydown", onKey, true);
    let saved = 280;
    try {
        saved = Number(localStorage.getItem("inkflow-editor-grid")) || 280;
    } catch {
        // default size
    }
    sizeInput.value = String(saved);
    setSize(saved);
    sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
    initListDrop();
    list.addEventListener("pointerdown", onListPress);
    on("model", renderGrid);
    on("slide", renderGrid);
    on("slide-selection", renderGrid);
    on("stars", renderGrid);
    on("slide-git", renderGrid);
    on("problems", renderGrid);
    on("comments", renderGrid);
    try {
        starredOnly = localStorage.getItem(STARRED_KEY) === "1";
    } catch {
        // every slide shown
    }
    starFilter.addEventListener("click", () => setStarredOnly(!starredOnly));
    changedFilter.addEventListener("click", () => {
        changedOnly = !changedOnly;
        renderGrid();
    });
    on("sections", renderGrid);
}
