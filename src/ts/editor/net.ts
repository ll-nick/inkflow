// The editor's WebSocket: requests to the server's EditorSession, answered by id,
// plus the pushes every page gets (update, error) and the editor-only ones
// (editor-model, editor-command).

import { applyDeckStyles } from "../shared/deck-styles";
import type { SlideData } from "../shared/types";
import { setDeckCanvas } from "../shared/viewbox";
import { toast } from "./dom";
import { ed, emit } from "./state";
import type { EditorModel, EditRequest, EditResult } from "./types";

let ws: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, (r: EditResult) => void>();
let commandHandler: (msg: Record<string, unknown>) => void = () => {};
let pendingSlides: SlideData[] | null = null;

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

export function connect(port: number): void {
    const host = location.hostname || "localhost";
    const sock = new WebSocket(`ws://${host}:${port}`);
    ws = sock;
    sock.onopen = () => {
        sock.send(JSON.stringify({ type: "hello", role: "editor" }));
        document.body.classList.remove("offline");
        for (const resolve of waiting) resolve();
        waiting = [];
        for (const fn of connectHooks) fn();
    };
    sock.onclose = () => {
        document.body.classList.add("offline");
        for (const resolve of pending.values()) {
            resolve({ ok: false, error: "disconnected from the server" });
        }
        pending.clear();
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
            case "update":
                // Rendered slides; the model that matches them follows at once.
                pendingSlides = msg.slides as SlideData[];
                applyDeckStyles(msg as { styles?: string; mode?: string });
                ed.error = null;
                emit("error");
                break;
            case "editor-model":
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
                if (pendingSlides) {
                    ed.slides = pendingSlides;
                    pendingSlides = null;
                }
                ed.model = msg.model as EditorModel;
                applyDeckSize(ed.model);
                ed.rebuilt = true;
                if (msg.history) {
                    setHistory(msg.history as HistoryState);
                }
                emit("model");
                break;
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
}

function setHistory(h: HistoryState): void {
    ed.canUndo = h.canUndo ?? ed.canUndo;
    ed.canRedo = h.canRedo ?? ed.canRedo;
    if ("undoLabel" in h) ed.undoLabel = h.undoLabel ?? null;
    if ("redoLabel" in h) ed.redoLabel = h.redoLabel ?? null;
    emit("history");
}

// An agent changed the deck through the server (`inkflow slide …`): the step
// is in this History like the author's own, and its Undo takes back exactly
// that step (refused once something else came after it: Ctrl+Z then).
function agentEdit(msg: Record<string, unknown>): void {
    setHistory(msg as HistoryState);
    const label = String(msg.label ?? "Agent: changed the deck");
    const step = msg.step;
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
    return new Promise((resolve) => {
        pending.set(id, resolve);
        sock.send(JSON.stringify({ type: "edit-op", id, ...req }));
    });
}

// A request whose failure is shown to the user; returns the result either way.
let pendingTimer = 0;

// Refusals that only mean "the last edit has not rebuilt yet".
const TRANSIENT = /since the last build|wait for the reload/;

export async function edit(
    req: EditRequest,
    opts: { retrying?: boolean } = {},
): Promise<EditResult> {
    const result = await request(req);
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
    for (const slide of ed.model?.slides ?? []) {
        for (const src of slide.sources ?? []) {
            if (src.path in hashes) src.hash = hashes[src.path];
        }
    }
}

export function sendRaw(payload: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(payload));
}
