// The editor's WebSocket: requests to the server's EditorSession, answered by id,
// plus the pushes every page gets (update, error) and the editor-only ones
// (editor-model, editor-command).

import { applyDeckStyles } from "../shared/deck-styles";
import { applyPatch, isWhole, type Keyed, type Patch } from "../shared/patch";
import type { SlideData } from "../shared/types";
import { setDeckCanvas } from "../shared/viewbox";
import { openSocket, SENT_AWAY } from "../shared/wsurl";
import type { Person } from "./collab";
import { presenceConnected, setPeople, welcome } from "./collab";
import { toast } from "./dom";
import { ed, emit, off, on } from "./state";
import type { EditorModel, EditRequest, EditResult, SlideModel } from "./types";

let ws: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, (r: EditResult) => void>();
let commandHandler: (msg: Record<string, unknown>) => void = () => {};
let pendingSlides: SlideData[] | null = null;
// The page found it does not hold what a patch named and asked for the whole
// deck: patches sent before the server heard that are of no use.
let resyncing = false;

/** The list a rebuild sent, put together from what the page holds; null
 * (and the whole deck asked for) when it names something the page lacks. */
function take<T extends Keyed>(held: readonly T[], sent: Patch<T>): T[] | null {
    if (resyncing && !isWhole(sent)) return null;
    const list = applyPatch(held, sent);
    if (!list && !resyncing) {
        resyncing = true;
        sendRaw({ type: "resync" });
    }
    return list;
}

// The deck's canvas: the fallback for a slide without a viewBox, and the shape
// of a thumbnail before its slide is drawn (`--deck-ar`).
function applyDeckSize(model: EditorModel): void {
    const size = model.deckSize;
    if (!size) return;
    const [w, h] = size.canvas;
    setDeckCanvas(w, h);
    document.documentElement.style.setProperty("--deck-ar", `${w} / ${h}`);
}

export function onCommand(fn: (msg: Record<string, unknown>) => void): void {
    commandHandler = fn;
}

// Pushes other modules own (the compare view's "compare-*" messages), and
// what to do each time the connection (re)opens.
const handlers = new Map<string, (msg: Record<string, unknown>) => void>();
const connectHooks: (() => void)[] = [];

export function onMessage(
    type: string,
    fn: (msg: Record<string, unknown>) => void,
): void {
    handlers.set(type, fn);
}

export function onConnect(fn: () => void): void {
    connectHooks.push(fn);
}

export function connected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
}

// After "Quit Inkflow" the page stops reconnecting to the stopped server.
let stopped = false;

export function stopReconnecting(): void {
    stopped = true;
}

// Callers waiting for the connection (the start page's first request).
let waiting: (() => void)[] = [];

export function whenConnected(): Promise<void> {
    if (connected()) return Promise.resolve();
    return new Promise((resolve) => waiting.push(resolve));
}

