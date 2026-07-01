// Escape a string for safe interpolation into an HTML template literal that is
// then assigned to innerHTML. Author-controlled strings (e.g. slide titles) reach
// the DOM as markup in a few places; run them through this first. `&` must be
// replaced before the others so already-produced entities are not double-escaped.
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
