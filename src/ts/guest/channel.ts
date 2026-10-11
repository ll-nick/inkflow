// A guest's encrypted channel to the host through the relay: the handshake,
// sealed frames, and on top of them what a page needs from its server —
// WebSocket-like page connections (`openSocket`) and GET requests
// (`fetch`, for the page itself and every picture, font and video it
// loads, answered through the service worker).
//
// One channel per browser tab (the guest page). The relay forwards frames
// and sees nothing in them; a channel lost while the host is away (network
// change) is opened again, and the page connections reconnect as they do
// to a restarting server.

import { finish, hello, type Session } from "./crypto";
import {
    chunks,
    type Header,
    pack,
    Reassembler,
    unpack,
    unwrap,
    wrap,
} from "./frames";

export interface Link {
    room: string;
    secret: Uint8Array;
}

export type ChannelState =
    | "connecting"
    | "open"
    | "waiting" // no host in the room now: tried again shortly
    | "ended"; // sent away, or the link no longer works: not tried again

// The relay's close codes (src/inkflow/online/relay.py, the Worker).
const NO_ROOM = 4404;
const ROOM_FULL = 4409;
const HOST_GONE = 4410;
const KICKED = 4403;
const RATE_LIMITED = 4429;
// What a page's connection is closed with when the host sent it away, as a
// server does (shared/wsurl.ts SENT_AWAY): the page stops reconnecting.
const SENT_AWAY = 4001;

export interface FetchSink {
    head(status: number, headers: Record<string, string>): void;
    chunk(bytes: Uint8Array): void;
    end(): void;
    error(message: string): void;
}

type Listener = (ev: Record<string, unknown>) => void;

/** A page's connection to the server, shaped like the WebSocket the page
 * would otherwise open (what net.ts and websocket.ts use of one). */
export class RelaySocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    onopen: Listener | null = null;
    onmessage: Listener | null = null;
    onclose: Listener | null = null;
    onerror: Listener | null = null;

    constructor(
        private channel: Channel,
        readonly cid: number,
    ) {}

    send(data: string): void {
        if (this.readyState === 0) throw new Error("still connecting");
        if (this.readyState !== 1) return;
        this.channel.send(
            { t: "ws", c: this.cid },
            new TextEncoder().encode(String(data)),
        );
    }

    close(code = 1000, reason = ""): void {
        if (this.readyState >= 2) return;
        const wasOpen = this.readyState === 1;
        this.readyState = 2;
        if (wasOpen) {
            this.channel.send({ t: "close", c: this.cid, code, reason });
        }
        this.ended(code, reason);
    }

    opened(): void {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({ type: "open" });
    }

    message(text: string): void {
        if (this.readyState === 1)
            this.onmessage?.({ type: "message", data: text });
    }

    ended(code: number, reason: string): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.channel.forget(this.cid);
        this.onclose?.({ type: "close", code, reason, wasClean: code < 4000 });
    }
}

export class Channel {
    state: ChannelState = "connecting";
    role: "editor" | "viewer" | null = null;
    /** Why the channel ended, or what it is waiting for. */
    detail = "";
    onstate: (state: ChannelState, detail: string) => void = () => {};
    /** Bytes of frames each way, for measurements. */
    sentBytes = 0;
    receivedBytes = 0;

    private ws: WebSocket | null = null;
    private session: Session | null = null;
    private helloFrame: Uint8Array | null = null;
    private again = new Reassembler();
    private sending: Promise<void> = Promise.resolve();
    private sockets = new Map<number, RelaySocket>();
    private fetches = new Map<number, FetchSink>();
    private nextCid = 1;
    private nextRid = 1;
    private waiters: (() => void)[] = [];
    private retry = 1000;

    constructor(
        private link: Link,
        private relayUrl: string,
    ) {}

    start(): void {
        this.connect();
    }

    whenOpen(): Promise<void> {
        if (this.state === "open") return Promise.resolve();
        return new Promise((resolve) => this.waiters.push(resolve));
    }

    private setState(state: ChannelState, detail = ""): void {
        this.state = state;
        this.detail = detail;
        this.onstate(state, detail);
        if (state === "open") {
            for (const resolve of this.waiters) resolve();
            this.waiters = [];
        }
    }

    private connect(): void {
        if (this.state === "ended") return;
        const url = `${this.relayUrl}/_relay/join?room=${encodeURIComponent(this.link.room)}`;
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        this.session = null;
        this.again = new Reassembler();
        // Frames are handled strictly in arrival order (decryption is async).
        let inbox: Promise<void> = Promise.resolve();
        ws.onopen = () => {
            void hello(this.link.secret, this.link.room).then((frame) => {
                this.helloFrame = frame;
                this.raw(frame);
            });
        };
        ws.onmessage = (ev) => {
            if (!(ev.data instanceof ArrayBuffer)) return;
            const frame = new Uint8Array(ev.data);
            this.receivedBytes += frame.length;
            inbox = inbox
                .then(() => this.receive(frame))
                .catch((err: unknown) => {
                    // A frame that does not open: not from the host.
                    console.warn("inkflow: dropped the channel:", err);
                    ws.close(4000, "bad frame");
                });
        };
        ws.onclose = (ev) => this.closed(ws, ev.code, ev.reason);
    }

