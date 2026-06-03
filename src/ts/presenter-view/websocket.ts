import type { WsMessage } from "../shared/types";
import { applyCurrentStep, renderAll, renderNext, updateInfo } from "./render";
import { state } from "./state";

const dotEl = document.getElementById("pv-dot");
const liveLabel = document.getElementById("pv-live-label");

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
        dotEl.classList.add("connected");
        liveLabel.textContent = "live";
    };

    state.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as WsMessage;
        if (msg.type === "update") {
            state.slides = msg.slides;
            state.slideIndex = Math.min(
                state.slideIndex,
                Math.max(0, state.slides.length - 1),
            );
            state.step = 0;
            renderAll();
        } else if (msg.type === "position") {
            const newIndex = Math.min(
                Math.max(0, msg.slideIndex | 0),
                Math.max(0, state.slides.length - 1),
            );
            const newStep = Math.max(0, msg.step | 0);
            if (newIndex === state.slideIndex && newStep === state.step) return;
            state._syncingFromServer = true;
            const slideChanged = newIndex !== state.slideIndex;
            state.slideIndex = newIndex;
            state.step = newStep;
            if (slideChanged) {
                renderAll();
            } else {
                applyCurrentStep();
                updateInfo();
                renderNext();
            }
            state._syncingFromServer = false;
        }
    };

    state.ws.onclose = () => {
        dotEl.classList.remove("connected");
        liveLabel.textContent = "offline";
        state.ws = null;
        setTimeout(() => connectWS(wsPort), 2000);
    };

    state.ws.onerror = () => state.ws?.close();
}
