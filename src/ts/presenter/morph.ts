import type { AffineComponents } from "../shared/morph-math";
import {
    decomposeAffine,
    easeInOut,
    INTERPOLATED_ATTRIBUTES,
    interpolateAffine,
    interpolateAttribute,
    matrixScaleX,
    matrixScaleY,
    readInterpolatedAttributes,
} from "../shared/morph-math";
import type { Segment } from "../shared/path-data";
import {
    areCompatible,
    interpolateSegments,
    parsePathData,
    serializePathData,
    transformSegments,
} from "../shared/path-data";
import { referencedDefinitions } from "../shared/svg-refs";
import type { TransitionData } from "../shared/types";
import {
    buildGhostLayer,
    limitScopesToLiveContent,
    removeGhosts,
} from "./ghost-layer";
import { planGhostPlacement } from "./ghost-placement";
import { ProgressDriver } from "./progress-driver";

// Only leaf graphics are morphed; a <g> is never rendered as a thing, it just
// contributes a transform to its descendants. Groups exist for editing/matching,
// so we morph the visible leaves and treat each one independently.
const LEAF_SELECTOR =
    "rect, circle, ellipse, line, polyline, polygon, path, text, image, foreignObject";

// A definition subtree paints only where a url(#…) reference pulls it in, so its
// contents are not slide geometry and take no part in the morph. Blink lays out
// marker contents, so their leaves have a screen CTM and would otherwise pass every
// filter here. Inkscape reuses stock marker ids across files, so a shared
// marker#ConcaveTriangle opened a scope pairing the two slides' marker internals:
// the incoming arrowhead was driven by a morph transform, and an unpaired marker
// path was ghosted into the visible tree as a top-level child of the slide.
//
// `clipPath` keeps its SVG capitalisation on purpose: a type selector matches
// case-insensitively only for elements in the HTML namespace.
const DEFINITION_SUBTREE_SELECTOR =
    "defs, marker, symbol, clipPath, mask, pattern";

export function isDefinitionContent(element: Element): boolean {
    return element.closest(DEFINITION_SUBTREE_SELECTOR) !== null;
}

// Ids under `root` a morph may pair on, definition ids excluded so they never open
// a scope.
function pairableDescendantIds(root: Element): Set<string> {
    const ids = new Set<string>();
    for (const element of root.querySelectorAll("[id]"))
        if (!isDefinitionContent(element)) ids.add(element.id);
    return ids;
}

// As above plus `root`'s own id, since a top-level child is matched by it too.
export function collectPairableIds(root: Element): Set<string> {
    const ids = pairableDescendantIds(root);
    if (root.id && !isDefinitionContent(root)) ids.add(root.id);
    return ids;
}

// The leaves a morph may pair: renderable tags, outside any definition subtree, and
// laid out — a null screen CTM means no layout box, so there is no geometry to morph.
function pairableLeaves(root: Element): SVGGraphicsElement[] {
    return Array.from(
        root.querySelectorAll<SVGGraphicsElement>(LEAF_SELECTOR),
    ).filter(
        (element) =>
            !isDefinitionContent(element) && element.getScreenCTM() !== null,
    );
}

// Namespaces a ghost container's copied definitions. Without it a copy of the outgoing
// slide's `#ConcaveTriangle` would land first in the document and win for the incoming
// slide's arrows too.
const GHOST_ID_PREFIX = "morph-ghost-";

// Inline style properties a morph writes over. finalize restores exactly what the
// element had rather than removing them, because a blanket removal also drops
// declarations the *author* wrote: an arrow styled `fill:none;stroke:#b4befe` falls
// back to the SVG defaults of black fill and no stroke, and a <text> sized only by
// inline `font-size` collapses to the inherited size.
const MORPH_OWNED_STYLE_PROPERTIES = [
    ...INTERPOLATED_ATTRIBUTES,
    "stroke-width",
    "font-size",
    "transform-box",
    "transform-origin",
];

export function readInlineStyle(element: Element): Record<string, string> {
    const declarations: Record<string, string> = {};
    for (const property of MORPH_OWNED_STYLE_PROPERTIES) {
        const value = (element as SVGElement).style.getPropertyValue(property);
        if (value) declarations[property] = value;
    }
    return declarations;
}

export function restoreInlineStyle(
    element: Element,
    declarations: Record<string, string>,
): void {
    const style = (element as SVGElement).style;
    for (const property of MORPH_OWNED_STYLE_PROPERTIES) {
        const original = declarations[property];
        if (original) style.setProperty(property, original);
        else style.removeProperty(property);
    }
}

// Length attributes that must NOT inherit a non-uniform box scale: a rect
// stretched 2× wide should keep round (not oval) corners and even stroke. We morph
// the *visual* value and divide the current scale back out (rx by x, ry by y,
// stroke-width by the uniform mean).
const LENGTH_ATTRIBUTES = ["stroke-width", "rx", "ry"] as const;
type LengthName = (typeof LENGTH_ATTRIBUTES)[number];
type Lengths = Partial<Record<LengthName, number>>;

// Endpoints of a <line>, in the new element's own coordinate system.
type Endpoints = { x1: number; y1: number; x2: number; y2: number };

// Screen pose of a <text>. Text is morphed by position + rotation + font-size and
// never by a box scale, so glyphs never shear and line spacing is exact.
interface TextScreenPose {
    anchorX: number; // anchor (first x/y), in screen pixels
    anchorY: number;
    rotation: number; // radians
    scale: number; // uniform screen scale (viewBox→pixel and any source scale)
    fontSize: number; // px
}

