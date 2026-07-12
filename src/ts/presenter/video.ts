// Presenter-side <video> playback control.
//
// Python emits playback intent as data-* attributes (data-autoplay, data-loop,
// data-play-on-step, data-start, data-end) rather than the native autoplay/loop
// attributes, so every play / pause / seek is decided here. syncVideos() is
// driven by the step machinery (status.ts) and only ever runs against the live
// stage, so clips reconstructed inside outgoing transition layers stay silent.

interface VideoSpec {
    autoplay: boolean;
    loop: boolean;
    playOnStep: number | null;
    start: number;
    end: number | null;
}

// Trim/loop listeners are attached once per element; the active-state map tracks
// whether a clip was "playing" last sync so we only act on the transition (and
// don't restart a clip that ran to its natural end).
const armed = new WeakSet<HTMLVideoElement>();
const activeState = new WeakMap<HTMLVideoElement, boolean>();

function readSpec(v: HTMLVideoElement): VideoSpec {
    const step = v.getAttribute("data-play-on-step");
    const start = v.getAttribute("data-start");
    const end = v.getAttribute("data-end");
    return {
        autoplay: v.hasAttribute("data-autoplay"),
        loop: v.hasAttribute("data-loop"),
        playOnStep: step === null ? null : Number(step),
        start: start === null ? 0 : Number(start),
        end: end === null ? null : Number(end),
    };
}

// Enforce the [start, end) trim window and looping, once per element.
function arm(v: HTMLVideoElement, spec: VideoSpec): void {
    if (armed.has(v)) return;
    armed.add(v);

    if (spec.start > 0) {
        // Land the first visible frame (and the controls scrub origin) on the
        // trim-in, even for a clip that only ever plays via its controls.
        const seek = () => {
            if (v.currentTime < spec.start) v.currentTime = spec.start;
        };
        if (v.readyState >= 1) seek();
        else v.addEventListener("loadedmetadata", seek, { once: true });
    }

    if (spec.end !== null || spec.loop) {
        v.addEventListener("timeupdate", () => {
            if (spec.end !== null && v.currentTime >= spec.end) {
                if (spec.loop) v.currentTime = spec.start;
                else v.pause();
            }
        });
    }
    if (spec.loop) {
        v.addEventListener("ended", () => playFrom(v, spec.start));
    }
}

function playFrom(v: HTMLVideoElement, start: number): void {
    const go = () => {
        v.currentTime = start;
        void v.play().catch(() => {
            // Playback blocked by browser policy (e.g. unmuted autoplay on a
            // cold load) — leave the poster / first frame showing.
        });
    };
    if (start > 0 && v.readyState < 1) {
        v.addEventListener("loadedmetadata", go, { once: true });
    } else {
        go();
    }
}

// Reconcile every <video> under `root` with the current step: a clip is "active"
// (playing) when it autoplays or the step has reached its play_on_step; entering
// that state plays from `start`, leaving it pauses and resets to `start`.
export function syncVideos(root: ParentNode, step: number): void {
    root.querySelectorAll<HTMLVideoElement>("video").forEach((v) => {
        const spec = readSpec(v);
        arm(v, spec);
        const shouldPlay =
            spec.autoplay ||
            (spec.playOnStep !== null && step >= spec.playOnStep);
        const wasActive = activeState.get(v) ?? false;
        if (shouldPlay && !wasActive) {
            playFrom(v, spec.start);
        } else if (!shouldPlay && wasActive) {
            v.pause();
            v.currentTime = spec.start;
        }
        activeState.set(v, shouldPlay);
    });
}
