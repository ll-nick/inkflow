// Where a served page opens the server's WebSocket: on the very address the
// page came from (its host and port, whatever name, LAN address or SSH tunnel
// that is), at /_inkflow/ws, over TLS when the page is.

export const WS_PATH = "/_inkflow/ws";

export function socketUrl(loc: { protocol: string; host: string }): string {
    const scheme = loc.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${loc.host || "localhost"}${WS_PATH}`;
}

// Close codes the server uses to send a guest away; the page says why and
// does not reconnect (its link stopped working, or the owner disconnected it).
export const SENT_AWAY = 4001;

// A page shared online runs in the guest page's frame (src/ts/guest/boot.ts),
// whose top window holds the encrypted channel to the host: there the page's
// connection is one over that channel, shaped like a WebSocket. Anywhere else
// it is the server's WebSocket on the page's own address.
interface RelayParent {
    __inkflowRelay?: { openSocket(): unknown };
}

function relay(): RelayParent["__inkflowRelay"] {
    try {
        if (window.parent !== window) {
            return (window.parent as unknown as RelayParent).__inkflowRelay;
        }
    } catch {
        // Framed by another site: not the guest page.
    }
    return undefined;
}

export function openSocket(): WebSocket {
    const online = relay();
    if (!online) return new WebSocket(socketUrl(location));
    const sock = online.openSocket() as WebSocket;
    // The page going away (a reload, another page) ends its connection, as
    // the browser ends a WebSocket.
    window.addEventListener("pagehide", () => sock.close(1001, "page left"));
    return sock;
}

/** Whether this page is shared online (through a relay). */
export function isOnline(): boolean {
    return relay() !== undefined;
}