// Each matched leaf morphs by its fully-resolved screen geometry, expressed
// relative to its parent's *static* transform (groups are never animated). Three
// geometry kinds: shapes via a full affine frame (unit square → screen), text via
// its screen pose, lines via their endpoints. Colours/opacities interpolate for all.
interface CommonMorph {
    element: SVGGraphicsElement;
    fromAttributes: Record<string, string>;
    toAttributes: Record<string, string>;
    originalInlineStyle: Record<string, string>;
}
// A box morph reconstructs the element's transform each frame as
// parent⁻¹ · M(p) · B_to⁻¹, where M(p) is the affine-interpolated frame, parent is
// the (static) parent screen CTM, and B_to maps the unit square to the new bbox.
interface BoxMorph extends CommonMorph {
    kind: "box";
    originalTransform: string;
    fromComp: AffineComponents;
    toComp: AffineComponents;
    parentInverse: DOMMatrix; // parent screen CTM, inverted
    bToInverse: DOMMatrix; // (unit square → new bbox), inverted
    fromLengths: Lengths;
    toLengths: Lengths;
    fromScreenScale: { x: number; y: number }; // old/new leaf local→screen scale,
    toScreenScale: { x: number; y: number }; // used to morph lengths in screen space
}
interface TextMorph extends CommonMorph {
    kind: "text";
    element: SVGTextElement;
    parentCTM: DOMMatrix;
    originalTransform: string;
    anchorLocalX: number;
    anchorLocalY: number;
    from: TextScreenPose;
    to: TextScreenPose;
}
interface LineMorph extends CommonMorph {
    kind: "line";
    element: SVGLineElement;
    from: Endpoints;
    to: Endpoints;
    fromStrokeWidth: number | undefined;
    toStrokeWidth: number | undefined;
}
// Interpolates `d` itself, so the outline bends rather than arriving whole on frame 0.
// Writes no transform, which is why markers stay correctly scaled and oriented.
interface PathMorph extends CommonMorph {
    kind: "path";
    element: SVGPathElement;
    from: Segment[]; // both already in the new element's own local space
    to: Segment[];
    originalPathData: string;
    fromStrokeWidth: number | undefined;
    toStrokeWidth: number | undefined;
}
type Morph = BoxMorph | TextMorph | LineMorph | PathMorph;

type AnimationTask =
    | { type: "morph"; morph: Morph }
    | { type: "fadeIn"; element: SVGGraphicsElement; targetOpacity: number }
    // A ghost container, faded as a whole. Group opacity multiplies, so an element with
    // an authored opacity still fades from its own value rather than from a hard 1.
    | { type: "exit"; element: SVGGraphicsElement; startOpacity: number };

// How two leaves are paired. Not `Morph["kind"]`: a path morph is chosen within the box
// case rather than being a pairing kind of its own.
type LeafKind = "box" | "text" | "line";

// Snapshot of one before-swap leaf, plus its ancestor-id chain so it can be paired
// with a new leaf once the matched ids are known.
interface LeafSnapshot {
    kind: LeafKind;
    ancestorIds: string[]; // nearest-first, includes the leaf's own id if any
    fromAttributes: Record<string, string>;
    // The outgoing element itself. It is detached once the new slide is swapped in, but
    // stays intact, and a ghost layer is pruned from a clone of the whole outgoing tree
    // rather than assembled from per-element copies.
    source: SVGGraphicsElement;
    frame?: AffineComponents; // box: decomposed unit-square→screen frame
    screenScale?: { x: number; y: number }; // box: local→screen per-axis scale
    lengths?: Lengths;
    textPose?: TextScreenPose;
    endpointsScreen?: Endpoints; // screen coords (line)
    pathScreen?: Segment[]; // box: normalized <path> geometry, in screen coords
    strokeWidth?: number; // line
}

interface LeafSnapshotSet {
    ids: Set<string>;
    leaves: LeafSnapshot[];
}

// A top-level child of the slide svg, captured for the unmatched-content
// crossfade: content that changes between slides fades, content that is
// byte-identical (static chrome) is left untouched so it never flickers.
interface ChildSnapshot {
    source: Element;
    html: string;
    ids: Set<string>;
}

// ── geometry capture ─────────────────────────────────────────────────────────

// Geometry is measured via getScreenCTM() rather than getCTM(). getCTM()'s
// reference frame depends on where the nearest SVG viewport is in the tree, so a
// child's getCTM() and the root's are not in the same space and cannot be
// directly compared. getScreenCTM() always uses the screen origin, so every
// element's frame is directly comparable regardless of nesting depth.
interface CapturedFrame {
    comp: AffineComponents;
    screenScale: { x: number; y: number };
    bbox: DOMRect;
}

// The affine map that takes the element's local unit square to the screen:
// screenCTM · translate(bbox) · scale(bbox). Decomposed once here so the morph
// loop only pays for recomposition. The per-axis screen scale is kept for length
// (rx/ry/stroke-width) morphing.
//
// getScreenCTM() returns a legacy SVGMatrix whose scale() is uniform-only — it
// keeps the first factor and silently drops the second (non-uniform scaling lived
// on the separate scaleNonUniform()). So calling scale(width, height) on it would
// square the box to width × width and leak the box's aspect ratio into the morph
// as a vertical stretch on any non-square element (e.g. a wide title or the footer
// logo; square shapes are unaffected, which is why it went unnoticed). Re-wrapping
// it in a real DOMMatrix makes scale(width, height) genuinely non-uniform.
function captureFrame(element: SVGGraphicsElement): CapturedFrame {
    const bbox = element.getBBox();
    const screenCTM = DOMMatrix.fromMatrix(element.getScreenCTM()!);
    const frame = screenCTM
        .translate(bbox.x, bbox.y)
        .scale(bbox.width, bbox.height);
    return {
        comp: decomposeAffine(frame),
        screenScale: { x: matrixScaleX(screenCTM), y: matrixScaleY(screenCTM) },
        bbox,
    };
}

