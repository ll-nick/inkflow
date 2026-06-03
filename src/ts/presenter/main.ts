import { renderPv, updatePvClock } from "./pv";
import { state } from "./state";
import { applyCurrentStep, readURL } from "./status";
import { loadSlide } from "./transitions";
import { showError } from "./ui";
import { connectWS } from "./websocket";
import "./keyboard";

// ── Injected by server ──
const INITIAL_SLIDES = __SLIDES_JSON__;
const INITIAL_TRANSITIONS = __TRANSITIONS_JSON__;
const WS_PORT = __WS_PORT__;
const INITIAL_ERROR = __ERROR_JSON__;

// ── Initialize state from server-injected globals ──
state.slides = INITIAL_SLIDES;
state.transitions = INITIAL_TRANSITIONS;

// ── Boot ──
readURL();
loadSlide(() => {
    if (state.step > 0) applyCurrentStep();
    renderPv();
});
updatePvClock();
setInterval(updatePvClock, 1000);
if (INITIAL_ERROR) showError(INITIAL_ERROR);
connectWS(WS_PORT);
