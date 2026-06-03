import type { WsMessage } from "../shared/types";
import { renderPv } from "./pv";
import { state } from "./state";
import { applyCurrentStep } from "./status";
import { loadSlide } from "./transitions";
import { hideError, showError } from "./ui";

const wsDot = document.getElementById("ws-dot")!;
// Direct DOM refs to avoid circular import with overview.ts
const overviewEl = document.getElementById("overview")!;
const overviewGridEl = document.getElementById("overview-grid")!;

export function sendNav(): void {
    if (
        !state.ws ||
        state.ws.readyState !== WebSocket.OPEN ||
        state._syncingFromServer
    )
        return;
    state.ws.send(
        JSON.stringify({
            type: "nav",
            slideIndex: state.slideIndex,
            step: state.step,
        }),
    );
}

export function connectWS(wsPort: number | null): void {
    if (!wsPort) return;
    state.ws = new WebSocket(`ws://localhost:${wsPort}`);

    state.ws.onopen = () => {
        wsDot.className = "connected";
        sendNav();
    };

    state.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as WsMessage;
        if (msg.type === "update") {
            state.slides = msg.slides;
            state.transitions = msg.transitions ?? [];
            hideError();
            if (overviewEl.classList.contains("visible")) {
                overviewEl.classList.remove("visible");
                overviewGridEl.innerHTML = "";
            }
            state.slideIndex = Math.min(
                state.slideIndex,
                Math.max(0, state.slides.length - 1),
            );
            state.step = 0;
            loadSlide();
            renderPv();
        } else if (msg.type === "error") {
            showError(msg.message);
        } else if (msg.type === "position") {
            const newIndex = Math.min(
                Math.max(0, msg.slideIndex | 0),
                Math.max(0, state.slides.length - 1),
            );
            const newStep = Math.max(0, msg.step | 0);
            if (newIndex === state.slideIndex && newStep === state.step) return;
            state._syncingFromServer = true;
            state.slideIndex = newIndex;
            state.step = newStep;
            loadSlide(() => {
                if (state.step > 0) applyCurrentStep();
                state._syncingFromServer = false;
            });
            renderPv();
        }
    };

    state.ws.onclose = () => {
        wsDot.className = "";
        state.ws = null;
        setTimeout(() => connectWS(wsPort), 2000);
    };

    state.ws.onerror = () => state.ws?.close();
}
