// The guest page's service worker: every request a page makes on the relay's
// address (pictures, fonts, a video's byte ranges, downloads) is answered by
// the host, through the encrypted channel, instead of the relay — which has
// none of the deck. The worker holds no channel and no key: it hands each
// request to the page that made it (`inkflow-fetch` with a MessagePort),
// whose guest script asks the host (src/ts/guest/boot.ts), and streams the
// answer back as the response.
//
// Not handled here: the guest page's own files (/_guest/…), the relay's
// endpoints (/_relay/…) and navigations, which the relay answers with the
// guest page itself (a page inside the guest page is loaded by it, through
// the channel).

interface Port {
    postMessage(message: unknown): void;
    onmessage: ((ev: { data: Reply }) => void) | null;
    close(): void;
}

interface WindowClientLike {
    postMessage(message: unknown, transfer: unknown[]): void;
}

interface FetchEventLike {
    request: Request;
    clientId: string;
    respondWith(response: Promise<Response> | Response): void;
}

interface Scope {
    location: Location;
    clients: {
        get(id: string): Promise<WindowClientLike | undefined>;
        claim(): Promise<void>;
    };
    skipWaiting(): Promise<void>;
    addEventListener(type: string, listener: (ev: never) => void): void;
}

type Reply =
    | { type: "head"; status: number; headers: Record<string, string> }
    | { type: "chunk"; data: ArrayBuffer }
    | { type: "end" }
    | { type: "error"; message: string };

const sw = self as unknown as Scope;

sw.addEventListener("install", () => {
    void sw.skipWaiting();
});

sw.addEventListener(
    "activate",
    (ev: { waitUntil(p: Promise<unknown>): void }) => {
        ev.waitUntil(sw.clients.claim());
    },
);

// A response may have no body with these.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function relayed(ev: FetchEventLike): boolean {
    const url = new URL(ev.request.url);
    if (url.origin !== sw.location.origin) return false;
    if (url.pathname.startsWith("/_guest/")) return false;
    if (url.pathname.startsWith("/_relay/")) return false;
    if (ev.request.mode === "navigate") return false;
    return Boolean(ev.clientId);
}

sw.addEventListener("fetch", (ev: FetchEventLike) => {
    if (!relayed(ev)) return;
    ev.respondWith(answer(ev));
});

async function answer(ev: FetchEventLike): Promise<Response> {
    const request = ev.request;
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Not available through the relay", { status: 405 });
    }
    const client = await sw.clients.get(ev.clientId);
    if (!client) return fetch(request);
    const url = new URL(request.url);
    const channel = new MessageChannel();
    const port = channel.port1 as unknown as Port;
    client.postMessage(
        {
            type: "inkflow-fetch",
            path: url.pathname + url.search,
            range: request.headers.get("range"),
        },
        [channel.port2],
    );
    return new Promise<Response>((resolve) => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null =
            null;
        let answered = false;
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
            cancel() {
                port.postMessage({ type: "cancel" });
                port.close();
            },
        });
        // A page that never answers (it is not a guest page's).
        const timer = setTimeout(() => {
            if (!answered) {
                answered = true;
                resolve(
                    new Response("No answer from the host", { status: 504 }),
                );
            }
        }, 60000);
        port.onmessage = ({ data }) => {
            if (data.type === "head") {
                answered = true;
                clearTimeout(timer);
                const empty =
                    request.method === "HEAD" || NULL_BODY.has(data.status);
                resolve(
                    new Response(empty ? null : stream, {
                        status: data.status,
                        headers: data.headers,
                    }),
                );
            } else if (data.type === "chunk") {
                controller?.enqueue(new Uint8Array(data.data));
            } else if (data.type === "end") {
                controller?.close();
                port.close();
            } else if (data.type === "error") {
                clearTimeout(timer);
                if (!answered) {
                    answered = true;
                    resolve(new Response(data.message, { status: 502 }));
                } else {
                    controller?.error(new Error(data.message));
                }
                port.close();
            }
        };
    });
}
