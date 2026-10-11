// The browser's half of the encryption against the vectors the Python half
// writes (tests/data/online_vectors.json, checked by tests/test_online.py
// too): the same keys, handshake frames and sealed bytes, or guests and
// hosts would not understand each other.

import { describe, expect, test } from "vitest";
import vectors from "../../../tests/data/online_vectors.json" with {
    type: "json",
};
import {
    authKey,
    CryptoError,
    finish,
    hello,
    roomId,
    Session,
    seal,
    sessionKeys,
    unb64u,
    unseal,
} from "./crypto";
import { chunks, pack, Reassembler, unpack, unwrap, wrap } from "./frames";

const hex = (h: string) =>
    new Uint8Array((h.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));
const toHex = (b: Uint8Array) =>
    Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const link = unb64u(vectors.link);
const room = vectors.room;

async function aes(raw: Uint8Array, use: KeyUsage) {
    return crypto.subtle.importKey(
        "raw",
        raw.slice().buffer,
        "AES-GCM",
        false,
        [use],
    );
}

describe("keys", () => {
    test("the room id is the hash of the room secret", async () => {
        expect(await roomId(unb64u(vectors.roomSecret))).toBe(room);
    });

    test("auth and session keys", async () => {
        expect(toHex(await authKey(link, room))).toBe(vectors.authKey);
        const keys = await sessionKeys(
            link,
            room,
            hex(vectors.cnonce),
            hex(vectors.snonce),
        );
        expect(toHex(keys.g2h)).toBe(vectors.g2h);
        expect(toHex(keys.h2g)).toBe(vectors.h2g);
    });
});

describe("handshake", () => {
    test("the hello is the host's", async () => {
        expect(toHex(await hello(link, room, hex(vectors.cnonce)))).toBe(
            vectors.hello,
        );
    });

    test("the host's welcome is accepted, a forged one is not", async () => {
        const h = hex(vectors.hello);
        const session = await finish(link, room, h, hex(vectors.welcome));
        expect(session.sent).toBe(0);
        const forged = hex(vectors.welcome);
        forged[40] ^= 1;
        await expect(finish(link, room, h, forged)).rejects.toThrow(
            CryptoError,
        );
        // Another link's guest cannot take this welcome either.
        const other = new Uint8Array(32).fill(3);
        await expect(
            finish(other, room, h, hex(vectors.welcome)),
        ).rejects.toThrow(CryptoError);
    });
});

describe("frames", () => {
    test("sealed exactly as the host seals", async () => {
        const key = await aes(hex(vectors.h2g), "encrypt");
        const sealed = await seal(key, vectors.seq, hex(vectors.message));
        expect(toHex(sealed)).toBe(vectors.sealed);
    });

    test("opened in order only", async () => {
        const key = await aes(hex(vectors.h2g), "decrypt");
        const frame = hex(vectors.sealed);
        expect(toHex(await unseal(key, vectors.seq, frame))).toBe(
            vectors.message,
        );
        // Replayed or reordered (another number due) or tampered.
        await expect(unseal(key, vectors.seq + 1, frame)).rejects.toThrow(
            CryptoError,
        );
        const bad = frame.slice();
        bad[bad.length - 1] ^= 1;
        await expect(unseal(key, vectors.seq, bad)).rejects.toThrow(
            CryptoError,
        );
    });

    test("a session's frames go both ways in sequence", async () => {
        const a = await Session.create(hex(vectors.g2h), hex(vectors.h2g));
        const b = await Session.create(hex(vectors.h2g), hex(vectors.g2h));
        const frames = await Promise.all(
            [1, 2, 3].map((n) => a.seal(new Uint8Array([n]))),
        );
        for (const [i, f] of frames.entries()) {
            expect(Array.from(await b.open(f))).toEqual([i + 1]);
        }
        await expect(b.open(frames[0])).rejects.toThrow(CryptoError);
    });

    test("envelope and chunks", () => {
        const [header, body] = unpack(hex(vectors.message));
        expect(header).toEqual({ t: "ws", c: 1 });
        expect(new TextDecoder().decode(body)).toBe('{"type":"hello"}');
        expect(toHex(pack({ t: "ws", c: 1 }, body))).toBe(vectors.message);
        const parts = chunks(
            Uint8Array.from({ length: 10 }, (_, i) => i),
            4,
        );
        expect(parts.map(toHex)).toEqual(vectors.chunks);
        const again = new Reassembler();
        expect(again.push(parts[0])).toBeNull();
        expect(again.push(parts[1])).toBeNull();
        expect(Array.from(again.push(parts[2]) ?? [])).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
        ]);
        expect(toHex(wrap(hex(vectors.message)))).toBe(vectors.wrapped);
        // A message over the limit is refused, not buffered.
        expect(() => new Reassembler(2).push(parts[0])).toThrow();
    });
});

describe("message coding", () => {
    test("what the host deflates, the guest inflates", async () => {
        const text = new TextDecoder().decode(
            await unwrap(hex(vectors.deflated)),
        );
        expect(text).toBe(vectors.deflatable);
        expect(toHex(await unwrap(hex(vectors.wrapped)))).toBe(vectors.message);
    });

    test("a coding it does not know, or a bomb, is refused", async () => {
        await expect(unwrap(new Uint8Array([7, 1]))).rejects.toThrow();
        await expect(unwrap(hex(vectors.deflated), 100)).rejects.toThrow(
            "too large",
        );
    });
});
