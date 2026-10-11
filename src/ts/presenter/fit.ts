// Text shrunk to fit its box (shared/fit.ts) on the presenter's stage: each
// slide as it is mounted, before a transition takes it in or it shows, and
// again when web fonts finish loading, unless a transition is under way (a
// transition never sees its slides change size).

import { fitSlide, onFontsLoaded } from "../shared/fit";
import { onSlideMounted } from "./slidehooks";
import { inflightDirection } from "./transitions";

export function initFit(): void {
    const stage = document.getElementById("stage");
    if (!stage) return;
    onSlideMounted(() => fitSlide(stage.firstElementChild));
    onFontsLoaded(() => {
        if (!inflightDirection()) fitSlide(stage.firstElementChild);
    });
}
