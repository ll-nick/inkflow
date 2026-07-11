import type { Render, TransitionFactory } from "./presenter/transitions";
import type {
    LogEntry,
    SlideData,
    SyncMode,
    TransitionData,
} from "./shared/types";

declare global {
    const __SLIDES_JSON__: SlideData[];
    const __TRANSITIONS_JSON__: TransitionData[];
    const __WS_PORT__: number | null;
    const __ERROR_JSON__: string | null;
    const __LOGS_JSON__: LogEntry[];

    interface Window {
        inkflow: {
            registerTransition(name: string, factory: TransitionFactory): void;
            registerProgressTransition(
                name: string,
                render: Render,
                options?: { easing?: string },
            ): void;
            setSyncMode(mode: SyncMode): void;
        };
    }
}
