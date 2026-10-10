// The presenter's ink held in memory, per slide: the strokes of the talk
// (drawn here or relayed from another window) and what undo takes back. A
// stroke saved to the slide's ink file is shown from that file once the
// rebuild brings it; until then it is held here too (`saved`), so it never
// blinks out between the pen lifting and the file coming back.

import type { InkStroke } from "../shared/ink";

export interface HeldStroke extends InkStroke {
    // Written (or being written) to the slide's ink file.
    saved?: boolean;
}

// One undoable thing done to a slide's ink: strokes drawn, or strokes taken
// away (by the eraser or Clear). Undo does the opposite with the same strokes.
export interface InkAction {
    kind: "add" | "erase";
    strokes: HeldStroke[];
}

const UNDO_LIMIT = 200;

export class SlideInk {
    strokes: HeldStroke[] = [];
    // Bumped on every change, so a render can tell it is up to date.
    rev = 0;
    private history: InkAction[] = [];

    // Show these strokes; one with the id of a stroke already here replaces it
    // in place (a relayed stroke finishing, a save coming back).
    add(strokes: HeldStroke[]): void {
        for (const s of strokes) {
            const i = this.strokes.findIndex((x) => x.id === s.id);
            if (i >= 0) this.strokes[i] = s;
            else this.strokes.push(s);
        }
        if (strokes.length) this.rev++;
    }

    // Stop showing these; returns the ones that were here.
    remove(ids: Iterable<string>): HeldStroke[] {
        const gone = new Set(ids);
        const removed = this.strokes.filter((s) => gone.has(s.id));
        if (removed.length) {
            this.strokes = this.strokes.filter((s) => !gone.has(s.id));
            this.rev++;
        }
        return removed;
    }

    record(action: InkAction): void {
        if (!action.strokes.length) return;
        this.history.push(action);
        this.history.splice(0, this.history.length - UNDO_LIMIT);
    }

    // The last action, taken off the history: the caller undoes it.
    popUndo(): InkAction | null {
        return this.history.pop() ?? null;
    }

    get canUndo(): boolean {
        return this.history.length > 0;
    }

    // Saved strokes the slide's ink file now shows: no longer held here.
    settle(inFile: Set<string>): void {
        const before = this.strokes.length;
        this.strokes = this.strokes.filter((s) => !inFile.has(s.id));
        if (this.strokes.length !== before) this.rev++;
    }
}

export class InkStore {
    private slides = new Map<string, SlideInk>();

    get(slideId: string): SlideInk {
        let ink = this.slides.get(slideId);
        if (!ink) {
            ink = new SlideInk();
            this.slides.set(slideId, ink);
        }
        return ink;
    }

    // Every slide's strokes, for a window that just connected.
    snapshot(): Record<string, InkStroke[]> {
        const out: Record<string, InkStroke[]> = {};
        for (const [id, ink] of this.slides) {
            const shown = ink.strokes.map(({ saved: _, ...s }) => s);
            if (shown.length) out[id] = shown;
        }
        return out;
    }
}
