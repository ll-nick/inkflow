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
import type { TransitionData } from "../shared/types";
import { ProgressDriver } from "./progress-driver";

// Only leaf graphics are morphed; a <g> is never rendered as a thing, it just
// contributes a transform to its descendants. Groups exist for editing/matching,
// so we morph the visible leaves and treat each one independently.
const LEAF_SELECTOR =
    "rect, circle, ellipse, line, polyline, polygon, path, text, image, foreignObject";

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
type Morph = BoxMorph | TextMorph | LineMorph;

type AnimationTask =
    | { type: "morph"; morph: Morph }
    | { type: "fadeIn"; element: SVGGraphicsElement; targetOpacity: number }
    | { type: "exit"; element: SVGGraphicsElement; startOpacity: number };

type MorphKind = Morph["kind"];

// Snapshot of one before-swap leaf, plus its ancestor-id chain so it can be paired
// with a new leaf once the matched ids are known.
interface LeafSnapshot {
    kind: MorphKind;
    ancestorIds: string[]; // nearest-first, includes the leaf's own id if any
    fromAttributes: Record<string, string>;
    clone: SVGGraphicsElement; // detached deep clone, re-rooted as an exit ghost
    screenCTM: DOMMatrix; // old screen CTM, to place the ghost under the new root
    frame?: AffineComponents; // box: decomposed unit-square→screen frame
    screenScale?: { x: number; y: number }; // box: local→screen per-axis scale
    lengths?: Lengths;
    textPose?: TextScreenPose;
    endpointsScreen?: Endpoints; // screen coords (line)
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
    element: Element;
    html: string;
    ids: Set<string>;
    index: number; // original sibling position, used to keep exit ghosts in z-order
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

function readLengthAttributes(element: Element): Lengths {
    const lengths: Lengths = {};
    for (const name of LENGTH_ATTRIBUTES) {
        const raw = element.getAttribute(name);
        if (raw === null) continue;
        const value = parseFloat(raw);
        if (Number.isFinite(value)) lengths[name] = value;
    }
    return lengths;
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

function leafKind(element: Element): MorphKind {
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
        clone: element.cloneNode(true) as SVGGraphicsElement,
        screenCTM: element.getScreenCTM() ?? new DOMMatrix(),
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
    };
}

function snapshotLeaves(svg: Element): LeafSnapshotSet {
    const ids = new Set<string>();
    for (const el of svg.querySelectorAll("[id]")) ids.add(el.id);
    const leaves: LeafSnapshot[] = [];
    for (const el of svg.querySelectorAll<SVGGraphicsElement>(LEAF_SELECTOR)) {
        if (!el.getScreenCTM()) continue;
        leaves.push(snapshotLeaf(el));
    }
    return { ids, leaves };
}

function collectIds(root: Element): Set<string> {
    const ids = new Set<string>();
    if (root.id) ids.add(root.id);
    for (const element of root.querySelectorAll("[id]")) ids.add(element.id);
    return ids;
}

function snapshotTopLevelChildren(svg: Element): ChildSnapshot[] {
    return Array.from(svg.children).map((child, index) => ({
        element: child.cloneNode(true) as Element,
        html: child.outerHTML,
        ids: collectIds(child),
        index,
    }));
}

// ── task building ────────────────────────────────────────────────────────────

function nearestMatchedId(
    ancestorIds: string[],
    matchedIds: Set<string>,
): string | undefined {
    return ancestorIds.find((id) => matchedIds.has(id));
}

function createLeafMorph(
    element: SVGGraphicsElement,
    snapshot: LeafSnapshot,
): Morph | null {
    const kind = leafKind(element);
    if (kind !== snapshot.kind) return null; // structure changed; skip (will snap)
    const fromAttributes = snapshot.fromAttributes;
    const toAttributes = readInterpolatedAttributes(element);

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
            element,
            fromAttributes,
            toAttributes,
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
        const anchor = textAnchorLocal(element);
        return {
            kind: "text",
            element,
            fromAttributes,
            toAttributes,
            parentCTM: parentScreenCTM(element),
            originalTransform: element.getAttribute("transform") ?? "",
            anchorLocalX: anchor.x,
            anchorLocalY: anchor.y,
            from: snapshot.textPose,
            to: captureTextScreenPose(element),
        };
    }

