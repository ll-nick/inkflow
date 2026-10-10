// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { blockKind, blocksOf, toRect } from "./boxes";

describe("toRect", () => {
    test("corner and size, to a tenth of a unit", () => {
        expect(
            toRect({ left: 10.04, top: 20, right: 110.06, bottom: 70.5 }),
        ).toEqual({ x: 10, y: 20, w: 100, h: 50.5 });
    });
});

describe("blocks of a zone's text", () => {
    function content(html: string): Element {
        const div = document.createElement("div");
        div.innerHTML = html;
        return div;
    }

    test("lists blocks in reading order, looking into wrappers", () => {
        const el = content(
            "<h2>Title</h2>" +
                '<div id="inkflow-step-1"><p>One</p></div>' +
                '<div class="highlight"><pre><code>x = 1</code></pre></div>' +
                "<ul><li>a</li><li>b</li></ul><table></table><img>",
        );
        expect(blocksOf(el).map((b) => blockKind(b))).toEqual([
            "h2",
            "p",
            "code",
            "list",
            "table",
            "image",
        ]);
    });

    test("inline math is part of its paragraph, display math a block", () => {
        const inline = document.createElement("math");
        expect(blockKind(inline)).toBeNull();
        inline.setAttribute("display", "block");
        expect(blockKind(inline)).toBe("math");
    });
});
