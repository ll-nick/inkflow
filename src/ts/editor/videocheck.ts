// After a video comes into the deck: can this browser play it, and is it
// worth converting? The server reads it with ffprobe (editor/media.py) for its
// codec, size, resolution and length; the browser adds whether it decodes it
// at all. Anything worth saying opens the "Video check" dialog, which offers a
// conversion to MP4 (H.264, plays everywhere) or WebM (VP9): presets for the
// resolution, a quality slider, a rough size and the ffmpeg command to copy,
// or run on the spot.

import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { folderPicker, megabytes } from "./folderpicker";
import { edit, request } from "./net";
import { openMenu as openWithMenu } from "./openwith";

export interface VideoContext {
    path: string;
    // Where it shows, to swap in a converted file.
    slide: number;
    zone: string;
    // What the browser made of it (insert.ts videoSize).
    browser?: { decoded: boolean; duration: number | null };
}

interface Info {
    size: number;
    container: string;
    duration?: number;
    vcodec?: string;
    acodec?: string | null;
    width?: number;
    height?: number;
    fps?: number;
}

interface Issue {
    kind: string;
    level: string;
    text: string;
}

interface MediaInfo {
    info: Info;
    issues: Issue[];
    tools: { ffprobe: boolean; ffmpeg: boolean };
    qualities: string[];
    // The container its streams fit as they are ("mp4", "webm"), if any.
    remux: string | null;
}

interface Placed {
    path: string;
    rel: string;
}

// What a finished conversion is for: replacing the video on a slide (the
// user may untick that), or a file coming in that needs converting first.
type ConvertFor =
    | { kind: "replace"; ctx: VideoContext }
    | { kind: "insert"; done: (placed: Placed | null) => void };

const LONG = 10 * 60;

async function mediaInfo(path: string): Promise<MediaInfo | null> {
    const res = await request({ action: "media-info", path });
    if (!res.ok) {
        toast(res.error ?? "Cannot read the video", "error");
        return null;
    }
    return res as unknown as MediaInfo;
}

function name(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

function minutes(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

function describe(info: Info): string {
    return [
        info.vcodec
            ? `${info.vcodec.toUpperCase()} in .${info.container}`
            : `.${info.container}`,
        info.width && info.height ? `${info.width}×${info.height}` : "",
        info.fps ? `${Math.round(info.fps)} fps` : "",
        info.duration ? minutes(info.duration) : "",
        megabytes(info.size),
    ]
        .filter(Boolean)
        .join(" · ");
}

/** Check a video that just came in; says something only when it matters. */
export async function checkVideo(ctx: VideoContext): Promise<void> {
    const data = await mediaInfo(ctx.path);
    if (!data) return;
    const issues = collect(ctx, data);
    if (issues.length) showCheck(ctx, data, issues);
}

/** The check, shown whether or not anything is wrong (the panel's button). */
export async function openVideoCheck(ctx: VideoContext): Promise<void> {
    const data = await mediaInfo(ctx.path);
    if (data) showCheck(ctx, data, collect(ctx, data));
}

function collect(ctx: VideoContext, data: MediaInfo): Issue[] {
    const issues = [...data.issues];
    if (ctx.browser && !ctx.browser.decoded) {
        issues.unshift({
            kind: "decode",
            level: "error",
            text: "This browser cannot play it: it shows as an empty box here, and in the presenter for anyone with this browser.",
        });
    }
    // Without ffprobe, the browser still knows how long it runs.
    const duration = ctx.browser?.duration;
    if (data.info.duration == null && duration && duration > LONG) {
        issues.push({
            kind: "length",
            level: "info",
            text: `It runs ${Math.round(duration / 60)} minutes. Trim start and end in its settings, or cut it in a video editor.`,
        });
    }
    return issues;
}

function showCheck(ctx: VideoContext, data: MediaInfo, issues: Issue[]): void {
    const editors = h(
        "button",
        {
            type: "button",
            class: "pbtn",
            title: "Trim or cut it in a video editor (LosslessCut, Shotcut…)",
        },
        "Open in…",
    ) as HTMLButtonElement;
    editors.addEventListener("click", () => {
        const r = editors.getBoundingClientRect();
        void openWithMenu(ctx.path, r.left, r.bottom + 4);
    });
    openDialog(
        "Video check",
        h(
            "div",
            { class: "git-form" },
            h(
                "p",
                { class: "hint" },
                `${name(ctx.path)}: ${describe(data.info)}`,
            ),
            issues.length
                ? h(
                      "ul",
                      { class: "video-issues" },
                      ...issues.map((i) =>
                          h("li", { class: `issue-${i.level}` }, i.text),
                      ),
                  )
                : h(
                      "p",
                      {},
                      "Nothing to worry about: it plays in every current browser.",
                  ),
            !data.tools.ffprobe &&
                h(
                    "p",
                    { class: "hint" },
                    "Install ffmpeg (it brings ffprobe) to see the codec, resolution and length here, and to convert in place.",
                ),
            h(
                "p",
                { class: "hint" },
                "MP4 with H.264 plays in every browser; WebM (VP9) in all but some Safari versions. Convert to one of them to be safe.",
            ),
            h(
                "div",
                { class: "btn-row end" },
                editors,
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => closeDialog(),
                    },
                    "Keep as is",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        onclick: () =>
                            convertDialog(ctx.path, data, {
                                kind: "replace",
                                ctx,
                            }),
                    },
                    "Convert…",
                ),
            ),
        ),
        { wide: true },
    );
}

