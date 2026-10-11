// Placeholders in the slide master: the zones a layout leaves for its slides
// to fill. The add dialog ("+ Text placeholder", "Make placeholder" on a drawn
// shape) and the props panel's Placeholder section for a selected zone: its
// kind, its name (a rename follows every slide's content, previewed first),
// its prompt (what the empty zone says on a new slide) and Remove. The server
// does the work (`master` ops add-zone, zone-make, zone-rename, zone-prompt,
// zone-remove: editor/placeholders.py); the words are in placeholdertext.ts.

import { slideRoot, zoneName } from "./canvas";
import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { afterRender } from "./insert";
import { edit, request } from "./net";
import {
    checkName,
    fillsText,
    kindOf,
    type PlaceholderInfo,
    type PlaceholderKind,
    type PlaceholderList,
    type PlaceholderPlan,
    renameSummary,
    zoneNameFor,
} from "./placeholdertext";
import { ed, sourceOf } from "./state";
import type { Selected, SourceInfo } from "./types";

export async function loadPlaceholders(
    kind: "layout" | "overlay",
    path: string,
): Promise<PlaceholderList | null> {
    const result = await request({ action: "master-placeholders", kind, path });
    if (!result.ok) return null;
    return {
        placeholders: (result.placeholders as PlaceholderInfo[]) ?? [],
        ids: (result.taken as string[]) ?? [],
    };
}

function listed(): PlaceholderList {
    return ed.master?.placeholders ?? { placeholders: [], ids: [] };
}

// The master's own file: where every placeholder edit goes.
function masterSource(): SourceInfo | null {
    const view = ed.master;
    return view?.slide.sources?.find((s) => s.path === view.path) ?? null;
}

function slideNumber(i: number): string {
    const s = ed.model?.slides[i];
    return s?.visibleIndex != null ? String(s.visibleIndex + 1) : "hidden";
}

const TEXT_TAGS = ["rect", "ellipse", "circle"];
const PICTURE_TAGS = ["rect", "ellipse", "circle", "polygon", "path"];

function freeName(kind: PlaceholderKind): string {
    const ids = new Set(listed().ids);
    const base = kind === "picture" ? "picture" : "text";
    let name = base;
    for (let n = 2; ids.has(`zone-${name}`); n++) name = `${base}-${n}`;
    return name;
}

// ── The add dialog ──

/** "+ Text placeholder" / "+ Picture placeholder", or, with `shape`, make
 * that drawn shape a placeholder (it keeps its look). */
export function placeholderDialog(
    kind: PlaceholderKind,
    shape: Selected | null = null,
): void {
    const src = shape ? sourceOf(shape.key) : masterSource();
    if (!ed.master || !src) return;
    const tag = shape
        ? (shape.el.getAttribute("data-ink-tag") ?? shape.el.localName)
        : "rect";
    const kinds: [PlaceholderKind, string, string[]][] = [
        ["text", "Text", TEXT_TAGS],
        ["picture", "Picture or video", PICTURE_TAGS],
    ];
    let chosen = kind;
    const radios = kinds.map(([k, label, tags]) => {
        const input = h("input", {
            type: "radio",
            name: "placeholder-kind",
            value: k,
            checked: k === kind,
            disabled: !tags.includes(tag),
        }) as HTMLInputElement;
        input.addEventListener("change", () => {
            if (!input.checked) return;
            if (name.value === freeName(chosen)) name.value = freeName(k);
            chosen = k;
            check();
        });
        return h("label", { class: "check" }, input, label);
    });
    const name = h("input", {
        type: "text",
        class: "master-name",
        value: freeName(kind),
        spellcheck: "false",
        "aria-label": "Name",
    }) as HTMLInputElement;
    const zone = h("p", { class: "hint placeholder-zone" });
    const prompt = h("input", {
        type: "text",
        placeholder: "Click to add the code example",
        "aria-label": "Prompt",
    }) as HTMLInputElement;
    const ok = h(
        "button",
        { type: "submit", class: "pbtn primary" },
        shape ? "Make placeholder" : "Add",
    ) as HTMLButtonElement;
    const check = (): string | null => {
        const { name: n, problem } = checkName(
            chosen,
            name.value,
            listed().ids,
        );
        zone.textContent = problem ?? `zone-${n}`;
        zone.classList.toggle("error", !!problem);
        ok.disabled = !!problem;
        return problem ? null : n;
    };
    name.addEventListener("input", check);
    const form = h(
        "form",
        { class: "master-form placeholder-form" },
        h("div", { class: "placeholder-kinds", role: "radiogroup" }, ...radios),
        h("label", {}, "Name", name, zone),
        h(
            "label",
            {},
            "Prompt (optional)",
            prompt,
            h(
                "span",
                { class: "hint" },
                "Grey text the empty zone shows on a new slide; a click types it in.",
            ),
        ),
        h(
            "p",
            { class: "hint" },
            shape
                ? "The shape keeps its look; each slide on this layout fills it with its own content."
                : "Each slide on this layout fills it with its own text or picture. Drag it into place afterwards.",
        ),
        h(
            "div",
            { class: "dialog-actions" },
            h(
                "button",
                { type: "button", class: "pbtn", onclick: () => closeDialog() },
                "Cancel",
            ),
            ok,
        ),
    );
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!check()) return;
        ok.disabled = true;
        const send = shape
            ? makePlaceholder(shape, src, chosen, name.value, prompt.value)
            : addPlaceholder(src, chosen, name.value, prompt.value);
        void send.then((done) => {
            if (done) closeDialog();
            else ok.disabled = false;
        });
    });
    check();
    openDialog(
        shape
            ? "Make placeholder"
            : chosen === "picture"
              ? "New picture placeholder"
              : "New text placeholder",
        form,
    );
    name.focus();
    name.select();
}

