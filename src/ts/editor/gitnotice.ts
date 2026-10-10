// The once-per-session warning before the first git operation that rewrites
// the deck's files (the editor's undo history is cleared afterwards), shared
// by the Git menu and the compare view's Merge.

const NOTICE_KEY = "inkflow-git-undo-notice";
let noticeShown = false;

export function undoNoticeDue(): boolean {
    try {
        return sessionStorage.getItem(NOTICE_KEY) !== "1" && !noticeShown;
    } catch {
        return !noticeShown;
    }
}

export function undoNoticeShown(): void {
    noticeShown = true;
    try {
        sessionStorage.setItem(NOTICE_KEY, "1");
    } catch {
        // private mode: remembered for this page only
    }
}

export const UNDO_NOTICE =
    "Note: git changes the deck's files on disk, so the editor's undo and redo history is cleared afterwards (Ctrl+Z cannot go back past this point). You are told this once per session.";
