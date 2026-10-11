import { describe, expect, it } from "vitest";
import {
    ago,
    commentTitle,
    openCount,
    slideThreads,
    type Thread,
    whereWords,
} from "./commentstext";

function thread(id: string, extra: Partial<Thread> = {}): Thread {
    return {
        id,
        slide: "intro",
        resolved: false,
        created: 100,
        messages: [
            { author: "owner", name: "Me", text: `Text ${id}`, at: 100 },
        ],
        ...extra,
    };
}

describe("threads", () => {
    const all = [
        thread("a", { created: 300 }),
        thread("b", { resolved: true, created: 50 }),
        thread("c", { created: 200 }),
        thread("d", { slide: "end" }),
    ];

    it("list a slide's open ones first, oldest first", () => {
        expect(slideThreads(all, "intro").map((t) => t.id)).toEqual([
            "c",
            "a",
            "b",
        ]);
        expect(slideThreads(all, null)).toEqual([]);
        expect(openCount(all, "intro")).toBe(2);
        expect(openCount(all, "end")).toBe(1);
    });

    it("say where they are pinned", () => {
        expect(whereWords(thread("a", { target: "zone-title" }))).toBe(
            "on #zone-title",
        );
        expect(whereWords(thread("a", { x: 10.4, y: 20.6 }))).toBe("at 10, 21");
        expect(whereWords(thread("a"))).toBe("on the slide");
    });

    it("sum up a slide's open ones", () => {
        const two = thread("a");
        two.messages.push({ author: "x", name: "", text: "ok", at: 1 });
        expect(commentTitle([two, thread("b", { resolved: true })])).toBe(
            "1 open comment\nMe: Text a (+1)",
        );
        expect(commentTitle([thread("b", { resolved: true })])).toBe("");
    });
});

describe("ago", () => {
    it("reads like a person would say it", () => {
        expect(ago(1000, 1030)).toBe("just now");
        expect(ago(1000, 1000 + 300)).toBe("5 min ago");
        expect(ago(1000, 1000 + 3 * 3600)).toBe("3 h ago");
        expect(ago(1000, 1000 + 86400)).toBe("1 day ago");
        expect(ago(0, 86400 * 30)).toBe("1970-01-01");
    });
});
