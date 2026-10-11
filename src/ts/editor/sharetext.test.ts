import { describe, expect, test } from "vitest";
import { type OnlineStatus, onlineSummary } from "./sharetext";

const base: OnlineStatus = {
    available: true,
    installHint: "pip install 'inkflow[online]'",
    relay: "https://relay.example.workers.dev",
    sharing: true,
};

describe("onlineSummary", () => {
    test("not shared", () => {
        const s = onlineSummary({ ...base, sharing: false });
        expect(s.text).toContain("relay.example.workers.dev");
        expect(s.text).not.toContain("https://");
        expect(s.error).toBeNull();
    });

    test("open, counting guests", () => {
        const open = (guests: number) =>
            onlineSummary({ ...base, state: "open", guests }).text;
        expect(open(0)).toContain("no one has joined yet");
        expect(open(1)).toContain("1 guest connected");
        expect(open(3)).toContain("3 guests connected");
    });

    test("trouble says why", () => {
        const retrying = onlineSummary({
            ...base,
            state: "retrying",
            error: "cannot reach the relay",
        });
        expect(retrying.text).toContain("Reconnecting");
        expect(retrying.error).toBe("cannot reach the relay");
        const refused = onlineSummary({
            ...base,
            state: "error",
            error: "the relay refused: this relay needs its access token",
        });
        expect(refused.error).toContain("access token");
        expect(onlineSummary({ ...base, state: "connecting" }).text).toContain(
            "Connecting",
        );
    });
});
