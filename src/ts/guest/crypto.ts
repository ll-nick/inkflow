// End-to-end encryption between this browser and the host's inkflow, in Web
// Crypto: the same derivations, handshake and frames as
// src/inkflow/online/crypto.py (the vectors in tests/data/online_vectors.json
// hold both sides to it).
//
// - auth key = HKDF-SHA256(link secret, info "inkflow/1 auth <room>");
// - hello = 0x01 | guest nonce (32) | HMAC(auth, "hello" | nonce);
// - welcome = 0x02 | host nonce (32) | HMAC(auth, "welcome" | both nonces),
//   which only the host (who has the link secret) can make;
// - session keys = HKDF(link secret, salt = both nonces, "inkflow/1 g2h|h2g
//   <room>"), new for each connection;
// - data frame = 0x03 | seq (u64) | AES-256-GCM(nonce = 0000 | seq,
//   AAD = the 9 header bytes), each side expecting exactly the next seq.

export const HELLO = 1;
export const WELCOME = 2;
export const DATA = 3;
export const NONCE_BYTES = 32;
export const HEADER_BYTES = 9;
export const TAG_BYTES = 16;
export const MAX_FRAME = 512 * 1024;
export const MAX_PLAINTEXT = MAX_FRAME - HEADER_BYTES - TAG_BYTES;

const subtle = (): SubtleCrypto => {
    if (!globalThis.crypto?.subtle) {
        throw new Error(
            "this page needs a secure connection (https) for its encryption",
        );
    }
    return globalThis.crypto.subtle;
};

const enc = new TextEncoder();

// ── Encodings ──

export function b64u(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text: string): Uint8Array {
    const s = atob(
        text.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (text.length % 4)) % 4),
    );
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// Web Crypto takes BufferSource; a view over its own ArrayBuffer always is.
function buf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

export function isRoomId(text: string): boolean {
    return /^[A-Za-z0-9_-]{22}$/.test(text);
}

export async function roomId(roomSecret: Uint8Array): Promise<string> {
    const digest = await subtle().digest(
        "SHA-256",
        buf(concat(enc.encode("inkflow-room/1"), roomSecret)),
    );
    return b64u(new Uint8Array(digest)).slice(0, 22);
}

// ── Keys ──

export async function hkdf(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: string,
): Promise<Uint8Array> {
    const key = await subtle().importKey("raw", buf(ikm), "HKDF", false, [
        "deriveBits",
    ]);
    const bits = await subtle().deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: buf(salt),
            info: buf(enc.encode(info)),
        },
        key,
        256,
    );
    return new Uint8Array(bits);
}

export function authKey(link: Uint8Array, room: string): Promise<Uint8Array> {
    return hkdf(link, new Uint8Array(0), `inkflow/1 auth ${room}`);
}

export async function sessionKeys(
    link: Uint8Array,
    room: string,
    cnonce: Uint8Array,
    snonce: Uint8Array,
): Promise<{ g2h: Uint8Array; h2g: Uint8Array }> {
    const salt = concat(cnonce, snonce);
    return {
        g2h: await hkdf(link, salt, `inkflow/1 g2h ${room}`),
        h2g: await hkdf(link, salt, `inkflow/1 h2g ${room}`),
    };
}

