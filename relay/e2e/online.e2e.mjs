// End-to-end check of sharing online, in a real browser (not part of the
// test suites: it needs Chromium and Playwright). It starts a relay — the
// Python one (`inkflow relay`), or the Cloudflare Worker under `wrangler dev`
// with RELAY=worker — and `inkflow edit` on a copy of the demo deck, then:
//
// - the owner sets the relay and shares online in the Share dialog;
// - an editor guest opens the online editor link: the editor boots through
//   the relay, its pictures and fonts come through the channel, a speaker
//   note typed and a rectangle drawn land in the deck's files;
// - a viewer guest opens the view link, follows the owner's slide, cannot
//   edit, and gets the video's byte ranges through the channel;
// - nothing the relay forwarded contains the deck's text (Python relay);
// - New online links sends both away; Stop sharing online ends a new one.
//
// Run from the repository root:
//   PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CHROMIUM=/path/to/chrome node relay/e2e/online.e2e.mjs
// (RELAY=worker needs `pnpm install --ignore-workspace` in relay/cloudflare.)
// Ports: OWNER_PORT (8000), RELAY_PORT (8001).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const { chromium } = require(
    process.env.PLAYWRIGHT ?? "/opt/node-tools/node_modules/playwright-core",
);
const CHROMIUM =
    process.env.CHROMIUM ??
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OWNER_PORT = Number(process.env.OWNER_PORT ?? 8000);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8001);
const RELAY = process.env.RELAY ?? "python";
const RELAY_URL = `http://localhost:${RELAY_PORT}`;

const work = mkdtempSync(join(tmpdir(), "inkflow-online-e2e-"));
const deck = join(work, "demo");
cpSync(join(root, "demo"), deck, { recursive: true });
// A WebM copy of the demo's video (when ffmpeg is here): Chromium builds
// without H.264 still play it.
const webm =
    spawnSync(
        "ffmpeg",
        [
            "-loglevel",
            "error",
            "-i",
            join(deck, "assets", "logo.mp4"),
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "400k",
            "-an",
            join(deck, "assets", "logo-e2e.webm"),
        ],
        { stdio: "ignore" },
    ).status === 0;
const dump = join(work, "relay-frames.bin");
writeFileSync(dump, "");

const children = [];
function run(cmd, args, opts = {}) {
    const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...opts,
        env: { ...process.env, ...(opts.env ?? {}) },
    });
    let out = "";
    child.stdout.on("data", (d) => {
        out += d;
    });
    child.stderr.on("data", (d) => {
        out += d;
    });
    children.push(child);
    return () => out;
}