async function addPlaceholder(
    src: SourceInfo,
    kind: PlaceholderKind,
    name: string,
    prompt: string,
): Promise<boolean> {
    const vb = slideRoot()?.viewBox.baseVal;
    const W = vb?.width || 1920;
    const H = vb?.height || 1080;
    const w = W * (kind === "picture" ? 0.35 : 0.5);
    const hgt = H * (kind === "picture" ? 0.35 : 0.2);
    const result = await edit({
        action: "master",
        op: "add-zone",
        file: src.path,
        hash: src.hash,
        zoneKind: kind,
        name,
        prompt,
        exact: true,
        x: Math.round((W - w) / 2),
        y: Math.round((H - hgt) / 2),
        width: Math.round(w),
        height: Math.round(hgt),
    });
    if (!result.ok || typeof result.zone !== "string") return false;
    afterRender.ids = [`zone-${result.zone}`];
    toast(`Placeholder “${result.zone}” added: drag it into place`);
    return true;
}

async function makePlaceholder(
    sel: Selected,
    src: SourceInfo,
    kind: PlaceholderKind,
    name: string,
    prompt: string,
): Promise<boolean> {
    const result = await edit({
        action: "master",
        op: "zone-make",
        file: src.path,
        hash: src.hash,
        loc: sel.loc,
        zoneKind: kind,
        name,
        prompt,
    });
    if (!result.ok || typeof result.zone !== "string") return false;
    afterRender.ids = [`zone-${result.zone}`];
    toast(`The shape is the placeholder “${result.zone}” now`);
    return true;
}

// ── The props panel ──

function section(title: string, ...body: (Node | null)[]): HTMLElement {
    return h(
        "section",
        { class: "props-section" },
        h("h3", {}, title),
        ...body.filter((b): b is Node => !!b),
    );
}

function row(label: string, ...controls: Node[]): HTMLElement {
    return h(
        "label",
        { class: "prop-row" },
        h("span", { class: "prop-label" }, label),
        ...controls,
    );
}

/** A drawn shape in the master: "Make placeholder". */
export function makePlaceholderSection(sel: Selected): HTMLElement | null {
    const src = sourceOf(sel.key);
    if (!ed.master || !src?.writable) return null;
    const tag = sel.el.localName;
    const text = TEXT_TAGS.includes(tag);
    const picture = PICTURE_TAGS.includes(tag);
    if (!text && !picture) return null;
    return section(
        "Placeholder",
        h(
            "p",
            { class: "hint" },
            "Make this shape a zone each slide on the layout fills; it keeps its look.",
        ),
        h(
            "div",
            { class: "master-actions" },
            text
                ? h(
                      "button",
                      {
                          type: "button",
                          class: "pbtn",
                          onclick: () => placeholderDialog("text", sel),
                      },
                      "Make text placeholder",
                  )
                : null,
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => placeholderDialog("picture", sel),
                },
                "Make picture placeholder",
            ),
        ),
    );
}

let previewTimer = 0;

