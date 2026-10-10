import type { EditorModel } from "./editor/types";
import type { Render, TransitionFactory } from "./presenter/transitions";
import type {
    EditCommandsConfig,
    LogEntry,
    SlideData,
    SyncMode,
    TransitionData,
} from "./shared/types";

declare global {
    const __SLIDES_JSON__: SlideData[];
    const __TRANSITIONS_JSON__: TransitionData[];
    const __WS_PORT__: number | null;
    const __EDIT_COMMANDS_JSON__: EditCommandsConfig;
    const __ERROR_JSON__: string | null;
    const __LOGS_JSON__: LogEntry[];
    const __MODEL_JSON__: EditorModel | null;
    const __RENDER_SVG__: string;
    const __RENDER_STEP__: number | null;
    const __RENDER_PRINT__: import("./render/measure").PrintCheck | null;

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
