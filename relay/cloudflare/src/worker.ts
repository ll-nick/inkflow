// inkflow's relay as a Cloudflare Worker: one Durable Object per room, using
// the WebSocket Hibernation API (an idle room costs nothing), and the guest
// page served as static assets (no Worker invocation for those).
//
// The same protocol as src/inkflow/online/relay.py (read its docstring):
// - /_relay/host?room=<id>: the host, proving the room secret (header
//   Inkflow-Room-Secret, whose SHA-256 names the room) and, when the Worker
//   has one, RELAY_ACCESS_TOKEN (Authorization: Bearer …);
// - /_relay/join?room=<id>: a guest; frames only;
// - /_relay/health: {"ok": true}.
// Host ⇄ relay binary messages are a u32 peer number and one frame; the
// relay tells the host {"type":"join"|"leave","peer"} and takes
// {"type":"kick","peer"}. A room exists while its host is connected.
//
// The relay sees room ids, peer numbers, sizes and timing. The frames are
// sealed end to end between the guest's browser and the host.

import { DurableObject } from "cloudflare:workers";

export interface Env {
    ROOMS: DurableObjectNamespace<Room>;
    /** A secret (wrangler secret put RELAY_ACCESS_TOKEN): only a host that
     * presents it may open rooms. */
    RELAY_ACCESS_TOKEN?: string;
    /** "1": refuse every host while no RELAY_ACCESS_TOKEN is set (what
     * `inkflow relay deploy cloudflare` deploys, so the relay is never open
     * between the deploy and the secret). */
    REQUIRE_ACCESS_TOKEN?: string;
    /** Guests per room (default 50). */
    MAX_GUESTS?: string;
}

const PROTOCOL = 1;
const MAX_FRAME = 512 * 1024;
const MAX_WIRE = MAX_FRAME + 64;
const ROOM = /^[A-Za-z0-9_-]{22}$/;

// Close codes (the Python relay's).
const NO_ROOM = 4404;
const ROOM_FULL = 4409;
const HOST_GONE = 4410;
const UNAUTHORIZED = 4401;
const KICKED = 4403;
const RATE_LIMITED = 4429;
const BAD_REQUEST = 4400;
const REPLACED = 4408;

const ROLE_HEADER = "X-Inkflow-Relay-Role";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
    });
}

