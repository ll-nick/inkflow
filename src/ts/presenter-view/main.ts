import { updateClock } from "./clock";
import { renderAll } from "./render";
import { state } from "./state";
import { connectWS } from "./websocket";
import "./keyboard";

// ── Injected by server ──
const INITIAL_SLIDES = __SLIDES_JSON__;
const INITIAL_POSITION = __INITIAL_POSITION__;
const WS_PORT = __WS_PORT__;

// ── Initialize state from server-injected globals ──
state.slides = INITIAL_SLIDES;
state.slideIndex = Math.min(
    Math.max(0, INITIAL_POSITION.slideIndex | 0),
    Math.max(0, state.slides.length - 1),
);
state.step = Math.max(0, INITIAL_POSITION.step | 0);

// ── Boot ──
renderAll();
updateClock();
setInterval(updateClock, 1000);
connectWS(WS_PORT);
