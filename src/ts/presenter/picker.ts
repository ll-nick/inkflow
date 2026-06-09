import { applyStepInstant, maxStep as computeMaxStep } from "../shared/step";
import { renderPv } from "./pv";
import { state } from "./state";
import { loadSlide } from "./transitions";
import { sendNav } from "./websocket";

const picker = document.getElementById("picker")!;
const pickerInput = document.getElementById("picker-input") as HTMLInputElement;
const pickerList = document.getElementById("picker-list")!;

export function openPicker(): void {
    picker.classList.add("visible");
    pickerInput.value = "";
    filterPicker("");
    pickerInput.focus();
}

export function closePicker(): void {
    picker.classList.remove("visible");
}

export function filterPicker(query: string): void {
    const q = query.trim();
    let matches: number[];
    if (q === "") {
        matches = state.slides.map((_, i) => i);
    } else if (/^\d+$/.test(q)) {
        matches = state.slides.reduce((acc: number[], _, i) => {
            if (String(i + 1).startsWith(q)) acc.push(i);
            return acc;
        }, []);
    } else {
        const lq = q.toLowerCase();
        matches = state.slides.reduce((acc: number[], s, i) => {
            const title = (s.title || "").toLowerCase();
            let ti = 0;
            for (let qi = 0; qi < lq.length; qi++) {
                ti = title.indexOf(lq[qi], ti);
                if (ti === -1) return acc;
                ti++;
            }
            acc.push(i);
            return acc;
        }, []);
    }
    state._pickerMatches = matches;
    state._pickerActive = 0;
    pickerList.innerHTML = matches
        .map(
            (idx, pos) =>
                `<li role="option" data-pos="${pos}" class="${pos === 0 ? "active" : ""}">` +
                `<span class="pk-num">${idx + 1}</span>` +
                `<span class="pk-title">${state.slides[idx].title || ""}</span></li>`,
        )
        .join("");
    const active = pickerList.querySelector("li.active");
    if (active) active.scrollIntoView({ block: "nearest" });
}

function pickerMoveCursor(delta: number): void {
    if (!state._pickerMatches.length) return;
    state._pickerActive = Math.max(
        0,
        Math.min(state._pickerMatches.length - 1, state._pickerActive + delta),
    );
    pickerList.querySelectorAll("li").forEach((li, i) => {
        li.classList.toggle("active", i === state._pickerActive);
    });
    const active = pickerList.querySelector("li.active");
    if (active) active.scrollIntoView({ block: "nearest" });
}

function pickerCommit(): void {
    if (!state._pickerMatches.length) return;
    const stage = document.getElementById("stage")!;
    state.slideIndex = state._pickerMatches[state._pickerActive];
    state.step = 0;
    closePicker();
    loadSlide(null, { type: "cut", duration: 0 }, () => {
        const maxSt = computeMaxStep(stage);
        applyStepInstant(stage, maxSt);
        state.step = maxSt;
    });
    renderPv();
    sendNav();
}

pickerInput.addEventListener("input", () => filterPicker(pickerInput.value));
pickerInput.addEventListener("keydown", (e) => {
    const down =
        e.key === "ArrowDown" ||
        (e.key === "Tab" && !e.shiftKey) ||
        (e.key === "j" && e.ctrlKey);
    const up =
        e.key === "ArrowUp" ||
        (e.key === "Tab" && e.shiftKey) ||
        (e.key === "k" && e.ctrlKey);
    if (down) {
        e.preventDefault();
        pickerMoveCursor(+1);
    } else if (up) {
        e.preventDefault();
        pickerMoveCursor(-1);
    } else if (e.key === "Enter") {
        e.preventDefault();
        pickerCommit();
    } else if (e.key === "Escape") {
        closePicker();
    }
});
pickerList.addEventListener("click", (e) => {
    const li = (e.target as Element).closest("li");
    if (!li) return;
    const pos = parseInt((li as HTMLElement).dataset.pos!, 10);
    state._pickerActive = pos;
    pickerCommit();
});
picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
});
