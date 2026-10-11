// Rich text ↔ Markdown for in-place zone editing.
//
// A zone's rendered HTML is edited directly (contenteditable) and written back
// as Markdown. Only constructs that survive the trip are handled; anything else
// (images, code highlighting, step reveals, footnotes…) throws
// `Unsupported`, and the editor falls back to the Markdown source pane. Before
// editing in place the editor checks that serializing the zone as rendered gives
// back its source (`sameMarkdown`), so editing can never silently drop content.

export class Unsupported extends Error {}

const COLOR_CLASS = /^inkflow-color-[\w-]+$/;
const RAW_INLINE = new Set(["u", "mark", "sub", "sup"]);

function attrs(el: Element): string[] {
    return [...el.attributes].map((a) => a.name);
}

// Attributes contenteditable (or the browser) adds that carry no content.
function plain(el: Element, allowed: string[] = []): boolean {
    return attrs(el).every(
        (a) => allowed.includes(a) || a === "style" || a === "dir",
    );
}

// ── Inline ──

function escapeText(text: string): string {
    return (
        text
            .replace(/\\/g, "\\\\")
            .replace(/([*`[\]<~$])/g, "\\$1")
            // An underscore between word characters is not emphasis.
            .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace("_", "\\_"))
            .replace(/ /g, " ")
    );
}

function codeSpan(text: string): string {
    const ticks = text.includes("`") ? "``" : "`";
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${ticks}${pad}${text}${pad}${ticks}`;
}

// Emphasis markers must hug their text: "** bold**" is not bold in Markdown.
function wrap(inner: string, mark: string): string {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m?.[2]) return inner;
    return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

export function inline(node: Node): string {
    let out = "";
    for (const child of node.childNodes) out += inlineNode(child);
    // A hard break is followed by the newline the renderer wrote after <br>.
    return out.replace(/\\\n\n/g, "\\\n");
}

function inlineNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        // A newline in rendered text is a soft break in the source: kept.
        return escapeText(
            (node.textContent ?? "").replace(/[ \t]*\n\s*/g, "\n"),
        );
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const tag = el.localName;
    switch (tag) {
        case "strong":
        case "b":
            if (!plain(el)) throw new Unsupported(tag);
            return wrap(inline(el), "**");
        case "em":
        case "i":
            if (!plain(el)) throw new Unsupported(tag);
            return wrap(inline(el), "*");
        case "s":
        case "del":
        case "strike":
            if (!plain(el)) throw new Unsupported(tag);
            return wrap(inline(el), "~~");
        case "code":
            if (!plain(el)) throw new Unsupported(tag);
            return codeSpan(el.textContent ?? "");
        case "br":
            return "\\\n";
        case "a": {
            // A slide link as the renderer writes it (Markdown `slide:` scheme).
            const slide = el.getAttribute("data-inkflow-slide");
            if (slide && plain(el, ["data-inkflow-slide", "title"])) {
                return `[${inline(el)}](slide:${slide})`;
            }
            if (!plain(el, ["href", "title"])) throw new Unsupported(tag);
            const href = el.getAttribute("href") ?? "";
            const title = el.getAttribute("title");
            const t = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
            return `[${inline(el)}](${href.replace(/[()\s]/g, encodeURIComponent)}${t})`;
        }
        case "span": {
            const cls = el.getAttribute("class") ?? "";
            const latex = formula(el, "inline");
            if (latex !== null) return `$${latex}$`;
            if (!cls && plain(el)) return inline(el);
            if (COLOR_CLASS.test(cls) && plain(el, ["class"])) {
                return `<span class="${cls}">${inline(el)}</span>`;
            }
            throw new Unsupported(`span.${cls}`);
        }
        case "font":
            // execCommand leftovers carry no content of their own.
            return inline(el);
        default:
            if (RAW_INLINE.has(tag) && plain(el)) {
                return `<${tag}>${inline(el)}</${tag}>`;
            }
            throw new Unsupported(tag);
    }
}

// A rendered formula (<span class="math inline"> / <div class="math block">
// around MathML carrying data-latex): its LaTeX, or null when el is none.
export function formula(el: Element, kind: "inline" | "block"): string | null {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/);
    if (!cls.includes("math") || !cls.includes(kind)) return null;
    const latex = el.querySelector("math")?.getAttribute("data-latex");
    if (latex == null) throw new Unsupported("math without its LaTeX");
    return latex.trim();
}

// ── Blocks ──

const BLOCK = new Set([
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "blockquote",
    "hr",
    "table",
    "pre",
]);

function isBlank(node: Node): boolean {
    return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim();
}

function cellText(cell: Element): string {
    return inline(cell).replace(/\|/g, "\\|").replace(/\\\n/g, " ").trim();
}

function align(cell: Element): string {
    const a =
        (cell as HTMLElement).style?.textAlign || cell.getAttribute("align");
    return a === "center" || a === "right" || a === "left" ? a : "";
}

export function tableMarkdown(table: Element): string {
    const rows = [...table.querySelectorAll("tr")];
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.children.length));
    const cells = rows.map((r) => {
        const out = [...r.children].map(cellText);
        while (out.length < width) out.push("");
        return out;
    });
    const aligns = [...rows[0].children].map(align);
    while (aligns.length < width) aligns.push("");
    const rule = aligns.map((a) =>
        a === "center"
            ? ":---:"
            : a === "right"
              ? "---:"
              : a === "left"
                ? ":---"
                : "---",
    );
    const line = (r: string[]) => `| ${r.join(" | ")} |`;
    return [line(cells[0]), line(rule), ...cells.slice(1).map(line)].join("\n");
}