    if (snapshot.frame && snapshot.screenScale) {
        const captured = captureFrame(element);
        // A zero-area new box has no invertible bbox frame; skip it (snaps).
        if (captured.bbox.width === 0 || captured.bbox.height === 0)
            return null;
        const bTo = new DOMMatrix()
            .translate(captured.bbox.x, captured.bbox.y)
            .scale(captured.bbox.width, captured.bbox.height);
        return {
            kind: "box",
            element,
            fromAttributes,
            toAttributes,
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

// Re-root an old leaf's clone under the new svg and fade it out from where it was.
// The captured screen CTM already folds in the leaf's own and ancestor transforms,
// so (new root)⁻¹ · screenCTM, set as the ghost's transform, reproduces its old
// screen position regardless of how deeply it was nested.
function buildLeafExit(
    snapshot: LeafSnapshot,
    svgRoot: SVGSVGElement,
): AnimationTask {
    const ghost = snapshot.clone;
    const placement = (svgRoot.getScreenCTM() ?? new DOMMatrix())
        .inverse()
        .multiply(snapshot.screenCTM);
    ghost.setAttribute("transform", matrixToSvgTransform(placement));
    svgRoot.appendChild(ghost);
    const startOpacity = parseFloat(snapshot.fromAttributes.opacity ?? "1");
    return {
        type: "exit",
        element: ghost,
        startOpacity: Number.isFinite(startOpacity) ? startOpacity : 1,
    };
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
    for (const el of svgRoot.querySelectorAll<SVGGraphicsElement>(
        LEAF_SELECTOR,
    )) {
        if (!el.getScreenCTM()) continue;
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
                tasks.push(buildLeafExit(snapshot, svgRoot));
                tasks.push(buildLeafEnter(element));
            }
        }
        for (let i = paired; i < oldList.length; i++)
            tasks.push(buildLeafExit(oldList[i], svgRoot));
        for (let i = paired; i < newList.length; i++)
            tasks.push(buildLeafEnter(newList[i]));
    }
    return tasks;
}

function containsMatchedId(ids: Set<string>, matchedIds: Set<string>): boolean {
    for (const id of ids) if (matchedIds.has(id)) return true;
    return false;
}

// Crossfade unmatched content: old-only fades out, new-only fades in. A top-level
// child is skipped if it carries a matched id (its leaves morph) or is
// byte-identical across slides (static chrome — leaving it untouched avoids flicker).
function buildCrossfadeTasks(
    svgRoot: SVGSVGElement,
    oldChildren: ChildSnapshot[],
    newChildren: ChildSnapshot[],
    matchedIds: Set<string>,
): AnimationTask[] {
    const oldHtml = new Set(oldChildren.map((child) => child.html));
    const newHtml = new Set(newChildren.map((child) => child.html));
    // The new slide's own children, captured before any exit ghost is spliced in,
    // so each ghost can be placed at its original sibling index and keep its depth.
    const newChildElements = Array.from(svgRoot.children);
    const tasks: AnimationTask[] = [];

    for (const child of oldChildren) {
        if (containsMatchedId(child.ids, matchedIds)) continue;
        if (newHtml.has(child.html)) continue;
        const clone = child.element;
        if (!(clone instanceof SVGGraphicsElement)) continue;
        // Insert at the element's original depth rather than on top, so an exiting
        // background fades out behind the new content instead of covering it (which
        // would make the persisting content flash away and back).
        svgRoot.insertBefore(clone, newChildElements[child.index] ?? null);
        // Fade from the element's current opacity, not a hard 1: when a morph is
        // reversed mid-flight the snapshotted element is already partly faded, and
        // snapping it back to full opacity would flash.
        const startOpacity = parseFloat(
            clone.style.opacity || clone.getAttribute("opacity") || "1",
        );
        tasks.push({
            type: "exit",
            element: clone,
            startOpacity: Number.isFinite(startOpacity) ? startOpacity : 1,
        });
    }
    for (const child of newChildren) {
        if (containsMatchedId(child.ids, matchedIds)) continue;
        if (oldHtml.has(child.html)) continue;
        const element = child.element;
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

function buildTasks(
    svgRoot: SVGSVGElement,
    oldLeaves: LeafSnapshotSet,
    oldChildren: ChildSnapshot[],
): AnimationTask[] {
    const newIds = collectIds(svgRoot);
    const matchedIds = new Set<string>();
    for (const id of oldLeaves.ids) if (newIds.has(id)) matchedIds.add(id);

    // Snapshot the new top-level children before the morph loop mutates any
    // transforms, so identical-content detection compares pristine markup.
    const newChildren: ChildSnapshot[] = Array.from(svgRoot.children).map(
        (child, index) => ({
            element: child,
            html: child.outerHTML,
            ids: collectIds(child),
            index,
        }),
    );

    return [
        ...buildLeafTasks(svgRoot, oldLeaves, matchedIds),
        ...buildCrossfadeTasks(svgRoot, oldChildren, newChildren, matchedIds),
    ];
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

function applyLine(morph: LineMorph, easedProgress: number): void {
    const lerp = (from: number, to: number) =>
        from + (to - from) * easedProgress;
    const element = morph.element;
    element.setAttribute("x1", String(lerp(morph.from.x1, morph.to.x1)));
    element.setAttribute("y1", String(lerp(morph.from.y1, morph.to.y1)));
    element.setAttribute("x2", String(lerp(morph.from.x2, morph.to.x2)));
    element.setAttribute("y2", String(lerp(morph.from.y2, morph.to.y2)));
    if (
        morph.fromStrokeWidth !== undefined &&
        morph.toStrokeWidth !== undefined
    )
        element.setAttribute(
            "stroke-width",
            String(lerp(morph.fromStrokeWidth, morph.toStrokeWidth)),
        );
}

function tickMorph(morph: Morph, easedProgress: number): void {
    if (morph.kind === "box") applyBox(morph, easedProgress);
    else if (morph.kind === "text") applyText(morph, easedProgress);
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
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
        morph.element.style.removeProperty(attribute);
    }

    if (morph.kind === "line") {
        morph.element.setAttribute("x1", String(morph.to.x1));
        morph.element.setAttribute("y1", String(morph.to.y1));
        morph.element.setAttribute("x2", String(morph.to.x2));
        morph.element.setAttribute("y2", String(morph.to.y2));
        if (morph.toStrokeWidth !== undefined)
            morph.element.setAttribute(
                "stroke-width",
                String(morph.toStrokeWidth),
            );
        return;
    }

    if (morph.kind === "text") {
        if (morph.originalTransform)
            morph.element.setAttribute("transform", morph.originalTransform);
        else morph.element.removeAttribute("transform");
        morph.element.style.fontSize = "";
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
    if (morph.toLengths["stroke-width"] !== undefined)
        morph.element.setAttribute(
            "stroke-width",
            String(morph.toLengths["stroke-width"]),
        );
}

function finalizeTasks(tasks: AnimationTask[]): void {
    for (const task of tasks) {
        if (task.type === "morph") finalizeMorph(task.morph);
        else if (task.type === "exit") task.element.remove();
        else task.element.style.opacity = "";
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

    // Snapshot the outgoing slide before swap() replaces the DOM, and keep its
    // markup so a full reversal can restore the real previous slide.
    prepare({ stage }: { stage: HTMLElement }): void {
        this.stage = stage;
        this.oldHtml = stage.innerHTML;
        const beforeSvg = stage.querySelector("svg");
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

        this.tasks = buildTasks(svgRoot, this.oldLeaves, this.oldChildren);
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

    cancel(_ctx: { stage: HTMLElement; params: TransitionData }): void {
        // Superseded by a non-reverse transition; the framework swaps the new slide
        // in next, so just remove the reconstructed exit ghosts.
        for (const task of this.tasks)
            if (task.type === "exit") task.element.remove();
    }

    // progress 1 → the new slide is fully formed; snap it to its natural state.
    // progress 0 → reversed all the way back; the morphed elements only *look* like
    // the previous slide, so restore the real one.
    private settle(): void {
        if (this.driver.value >= 1) finalizeTasks(this.tasks);
        else this.stage.innerHTML = this.oldHtml;
    }
}
