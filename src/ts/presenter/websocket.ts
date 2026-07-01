import type { SyncMode, TransitionData, WsMessage } from "../shared/types";
import { renderPv, renderPvNext, updatePvInfo } from "./pv";
import { state } from "./state";
import { applyCurrentStep, applyCurrentStepInstant, maxStep } from "./status";
import { CUT, loadSlide, snapInflight } from "./transitions";
import { hideError, showError } from "./ui";

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

export function setSyncMode(mode: SyncMode): void {
    state.syncMode = mode;
    try {
        sessionStorage.setItem(SYNC_MODE_KEY, mode);
    } catch (_) {}
    // Entering a receiving mode: catch up to the presenter's current position now
    // instead of waiting for their next navigation.
    if (receives()) requestSync();
}

// Ask the server to reply (to this client only) with the current position.
function requestSync(): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN)
        state.ws.send(JSON.stringify({ type: "sync-request" }));
}

// ── Outbound ─────────────────────────────────────────────────────────────────

export function sendNav(transition?: TransitionData | null): void {
    if (
        !state.ws ||
        state.ws.readyState !== WebSocket.OPEN ||
        state._syncingFromServer ||
        !sends()
    )
        return;
    state.ws.send(
        JSON.stringify({
            type: "nav",
            slideIndex: state.slideIndex,
            step: state.step,
            ...(transition ? { transition } : {}),
        }),
    );
}

// Tell other connected screens to snap their in-flight transition to its end,
// matching a local same-direction-press snap. Position is unchanged, so this is a
// separate signal rather than a normal nav.
export function sendSnap(): void {
    if (
        !state.ws ||
        state.ws.readyState !== WebSocket.OPEN ||
        state._syncingFromServer ||
        !sends()
    )
        return;
    state.ws.send(
        JSON.stringify({
            type: "nav",
            slideIndex: state.slideIndex,
            step: state.step,
            snap: true,
        }),
    );
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
        } else if (msg.type === "position") {
            if (!receives()) return;
            if (msg.snap) {
                // Another screen snapped its transition; match it. Position is
                // already in sync, so just collapse our in-flight transition.
                snapInflight();
                return;
            }
            if (firstPositionPending) {
                // Discard exactly the stale connect-time push so an authoritative
                // window keeps its own position. Later updates apply normally.
                firstPositionPending = false;
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
