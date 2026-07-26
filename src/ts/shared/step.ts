import { buildKeyframes } from "./keyframes";

// The step engine. Every animated element carries a `data-cues` JSON array (written by
// pipeline.py). Each cue becomes one Web Animations API animation, and the engine drives
// those animations by step: enters reveal, exits hide, emphasis pulses. Because each cue
// is its own animation, an element can enter, be emphasized, and exit at different steps,
// reverse is a real backward play (a true time-mirror), and per-cue params never collide.

interface CueOpts {
    duration: number; // seconds
    delay: number; // seconds
    easing: string;
    iterations?: number;
}

interface CueData {
    step: number;
    kind: "enter" | "exit" | "emphasis";
    name: string;
    opts: CueOpts;
    vars: Record<string, string>;
}

interface CueState {
    cue: CueData;
    anim: Animation | null; // the WAAPI animation, created lazily on first use
}

// Per-element cue state and the last step applied to a given root. Both keyed weakly, so
// they clear automatically when a slide's DOM is replaced.
const elementCues = new WeakMap<Element, CueState[]>();
const rootStep = new WeakMap<Element, number>();

function parseCues(el: Element): CueData[] {
    const raw = el.getAttribute("data-cues");
    if (!raw) return [];
    try {
        return JSON.parse(raw) as CueData[];
    } catch {
        return [];
    }
}

function cueStates(el: Element): CueState[] {
    let states = elementCues.get(el);
    if (!states) {
        states = parseCues(el).map((cue) => ({ cue, anim: null }));
        elementCues.set(el, states);
    }
    return states;
}

function ensureAnim(el: Element, st: CueState): Animation {
    if (!st.anim) {
        const { name, vars, opts } = st.cue;
        // The cue `name` is the type slug (`fade-in`); the keyframes rule is
        // `@keyframes anim-<slug>` (`anim-fade-in`), so prefix it here.
        const anim = el.animate(buildKeyframes(`anim-${name}`, vars), {
            duration: Math.max(0, opts.duration * 1000),
            delay: Math.max(0, opts.delay * 1000),
            easing: opts.easing || "linear",
            iterations: opts.iterations ?? 1,
            fill: "forwards",
        });
        anim.pause();
        st.anim = anim;
    }
    return st.anim;
}

function holdAtEnd(anim: Animation): void {
    anim.playbackRate = 1;
    try {
        anim.play();
        anim.finish(); // jump to the resting end state, no visible playback
    } catch {
        // finish() throws on an infinite effect — leave it running.
    }
}

// ── Decision (pure) ─────────────────────────────────────────────────────────────

// What the engine should do with a cue at `step`.
export type CueAction =
    | "forward" // enter/exit: play in to reveal/hide
    | "reverse" // enter/exit: play back to un-reveal/un-hide
    | "hold" // enter/exit: sit at the resting end state
    | "emphasis" // emphasis: fire once
    | "cancel" // assert nothing
    | "idle"; // leave as-is

// Decide an action for every cue on one element, given the target step, the previously
// applied step, and whether this is an instant landing (load / jump / backward entry) vs a
// sequential move. Visibility is owned by the *governing* enter/exit cue — the last whose
// step is reached — so at most one enter/exit ever asserts the element's state and the
// result never depends on WAAPI composite order across several held animations. A single
// step back across the governing boundary plays the outgoing cue in reverse; it lands on
// its start frame (which equals the new governing cue's resting value) and is cancelled by
// the next step. Pure, so the whole rule is unit-testable. `cues` are in step order.
export function elementActions(
    cues: readonly Pick<CueData, "kind" | "step">[],
    step: number,
    prev: number,
    instant: boolean,
): CueAction[] {
    const governing = (at: number): number => {
        let idx = -1;
        cues.forEach((c, i) => {
            if (c.kind !== "emphasis" && c.step <= at) idx = i;
        });
        return idx;
    };
    const gov = governing(step);
    const govPrev = governing(prev);
    return cues.map((cue, i): CueAction => {
        if (cue.kind === "emphasis") {
            const crossedForward =
                !instant && step > prev && cue.step > prev && cue.step <= step;
            if (crossedForward) return "emphasis";
            return instant ? "cancel" : "idle";
        }
        if (i === gov) {
            return !instant && step > prev && cue.step === step
                ? "forward"
                : "hold";
        }
        if (!instant && i === govPrev && govPrev > gov) return "reverse";
        return "cancel";
    });
}