// stroke-width comes from the computed style, not the attribute: authored SVGs commonly
// set it inline, where an attribute read missed it and the counter-scaling never ran.
// rx/ry stay attribute-only, which is where an editor writes them.
function readLengthAttributes(element: Element): Lengths {
    const lengths: Lengths = {};
    for (const name of ["rx", "ry"] as const) {
        const raw = element.getAttribute(name);
        if (raw === null) continue;
        const value = parseFloat(raw);
        if (Number.isFinite(value)) lengths[name] = value;
    }
    const strokeWidth = parseFloat(getComputedStyle(element).strokeWidth);
    if (Number.isFinite(strokeWidth)) lengths["stroke-width"] = strokeWidth;
    return lengths;
}

// Screen space, so it can be compared against a path on the other slide whose ancestors
// carry different transforms.
function screenPathSegments(element: SVGGraphicsElement): Segment[] | null {
    if (!(element instanceof SVGPathElement)) return null;
    const segments = parsePathData(element.getAttribute("d") ?? "");
    if (!segments) return null;
    return transformSegments(
        segments,
        element.getScreenCTM() ?? new DOMMatrix(),
    );
}

function readFontSize(node: SVGTextElement): number {
    const px = parseFloat(getComputedStyle(node).fontSize);
    return Number.isFinite(px) ? px : 0;
}

function textAnchorLocal(node: SVGTextElement): { x: number; y: number } {
    return {
        x:
            node.x.baseVal.numberOfItems > 0
                ? node.x.baseVal.getItem(0).value
                : 0,
        y:
            node.y.baseVal.numberOfItems > 0
                ? node.y.baseVal.getItem(0).value
                : 0,
    };
}

function captureTextScreenPose(node: SVGTextElement): TextScreenPose {
    const ctm = node.getScreenCTM() ?? new DOMMatrix();
    const anchor = textAnchorLocal(node);
    const screen = new DOMPoint(anchor.x, anchor.y).matrixTransform(ctm);
    return {
        anchorX: screen.x,
        anchorY: screen.y,
        rotation: Math.atan2(ctm.b, ctm.a),
        scale: Math.hypot(ctm.a, ctm.b) || 1,
        fontSize: readFontSize(node),
    };
}

