// "Share via SSH" in the Share dialog (share.ts): the commands, with Copy.
// Two variants, by where this editor runs: on this computer, how to move the
// deck to a server and edit it there through an SSH tunnel; on such a server
// (SSH mode), the tunnel and the link to send each collaborator. The words
// and commands come from sshtext.ts (pure, tested).

import { clear, h } from "./dom";
import {
    codeParts,
    guestMessage,
    guestTunnel,
    linkAt,
    moveSteps,
    nextTimeCommand,
    parsePort,
    type SshInfo,
    type Step,
} from "./sshtext";

export interface SshStatus {
    sharing: boolean;
    links: { address: string; editor: string; view: string }[];
    port: number;
    ssh?: boolean;
    sshInfo?: SshInfo | null;
}

export interface SshViewOptions {
    back: () => void;
    copy: (text: string, what: string) => void;
    turnOn: () => void;
}

export interface SshView {
    element: HTMLElement;
    /** A new `share-status`: the inputs keep what is typed in them. */
    update: (status: SshStatus) => void;
}

const LOGIN_KEY = "inkflow-ssh-login";
const SERVER_KEY = "inkflow-ssh-server";

function stored(key: string): string {
    try {
        return localStorage.getItem(key) ?? "";
    } catch {
        return "";
    }
}

function store(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Private mode: the field is simply not remembered.
    }
}

/** Text with `code` spans. */
function rich(text: string): (Node | string)[] {
    return codeParts(text).map((p) =>
        p.code ? h("code", {}, p.text) : p.text,
    );
}

function commandBlock(
    text: string,
    what: string,
    copy: SshViewOptions["copy"],
): HTMLElement {
    return h(
        "div",
        { class: "ssh-copy" },
        h("pre", { class: "ssh-command" }, text),
        h(
            "button",
            { type: "button", class: "pbtn", onclick: () => copy(text, what) },
            "Copy",
        ),
    );
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
    return h(
        "label",
        { class: "ssh-field" },
        h("span", { class: "field-label" }, label),
        input,
        hint ? h("span", { class: "hint" }, hint) : null,
    );
}

function textInput(value: string, placeholder: string, width?: string) {
    return h("input", {
        type: "text",
        value,
        placeholder,
        spellcheck: "false",
        autocomplete: "off",
        style: width ? `width:${width}` : undefined,
    });
}

function stepList(steps: Step[], copy: SshViewOptions["copy"]): HTMLElement {
    const list = h("ol", { class: "ssh-steps" });
    for (const step of steps) {
        list.append(
            h(
                "li",
                {},
                h("strong", {}, step.title),
                h("p", {}, ...rich(step.text)),
                step.commands.length
                    ? commandBlock(step.commands.join("\n"), "Command", copy)
                    : null,
                ...step.notes.map((n) => h("p", { class: "hint" }, ...rich(n))),
            ),
        );
    }
    return list;
}

function header(title: string, back: () => void): HTMLElement {
    return h(
        "div",
        { class: "ssh-head" },
        h("button", { type: "button", class: "pbtn", onclick: back }, "← Back"),
        h("h3", {}, title),
    );
}

/** The three computers involved, `here` marked: your laptop and each
 * collaborator's reach the one server that runs inkflow through tunnels. */
export function setupPicture(here: "laptop" | "server"): HTMLElement {
    const box = (title: string, lines: string[], mark: boolean) =>
        h(
            "div",
            { class: `ssh-box${mark ? " here" : ""}` },
            mark ? h("span", { class: "ssh-here" }, "you are here") : null,
            h("strong", {}, title),
            ...lines.map((l) => h("span", {}, l)),
        );
    const tunnel = (dir: "right" | "left") =>
        h(
            "div",
            { class: "ssh-tunnel" },
            h(
                "span",
                { class: "ssh-across" },
                dir === "right" ? "SSH tunnel →" : "← SSH tunnel",
            ),
            h(
                "span",
                { class: "ssh-down" },
                dir === "right" ? "↓ SSH tunnel" : "↑ SSH tunnel",
            ),
        );
    return h(
        "div",
        { class: "ssh-picture" },
        h(
            "div",
            { class: "ssh-machines" },
            box(
                "Your computer",
                ["a browser", "opens the owner link"],
                here === "laptop",
            ),
            tunnel("right"),
            box(
                "The server",
                ["runs inkflow", "holds the deck (a git clone)"],
                here === "server",
            ),
            tunnel("left"),
            box(
                "Each collaborator's computer",
                ["a browser + ssh", "opens an editor or view link"],
                false,
            ),
        ),
        h(
            "p",
            { class: "hint" },
            "Your collaborators install nothing: no inkflow, no git, no copy of the deck. They need an SSH login on the server and a browser. Give each their own login: someone logged in with your account is you there (your files, your shell, your owner link).",
        ),
    );
}