const results = [];
function check(name, ok, detail = "") {
    results.push({ name, ok, detail });
    console.log(
        `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
    );
}

async function until(fn, ms = 20000, step = 100) {
    const end = Date.now() + ms;
    for (;;) {
        try {
            const v = await fn();
            if (v) return v;
        } catch {
            // not yet
        }
        if (Date.now() > end) return null;
        await new Promise((r) => setTimeout(r, step));
    }
}

const relayLog =
    RELAY === "worker"
        ? run(
              "pnpm",
              [
                  "exec",
                  "wrangler",
                  "dev",
                  "--port",
                  String(RELAY_PORT),
                  "--ip",
                  "127.0.0.1",
              ],
              { cwd: join(root, "relay/cloudflare") },
          )
        : run(
              "uv",
              [
                  "run",
                  "inkflow",
                  "relay",
                  "--port",
                  String(RELAY_PORT),
                  "--dump",
                  dump,
              ],
              {
                  cwd: root,
              },
          );
const serverLog = run(
    "uv",
    [
        "run",
        "inkflow",
        "edit",
        "--deck",
        join(deck, "deck.py"),
        "--port",
        String(OWNER_PORT),
        "--no-open",
    ],
    {
        cwd: root,
        env: { XDG_CONFIG_HOME: join(work, "config"), INKFLOW_RELAY_URL: "" },
    },
);

const health = await until(
    async () => (await fetch(`${RELAY_URL}/_relay/health`)).ok,
    60000,
    300,
);
check(
    `relay (${RELAY}) answers`,
    Boolean(health),
    health ? "" : relayLog().slice(-2000),
);
const serving = await until(
    async () => (await fetch(`http://localhost:${OWNER_PORT}/edit`)).ok,
    60000,
    300,
);
check(
    "inkflow edit serves",
    Boolean(serving),
    serving ? "" : serverLog().slice(-2000),
);

const browser = await chromium.launch({ executablePath: CHROMIUM });
const errors = [];
function watch(page, who) {
    page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
}

// The page's own frame: the editor or presenter inside the guest page.
async function pageFrame(page, path) {
    return until(
        () =>
            page
                .frames()
                .find(
                    (f) =>
                        f !== page.mainFrame() &&
                        new URL(f.url()).pathname === path,
                ),
        30000,
    );
}

async function editorReady(frame) {
    await frame.waitForSelector("#sorter-list .thumb svg, #sorter-list svg", {
        timeout: 60000,
    });
    await frame.waitForSelector("#slide-host svg", { timeout: 60000 });
}

try {
    // ── The owner: LAN boot time, then share online from the dialog ──
    const ownerCtx = await browser.newContext({
        viewport: { width: 1400, height: 900 },
    });
    const owner = await ownerCtx.newPage();
    watch(owner, "owner");
    owner.on("dialog", (d) => d.accept());
    let t0 = Date.now();
    await owner.goto(`http://localhost:${OWNER_PORT}/edit`);
    await editorReady(owner.mainFrame());
    const coldBoot = Date.now() - t0;
    // Again, warm (the relay's guest boots below are the second load too).
    t0 = Date.now();
    await owner.reload();
    await editorReady(owner.mainFrame());
    const lanBoot = Date.now() - t0;
    check(
        "editor boots on this machine",
        true,
        `${lanBoot} ms (first load ${coldBoot} ms)`,
    );

    await owner.click("#btn-share");
    await owner.waitForSelector(".share-relay input[type=url]");
    await owner.fill(".share-relay input[type=url]", RELAY_URL);
    await owner.click(".share-relay button.primary");
    await owner.waitForSelector("button[data-op=online-on]");
    await owner.click("button[data-op=online-on]");
    await owner.waitForSelector(".share-online-links input", {
        timeout: 20000,
    });
    const [editorLink, viewLink] = await owner.$$eval(
        ".share-online-links input",
        (els) => els.map((e) => e.value),
    );
    check(
        "the Share dialog shares online",
        editorLink.startsWith(`${RELAY_URL}/#r=`) && viewLink !== editorLink,
    );

    // ── An editor guest ──
    const edCtx = await browser.newContext({
        viewport: { width: 1400, height: 900 },
    });
    const ed = await edCtx.newPage();
    watch(ed, "editor guest");
    const fromRelay = [];
    ed.on("response", (r) => {
        if (r.fromServiceWorker())
            fromRelay.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    t0 = Date.now();
    await ed.goto(editorLink);
    const edFrame = await pageFrame(ed, "/edit");
    check("the editor link opens the editor", Boolean(edFrame));
    await editorReady(edFrame);
    const onlineBoot = Date.now() - t0;
    const bootBytes = await ed.evaluate(
        () => window.__inkflowRelay.channel.receivedBytes,
    );
    check(
        "editor boots through the relay",
        true,
        `${onlineBoot} ms, ${(bootBytes / 1e6).toFixed(2)} MB through the channel (this machine: ${lanBoot} ms)`,
    );
    check("the key left the address bar", !ed.url().includes("k="), ed.url());
    // Its name, as a guest is asked.
    const nameBox = await edFrame.$(".name-dialog input");
    if (nameBox) {
        await nameBox.fill("Ada");
        await edFrame.click(".name-dialog button.primary");
    }
    const pictures = fromRelay.filter(
        (r) => r.startsWith("200 /assets/") || r.startsWith("200 /slides/"),
    );
    const fonts = fromRelay.filter((r) => r.includes("/_inkflow/fonts/"));
    check(
        "pictures come through the channel",
        pictures.length > 0,
        pictures.slice(0, 3).join(", "),
    );
    check(
        "fonts come through the channel",
        fonts.length > 0,
        fonts.slice(0, 2).join(", "),
    );
    const fontsOk = await edFrame.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check('16px "Inkflow UI"');
    });
    check("the interface font is loaded", fontsOk);

    // A text: the first slide's speaker notes.
    const relay = () =>
        ed.evaluate(() => ({
            sent: window.__inkflowRelay.channel.sentBytes,
            received: window.__inkflowRelay.channel.receivedBytes,
        }));
    const before = await relay();
    const typed = "Typed through the relay";
    await edFrame.click("#notes-input");
    await edFrame.fill("#notes-input", typed);
    await edFrame.click("#slide-host");
    const notesFile = join(deck, "notes", "title.md");
    const noted = await until(() =>
        readFileSync(notesFile, "utf8").includes(typed),
    );
    // The edit's result and the rebuild it causes (update + editor-model).
    await new Promise((r) => setTimeout(r, 2500));
    const after = await relay();
    check("a typed note reaches the deck's files", Boolean(noted));
    if (after) {
        check(
            "bytes for that edit",
            true,
            `sent ${after.sent - before.sent} B, received ${after.received - before.received} B (request, result, rebuild push)`,
        );
    }

    // A shape: a rectangle drawn with the tool.
    const svgFile = join(deck, "slides", "title.svg");
    const rects = () =>
        (readFileSync(svgFile, "utf8").match(/<rect\b/g) ?? []).length;
    const rectsBefore = rects();
    await edFrame.click("[data-tool=rect]");
    const box = await edFrame.$eval("#slide-host svg", (s) => {
        const r = s.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const frameBox = await (await ed.$("iframe#page")).boundingBox();
    const ox = frameBox.x + box.x;
    const oy = frameBox.y + box.y;
    await ed.mouse.move(ox + box.w * 0.1, oy + box.h * 0.75);
    await ed.mouse.down();
    await ed.mouse.move(ox + box.w * 0.2, oy + box.h * 0.85, { steps: 8 });
    await ed.mouse.up();
    const drawn = await until(() => rects() > rectsBefore);
    check(
        "a drawn rectangle reaches the slide's SVG",
        Boolean(drawn),
        `${rectsBefore} → ${rects()} rects`,
    );

    // A reload keeps the guest in (the link stays in the tab, not the bar).
    t0 = Date.now();
    await ed.reload();
    const again = await pageFrame(ed, "/edit");
    await editorReady(again);
    check(
        "a reload reopens the editor through the relay",
        true,
        `${Date.now() - t0} ms`,
    );

    // ── A viewer guest ──
    const viewCtx = await browser.newContext({
        viewport: { width: 1200, height: 700 },
    });
    const view = await viewCtx.newPage();
    watch(view, "viewer");
    t0 = Date.now();
    await view.goto(viewLink);
    const viewFrame = await pageFrame(view, "/");
    await viewFrame.waitForSelector('svg[id^="inkflow-slide-"]', {
        timeout: 60000,
    });
    check("the view link opens the presenter", true, `${Date.now() - t0} ms`);
    const refused = await viewFrame.evaluate(async () => {
        const page = await fetch("/edit");
        const sock = window.parent.__inkflowRelay.openSocket();
        const reply = await new Promise((done) => {
            sock.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.type === "edit-result") done(msg);
            };
            sock.onopen = () =>
                sock.send(
                    JSON.stringify({
                        type: "edit-op",
                        id: 1,
                        action: "notes",
                        slide: 0,
                        text: "viewer",
                    }),
                );
        });
        sock.close();
        return { page: page.status, ok: reply.ok, error: reply.error };
    });
    check(
        "a viewer cannot open the editor",
        refused.page === 403,
        `GET /edit → ${refused.page}`,
    );
    check("a viewer cannot edit", refused.ok === false, refused.error);

    // The owner presents; the viewer follows.
    const ownerSock = new WebSocket(`ws://localhost:${OWNER_PORT}/_inkflow/ws`);
    await new Promise((r) => {
        ownerSock.onopen = r;
    });
    ownerSock.send(JSON.stringify({ type: "nav", slideIndex: 2, step: 0 }));
    const followed = await until(
        () => new URL(viewFrame.url()).hash.includes("slide=3"),
        10000,
    );
    check(
        "the viewer follows the owner's slide",
        Boolean(followed),
        new URL(viewFrame.url()).hash,
    );

    // The video: its byte ranges through the channel.
    const video = await viewFrame.evaluate(async () => {
        const res = await fetch("/assets/logo.mp4", {
            headers: { Range: "bytes=1000-1999" },
        });
        const body = new Uint8Array(await res.arrayBuffer());
        return {
            status: res.status,
            length: body.length,
            range: res.headers.get("content-range"),
        };
    });
    const size = readFileSync(join(deck, "assets", "logo.mp4")).length;
    check(
        "video byte ranges come through the channel",
        video.status === 206 &&
            video.length === 1000 &&
            video.range === `bytes 1000-1999/${size}`,
        JSON.stringify(video),
    );
    let played = null;
    for (let i = 0; i < 16 && !played; i++) {
        ownerSock.send(JSON.stringify({ type: "nav", slideIndex: i, step: 1 }));
        await new Promise((r) => setTimeout(r, 400));
        played = await viewFrame.evaluate(() => {
            const v = document.querySelector("#stage video, video");
            return v
                ? {
                      src: v.currentSrc,
                      buffered: v.buffered.length,
                      error: v.error?.code ?? null,
                  }
                : null;
        });
    }
    if (played) {
        await new Promise((r) => setTimeout(r, 2500));
        played = await viewFrame.evaluate(() => {
            const v = document.querySelector("#stage video, video");
            return {
                readyState: v.readyState,
                buffered: v.buffered.length ? v.buffered.end(0) : 0,
                error: v.error?.code ?? null,
                h264: MediaSource.isTypeSupported(
                    'video/mp4; codecs="avc1.42E01E"',
                ),
            };
        });
    }
    check(
        "the video slide's <video> loads through the channel",
        Boolean(
            played &&
                (played.readyState >= 2 ||
                    (played.error === 4 && !played.h264)),
        ),
        `${JSON.stringify(played)}${played?.h264 === false ? " (this Chromium has no H.264: the WebM below plays instead)" : ""}`,
    );
    // A codec every Chromium has, played and sought through the channel.
    if (webm) {
        const playedWebm = await viewFrame.evaluate(async () => {
            const v = document.createElement("video");
            v.muted = true;
            v.preload = "auto";
            v.src = "/assets/logo-e2e.webm";
            document.body.append(v);
            const ready = (what) =>
                new Promise((done) => {
                    v.addEventListener(what, () => done(true), { once: true });
                    v.addEventListener("error", () => done(false), {
                        once: true,
                    });
                });
            const loaded = await ready("loadeddata");
            v.currentTime = v.duration / 2;
            const sought = await ready("seeked");
            await v.play().catch(() => {});
            await new Promise((r) => setTimeout(r, 500));
            const out = {
                loaded,
                sought,
                readyState: v.readyState,
                time: v.currentTime,
                error: v.error?.code ?? null,
            };
            v.remove();
            return out;
        });
        check(
            "a WebM video plays and seeks through the channel",
            playedWebm.loaded &&
                playedWebm.sought &&
                playedWebm.readyState >= 2,
            JSON.stringify(playedWebm),
        );
    }

    // ── What the relay saw ──
    if (RELAY === "python") {
        const seen = readFileSync(dump);
        const plain = [
            typed,
            "Beautiful slides from SVG",
            "editor-model",
            "inkflow-slide-",
            "notes/title.md",
        ];
        const found = plain.filter((t) => seen.includes(Buffer.from(t)));
        check(
            "the relay saw no plaintext",
            seen.length > 100000 && found.length === 0,
            `${seen.length} bytes relayed; found: ${found.join(", ") || "none"}`,
        );
    }

    // ── New links: both guests are sent away ──
    await owner.click("text=New online links");
    const edEnded = await until(
        () =>
            ed.$eval("#status", (s) =>
                !s.hidden && s.className === "end" ? s.textContent : null,
            ),
        15000,
    );
    const viewEnded = await until(
        () =>
            view.$eval("#status", (s) =>
                !s.hidden && s.className === "end" ? s.textContent : null,
            ),
        15000,
    );
    check(
        "New online links disconnects the guests",
        Boolean(edEnded && viewEnded),
        (edEnded ?? "").trim().slice(0, 80),
    );
    await owner.waitForFunction((old) => {
        const els = document.querySelectorAll(".share-online-links input");
        return els.length && els[1].value !== old;
    }, viewLink);
    const newView = await owner.$$eval(
        ".share-online-links input",
        (els) => els[1].value,
    );

    // ── Stop sharing: the room ends ──
    const lateCtx = await browser.newContext();
    const late = await lateCtx.newPage();
    await late.goto(newView);
    const lateFrame = await pageFrame(late, "/");
    await lateFrame.waitForSelector('svg[id^="inkflow-slide-"]', {
        timeout: 60000,
    });
    const oldLink = await (await browser.newContext()).newPage();
    await oldLink.goto(viewLink);
    const oldRefused = await until(
        () =>
            oldLink.$eval("#status", (s) => (!s.hidden ? s.textContent : null)),
        10000,
    );
    check(
        "an old link no longer opens the deck",
        Boolean(oldRefused) && !(await oldLink.$("iframe#page")),
        (oldRefused ?? "").trim().slice(0, 80),
    );
    await owner.click("button[data-op=online-off]");
    const lateEnded = await until(
        () =>
            late.$eval("#status", (s) =>
                !s.hidden && s.className === "end" ? s.textContent : null,
            ),
        15000,
    );
    check(
        "stopping sharing ends the room",
        Boolean(lateEnded && /stopped/.test(lateEnded)),
        (lateEnded ?? "").trim().slice(0, 80),
    );
    ownerSock.close();
    check(
        "no page errors",
        errors.length === 0,
        errors.slice(0, 5).join(" | "),
    );
} catch (err) {
    check("ran to the end", false, String(err?.stack ?? err));
} finally {
    await browser.close();
    for (const c of children) c.kill("SIGTERM");
}
const failed = results.filter((r) => !r.ok);
console.log(
    `\n${results.length - failed.length}/${results.length} passed (${RELAY} relay)`,
);
process.exit(failed.length ? 1 : 0);
