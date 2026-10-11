// Editing together: who is here (avatars in the toolbar, dots on the slides
// they are on, their selections outlined on the canvas in their colour), the
// name this browser goes by, and what this page tells the others. Relayed by
// the server as "presence"; nothing of it is stored.

import { clientKey, initials, saveName, storedName } from "../shared/identity";
import { drawOverlay, hooks, outlineOf, slideRoot } from "./canvas";
import { closeDialog, openDialog } from "./dialog";
import { clear, h, svgEl } from "./dom";
import { sendRaw } from "./net";
import { gotoSlide } from "./sorter";
import { ed, on } from "./state";

export interface Person {
    id: string;
    role: "owner" | "editor" | "viewer";
    name: string;
    color: string;
    page: "editor" | "presenter" | "";
    slide: number | null;
    selection: string[];
    editing: string | null;
}

export const collab = {
    me: null as {
        id: string;
        role: string;
        color: string;
        name: string;
    } | null,
    people: [] as Person[],
};

/** Everyone else with a page open. */
export function others(): Person[] {
    return collab.people.filter((p) => p.id !== collab.me?.id);
}

/** The deck index a person is on (a presenter counts visible slides). */
export function deckIndexOf(p: Person): number | null {
    if (p.slide == null) return null;
    if (p.page !== "presenter") return p.slide;
    const s = ed.model?.slides.find((x) => x.visibleIndex === p.slide);
    return s ? s.deckIndex : null;
}

/** Who else is editing deck slide `i` right now. */
export function editorsOn(i: number): Person[] {
    return others().filter((p) => p.page === "editor" && deckIndexOf(p) === i);
}

function myName(): string {
    return storedName() ?? collab.me?.name ?? "";
}

// ── What this page tells the others ──

let timer = 0;
let lastSent = "";

export function sendPresence(now = false): void {
    window.clearTimeout(timer);
    const go = () => {
        const msg = {
            type: "presence",
            page: "editor",
            key: clientKey(),
            ...(myName() ? { name: myName() } : {}),
            slide: ed.current,
            selection: ed.selection.map((s) => s.loc),
            editing: ed.richEditing ? "text" : null,
        };
        const text = JSON.stringify(msg);
        if (text === lastSent) return;
        lastSent = text;
        sendRaw(msg);
    };
    if (now) go();
    else timer = window.setTimeout(go, 120);
}

/** The connection (re)opened: say everything again. */
export function presenceConnected(): void {
    lastSent = "";
    sendPresence(true);
}

// ── What the others told us ──

export function welcome(msg: Record<string, unknown>): void {
    collab.me = {
        id: String(msg.id ?? ""),
        role: String(msg.role ?? "owner"),
        color: String(msg.color ?? "#1c7ed6"),
        name: String(msg.name ?? ""),
    };
    document.body.dataset.role = collab.me.role;
    // A guest's page has nothing of the owner's computer: no git, no other
    // decks, no programs to open files in (the server refuses them anyway).
    document.body.classList.toggle("guest", collab.me.role !== "owner");
    const share = document.getElementById("btn-share");
    if (share) share.hidden = collab.me.role !== "owner";
    if (collab.me.role !== "owner" && !storedName()) askName();
    renderPeople();
}

export function setPeople(people: Person[]): void {
    collab.people = people;
    renderPeople();
    paintDots();
    drawOverlay();
}

// ── Toolbar avatars ──

const host = document.getElementById("people");

function avatar(p: Person, me: boolean): HTMLElement {
    const where =
        p.page === "presenter"
            ? `presenting, slide ${(p.slide ?? 0) + 1}`
            : p.slide != null
              ? `slide ${p.slide + 1}`
              : "";
    const role =
        p.role === "viewer"
            ? "viewer"
            : p.role === "owner"
              ? "owner"
              : "editor";
    return h(
        "span",
        {
            class: `avatar${me ? " me" : ""}${p.page === "presenter" ? " presenting" : ""}`,
            style: `--who:${p.color}`,
            title: `${p.name}${me ? " (you)" : ""} · ${role}${where ? ` · ${where}` : ""}`,
            "data-person": p.id,
            onclick: me
                ? () => askName()
                : () => {
                      const i = deckIndexOf(p);
                      if (i != null) gotoSlide(i);
                  },
        },
        initials(p.name || "?"),
    );
}

function renderPeople(): void {
    if (!host) return;
    clear(host);
    const people = collab.people;
    host.hidden = people.length < 2 && collab.me?.role === "owner";
    const mine = people.find((p) => p.id === collab.me?.id);
    if (mine) host.append(avatar(mine, true));
    for (const p of others()) host.append(avatar(p, false));
}

// ── Slide list dots ──

export function paintDots(): void {
    for (const old of document.querySelectorAll(".peer-dots")) old.remove();
    const byIndex = new Map<number, Person[]>();
    for (const p of others()) {
        const i = deckIndexOf(p);
        if (i == null) continue;
        byIndex.set(i, [...(byIndex.get(i) ?? []), p]);
    }
    for (const [i, people] of byIndex) {
        const item = document.querySelector(`.sorter-item[data-index="${i}"]`);
        if (!item) continue;
        item.append(
            h(
                "span",
                { class: "peer-dots" },
                ...people.map((p) =>
                    h("span", {
                        class: "peer-dot",
                        style: `background:${p.color}`,
                        title: p.name,
                    }),
                ),
            ),
        );
    }
}

// ── Others' selections on the canvas ──

function drawPeers(overlay: SVGSVGElement): void {
    const svg = slideRoot();
    if (!svg) return;
    for (const p of editorsOn(ed.current)) {
        let labelled = false;
        for (const loc of p.selection) {
            const el = svg.querySelector(`[data-ink="${CSS.escape(loc)}"]`);
            if (!(el instanceof SVGGraphicsElement)) continue;
            const corners = outlineOf(el);
            if (!corners) continue;
            const g = svgEl("g", {
                class: "peer-sel",
                style: `--who:${p.color}`,
            });
            g.append(
                svgEl("polygon", {
                    points: corners.map((c) => `${c.x},${c.y}`).join(" "),
                    class: "peer-outline",
                }),
            );
            if (!labelled) {
                labelled = true;
                const top = corners.reduce((a, b) =>
                    b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a,
                );
                const label = svgEl("text", {
                    x: top.x,
                    y: top.y - 5,
                    class: "peer-label",
                });
                label.textContent = p.editing ? `${p.name} (typing)` : p.name;
                g.append(label);
            }
            overlay.append(g);
        }
    }
}

// ── The name this browser goes by ──

export function askName(): void {
    const input = h("input", {
        type: "text",
        value: myName(),
        maxlength: "40",
        placeholder: "Your name",
        "aria-label": "Your name",
    });
    const done = () => {
        const name = input.value.trim();
        if (!name) return;
        saveName(name);
        closeDialog();
        sendPresence(true);
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done();
    });
    const body = h(
        "div",
        { class: "name-dialog" },
        h(
            "p",
            {},
            "The others editing this deck see you by this name, and your selection in your colour.",
        ),
        input,
        h(
            "div",
            { class: "dialog-actions" },
            h(
                "button",
                { type: "button", class: "pbtn primary", onclick: done },
                "OK",
            ),
        ),
    );
    openDialog("Your name", body);
    window.setTimeout(() => input.select(), 0);
}

export function initCollab(): void {
    hooks.drawPeers = drawPeers;
    on("selection", () => sendPresence());
    on("render", () => sendPresence());
    on("model", () => sendPresence());
    on("sorter", paintDots);
}