async function mac(key: Uint8Array, ...parts: Uint8Array[]) {
    const k = await subtle().importKey(
        "raw",
        buf(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    return new Uint8Array(
        await subtle().sign("HMAC", k, buf(concat(...parts))),
    );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// ── Handshake ──

export async function hello(
    link: Uint8Array,
    room: string,
    cnonce?: Uint8Array,
): Promise<Uint8Array> {
    const nonce =
        cnonce ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
    const tag = await mac(
        await authKey(link, room),
        enc.encode("hello"),
        nonce,
    );
    return concat(new Uint8Array([HELLO]), nonce, tag);
}

export class CryptoError extends Error {}

/** The guest's session once the host's welcome checks out. */
export async function finish(
    link: Uint8Array,
    room: string,
    helloFrame: Uint8Array,
    frame: Uint8Array,
): Promise<Session> {
    if (frame.length !== 1 + NONCE_BYTES + 32 || frame[0] !== WELCOME) {
        throw new CryptoError("not a welcome frame");
    }
    const cnonce = helloFrame.slice(1, 1 + NONCE_BYTES);
    const snonce = frame.slice(1, 1 + NONCE_BYTES);
    const expected = await mac(
        await authKey(link, room),
        enc.encode("welcome"),
        cnonce,
        snonce,
    );
    if (!sameBytes(frame.slice(1 + NONCE_BYTES), expected)) {
        throw new CryptoError("the welcome is not from the host");
    }
    const { g2h, h2g } = await sessionKeys(link, room, cnonce, snonce);
    return Session.create(g2h, h2g);
}

// ── Sealed frames ──

function header(seq: number): Uint8Array {
    const out = new Uint8Array(HEADER_BYTES);
    out[0] = DATA;
    new DataView(out.buffer).setBigUint64(1, BigInt(seq));
    return out;
}

function nonce(seq: number): Uint8Array {
    const out = new Uint8Array(12);
    new DataView(out.buffer).setBigUint64(4, BigInt(seq));
    return out;
}

function aesKey(raw: Uint8Array, use: KeyUsage): Promise<CryptoKey> {
    return subtle().importKey("raw", buf(raw), "AES-GCM", false, [use]);
}

export async function seal(
    key: CryptoKey,
    seq: number,
    plaintext: Uint8Array,
): Promise<Uint8Array> {
    const head = header(seq);
    const sealed = await subtle().encrypt(
        { name: "AES-GCM", iv: buf(nonce(seq)), additionalData: buf(head) },
        key,
        buf(plaintext),
    );
    return concat(head, new Uint8Array(sealed));
}

export async function unseal(
    key: CryptoKey,
    expect: number,
    frame: Uint8Array,
): Promise<Uint8Array> {
    if (frame.length < HEADER_BYTES + TAG_BYTES || frame[0] !== DATA) {
        throw new CryptoError("not a data frame");
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    const seq = Number(view.getBigUint64(1));
    if (seq !== expect) {
        throw new CryptoError(`frame ${seq} where ${expect} was due`);
    }
    try {
        const plain = await subtle().decrypt(
            {
                name: "AES-GCM",
                iv: buf(nonce(seq)),
                additionalData: buf(frame.slice(0, HEADER_BYTES)),
            },
            key,
            buf(frame.slice(HEADER_BYTES)),
        );
        return new Uint8Array(plain);
    } catch {
        throw new CryptoError("frame failed authentication");
    }
}

/** One connection: this side's sending key and sequence, and the other's. */
export class Session {
    sent = 0;
    received = 0;
    // Frames are sealed and opened one at a time, in order (each awaits the
    // one before), so the sequence numbers match the order on the wire.
    private sealing: Promise<unknown> = Promise.resolve();
    private opening: Promise<unknown> = Promise.resolve();

    private constructor(
        private sendKey: CryptoKey,
        private recvKey: CryptoKey,
    ) {}

    static async create(send: Uint8Array, recv: Uint8Array): Promise<Session> {
        return new Session(
            await aesKey(send, "encrypt"),
            await aesKey(recv, "decrypt"),
        );
    }

    seal(plaintext: Uint8Array): Promise<Uint8Array> {
        const seq = this.sent++;
        const next = this.sealing.then(() =>
            seal(this.sendKey, seq, plaintext),
        );
        this.sealing = next.catch(() => {});
        return next;
    }

    open(frame: Uint8Array): Promise<Uint8Array> {
        const seq = this.received++;
        const next = this.opening.then(() => unseal(this.recvKey, seq, frame));
        this.opening = next.catch(() => {});
        return next;
    }
}