function captureEndpointsScreen(node: SVGLineElement): Endpoints {
    const ctm = node.getScreenCTM() ?? new DOMMatrix();
    const p1 = new DOMPoint(
        node.x1.baseVal.value,
        node.y1.baseVal.value,
    ).matrixTransform(ctm);
    const p2 = new DOMPoint(
        node.x2.baseVal.value,
        node.y2.baseVal.value,
    ).matrixTransform(ctm);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

function leafKind(element: Element): LeafKind {
    if (element instanceof SVGLineElement) return "line";
    if (element instanceof SVGTextElement) return "text";
    return "box";
}

// The compensation transform is applied in the parent's local coordinate space so
// it composes correctly with the parent's own transform.
function parentScreenCTM(element: Element): DOMMatrix {
    const parent = element.parentElement;
    return parent instanceof SVGGraphicsElement
        ? (parent.getScreenCTM() ?? new DOMMatrix())
        : new DOMMatrix();
}

// ── snapshot (before swap) ───────────────────────────────────────────────────

function ancestorIdChain(element: Element): string[] {
    const ids: string[] = [];
    let current: Element | null = element;
    while (current) {
        if (current.id) ids.push(current.id);
        current = current.parentElement;
    }
    return ids;
}

function snapshotLeaf(element: SVGGraphicsElement): LeafSnapshot {
    // Captured once for every leaf so any of them can be reconstructed as a
    // fade-out ghost later, even those nested inside a matched group.
    const common = {
        ancestorIds: ancestorIdChain(element),
        fromAttributes: readInterpolatedAttributes(element),
        source: element,
    };
    if (element instanceof SVGLineElement)
        return {
            kind: "line",
            ...common,
            endpointsScreen: captureEndpointsScreen(element),
            strokeWidth: readLengthAttributes(element)["stroke-width"],
        };
    if (element instanceof SVGTextElement)
        return {
            kind: "text",
            ...common,
            textPose: captureTextScreenPose(element),
        };
    const captured = captureFrame(element);
    return {
        kind: "box",
        ...common,
        frame: captured.comp,
        screenScale: captured.screenScale,
        lengths: readLengthAttributes(element),
        pathScreen: screenPathSegments(element) ?? undefined,
    };
}

function snapshotLeaves(svg: Element): LeafSnapshotSet {
    return {
        ids: pairableDescendantIds(svg),
        leaves: pairableLeaves(svg).map(snapshotLeaf),
    };
}

function snapshotTopLevelChildren(svg: Element): ChildSnapshot[] {
    return Array.from(svg.children).map((child) => ({
        source: child,
        html: child.outerHTML,
        ids: collectPairableIds(child),
    }));
}

// ── task building ────────────────────────────────────────────────────────────

function nearestMatchedId(
    ancestorIds: string[],
    matchedIds: Set<string>,
): string | undefined {
    return ancestorIds.find((id) => matchedIds.has(id));
}

// Attributes that define an element's form beyond the box a morph animates.
const SHAPE_ATTRIBUTES: Record<string, readonly string[]> = {
    path: ["d"],
    polygon: ["points"],
    polyline: ["points"],
    image: ["href", "xlink:href"],
    use: ["href", "xlink:href"],
};

// An ellipse squeezed into a circle's box *is* that circle, so those two are one form.
// Every other tag stands alone.
const SHAPE_FAMILY: Record<string, string> = {
    circle: "ellipse",
    ellipse: "ellipse",
};

// A box morph animates position, scale, rotation and skew of the *destination* element,
// which reads as motion only if both are the same form to begin with: hand it a rect and
// a circle and the circle is on screen whole at frame 0. Nothing should snap during a
// morph, so a pair that fails this crossfades in place instead.
export function sameIntrinsicShape(from: Element, to: Element): boolean {
    const family = (element: Element) =>
        SHAPE_FAMILY[element.tagName] ?? element.tagName;
    if (family(from) !== family(to)) return false;
    return (SHAPE_ATTRIBUTES[to.tagName] ?? []).every(
        (attribute) =>
            from.getAttribute(attribute) === to.getAttribute(attribute),
    );
}

// Null when the pair cannot be interpolated segment by segment, and the caller falls
// back to the box morph.
function createPathMorph(
    element: SVGGraphicsElement,
    snapshot: LeafSnapshot,
    common: CommonMorph,
): PathMorph | null {
    if (!(element instanceof SVGPathElement) || !snapshot.pathScreen)
        return null;
    const originalPathData = element.getAttribute("d") ?? "";
    const to = parsePathData(originalPathData);
    if (!to || !areCompatible(snapshot.pathScreen, to)) return null;

    // Into the new element's local space, as the line morph does with its endpoints, so
    // every frame is a lerp and a write.
    const screenInverse = (element.getScreenCTM() ?? new DOMMatrix()).inverse();
    // A singular ancestor transform inverts to all-NaN rather than throwing.
    if (!Number.isFinite(screenInverse.a)) return null;

    return {
        ...common,
        kind: "path",
        element,
        from: transformSegments(snapshot.pathScreen, screenInverse),
        to,
        originalPathData,
        fromStrokeWidth: snapshot.lengths?.["stroke-width"],
        toStrokeWidth: readLengthAttributes(element)["stroke-width"],
    };
}

function createLeafMorph(
    element: SVGGraphicsElement,
    snapshot: LeafSnapshot,
): Morph | null {
    const kind = leafKind(element);
    if (kind !== snapshot.kind) return null; // structure changed; skip (will snap)
    const fromAttributes = snapshot.fromAttributes;
    const toAttributes = readInterpolatedAttributes(element);
    const originalInlineStyle = readInlineStyle(element);
    const common: CommonMorph = {
        element,
        fromAttributes,
        toAttributes,
        originalInlineStyle,
    };

    if (
        kind === "line" &&
        element instanceof SVGLineElement &&
        snapshot.endpointsScreen
    ) {
        // Convert the previous screen-space endpoints into the new line's own
        // (static) frame, then interpolate locally.
        const screenInverse = (
            element.getScreenCTM() ?? new DOMMatrix()
        ).inverse();
        const s = snapshot.endpointsScreen;
        const p1 = new DOMPoint(s.x1, s.y1).matrixTransform(screenInverse);
        const p2 = new DOMPoint(s.x2, s.y2).matrixTransform(screenInverse);
        return {
            kind: "line",
            ...common,
            element,
            from: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
            to: {
                x1: element.x1.baseVal.value,
                y1: element.y1.baseVal.value,
                x2: element.x2.baseVal.value,
                y2: element.y2.baseVal.value,
            },
            fromStrokeWidth: snapshot.strokeWidth,
            toStrokeWidth: readLengthAttributes(element)["stroke-width"],
        };
    }

    if (
        kind === "text" &&
        element instanceof SVGTextElement &&
        snapshot.textPose
    ) {
        // A text morph animates the pose, never the glyphs, so two different strings
        // would swap on frame 0.
        if (snapshot.source.textContent !== element.textContent) return null;
        const anchor = textAnchorLocal(element);
        return {
            kind: "text",
            ...common,
            element,
            parentCTM: parentScreenCTM(element),
            originalTransform: element.getAttribute("transform") ?? "",
            anchorLocalX: anchor.x,
            anchorLocalY: anchor.y,
            from: snapshot.textPose,
            to: captureTextScreenPose(element),
        };
    }

    // Before the box morph's zero-area guard: a straight arrow has no box frame at all,
    // but its two segments interpolate perfectly well.
    const pathMorph = createPathMorph(element, snapshot, common);
    if (pathMorph) return pathMorph;

    if (snapshot.frame && snapshot.screenScale) {
        const captured = captureFrame(element);
        // A zero-area new box has no invertible bbox frame; skip it (snaps).
        if (captured.bbox.width === 0 || captured.bbox.height === 0)
            return null;
        // A box whose inner content changed (a foreignObject title, injected
        // markdown) cannot be geometry-morphed: the box has no way to tween HTML,
        // so the new content would snap in at frame 0. Fall through to a crossfade
        // instead, fading the old content out and the new in. Boxes with identical
        // content (a plain shape, or an image moving across slides in an injected
        // zone) keep the geometry morph.
        if (snapshot.source.innerHTML !== element.innerHTML) return null;
        // Same reasoning one level out: a box morph moves a shape, it does not turn
        // one shape into another.
        if (!sameIntrinsicShape(snapshot.source, element)) return null;
        const bTo = new DOMMatrix()
            .translate(captured.bbox.x, captured.bbox.y)
            .scale(captured.bbox.width, captured.bbox.height);
        // The morph drives the `transform` attribute in SVG user space, about the
        // viewBox origin (0,0). Once that attribute maps to the CSS `transform`
        // property, `transform-box` and `transform-origin` apply to it — and the zoom
        // animation's `.anim-zoom-in`/`.anim-zoom-out` class sets both (`fill-box` +
        // `center`), which would re-base the morph matrix about the element's bbox
        // centre and offset it every frame (largest at frame 0, where the matrix is
        // furthest from identity). Pin the classic SVG reference frame inline for the
        // morph; being inline author style it outranks that class rule, and finalize
        // removes it to fall back. The animated scale is 1 here, so the class is
        // otherwise unchanged.
        element.style.setProperty("transform-box", "view-box");
        element.style.setProperty("transform-origin", "0 0");
        return {
            kind: "box",
            ...common,
            originalTransform: element.getAttribute("transform") ?? "",
            fromComp: snapshot.frame,
            toComp: captured.comp,
            parentInverse: parentScreenCTM(element).inverse(),
            bToInverse: bTo.inverse(),
            fromLengths: snapshot.lengths ?? {},
            toLengths: readLengthAttributes(element),
            fromScreenScale: snapshot.screenScale,
            toScreenScale: captured.screenScale,
        };
    }
    return null;
}

// Fade a new-only (or crossfaded) leaf in from transparent.
function buildLeafEnter(element: SVGGraphicsElement): AnimationTask {
    const target = parseFloat(element.getAttribute("opacity") ?? "1");
    element.style.opacity = "0";
    return {
        type: "fadeIn",
        element,
        targetOpacity: Number.isFinite(target) ? target : 1,
    };
}

// Pair before/after leaves by their nearest matched-id ancestor (their "scope"),
// in document order. A scope is a single leaf (its own id matched) or every leaf
// under a matched group. A matched pair tweens its geometry; a leaf with no
// counterpart crossfades, so labels removed from a group fade out (and fade back
// in on reverse) instead of vanishing.
function buildLeafTasks(
    svgRoot: SVGSVGElement,
    oldLeaves: LeafSnapshotSet,
    matchedIds: Set<string>,
    ghosts: Set<Element>,
): AnimationTask[] {
    const oldByScope = new Map<string, LeafSnapshot[]>();
    for (const leaf of oldLeaves.leaves) {
        const scope = nearestMatchedId(leaf.ancestorIds, matchedIds);
        if (!scope) continue;
        (oldByScope.get(scope) ?? oldByScope.set(scope, []).get(scope)!).push(
            leaf,
        );
    }

    const newByScope = new Map<string, SVGGraphicsElement[]>();
    for (const el of pairableLeaves(svgRoot)) {
        const scope = nearestMatchedId(ancestorIdChain(el), matchedIds);
        if (!scope) continue;
        (newByScope.get(scope) ?? newByScope.set(scope, []).get(scope)!).push(
            el,
        );
    }

    const tasks: AnimationTask[] = [];
    const scopes = new Set([...oldByScope.keys(), ...newByScope.keys()]);
    for (const scope of scopes) {
        const oldList = oldByScope.get(scope) ?? [];
        const newList = newByScope.get(scope) ?? [];
        const paired = Math.min(oldList.length, newList.length);
        for (let i = 0; i < paired; i++) {
            const snapshot = oldList[i];
            const element = newList[i];
            // Same kind → morph the geometry. A kind mismatch (or a failed morph
            // build) falls through to a crossfade.
            const morph =
                leafKind(element) === snapshot.kind
                    ? createLeafMorph(element, snapshot)
                    : null;
            if (morph) {
                tickMorph(morph, 0); // seed the from-state before the first paint
                tasks.push({ type: "morph", morph });
            } else {
                // Changed content with no geometric counterpart: crossfade.
                ghosts.add(snapshot.source);
                tasks.push(buildLeafEnter(element));
            }
        }
        for (let i = paired; i < oldList.length; i++)
            ghosts.add(oldList[i].source);
        for (let i = paired; i < newList.length; i++)
            tasks.push(buildLeafEnter(newList[i]));
    }
    return tasks;
}

function containsMatchedId(ids: Set<string>, matchedIds: Set<string>): boolean {
    for (const id of ids) if (matchedIds.has(id)) return true;
    return false;
}

// Definition/metadata nodes never paint, so crossfading them is invisible work.
// They also tend to carry slide-specific generated ids (defs5 vs defs6), so they
// would crossfade on every morph for no visual gain. (In SVG2 SVGDefsElement is an
// SVGGraphicsElement, so the instanceof guard below does not exclude them.)
const NON_RENDERING_TAGS = new Set([
    "defs",
    "style",
    "metadata",
    "title",
    "desc",
]);

// Crossfade unmatched content: old-only fades out, new-only fades in. A top-level
// child is skipped if it carries a matched id (its leaves morph) or is
// byte-identical across slides (static chrome — leaving it untouched avoids flicker).
function buildCrossfadeTasks(
    oldChildren: ChildSnapshot[],
    newChildren: ChildSnapshot[],
    matchedIds: Set<string>,
    ghosts: Set<Element>,
): AnimationTask[] {
    const oldHtml = new Set(oldChildren.map((child) => child.html));
    const newHtml = new Set(newChildren.map((child) => child.html));
    const tasks: AnimationTask[] = [];

    for (const child of oldChildren) {
        if (NON_RENDERING_TAGS.has(child.source.tagName)) continue;
        if (containsMatchedId(child.ids, matchedIds)) continue;
        if (newHtml.has(child.html)) continue;
        if (child.source instanceof SVGGraphicsElement)
            ghosts.add(child.source);
    }
    for (const child of newChildren) {
        if (NON_RENDERING_TAGS.has(child.source.tagName)) continue;
        if (containsMatchedId(child.ids, matchedIds)) continue;
        if (oldHtml.has(child.html)) continue;
        const element = child.source;
        if (!(element instanceof SVGGraphicsElement)) continue;
        element.style.opacity = "0";
        tasks.push({
            type: "fadeIn",
            element,
            targetOpacity: parseFloat(element.getAttribute("opacity") ?? "1"),
        });
    }
    return tasks;
}

// The union of every id under each top-level child that carries a matched id.
// Such a child is *not* crossfaded whole (buildCrossfadeTasks skips it), so its
// own unscoped leaves are the ones that need individual orphan handling.
function matchedContainingChildIds(
    children: ChildSnapshot[],
    matchedIds: Set<string>,
): Set<string> {
    const ids = new Set<string>();
    for (const child of children)
        if (containsMatchedId(child.ids, matchedIds))
            for (const id of child.ids) ids.add(id);
    return ids;
}

// Crossfade "orphan" leaves: leaves with no matched-ancestor scope that live
// inside a top-level child which *does* carry a matched id. Group ids are often
// auto-generated and offset between slides (animations g7–g12 vs morph g6–g11), so
// a label whose stable-id sibling shape matches can still sit in a group id that
// exists in only one slide. Such a leaf is paired by nobody (no scope) and skipped
// by the whole-child crossfade (its group holds a matched id), so without this it
// would snap in/out. Leaves byte-identical across slides are left untouched.
function buildOrphanTasks(
    svgRoot: SVGSVGElement,
    oldLeaves: LeafSnapshotSet,
    oldChildren: ChildSnapshot[],
    newChildren: ChildSnapshot[],
    matchedIds: Set<string>,
    ghosts: Set<Element>,
): AnimationTask[] {
    const oldScope = matchedContainingChildIds(oldChildren, matchedIds);
    const newScope = matchedContainingChildIds(newChildren, matchedIds);
    const isOrphan = (ancestorIds: string[], scope: Set<string>) =>
        !nearestMatchedId(ancestorIds, matchedIds) &&
        ancestorIds.some((id) => scope.has(id));

    const newLeaves = pairableLeaves(svgRoot);
    const oldHtml = new Set(oldLeaves.leaves.map((l) => l.source.outerHTML));
    const newHtml = new Set(newLeaves.map((el) => el.outerHTML));

    const tasks: AnimationTask[] = [];
    for (const leaf of oldLeaves.leaves)
        if (
            isOrphan(leaf.ancestorIds, oldScope) &&
            !newHtml.has(leaf.source.outerHTML)
        )
            ghosts.add(leaf.source);
    for (const el of newLeaves)
        if (
            isOrphan(ancestorIdChain(el), newScope) &&
            !oldHtml.has(el.outerHTML)
        )
            tasks.push(buildLeafEnter(el));
    return tasks;
}

// `ghosts` collects the *outgoing* elements that fade out. They are never re-rooted:
// the caller prunes a clone of the whole outgoing tree down to them, so each keeps the
// ancestors that carry its inherited paint, its custom properties and its coordinate
// space.
function buildTasks(
    svgRoot: SVGSVGElement,
    oldLeaves: LeafSnapshotSet,
    oldChildren: ChildSnapshot[],
    matchedIds: Set<string>,
): { tasks: AnimationTask[]; ghosts: Set<Element> } {
    const ghosts = new Set<Element>();

    // Snapshot the new top-level children before the morph loop mutates any
    // transforms, so identical-content detection compares pristine markup.
    const newChildren: ChildSnapshot[] = Array.from(svgRoot.children).map(
        (child) => ({
            source: child,
            html: child.outerHTML,
            ids: collectPairableIds(child),
        }),
    );

    // Orphans first: it reads new-leaf markup, so run it before buildLeafTasks
    // seeds morph transforms onto matched leaves.
    const orphanTasks = buildOrphanTasks(
        svgRoot,
        oldLeaves,
        oldChildren,
        newChildren,
        matchedIds,
        ghosts,
    );
    return {
        tasks: [
            ...buildLeafTasks(svgRoot, oldLeaves, matchedIds, ghosts),
            ...orphanTasks,
            ...buildCrossfadeTasks(
                oldChildren,
                newChildren,
                matchedIds,
                ghosts,
            ),
        ],
        ghosts,
    };
}

// ── per-frame application ────────────────────────────────────────────────────

function matrixToSvgTransform(m: DOMMatrix): string {
    return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
}

function applyColorAttributes(morph: Morph, easedProgress: number): void {
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
        const fromValue = morph.fromAttributes[attribute];
        const toValue = morph.toAttributes[attribute];
        if (fromValue !== undefined && toValue !== undefined)
            morph.element.style.setProperty(
                attribute,
                interpolateAttribute(
                    attribute,
                    fromValue,
                    toValue,
                    easedProgress,
                ),
            );
    }
}

