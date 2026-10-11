// Messages inside the sealed frames, as src/inkflow/online/frames.py writes
// them: an envelope (u32 header length, JSON header, raw body), split into
// chunks whose first byte says whether it is the last one.

import { concat, MAX_PLAINTEXT } from "./crypto";

export const LAST = 1;
export const CHUNK = MAX_PLAINTEXT - 1;
export const MAX_MESSAGE = 96 * 1024 * 1024;

export type Header = Record<string, unknown> & { t: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function pack(
    header: Header,
    body: Uint8Array = new Uint8Array(0),
): Uint8Array {
    const head = enc.encode(JSON.stringify(header));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, head.length);
    return concat(len, head, body);
}

export function unpack(message: Uint8Array): [Header, Uint8Array] {
    if (message.length < 4) throw new Error("short message");
    const view = new DataView(message.buffer, message.byteOffset, 4);
    const n = view.getUint32(0);
    if (4 + n > message.length) throw new Error("header past the end");
    const header = JSON.parse(dec.decode(message.subarray(4, 4 + n)));
    if (!header || typeof header !== "object" || Array.isArray(header)) {
        throw new Error("header is not an object");
    }
    return [header as Header, message.subarray(4 + n)];
}

// A message on the wire: one byte for its coding (0 as is, 1 raw DEFLATE,
// which only the host sends), then the data. Guests send theirs as is.
export const RAW = 0;
export const DEFLATE = 1;

export function wrap(message: Uint8Array): Uint8Array {
    return concat(new Uint8Array([RAW]), message);
}

export async function unwrap(
    data: Uint8Array,
    limit = MAX_MESSAGE,
): Promise<Uint8Array> {
    if (!data.length) throw new Error("empty message");
    if (data[0] === RAW) return data.subarray(1);
    if (data[0] !== DEFLATE) throw new Error("unknown message coding");
    const stream = new Blob([data.slice(1)])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
            await reader.cancel();
            throw new Error("message too large");
        }
        parts.push(value);
    }
    return concat(...parts);
}

export function chunks(message: Uint8Array, size = CHUNK): Uint8Array[] {
    if (!message.length) return [new Uint8Array([LAST])];
    const out: Uint8Array[] = [];
    for (let i = 0; i < message.length; i += size) {
        const part = message.subarray(i, i + size);
        const last = i + size >= message.length;
        out.push(concat(new Uint8Array([last ? LAST : 0]), part));
    }
    return out;
}

export class Reassembler {
    private parts: Uint8Array[] = [];
    private size = 0;

    constructor(private limit = MAX_MESSAGE) {}

    /** The whole message once its last chunk is in, else null. */
    push(plaintext: Uint8Array): Uint8Array | null {
        if (!plaintext.length) throw new Error("empty chunk");
        this.size += plaintext.length - 1;
        if (this.size > this.limit) throw new Error("message too large");
        this.parts.push(plaintext.subarray(1));
        if (plaintext[0] & LAST) {
            const message = concat(...this.parts);
            this.parts = [];
            this.size = 0;
            return message;
        }
        return null;
    }
}
