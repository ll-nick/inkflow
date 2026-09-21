// Coordinates status-bar dropdown menus (sync, edit, …) so opening one closes
// any other that's open. Each menu owns its own DOM/open-close logic (syncmenu.ts,
// edit.ts) and just reports through here — this module holds no menu state of its
// own beyond "which close function is currently active", so two menus never import
// each other directly.

let activeClose: (() => void) | null = null;

export function menuOpened(close: () => void): void {
    if (activeClose && activeClose !== close) activeClose();
    activeClose = close;
}

export function menuClosed(close: () => void): void {
    if (activeClose === close) activeClose = null;
}
