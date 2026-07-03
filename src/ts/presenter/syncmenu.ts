import type { SyncMode } from "../shared/types";
import { state } from "./state";
import { applySyncMode } from "./websocket";

// Status-bar control for the per-client sync mode. Owns the button + dropdown DOM;
// delegates the state/network side to websocket.applySyncMode. See shared/types.ts
// SyncMode and the handshake notes in websocket.ts.

const btnSync = document.getElementById("btn-sync")!;
const syncMenu = document.getElementById("sync-menu")!;
const syncWrap = btnSync.closest<HTMLElement>(".sync-wrap")!;

let enabled = false;

const SYNC_ORDER: SyncMode[] = ["two-way", "present", "follow", "solo"];
const SYNC_LABELS: Record<SyncMode, string> = {
    "two-way": "Two-way (send + receive)",
    present: "Present (send only)",
    follow: "Follow (receive only)",
    solo: "Solo (no sync)",
};

function renderSyncButton(): void {
    btnSync.dataset.mode = state.syncMode;
    const label = SYNC_LABELS[state.syncMode];
    btnSync.title = `Sync: ${label} (s)`;
    btnSync.setAttribute("aria-label", `Sync mode: ${label}`);
    for (const row of syncMenu.querySelectorAll<HTMLElement>(".sync-row")) {
        const active = row.dataset.mode === state.syncMode;
        row.classList.toggle("active", active);
        row.setAttribute("aria-checked", String(active));
    }
}

export function setSyncMode(mode: SyncMode): void {
    applySyncMode(mode);
    renderSyncButton();
    closeMenu();
}

export function cycleSyncMode(): void {
    if (!enabled) return;
    const i = SYNC_ORDER.indexOf(state.syncMode);
    setSyncMode(SYNC_ORDER[(i + 1) % SYNC_ORDER.length]);
}

// ── Menu open/close ────────────────────────────────────────────────────────────

function onDocClick(e: MouseEvent): void {
    const t = e.target as Node;
    if (!btnSync.contains(t) && !syncMenu.contains(t)) closeMenu();
}

function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
        closeMenu();
        btnSync.focus();
    }
}

function openMenu(): void {
    syncMenu.classList.add("open");
    btnSync.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
}

function closeMenu(): void {
    if (!syncMenu.classList.contains("open")) return;
    syncMenu.classList.remove("open");
    btnSync.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKeydown);
}

function toggleMenu(): void {
    if (syncMenu.classList.contains("open")) closeMenu();
    else openMenu();
}

export function initSyncMenu(wsPort: number | null): void {
    if (!wsPort) {
        syncWrap.style.display = "none";
        return;
    }
    enabled = true;
    btnSync.addEventListener("click", (e) => {
        // Stop the opening click from reaching the just-added outside-click handler.
        e.stopPropagation();
        toggleMenu();
    });
    for (const row of syncMenu.querySelectorAll<HTMLElement>(".sync-row"))
        row.addEventListener("click", () =>
            setSyncMode(row.dataset.mode as SyncMode),
        );
    renderSyncButton();
}