/** A: the deck runs on this computer; move it to a server. */
function moveView(status: SshStatus, opts: SshViewOptions): SshView {
    let current = status;
    const login = textInput(
        stored(LOGIN_KEY),
        "you@server.example.com",
        "100%",
    );
    const port = textInput(String(status.port), String(status.port), "7em");
    const out = h("div", { class: "ssh-out" });
    const draw = () => {
        clear(out);
        const info = current.sshInfo;
        if (!info) {
            out.append(h("p", { class: "hint" }, "…"));
            return;
        }
        const p = parsePort(port.value, current.port);
        out.append(stepList(moveSteps(info, login.value, p), opts.copy));
        out.append(
            h("h3", {}, "Next time"),
            h(
                "p",
                {},
                "Log in, update the deck and start the editor in one go (it stops when the connection closes):",
            ),
            commandBlock(
                nextTimeCommand(info, login.value, p),
                "Command",
                opts.copy,
            ),
        );
    };
    login.addEventListener("input", () => {
        store(LOGIN_KEY, login.value.trim());
        draw();
    });
    port.addEventListener("input", draw);
    const element = h(
        "div",
        { class: "ssh-view" },
        header(
            "Move this deck to a server and edit it there together",
            opts.back,
        ),
        h(
            "p",
            {},
            "On a server you and your collaborators can log in to over SSH, the deck runs once for everyone: each of you opens it through an SSH tunnel, and nothing listens on the network. The steps below are yours; the last ones give you the message to send your collaborators.",
        ),
        setupPicture("laptop"),
        h(
            "div",
            { class: "ssh-fields" },
            field("Server login", login),
            field("Port", port),
        ),
        out,
    );
    draw();
    return {
        element,
        update: (s) => {
            const had = current.sshInfo;
            current = s;
            if (!had && s.sshInfo) draw();
        },
    };
}

/** B: this editor runs on a server in SSH mode; invite collaborators. */
function inviteView(status: SshStatus, opts: SshViewOptions): SshView {
    let current = status;
    const info = status.sshInfo;
    const guess = stored(SERVER_KEY) || info?.serverNames[0] || "";
    const server = textInput(guess, "server.example.com", "100%");
    const localPort = textInput(
        String(status.port),
        String(status.port),
        "7em",
    );
    const out = h("div", { class: "ssh-out" });
    let drawn = "";
    const draw = (force = false) => {
        const s = current;
        const key = JSON.stringify([
            s.sharing,
            s.links,
            server.value,
            localPort.value,
        ]);
        if (!force && key === drawn) return;
        drawn = key;
        clear(out);
        if (!s.sharing || !s.links.length) {
            out.append(
                h(
                    "div",
                    { class: "share-state" },
                    h(
                        "p",
                        {},
                        "The links are off. Turn them on to invite people; they still reach the deck only through SSH.",
                    ),
                    h(
                        "button",
                        {
                            type: "button",
                            class: "pbtn primary",
                            onclick: opts.turnOn,
                        },
                        "Turn on links",
                    ),
                ),
            );
            return;
        }
        const link = s.links[0];
        const local = parsePort(localPort.value, s.port);
        const host = server.value.trim();
        for (const [role, url, title] of [
            ["editor", link.editor, "For an editor"],
            ["viewer", link.view, "For a viewer"],
        ] as const) {
            const message = guestMessage(role, url, host, local, s.port);
            out.append(
                h("h3", {}, title),
                h(
                    "p",
                    { class: "hint" },
                    role === "editor"
                        ? "Edits the deck with you."
                        : "Watches the presentation and follows your slide.",
                ),
                commandBlock(message, "Message", opts.copy),
                h(
                    "details",
                    { class: "ssh-parts" },
                    h("summary", {}, "The command and the link alone"),
                    commandBlock(
                        guestTunnel(host, local, s.port),
                        "Command",
                        opts.copy,
                    ),
                    commandBlock(linkAt(url, local), "Link", opts.copy),
                ),
            );
        }
        out.append(
            h(
                "p",
                { class: "hint" },
                "Whoever has the editor link and a login on this server can edit the deck's files (not the server's, and not git or programs). New links in the Share dialog disconnects everyone holding the old ones.",
            ),
        );
    };
    server.addEventListener("input", () => {
        store(SERVER_KEY, server.value.trim());
        draw();
    });
    localPort.addEventListener("input", () => draw());
    const user = info?.user ? ` (you logged in as ${info.user})` : "";
    const element = h(
        "div",
        { class: "ssh-view" },
        header("Invite collaborators through SSH", opts.back),
        h(
            "p",
            {},
            `This editor runs on a server in SSH mode${user}. Each collaborator logs in to it with their own SSH account, forwarding a port, and opens their link through that tunnel. Nothing listens on the network.`,
        ),
        setupPicture("server"),
        h(
            "div",
            { class: "ssh-fields" },
            field(
                "Server address",
                server,
                info?.serverNames.length
                    ? `The name they log in to (guessed: ${info.serverNames.join(", ")}).`
                    : "The name they log in to.",
            ),
            field(
                "Their local port",
                localPort,
                "Where the tunnel ends on their computer; another one if theirs is busy.",
            ),
        ),
        out,
    );
    draw(true);
    return {
        element,
        update: (s) => {
            current = s;
            const names = s.sshInfo?.serverNames ?? [];
            if (!server.value && names.length) server.value = names[0];
            draw();
        },
    };
}

/** The view for `status`: invite (SSH mode) or move (this computer). */
export function sshView(status: SshStatus, opts: SshViewOptions): SshView {
    return status.ssh ? inviteView(status, opts) : moveView(status, opts);
}
