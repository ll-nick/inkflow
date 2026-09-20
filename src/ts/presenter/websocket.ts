import type {
    NavMessage,
    SyncMode,
    SyncPosition,
    TransitionData,
    WsMessage,
} from "../shared/types";
import { renderPv, renderPvNext, updatePvInfo } from "./pv";
import { state } from "./state";
import {
    applyCurrentStep,
    applyCurrentStepInstant,
    maxStep,
    snapStepRun,
} from "./status";
import { CUT, loadSlide, snapInflight } from "./transitions";
import { hideError, showError, showLogs, showNotify } from "./ui";

const wsDot = document.getElementById("ws-dot")!;
// Direct DOM refs to avoid circular import with overview.ts
const overviewEl = document.getElementById("overview")!;
const overviewGridEl = document.getElementById("overview-grid")!;

// ── Sync mode ──────────────────────────────────────────────────────────────────
// The per-client sync mode governs steady-state behaviour: whether this window
// broadcasts its navigation to peers, and whether it applies positions pushed by
// peers. It is never sent to the server; the server is a dumb relay. Persisted in
// sessionStorage (per-tab, so two windows can hold different modes) and defaulting
// to two-way. See shared/types.ts SyncMode.

const SYNC_MODE_KEY = "inkflow-sync-mode";

function isSyncMode(v: string | null): v is SyncMode {
    return v === "two-way" || v === "present" || v === "follow" || v === "solo";
}

function sends(): boolean {
    return state.syncMode === "two-way" || state.syncMode === "present";
}

function receives(): boolean {
    return state.syncMode === "two-way" || state.syncMode === "follow";
}

export function loadSyncMode(): void {
    let stored: string | null = null;
    try {
        stored = sessionStorage.getItem(SYNC_MODE_KEY);
    } catch (_) {}
    if (isSyncMode(stored)) state.syncMode = stored;
}

// Behavioural core of a mode change: update state, persist, and (when entering a
// receiving mode) catch up to the presenter's current position immediately instead
// of waiting for their next navigation. The status-bar widget wraps this with the
// UI refresh (syncmenu.ts setSyncMode).
export function applySyncMode(mode: SyncMode): void {
    state.syncMode = mode;
    try {
        sessionStorage.setItem(SYNC_MODE_KEY, mode);
    } catch (_) {}
    if (receives()) requestSync();
}

// ── Outbound ─────────────────────────────────────────────────────────────────

// Send over whichever transport is live: the WS relay (serve) or the window-link
// (build; windowsync.ts). Exactly one is ever active — see initWindowSync.
// targetOrigin is "*": a window-link peer can be a file:// window carrying an
// opaque origin, which a stricter target could never reliably match.
function postToPeer(msg: NavMessage | { type: "sync-request" }): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(msg));
    } else if (state.windowLink && !state.windowLink.closed) {
        state.windowLink.postMessage(msg, "*");
    }
}

// Ask the peer to reply with its current position: the server relays this to the
// client that pushed it last (serve), or the window-link peer answers directly
// (build — see windowsync.ts's sync-request handling and currentNavMessage below).
// Exported so windowsync.ts can also use it to close the window.open()-to-
// listener-ready race on a freshly opened presenter view.
export function requestSync(): void {
    postToPeer({ type: "sync-request" });
}

export function sendNav(transition?: TransitionData | null): void {
    if (state._syncingFromServer || !sends()) return;
    postToPeer({
        type: "nav",
        slideIndex: state.slideIndex,
        step: state.step,
        ...(transition ? { transition } : {}),
    });
}

// Tell other connected screens to snap their in-flight transition to its end,
// matching a local same-direction-press snap. Position is unchanged, so this is a
// separate signal rather than a normal nav.
export function sendSnap(): void {
    if (state._syncingFromServer || !sends()) return;
    postToPeer({
        type: "nav",
        slideIndex: state.slideIndex,
        step: state.step,
        snap: true,
    });
}

// This window's current position, handed directly to a window-link peer that just
// asked for it (a sync-request reply). Unlike sendNav this is a direct answer to an
// explicit request rather than a broadcast, so it isn't gated by
// sends()/_syncingFromServer — the peer gets the truth regardless of this window's
// own sync mode, same as the WS server always answers from its last-known position.
export function currentNavMessage(): NavMessage {
    return { type: "nav", slideIndex: state.slideIndex, step: state.step };
}

