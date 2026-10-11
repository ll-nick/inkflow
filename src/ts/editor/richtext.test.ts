// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
    htmlToMarkdown,
    normalizeMarkdown,
    sameMarkdown,
    Unsupported,
} from "./richtext";

// HTML as inkflow's Markdown renderer (markdown-it) emits it.
function md(html: string): string {
    const div = document.createElement("div");
    div.innerHTML = html;
    return htmlToMarkdown(div);
}

describe("htmlToMarkdown", () => {
    it("round-trips inline formatting", () => {
        const out = md(
            '<p>Hello <strong>bold</strong> and <em>it</em> and <code>code</code> and <a href="https://x.y/a">link</a>.</p>\n<p>Second <s>gone</s> para.</p>\n',
        );
        expect(out).toBe(
            "Hello **bold** and *it* and `code` and [link](https://x.y/a).\n\nSecond ~~gone~~ para.",
        );
    });

    it("writes nested and numbered lists", () => {
        const out = md(
            "<ul>\n<li>one</li>\n<li>two\n<ul>\n<li>nested</li>\n</ul>\n</li>\n</ul>\n<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n",
        );
        expect(out).toBe("- one\n- two\n  - nested\n\n1. a\n2. b");
    });

    it("writes slide links with the slide: scheme", () => {
        expect(
            md(
                '<p><a data-inkflow-slide="intro" title="Go to slide: intro">back</a></p>',
            ),
        ).toBe("[back](slide:intro)");
    });

    it("writes checklists as task items", () => {
        const out = md(
            '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="disabled" type="checkbox"> todo</li>\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="checked" disabled="disabled" type="checkbox"> done</li>\n<li>added while editing<br></li>\n</ul>\n',
        );
        expect(out).toBe("- [ ] todo\n- [x] done\n- [ ] added while editing");
    });

    it("writes headings, quotes and hard breaks", () => {
        expect(md("<h1>Title</h1>\n")).toBe("# Title");
        expect(md("<blockquote>\n<p>quoted\ntext</p>\n</blockquote>\n")).toBe(
            "> quoted\n> text",
        );
        expect(md("<p>line one<br />\nline two</p>\n")).toBe(
            "line one\\\nline two",
        );
    });

    it("writes tables with alignment", () => {
        const out = md(
            '<table><thead><tr><th style="text-align:left">A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr><tr><td style="text-align:left">x <strong>y</strong></td><td style="text-align:right"></td></tr></tbody></table>',
        );
        expect(out).toBe(
            "| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| x **y** |  |",
        );
    });

    it("keeps theme colour spans and escapes literal syntax", () => {
        expect(
            md(
                '<p>Some <span class="inkflow-color-accent">accent</span> word</p>',
            ),
        ).toBe('Some <span class="inkflow-color-accent">accent</span> word');
        expect(md("<p>snake_case and 2 * 3 and $5</p>")).toBe(
            "snake_case and 2 \\* 3 and \\$5",
        );
        expect(md("<p># not a heading</p>")).toBe("\\# not a heading");
        expect(md("<p>1. not a list</p>")).toBe("1\\. not a list");
    });

    it("treats contenteditable's own markup as plain paragraphs", () => {
        expect(
            md(
                '<div>typed</div><div><b style="">bold</b><br></div><p><span>x</span></p>',
            ),
        ).toBe("typed\n\n**bold**\n\nx");
    });

    it("writes formulas back as LaTeX", () => {
        expect(
            md(
                '<p>Euler <span class="math inline"><math data-latex="e^{i\\pi}"><mi>e</mi></math></span> holds</p>\n<div class="math block">\n<math data-latex="\\frac{a}{b}" display="block"><mfrac/></math>\n</div>',
            ),
        ).toBe("Euler $e^{i\\pi}$ holds\n\n$$\n\\frac{a}{b}\n$$");
    });

    it("refuses what it cannot write back", () => {
        expect(() =>
            md(
                '<p>Euler <span class="math inline"><math><mi>e</mi></math></span></p>',
            ),
        ).toThrow(Unsupported);
        expect(() => md('<p><img src="a.png" alt="a"></p>')).toThrow(
            Unsupported,
        );
        expect(() => md('<div class="step">x</div>')).toThrow(Unsupported);
        expect(() => md("<pre><code>x</code></pre>")).toThrow(Unsupported);
    });
});

describe("sameMarkdown", () => {
    it("ignores spelling differences that render the same", () => {
        expect(sameMarkdown("* a\n* b", "- a\n- b")).toBe(true);
        expect(sameMarkdown("__b__ _i_", "**b** *i*")).toBe(true);
        expect(sameMarkdown("3. x", "1. x")).toBe(true);
        expect(sameMarkdown("a  \n\n\n\nb", "a\n\nb")).toBe(true);
        expect(sameMarkdown("costs $5", "costs \\$5")).toBe(true);
        expect(sameMarkdown("**a**  \nb", "**a**\\\nb")).toBe(true);
        expect(sameMarkdown("|a|b|\n|-|-|", "| a | b |\n| --- | --- |")).toBe(
            true,
        );
    });

    it("tells different content apart", () => {
        expect(sameMarkdown("**a**", "a")).toBe(false);
        expect(sameMarkdown("a\n::step::\nb", "a\n\nb")).toBe(false);
        expect(normalizeMarkdown("x")).toBe("x");
    });
});
