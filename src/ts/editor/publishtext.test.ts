import { describe, expect, it } from "vitest";
import {
    defaultHost,
    fileAction,
    filesFor,
    linkParts,
    type PublishInfo,
} from "./publishtext";

function info(over: Partial<PublishInfo> = {}): PublishInfo {
    const host = (files: PublishInfo["hosts"]["github"]["files"]) => ({
        url: null,
        settingsUrl: null,
        note: null,
        files,
        warnings: [],
    });
    return {
        root: "/r",
        scope: "",
        inRepo: true,
        branch: "main",
        remote: null,
        suggested: null,
        configured: null,
        hosts: {
            github: host([
                {
                    path: ".github/workflows/pages.yml",
                    exists: "none",
                    release: false,
                },
                {
                    path: ".github/workflows/release.yml",
                    exists: "other",
                    release: true,
                },
            ]),
            gitlab: host([
                { path: ".gitlab-ci.yml", exists: "inkflow", release: false },
            ]),
        },
        readme: "missing",
        fonts: [],
        ...over,
    };
}

describe("defaultHost", () => {
    it("prefers what is set up, then the origin's host, then GitHub", () => {
        expect(defaultHost(info())).toBe("github");
        expect(defaultHost(info({ suggested: "gitlab" }))).toBe("gitlab");
        expect(
            defaultHost(
                info({
                    suggested: "github",
                    configured: {
                        host: "gitlab",
                        release: false,
                        url: null,
                        settingsUrl: null,
                    },
                }),
            ),
        ).toBe("gitlab");
    });
});

describe("filesFor", () => {
    it("leaves GitHub's release workflow out without a release", () => {
        const paths = (host: "github" | "gitlab", release: boolean) =>
            filesFor(info(), host, release).map((f) => f.path);
        expect(paths("github", false)).toEqual([".github/workflows/pages.yml"]);
        expect(paths("github", true)).toEqual([
            ".github/workflows/pages.yml",
            ".github/workflows/release.yml",
        ]);
        expect(paths("gitlab", true)).toEqual([".gitlab-ci.yml"]);
    });

    it("names what happens to each file", () => {
        expect(filesFor(info(), "github", true).map(fileAction)).toEqual([
            "new",
            "replace",
        ]);
        expect(filesFor(info(), "gitlab", false).map(fileAction)).toEqual([
            "update",
        ]);
    });
});

describe("linkParts", () => {
    it("splits out links, keeping closing punctuation as text", () => {
        expect(
            linkParts(
                'Source: "GitHub Actions" (https://github.com/o/r/settings/pages); then.',
            ),
        ).toEqual([
            { text: 'Source: "GitHub Actions" (' },
            { url: "https://github.com/o/r/settings/pages" },
            { text: "); then." },
        ]);
        expect(linkParts("at https://o.github.io/r/.")).toEqual([
            { text: "at " },
            { url: "https://o.github.io/r/" },
            { text: "." },
        ]);
        expect(linkParts("no link")).toEqual([{ text: "no link" }]);
    });
});
