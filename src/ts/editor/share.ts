// The owner's Share… dialog: share the deck on the local network (or a VPN)
// and stop again, without restarting; an editor link and a view link per
// address, each with Copy and a QR code; new links (everyone who joined with
// the old ones is disconnected); who is connected, with Disconnect. "Share
// via SSH" opens sshdialog.ts in its place. In SSH mode (a server others log
// in to) the links name localhost, for each guest's own tunnel, and turning
// them on never listens on the network.
// Online: the same through the user's relay (src/inkflow/online), with links
// that work from anywhere; the relay is set here or with `inkflow relay`.

import qrcode from "qrcode-generator";
import { collab } from "./collab";
import { dialogOpen, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { onMessage, sendRaw } from "./net";
import { GUIDE_URL, type OnlineStatus, onlineSummary } from "./sharetext";
import { type SshView, sshView } from "./sshdialog";
import type { SshInfo } from "./sshtext";

interface Link {
    address: string;
    editor: string;
    view: string;
}

interface ShareStatus {
    sharing: boolean;
    links: Link[];
    names: string[];
    port: number;
    /** SSH mode: links for tunnels, no network listening. */
    ssh?: boolean;
    sshInfo?: SshInfo | null;
    people: {
        id: string;
        name: string;
        role: string;
        page: string;
        slide: number | null;
        online?: boolean;
    }[];
    online?: OnlineStatus;
    error?: string;
}

let status: ShareStatus | null = null;
let body: HTMLElement | null = null;
/** "Share via SSH", shown in the dialog's place while open. */
let ssh: SshView | null = null;
const button = document.getElementById("btn-share");

/** An SVG QR code for `text` (generated here; nothing leaves the page). */
export function qrSvg(text: string): string {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
}

export function copy(text: string, what: string): void {
    const done = () => toast(`${what} copied`, "ok");
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback(): void {
        const area = h("textarea", {}, text);
        document.body.append(area);
        area.select();
        try {
            document.execCommand("copy");
            done();
        } catch {
            toast("Select the link and copy it", "error");
        }
        area.remove();
    }
}

function linkRow(
    label: string,
    url: string,
    hint: string,
    withQr = true,
): HTMLElement {
    const qr = h("div", { class: "share-qr", title: `QR code: ${label}` });
    qr.innerHTML = qrSvg(url);
    return h(
        "div",
        { class: "share-link" },
        withQr ? qr : null,
        h(
            "div",
            { class: "share-link-text" },
            h("strong", {}, label),
            h("span", { class: "hint" }, hint),
            h("input", {
                type: "text",
                readonly: true,
                value: url,
                onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
            }),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => copy(url, label),
                },
                "Copy",
            ),
        ),
    );
}

function openSsh(): void {
    if (!body || !status) return;
    ssh = sshView(status, {
        back: () => {
            ssh = null;
            render();
        },
        copy,
        turnOn: () => sendRaw({ type: "share", op: "on" }),
    });
    clear(body);
    body.append(ssh.element);
}

function sshSection(s: ShareStatus): HTMLElement {
    return h(
        "section",
        { class: "share-ssh" },
        h("h3", { class: "share-section" }, "Over SSH"),
        h(
            "div",
            { class: "share-state" },
            h(
                "p",
                { class: "hint" },
                s.ssh
                    ? "The commands and the message for each collaborator's tunnel."
                    : "Move the deck to a server you and others can log in to, and edit it there together through SSH tunnels.",
            ),
            h(
                "button",
                { type: "button", class: "pbtn", onclick: openSsh },
                "Share via SSH",
            ),
        ),
    );
}

function stateText(s: ShareStatus): string {
    if (s.ssh) {
        return s.sharing
            ? "SSH mode: people with a link below join through an SSH tunnel to this server."
            : "SSH mode: this server is reached through SSH tunnels only. Turn the links on to invite people.";
    }
    return s.sharing
        ? "Shared on the network: people with a link below can join."
        : "Only this computer can open the deck. Share it to give people on the same network (or VPN) a link.";
}