// ── Converting ──

const PRESETS: { label: string; height: number | null }[] = [
    { label: "Keep its resolution", height: null },
    { label: "4K (2160p)", height: 2160 },
    { label: "Full HD (1080p)", height: 1080 },
    { label: "HD (720p)", height: 720 },
    { label: "480p", height: 480 },
];

/** A video that needs converting before it can go on a slide (another
 * format, read by ffmpeg): the convert dialog, which places the result or,
 * closed, nothing. */
export async function convertForInsert(source: string): Promise<Placed | null> {
    const data = await mediaInfo(source);
    if (!data) return null;
    return new Promise((resolve) =>
        convertDialog(source, data, { kind: "insert", done: resolve }),
    );
}

function convertDialog(
    path: string,
    data: MediaInfo,
    purpose: ConvertFor,
): void {
    const info = data.info;
    // Repackaging keeps the video as it is: the default whenever it can.
    let format = data.remux ? "copy" : "mp4";
    // The source's own resolution unless asked otherwise.
    let height: number | null = null;
    let quality = 2;
    let audio = !!info.acodec;
    const inserting = purpose.kind === "insert";

    const choices: string[][] = [
        ["mp4", "MP4 (H.264)", "Plays in every browser. The safe choice."],
        [
            "webm",
            "WebM (VP9)",
            "Smaller at the same quality; not in all Safari versions.",
        ],
    ];
    if (data.remux) {
        choices.unshift([
            "copy",
            `Keep the video as it is (.${data.remux})`,
            `Its ${info.vcodec?.toUpperCase() ?? "video"} already plays in browsers: repackaged without re-encoding, in seconds and with no quality lost.`,
        ]);
    }
    const formats = h(
        "div",
        { class: "look-list" },
        ...choices.map(([value, label, text]) => {
            const radio = h("input", {
                type: "radio",
                name: "video-format",
                value,
            }) as HTMLInputElement;
            radio.checked = value === format;
            radio.addEventListener("change", () => {
                format = value;
                void update();
            });
            return h(
                "label",
                { class: "look" },
                radio,
                h(
                    "span",
                    { class: "look-text" },
                    h("strong", {}, label),
                    h("span", { class: "hint" }, text),
                ),
            );
        }),
    );

    const size = h("select", {}) as HTMLSelectElement;
    for (const p of PRESETS) {
        const bigger = p.height && info.height && p.height > info.height;
        const option = h(
            "option",
            { value: String(p.height ?? "") },
            p.height
                ? `${p.label}${bigger ? " (no larger than the source)" : ""}`
                : `${p.label}${info.width && info.height ? ` (${info.width}×${info.height})` : ""}`,
        ) as HTMLOptionElement;
        option.selected = p.height === height;
        size.append(option);
    }
    size.addEventListener("change", () => {
        height = size.value ? Number(size.value) : null;
        void update();
    });

    const slider = h("input", {
        type: "range",
        class: "quality-slider",
        min: "0",
        max: String(data.qualities.length - 1),
        step: "1",
        value: String(quality),
    }) as HTMLInputElement;
    const qualityLabel = h("span", { class: "hint" });
    slider.addEventListener("input", () => {
        quality = Number(slider.value);
        void update();
    });

    const sound = h("input", { type: "checkbox" }) as HTMLInputElement;
    sound.checked = audio;
    sound.disabled = !info.acodec && data.tools.ffprobe;
    sound.addEventListener("change", () => {
        audio = sound.checked;
        void update();
    });

    const estimate = h("p", { class: "video-estimate" });
    const command = h("textarea", {
        class: "git-message video-command",
        rows: "3",
        readonly: true,
        spellcheck: "false",
    }) as HTMLTextAreaElement;
    const copy = h(
        "button",
        {
            type: "button",
            class: "pbtn",
            onclick: () =>
                void navigator.clipboard.writeText(command.value).then(
                    () =>
                        toast(
                            "Command copied: run it in the deck's folder",
                            "ok",
                        ),
                    () => command.select(),
                ),
        },
        "Copy command",
    );
    const use = h("input", { type: "checkbox" }) as HTMLInputElement;
    use.checked = true;
    const progress = h("progress", {
        max: "1",
        value: "0",
        hidden: true,
    }) as HTMLProgressElement;
    const run = h(
        "button",
        { type: "button", class: "pbtn primary", disabled: !data.tools.ffmpeg },
        "Convert now",
    ) as HTMLButtonElement;
    let job: string | null = null;
    let finished = false;

    async function update(): Promise<void> {
        qualityLabel.textContent = data.qualities[quality] ?? "";
        // Resolution and quality are an encoder's: a repackage keeps both.
        size.disabled = slider.disabled = format === "copy";
        const res = await request({
            action: "convert-plan",
            path,
            format,
            height,
            quality,
            audio,
        });
        if (!res.ok) {
            estimate.textContent = res.error ?? "";
            return;
        }
        command.value = String(res.command);
        const bytes = res.estimate as number | null;
        estimate.textContent = bytes
            ? `Roughly ${megabytes(bytes)}, from ${megabytes(info.size)} now (a guess: it depends on the footage).`
            : "No size estimate without the video's length and resolution (install ffmpeg).";
        estimate.append(
            h("br"),
            h("span", { class: "hint" }, `Saved as ${res.out}`),
        );
    }

    run.addEventListener("click", async () => {
        if (job) {
            await request({ action: "convert-cancel", job });
            return;
        }
        const res = await request({
            action: "convert",
            path,
            format,
            height,
            quality,
            audio,
        });
        if (!res.ok || typeof res.job !== "string") {
            toast(res.error ?? "Could not start ffmpeg", "error");
            return;
        }
        job = res.job;
        run.textContent = "Cancel";
        progress.hidden = false;
        const poll = async () => {
            const st = await request({ action: "convert-status", job });
            progress.value = Number(st.progress ?? 0);
            if (st.state === "running") {
                window.setTimeout(() => void poll(), 700);
                return;
            }
            job = null;
            run.textContent = inserting ? "Convert and insert" : "Convert now";
            progress.hidden = true;
            if (st.state !== "done" || typeof st.path !== "string") {
                toast(
                    `Conversion stopped: ${st.error || "cancelled"}`,
                    "error",
                );
                return;
            }
            toast(`Converted to ${st.rel}`, "ok");
            finished = true;
            const placed = { path: st.path, rel: String(st.rel) };
            if (purpose.kind === "insert") purpose.done(placed);
            else if (use.checked) {
                await edit({
                    action: "zone-media",
                    slide: purpose.ctx.slide,
                    zone: purpose.ctx.zone,
                    src: st.path,
                });
            }
            closeDialog();
        };
        void poll();
    });

    openDialog(
        "Convert video",
        h(
            "div",
            { class: "deck-form" },
            h("p", { class: "hint" }, `${name(path)}: ${describe(info)}`),
            inserting &&
                h(
                    "p",
                    { class: "hint warn" },
                    "Browsers cannot play this file as it is: convert it to put it on the slide.",
                ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Format"),
                formats,
            ),
            h(
                "label",
                { class: "field" },
                h("span", { class: "field-label" }, "Resolution"),
                size,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Quality"),
                h(
                    "div",
                    { class: "video-quality" },
                    h("span", { class: "hint" }, "Smaller"),
                    slider,
                    h("span", { class: "hint" }, "Better"),
                    qualityLabel,
                ),
            ),
            h("label", { class: "check-row" }, sound, "Keep the sound"),
            estimate,
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "ffmpeg"),
                h("div", {}, command, h("div", { class: "btn-row" }, copy)),
            ),
            !data.tools.ffmpeg &&
                h(
                    "p",
                    { class: "hint warn" },
                    "ffmpeg is not installed here: copy the command and run it where it is, or install ffmpeg to convert from the editor.",
                ),
            !inserting &&
                h(
                    "label",
                    { class: "check-row" },
                    use,
                    "Use the converted video on this slide",
                ),
            h("div", { class: "btn-row end" }, progress, run),
        ),
        {
            wide: true,
            // Closed before it finished: an insert is called off, and a
            // source staged for it goes (cancelling a running ffmpeg first).
            onClose: () => {
                if (finished) return;
                if (job) void request({ action: "convert-cancel", job });
                if (purpose.kind === "insert") {
                    void request({ action: "discard-source", path });
                    purpose.done(null);
                }
            },
        },
    );
    if (inserting) run.textContent = "Convert and insert";
    void update();
}

// ── Picking a video from this computer's folders ──

/** Choose a video file on disk (the server copies it: no upload). */
export function pickVideoFromDisk(start: string): Promise<string | null> {
    return new Promise((resolve) => {
        let chosen: string | null = null;
        const picker = folderPicker(start, () => {}, {
            kind: "video",
            onFile: (path) => {
                chosen = path;
                closeDialog();
            },
        });
        openDialog(
            "Insert a video from this computer",
            h(
                "div",
                { class: "deck-form" },
                h(
                    "p",
                    { class: "hint" },
                    "Pick a video: the server copies it into the deck's assets/ folder straight from disk, however big it is.",
                ),
                picker.el,
            ),
            { large: true, onClose: () => resolve(chosen) },
        );
        picker.focus();
    });
}
