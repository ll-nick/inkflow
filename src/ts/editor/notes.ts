// Speaker notes under the canvas: the slide's notes Markdown (a file, an
// Inline(...) in deck.py, or a new notes/<slide>.md created on first input),
// saved as you type with the whole typing burst as one undo step.

import { edit } from "./net";
import { currentSlide, ed, on } from "./state";

const area = document.getElementById("notes-input") as HTMLTextAreaElement;
const label = document.getElementById("notes-file")!;

let timer = 0;
let slideIndex = -1;
let sent = "";
let burst = "";

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
    on("slide", () => {
        void save().then(load);
    });
    on("model", load);
}
