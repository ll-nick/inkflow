import type { AbsolutePose } from "../shared/morph-math";
import {
    buildCompensationMatrix,
    compensationScale,
    easeInOut,
    INTERPOLATED_ATTRIBUTES,
    interpolateAttribute,
    readInterpolatedAttributes,
} from "../shared/morph-math";
import type { TransitionData } from "../shared/types";

const stage = document.getElementById("stage")!;

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

// Each matched leaf morphs by its fully-resolved screen pose, interpolated against
// its parent's *static* transform (groups are never animated). Three geometry
// kinds: shapes via the bbox compensation matrix, text via its screen pose, lines
// via their endpoints. Colours/opacities interpolate for all of them.
interface CommonMorph {
    element: SVGGraphicsElement;
    fromAttributes: Record<string, string>;
    toAttributes: Record<string, string>;
}
interface BoxMorph extends CommonMorph {
    kind: "box";
    parentCTM: DOMMatrix;
    originalTransform: string;
    fromPose: AbsolutePose;
    toPose: AbsolutePose;
    fromLengths: Lengths;
    toLengths: Lengths;
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
    | { type: "exit"; element: SVGGraphicsElement };

type MorphKind = Morph["kind"];

// Snapshot of one before-swap leaf, plus its ancestor-id chain so it can be paired
// with a new leaf once the matched ids are known.
interface LeafSnapshot {
    kind: MorphKind;
    ancestorIds: string[]; // nearest-first, includes the leaf's own id if any
    fromAttributes: Record<string, string>;
    pose?: AbsolutePose;
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
}

// ── geometry capture ─────────────────────────────────────────────────────────

// All poses are measured in screen-pixel space via getScreenCTM(). Unlike
// getCTM() — whose reference frame ("nearest viewport") differs between a child
// (the root svg's viewBox space) and the root svg itself (its container) — every
// element's getScreenCTM() shares the same screen origin, so child and parent
// matrices compose: child.getScreenCTM() === parent.getScreenCTM() · ownTransform.
function captureAbsolutePose(element: SVGGraphicsElement): AbsolutePose {
    const boundingBox = element.getBBox();
    const currentMatrix = element.getScreenCTM()!;
    const topLeft = new DOMPoint(boundingBox.x, boundingBox.y).matrixTransform(
        currentMatrix,
    );
    const topRight = new DOMPoint(
        boundingBox.x + boundingBox.width,
        boundingBox.y,
    ).matrixTransform(currentMatrix);
    const bottomLeft = new DOMPoint(
        boundingBox.x,
        boundingBox.y + boundingBox.height,
    ).matrixTransform(currentMatrix);
    return {
        x: topLeft.x,
        y: topLeft.y,
        width: Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
        height: Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y),
        rotation: Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x),
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
    const ancestorIds = ancestorIdChain(element);
    const fromAttributes = readInterpolatedAttributes(element);
    if (element instanceof SVGLineElement)
        return {
            kind: "line",
            ancestorIds,
            fromAttributes,
            endpointsScreen: captureEndpointsScreen(element),
            strokeWidth: readLengthAttributes(element)["stroke-width"],
        };
    if (element instanceof SVGTextElement)
        return {
            kind: "text",
            ancestorIds,
            fromAttributes,
            textPose: captureTextScreenPose(element),
        };
    return {
        kind: "box",
        ancestorIds,
        fromAttributes,
        pose: captureAbsolutePose(element),
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
    return Array.from(svg.children).map((child) => ({
        element: child.cloneNode(true) as Element,
        html: child.outerHTML,
        ids: collectIds(child),
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

    if (snapshot.pose)
        return {
            kind: "box",
            element,
            fromAttributes,
            toAttributes,
            parentCTM: parentScreenCTM(element),
            originalTransform: element.getAttribute("transform") ?? "",
            fromPose: snapshot.pose,
            toPose: captureAbsolutePose(element),
            fromLengths: snapshot.lengths ?? {},
            toLengths: readLengthAttributes(element),
        };
    return null;
}

// Group before/after leaves by their nearest matched-id ancestor (their "scope"),
// then pair them by document order within each scope. A scope is a single leaf
// (its own id matched) or every leaf under a matched group.
function buildLeafMorphTasks(
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
    for (const [scope, newElements] of newByScope) {
        const oldList = oldByScope.get(scope);
        if (!oldList) continue;
        const count = Math.min(newElements.length, oldList.length);
        for (let i = 0; i < count; i++) {
            const morph = createLeafMorph(newElements[i], oldList[i]);
            if (!morph) continue;
            tickMorph(morph, 0); // seed the from-state before the first paint
            tasks.push({ type: "morph", morph });
        }
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
    const tasks: AnimationTask[] = [];

    for (const child of oldChildren) {
        if (containsMatchedId(child.ids, matchedIds)) continue;
        if (newHtml.has(child.html)) continue;
        const clone = child.element;
        if (!(clone instanceof SVGGraphicsElement)) continue;
        svgRoot.appendChild(clone);
        tasks.push({ type: "exit", element: clone });
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
        (child) => ({
            element: child,
            html: child.outerHTML,
            ids: collectIds(child),
        }),
    );

    return [
        ...buildLeafMorphTasks(svgRoot, oldLeaves, matchedIds),
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
            morph.element.setAttribute(
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
    const compensation = buildCompensationMatrix(
        morph.fromPose,
        morph.toPose,
        morph.parentCTM,
        easedProgress,
    );
    const prefix = compensation ? `${matrixToSvgTransform(compensation)} ` : "";
    morph.element.setAttribute(
        "transform",
        `${prefix}${morph.originalTransform}`.trim(),
    );

    const { x: csx, y: csy } = compensationScale(
        morph.fromPose,
        morph.toPose,
        easedProgress,
    );
    const uniformScale = Math.sqrt(Math.max(csx * csy, 1e-6));
    const lerp = (from: number, to: number) =>
        from + (to - from) * easedProgress;

    const rxFrom = morph.fromLengths.rx;
    const rxTo = morph.toLengths.rx;
    if (rxFrom !== undefined && rxTo !== undefined) {
        const ryFrom = morph.fromLengths.ry ?? rxFrom;
        const ryTo = morph.toLengths.ry ?? rxTo;
        morph.element.setAttribute("rx", String(lerp(rxFrom, rxTo) / csx));
        morph.element.setAttribute("ry", String(lerp(ryFrom, ryTo) / csy));
    }
    const swFrom = morph.fromLengths["stroke-width"];
    const swTo = morph.toLengths["stroke-width"];
    if (swFrom !== undefined && swTo !== undefined)
        morph.element.setAttribute(
            "stroke-width",
            String(lerp(swFrom, swTo) / uniformScale),
        );
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
            task.element.style.opacity = String(1 - exitProgress);
        }
    }
}

// ── finalize (snap to the new slide's natural state) ─────────────────────────

function finalizeMorph(morph: Morph): void {
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
        const toValue = morph.toAttributes[attribute];
        if (toValue !== undefined)
            morph.element.setAttribute(attribute, toValue);
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

function runMorphLoop(
    tasks: AnimationTask[],
    durationMs: number,
    then: (() => void) | null,
): void {
    const t0 = performance.now();
    function frame(now: number): void {
        const rawProgress = Math.min((now - t0) / durationMs, 1);
        tickTasks(tasks, rawProgress);
        if (rawProgress < 1) {
            requestAnimationFrame(frame);
            return;
        }
        finalizeTasks(tasks);
        if (then) then();
    }
    requestAnimationFrame(frame);
}

export function morphToNextSlide(
    swap: () => void,
    transition: TransitionData,
    then: (() => void) | null,
): void {
    const beforeSvg = stage.querySelector("svg");
    const oldLeaves: LeafSnapshotSet = beforeSvg
        ? snapshotLeaves(beforeSvg)
        : { ids: new Set(), leaves: [] };
    const oldChildren = beforeSvg ? snapshotTopLevelChildren(beforeSvg) : [];

    swap();
    const svgRoot = stage.querySelector("svg");
    if (!svgRoot) {
        if (then) then();
        return;
    }

    const tasks = buildTasks(svgRoot, oldLeaves, oldChildren);
    runMorphLoop(tasks, transition.duration * 1000, then);
}