function render(): void {
    if (!body || !status) return;
    if (ssh) {
        ssh.update(status);
        return;
    }
    clear(body);
    const s = status;
    const onLabel = s.ssh ? "Turn on links" : "Share on the network";
    body.append(
        h(
            "h3",
            { class: "share-section" },
            s.ssh ? "Through SSH tunnels" : "On this network",
        ),
    );
    body.append(
        h(
            "div",
            { class: "share-state" },
            h("p", {}, stateText(s)),
            h(
                "button",
                {
                    type: "button",
                    class: s.sharing ? "pbtn" : "pbtn primary",
                    onclick: () =>
                        sendRaw({
                            type: "share",
                            op: s.sharing ? "off" : "on",
                        }),
                },
                s.sharing ? "Stop sharing" : onLabel,
            ),
        ),
    );
    if (s.error) body.append(h("p", { class: "share-error" }, s.error));
    if (s.sharing) {
        if (!s.links.length) {
            body.append(
                h(
                    "p",
                    { class: "hint" },
                    "No network address found. Start inkflow with --host <address>.",
                ),
            );
        }
        for (const link of s.links) {
            body.append(
                h(
                    "section",
                    { class: "share-address" },
                    h(
                        "h3",
                        {},
                        s.ssh ? "Through each guest's tunnel" : link.address,
                    ),
                    linkRow(
                        "Editor link",
                        link.editor,
                        "Edits the deck with you (not your computer's files, git or programs).",
                        !s.ssh,
                    ),
                    linkRow(
                        "View link",
                        link.view,
                        "Watches the presentation and follows your slide.",
                        !s.ssh,
                    ),
                ),
            );
        }
        if (s.names.length) {
            body.append(
                h(
                    "p",
                    { class: "hint" },
                    `The same links also work with ${s.names.join(", ")} in place of the address, where the network supports it.`,
                ),
            );
        }
        body.append(
            h(
                "div",
                { class: "share-actions" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => {
                            if (
                                confirm(
                                    "Make new links? Everyone who joined with the current ones is disconnected.",
                                )
                            ) {
                                sendRaw({ type: "share", op: "rotate" });
                            }
                        },
                    },
                    "New links",
                ),
            ),
            h(
                "p",
                { class: "hint" },
                s.ssh
                    ? "Each guest needs a login on this server for their tunnel; the links travel inside it, encrypted."
                    : "The links travel unencrypted on the network: on a network you do not trust, share over SSH or a VPN instead.",
            ),
        );
    }
    body.append(sshSection(s));
    if (s.online) renderOnline(body, s.online);
    const people = s.people.filter((p) => p.id !== collab.me?.id);
    body.append(
        h("h3", {}, people.length ? "Connected" : "No one else is connected"),
    );
    const list = h("ul", { class: "share-people" });
    for (const p of people) {
        const where =
            p.slide == null
                ? ""
                : p.page === "presenter"
                  ? `presenting slide ${p.slide + 1}`
                  : `on slide ${p.slide + 1}`;
        list.append(
            h(
                "li",
                {},
                h("span", { class: "who" }, p.name),
                h(
                    "span",
                    { class: "hint" },
                    `${p.role}${p.online ? " · online" : ""}${where ? ` · ${where}` : ""}`,
                ),
                p.role === "owner"
                    ? null
                    : h(
                          "button",
                          {
                              type: "button",
                              class: "pbtn",
                              onclick: () =>
                                  sendRaw({
                                      type: "share",
                                      op: "kick",
                                      id: p.id,
                                  }),
                          },
                          "Disconnect",
                      ),
            ),
        );
    }
    body.append(list);
}

// The relay form is open (no relay yet, or "Change relay…").
let editingRelay = false;