const TASK_LIST = "contains-task-list";
const TASK_ITEM = "task-list-item";

function isCheckbox(node: Node): node is HTMLInputElement {
    return (
        node.nodeType === Node.ELEMENT_NODE &&
        (node as Element).localName === "input" &&
        (node as HTMLInputElement).type === "checkbox"
    );
}

function listMarkdown(list: Element): string {
    const ordered = list.localName === "ol";
    // A checklist (- [ ] / - [x]); an item added while editing may lack its
    // class or its box, and is then an unticked task.
    const tasks = list.classList.contains(TASK_LIST);
    let n = parseInt(list.getAttribute("start") ?? "1", 10) || 1;
    const lines: string[] = [];
    for (const li of list.children) {
        if (li.localName !== "li") throw new Unsupported(li.localName);
        const cls = li.getAttribute("class") ?? "";
        if (!plain(li, cls === TASK_ITEM || !cls ? ["class"] : [])) {
            throw new Unsupported("li with attributes");
        }
        const box = [...li.childNodes].find(isCheckbox);
        const task = tasks || cls === TASK_ITEM || box !== undefined;
        const bullet = ordered ? `${n++}. ` : "- ";
        const marker = `${bullet}${task ? (box?.checked ? "[x] " : "[ ] ") : ""}`;
        const pad = " ".repeat(bullet.length);
        const own: string[] = [];
        const nested: string[] = [];
        for (const c of li.childNodes) {
            const el = c as Element;
            if (isCheckbox(c)) continue;
            if (
                c.nodeType === Node.ELEMENT_NODE &&
                /^[ou]l$/.test(el.localName)
            ) {
                nested.push(listMarkdown(el));
            } else if (
                c.nodeType === Node.ELEMENT_NODE &&
                (el.localName === "p" || el.localName === "div")
            ) {
                own.push(inline(el));
            } else {
                own.push(inlineNode(c));
            }
        }
        // contenteditable leaves a <br> at the end of an edited item.
        const text = own
            .join("")
            .replace(/(\\\n\s*)+$/, "")
            .trim()
            .replace(/\n/g, `\n${pad}`);
        lines.push(`${marker}${text}`);
        for (const sub of nested) {
            lines.push(
                sub
                    .split("\n")
                    .map((l) => pad + l)
                    .join("\n"),
            );
        }
    }
    return lines.join("\n");
}

