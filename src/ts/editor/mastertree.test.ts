import { describe, expect, it } from "vitest";
import {
    copyTarget,
    layoutRows,
    layoutTitle,
    type MasterLayout,
    type MasterTree,
    origin,
    usage,
} from "./mastertree";

function layout(
    name: string,
    parent: string | null,
    extra: Partial<MasterLayout> = {},
): MasterLayout {
    return {
        name,
        label: null,
        path: `/theme/layouts/${name}.svg`,
        rel: null,
        source: "builtin",
        copyOf: null,
        shadows: false,
        parent,
        slides: [],
        reach: [],
        zones: [],
        ...extra,
    };
}

function tree(layouts: MasterLayout[], background = "base"): MasterTree {
    return {
        background,
        layouts,
        overlays: [],
        overlaysFromTheme: false,
        overrides: [],
        canvas: [1920, 1080],
    };
}

const rows = (t: MasterTree) =>
    layoutRows(t).map((r) => `${"  ".repeat(r.depth)}${r.layout.name}`);

describe("layoutRows", () => {
    it("nests layouts under their parent, the background left out", () => {
        const t = tree([
            layout("agenda", "title"),
            layout("base", null),
            layout("content", "title"),
            layout("cover", "base"),
            layout("title", "numbered"),
            layout("numbered", "base"),
            layout("fact", "numbered"),
        ]);
        expect(rows(t)).toEqual([
            "numbered",
            "  title",
            "    content",
            "    agenda",
            "  fact",
            "cover",
        ]);
    });

    it("puts templates after the theme's layouts, a copy in its place", () => {
        const t = tree([
            layout("base", null),
            layout("title", "base", {
                source: "local",
                copyOf: "builtin:title",
            }),
            layout("zeta-own", "title", { source: "local" }),
            layout("content", "title"),
            layout("custom-code", "base", { source: "local" }),
        ]);
        expect(rows(t)).toEqual([
            "title",
            "  content",
            "  zeta-own",
            "custom-code",
        ]);
    });

    it("treats a layout with an unlisted parent as a root", () => {
        const t = tree(
            [
                layout("poster-base", null),
                layout("poster-3col", "poster-base"),
                layout("mine", "elsewhere", { source: "local" }),
            ],
            "poster-base",
        );
        expect(rows(t)).toEqual(["poster-3col", "mine"]);
    });

    it("survives a cycle", () => {
        const t = tree([layout("a", "b"), layout("b", "a")], "x");
        expect(rows(t)).toEqual([]);
    });
});

describe("row words", () => {
    it("says where a layout comes from", () => {
        expect(origin(layout("agenda", "title")).kind).toBe("theme");
        expect(
            origin(layout("agenda", "title", { copyOf: "builtin:agenda" }))
                .text,
        ).toBe("Deck's copy");
        expect(origin(layout("mine", null, { source: "local" })).kind).toBe(
            "own",
        );
    });

    it("counts the slides an edit reaches", () => {
        const l = layout("title", "numbered", {
            slides: [1],
            reach: [1, 2, 3],
        });
        expect(usage(l, false)).toBe("1 slide (+2 built on it)");
        expect(usage(layout("x", null), false)).toBe("no slides");
        expect(usage(layout("base", null, { reach: [0, 1] }), true, 2)).toBe(
            "behind every slide",
        );
        // A slide drawn without any layout has no background to share.
        expect(usage(layout("base", null, { reach: [1, 2] }), true, 3)).toBe(
            "behind 2 of 3 slides",
        );
    });

    it("names a template as typed", () => {
        const labels = { content: "Title and content" };
        expect(layoutTitle({ name: "content", label: null }, labels)).toBe(
            "Title and content",
        );
        expect(
            layoutTitle(
                { name: "custom-code-examples", label: "customCodeExamples" },
                labels,
            ),
        ).toBe("customCodeExamples");
    });

    it("knows where the deck's copy of a theme file goes", () => {
        expect(
            copyTarget(
                "/site/inkflow/theme/layouts/base.svg",
                "/deck",
                "layout",
            ),
        ).toBe("/deck/layouts/base.svg");
        expect(copyTarget("/deck/layouts/base.svg", "/deck/", "layout")).toBe(
            null,
        );
        expect(
            copyTarget(
                "C:\\py\\theme\\overlays\\logo.svg",
                "C:\\deck",
                "overlay",
            ),
        ).toBe("C:\\deck\\overlays\\logo.svg");
    });
});
