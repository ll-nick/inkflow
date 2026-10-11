import { describe, expect, it } from "vitest";
import { socketUrl } from "./wsurl";

describe("socketUrl", () => {
    it("uses the page's own host and port", () => {
        expect(socketUrl({ protocol: "http:", host: "localhost:7777" })).toBe(
            "ws://localhost:7777/_inkflow/ws",
        );
        expect(socketUrl({ protocol: "http:", host: "192.168.1.5:7779" })).toBe(
            "ws://192.168.1.5:7779/_inkflow/ws",
        );
    });

    it("keeps a forwarded port and an IPv6 host", () => {
        expect(socketUrl({ protocol: "http:", host: "localhost:8000" })).toBe(
            "ws://localhost:8000/_inkflow/ws",
        );
        expect(socketUrl({ protocol: "http:", host: "[::1]:7777" })).toBe(
            "ws://[::1]:7777/_inkflow/ws",
        );
    });

    it("goes over TLS when the page does", () => {
        expect(
            socketUrl({ protocol: "https:", host: "box.tail1234.ts.net" }),
        ).toBe("wss://box.tail1234.ts.net/_inkflow/ws");
    });
});
