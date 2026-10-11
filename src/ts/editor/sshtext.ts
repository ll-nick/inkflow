// What "Share via SSH" says (sshdialog.ts): the commands to move a deck to a
// server and edit it there through an SSH tunnel, and the message inviting a
// collaborator through a tunnel of their own. Pure, so every command is
// tested without a page; the facts come from the server's `share-status`
// (`sshInfo`, inkflow/sshshare.py).

export interface SshInfo {
    port: number;
    /** Guesses at the server's name: the address the SSH login reached,
     * its fully qualified name, its host name. */
    serverNames: string[];
    /** The login of the user running inkflow. */
    user: string;
    /** `inkflow~=X.Y.Z`: the version this deck runs on. */
    requirement: string;
    inRepo: boolean;
    remote: string | null;
    /** The repository's folder name (where `git clone` puts it). */
    folder: string;
    /** deck.py relative to the repository's root. */
    deck: string;
    /** The folder of the pyproject.toml near the deck ("" = the root). */
    project: string | null;
    /** That pyproject.toml pins inkflow: `uv run inkflow` installs it. */
    pinned: boolean;
    branch: string;
}

export interface Step {
    title: string;
    /** Sentences; `backticks` mark code. */
    text: string;
    /** Commands to copy, one per line. */
    commands: string[];
    notes: string[];
}

export const DEFAULT_PORT = 7777;
export const LOGIN_PLACEHOLDER = "you@server";
export const USER_PLACEHOLDER = "<your-user>";

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** `text` as one argument to a POSIX shell (and PowerShell, for what the
 * commands here contain): as it is when nothing in it is special, else in
 * single quotes, else in double quotes, else single quotes with each `'`
 * spelled `'"'"'`. */
