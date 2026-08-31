// Where the deck's position lives in the URL: always the fragment,
// `#slide=7&steps=2`.

const SLIDE = "slide";
const STEPS = "steps";

export interface DeckPosition {
    /** Zero-based, or `null` when the URL names no slide the deck actually has. */
    slideIndex: number | null;
    step: number;
}

function hashParams(url: URL): URLSearchParams {
    return new URLSearchParams(url.hash.slice(1));
}

/** The href that names this position, leaving the rest of `url` as it stands. */
export function positionHref(
    url: URL,
    slideIndex: number,
    step: number,
): string {
    const next = new URL(url.href);
    const params = hashParams(next);
    params.set(SLIDE, String(slideIndex + 1));
    if (step > 0) params.set(STEPS, String(step));
    else params.delete(STEPS);
    next.hash = params.toString();
    return next.href;
}

/** The position `url` carries, against a deck of `slideCount` slides. */
export function readPosition(url: URL, slideCount: number): DeckPosition {
    const params = hashParams(url);
    const slide = parseInt(params.get(SLIDE) ?? "", 10);
    const inDeck = !Number.isNaN(slide) && slide >= 1 && slide <= slideCount;
    const step = parseInt(params.get(STEPS) ?? "0", 10);
    return {
        slideIndex: inDeck ? slide - 1 : null,
        step: !Number.isNaN(step) && step >= 0 ? step : 0,
    };
}
