import type { NavMessage } from "../shared/types";
import { state } from "./state";
import { showNotify } from "./ui";
import {
    applyIncomingPosition,
    currentNavMessage,
    requestSync,
} from "./websocket";

// Position sync for `inkflow build` output, which has no WebSocket server behind
// it (WS_PORT is null — see globals.d.ts / server.py build_html). Two windows of
// the same exported page sync directly via window.open()/postMessage instead: the
// opener holds a Window reference to whatever it opens, and postMessage works over
// that reference regardless of file://'s opaque origin (targetOrigin "*" in
// websocket.ts's postToPeer — a stricter target could never reliably match two
// file:// windows). Symmetric, not master/slave — whichever side has the reference
// can send and receive, gated by the same per-window SyncMode as the WS transport
// (see websocket.ts). Capped at two windows: a window that is itself a child (has
// window.opener) never offers to open a third.
//
// In serve mode (WS_PORT set) the button is still wired, purely as a convenience
// for opening another tab — the WS relay already syncs however many windows
// connect, so there's no two-window cap and no link bookkeeping on that path;
// each click opens a genuinely new window rather than reusing one.

const statusDot = document.getElementById("ws-dot")!;
const btnPresenterView = document.getElementById("btn-presenter-view")!;

// How fast a closed peer is noticed (button re-enabled, dot goes disconnected).
// Cheap to poll — just a `.closed` read — so this stays snappy.
const POLL_INTERVAL_MS = 300;

const POPUP_BLOCKED_MESSAGE =
    "Pop-up blocked — allow pop-ups for this page to open the presenter view.";

/** Narrows an incoming postMessage payload to a NavMessage before it's applied. */
export function isSyncPayload(data: unknown): data is NavMessage {
    if (typeof data !== "object" || data === null) return false;
    const msg = data as Partial<NavMessage>;
    return (
        msg.type === "nav" &&
        typeof msg.slideIndex === "number" &&
        typeof msg.step === "number"
    );
}

/** A peer asking us to hand back our current position (websocket.ts requestSync). */
function isSyncRequest(data: unknown): boolean {
    return (
        typeof data === "object" &&
        data !== null &&
        (data as { type?: unknown }).type === "sync-request"
    );
}

let linkHandler: ((e: MessageEvent) => void) | undefined;
let linkPoll: ReturnType<typeof setInterval> | undefined;

// `requestCatchUp` is only for the "I was opened by someone" boot path: it closes
// the race between window.open() returning and this window's listener existing, by
// asking the opener directly for whatever it's actually showing right now, rather
// than waiting for its next navigation. The opener side never needs this — its own
// state already is the current truth.
function attachLink(win: Window, requestCatchUp = false): void {
    state.windowLink = win;
    statusDot.className = "connected";
    btnPresenterView.style.display = "none";
    linkHandler = (e: MessageEvent) => {
        // e.source pins this to the specific window we linked; e.origin guards
        // against that same window later navigating to unrelated content while
        // still holding the reference (window.opener and the link both survive a
        // navigation of the window they point at).
        if (e.source !== win || e.origin !== window.origin) return;
        if (isSyncRequest(e.data)) {
            win.postMessage(currentNavMessage(), "*");
            return;
        }
        if (isSyncPayload(e.data)) applyIncomingPosition(e.data);
    };
    window.addEventListener("message", linkHandler);
    linkPoll = setInterval(() => {
        if (win.closed) detachLink();
    }, POLL_INTERVAL_MS);
    if (requestCatchUp) requestSync();
}

function detachLink(): void {
    state.windowLink = null;
    statusDot.className = "";
    btnPresenterView.style.display = "";
    if (linkHandler) window.removeEventListener("message", linkHandler);
    linkHandler = undefined;
    clearInterval(linkPoll);
    linkPoll = undefined;
}

// Set once by initWindowSync; read by openSyncedWindow so the keyboard binding
// (keyboard.ts's "n") can call the same logic as the click listener without
// threading wsPort through a second parameter.
let _wsPort: number | null = null;

export function openSyncedWindow(): void {
    if (_wsPort === null && state.windowLink) return; // already linked (2-window cap)
    // No target name: a named target gets reused/refocused by a later
    // window.open() call with the same name — including from inside the window
    // it names, which would just reload itself. Serve has no window-count cap
    // (the WS relay already syncs however many windows connect), so repeat
    // clicks must always open a genuinely new window rather than colliding with
    // whichever window happens to hold that name.
    const child = window.open(location.href);
    if (!child) {
        showNotify(POPUP_BLOCKED_MESSAGE, "yellow");
        return;
    }
    if (_wsPort === null) attachLink(child);
}

export function initWindowSync(wsPort: number | null): void {
    _wsPort = wsPort;
    btnPresenterView.addEventListener("click", openSyncedWindow);

    if (wsPort !== null) return; // serve: WS already syncs any window opened this way

    if (window.opener) attachLink(window.opener as Window, true);
}
