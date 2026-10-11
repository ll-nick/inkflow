// Back from presenting to the visual editor, at the slide on screen. Only a
// served deck has an editor (a static build has no server: WS_PORT is null).
//
// The editor's Present button opens this page in a window of its own; when
// that editor tab is still there, it is moved to this slide and brought back,
// and this window closes. Otherwise this tab becomes the editor.

import { state } from "./state";

let served = false;

export function backToEditor(): void {
    if (!served) return;
    const hash = `#slide=${state.slideIndex + 1}`;
    const opener = window.opener as Window | null;
    try {
        if (
            opener &&
            !opener.closed &&
            opener.location.origin === location.origin &&
            opener.location.pathname.startsWith("/edit")
        ) {
            opener.location.hash = hash;
            opener.focus();
            window.close();
            if (window.closed) return;
        }
    } catch {
        // Another origin, or a window that is gone: take this tab instead.
    }
    location.href = `/edit${hash}`;
}

export function initToEditor(wsPort: number | null): void {
    const button = document.getElementById("btn-to-editor");
    served = wsPort != null;
    if (!button) return;
    if (!served) {
        button.style.display = "none";
        return;
    }
    button.addEventListener("click", backToEditor);
}
