// A rebuild that changed the deck's stylesheet or colour mode (a theme edit)
// restyles the open page in place.
export function applyDeckStyles(msg: { styles?: string; mode?: string }): void {
    if (msg.styles !== undefined) {
        const el = document.getElementById("deck-styles");
        if (el) el.textContent = msg.styles;
    }
    if (msg.mode !== undefined)
        document.documentElement.dataset.theme = msg.mode;
}