function applyBox(morph: BoxMorph, easedProgress: number): void {
    const frame = interpolateAffine(
        morph.fromComp,
        morph.toComp,
        easedProgress,
    );
    // Element local→screen at this progress is frame · B_to⁻¹; the transform
    // attribute (which composes under the static parent) is parent⁻¹ · that, so
    // the element's natural rendering lands exactly on `frame`.
    const localToScreen = frame.multiply(morph.bToInverse);
    morph.element.setAttribute(
        "transform",
        matrixToSvgTransform(morph.parentInverse.multiply(localToScreen)),
    );

    // Shear-free per-axis scale that the element currently renders at, used to
    // divide the box stretch back out of the corner radius and stroke width.
    const curScaleX = matrixScaleX(localToScreen);
    const curScaleY = matrixScaleY(localToScreen);
    const lerp = (from: number, to: number) =>
        from + (to - from) * easedProgress;

    const rxFrom = morph.fromLengths.rx;
    const rxTo = morph.toLengths.rx;
    if (rxFrom !== undefined && rxTo !== undefined) {
        const ryFrom = morph.fromLengths.ry ?? rxFrom;
        const ryTo = morph.toLengths.ry ?? rxTo;
        // Interpolate the radius in screen space (attribute × that leaf's own
        // local→screen scale), then convert back through the current scale. The
        // corner therefore tracks its visual from→to value and stays circular,
        // never inheriting the box's or the parent's scale.
        const rxScreen = lerp(
            rxFrom * morph.fromScreenScale.x,
            rxTo * morph.toScreenScale.x,
        );
        const ryScreen = lerp(
            ryFrom * morph.fromScreenScale.y,
            ryTo * morph.toScreenScale.y,
        );
        morph.element.setAttribute("rx", String(rxScreen / curScaleX));
        morph.element.setAttribute("ry", String(ryScreen / curScaleY));
    }
    const swFrom = morph.fromLengths["stroke-width"];
    const swTo = morph.toLengths["stroke-width"];
    if (swFrom !== undefined && swTo !== undefined) {
        const fromUniform = Math.sqrt(
            morph.fromScreenScale.x * morph.fromScreenScale.y,
        );
        const toUniform = Math.sqrt(
            morph.toScreenScale.x * morph.toScreenScale.y,
        );
        const curUniform = Math.sqrt(Math.max(curScaleX * curScaleY, 1e-6));
        const swScreen = lerp(swFrom * fromUniform, swTo * toUniform);
        morph.element.setAttribute(
            "stroke-width",
            String(swScreen / curUniform),
        );
    }
}

