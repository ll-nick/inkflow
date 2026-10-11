// The PDF export page (pdf.html, bundled to fit.js): text shrunk to fit its
// box on every slide, as the presenter shows it (shared/fit.ts). Run as the
// page is parsed, and again once its fonts are in, before Chromium prints.

import { fitSlide } from "../shared/fit";

function fitAll(): void {
    for (const svg of Array.from(document.querySelectorAll(".trim > svg"))) {
        fitSlide(svg);
    }
}

fitAll();
window.addEventListener("load", fitAll);
void document.fonts?.ready.then(fitAll);
