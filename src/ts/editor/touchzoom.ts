// Zooming the editor's canvas with gestures (shared/gesturepad.ts): a
// trackpad pinch or Ctrl/⌘+wheel zooms about the pointer, two fingers on a
// touchscreen zoom about their midpoint and pan with it, a double tap or
// double-click on the slide's empty area fits the slide. A plain wheel or a
// two-finger trackpad scroll still scrolls the canvas natively.
//
// One finger keeps its meaning (select, drag, marquee, an insert tool), but
// a finger's touch is held back until it commits (it moved past the slop
// and the pinch window passed) or lifts, and is then replayed to the canvas
// as it happened. A second finger landing before that makes a pinch, and the
// held-back finger is simply dropped: no selection change, no drag preview,
// nothing sent. Deferring rather than undoing is what lets every tool keep
// its own pointer handling: an insert tool's draft or a drag's snapshot has
// nothing to roll back. The one exception is drawing with a finger (the pen
// tool with "fingers draw" on), where latency matters: that stroke starts at
// once and is dropped if a second finger turns the touch into a pinch.

import { GesturePad } from "../shared/gesturepad";
import { hooks, pick, setZoom, zoomAbout, zoomEnded } from "./canvas";
import { cancelStroke, fingersDraw } from "./ink";
import { ed } from "./state";

export function initTouchZoom(): void {
    const canvas = document.getElementById("canvas")!;
    new GesturePad({
        surface: canvas,
        // Text being edited in place keeps the browser's caret and selection.
        defer: (e) =>
            !fingersDraw() && !hooks.editingHost()?.contains(e.target as Node),
        cancelSingle: cancelStroke,
        zoom: (factor, from, to) => zoomAbout(factor, from, to),
        zoomEnd: zoomEnded,
        doubleTap: (at) => {
            if (ed.tool !== "select" || ed.richEditing) return;
            if (!pick(at.x, at.y)) setZoom(0);
        },
    });
}
