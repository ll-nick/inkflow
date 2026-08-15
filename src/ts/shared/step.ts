import { buildKeyframes } from "./keyframes";

// The step engine. Every animated element carries a `data-cues` JSON array (written by
// pipeline.py). Each cue becomes one paused Web Animations API animation that the engine
// drives by SEEKING its `currentTime` — setting the playback position directly, never
// letting it run on the wall clock. A step's cues form one "run" laid out over a shared
// timeline (each cue at its `offset`), and the presenter walks a single 0→1 progress value
// across that run (see status.ts). Because the whole run is one scalar, reverse is the value
// gliding back and a snap is the value jumping to its end — exactly like the slide
// transitions. At rest, the governing enter/exit cue owns visibility, so the held state
// never depends on WAAPI composite order.

interface CueOpts {
    duration: number; // seconds
    delay: number; // seconds — a real WAAPI before-phase the run seeks through
    easing: string;
    iterations?: number;
}

interface CueData {
    step: number;
    kind: "enter" | "exit" | "emphasis";
    name: string;
    offset: number; // seconds from its run's start where this cue's slot begins
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

// The effect's natural end in ms: delay + duration·iterations. A run never seeks past it,
// and the resting hold lands exactly on it.
function effectEndMs(cue: CueData): number {
    const { duration, delay, iterations } = cue.opts;
    return (
        Math.max(0, delay) * 1000 +
        Math.max(0, duration) * (iterations ?? 1) * 1000
    );
}

function ensureAnim(el: Element, st: CueState): Animation {
    if (!st.anim) {
        const { name, vars, opts } = st.cue;
        // The cue `name` is the type slug (`fade-in`); the keyframes rule is
        // `@keyframes anim-<slug>` (`anim-fade-in`), so prefix it here. `fill: both` so a
        // a sought `currentTime` paints a deterministic frame at any point, including the
        // `delay` before-phase (the from-frame).
        const anim = el.animate(buildKeyframes(`anim-${name}`, vars), {
            duration: Math.max(0, opts.duration * 1000),
            delay: Math.max(0, opts.delay * 1000),
            easing: opts.easing || "linear",
            iterations: opts.iterations ?? 1,
            fill: "both",
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

// ── Resting decision (pure) ─────────────────────────────────────────────────────

// What the engine should do with a cue when the slide sits at rest on `step`.
export type RestingAction =
    | "hold" // enter/exit: sit at the resting end state (the governing cue)
    | "cancel"; // assert nothing

// Decide the resting action for every cue on one element at `step`. Visibility is owned by
// the *governing* enter/exit cue — the last whose step is reached — held at its end; every
// other enter/exit, and every emphasis, asserts nothing (cancel). Pure, so the whole rule
// is unit-testable. `cues` are in step order.
export function restingActions(
    cues: readonly Pick<CueData, "kind" | "step">[],
    step: number,
): RestingAction[] {
    let gov = -1;
    cues.forEach((c, i) => {
        if (c.kind !== "emphasis" && c.step <= step) gov = i;
    });
    return cues.map((_, i): RestingAction => (i === gov ? "hold" : "cancel"));
}

// ── Step run (animated, seek-driven) ────────────────────────────────────────────

// One cue enlisted in a run: its animation plus its slot on the run timeline (ms).
interface RunItem {
    anim: Animation;
    offsetMs: number; // where the cue's slot begins within the run
    spanMs: number; // the cue's own effect length (delay + duration·iterations)
}

// A step's cues laid out as a single seekable timeline. `totalMs` is the run's length;
// `forward` is the travel direction (true 0→1, false 1→0); `toStep` is the destination stop.
export interface StepRun {
    items: RunItem[];
    totalMs: number;
    forward: boolean;
    toStep: number;
}

// Build the run played when moving between `fromStep` and `toStep` (always adjacent stops).
// The run is the cues introduced at the higher stop, each placed at its `offset`; seeking
// the run forward reveals them staggered and backward mirrors it. An empty run (totalMs 0)
// means nothing animates and the caller should land instantly.
export function buildStepRun(
    root: Element,
    fromStep: number,
    toStep: number,
): StepRun {
    const forward = toStep >= fromStep;
    const runStep = Math.max(fromStep, toStep);
    const items: RunItem[] = [];
    root.querySelectorAll("[data-cues]").forEach((el) => {
        for (const st of cueStates(el)) {
            if (st.cue.step !== runStep) continue;
            const anim = ensureAnim(el, st);
            anim.pause(); // a previously-held cue is finished/running — pause so a
            // sought currentTime holds instead of the effect advancing on its own.
            items.push({
                anim,
                offsetMs: Math.max(0, st.cue.offset) * 1000,
                spanMs: effectEndMs(st.cue),
            });
        }
    });
    const totalMs = items.reduce(
        (m, it) => Math.max(m, it.offsetMs + it.spanMs),
        0,
    );
    return { items, totalMs, forward, toStep };
}

// Paint the run at progress `value` (0..1) by seeking each cue: its `currentTime` is the run
// time minus its slot offset, clamped to its own span. Cues whose slot has not begun sit at
// their from-frame; cues past their end sit held. Setting `currentTime` on an idle
// (cancelled) animation re-activates it paused at that frame, so a run picks up cancelled
// enters cleanly.
export function seekStepRun(run: StepRun, value: number): void {
    const runTimeMs = value * run.totalMs;
    for (const it of run.items) {
        it.anim.currentTime = Math.min(
            Math.max(runTimeMs - it.offsetMs, 0),
            it.spanMs,
        );
    }
}

// ── Code-fence highlight stages (unchanged) ─────────────────────────────────────

export function applyCodeHighlights(root: Element, step: number): void {
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

// The last step the engine applied to this root (0 before anything). status.ts reads it to
// know where a run starts from.
export function appliedStep(root: Element): number {
    return rootStep.get(root) ?? 0;
}

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

// Land on `step`'s resting state with no visible playback: the governing enter/exit holds
// its end, everything else asserts nothing, and code highlights switch. Used for load,
// jumps, overview thumbnails, backward slide entry, and to settle the end of a run.
export function applyStepInstant(root: Element, step: number): void {
    root.querySelectorAll("[data-cues]").forEach((el) => {
        const states = cueStates(el);
        const actions = restingActions(
            states.map((s) => s.cue),
            step,
        );
        states.forEach((st, i) => {
            if (actions[i] === "hold") holdAtEnd(ensureAnim(el, st));
            else st.anim?.cancel();
        });
    });
    applyCodeHighlights(root, step);
    rootStep.set(root, step);
}
