export interface SlideData {
    svg: string;
    title?: string;
    notes?: string;
}

export interface TransitionData {
    type: string;
    duration: number;
    easing?: string;
    direction?: string;
    color?: string;
    reverse?: boolean;
    [key: string]: unknown;
}

export interface NavMessage {
    type: "nav";
    slideIndex: number;
    step: number;
}

export type WsMessage =
    | { type: "update"; slides: SlideData[]; transitions?: TransitionData[] }
    | { type: "error"; message: string }
    | { type: "position"; slideIndex: number; step: number };