// Place text at its interpolated screen pose, independent of any box scale.
// Position/rotation/uniform-scale go into the transform (relative to the parent's
// static frame); size goes into font-size. Uniform ⇒ never sheared; reproduces the
// previous pose exactly at progress 0 ⇒ no spacing jump.
function applyText(morph: TextMorph, easedProgress: number): void {
    const lerp = (from: number, to: number) =>
        from + (to - from) * easedProgress;
    const target = new DOMMatrix()
        .translate(
            lerp(morph.from.anchorX, morph.to.anchorX),
            lerp(morph.from.anchorY, morph.to.anchorY),
        )
        .rotate((lerp(morph.from.rotation, morph.to.rotation) * 180) / Math.PI)
        .scale(lerp(morph.from.scale, morph.to.scale))
        .translate(-morph.anchorLocalX, -morph.anchorLocalY);
    const local = morph.parentCTM.inverse().multiply(target);
    morph.element.setAttribute("transform", matrixToSvgTransform(local));
    morph.element.style.fontSize = `${lerp(morph.from.fontSize, morph.to.fontSize)}px`;
}

// No transform is applied, so the width interpolates directly. Written to the inline
// style, since an authored inline value would outrank the attribute.
function applyStrokeWidth(
    element: SVGGraphicsElement,
    from: number | undefined,
    to: number | undefined,
    easedProgress: number,
): void {
    if (from === undefined || to === undefined) return;
    element.style.setProperty(
        "stroke-width",
        String(from + (to - from) * easedProgress),
    );
}