function applyAction(el: Element, st: CueState, action: CueAction): void {
    switch (action) {
        case "forward":
        case "emphasis": {
            const anim = ensureAnim(el, st);
            anim.cancel(); // restart from the `from` frame
            anim.playbackRate = 1;
            anim.play();
            break;
        }
        case "reverse": {
            const anim = ensureAnim(el, st);
            anim.playbackRate = -1;
            anim.play();
            break;
        }
        case "hold":
            holdAtEnd(ensureAnim(el, st));
            break;
        case "cancel":
            st.anim?.cancel();
            break;
        case "idle":
            break;
    }
}

// ── Code-fence highlight stages (unchanged) ─────────────────────────────────────

function applyCodeHighlights(root: Element, step: number): void {
    root.querySelectorAll<HTMLElement>(
        ".inkflow-codeblock[data-hl-spec][data-base-step]",
    ).forEach((block) => {
        const spec: (number[] | null)[] = JSON.parse(block.dataset.hlSpec!);
        const baseStep = +(block.dataset.baseStep ?? "0");
        const specIdx = Math.min(Math.max(step - baseStep, 0), spec.length - 1);
        const active = spec[specIdx]; // null = all, [] = none, [1,2,…] = lines
        const hasHL = active !== null;

        block.querySelectorAll<HTMLElement>(".code-line").forEach((line) => {
            const n = +(line.dataset.line ?? "0");
            line.classList.toggle("hl-active", hasHL && active!.includes(n));
            line.classList.toggle("hl-dim", hasHL && !active!.includes(n));
            if (!hasHL) line.classList.remove("hl-active", "hl-dim");
        });
    });
}

// ── Public API ──────────────────────────────────────────────────────────────────

// The highest step in a slide: the max across every element's cues, plus a video's
// play-on-step and code-highlight stages. A pure function of the markup, so it works on a
// detached scratch tree (status.ts computes it that way, off the slide data).
export function maxStep(root: Element): number {
    let m = 0;
    root.querySelectorAll("[data-cues]").forEach((el) => {
        for (const c of parseCues(el)) if (c.step > m) m = c.step;
    });
    root.querySelectorAll("[data-play-on-step]").forEach((el) => {
        const s = +(el.getAttribute("data-play-on-step") ?? "0");
        if (s > m) m = s;
    });
    root.querySelectorAll<HTMLElement>(
        ".inkflow-codeblock[data-hl-spec][data-base-step]",
    ).forEach((block) => {
        const spec: unknown[] = JSON.parse(block.dataset.hlSpec!);
        const baseStep = +(block.dataset.baseStep ?? "0");
        const last = baseStep + spec.length - 1;
        if (last > m) m = last;
    });
    return m;
}

// Advance the slide to `step`, animating the change. Direction (forward vs backward) is
// inferred from the last step applied to this root, so a single forward press reveals and
// a single back press mirrors it in reverse.
export function applyStep(root: Element, step: number): void {
    const prev = rootStep.get(root) ?? 0;
    root.querySelectorAll("[data-cues]").forEach((el) => {
        const states = cueStates(el);
        const actions = elementActions(
            states.map((s) => s.cue),
            step,
            prev,
            false,
        );
        states.forEach((st, i) => applyAction(el, st, actions[i]));
    });
    applyCodeHighlights(root, step);
    rootStep.set(root, step);
}

// Bake each element's currently-held animation values into its inline style. The step
// state is held by live WAAPI animation objects, which a DOM snapshot (a transition
// capturing innerHTML, or cloning nodes) does not carry — without this the outgoing slide
// would revert to its authored base (entered elements vanish, exited ones reappear) the
// instant a transition starts. Called on the outgoing slide just before it is captured.
export function commitStepStyles(root: Element): void {
    if (typeof root.getAnimations !== "function") return;
    for (const anim of root.getAnimations({ subtree: true })) {
        try {
            anim.commitStyles();
        } catch {
            // commitStyles throws if the target is not currently renderable — skip it.
        }
    }
}

// Land on `step`'s resting state with no visible playback: reached enters/exits hold their
// end, everything else asserts nothing, and emphasis never fires. Used for load, jumps,
// overview thumbnails, and backward slide entry.
export function applyStepInstant(root: Element, step: number): void {
    root.querySelectorAll("[data-cues]").forEach((el) => {
        const states = cueStates(el);
        const actions = elementActions(
            states.map((s) => s.cue),
            step,
            step,
            true,
        );
        states.forEach((st, i) => applyAction(el, st, actions[i]));
    });
    applyCodeHighlights(root, step);
    rootStep.set(root, step);
}
