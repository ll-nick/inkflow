import type { EditableFile, EditCommandsConfig } from "../shared/types";
import { menuClosed, menuOpened } from "./menus";
import { state } from "./state";

// Status-bar control for editing the current slide's source file(s). Owns the
// button + dropdown DOM (structurally mirrors syncmenu.ts).
//
// Default action is copying the resolved path to the clipboard — universal,
// works with any editor via paste-navigate. INKFLOW_EDIT_CMD_SVG /
// INKFLOW_EDIT_CMD_MD (server env vars, baked into EditCommandsConfig at page
// load) override that per file kind: when configured *and* there's a live server
// connection, the path is sent to the server to launch instead. The live-connection
// check (not just the boot-time config flag) mirrors websocket.ts's postToPeer
// reasoning — check the real transport, not a static flag — so a disconnected
// server degrades to clipboard-copy instead of silently dropping the click.
//
// Hidden entirely when wsPort is null (a static build/export): there is no server
// to run a command, and copying the deck author's local dev-machine path to an
// arbitrary viewer's clipboard is not a sensible default there.

const btnEdit = document.getElementById("btn-edit")!;
const editMenu = document.getElementById("edit-menu")!;
const editWrap = btnEdit.closest<HTMLElement>(".edit-wrap")!;
const editToast = document.getElementById("edit-toast")!;
const editToastText = document.getElementById("edit-toast-text")!;

let config: EditCommandsConfig = { svg: false, md: false };
let toastTimeout: ReturnType<typeof setTimeout> | null = null;

// One small icon per editableFiles label — a plain signifier, not decoration, so
// entries with the same generic label (several "Parent" rows) still read apart at
// a glance alongside their filename. Trusted, fixed markup (never file/user data).
const ROW_ICONS: Record<string, string> = {
    Layout: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1"/></svg>`,
    Parent: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 14 5.5 8 9 2 5.5 8 2Z"/><path d="M2 9 8 12.5 14 9"/></svg>`,
    Content: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.5h5.5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"/><path d="M9.5 1.5v3.5H13"/><path d="M4.7 9h6.2M4.7 11.3h4.3"/></svg>`,
    Notes: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3.2 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/></svg>`,
    Deck: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 4 2 8l3.5 4"/><path d="M10.5 4 14 8l-3.5 4"/></svg>`,
};

function isConfigured(file: EditableFile): boolean {
    return file.path.toLowerCase().endsWith(".svg") ? config.svg : config.md;
}

// Flashes a confirmation styled like the #log-banner message boxes (same
// surface/border/shadow treatment, an accent colour instead of its warning
// yellow), but with no dismiss button — it always times itself out.
function flashToast(message: string): void {
    if (toastTimeout) clearTimeout(toastTimeout);
    editToastText.textContent = message;
    editToast.classList.add("visible");
    toastTimeout = setTimeout(() => {
        editToast.classList.remove("visible");
        toastTimeout = null;
    }, 1600);
}

function actOn(file: EditableFile): void {
    if (
        isConfigured(file) &&
        state.ws &&
        state.ws.readyState === WebSocket.OPEN
    ) {
        state.ws.send(JSON.stringify({ type: "edit", path: file.path }));
        flashToast(`Opened ${file.name}`);
        return;
    }
    try {
        void navigator.clipboard.writeText(file.path);
        flashToast(`Copied ${file.name}`);
    } catch (_) {}
}

// ── Button / menu rendering ──────────────────────────────────────────────────

export function renderEditButton(): void {
    const files = state.slides[state.slideIndex]?.editableFiles ?? [];
    editMenu.innerHTML = "";
    for (const file of files) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "edit-row";
        row.insertAdjacentHTML("beforeend", ROW_ICONS[file.label] ?? "");
        const text = document.createElement("span");
        text.className = "edit-row-text";
        const label = document.createElement("span");
        label.className = "edit-row-label";
        label.textContent = file.label;
        const name = document.createElement("span");
        name.className = "edit-row-name";
        name.textContent = file.name;
        text.append(label, name);
        row.appendChild(text);
        row.addEventListener("click", () => {
            actOn(file);
            closeMenu();
        });
        editMenu.appendChild(row);
    }
}

// ── Menu open/close ────────────────────────────────────────────────────────────

function onDocClick(e: MouseEvent): void {
    const t = e.target as Node;
    if (!btnEdit.contains(t) && !editMenu.contains(t)) closeMenu();
}

function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
        closeMenu();
        btnEdit.focus();
    }
}

function openMenu(): void {
    editMenu.classList.add("open");
    btnEdit.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
    menuOpened(closeMenu);
}

function closeMenu(): void {
    if (!editMenu.classList.contains("open")) return;
    editMenu.classList.remove("open");
    btnEdit.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKeydown);
    menuClosed(closeMenu);
}

function toggleMenu(): void {
    if (editMenu.classList.contains("open")) closeMenu();
    else openMenu();
}

export function initEditMenu(
    cfg: EditCommandsConfig,
    wsPort: number | null,
): void {
    if (!wsPort) {
        editWrap.style.display = "none";
        return;
    }
    config = cfg;
    btnEdit.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMenu();
    });
    renderEditButton();
}