function renderOnline(into: HTMLElement, o: OnlineStatus): void {
    const sharing = o.sharing;
    into.append(h("h3", { class: "share-section" }, "Online"));
    if (!o.available) {
        into.append(
            h("p", {}, "Sharing online needs one more package here:"),
            h("p", {}, h("code", {}, o.installHint)),
        );
        return;
    }
    if (!o.relay || editingRelay) {
        into.append(relayForm(o));
        return;
    }
    const summary = onlineSummary(o);
    into.append(
        h(
            "div",
            { class: "share-state" },
            h("p", {}, summary.text),
            h(
                "button",
                {
                    type: "button",
                    class: sharing ? "pbtn" : "pbtn primary",
                    "data-op": sharing ? "online-off" : "online-on",
                    onclick: () =>
                        sendRaw({
                            type: "share",
                            op: sharing ? "online-off" : "online-on",
                        }),
                },
                sharing ? "Stop sharing online" : "Share online",
            ),
        ),
    );
    if (summary.error) {
        into.append(h("p", { class: "share-error" }, summary.error));
    }
    if (o.links) {
        into.append(
            h(
                "section",
                { class: "share-online-links" },
                linkRow(
                    "Online editor link",
                    o.links.editor,
                    "Edits the deck with you from anywhere (not your computer's files, git or programs).",
                ),
                linkRow(
                    "Online view link",
                    o.links.view,
                    "Watches the presentation from anywhere and follows your slide.",
                ),
            ),
        );
    }
    const rotate = () => {
        if (
            confirm(
                "Make new online links? Everyone who joined online with the current ones is disconnected.",
            )
        ) {
            sendRaw({ type: "share", op: "online-rotate" });
        }
    };
    into.append(
        h(
            "div",
            { class: "share-actions" },
            sharing && o.links
                ? h(
                      "button",
                      { type: "button", class: "pbtn", onclick: rotate },
                      "New online links",
                  )
                : null,
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    disabled: sharing,
                    title: sharing
                        ? "Stop sharing online to change the relay"
                        : null,
                    onclick: () => {
                        editingRelay = true;
                        render();
                    },
                },
                "Change relay…",
            ),
        ),
        h(
            "p",
            { class: "hint" },
            "End-to-end encrypted: the relay passes the deck on without being able to read it. A link is its key: anyone with the editor link can edit until you make new links.",
        ),
    );
}

function relayForm(o: OnlineStatus): HTMLElement {
    const url = h("input", {
        type: "url",
        placeholder: "https://inkflow-relay.you.workers.dev",
        value: o.relay ?? "",
        "aria-label": "Relay address",
    });
    const token = h("input", {
        type: "password",
        placeholder: "Access token (if the relay has one)",
        "aria-label": "Access token",
        autocomplete: "off",
    });
    const save = () => {
        editingRelay = false;
        sendRaw({
            type: "share",
            op: "relay-set",
            url: url.value.trim(),
            token: token.value.trim(),
        });
    };
    return h(
        "div",
        { class: "share-relay" },
        h(
            "p",
            {},
            o.relay
                ? "The relay sharing online goes through: "
                : "Sharing online goes through a relay of your own: a free Cloudflare Worker, or a server you run. ",
            h(
                "a",
                { href: GUIDE_URL, target: "_blank", rel: "noopener" },
                "How to set one up",
            ),
        ),
        h(
            "div",
            { class: "share-relay-fields" },
            url,
            token,
            h(
                "button",
                { type: "button", class: "pbtn primary", onclick: save },
                "Use this relay",
            ),
            o.relay
                ? h(
                      "button",
                      {
                          type: "button",
                          class: "pbtn",
                          onclick: () => {
                              editingRelay = false;
                              render();
                          },
                      },
                      "Cancel",
                  )
                : null,
        ),
        h(
            "p",
            { class: "hint" },
            "Or in a terminal: ",
            h("code", {}, "inkflow relay deploy cloudflare"),
            " deploys one and sets it here.",
        ),
    );
}

function setStatus(msg: Record<string, unknown>): void {
    status = msg as unknown as ShareStatus;
    if (button) {
        button.classList.toggle(
            "on",
            status.sharing || Boolean(status.online?.sharing),
        );
    }
    if (status.error) toast(status.error, "error");
    if (body && dialogOpen()) render();
}

export function openShare(): void {
    body = h("div", { class: "share-dialog" }, h("p", {}, "…"));
    ssh = null;
    openDialog("Share", body, {
        wide: true,
        onClose: () => {
            body = null;
            ssh = null;
        },
    });
    sendRaw({ type: "share", op: "status" });
    render();
}

export function initShare(): void {
    onMessage("share-status", setStatus);
    button?.addEventListener("click", openShare);
}