function applyPath(morph: PathMorph, easedProgress: number): void {
    morph.element.setAttribute(
        "d",
        serializePathData(
            interpolateSegments(morph.from, morph.to, easedProgress),
        ),
    );
    applyStrokeWidth(
        morph.element,
        morph.fromStrokeWidth,
        morph.toStrokeWidth,
        easedProgress,
    );
}

function applyLine(morph: LineMorph, easedProgress: number): void {
    const lerp = (from: number, to: number) =>
        from + (to - from) * easedProgress;
    const element = morph.element;
    element.setAttribute("x1", String(lerp(morph.from.x1, morph.to.x1)));
    element.setAttribute("y1", String(lerp(morph.from.y1, morph.to.y1)));
    element.setAttribute("x2", String(lerp(morph.from.x2, morph.to.x2)));
    element.setAttribute("y2", String(lerp(morph.from.y2, morph.to.y2)));
    applyStrokeWidth(
        element,
        morph.fromStrokeWidth,
        morph.toStrokeWidth,
        easedProgress,
    );
}

function tickMorph(morph: Morph, easedProgress: number): void {
    if (morph.kind === "box") applyBox(morph, easedProgress);
    else if (morph.kind === "text") applyText(morph, easedProgress);
    else if (morph.kind === "path") applyPath(morph, easedProgress);
    else applyLine(morph, easedProgress);
    applyColorAttributes(morph, easedProgress);
}

function tickTasks(tasks: AnimationTask[], rawProgress: number): void {
    const easedProgress = easeInOut(rawProgress);
    for (const task of tasks) {
        if (task.type === "morph") {
            tickMorph(task.morph, easedProgress);
        } else if (task.type === "fadeIn") {
            const fadeProgress = easeInOut(
                Math.max(0, Math.min((rawProgress - 0.3) / 0.7, 1)),
            );
            task.element.style.opacity = String(
                fadeProgress * task.targetOpacity,
            );
        } else {
            const exitProgress = easeInOut(Math.min(rawProgress / 0.7, 1));
            task.element.style.opacity = String(
                task.startOpacity * (1 - exitProgress),
            );
        }
    }
}

// ── finalize (snap to the new slide's natural state) ─────────────────────────

function finalizeMorph(morph: Morph): void {
    // Put back the element's own inline declarations. This also releases the
    // reference-frame pin (transform-box / transform-origin) that applyBox sets, so an
    // animation class's own values govern the element again if it later animates.
    restoreInlineStyle(morph.element, morph.originalInlineStyle);

    // Neither of these restores stroke-width: they only wrote it inline, and
    // restoreInlineStyle has already put the authored value back.
    if (morph.kind === "path") {
        // The authored string, not a re-serialization, so the element ends the morph
        // byte-identical to how the slide declared it.
        morph.element.setAttribute("d", morph.originalPathData);
        return;
    }

    if (morph.kind === "line") {
        morph.element.setAttribute("x1", String(morph.to.x1));
        morph.element.setAttribute("y1", String(morph.to.y1));
        morph.element.setAttribute("x2", String(morph.to.x2));
        morph.element.setAttribute("y2", String(morph.to.y2));
        return;
    }

    if (morph.kind === "text") {
        if (morph.originalTransform)
            morph.element.setAttribute("transform", morph.originalTransform);
        else morph.element.removeAttribute("transform");
        return;
    }

    if (morph.originalTransform)
        morph.element.setAttribute("transform", morph.originalTransform);
    else morph.element.removeAttribute("transform");
    // Restore the new slide's natural lengths; drop ry if we only added it to hold
    // the corner uniform (the new element had none of its own).
    if (morph.toLengths.rx !== undefined)
        morph.element.setAttribute("rx", String(morph.toLengths.rx));
    if (morph.toLengths.ry !== undefined)
        morph.element.setAttribute("ry", String(morph.toLengths.ry));
    else if (morph.fromLengths.rx !== undefined)
        morph.element.removeAttribute("ry");
}

