import type { EditableFile, EditCommandsConfig } from "../shared/types";
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

let config: EditCommandsConfig = { svg: false, md: false };

function isConfigured(file: EditableFile): boolean {
    return file.path.toLowerCase().endsWith(".svg") ? config.svg : config.md;
}

function flashCopied(el: HTMLElement): void {
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 1200);
}

function actOn(file: EditableFile, flashTarget: HTMLElement): void {
    if (
        isConfigured(file) &&
        state.ws &&
        state.ws.readyState === WebSocket.OPEN
    ) {
        state.ws.send(JSON.stringify({ type: "edit", path: file.path }));
        return;
    }
    try {
        void navigator.clipboard.writeText(file.path);
        flashCopied(flashTarget);
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
        row.textContent = file.label;
        row.addEventListener("click", () => {
            actOn(file, row);
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
        const files = state.slides[state.slideIndex]?.editableFiles ?? [];
        if (files.length <= 1) {
            if (files.length === 1) actOn(files[0], btnEdit);
            return;
        }
        toggleMenu();
    });
    renderEditButton();
}
