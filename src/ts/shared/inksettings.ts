// What the ink palette is set to: tool, colour and width per tool, and who may
// draw. Pure, so the rules are tested; the palette (inkpalette.ts) shows it and
// each page keeps its own copy in localStorage.

import {
    HIGHLIGHTER_SIZES,
    type InkTool,
    inkScale,
    PEN_SIZES,
    type PenTool,
    type StrokeStyle,
    SWATCHES,
} from "./ink";

export interface ToolSettings {
    swatch: number | null; // index into SWATCHES; null: `custom`
    custom: string; // #rrggbb
    size: number; // index into the tool's sizes
}

export interface InkSettings {
    tool: InkTool;
    pen: ToolSettings;
    highlighter: ToolSettings;
    // A mouse or a finger draws too. Off, only a pen draws, so clicks and
    // swipes keep navigating (and a palm resting on a tablet draws nothing).
    fingers: boolean;
    // Strokes are saved into the slide's ink file instead of kept for the
    // talk only (the presenter's "Keep"; the editor always saves).
    keep: boolean;
}

export function defaultSettings(fingers: boolean): InkSettings {
    return {
        tool: "pen",
        pen: { swatch: 2, custom: "#e64553", size: 1 },
        highlighter: { swatch: 4, custom: "#df8e1d", size: 1 },
        fingers,
        keep: false,
    };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function toolFrom(
    raw: unknown,
    fallback: ToolSettings,
    sizes: number,
): ToolSettings {
    if (typeof raw !== "object" || raw === null) return { ...fallback };
    const r = raw as Record<string, unknown>;
    const swatch =
        r.swatch === null
            ? null
            : Number.isInteger(r.swatch) &&
                (r.swatch as number) >= 0 &&
                (r.swatch as number) < SWATCHES.length
              ? (r.swatch as number)
              : fallback.swatch;
    return {
        swatch,
        custom:
            typeof r.custom === "string" && HEX_RE.test(r.custom)
                ? r.custom
                : fallback.custom,
        size:
            Number.isInteger(r.size) &&
            (r.size as number) >= 0 &&
            (r.size as number) < sizes
                ? (r.size as number)
                : fallback.size,
    };
}

// Settings read back from storage, with anything missing or malformed (an
// older page's, or edited by hand) taken from `fallback`.
export function settingsFrom(raw: unknown, fallback: InkSettings): InkSettings {
    if (typeof raw !== "object" || raw === null)
        return structuredClone(fallback);
    const r = raw as Record<string, unknown>;
    return {
        tool:
            r.tool === "pen" || r.tool === "highlighter" || r.tool === "eraser"
                ? r.tool
                : fallback.tool,
        pen: toolFrom(r.pen, fallback.pen, PEN_SIZES.length),
        highlighter: toolFrom(
            r.highlighter,
            fallback.highlighter,
            HIGHLIGHTER_SIZES.length,
        ),
        fingers: typeof r.fingers === "boolean" ? r.fingers : fallback.fingers,
        keep: typeof r.keep === "boolean" ? r.keep : fallback.keep,
    };
}

export function sizesOf(tool: PenTool): number[] {
    return tool === "highlighter" ? HIGHLIGHTER_SIZES : PEN_SIZES;
}

// The style a new stroke gets. `width` and `height` are the size of the slide
// area on screen in slide units (the viewBox, which the zoom camera narrows),
// so a stroke has the same width on screen however far in it is drawn, and on
// a slide of any shape (`inkScale`).
// `tokenColor` resolves a theme token to its current colour, or null.
export function styleFor(
    s: InkSettings,
    tool: PenTool,
    width: number,
    tokenColor: (token: string) => string | null,
    height = 0,
): StrokeStyle {
    const t = s[tool];
    const swatch = t.swatch === null ? null : SWATCHES[t.swatch];
    const fill = swatch
        ? (swatch.token && tokenColor(swatch.token)) || swatch.hex
        : t.custom;
    return {
        tool,
        fill: normalizeHex(fill) ?? "#000000",
        token: swatch?.token ?? null,
        size: sizesOf(tool)[t.size] * inkScale(width, height),
    };
}

// `#abc`, `#aabbcc`, or `rgb(r, g, b)` (a computed style) as `#aabbcc`.
export function normalizeHex(color: string): string | null {
    const c = color.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(c)) return c;
    if (/^#[0-9a-f]{3}$/.test(c))
        return `#${[...c.slice(1)].map((x) => x + x).join("")}`;
    const m = c.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (m) {
        return `#${m
            .slice(1, 4)
            .map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0"))
            .join("")}`;
    }
    return null;
}
