// The guest page: what a share link for sharing online opens. It is static
// (served by the relay, the same for every deck and every inkflow version):
// it reads the room and key from the link's fragment, opens the encrypted
// channel to the host, and asks the host for the real page — the editor or
// the presenter of the host's own inkflow — which it shows in a frame
// filling the window.
//
// Two modes, one script:
// - top: the window the link opened. Holds the channel (window.__inkflowRelay),
//   registers the service worker, and loads the page frame.
// - frame: the page frame. The relay answers every navigation with this same
//   file, so a page at /edit (or /, or a reload) starts here: it fetches the
//   host's page for its own address through the top window's channel and
//   replaces itself with it (document.open/write). From then on its socket
//   is the channel (shared/wsurl.ts openSocket) and its requests go through
//   the service worker to the host.

import {
    Channel,
    type Channel as ChannelType,
    type FetchSink,
} from "./channel";
import { isRoomId, unb64u } from "./crypto";

interface RelayApi {
    channel: ChannelType;
    openSocket(): unknown;
}

declare global {
    interface Window {
        __inkflowRelay?: RelayApi;
    }
}

const STORE = "inkflow-online-link";

function parentRelay(): RelayApi | undefined {
    try {
        if (window.parent !== window) return window.parent.__inkflowRelay;
    } catch {
        // A frame of another site: not ours.
    }
    return undefined;
}

// ── Requests from the service worker ──

/** Answer the service worker's requests (this page's pictures, fonts,
 * videos) through the channel. */
function forwardRequests(channel: ChannelType): void {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { type?: string; path?: string; range?: string };
        const port = ev.ports[0];
        if (msg?.type !== "inkflow-fetch" || !port || !msg.path) return;
        const sink: FetchSink = {
            head: (status, headers) =>
                port.postMessage({ type: "head", status, headers }),
            chunk: (bytes) => {
                const copy = bytes.slice().buffer;
                port.postMessage({ type: "chunk", data: copy }, [copy]);
            },
            end: () => port.postMessage({ type: "end" }),
            error: (message) => port.postMessage({ type: "error", message }),
        };
        const cancel = channel.fetch(msg.path, msg.range ?? null, sink);
        port.onmessage = (m) => {
            if ((m.data as { type?: string })?.type === "cancel") cancel();
        };
    };
}

// ── The page frame ──

async function frameMode(relay: RelayApi): Promise<void> {
    forwardRequests(relay.channel);
    const path = location.pathname + location.search;
    let html: string;
    try {
        const res = await relay.channel.fetchAll(path);
        html = new TextDecoder().decode(res.body);
    } catch (err) {
        document.body.textContent = `Could not load the page: ${String(err)}`;
        return;
    }
    document.open();
    document.write(html);
    document.close();
    // document.open may drop the handler with the old document's.
    forwardRequests(relay.channel);
}

// ── The window the link opened ──

function linkFromFragment(): { room: string; secret: string } | null {
    const params = new URLSearchParams(location.hash.slice(1));
    const room = params.get("r");
    const secret = params.get("k");
    if (!room || !secret || !isRoomId(room)) return null;
    return { room, secret };
}

function stored(): { room: string; secret: string } | null {
    try {
        const raw = sessionStorage.getItem(STORE);
        const link = raw ? JSON.parse(raw) : null;
        if (link && isRoomId(link.room) && typeof link.secret === "string") {
            return link;
        }
    } catch {
        // Storage blocked: the link must be opened again.
    }
    return null;
}

function store(link: { room: string; secret: string }): void {
    try {
        sessionStorage.setItem(STORE, JSON.stringify(link));
    } catch {
        // Then a reload needs the link again.
    }
}

const status = document.getElementById("status");
const statusText = document.getElementById("status-text");

function show(text: string, kind: "busy" | "wait" | "end" = "busy"): void {
    if (!status || !statusText) return;
    statusText.textContent = text;
    status.className = kind;
    status.hidden = false;
}

function hide(): void {
    if (status) status.hidden = true;
}

async function topMode(): Promise<void> {
    const fromLink = linkFromFragment();
    const link = fromLink ?? stored();
    if (!link) {
        show(
            "This is a relay for sharing inkflow decks. Open the link the person sharing a deck sent you.",
            "end",
        );
        return;
    }
    store(link);
    // The key leaves the address bar (it stays in this tab, for a reload).
    const keep = fromLink ? "" : location.hash;
    history.replaceState(null, "", location.pathname + location.search + keep);
    if (!window.isSecureContext || !globalThis.crypto?.subtle) {
        show("This page needs a secure (https) address.", "end");
        return;
    }
    if (!("serviceWorker" in navigator)) {
        show(
            "This browser cannot show shared decks (no service workers; a private window may turn them off).",
            "end",
        );
        return;
    }
    show("Connecting…");
    try {
        await navigator.serviceWorker.register("/_guest/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
    } catch (err) {
        show(
            `This browser refused the page's service worker: ${String(err)}`,
            "end",
        );
        return;
    }
    const relayUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    const channel = new Channel(
        { room: link.room, secret: unb64u(link.secret) },
        relayUrl,
    );
    window.__inkflowRelay = { channel, openSocket: () => channel.openSocket() };
    forwardRequests(channel);
    let frame: HTMLIFrameElement | null = null;
    channel.onstate = (state, detail) => {
        if (state === "open") {
            hide();
            if (!frame) frame = openFrame(channel, fromLink !== null, keep);
        } else if (state === "waiting") {
            show(detail, "wait");
        } else if (state === "ended") {
            show(
                `Disconnected: ${detail}. Ask the person sharing the deck for a new link.`,
                "end",
            );
        }
    };
    channel.start();
}

function openFrame(
    channel: ChannelType,
    byLink: boolean,
    hash: string,
): HTMLIFrameElement {
    // A link opens the page of its role; a reload or a window the page
    // opened (the presenter) keeps its own address.
    const target = byLink
        ? channel.role === "editor"
            ? "/edit"
            : "/"
        : location.pathname + location.search;
    if (byLink) history.replaceState(null, "", target);
    const frame = document.createElement("iframe");
    frame.id = "page";
    frame.title = "Shared deck";
    frame.allow = "fullscreen; clipboard-read; clipboard-write; autoplay";
    frame.src = target + hash;
    document.body.append(frame);
    frame.addEventListener("load", () => frame.focus());
    // The page's title in this window's bar.
    window.setInterval(() => {
        try {
            const title = frame.contentDocument?.title;
            if (title && title !== document.title) document.title = title;
        } catch {
            // Between pages.
        }
    }, 1000);
    window.addEventListener("focus", () => frame.focus());
    return frame;
}

const relay = parentRelay();
if (relay) void frameMode(relay);
else void topMode();
