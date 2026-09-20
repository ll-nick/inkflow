// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// edit.ts captures DOM element references at module evaluation time via
// getElementById, and initEditMenu() is not idempotent (each call adds another
// click listener to the same button) — production code only ever calls it once
// per page load. So each test gets a fresh DOM fragment *and* a fresh module
// instance via vi.resetModules() + dynamic import, mirroring transitions.test.ts,
// rather than reusing one initEditMenu() call across tests.

let initEditMenu: typeof import("./edit").initEditMenu;
let renderEditButton: typeof import("./edit").renderEditButton;
let showEditError: typeof import("./edit").showEditError;
let menuOpened: typeof import("./menus").menuOpened;
let state: typeof import("./state").state;
let btnEdit: HTMLButtonElement;
let editMenu: HTMLElement;
let editWrap: HTMLElement;
let editToast: HTMLElement;
let editToastText: HTMLElement;
let editToastClose: HTMLButtonElement;

beforeEach(async () => {
    document.body.innerHTML = `
        <span class="edit-wrap">
            <button id="btn-edit"></button>
            <div id="edit-menu"></div>
        </span>
        <div id="edit-toast">
            <div id="edit-toast-body">
                <span id="edit-toast-text"></span>
                <button id="edit-toast-close"></button>
            </div>
            <div id="edit-toast-progress"></div>
        </div>
    `;
    vi.resetModules();
    ({ initEditMenu, renderEditButton, showEditError } = await import(
        "./edit"
    ));
    ({ menuOpened } = await import("./menus"));
    ({ state } = await import("./state"));
    btnEdit = document.getElementById("btn-edit") as HTMLButtonElement;
    editMenu = document.getElementById("edit-menu")!;
    editWrap = btnEdit.closest(".edit-wrap") as HTMLElement;
    editToast = document.getElementById("edit-toast")!;
    editToastText = document.getElementById("edit-toast-text")!;
    editToastClose = document.getElementById(
        "edit-toast-close",
    ) as HTMLButtonElement;
    state.slides = [];
    state.slideIndex = 0;
    state.ws = null;
    vi.stubGlobal("navigator", {
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function slideWith(
    ...editableFiles: { label: string; name: string; path: string }[]
) {
    return { id: "s", svg: "", title: "", notes: "", editableFiles };
}

test("hides the wrap entirely when there is no WS port (static export)", () => {
    initEditMenu({ svg: false, default: false }, null);
    expect(editWrap.style.display).toBe("none");
});

test("renderEditButton populates one row per editable file, with an icon, label and filename", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "slide.svg", path: "/deck/slide.svg" },
            { label: "Content", name: "slide.md", path: "/deck/slide.md" },
        ),
    ];
    renderEditButton();
    const rows = editMenu.querySelectorAll(".edit-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector("svg")).not.toBeNull();
    expect(rows[0].querySelector(".edit-row-label")?.textContent).toBe(
        "Layout",
    );
    expect(rows[0].querySelector(".edit-row-name")?.textContent).toBe(
        "slide.svg",
    );
    expect(rows[1].querySelector(".edit-row-label")?.textContent).toBe(
        "Content",
    );
    expect(rows[1].querySelector(".edit-row-name")?.textContent).toBe(
        "slide.md",
    );
});

test("distinct Parent rows still read apart via their filename", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "child.svg", path: "/deck/child.svg" },
            { label: "Parent", name: "parent.svg", path: "/deck/parent.svg" },
            {
                label: "Parent",
                name: "grandparent.svg",
                path: "/deck/grandparent.svg",
            },
        ),
    ];
    renderEditButton();
    const names = Array.from(editMenu.querySelectorAll(".edit-row-name")).map(
        (n) => n.textContent,
    );
    expect(names).toEqual(["child.svg", "parent.svg", "grandparent.svg"]);
});

test("a single editable file still opens a (one-row) dropdown", () => {
    // Never happens in production (pipeline._editable_files always appends the
    // deck script, so the real floor is two entries) but edit.ts makes no
    // assumption about that — it just renders whatever it's given.
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    expect(editMenu.classList.contains("open")).toBe(true);
    expect(editMenu.querySelectorAll(".edit-row").length).toBe(1);
});

test("clicking the lone row copies the full path and flashes a confirmation", () => {
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.svg",
    );
    expect(editMenu.classList.contains("open")).toBe(false);
    expect(editToast.classList.contains("visible")).toBe(true);
    // The full path, not just the filename — a bare "slide.svg" would read as
    // though only the name had been copied.
    expect(editToastText.textContent).toBe("Copied /deck/slide.svg");
});

test("clicking the toast's close button dismisses it early", () => {
    vi.useFakeTimers();
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(editToast.classList.contains("visible")).toBe(true);
    editToastClose.click();
    expect(editToast.classList.contains("visible")).toBe(false);
    // The pending auto-hide timeout must also be cleared, not just overridden by
    // the manual dismiss, otherwise it could re-fire (harmlessly, but sloppily)
    // or clobber a *later* toast's own timer.
    vi.advanceTimersByTime(3000);
    expect(editToast.classList.contains("visible")).toBe(false);
    vi.useRealTimers();
});