/** A placeholder selected in the master: kind, name, prompt, who fills it. */
export function placeholderSection(sel: Selected): HTMLElement {
    const name = zoneName(sel.el);
    const info = listed().placeholders.find((p) => p.name === name);
    const kind = info?.kind ?? kindOf(name);
    const src = sourceOf(sel.key);
    const file = src?.path ?? ed.master?.path ?? "";
    const note = h("p", { class: "hint placeholder-note" });
    const nameInput = h("input", {
        type: "text",
        value: name,
        spellcheck: "false",
        "aria-label": "Placeholder name",
    }) as HTMLInputElement;
    const say = (text: string, error = false) => {
        note.textContent = text;
        note.classList.toggle("error", error);
    };
    const fills = fillsText(info?.filled ?? [], slideNumber);
    say(fills);
    const valid = (): string | null => {
        const { name: n, problem } = checkName(
            kind,
            nameInput.value,
            listed().ids,
            name,
        );
        if (problem) say(problem, true);
        return problem || n === name ? null : n;
    };
    // While typing: what the rename would change, from a dry run.
    nameInput.addEventListener("input", () => {
        window.clearTimeout(previewTimer);
        const to = valid();
        if (!to) {
            if (zoneNameFor(kind, nameInput.value) === name) say(fills);
            return;
        }
        say(`zone-${to}…`);
        previewTimer = window.setTimeout(async () => {
            const result = await request({
                action: "master",
                op: "zone-rename",
                file,
                zone: name,
                to: nameInput.value,
                dryRun: true,
            });
            if (zoneNameFor(kind, nameInput.value) !== to) return;
            if (!result.ok) {
                say(result.error ?? "cannot rename", true);
                return;
            }
            const plan = result.placeholder as PlaceholderPlan;
            const warn = plan.warnings.length ? ` · ${plan.warnings[0]}` : "";
            say(`zone-${to} · ${renameSummary(plan)}${warn}`);
        }, 250);
    });
    nameInput.addEventListener("change", () => {
        window.clearTimeout(previewTimer);
        const to = valid();
        if (!to || !src) {
            if (!to && zoneNameFor(kind, nameInput.value) === name)
                nameInput.value = name;
            return;
        }
        void edit({
            action: "master",
            op: "zone-rename",
            file,
            hash: src.hash,
            zone: name,
            to: nameInput.value,
        }).then((result) => {
            if (result.ok && typeof result.zone === "string") {
                afterRender.ids = [`zone-${result.zone}`];
                const n = (result.placeholder as PlaceholderPlan | undefined)
                    ?.slides.length;
                toast(
                    n
                        ? `Renamed to “${result.zone}” on the layout and ${n} slide${n === 1 ? "" : "s"}`
                        : `Renamed to “${result.zone}”`,
                );
            } else {
                nameInput.value = name;
            }
        });
    });
    nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") nameInput.blur();
    });
    const prompt = h("input", {
        type: "text",
        value: info?.prompt ?? "",
        placeholder: "None: the zone's name shows",
        "aria-label": "Prompt",
    }) as HTMLInputElement;
    prompt.addEventListener("change", () => {
        if (!src || prompt.value.trim() === (info?.prompt ?? "")) return;
        void edit({
            action: "master",
            op: "zone-prompt",
            file,
            hash: src.hash,
            zone: name,
            prompt: prompt.value,
        });
    });
    prompt.addEventListener("keydown", (e) => {
        if (e.key === "Enter") prompt.blur();
    });
    return section(
        "Placeholder",
        row(
            "Kind",
            h(
                "span",
                { class: "prop-value" },
                kind === "picture" ? "Picture or video" : "Text",
                info?.shape ? " · drawn as a shape" : "",
            ),
        ),
        row("Name", nameInput),
        note,
        row("Prompt", prompt),
        h(
            "p",
            { class: "hint" },
            "Each slide on this layout fills this zone with its own content; the prompt is what the empty zone says on a new slide.",
        ),
        h(
            "div",
            { class: "master-actions" },
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "Take this zone out of the layout",
                    onclick: () => removeDialog(name, info ?? null, src),
                },
                "Remove placeholder",
            ),
        ),
    );
}

function removeDialog(
    name: string,
    info: PlaceholderInfo | null,
    src: SourceInfo | null,
): void {
    if (!src) return;
    const filled = info?.filled ?? [];
    const drop = h("input", { type: "checkbox" }) as HTMLInputElement;
    const body = h(
        "div",
        { class: "master-form" },
        h(
            "p",
            {},
            info?.shape
                ? `Remove the placeholder “${name}”? The shape stays, as a plain shape.`
                : `Remove the placeholder “${name}” from this layout?`,
        ),
        filled.length
            ? h(
                  "label",
                  { class: "check" },
                  drop,
                  `Also delete what ${filled.length === 1 ? "slide" : "slides"} ${filled.map(slideNumber).join(", ")} put in it`,
              )
            : null,
        filled.length
            ? h(
                  "p",
                  { class: "hint" },
                  "Otherwise their text stays in their files and no longer shows. Undo brings everything back.",
              )
            : null,
        h(
            "div",
            { class: "dialog-actions" },
            h(
                "button",
                { type: "button", class: "pbtn", onclick: () => closeDialog() },
                "Cancel",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn danger",
                    onclick: async () => {
                        const result = await edit({
                            action: "master",
                            op: "zone-remove",
                            file: src.path,
                            hash: src.hash,
                            zone: name,
                            dropContent: drop.checked,
                        });
                        if (result.ok) closeDialog();
                    },
                },
                "Remove",
            ),
        ),
    );
    openDialog("Remove placeholder", body);
}