    private closed(ws: WebSocket, code: number, reason: string): void {
        if (this.ws !== ws) return;
        this.ws = null;
        this.session = null;
        const ending = this.state === "ended";
        const sentAway = code === KICKED || code === RATE_LIMITED;
        const why = ending
            ? this.detail
            : sentAway
              ? reason || "the host sent this page away"
              : "";
        for (const sock of [...this.sockets.values()]) {
            sock.ended(ending || sentAway ? SENT_AWAY : 1006, why);
        }
        for (const sink of this.fetches.values()) {
            sink.error("the connection to the host was lost");
        }
        this.fetches.clear();
        if (ending) return;
        if (sentAway) {
            this.setState("ended", why);
            return;
        }
        const waiting =
            code === NO_ROOM || code === HOST_GONE
                ? "Waiting for the person sharing the deck… (if they made new links since, this one no longer works)"
                : code === ROOM_FULL
                  ? "The room is full: trying again shortly…"
                  : "Reconnecting…";
        this.setState("waiting", waiting);
        const delay = code === ROOM_FULL ? 10000 : this.retry;
        this.retry = Math.min(this.retry * 2, 15000);
        window.setTimeout(() => this.connect(), delay);
    }

    /** End for good (the host said bye, or the page gives up). */
    end(why: string): void {
        if (this.state === "ended") return;
        this.setState("ended", why);
        this.ws?.close(1000, "bye");
    }

    private raw(frame: Uint8Array): void {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        this.sentBytes += frame.length;
        this.ws.send(frame as Uint8Array<ArrayBuffer>);
    }

    private async receive(frame: Uint8Array): Promise<void> {
        if (!this.session) {
            if (!this.helloFrame) throw new Error("welcome before hello");
            this.session = await finish(
                this.link.secret,
                this.link.room,
                this.helloFrame,
                frame,
            );
            return;
        }
        const message = this.again.push(await this.session.open(frame));
        if (!message) return;
        const [header, body] = unpack(await unwrap(message));
        this.dispatch(header, body);
    }

    private dispatch(header: Header, body: Uint8Array): void {
        const t = header.t;
        if (t === "hi") {
            this.role = header.role === "editor" ? "editor" : "viewer";
            this.retry = 1000;
            this.setState("open");
        } else if (t === "ws") {
            this.sockets
                .get(Number(header.c))
                ?.message(new TextDecoder().decode(body));
        } else if (t === "close") {
            this.sockets
                .get(Number(header.c))
                ?.ended(
                    Number(header.code) || 1000,
                    String(header.reason ?? ""),
                );
        } else if (t === "res") {
            this.fetches
                .get(Number(header.id))
                ?.head(
                    Number(header.status),
                    (header.headers ?? {}) as Record<string, string>,
                );
        } else if (t === "body") {
            this.fetches.get(Number(header.id))?.chunk(body);
        } else if (t === "end") {
            const id = Number(header.id);
            this.fetches.get(id)?.end();
            this.fetches.delete(id);
        } else if (t === "bye") {
            this.end(
                String(header.reason ?? "the person sharing the deck ended it"),
            );
        }
    }

    /** Send one message (sealed in order, in as many frames as it takes). */
    send(header: Header, body?: Uint8Array): void {
        const session = this.session;
        if (!session || this.state !== "open") return;
        const parts = chunks(wrap(pack(header, body)));
        // Seal every chunk now (sequence numbers in call order), send them in
        // that order.
        const sealed = parts.map((p) => session.seal(p));
        this.sending = this.sending.then(async () => {
            for (const frame of sealed) {
                try {
                    const bytes = await frame;
                    if (this.session === session) this.raw(bytes);
                } catch {
                    return;
                }
            }
        });
    }

    // ── What pages use ──

    openSocket(): RelaySocket {
        const sock = new RelaySocket(this, this.nextCid++);
        this.sockets.set(sock.cid, sock);
        if (this.state === "ended") {
            window.setTimeout(() => sock.ended(SENT_AWAY, this.detail), 0);
            return sock;
        }
        void this.whenOpen().then(() => {
            if (sock.readyState !== 0) return;
            this.send({ t: "open", c: sock.cid });
            sock.opened();
        });
        return sock;
    }

    forget(cid: number): void {
        this.sockets.delete(cid);
    }

    /** A GET through the channel; returns how to cancel it. */
    fetch(path: string, range: string | null, sink: FetchSink): () => void {
        const id = this.nextRid++;
        let cancelled = false;
        if (this.state === "ended") {
            sink.error(this.detail || "not connected");
            return () => {};
        }
        void this.whenOpen().then(() => {
            if (cancelled) return;
            this.fetches.set(id, sink);
            this.send({ t: "get", id, path, ...(range ? { range } : {}) });
        });
        return () => {
            cancelled = true;
            if (this.fetches.delete(id)) this.send({ t: "cancel", id });
        };
    }

    /** A whole response, for the page itself. */
    fetchAll(path: string): Promise<{
        status: number;
        headers: Record<string, string>;
        body: Uint8Array;
    }> {
        return new Promise((resolve, reject) => {
            let status = 0;
            let headers: Record<string, string> = {};
            const parts: Uint8Array[] = [];
            this.fetch(path, null, {
                head: (s, h) => {
                    status = s;
                    headers = h;
                },
                chunk: (b) => parts.push(b),
                end: () => {
                    const body = new Uint8Array(
                        parts.reduce((n, p) => n + p.length, 0),
                    );
                    let at = 0;
                    for (const p of parts) {
                        body.set(p, at);
                        at += p.length;
                    }
                    resolve({ status, headers, body });
                },
                error: (m) => reject(new Error(m)),
            });
        });
    }
}