// `port` only says the page is served; the socket is on the page's own
// address (a share link's, an SSH tunnel's), at /_inkflow/ws.
export function connect(port: number): void {
    const sock = openSocket();
    ws = sock;
    sock.onopen = () => {
        presenceConnected();
        resyncing = false;
        sock.send(
            JSON.stringify({ type: "hello", role: "editor", patch: true }),
        );
        document.body.classList.remove("offline");
        for (const resolve of waiting) resolve();
        waiting = [];
        for (const fn of connectHooks) fn();
    };
    sock.onclose = (ev) => {
        document.body.classList.add("offline");
        for (const resolve of pending.values()) {
            resolve({ ok: false, error: "disconnected from the server" });
        }
        pending.clear();
        if (ev.code === SENT_AWAY) {
            // The owner stopped sharing, made new links or disconnected this
            // page: the link no longer opens the deck.
            stopped = true;
            sentAway(ev.reason);
            return;
        }
        if (!stopped) window.setTimeout(() => connect(port), 1500);
    };
    sock.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(event.data as string);
        } catch {
            return;
        }
        switch (msg.type) {
            case "update": {
                // Rendered slides (the ones that changed; the rest by key);
                // the model that matches them follows at once.
                const slides = take(
                    pendingSlides ?? ed.slides,
                    msg.slides as Patch<SlideData>,
                );
                if (slides) pendingSlides = slides;
                if (msg.styles !== undefined || msg.mode !== undefined) {
                    ed.restyled = true;
                }
                applyDeckStyles(msg as { styles?: string; mode?: string });
                ed.error = null;
                emit("error");
                break;
            }
            case "editor-model": {
                // The server opened another deck (or the first one, from
                // the start page): start the page afresh.
                if (
                    document.body.classList.contains("start-mode") ||
                    (ed.model &&
                        (msg.model as EditorModel).deckPath !==
                            ed.model.deckPath)
                ) {
                    // The start page may be at any path; the editor is /edit.
                    location.assign("/edit");
                    return;
                }
                const model = msg.model as EditorModel;
                const entries = take(
                    ed.model?.slides ?? [],
                    model.slides as Patch<SlideModel>,
                );
                if (!entries) return;
                if (isWhole(model.slides as Patch<SlideModel>)) {
                    resyncing = false;
                }
                model.slides = entries;
                if (pendingSlides) {
                    ed.slides = pendingSlides;
                    pendingSlides = null;
                }
                ed.model = model;
                applyDeckSize(ed.model);
                ed.rebuilt = true;
                if (msg.history) {
                    setHistory(msg.history as HistoryState);
                }
                emit("model");
                break;
            }
            case "error":
                ed.error = String(msg.message ?? "build error");
                emit("error");
                break;
            case "edit-result": {
                const resolve = pending.get(msg.id as number);
                pending.delete(msg.id as number);
                resolve?.(msg as unknown as EditResult);
                break;
            }
            case "editor-command":
                commandHandler(msg);
                break;
            case "agent-edit":
                agentEdit(msg);
                break;
            case "history":
                // Someone's edit may block, or free, this person's Undo.
                setHistory(msg as HistoryState);
                break;
            case "welcome":
                welcome(msg);
                break;
            case "presence":
                setPeople((msg.people as Person[]) ?? []);
                break;
            case "notify":
                toast(String(msg.message ?? ""));
                break;
            default:
                handlers.get(String(msg.type))?.(msg);
        }
    };
}

interface HistoryState {
    canUndo?: boolean;
    canRedo?: boolean;
    undoLabel?: string | null;
    redoLabel?: string | null;
    undoBlockedBy?: string | null;
}

function setHistory(h: HistoryState): void {
    ed.canUndo = h.canUndo ?? ed.canUndo;
    ed.canRedo = h.canRedo ?? ed.canRedo;
    if ("undoLabel" in h) ed.undoLabel = h.undoLabel ?? null;
    if ("redoLabel" in h) ed.redoLabel = h.redoLabel ?? null;
    if ("undoBlockedBy" in h) ed.undoBlockedBy = h.undoBlockedBy ?? null;
    emit("history");
}

function sentAway(reason: string): void {
    const box = document.getElementById("build-error");
    if (box) {
        box.textContent = `Disconnected: ${reason || "this link no longer opens the deck"}. Ask the person sharing it for a new link.`;
        box.classList.add("show");
    }
}

// An agent changed the deck through the server (`inkflow slide …`): the step
// is in this History like the author's own, and its Undo takes back exactly
// that step (refused once something else came after it: Ctrl+Z then).
function agentEdit(msg: Record<string, unknown>): void {
    setHistory(msg as HistoryState);
    const label = String(msg.label ?? "Agent: changed the deck");
    const step = msg.step;
    // The agent works for the owner: only their pages can take it back.
    if (!msg.mine) {
        toast(label, "info");
        return;
    }
    toast(label, "info", {
        label: "Undo",
        run: () => {
            void edit({
                action: "undo",
                ...(typeof step === "number" ? { step } : {}),
            });
        },
    });
}