export function shellQuote(text: string): string {
    if (text === "") return "''";
    if (SAFE.test(text)) return text;
    if (!text.includes("'")) return `'${text}'`;
    if (!/[$`"\\!]/.test(text)) return `"${text}"`;
    return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/** A port typed in a field, or `fallback` when it is not one. */
export function parsePort(text: string, fallback: number): number {
    const t = text.trim();
    if (!/^\d{1,5}$/.test(t)) return fallback;
    const n = Number(t);
    return n >= 1 && n <= 65535 ? n : fallback;
}

/** `ssh -L` with `local` on this computer forwarded to `remote` on the
 * server's own localhost. */
export function forward(local: number, remote: number): string {
    return `-L ${local}:localhost:${remote}`;
}

/** A link of the server's (`http://localhost:7777/...`) as it is opened
 * through a tunnel ending at `port`. */
export function linkAt(url: string, port: number): string {
    try {
        const u = new URL(url);
        u.port = String(port);
        return u.toString();
    } catch {
        return url;
    }
}

/** Splits `text` at backticks: odd parts are code. */
export function codeParts(text: string): { text: string; code: boolean }[] {
    return text
        .split("`")
        .map((part, i) => ({ text: part, code: i % 2 === 1 }))
        .filter((p) => p.text !== "");
}

function login(text: string): string {
    const t = text.trim();
    return shellQuote(t || LOGIN_PLACEHOLDER);
}

/** How the server runs inkflow: `uv run` when the deck's pyproject.toml
 * pins it (uv installs it on first run), else the installed tool. */
export function inkflowCommand(info: SshInfo): string {
    if (!info.pinned) return "inkflow";
    const project = info.project
        ? ` --project ${shellQuote(info.project)}`
        : "";
    return `uv run${project} inkflow`;
}

/** What starts the editor on the server, from the repository's folder. */
export function startCommand(info: SshInfo, port: number): string {
    const parts = [inkflowCommand(info), "edit", "--no-open", "--ssh"];
    if (port !== DEFAULT_PORT) parts.push("--port", String(port));
    if (info.deck !== "deck.py") parts.push("--deck", shellQuote(info.deck));
    return parts.join(" ");
}

function folderOf(info: SshInfo): string {
    return info.folder || "deck";
}

/** The steps that move this deck to a server and edit it there:
 * `loginText` is the field's `you@server`, `port` the one forwarded. */
export function moveSteps(
    info: SshInfo,
    loginText: string,
    port: number,
): Step[] {
    const to = login(loginText);
    const folder = shellQuote(folderOf(info));
    const remote = info.remote ? shellQuote(info.remote) : "<repository URL>";
    const steps: Step[] = [];

    if (info.inRepo && info.remote) {
        steps.push({
            title: "Push your latest changes",
            text: "The server clones the deck from its repository: commit and push what you changed (Git menu → Commit, then Push).",
            commands: [],
            notes: [],
        });
    } else {
        steps.push({
            title: "Give the deck a repository the server can clone",
            text: info.inRepo
                ? "The deck's repository has no remote yet. Create an empty repository (on GitHub or GitLab, say), then add it here and push:"
                : "The deck is not in a git repository yet: commit it first (Git menu), then create an empty repository (on GitHub or GitLab, say), add it and push:",
            commands: [
                "git remote add origin <repository URL>",
                `git push -u origin ${shellQuote(info.branch || "main")}`,
            ],
            notes: [],
        });
    }

    steps.push({
        title: "Log in to the server with the port forwarded",
        text: `Everything below runs on the server, in this login. The tunnel brings its port ${port} to this computer.`,
        commands: [`ssh ${forward(port, port)} ${to}`],
        notes: [
            "To keep inkflow running when the connection drops, start `tmux new -A -s inkflow` (or `screen`) first and run the next steps in it; the same command gets back to it after logging in again.",
            "A private repository: `ssh -A` lets the server clone with your own keys (whoever administers the server can use them while you are logged in), or clone with an HTTPS access token.",
        ],
    });

    const install = ["curl -LsSf https://astral.sh/uv/install.sh | sh"];
    install.push("source $HOME/.local/bin/env");
    if (!info.pinned)
        install.push(`uv tool install ${shellQuote(info.requirement)}`);
    install.push(`git clone ${remote} ${folder}`, `cd ${folder}`);
    steps.push({
        title: "On the server, once: install inkflow and get the deck",
        text: info.pinned
            ? "uv runs inkflow; the deck's pyproject.toml pins the version, which `uv run` installs the first time. Skip what the server has already."
            : "uv installs inkflow, at the version this deck runs on. Skip what the server has already.",
        commands: install,
        notes: [],
    });

    steps.push({
        title: "Start the editor",
        text: `It prints an owner link, \`http://localhost:${port}/edit?k=…\`. If it says port ${port} is taken, it uses the next free one: log in again forwarding that one.`,
        commands: [startCommand(info, port)],
        notes: [],
    });

    steps.push({
        title: "On this computer, open the owner link",
        text: "Open the link it printed in your browser here. You are the owner there, editing the server's copy of the deck; nobody else on the server is.",
        commands: [],
        notes: [],
    });

    steps.push({
        title: "Invite others",
        text: "There, Share → Share via SSH writes the commands and the message for your collaborators. They need an SSH login on the server.",
        commands: [],
        notes: [],
    });

    steps.push({
        title: "When you are done",
        text: "Commit and push on the server (its Git menu), then pull here:",
        commands: ["git pull"],
        notes: [],
    });
    return steps;
}

/** Next time, one command: log in, update and start the editor (the login
 * shell's PATH has uv). Stops when the connection closes. */
export function nextTimeCommand(
    info: SshInfo,
    loginText: string,
    port: number,
): string {
    const inner = `cd ${shellQuote(folderOf(info))} && git pull && ${startCommand(info, port)}`;
    const remote = `bash -lc ${shellQuote(inner)}`;
    return `ssh -t ${forward(port, port)} ${login(loginText)} ${shellQuote(remote)}`;
}

/** The tunnel a collaborator opens: `<your-user>` stays for them to
 * replace with their own login on `server`. */
export function guestTunnel(
    server: string,
    localPort: number,
    serverPort: number,
): string {
    const host = server.trim() || "server";
    const at = SAFE.test(host)
        ? `${USER_PLACEHOLDER}@${host}`
        : shellQuote(`${USER_PLACEHOLDER}@${host}`);
    return `ssh -N ${forward(localPort, serverPort)} ${at}`;
}

/** The message to send a collaborator: their tunnel, then their link. */
export function guestMessage(
    role: "editor" | "viewer",
    link: string,
    server: string,
    localPort: number,
    serverPort: number,
): string {
    const host = server.trim() || "server";
    const what =
        role === "editor"
            ? "To edit the deck with me"
            : "To watch the presentation";
    return [
        `${what} (you need an SSH login on ${host}):`,
        "",
        `1. In a terminal, run this, with your own login on ${host} in place of ${USER_PLACEHOLDER}. Keep it open; it shows nothing. (On Windows, the same command works in PowerShell.)`,
        "",
        `   ${guestTunnel(host, localPort, serverPort)}`,
        "",
        "2. Open this link in your browser:",
        "",
        `   ${linkAt(link, localPort)}`,
        "",
        localPort === serverPort
            ? `If port ${localPort} is taken on your computer, use another one in both places (the first number in the command and the one in the link).`
            : "",
    ]
        .join("\n")
        .trimEnd();
}