function blockMarkdown(el: Element): string {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) {
        if (!plain(el)) throw new Unsupported(tag);
        return `${"#".repeat(Number(tag[1]))} ${inline(el).trim()}`;
    }
    const latex = formula(el, "block");
    if (latex !== null) return `$$\n${latex}\n$$`;
    switch (tag) {
        case "p":
        case "div":
            if (!plain(el)) throw new Unsupported(tag);
            // A div holding blocks (pasted content) is serialized as those.
            if ([...el.children].some((c) => BLOCK.has(c.localName))) {
                return blocks(el);
            }
            return escapeLineStart(inline(el).replace(/\\\n$/, "").trim());
        case "ul":
        case "ol": {
            const cls = el.getAttribute("class");
            if (cls && cls !== TASK_LIST)
                throw new Unsupported(`${tag}.${cls}`);
            if (!plain(el, ["start", "class"])) throw new Unsupported(tag);
            return listMarkdown(el);
        }
        case "blockquote":
            if (!plain(el)) throw new Unsupported(tag);
            return blocks(el)
                .split("\n")
                .map((l) => (l ? `> ${l}` : ">"))
                .join("\n");
        case "hr":
            return "---";
        case "table":
            if (!plain(el)) throw new Unsupported(tag);
            return tableMarkdown(el);
        default:
            throw new Unsupported(tag);
    }
}

// Paragraph text that would read as a heading, list or quote is escaped.
function escapeLineStart(md: string): string {
    const ordered = md.match(/^(\d+)([.)]) /);
    if (ordered) {
        return `${ordered[1]}\\${ordered[2]} ${md.slice(ordered[0].length)}`;
    }
    return /^(#{1,6} |[-+] |> )/.test(md) ? `\\${md}` : md;
}

function blocks(root: Element): string {
    const out: string[] = [];
    let run = "";
    const flush = () => {
        if (run.trim()) out.push(run.trim());
        run = "";
    };
    for (const node of root.childNodes) {
        if (isBlank(node)) continue;
        const el = node as Element;
        if (node.nodeType === Node.ELEMENT_NODE && BLOCK.has(el.localName)) {
            flush();
            const md = blockMarkdown(el);
            if (md.trim()) out.push(md);
        } else if (
            node.nodeType === Node.ELEMENT_NODE &&
            el.localName === "br"
        ) {
            flush();
        } else {
            run += inlineNode(node);
        }
    }
    flush();
    return out.join("\n\n");
}

/** The Markdown for an edited zone's content element (throws Unsupported). */
export function htmlToMarkdown(root: Element): string {
    return blocks(root);
}

// ── Comparing Markdown ──

/** Spelling-insensitive form: two sources that render the same compare equal. */
export function normalizeMarkdown(md: string): string {
    return (
        md
            .replace(/\r/g, "")
            // Two trailing spaces and a backslash are both a hard line break.
            .replace(/ {2,}\n(?=[^\n])/g, "\\\n")
            .split("\n")
            .map((l) =>
                l
                    .replace(/\s+$/, "")
                    .replace(/^(\s*)[*+] /, "$1- ")
                    .replace(/^(\s*)\d+[.)] /, "$11. "),
            )
            .join("\n")
            .replace(/__(.+?)__/g, "**$1**")
            .replace(/(^|\W)_(\S.*?)_(?=\W|$)/g, "$1*$2*")
            .replace(/\\([\\`*_{}[\]()#+\-.!<>~$|])/g, "$1")
            .replace(/ *\| */g, "|")
            .replace(/\|:?-+:?/g, "|-")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
    );
}

export function sameMarkdown(a: string, b: string): boolean {
    return normalizeMarkdown(a) === normalizeMarkdown(b);
}