// Send one request; resolves with the server's result (never rejects).
export function request(req: EditRequest): Promise<EditResult> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        toast("Not connected to the inkflow server", "error");
        return Promise.resolve({ ok: false, error: "not connected" });
    }
    const id = nextId++;
    const sock = ws;
    // The build this page shows: a write to a file someone changed since is
    // refused rather than undoing their change.
    const base =
        req.action === "undo" || req.action === "redo"
            ? {}
            : ed.model?.build != null
              ? { baseBuild: ed.model.build }
              : {};
    // A theme's layout edited in the slide master: the server makes the
    // deck's own copy in the same step (`EditorSession._copy_on_write`).
    const cow =
        typeof req.file === "string" &&
        ed.master?.slide.sources?.some(
            (s) => s.path === req.file && s.copyTo != null,
        )
            ? { copyLayout: true }
            : {};
    return new Promise((resolve) => {
        pending.set(id, (result) => {
            if (result.ok && result.copied) copied(result);
            resolve(result);
        });
        sock.send(
            JSON.stringify({ type: "edit-op", id, ...base, ...cow, ...req }),
        );
    });
}

// The deck now has its own copy of what the slide master shows: further
// edits go to the copy (its hash from this result), and the user is told.
function copied(result: EditResult): void {
    const info = result.copied as { from: string; to: string; note: string };
    const hash = result.hashes?.[info.to];
    for (const src of ed.master?.slide.sources ?? []) {
        if (src.path !== info.from) continue;
        src.path = info.to;
        src.copyTo = undefined;
        src.writable = true;
        if (hash) src.hash = hash;
    }
    if (ed.master?.path === info.from) ed.master.path = info.to;
    toast(info.note, "info");
    emit("master-copied");
}

// A request whose failure is shown to the user; returns the result either way.
let pendingTimer = 0;

/** Resolves once a model newer than build `than` is here (true), or after
 * `ms` without one (false). */
export function newerBuild(
    than: number | undefined,
    ms = 4000,
): Promise<boolean> {
    return new Promise((resolve) => {
        const now = () => ed.model?.build != null && ed.model.build !== than;
        if (now()) {
            resolve(true);
            return;
        }
        const done = (ok: boolean) => {
            window.clearTimeout(timer);
            off("model", check);
            resolve(ok);
        };
        const check = () => {
            if (now()) done(true);
        };
        const timer = window.setTimeout(() => done(false), ms);
        on("model", check);
    });
}

// Refusals that only mean "the last edit has not rebuilt yet".
const TRANSIENT = /since the last build|wait for the reload/;

export async function edit(
    req: EditRequest,
    opts: { retrying?: boolean; quietStale?: boolean } = {},
): Promise<EditResult> {
    const result = await request(req);
    if (!result.ok && result.stale && opts.quietStale) return result;
    if (!result.ok && result.stale) {
        // Someone else changed what this edit was aimed at: the newer
        // build is on its way (or here); show it instead of the preview.
        toast(
            result.error ?? "Changed by someone else meanwhile — updated",
            "error",
        );
        emit("stale");
        return result;
    }
    if (!result.ok && !(opts.retrying && TRANSIENT.test(result.error ?? ""))) {
        toast(result.error ?? "edit failed", "error");
    }
    if (result.ok) {
        ed.canUndo = result.canUndo ?? ed.canUndo;
        ed.canRedo = result.canRedo ?? ed.canRedo;
        if ("undoLabel" in result) ed.undoLabel = result.undoLabel ?? null;
        if ("redoLabel" in result) ed.redoLabel = result.redoLabel ?? null;
        // After an edit that moved elements (or an undo, which may have), the
        // locators on screen no longer match the file: keep the old hashes so
        // the server refuses anything aimed at them until the rebuild lands.
        if (
            result.structural ||
            req.action === "undo" ||
            req.action === "redo"
        ) {
            ed.structuralPending = true;
            // A rebuild that never comes (a build error) must not lock editing.
            window.clearTimeout(pendingTimer);
            pendingTimer = window.setTimeout(() => {
                ed.structuralPending = false;
            }, 4000);
        } else {
            updateHashes(result.hashes ?? {});
        }
        emit("history");
    }
    return result;
}

// Keep source hashes current between an edit and the rebuild it triggers, so a
// quick second edit to the same file is not refused as stale.
function updateHashes(hashes: Record<string, string>): void {
    const shown = ed.master ? [ed.master.slide] : [];
    for (const slide of [...(ed.model?.slides ?? []), ...shown]) {
        for (const src of slide.sources ?? []) {
            if (!(src.path in hashes)) continue;
            src.hash = hashes[src.path];
            // No longer the entry the server means by this key.
            slide.key = undefined;
        }
    }
}

export function sendRaw(payload: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(payload));
}
