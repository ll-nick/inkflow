// The words of the Share dialog's Online section (pure, tested): what the
// owner's inkflow is doing with its room on the relay.

export const GUIDE_URL =
    "https://ll-nick.github.io/inkflow/editor/share-online/";

export interface OnlineStatus {
    available: boolean;
    installHint: string;
    relay: string | null;
    sharing: boolean;
    state?: "off" | "connecting" | "open" | "retrying" | "error";
    error?: string | null;
    links?: { editor: string; view: string } | null;
    guests?: number;
}

export function onlineSummary(o: OnlineStatus): {
    text: string;
    error: string | null;
} {
    const host = o.relay ? o.relay.replace(/^https?:\/\//, "") : "";
    if (!o.sharing) {
        return {
            text: `Not shared online. Share it to get links that work from anywhere, through ${host}.`,
            error: null,
        };
    }
    switch (o.state) {
        case "open": {
            const n = o.guests ?? 0;
            const who =
                n === 0
                    ? "no one has joined yet"
                    : n === 1
                      ? "1 guest connected"
                      : `${n} guests connected`;
            return {
                text: `Shared online through ${host}: ${who}.`,
                error: null,
            };
        }
        case "retrying":
            return {
                text: `Reconnecting to ${host}… (the links work again once it is back)`,
                error: o.error ?? null,
            };
        case "error":
            return {
                text: `Could not share through ${host}.`,
                error: o.error ?? "the relay refused",
            };
        default:
            return { text: `Connecting to ${host}…`, error: null };
    }
}
