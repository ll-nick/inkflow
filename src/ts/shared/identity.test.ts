// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clientKey, initials, saveName, storedName } from "./identity";

describe("identity", () => {
    beforeEach(() => localStorage.clear());

    it("keeps a name, trimmed and bounded", () => {
        expect(storedName()).toBeNull();
        saveName("  Ana Lima  ");
        expect(storedName()).toBe("Ana Lima");
        saveName("x".repeat(80));
        expect(storedName()).toHaveLength(40);
    });

    it("keeps one private key across reloads", () => {
        const key = clientKey();
        expect(key).toMatch(/^[0-9a-f]{36}$/);
        expect(clientKey()).toBe(key);
        expect(localStorage.getItem("inkflow-key")).toBe(key);
    });

    it("draws two letters for an avatar", () => {
        expect(initials("Ana Lima")).toBe("AL");
        expect(initials("ana")).toBe("AN");
        expect(initials("  ")).toBe("?");
    });
});