// Apply a position pushed by a peer — shared by the WS relay (serve) and the
// window-link transport (build; windowsync.ts), so the two transports can never
// drift in what "receiving a position" actually does to the slide/step state.
export function applyIncomingPosition(msg: SyncPosition): void {
    if (!receives()) return;
    if (msg.snap) {
        // Another screen snapped its in-flight animation; match it. Position is
        // already in sync, so just collapse ours — whichever is live (a slide
        // transition or a step run).
        snapInflight();
        snapStepRun();
        return;
    }
    const newIndex = Math.min(
        Math.max(0, msg.slideIndex | 0),
        Math.max(0, state.slides.length - 1),
    );
    const newStep = Math.max(0, msg.step | 0);
    if (newIndex === state.slideIndex && newStep === state.step) return;
    if (newIndex === state.slideIndex) {
        // Same slide, step-only change from a peer: reveal it in place
        // rather than rebuilding the slide DOM (which would interrupt the
        // step animation and replay the entry transition). A single-step
        // delta animates; a multi-step jump lands instantly.
        const prevStep = state.step;
        state._syncingFromServer = true;
        state.step = newStep;
        if (Math.abs(newStep - prevStep) === 1) applyCurrentStep();
        else applyCurrentStepInstant();
        state._syncingFromServer = false;
        renderPvNext();
        updatePvInfo();
        return;
    }
    state._syncingFromServer = true;
    state.slideIndex = newIndex;
    state.step = newStep;
    loadSlide(() => {
        if (state.step > 0) applyCurrentStep();
        state._syncingFromServer = false;
    }, msg.transition ?? null);
    renderPv();
}

// ── Connection ───────────────────────────────────────────────────────────────

// `authoritative` marks a client whose own position should win over the server's
// stored one on connect: a deep-linked window (URL carried a slide segment) or a
// reconnecting live window. Such a client announces its position and discards the
// server's first push. A non-authoritative window stays silent and adopts the
// pushed position (proper second-screen follow), so opening a bare window never
// yanks the others.
export function connectWS(wsPort: number | null, authoritative: boolean): void {
    if (!wsPort) return;
    state.ws = new WebSocket(`ws://localhost:${wsPort}`);

    // Set in onopen (which fires before any message): true only while this
    // connection still owes the server's stale connect-time push a discard.
    let firstPositionPending = false;

    state.ws.onopen = () => {
        wsDot.className = "connected";
        const assert = authoritative && sends();
        firstPositionPending = assert;
        if (assert) sendNav();
    };

    state.ws.onmessage = (ev) => {
        let msg: WsMessage;
        try {
            msg = JSON.parse(ev.data) as WsMessage;
        } catch (_) {
            return;
        }
        if (msg.type === "update") {
            state.slides = msg.slides;
            state.transitions = msg.transitions;
            hideError();
            showLogs(msg.logs ?? []);
            if (overviewEl.classList.contains("visible")) {
                overviewEl.classList.remove("visible");
                overviewGridEl.innerHTML = "";
            }
            state.slideIndex = Math.min(
                state.slideIndex,
                Math.max(0, state.slides.length - 1),
            );
            state.step = Math.min(state.step, maxStep());
            loadSlide(null, CUT);
            renderPv();
        } else if (msg.type === "error") {
            showError(msg.message);
        } else if (msg.type === "notify") {
            showNotify(msg.message, msg.style);
        } else if (msg.type === "position") {
            // Discard exactly the stale connect-time push so an authoritative window
            // keeps its own position; later updates apply normally. Mirrors the
            // receives()/snap short-circuits inside applyIncomingPosition so a
            // non-receiving or snap message never consumes this one-shot flag.
            if (receives() && !msg.snap && firstPositionPending) {
                firstPositionPending = false;
                return;
            }
            applyIncomingPosition(msg);
        }
    };

    state.ws.onclose = () => {
        wsDot.className = "";
        state.ws = null;
        // A reconnecting live window re-asserts its position rather than being
        // adopted by a possibly-stale server.
        setTimeout(() => connectWS(wsPort, true), 2000);
    };

    state.ws.onerror = () => state.ws?.close();
}
