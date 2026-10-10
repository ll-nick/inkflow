import type { SectionRef } from "./sections";

// Every field is always emitted by the Python side (pipeline.py process_deck),
// so all are required here. Consumers that still guard with `|| ""` are being
// defensive, not handling a real absent case.
export interface EditableFile {
    label: string;
    name: string;
    path: string;
}

export interface SlideData {
    id: string;
    svg: string;
    title: string;
    notes: string;
    editableFiles: EditableFile[];
    // The Section(...) the slide is in (absent before the first section).
    section?: SectionRef;
}

// Whether the server has a configured edit command for each file kind (env vars
// INKFLOW_EDIT_CMD, _SVG, _<EXT>, _IMAGE / _TEXT / _VIDEO), baked in at page
// load — see edit.ts.
export interface EditCommandsConfig {
    default: boolean;
    svg: boolean;
    // Extensions (lower-case, no dot) a command is configured for.
    suffixes?: string[];
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

// The colour a notification carries — the same vocabulary as inkflow.logging's
// report()/`_level_render` (green for a completed action, yellow for attention,
// red for an error), so client and server never invent two severity dialects.
export type NotifyStyle = "green" | "yellow" | "red";

// Ink drawn for the talk only, relayed between the windows of one
// presentation like the position (presenter/ink.ts). The server forwards it
// untouched; strokes are referred to by the slide's id, which survives a
// rebuild. Fields from another window are `unknown` until checked.
export type InkMessage =
    // A stroke still being drawn: its style and the samples from `from` on.
    | {
          type: "ink";
          op: "draw";
          slide: string;
          stroke: unknown;
          from: number;
          points: unknown;
      }
    | { type: "ink"; op: "abandon"; slide: string; id: unknown }
    // Finished strokes (a stroke ending, or ones an undo puts back).
    | { type: "ink"; op: "add"; slide: string; strokes: unknown[] }
    | { type: "ink"; op: "erase"; slide: string; ids: unknown[] }
    // A window that just connected asks; the others answer with "state".
    | { type: "ink"; op: "request" }
    | { type: "ink"; op: "state"; slides: Record<string, unknown> };

export type WsMessage =
    | InkMessage
    | {
          type: "edit-result";
          id: unknown;
          ok: boolean;
          error?: string;
          [key: string]: unknown;
      }
    | {
          type: "update";
          slides: SlideData[];
          transitions: TransitionData[];
          logs: LogEntry[];
          // Sent only when they changed (a theme edit): the deck's stylesheet
          // and its colour mode ("" dark, "light").
          styles?: string;
          mode?: string;
      }
    | { type: "error"; message: string }
    | { type: "notify"; message: string; style: NotifyStyle }
    | ({ type: "position" } & SyncPosition);