test("a second copy in quick succession restarts the auto-hide timer", () => {
    vi.useFakeTimers();
    state.slides = [
        slideWith(
            { label: "Layout", name: "a.svg", path: "/deck/a.svg" },
            { label: "Content", name: "b.md", path: "/deck/b.md" },
        ),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelectorAll<HTMLButtonElement>(".edit-row")[0].click();
    vi.advanceTimersByTime(2000); // most of the way to the first toast's timeout
    btnEdit.click();
    editMenu.querySelectorAll<HTMLButtonElement>(".edit-row")[1].click();
    vi.advanceTimersByTime(2000); // would have closed the first toast by now
    expect(editToast.classList.contains("visible")).toBe(true);
    expect(editToastText.textContent).toBe("Copied /deck/b.md");
    vi.advanceTimersByTime(1000); // completes the second toast's own 3000ms
    expect(editToast.classList.contains("visible")).toBe(false);
    vi.useRealTimers();
});

test("the copy confirmation times itself out", () => {
    vi.useFakeTimers();
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(editToast.classList.contains("visible")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(editToast.classList.contains("visible")).toBe(false);
    vi.useRealTimers();
});

test("multiple editable files open a dropdown instead of acting directly", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "slide.svg", path: "/deck/slide.svg" },
            { label: "Content", name: "slide.md", path: "/deck/slide.md" },
        ),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    expect(editMenu.classList.contains("open")).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

test("opening the edit dropdown closes another open menu (e.g. sync)", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "slide.svg", path: "/deck/slide.svg" },
            { label: "Content", name: "slide.md", path: "/deck/slide.md" },
        ),
    ];
    const closeOther = vi.fn();
    menuOpened(closeOther);
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    expect(closeOther).toHaveBeenCalledOnce();
    expect(editMenu.classList.contains("open")).toBe(true);
});

test("clicking a dropdown row acts on that file and closes the menu", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "slide.svg", path: "/deck/slide.svg" },
            { label: "Content", name: "slide.md", path: "/deck/slide.md" },
        ),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    const contentRow = Array.from(
        editMenu.querySelectorAll<HTMLButtonElement>(".edit-row"),
    ).find(
        (r) => r.querySelector(".edit-row-label")?.textContent === "Content",
    )!;
    contentRow.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.md",
    );
    expect(editMenu.classList.contains("open")).toBe(false);
});

test("a configured command with a live WS connection sends an edit message instead of copying", () => {
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    const send = vi.fn();
    state.ws = { send, readyState: WebSocket.OPEN } as unknown as WebSocket;
    initEditMenu({ svg: true, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(send).toHaveBeenCalledWith(
        JSON.stringify({ type: "edit", path: "/deck/slide.svg" }),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(editToast.classList.contains("visible")).toBe(true);
    expect(editToastText.textContent).toBe("Opened slide.svg");
});

test("a configured command falls back to clipboard when the WS is not open", () => {
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    const send = vi.fn();
    state.ws = { send, readyState: WebSocket.CLOSED } as unknown as WebSocket;
    initEditMenu({ svg: true, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(send).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.svg",
    );
});

test("an unconfigured file kind falls back to clipboard even with a live WS", () => {
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    const send = vi.fn();
    state.ws = { send, readyState: WebSocket.OPEN } as unknown as WebSocket;
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(send).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.svg",
    );
});

test("the general command also applies to SVG files when no SVG-specific override is set", () => {
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    const send = vi.fn();
    state.ws = { send, readyState: WebSocket.OPEN } as unknown as WebSocket;
    initEditMenu({ svg: false, default: true }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(send).toHaveBeenCalledWith(
        JSON.stringify({ type: "edit", path: "/deck/slide.svg" }),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

test("showEditError shows a red, non-auto-dismissing toast", () => {
    vi.useFakeTimers();
    showEditError("failed to launch edit command 'nope': not found");
    expect(editToast.classList.contains("visible")).toBe(true);
    expect(editToast.classList.contains("error")).toBe(true);
    expect(editToastText.textContent).toBe(
        "failed to launch edit command 'nope': not found",
    );
    // Unlike a success toast, an error stays until dismissed — it's diagnostic
    // text worth reading, not a transient confirmation.
    vi.advanceTimersByTime(10_000);
    expect(editToast.classList.contains("visible")).toBe(true);
    vi.useRealTimers();
});

test("the close button dismisses an error toast too", () => {
    showEditError("something went wrong");
    editToastClose.click();
    expect(editToast.classList.contains("visible")).toBe(false);
});

test("a success toast after an error clears the error styling", () => {
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    showEditError("something went wrong");
    expect(editToast.classList.contains("error")).toBe(true);
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    editMenu.querySelector<HTMLButtonElement>(".edit-row")!.click();
    expect(editToast.classList.contains("error")).toBe(false);
    expect(editToast.classList.contains("visible")).toBe(true);
});