function finalizeTasks(tasks: AnimationTask[]): void {
    for (const task of tasks) {
        if (task.type === "morph") finalizeMorph(task.morph);
        else if (task.type === "exit") task.element.remove();
        else {
            // Clear the fade-in opacity, then drop a now-empty style attribute.
            // The crossfade decides a child is unchanged chrome by exact outerHTML
            // equality; a leftover style="" would make a pristine element fail that
            // check on the next navigation, so unchanged content (the background
            // group, defs) would crossfade — and each crossfade leaves another
            // style="", perpetuating the flicker. Restoring the byte-identical
            // markup keeps the equality check honest.
            task.element.style.opacity = "";
            if (task.element.getAttribute("style") === "")
                task.element.removeAttribute("style");
        }
    }
}

// MorphTransition implements the Transition interface from transitions.ts using
// structural typing — no import needed since TypeScript checks compatibility at
// the registerTransition() call site.
export class MorphTransition {
    private oldLeaves: LeafSnapshotSet = { ids: new Set(), leaves: [] };
    private oldChildren: ChildSnapshot[] = [];
    private tasks: AnimationTask[] = [];
    private readonly driver = new ProgressDriver();
    private stage!: HTMLElement;
    private oldHtml = "";
    // The outgoing <svg> itself. Detached once the new slide is swapped in, but intact,
    // and every ghost layer is a pruned clone of it.
    private oldSvg: SVGSVGElement | null = null;
    private restoreScopes: (() => void) | null = null;

    // Snapshot the outgoing slide before swap() replaces the DOM, and keep its
    // markup so a full reversal can restore the real previous slide.
    prepare({ stage }: { stage: HTMLElement }): void {
        this.stage = stage;
        // Drop anything a previous morph failed to clean up, before reading the
        // outgoing DOM. prepare() runs before the framework swaps the new slide in, so
        // a survivor would otherwise be captured into oldHtml and snapshotted as
        // outgoing content.
        removeGhosts(stage);
        this.oldHtml = stage.innerHTML;
        const beforeSvg = stage.querySelector("svg") as SVGSVGElement | null;
        this.oldSvg = beforeSvg;
        this.oldLeaves = beforeSvg
            ? snapshotLeaves(beforeSvg)
            : { ids: new Set(), leaves: [] };
        this.oldChildren = beforeSvg ? snapshotTopLevelChildren(beforeSvg) : [];
    }

    async start({
        stage,
        params,
        signal,
    }: {
        stage: HTMLElement;
        params: TransitionData;
        signal: AbortSignal;
    }): Promise<void> {
        if (params.duration <= 0) return;

        const svgRoot = stage.querySelector("svg") as SVGSVGElement | null;
        if (!svgRoot) return;

        const newIds = collectPairableIds(svgRoot);
        const matchedIds = new Set<string>();
        for (const id of this.oldLeaves.ids)
            if (newIds.has(id)) matchedIds.add(id);

        const { tasks, ghosts } = buildTasks(
            svgRoot,
            this.oldLeaves,
            this.oldChildren,
            matchedIds,
        );
        this.tasks = [...tasks, ...this.layGhosts(svgRoot, ghosts, matchedIds)];
        await this.driver.animateTo(1, params.duration, signal, (progress) =>
            tickTasks(this.tasks, progress),
        );
        if (!signal.aborted) this.settle();
    }

    // Reverse direction mid-flight by retargeting the progress: the same tasks run
    // backward, so every property retraces its exact path. No re-snapshot of the
    // intermediate DOM, hence no colour or corner-radius jump and no crossfade
    // darkening across repeated reversals.
    async reverse({
        params,
        signal,
    }: {
        stage: HTMLElement;
        params: TransitionData;
        signal: AbortSignal;
    }): Promise<void> {
        const target = this.driver.heading === 1 ? 0 : 1;
        await this.driver.animateTo(
            target,
            params.duration,
            signal,
            (progress) => tickTasks(this.tasks, progress),
        );
        if (!signal.aborted) this.settle();
    }

    cancel({ stage }: { stage: HTMLElement; params: TransitionData }): void {
        // Superseded by a non-reverse transition; the framework swaps the new slide
        // in next, so just take the containers back out. Done by selector rather than
        // walked from this.tasks, which is empty when the build threw.
        this.releaseScopes();
        removeGhosts(stage);
    }

    // Nest one container per insertion point into the incoming slide's own tree, so a
    // ghost lands where it sat relative to the elements that survive rather than
    // wholly above or below everything.
    private layGhosts(
        svgRoot: SVGSVGElement,
        ghosts: Set<Element>,
        matchedIds: Set<string>,
    ): AnimationTask[] {
        const outgoing = this.oldSvg;
        if (!outgoing || ghosts.size === 0) return [];
        const rename = referencedDefinitions(outgoing);
        this.restoreScopes = limitScopesToLiveContent(svgRoot);

        const tasks: AnimationTask[] = [];
        let carryDefinitions = true;
        for (const group of planGhostPlacement(
            outgoing,
            svgRoot,
            ghosts,
            matchedIds,
        )) {
            const container = buildGhostLayer(outgoing, new Set(group.ghosts), {
                carryDefinitions,
                idPrefix: GHOST_ID_PREFIX,
                rename,
            });
            if (!container) continue;
            carryDefinitions = false;
            svgRoot.insertBefore(container, group.before);
            tasks.push({ type: "exit", element: container, startOpacity: 1 });
        }
        return tasks;
    }

    private releaseScopes(): void {
        this.restoreScopes?.();
        this.restoreScopes = null;
    }

    // progress 1 → the new slide is fully formed; snap it to its natural state.
    // progress 0 → reversed all the way back; the morphed elements only *look* like
    // the previous slide, so restore the real one.
    private settle(): void {
        if (this.driver.value >= 1) finalizeTasks(this.tasks);
        else this.stage.innerHTML = this.oldHtml;
        // Backstop: finalizeTasks removes the containers it knows about, this catches
        // any the task list never learned of.
        this.releaseScopes();
        removeGhosts(this.stage);
    }
}
