import { describe, expect, it } from "vitest";
import {
    agentCommand,
    agentPrompt,
    deckDir,
    shellQuote,
    summary,
    type Worktree,
} from "./worktreetext";

const wt: Worktree = {
    name: "bolder",
    path: "/home/me/talks/.inkflow/worktrees/bolder",
    branch: "deck/bolder",
    head: "abc1234",
    deck: "/home/me/talks/.inkflow/worktrees/bolder/q3/deck.py",
    dirty: false,
    ahead: 0,
    behind: 0,
    main: false,
};

describe("worktree words", () => {
    it("sums up a worktree's state", () => {
        expect(summary(wt)).toBe("up to date");
        expect(summary({ ...wt, ahead: 2, behind: 1, dirty: true })).toBe(
            "2 ahead · 1 behind · uncommitted changes",
        );
        expect(summary({ ...wt, deck: null })).toBe("no deck");
    });

    it("tells an agent where to work", () => {
        const text = agentPrompt(wt);
        expect(text).toContain(`--deck ${wt.deck}`);
        expect(text).toContain("branch deck/bolder");
        expect(text).toContain("Do not merge");
        expect(agentCommand(wt)).toBe(
            "cd /home/me/talks/.inkflow/worktrees/bolder/q3 && claude",
        );
    });

    it("quotes paths a shell would split", () => {
        expect(shellQuote("/a/b c/it's")).toBe("'/a/b c/it'\\''s'");
        expect(shellQuote("C:\\decks\\talk")).toBe("C:\\decks\\talk");
        expect(deckDir("C:\\decks\\talk\\deck.py")).toBe("C:\\decks\\talk");
    });
});
