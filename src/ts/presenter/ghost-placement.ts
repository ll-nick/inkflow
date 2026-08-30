// Where a ghost belongs in the incoming slide's paint order.
//
// Matched elements are the only things that exist in both slides, so they are the
// shared landmarks. A ghost sat somewhere relative to them on the way out, and that
// relative position transfers: the label that sat just before #straight belongs just
// before #straight on the incoming slide too. No element is ever classified as "a
// background", and nothing depends on the two slides having comparable structure.

/** Ghosts that share one insertion point, in outgoing paint order. */
export interface GhostGroup {
    /** The incoming top-level child to insert before, or null for "append last". */
    before: Element | null;
    ghosts: Element[];
}

// Paint order is document order, so one walk ranks everything.
function documentOrder(root: Element): Map<Element, number> {
    const order = new Map<Element, number>([[root, 0]]);
    let rank = 1;
    for (const element of root.querySelectorAll("*"))
        order.set(element, rank++);
    return order;
}

// Placement is at top-level granularity: a ghost goes before the top-level child that
// holds its anchor, never beside the anchor itself, since a deeper insertion would make
// the ghost inherit that group's transform and paint.
function topLevelAncestor(root: Element, element: Element): Element | null {
    let current: Element | null = element;
    while (current && current.parentElement !== root)
        current = current.parentElement;
    return current;
}

/**
 * Group `ghosts` by the incoming element they should be inserted before.
 *
 * Each ghost is anchored to the first matched element that followed it on the outgoing
 * slide, which is the landmark it sat *under*. Ghosts with no matched element after
 * them were on top of everything that survives, so they append last.
 */
export function planGhostPlacement(
    outgoing: Element,
    incoming: Element,
    ghosts: ReadonlySet<Element>,
    matchedIds: ReadonlySet<string>,
): GhostGroup[] {
    const order = documentOrder(outgoing);
    const anchors = [...order.entries()]
        .filter(([element]) => element.id && matchedIds.has(element.id))
        .sort((a, b) => a[1] - b[1]);

    // Incoming counterparts, looked up once. An anchor whose id the incoming slide does
    // not surface as a top-level subtree cannot place anything, so it is skipped.
    const insertionPoint = new Map<string, Element | null>();
    for (const [element] of anchors) {
        const counterpart = incoming.querySelector(
            `[id="${CSS.escape(element.id)}"]`,
        );
        insertionPoint.set(
            element.id,
            counterpart ? topLevelAncestor(incoming, counterpart) : null,
        );
    }

    const byAnchor = new Map<Element | null, Element[]>();
    for (const ghost of [...ghosts].sort(
        (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
    )) {
        const rank = order.get(ghost) ?? 0;
        const anchor = anchors.find(([, anchorRank]) => anchorRank > rank);
        const before = anchor
            ? (insertionPoint.get(anchor[0].id) ?? null)
            : null;
        const group = byAnchor.get(before);
        if (group) group.push(ghost);
        else byAnchor.set(before, [ghost]);
    }

    return [...byAnchor.entries()].map(([before, groupGhosts]) => ({
        before,
        ghosts: groupGhosts,
    }));
}
