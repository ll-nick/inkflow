import { describe, expect, it } from "vitest";
import {
    codeParts,
    guestMessage,
    guestTunnel,
    linkAt,
    moveSteps,
    nextTimeCommand,
    parsePort,
    type SshInfo,
    shellQuote,
    startCommand,
} from "./sshtext";

function info(over: Partial<SshInfo> = {}): SshInfo {
    return {
        port: 7777,
        serverNames: ["198.51.100.2", "box.example.org"],
        user: "tim",
        requirement: "inkflow~=0.9.0",
        inRepo: true,
        remote: "git@github.com:tim/talks.git",
        folder: "talks",
        deck: "deck.py",
        project: "",
        pinned: true,
        branch: "main",
        ...over,
    };
}

/** What a POSIX shell makes of `command`'s words, strictly: anything the
 * shell would expand or treat as an operator outside quotes (or `$`, a
 * backquote or `!` inside double quotes) throws, so a quoting mistake fails
 * instead of passing by luck. */
function shellArgs(command: string): string[] {
    const words: string[] = [];
    let word: string | null = null;
    let i = 0;
    const add = (text: string) => {
        word = (word ?? "") + text;
    };
    while (i < command.length) {
        const c = command[i];
        if (c === " ") {
            if (word !== null) words.push(word);
            word = null;
            i++;
        } else if (c === "'") {
            const end = command.indexOf("'", i + 1);
            if (end < 0) throw new Error(`unclosed ' in ${command}`);
            add(command.slice(i + 1, end));
            i = end + 1;
        } else if (c === '"') {
            let text = "";
            i++;
            while (command[i] !== '"') {
                if (i >= command.length)
                    throw new Error(`unclosed " in ${command}`);
                const d = command[i];
                if (d === "\\" && '$`"\\'.includes(command[i + 1])) {
                    text += command[i + 1];
                    i += 2;
                } else if ("$`!".includes(d)) {
                    throw new Error(`${d} expands in "…": ${command}`);
                } else {
                    text += d;
                    i++;
                }
            }
            add(text);
            i++;
        } else if (/[A-Za-z0-9_@%+=:,./-]/.test(c)) {
            add(c);
            i++;
        } else if (c === "&" && command.startsWith("&& ", i) && word === null) {
            words.push("&&");
            i += 2;
        } else {
            throw new Error(`unquoted ${c} in ${command}`);
        }
    }
    if (word !== null) words.push(word);
    return words;
}

describe("shellQuote", () => {
    it("leaves plain words alone", () => {
        expect(shellQuote("talks/deck.py")).toBe("talks/deck.py");
        expect(shellQuote("you@box.example.org")).toBe("you@box.example.org");
        expect(shellQuote("")).toBe("''");
    });

    it("quotes what a shell would split or expand", () => {
        expect(shellQuote("my talks")).toBe("'my talks'");
        expect(shellQuote("$HOME")).toBe("'$HOME'");
        expect(shellQuote("it's")).toBe(`"it's"`);
        expect(shellQuote(`it's $5`)).toBe(`'it'"'"'s $5'`);
    });

    it("round-trips through a shell", () => {
        for (const text of [
            "my talks",
            "it's",
            `it's "$5" \`x\` \\ !`,
            "a'b'c",
            "~/x",
            "*",
        ]) {
            expect(shellArgs(shellQuote(text))).toEqual([text]);
        }
    });
});

describe("ports and links", () => {
    it("reads a port or falls back", () => {
        expect(parsePort(" 8000 ", 7777)).toBe(8000);
        expect(parsePort("0", 7777)).toBe(7777);
        expect(parsePort("70000", 7777)).toBe(7777);
        expect(parsePort("80a", 7777)).toBe(7777);
    });

    it("moves a link to the tunnel's local port", () => {
        expect(linkAt("http://localhost:7777/edit?k=abc", 8000)).toBe(
            "http://localhost:8000/edit?k=abc",
        );
        expect(linkAt("http://localhost:7777/?k=abc", 7777)).toBe(
            "http://localhost:7777/?k=abc",
        );
    });

    it("splits code out of a sentence", () => {
        expect(codeParts("start `tmux` first")).toEqual([
            { text: "start ", code: false },
            { text: "tmux", code: true },
            { text: " first", code: false },
        ]);
    });
});

