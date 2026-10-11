// The floating ink palette: tool, colour, width, undo / clear, and who draws.
// One component for the presenter and the editor; each page says what undo,
// clear and close do, and where its settings are remembered.

import { type InkTool, type PenTool, SWATCHES } from "./ink";
import {
    defaultSettings,
    type InkSettings,
    settingsFrom,
    sizesOf,
} from "./inksettings";

const ICONS: Record<string, string> = {
    pen: '<path d="M3 13.5 4 10l7-7 2.5 2.5-7 7Z"/><path d="m9.5 4.5 2 2"/>',
    highlighter:
        '<path d="M5 11 3.5 14h4l.8-1.8"/><path d="m5 11 6.5-8.5 3 2.4L8.3 12.2Z"/>',
    eraser: '<path d="M6.5 14H14"/><path d="M2.8 10.2 9 4l4 4-6 6H5.6Z"/><path d="m6 7 4 4"/>',
    undo: '<path d="M4 7h7a3.5 3.5 0 0 1 0 7H8"/><path d="M6.5 4.5 4 7l2.5 2.5"/>',
    clear: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
    fingers:
        '<path d="M6 8.5V3.2a1.1 1.1 0 0 1 2.2 0V7.5"/><path d="M8.2 7V6a1.1 1.1 0 0 1 2.2 0v1.5"/><path d="M10.4 7.2a1.1 1.1 0 0 1 2.1.3V10c0 2.5-1.6 4-4 4H8c-1.7 0-2.6-.8-3.6-2.3L3.2 9.8a1 1 0 0 1 1.6-1.2L6 9.8"/>',
    keep: '<path d="M4 2.5h6.5L13 5v8.5H4Z"/><path d="M6 2.5v3.5h4V2.5M6 13.5V9.5h5v4"/>',
    close: '<path d="m4 4 8 8M12 4l-8 8"/>',
};

