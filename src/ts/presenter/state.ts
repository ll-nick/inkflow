import type { SlideData, TransitionData } from "../shared/types";

export const state = {
    slides: [] as SlideData[],
    transitions: [] as TransitionData[],
    slideIndex: 0,
    step: 0,
    _pickerMatches: [] as number[],
    _pickerActive: 0,
    _overviewActive: 0,
    _overviewCols: 1,
    ws: null as WebSocket | null,
    _syncingFromServer: false,
    _laserMode: false,
};
