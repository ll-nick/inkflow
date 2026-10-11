// Which of the editor's panels are shown (panels.ts), without the page.

export const PANELS = ["left", "bottom", "right"] as const;
/** The slide list (or the slide master's list), the speaker notes, the
 * properties. */
export type Panel = (typeof PANELS)[number];

export type Shown = Record<Panel, boolean>;

export const ALL_SHOWN: Shown = { left: true, bottom: true, right: true };

/** The key that hides and shows each panel, and what its button calls it. */
export const PANEL_KEYS: Record<Panel, string> = {
    left: "1",
    bottom: "2",
    right: "3",
};

export const PANEL_NAMES: Record<Panel, string> = {
    left: "slide list",
    bottom: "speaker notes",
    right: "properties",
};

/** What was remembered (the hidden panels' names, as JSON), or every panel
 * shown when nothing usable was. */
export function parseShown(stored: string | null): Shown {
    const shown = { ...ALL_SHOWN };
    if (!stored) return shown;
    try {
        const hidden: unknown = JSON.parse(stored);
        if (!Array.isArray(hidden)) return shown;
        for (const panel of PANELS) {
            if (hidden.includes(panel)) shown[panel] = false;
        }
    } catch {
        // every panel shown
    }
    return shown;
}

export function storeShown(shown: Shown): string {
    return JSON.stringify(PANELS.filter((panel) => !shown[panel]));
}

export function panelTitle(
    panel: Panel,
    shown: boolean,
    key: string = PANEL_KEYS[panel],
): string {
    const name = PANEL_NAMES[panel];
    const what = `${shown ? "Hide" : "Show"} the ${name}`;
    return key ? `${what} (${key})` : what;
}

/** The panel a key hides and shows, if it is one's. */
export function panelOfKey(key: string): Panel | null {
    return PANELS.find((panel) => PANEL_KEYS[panel] === key) ?? null;
}
