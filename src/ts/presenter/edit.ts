import type { EditableFile, EditCommandsConfig } from "../shared/types";
import { menuClosed, menuOpened } from "./menus";
import { state } from "./state";
import { showNotify } from "./ui";

// Status-bar control for editing the current slide's source file(s). Owns the
// button + dropdown DOM (structurally mirrors syncmenu.ts).
//
// Default action is copying the resolved path to the clipboard — universal,
// works with any editor via paste-navigate. INKFLOW_EDIT_CMD / INKFLOW_EDIT_CMD_SVG
// (server env vars, baked into EditCommandsConfig at page load) override that:
// INKFLOW_EDIT_CMD_SVG overrides INKFLOW_EDIT_CMD for SVG files, which otherwise
// covers every file kind. When configured *and* there's a live server connection,
// the path is sent to the server to launch instead. The live-connection check
// (not just the boot-time config flag) mirrors websocket.ts's postToPeer
// reasoning — check the real transport, not a static flag — so a disconnected
// server degrades to clipboard-copy instead of silently dropping the click.
//
// Hidden entirely when wsPort is null (a static build/export): there is no server
// to run a command, and copying the deck author's local dev-machine path to an
// arbitrary viewer's clipboard is not a sensible default there.

const btnEdit = document.getElementById("btn-edit")!;
const editMenu = document.getElementById("edit-menu")!;
const editWrap = btnEdit.closest<HTMLElement>(".edit-wrap")!;

let config: EditCommandsConfig = { default: false, svg: false };

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
    // config.svg overrides config.default for SVG files; every other kind
    // always uses the general command — mirrors edit.py's command_for.
    if (file.path.toLowerCase().endsWith(".svg")) {
        return config.svg || config.default;
    }
    return config.default;
}

function actOn(file: EditableFile): void {
    if (
        isConfigured(file) &&
        state.ws &&
        state.ws.readyState === WebSocket.OPEN
    ) {
        state.ws.send(JSON.stringify({ type: "edit", path: file.path }));
        showNotify(`Opened ${file.name}`);
        return;
    }
    try {
        void navigator.clipboard.writeText(file.path);
        // The full path, not just file.name: a bare filename here would read as
        // though only the name (not the whole path) had been copied.
        showNotify(`Copied ${file.path}`);
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

// ── Keyboard navigation (mirrors overview.ts's active-index pattern) ───────────
// Unlike syncmenu.ts's identically-shaped dropdown, this one can't just cycle
// through options on a single keypress — acting on a file has a real side effect
// (a clipboard write or a spawned editor command), so highlighting a row and
// committing it must be separate steps. Ownership of the open-state keys
// (arrows/j/k/Enter/Escape) therefore lives in keyboard.ts's global cascade, not
// a listener local to this module: a local listener registered only while the
// menu is open would run *after* keyboard.ts's (registered once at boot), too
// late to stop it from also treating j/k/arrows as slide navigation underneath
// the open menu.

export function editMenuSetActive(i: number): void {
    const rows = Array.from(
        editMenu.querySelectorAll<HTMLElement>(".edit-row"),
    );
    if (rows.length === 0) return;
    state._editActive = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((row, idx) => {
        row.classList.toggle("active", idx === state._editActive);
    });
    rows[state._editActive]?.scrollIntoView({ block: "nearest" });
}

export function editMenuCommit(): void {
    const files = state.slides[state.slideIndex]?.editableFiles ?? [];
    const file = files[state._editActive];
    if (file) actOn(file);
    closeMenu();
}

// ── Menu open/close ────────────────────────────────────────────────────────────

function onDocClick(e: MouseEvent): void {
    const t = e.target as Node;
    if (!btnEdit.contains(t) && !editMenu.contains(t)) closeMenu();
}

function openMenu(): void {
    editMenu.classList.add("open");
    btnEdit.setAttribute("aria-expanded", "true");
    editMenuSetActive(0);
    document.addEventListener("click", onDocClick);
    menuOpened(closeMenu);
}

export function closeMenu(): void {
    if (!editMenu.classList.contains("open")) return;
    editMenu.classList.remove("open");
    btnEdit.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    menuClosed(closeMenu);
}

export function toggleMenu(): void {
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
