// SVG's second way of pointing at something: `fill="url(#grad)"`, `marker-end`,
// `clip-path`, `<use href="#foo">`. Unlike a selector, this resolves by name against
// the whole document and first match wins, so two slides that both define
// `#ConcaveTriangle` silently collapse onto one definition, and whichever lands first
// wins for *both* slides. Copying an outgoing slide's definitions alongside its ghosts
// therefore means renaming them.

// Presentation attributes whose value may be a funciri.
const REFERENCE_ATTRIBUTES = [
    "fill",
    "stroke",
    "clip-path",
    "mask",
    "filter",
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
    "cursor",
    "style",
];

// Same-document references: <use>, <textPath>, gradient inheritance, <mpath>.
const HREF_ATTRIBUTES = ["href", "xlink:href"];

const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;

function eachReference(
    root: Element,
    visit: (element: Element, attribute: string, id: string) => void,
): void {
    for (const element of [root, ...root.querySelectorAll("*")]) {
        for (const attribute of REFERENCE_ATTRIBUTES) {
            const value = element.getAttribute(attribute);
            if (!value?.includes("#")) continue;
            // Materialized before visiting: `visit` rewrites the attribute with the
            // same global regex, and sharing one regex object between an iteration and
            // a replace resets lastIndex underneath the iteration.
            for (const match of [...value.matchAll(URL_REFERENCE)])
                visit(element, attribute, match[2]);
        }
        for (const attribute of HREF_ATTRIBUTES) {
            const value = element.getAttribute(attribute);
            if (value?.startsWith("#"))
                visit(element, attribute, value.slice(1));
        }
    }
}

/** Every id referenced from inside `root`, whether or not it is defined there. */
export function collectReferencedIds(root: Element): Set<string> {
    const ids = new Set<string>();
    eachReference(root, (_element, _attribute, id) => ids.add(id));
    return ids;
}

/**
 * The ids a copy of `root` must rename: defined inside it *and* referenced from inside
 * it. Decided once for the whole outgoing slide, because its content may be split
 * across several copies and they all have to agree on the new names. A reference to
 * something defined elsewhere is excluded: renaming it would point it at a name nothing
 * answers to.
 */
export function referencedDefinitions(root: Element): Set<string> {
    const defined = new Set<string>();
    for (const element of [root, ...root.querySelectorAll("[id]")])
        if (element.id) defined.add(element.id);
    return new Set(
        [...collectReferencedIds(root)].filter((id) => defined.has(id)),
    );
}

/** Rewrite `ids` and every reference to them, so one slide's copied definitions cannot
 * shadow another slide's identically named ones. */
export function renameIds(
    root: Element,
    prefix: string,
    ids: ReadonlySet<string>,
): void {
    if (ids.size === 0) return;

    eachReference(root, (element, attribute, id) => {
        if (!ids.has(id)) return;
        const value = element.getAttribute(attribute) ?? "";
        element.setAttribute(
            attribute,
            attribute === "href" || attribute === "xlink:href"
                ? `#${prefix}${id}`
                : value.replace(
                      URL_REFERENCE,
                      (whole, quote: string, referenced: string) =>
                          referenced === id
                              ? `url(${quote}#${prefix}${referenced}${quote})`
                              : whole,
                  ),
        );
    });

    for (const element of [root, ...root.querySelectorAll("[id]")])
        if (ids.has(element.id)) element.id = `${prefix}${element.id}`;
}
