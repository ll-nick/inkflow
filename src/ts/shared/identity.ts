// Who this browser is to the people it edits with: a display name chosen
// once, and a private key that ties its undo history together across reloads.
// Both live in this browser's storage only; the key is never shown to anyone.

const NAME_KEY = "inkflow-name";
const ID_KEY = "inkflow-key";

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Private window: the name is asked again next time.
    }
}

export function storedName(): string | null {
    const name = read(NAME_KEY)?.trim();
    return name ? name.slice(0, 40) : null;
}

export function saveName(name: string): void {
    write(NAME_KEY, name.trim().slice(0, 40));
}

let sessionKey: string | null = null;

export function clientKey(): string {
    const stored = read(ID_KEY);
    if (stored && /^[A-Za-z0-9_-]{16,64}$/.test(stored)) return stored;
    if (!sessionKey) {
        const bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        sessionKey = Array.from(bytes, (b) =>
            b.toString(16).padStart(2, "0"),
        ).join("");
        write(ID_KEY, sessionKey);
    }
    return sessionKey;
}

// Two letters for an avatar: "Ana Lima" -> "AL", "ana" -> "AN".
export function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return (words[0] ?? "?").slice(0, 2).toUpperCase();
}
