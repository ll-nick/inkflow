// A ghost layer is the outgoing slide's own <svg>, cloned and pruned down to the
// elements that are fading out plus the spine of ancestors above them.
//
// Pruning rather than re-parenting is the whole point. An element's appearance depends
// on where it sits: inherited fill and font, custom properties, selectors that name an
// ancestor, and the coordinate space its geometry is written in all come from the
// chain above it. Hang it off a foreign root and every one of those changes. Keep the
// chain and none of them do.

import { renameIds } from "../shared/svg-refs";

// Marks every node the morph adds, so cleanup is a selector sweep rather than a walk of
// a task list that may never have been assigned. `_scope_slide_styles` uses the same
// attribute as an `@scope ... to (...)` limit, so the incoming slide's own rules stop
// at a container instead of restyling content on its way out.
export const GHOST_ATTRIBUTE = "data-morph-ghost";

export function markGhost(element: Element): void {
    element.setAttribute(GHOST_ATTRIBUTE, "");
}

export function removeGhosts(root: ParentNode): void {
    for (const ghost of root.querySelectorAll(`[${GHOST_ATTRIBUTE}]`))
        ghost.remove();
}

// An `@scope` prelude with no limit of its own, and a block to follow. Already-limited
// preludes have ` to (…)` between the paren and the brace, so they do not match and
// applying this twice is a no-op.
const UNLIMITED_SCOPE = /@scope\s*\(([^)]*)\)\s*(?=\{)/g;

/**
 * Stop the live slide's `@scope` rules at ghost containers, and return the undo.
 *
 * A container is nested inside the incoming slide, so without a limit the incoming
 * slide's own scoped rules would reach in and restyle content that is on its way out.
 * Done here, at transition time, rather than where the CSS is generated: the morph
 * stays self-contained, and it covers an `@scope` a deck author wrote as well as the
 * pipeline's own.
 */
export function limitScopesToLiveContent(root: ParentNode): () => void {
    const originals = new Map<Element, string>();
    for (const style of root.querySelectorAll("style")) {
        const css = style.textContent ?? "";
        if (!css.includes("@scope")) continue;
        const limited = css.replace(
            UNLIMITED_SCOPE,
            `@scope($1) to ([${GHOST_ATTRIBUTE}]) `,
        );
        if (limited === css) continue;
        originals.set(style, css);
        style.textContent = limited;
    }
    return () => {
        for (const [style, css] of originals) style.textContent = css;
    };
}

// Never painted on their own, but referenced by name from the elements that are, so
// they come along whole rather than being traced reference by reference.
const CARRIED_TAGS = new Set(["defs", "style"]);

// Cloning is depth-first and structure-preserving, so the clone's children line up with
// the original's by index and the two trees can be walked in lockstep. Returns whether
// anything under `clone` was worth keeping.
function prune(
    original: Element,
    clone: Element,
    keep: ReadonlySet<Element>,
): boolean {
    if (keep.has(original)) return true;
    if (CARRIED_TAGS.has(original.tagName)) return true;

    let kept = false;
    const originalChildren = Array.from(original.children);
    // Backwards, so removing a clone child does not shift the indices still to visit.
    for (let index = originalChildren.length - 1; index >= 0; index--) {
        const childClone = clone.children[index];
        if (!childClone) continue;
        if (prune(originalChildren[index], childClone, keep)) kept = true;
        else childClone.remove();
    }
    return kept;
}

/**
 * Build one ghost container from `outgoing`, retaining `keep` and their ancestors.
 *
 * The result is a nested `<svg>` for insertion into the *incoming* slide's tree, which
 * is what lets a ghost land at any depth in its paint order. It is still a genuine
 * slide root, so `@scope` matches it and `.layout-*` selectors reach through it, and it
 * establishes its own viewport with the outgoing viewBox, so ghost coordinates need no
 * compensating transform even between slides of different sizes.
 *
 * `carryDefinitions` belongs to the first layer only: `url(#…)` resolves against the
 * whole document rather than the nearest root, and a `<style>` inside inline SVG
 * contributes to the document stylesheet, so one copy serves every layer of the slide.
 * `rename` is decided once for the outgoing slide and passed to every layer, so a layer
 * carrying no definitions still points at the renamed ones.
 *
 * Returns null when nothing survives the prune, so callers do not have to special-case
 * an empty layer.
 */
export function buildGhostLayer(
    outgoing: SVGSVGElement,
    keep: ReadonlySet<Element>,
    {
        carryDefinitions,
        idPrefix,
        rename,
    }: {
        carryDefinitions: boolean;
        idPrefix: string;
        rename: ReadonlySet<string>;
    },
): SVGSVGElement | null {
    if (keep.size === 0) return null;
    const layer = outgoing.cloneNode(true) as SVGSVGElement;
    prune(outgoing, layer, keep);

    if (!carryDefinitions)
        for (const carried of layer.querySelectorAll("defs, style"))
            carried.remove();

    // A ghost is a fading snapshot, never a step target. Dropping the cues means the
    // step engine cannot reach into a layer at all, rather than it happening not to.
    for (const cued of layer.querySelectorAll("[data-cues]"))
        cued.removeAttribute("data-cues");

    // Fill the parent viewport rather than keeping the outgoing root's absolute size,
    // so the nested viewport letterboxes exactly as the outgoing slide did.
    layer.setAttribute("x", "0");
    layer.setAttribute("y", "0");
    layer.setAttribute("width", "100%");
    layer.setAttribute("height", "100%");
    markGhost(layer);

    renameIds(layer, idPrefix, rename);
    return layer;
}
