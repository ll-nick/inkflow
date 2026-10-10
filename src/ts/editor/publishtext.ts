// The publish dialog's pure parts (publish.ts): which host to offer first,
// which files a setup writes, and links inside the server's step texts.

export type Host = "github" | "gitlab";

export interface PublishFile {
    path: string;
    // "none": not there; "inkflow": an earlier setup wrote it; "other": not
    // inkflow's, replaced only after asking.
    exists: "none" | "inkflow" | "other";
    // Written only with a release (GitHub's release.yml).
    release: boolean;
}

export interface HostInfo {
    url: string | null;
    settingsUrl: string | null;
    note: string | null;
    files: PublishFile[];
    warnings: string[];
}

export interface PublishInfo {
    root: string;
    scope: string;
    inRepo: boolean;
    branch: string;
    remote: string | null;
    suggested: Host | null;
    configured: {
        host: Host;
        release: boolean;
        url: string | null;
        settingsUrl: string | null;
    } | null;
    hosts: Record<Host, HostInfo>;
    readme: "missing" | "present" | "linked";
    fonts: string[];
}

/** The host to preselect: the one set up already, else the origin's. */
export function defaultHost(info: PublishInfo): Host {
    return info.configured?.host ?? info.suggested ?? "github";
}

/** The files a setup for `host` writes (GitHub's release workflow only with
 * `release`; GitLab's one file holds both). */
export function filesFor(
    info: PublishInfo,
    host: Host,
    release: boolean,
): PublishFile[] {
    return info.hosts[host].files.filter((f) => release || !f.release);
}

/** What happens to a file: written new, updated, or someone else's replaced. */
export function fileAction(file: PublishFile): string {
    if (file.exists === "inkflow") return "update";
    if (file.exists === "other") return "replace";
    return "new";
}

export type Part = { text: string } | { url: string };

/** Text split around its http(s) links (a trailing `)`, `.` or `,` stays text). */
export function linkParts(text: string): Part[] {
    const parts: Part[] = [];
    const re = /https?:\/\/[^\s)]+[^\s).,;]/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
        const at = m.index ?? 0;
        if (at > last) parts.push({ text: text.slice(last, at) });
        parts.push({ url: m[0] });
        last = at + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
}
