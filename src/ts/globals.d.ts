import type { SlideData, TransitionData } from "./shared/types";

declare global {
    const __SLIDES_JSON__: SlideData[];
    const __TRANSITIONS_JSON__: TransitionData[];
    const __WS_PORT__: number | null;
    const __ERROR_JSON__: string | null;
    const __INITIAL_POSITION__: { slideIndex: number; step: number };
}