function icon(name: string): string {
    return `<svg aria-hidden="true" viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

function button(
    title: string,
    content: string,
    data: Record<string, string>,
): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ink-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = content;
    for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
    return b;
}

function group(...children: HTMLElement[]): HTMLElement {
    const g = document.createElement("div");
    g.className = "ink-group";
    g.append(...children);
    return g;
}

export interface PaletteOptions {
    settings: InkSettings;
    onChange(settings: InkSettings): void;
    undo(): void;
    clear(): void;
    close?(): void;
    // Offer the presenter's "Keep" (saving strokes needs a local server).
    keep: boolean;
    undoTitle: string;
    clearTitle: string;
}

const TOOL_TITLES: Record<InkTool, string> = {
    pen: "Pen",
    highlighter: "Highlighter",
    eraser: "Eraser (also a pen's eraser end): wipe over strokes to remove them",
};

export class InkPalette {
    readonly el: HTMLElement;
    private opts: PaletteOptions;
    private custom: HTMLInputElement;
    private sizes: HTMLElement;

    constructor(opts: PaletteOptions) {
        this.opts = opts;
        const el = document.createElement("div");
        el.className = "ink-palette";
        el.setAttribute("role", "toolbar");
        el.setAttribute("aria-label", "Ink");
        this.el = el;

        const tools = group(
            ...(["pen", "highlighter", "eraser"] as InkTool[]).map((t) =>
                button(TOOL_TITLES[t], icon(t), { inkTool: t }),
            ),
        );
        const swatches = group(
            ...SWATCHES.map((s, i) => {
                const b = button(
                    s.label,
                    `<span class="ink-swatch" style="background:${s.token ? `var(--inkflow-${s.token}, ${s.hex})` : s.hex}"></span>`,
                    { inkSwatch: String(i) },
                );
                return b;
            }),
        );
        swatches.classList.add("ink-colours");
        const customLabel = document.createElement("label");
        customLabel.className = "ink-btn ink-custom";
        customLabel.title = "Another colour";
        customLabel.dataset.inkCustom = "";
        this.custom = document.createElement("input");
        this.custom.type = "color";
        this.custom.setAttribute("aria-label", "Another colour");
        customLabel.append(this.custom);
        swatches.append(customLabel);
        this.sizes = group();
        this.sizes.classList.add("ink-sizes");
        const actions = group(
            button(opts.undoTitle, icon("undo"), { inkAction: "undo" }),
            button(opts.clearTitle, icon("clear"), { inkAction: "clear" }),
        );
        const toggles = group(
            button(
                "Draw with a mouse or a finger too (off: only a pen draws, so clicks and swipes still navigate)",
                icon("fingers"),
                { inkToggle: "fingers" },
            ),
        );
        if (opts.keep) {
            toggles.append(
                button(
                    "Keep: save new strokes with the slide (off: they last for this talk only)",
                    icon("keep"),
                    { inkToggle: "keep" },
                ),
            );
        }
        if (opts.close) {
            toggles.append(
                button("Leave ink mode (i)", icon("close"), {
                    inkAction: "close",
                }),
            );
        }
        el.append(tools, swatches, this.sizes, actions, toggles);

        // A press on the palette is never a stroke or a click on the slide.
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            const b = (e.target as Element).closest<HTMLElement>(".ink-btn");
            if (!b) return;
            this.press(b.dataset);
        });
        this.custom.addEventListener("input", () => {
            const s = this.settings;
            const tool = this.penTool();
            s[tool] = { ...s[tool], swatch: null, custom: this.custom.value };
            if (s.tool === "eraser") s.tool = tool;
            this.commit(s);
        });
        this.render();
    }

    get settings(): InkSettings {
        return structuredClone(this.opts.settings);
    }

    set(settings: InkSettings): void {
        this.opts.settings = settings;
        this.render();
    }

    // The pen tool colour and width apply to: the current one, or the pen
    // while the eraser is picked.
    private penTool(): PenTool {
        return this.opts.settings.tool === "highlighter"
            ? "highlighter"
            : "pen";
    }

    private press(data: DOMStringMap): void {
        const s = this.settings;
        if (data.inkTool) {
            s.tool = data.inkTool as InkTool;
        } else if (data.inkSwatch !== undefined) {
            const tool = this.penTool();
            s[tool] = { ...s[tool], swatch: Number(data.inkSwatch) };
            if (s.tool === "eraser") s.tool = tool;
        } else if (data.inkSize !== undefined) {
            const tool = this.penTool();
            s[tool] = { ...s[tool], size: Number(data.inkSize) };
            if (s.tool === "eraser") s.tool = tool;
        } else if (data.inkCustom !== undefined) {
            // The well itself picks the custom colour; the native picker it
            // opens changes it (the input event below).
            const tool = this.penTool();
            s[tool] = { ...s[tool], swatch: null };
            if (s.tool === "eraser") s.tool = tool;
        } else if (data.inkToggle === "fingers") {
            s.fingers = !s.fingers;
        } else if (data.inkToggle === "keep") {
            s.keep = !s.keep;
        } else if (data.inkAction === "undo") {
            this.opts.undo();
            return;
        } else if (data.inkAction === "clear") {
            this.opts.clear();
            return;
        } else if (data.inkAction === "close") {
            this.opts.close?.();
            return;
        }
        this.commit(s);
    }

    private commit(s: InkSettings): void {
        this.opts.settings = s;
        this.render();
        this.opts.onChange(structuredClone(s));
    }

    private render(): void {
        const s = this.opts.settings;
        const tool = this.penTool();
        const t = s[tool];
        for (const b of this.el.querySelectorAll<HTMLElement>(
            "[data-ink-tool]",
        )) {
            b.setAttribute(
                "aria-pressed",
                String(b.dataset.inkTool === s.tool),
            );
        }
        for (const b of this.el.querySelectorAll<HTMLElement>(
            "[data-ink-swatch]",
        )) {
            b.setAttribute(
                "aria-pressed",
                String(t.swatch === Number(b.dataset.inkSwatch)),
            );
        }
        this.custom.parentElement!.classList.toggle("on", t.swatch === null);
        this.custom.value = t.custom;
        const sizes = sizesOf(tool);
        const largest = sizes[sizes.length - 1];
        this.sizes.replaceChildren(
            ...sizes.map((size, i) => {
                const px = Math.max(3, Math.round((size / largest) * 16));
                const b = button(
                    ["Thin", "Medium", "Thick"][i] ?? `Size ${i + 1}`,
                    `<span class="ink-dot ${tool}" style="width:${px}px;height:${tool === "highlighter" ? Math.max(3, Math.round(px / 2.5)) : px}px"></span>`,
                    { inkSize: String(i) },
                );
                b.setAttribute("aria-pressed", String(t.size === i));
                return b;
            }),
        );
        this.el.classList.toggle("erasing", s.tool === "eraser");
        for (const b of this.el.querySelectorAll<HTMLElement>(
            "[data-ink-toggle]",
        )) {
            const key = b.dataset.inkToggle as "fingers" | "keep";
            b.setAttribute("aria-pressed", String(s[key]));
        }
    }
}

// A page's palette settings, remembered in this browser only (a viewer's
// convenience; nothing depends on them being there).
export function loadSettings(key: string, fingers: boolean): InkSettings {
    const fallback = defaultSettings(fingers);
    try {
        const raw = localStorage.getItem(key);
        return raw ? settingsFrom(JSON.parse(raw), fallback) : fallback;
    } catch {
        return fallback;
    }
}

export function saveSettings(key: string, settings: InkSettings): void {
    try {
        localStorage.setItem(key, JSON.stringify(settings));
    } catch {
        // Private window or blocked storage: the palette just forgets.
    }
}
