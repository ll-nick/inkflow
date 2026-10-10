// The Theme dialog: the deck's colours, fonts, base font size and colour mode.
//
// Colours and fonts are the active theme's tokens; a change is written as an
// override in the project's styles.css (inkflow/editor/themeedit.py), the mode
// and font size as Deck(...) arguments. Colours preview live while the picker is
// dragged; the rebuild then restyles every open window (presenter included).

import { openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { edit, request } from "./net";
import { ed, on } from "./state";

interface ThemeInfo {
    name: string;
    mode: string;
    deckMode: string | null;
    themeMode: string;
    fontSize: number | null;
    themeFontSize: number;
    values: Record<"dark" | "light" | "typography", Record<string, string>>;
    overrides: Record<"dark" | "light" | "typography", Record<string, string>>;
    fonts: string[];
}

const SEMANTIC: [string, string][] = [
    ["bg", "Background"],
    ["surface", "Surface (cards)"],
    ["border", "Border"],
    ["text", "Text"],
    ["text_muted", "Muted text"],
    ["heading", "Headings"],
    ["accent", "Accent"],
    ["accent_fg", "Text on accent"],
    ["link", "Links"],
    ["code_bg", "Code background"],
    ["code_text", "Code text"],
    ["blockquote", "Quote bar"],
];
const NAMED = [
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "grey",
];
const FONTS: [string, string, string][] = [
    ["body_font", "Body", "sans-serif"],
    ["heading_font", "Headings", "sans-serif"],
    ["mono_font", "Code", "monospace"],
];

type FontWhere = "project" | "theme" | "machine" | "missing" | "generic";

interface FontFamily {
    family: string;
    where: FontWhere;
    faces: string[];
    usedBy: string[];
    files: { path: string; where: FontWhere; face: string }[];
    licence: { status: string; name: string } | null;
    message: string;
}

interface FontReport {
    families: FontFamily[];
}

let info: ThemeInfo | null = null;
let report: FontReport | null = null;
let content: HTMLElement | null = null;

const cssVar = (name: string) => `--inkflow-${name.replace(/_/g, "-")}`;

// <input type=color> takes #rrggbb only: normalise whatever the theme wrote.
function toHex(value: string): string {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(value)) {
        return `#${[...value.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
    }
    const probe = h("span", {});
    probe.style.color = value;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? ["0", "0", "0"];
    probe.remove();
    return `#${rgb
        .slice(0, 3)
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")}`;
}

async function save(
    body: Record<string, unknown>,
    label: string,
): Promise<void> {
    await edit({ action: "theme-set", label, ...body });
}

function setToken(
    group: "dark" | "light" | "typography",
    name: string,
    value: string | null,
): void {
    void save({ changes: { [group]: { [name]: value } } }, "Theme");
}

function colorCell(mode: "dark" | "light", name: string): HTMLElement {
    const t = info!;
    const own = t.overrides[mode][name];
    const value = own ?? t.values[mode][name] ?? "#000000";
    const input = h("input", {
        type: "color",
        value: toHex(value),
        title: `${cssVar(name)} (${mode})${own ? " · changed" : ""}`,
    });
    // Live preview while dragging, in the mode the editor is showing.
    input.addEventListener("input", () => {
        const showing =
            document.documentElement.dataset.theme === "light"
                ? "light"
                : "dark";
        if (showing === mode) {
            document.documentElement.style.setProperty(
                cssVar(name),
                input.value,
            );
        }
    });
    input.addEventListener("change", () => setToken(mode, name, input.value));
    return h(
        "span",
        { class: `theme-color${own ? " changed" : ""}` },
        input,
        own
            ? h(
                  "button",
                  {
                      type: "button",
                      class: "theme-reset",
                      title: "Back to the theme's colour",
                      onclick: () => setToken(mode, name, null),
                  },
                  "↺",
              )
            : null,
    );
}

function colorsTable(): HTMLElement {
    const rows: HTMLElement[] = [
        h(
            "div",
            { class: "theme-row head" },
            h("span", {}, ""),
            h("span", {}, "Dark"),
            h("span", {}, "Light"),
        ),
    ];
    const add = (name: string, label: string) =>
        rows.push(
            h(
                "div",
                { class: "theme-row" },
                h("span", { class: "theme-label" }, label),
                colorCell("dark", name),
                colorCell("light", name),
            ),
        );
    for (const [name, label] of SEMANTIC) add(name, label);
    rows.push(h("div", { class: "theme-sub" }, "Named colours"));
    for (const name of NAMED) add(name, name[0].toUpperCase() + name.slice(1));
    return h("div", { class: "theme-colors" }, ...rows);
}

function fontRow(name: string, label: string, generic: string): HTMLElement {
    const t = info!;
    const own = t.overrides.typography[name];
    const value = own ?? t.values.typography[name] ?? generic;
    const input = h("input", {
        type: "text",
        list: "theme-font-list",
        value: value,
        placeholder: generic,
        spellcheck: "false",
    });
    input.addEventListener("change", () => {
        const v = input.value.trim();
        if (!v) {
            setToken("typography", name, null);
            return;
        }
        // As `inkflow fonts set` does: a bare family gets a generic fallback,
        // a generic first is refused, and a font only this computer has is
        // copied into fonts/ in the same step.
        void (async () => {
            const res = await edit({
                action: "fonts",
                op: "set",
                role: name.replace(/_font$/, ""),
                family: v,
                label: `Font: ${label}`,
            });
            if (!res.ok) {
                input.value = value;
                return;
            }
            const bundle = res.bundle as { families?: string[] } | undefined;
            if (bundle?.families?.length) {
                toast(`Copied ${bundle.families.join(", ")} into fonts/`, "ok");
            } else if (typeof res.note === "string") {
                toast(res.note, "info");
            }
        })();
    });
    const sample = h("span", { class: "theme-font-sample" }, "Aa Bb 123");
    sample.style.fontFamily = value;
    return h(
        "div",
        { class: "theme-font" },
        h("span", { class: "theme-label" }, label),
        input,
        sample,
        own
            ? h(
                  "button",
                  {
                      type: "button",
                      class: "theme-reset",
                      title: "Back to the theme's font",
                      onclick: () => setToken("typography", name, null),
                  },
                  "↺",
              )
            : null,
    );
}

function render(): void {
    if (!content || !info) return;
    const t = info;
    clear(content);
    const mode = h("select", {});
    for (const [v, l] of [
        ["", `Theme default (${t.themeMode})`],
        ["dark", "Dark"],
        ["light", "Light"],
    ]) {
        mode.append(h("option", { value: v }, l));
    }
    mode.value = t.deckMode ?? "";
    // Mode and size are Deck(...) arguments: read-only when deck.py is code.
    mode.disabled = !ed.model?.deckEditable;
    mode.addEventListener(
        "change",
        () => void save({ mode: mode.value || null }, "Colour mode"),
    );
    const size = h("input", {
        type: "number",
        min: 8,
        max: 200,
        value: t.fontSize ?? "",
        placeholder: String(t.themeFontSize),
    });
    size.disabled = !ed.model?.deckEditable;
    size.addEventListener("change", () => {
        const n = parseInt(size.value, 10);
        void save({ fontSize: Number.isFinite(n) ? n : null }, "Font size");
    });
    const list = h("datalist", { id: "theme-font-list" });
    for (const f of ["sans-serif", "serif", "monospace", ...t.fonts]) {
        list.append(h("option", { value: f }));
    }
    content.append(
        h(
            "div",
            { class: "theme-top" },
            h("label", {}, h("span", {}, "Colour mode"), mode),
            h("label", {}, h("span", {}, "Base font size (px)"), size),
        ),
        h("h3", {}, "Fonts"),
        list,
        ...FONTS.map(([n, l, g]) => fontRow(n, l, g)),
        fontsReport(),
        h("h3", {}, "Colours"),
        colorsTable(),
        h(
            "p",
            { class: "hint" },
            "Changes are written to styles.css (one marked block) and deck.py; ↺ goes back to the theme.",
        ),
    );
}

// ── Where the fonts come from (inkflow/fontreport.py) ──

const WHERE: Record<FontWhere, string> = {
    project: "in the deck (fonts/)",
    theme: "ships with inkflow / the theme",
    machine: "this computer only",
    missing: "not installed",
    generic: "each machine's own",
};

function fontsReport(): HTMLElement {
    const families = report?.families ?? [];
    const box = h("div", { class: "theme-fonts-report" });
    if (!report) {
        box.append(
            h("p", { class: "hint" }, "Checking where the fonts come from…"),
        );
        return box;
    }
    if (!families.length) {
        box.append(h("p", { class: "hint" }, "The deck names no font."));
        return box;
    }
    box.append(
        h(
            "div",
            { class: "theme-sub" },
            "Where each font comes from (on another machine only the deck's and inkflow's fonts are there)",
        ),
        ...families.map((f) =>
            h(
                "div",
                {
                    class: `font-source ${f.where}`,
                    "data-family": f.family,
                    title: f.message || f.files.map((x) => x.path).join("\n"),
                },
                h("span", { class: "font-family" }, f.family),
                h("span", { class: `font-where ${f.where}` }, WHERE[f.where]),
                h("span", { class: "font-faces" }, f.faces.join(", ")),
                f.message
                    ? h("span", { class: "font-message hint" }, f.message)
                    : null,
            ),
        ),
    );
    const machine = families.filter((f) => f.where === "machine");
    const bundle = h(
        "button",
        {
            type: "button",
            class: "pbtn",
            "data-fonts": "bundle",
            title: "Copy the fonts only this computer has into the deck's fonts/, with their licences",
            onclick: () => void bundleFonts(),
        },
        "Bundle fonts into the deck",
    ) as HTMLButtonElement;
    bundle.disabled = machine.length === 0;
    box.append(h("div", { class: "btn-row" }, bundle));
    return box;
}

async function bundleFonts(): Promise<void> {
    const plan = await request({ action: "fonts", op: "bundle", dryRun: true });
    if (!plan.ok) {
        toast(plan.error ?? "cannot bundle fonts", "error");
        return;
    }
    const b = plan.bundle as {
        copies: { from: string; to: string }[];
        families: string[];
        warnings: string[];
    };
    if (!b.copies.length) {
        toast("No font comes from this computer only", "info");
        return;
    }
    const question = [
        `Copy ${b.families.join(", ")} into fonts/ (${b.copies.length} file${b.copies.length === 1 ? "" : "s"})?`,
        ...b.warnings.map((w) => `⚠ ${w}`),
    ].join("\n\n");
    if (!confirm(question)) return;
    const res = await edit({ action: "fonts", op: "bundle" });
    if (res.ok) {
        toast(`Copied ${b.families.join(", ")} into fonts/`, "ok");
        await refresh();
    }
}

async function refresh(): Promise<void> {
    const result = await request({ action: "theme-get" });
    if (!result.ok) return;
    info = result.theme as ThemeInfo;
    render();
    const fonts = await request({ action: "fonts" });
    if (fonts.ok) {
        report = fonts.fonts as FontReport;
        render();
    }
}

export async function openTheme(): Promise<void> {
    report = null;
    content = h(
        "div",
        { class: "theme-body" },
        h("p", { class: "hint" }, "Loading…"),
    );
    openDialog("Theme", content, {
        hint: "Colours, fonts and size for the whole deck",
        onClose: () => {
            content = null;
            document.documentElement.removeAttribute("style");
        },
    });
    await refresh();
}

export function initTheme(): void {
    document
        .getElementById("btn-theme-panel")
        ?.addEventListener("click", () => {
            void openTheme();
        });
    on("model", () => {
        // The rebuild carries the new styles: drop the live previews.
        document.documentElement.removeAttribute("style");
        if (content) void refresh();
    });
}
