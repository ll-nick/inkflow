// Cropping free images on the slide.
//
// A cropped image is a nested <svg> frame (x/y/width/height + viewBox) holding
// the original <image> (inkflow/editor/svgops.py `_crop_frame`). In crop mode
// the selection handles move the frame's edges and its viewBox together
// (geom.ts `planCrop`), so the picture stays put while what is visible changes;
// the rest of the picture shows faded around the frame.

import { drawOverlay, sendSvgOps } from "./canvas";
import { toast } from "./dom";
import { afterRender } from "./insert";
import { edit } from "./net";
import { currentSlide, ed, emit, sourceOf } from "./state";
import type { Selected } from "./types";

/** The <image> shown by a picture object: the element or its crop frame's. */
export function pictureOf(el: Element): SVGImageElement | null {
    if (el.localName === "image") return el as SVGImageElement;
    if (el.localName !== "svg" || !el.getAttribute("viewBox")) return null;
    const images = [...el.children].filter((c) => c.localName === "image");
    return images.length === 1 ? (images[0] as SVGImageElement) : null;
}

export function isCropped(el: Element): boolean {
    return el.localName === "svg" && pictureOf(el) !== null;
}

export function setCropMode(on: boolean): void {
    if (ed.cropMode === on) return;
    ed.cropMode = on;
    document.body.classList.toggle("crop-mode", on);
    drawOverlay();
    emit("crop");
}

export async function startCrop(sel: Selected): Promise<void> {
    if (isCropped(sel.el)) {
        setCropMode(true);
        return;
    }
    if (sel.el.localName !== "image") return;
    const src = sourceOf(sel.key);
    const slide = currentSlide();
    if (!src?.writable || !slide) return;
    // Frame it first (nothing visibly changes), then crop the frame.
    const result = await edit({
        action: "svg",
        file: src.path,
        hash: src.hash,
        ops: [
            { kind: "ensure-id", loc: sel.loc, base: "image", key: "img" },
            { kind: "crop-frame", loc: sel.loc },
        ],
        label: "Crop",
    });
    const id = result.ids?.img;
    if (!result.ok || !id) return;
    afterRender.ids = [id];
    ed.cropMode = true;
    document.body.classList.add("crop-mode");
    toast("Drag the handles to crop; Enter or Esc when done");
}

export async function resetCrop(sel: Selected): Promise<void> {
    if (!isCropped(sel.el)) return;
    setCropMode(false);
    await sendSvgOps(
        [{ sel, ops: [{ kind: "uncrop", loc: sel.loc }] }],
        "Reset crop",
    );
}