describe("moving the deck to a server", () => {
    it("runs inkflow with uv run when the deck pins it", () => {
        expect(startCommand(info(), 7777)).toBe(
            "uv run inkflow edit --no-open --ssh",
        );
        expect(
            startCommand(
                info({ project: "keynote", deck: "keynote/deck.py" }),
                8022,
            ),
        ).toBe(
            "uv run --project keynote inkflow edit --no-open --ssh --port 8022 --deck keynote/deck.py",
        );
    });

    it("installs inkflow as a tool otherwise", () => {
        const steps = moveSteps(info({ pinned: false }), "tim@box", 7777);
        const install = steps[2].commands;
        expect(install).toContain("uv tool install 'inkflow~=0.9.0'");
        expect(steps[3].commands).toEqual(["inkflow edit --no-open --ssh"]);
    });

    it("writes every step for an example", () => {
        const steps = moveSteps(
            info({ folder: "my talks" }),
            " tim@box.example.org ",
            7777,
        );
        expect(steps.map((s) => s.title)).toEqual([
            "Push your latest changes",
            "Log in to the server with the port forwarded",
            "On the server, once: install inkflow and get the deck",
            "Start the editor",
            "On this computer, open the owner link",
            "Invite others",
            "When you are done",
        ]);
        expect(steps[1].commands).toEqual([
            "ssh -L 7777:localhost:7777 tim@box.example.org",
        ]);
        expect(steps[2].commands).toEqual([
            "curl -LsSf https://astral.sh/uv/install.sh | sh",
            "source $HOME/.local/bin/env",
            "git clone git@github.com:tim/talks.git 'my talks'",
            "cd 'my talks'",
        ]);
        expect(steps[3].text).toContain("http://localhost:7777/edit?k=…");
    });

    it("asks for a remote when there is none", () => {
        const steps = moveSteps(info({ remote: null }), "", 7777);
        expect(steps[0].commands).toEqual([
            "git remote add origin <repository URL>",
            "git push -u origin main",
        ]);
        expect(steps[1].commands).toEqual([
            "ssh -L 7777:localhost:7777 you@server",
        ]);
        expect(steps[2].commands).toContain("git clone <repository URL> talks");
        const outside = moveSteps(
            info({ inRepo: false, remote: null }),
            "",
            7777,
        );
        expect(outside[0].text).toContain("not in a git repository");
    });

    it("starts again next time in one command", () => {
        expect(nextTimeCommand(info(), "tim@box", 7777)).toBe(
            `ssh -t -L 7777:localhost:7777 tim@box "bash -lc 'cd talks && git pull && uv run inkflow edit --no-open --ssh'"`,
        );
        const odd = nextTimeCommand(
            info({ folder: "my talks", deck: "a b/deck.py" }),
            "tim@box",
            8022,
        );
        // The server's shell gets bash -lc and the whole command as one.
        const args = shellArgs(odd);
        expect(args.slice(0, 4)).toEqual([
            "ssh",
            "-t",
            "-L",
            "8022:localhost:8022",
        ]);
        const remote = shellArgs(args[5]);
        expect(remote.slice(0, 2)).toEqual(["bash", "-lc"]);
        expect(remote[2]).toBe(
            "cd 'my talks' && git pull && uv run inkflow edit --no-open --ssh --port 8022 --deck 'a b/deck.py'",
        );
        expect(shellArgs(remote[2].split(" && ")[0])).toEqual([
            "cd",
            "my talks",
        ]);
    });
});

describe("inviting collaborators", () => {
    const link = "http://localhost:7777/edit?k=TOKEN";

    it("writes their tunnel with a placeholder for their login", () => {
        expect(guestTunnel("box.example.org", 7777, 7777)).toBe(
            "ssh -N -L 7777:localhost:7777 <your-user>@box.example.org",
        );
        expect(guestTunnel(" ", 8000, 7777)).toBe(
            "ssh -N -L 8000:localhost:7777 <your-user>@server",
        );
    });

    it("writes the message with the link at their local port", () => {
        const same = guestMessage("editor", link, "box", 7777, 7777);
        expect(same).toContain("To edit the deck with me");
        expect(same).toContain(
            "   ssh -N -L 7777:localhost:7777 <your-user>@box",
        );
        expect(same).toContain("   http://localhost:7777/edit?k=TOKEN");
        expect(same).toContain("PowerShell");
        expect(same).toContain("If port 7777 is taken");
        const other = guestMessage(
            "viewer",
            "http://localhost:7777/?k=V",
            "box",
            8000,
            7777,
        );
        expect(other).toContain("To watch the presentation");
        expect(other).toContain(
            "ssh -N -L 8000:localhost:7777 <your-user>@box",
        );
        expect(other).toContain("   http://localhost:8000/?k=V");
        expect(other).not.toContain("is taken");
    });
});
