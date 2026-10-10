// Videos on the editor canvas are objects to place, not players: their native
// controls are removed and they let clicks through to the zone (canvas.ts
// prepareForEditing, editor CSS), so a click selects the video and a drag
// moves it. Playing one to check it is this preview, from the properties
// panel or the right-click menu; the presenter plays videos as the deck says
// (controls, autoplay, play on a step).

/** The video an object on the canvas shows, if any. */
export function videoOf(
    el: Element | null | undefined,
): HTMLVideoElement | null {
    if (!el) return null;
    return el.localName === "video"
        ? (el as HTMLVideoElement)
        : el.querySelector("video");
}

export function isPreviewing(video: HTMLVideoElement): boolean {
    return !video.paused && !video.ended;
}

/** Play or pause in place, within the clip's trim (data-start / data-end). */
export function togglePreview(video: HTMLVideoElement): void {
    if (isPreviewing(video)) {
        video.pause();
        return;
    }
    const start = parseFloat(video.dataset.start ?? "") || 0;
    const end = parseFloat(video.dataset.end ?? "");
    if (video.currentTime < start || (end > 0 && video.currentTime >= end)) {
        video.currentTime = start;
    }
    if (end > 0) {
        const stop = () => {
            if (video.currentTime >= end) {
                video.pause();
                video.removeEventListener("timeupdate", stop);
            }
        };
        video.addEventListener("timeupdate", stop);
    }
    void video.play().catch(() => {
        // Not playable here (an unsupported codec, a missing file).
    });
}

/** A button that plays and pauses the video, following its state. */
export function previewButton(
    video: HTMLVideoElement,
    make: (label: string, title: string, fn: () => void) => HTMLButtonElement,
): HTMLButtonElement {
    const btn = make(
        "▶ Play preview",
        "Play the video here (the presenter plays it as the deck says)",
        () => togglePreview(video),
    );
    const sync = () => {
        btn.textContent = isPreviewing(video)
            ? "⏸ Pause preview"
            : "▶ Play preview";
    };
    for (const ev of ["play", "pause", "ended"])
        video.addEventListener(ev, sync);
    sync();
    return btn;
}
