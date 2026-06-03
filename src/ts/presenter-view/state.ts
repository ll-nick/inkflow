import type { SlideData } from "../shared/types";

export const state = {
    slides: [] as SlideData[],
    slideIndex: 0,
    step: 0,
    ws: null as WebSocket | null,
    _syncingFromServer: false,
    _maxStepCache: null as number | null,
};
