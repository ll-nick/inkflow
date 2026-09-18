// Every field is always emitted by the Python side (pipeline.py process_deck),
// so all are required here. Consumers that still guard with `|| ""` are being
// defensive, not handling a real absent case.
export interface EditableFile {
    label: string;
    path: string;
}

export interface SlideData {
    id: string;
    svg: string;
    title: string;
    notes: string;
    editableFiles: EditableFile[];
}

// Whether the server has a configured edit command for each file kind (env vars
// INKFLOW_EDIT_CMD_SVG / INKFLOW_EDIT_CMD_MD), baked in at page load — see edit.ts.
export interface EditCommandsConfig {
    svg: boolean;
    md: boolean;
}

// Per-client position-sync mode. Never sent to the server: it only decides,
// locally, whether this client broadcasts its nav and whether it applies an
// incoming position. `two-way` both, `present` send-only, `follow` receive-only,
// `solo` neither.
export type SyncMode = "two-way" | "present" | "follow" | "solo";

export interface TransitionData {
    type: string;
    duration: number;
    easing?: string;
    direction?: string;
    color?: string;
    amount?: number;
    reverse?: boolean;
    [key: string]: unknown;
}

// A non-fatal log record surfaced to the presenter banner. `level` is one of
// debug/info/warning/error (the coarse band from inkflow.logging), used to style
// the entry. Fatal build errors are not logs — they use the `error` message overlay.
export interface LogEntry {
    level: string;
    message: string;
}

export interface NavMessage {
    type: "nav";
    slideIndex: number;
    step: number;
    transition?: TransitionData;
    snap?: boolean;
}

// The position-carrying fields common to an outbound NavMessage and an inbound
// WsMessage "position" — what applyIncomingPosition (websocket.ts) needs, shared by
// the WebSocket relay (serve) and the window-link transport (build; windowsync.ts).
// Derived from NavMessage rather than restated so a new field can't drift between
// the two (or WsMessage's "position" variant below).
export type SyncPosition = Omit<NavMessage, "type">;

export type WsMessage =
    | {
          type: "update";
          slides: SlideData[];
          transitions: TransitionData[];
          logs: LogEntry[];
      }
    | { type: "error"; message: string }
    | ({ type: "position" } & SyncPosition);