function b64uDecode(text: string): Uint8Array | null {
    try {
        const s = atob(
            text.replace(/-/g, "+").replace(/_/g, "/") +
                "=".repeat((4 - (text.length % 4)) % 4),
        );
        return Uint8Array.from(s, (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

function b64u(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/** Equal strings, in time that does not depend on where they differ. */
function same(a: string, b: string): boolean {
    const x = new TextEncoder().encode(a);
    const y = new TextEncoder().encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    }
    return diff === 0;
}

export async function roomOf(secret: Uint8Array): Promise<string> {
    const prefix = new TextEncoder().encode("inkflow-room/1");
    const data = new Uint8Array(prefix.length + secret.length);
    data.set(prefix);
    data.set(secret, prefix.length);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return b64u(new Uint8Array(digest)).slice(0, 22);
}

/** Why this request may not host ``room`` (null: it may). */
export async function hostRefusal(
    request: Request,
    env: Env,
    room: string,
): Promise<string | null> {
    const token = env.RELAY_ACCESS_TOKEN;
    if (token) {
        const given = (request.headers.get("Authorization") ?? "")
            .replace(/^Bearer\s+/i, "")
            .trim();
        if (!same(given, token)) return "this relay needs its access token";
    } else if (env.REQUIRE_ACCESS_TOKEN === "1") {
        return "this relay has no access token set yet (wrangler secret put RELAY_ACCESS_TOKEN)";
    }
    const secret = b64uDecode(request.headers.get("Inkflow-Room-Secret") ?? "");
    if (!secret || secret.length < 16) return "bad room secret";
    if (!same(await roomOf(secret), room)) return "not this room's host";
    return null;
}

/** A WebSocket answered and closed at once, so the client learns why. */
function refuse(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    // The client's side of the close may come after the socket is gone.
    server.addEventListener("error", () => {});
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/_relay/health") {
            return json({ ok: true, v: PROTOCOL, relay: "inkflow" });
        }
        const host = url.pathname === "/_relay/host";
        if (!host && url.pathname !== "/_relay/join") {
            return new Response("not found\n", { status: 404 });
        }
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("a WebSocket endpoint\n", { status: 426 });
        }
        const room = url.searchParams.get("room") ?? "";
        if (!ROOM.test(room)) return refuse(BAD_REQUEST, "bad room");
        if (host) {
            const refused = await hostRefusal(request, env, room);
            if (refused) return refuse(UNAUTHORIZED, refused);
        }
        const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
        const headers = new Headers(request.headers);
        headers.set(ROLE_HEADER, host ? "host" : "guest");
        headers.delete("Inkflow-Room-Secret");
        headers.delete("Authorization");
        return stub.fetch(new Request(request.url, { headers }));
    },
} satisfies ExportedHandler<Env>;

interface Attachment {
    role: "host" | "guest";
    /** host: this connection's own id; guest: its peer number. */
    id: number;
    room: string;
}

/** Frames a connection may send: `rate` per second, `burst` at once. Kept
 * in memory only (a hibernated room starts afresh, which is fine: it was
 * idle). */
class Bucket {
    private tokens: number;
    private at = Date.now();

    constructor(
        private rate: number,
        private burst: number,
    ) {
        this.tokens = burst;
    }

    take(): boolean {
        const now = Date.now();
        this.tokens = Math.min(
            this.burst,
            this.tokens + ((now - this.at) / 1000) * this.rate,
        );
        this.at = now;
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

function close(ws: WebSocket, code: number, reason: string): void {
    try {
        ws.close(code, reason);
    } catch {
        // Already closing.
    }
}

export class Room extends DurableObject<Env> {
    private buckets = new WeakMap<WebSocket, Bucket>();

    private attachment(ws: WebSocket): Attachment | null {
        return (ws.deserializeAttachment() as Attachment | null) ?? null;
    }

    private host(except?: WebSocket): WebSocket | null {
        for (const ws of this.ctx.getWebSockets("host")) {
            if (ws !== except && ws.readyState === WebSocket.OPEN) return ws;
        }
        return null;
    }

    private guest(peer: number): WebSocket | null {
        return this.ctx.getWebSockets(`g:${peer}`)[0] ?? null;
    }

    private closeGuests(code: number, reason: string): void {
        for (const ws of this.ctx.getWebSockets("guest"))
            close(ws, code, reason);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const room = url.searchParams.get("room") ?? "";
        if (request.headers.get(ROLE_HEADER) === "host") {
            const [client, server] = Object.values(new WebSocketPair());
            // The host again (a new connection after a network change): its
            // guests' sessions were with the old connection.
            const old = this.ctx.getWebSockets("host");
            if (old.length) {
                this.closeGuests(HOST_GONE, "the host reconnected");
                for (const ws of old)
                    close(ws, REPLACED, "replaced by a new connection");
            }
            this.ctx.acceptWebSocket(server, ["host"]);
            const id = crypto.getRandomValues(new Uint32Array(1))[0];
            server.serializeAttachment({
                role: "host",
                id,
                room,
            } satisfies Attachment);
            server.send(
                JSON.stringify({
                    type: "ready",
                    room,
                    v: PROTOCOL,
                    maxGuests: this.maxGuests(),
                    maxFrame: MAX_FRAME,
                }),
            );
            return new Response(null, { status: 101, webSocket: client });
        }
        const host = this.host();
        if (!host) return refuse(NO_ROOM, "no one is sharing in this room now");
        if (this.ctx.getWebSockets("guest").length >= this.maxGuests()) {
            return refuse(ROOM_FULL, "the room is full");
        }
        const [client, server] = Object.values(new WebSocketPair());
        let peer = crypto.getRandomValues(new Uint32Array(1))[0];
        while (this.guest(peer))
            peer = crypto.getRandomValues(new Uint32Array(1))[0];
        this.ctx.acceptWebSocket(server, ["guest", `g:${peer}`]);
        server.serializeAttachment({
            role: "guest",
            id: peer,
            room,
        } satisfies Attachment);
        host.send(JSON.stringify({ type: "join", peer }));
        return new Response(null, { status: 101, webSocket: client });
    }

    private maxGuests(): number {
        const n = Number(this.env.MAX_GUESTS);
        return Number.isFinite(n) && n > 0 ? n : 50;
    }

    private bucket(ws: WebSocket, role: Attachment["role"]): Bucket {
        let bucket = this.buckets.get(ws);
        if (!bucket) {
            bucket =
                role === "host" ? new Bucket(2000, 8000) : new Bucket(100, 400);
            this.buckets.set(ws, bucket);
        }
        return bucket;
    }

    async webSocketMessage(
        ws: WebSocket,
        message: string | ArrayBuffer,
    ): Promise<void> {
        const me = this.attachment(ws);
        if (!me) return;
        if (!this.bucket(ws, me.role).take()) {
            close(ws, RATE_LIMITED, "too many frames");
            return;
        }
        if (me.role === "host") {
            if (typeof message === "string") {
                this.control(message);
                return;
            }
            if (message.byteLength < 5 || message.byteLength > MAX_WIRE) {
                close(ws, 1009, "frame too large");
                return;
            }
            const peer = new DataView(message).getUint32(0);
            const guest = this.guest(peer);
            if (guest) {
                try {
                    guest.send(message.slice(4));
                } catch {
                    close(guest, 1011, "cannot send");
                }
            }
            return;
        }
        if (typeof message === "string" || !message.byteLength) {
            close(ws, BAD_REQUEST, "frames only");
            return;
        }
        if (message.byteLength > MAX_WIRE - 4) {
            close(ws, 1009, "frame too large");
            return;
        }
        const host = this.host();
        if (!host) {
            close(ws, HOST_GONE, "the host left");
            return;
        }
        const out = new Uint8Array(4 + message.byteLength);
        new DataView(out.buffer).setUint32(0, me.id);
        out.set(new Uint8Array(message), 4);
        host.send(out);
    }

    private control(text: string): void {
        let msg: { type?: unknown; peer?: unknown };
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }
        if (msg.type === "kick" && typeof msg.peer === "number") {
            const guest = this.guest(msg.peer);
            if (guest) close(guest, KICKED, "sent away");
        }
    }

    async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
    ): Promise<void> {
        this.gone(ws);
        close(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        this.gone(ws);
    }

    private gone(ws: WebSocket): void {
        const me = this.attachment(ws);
        if (!me) return;
        if (me.role === "host") {
            // A host replaced by its new connection leaves the new one's
            // guests alone.
            if (!this.host(ws)) this.closeGuests(HOST_GONE, "the host left");
            return;
        }
        const host = this.host();
        if (host) {
            try {
                host.send(JSON.stringify({ type: "leave", peer: me.id }));
            } catch {
                // The host is going too.
            }
        }
    }
}
