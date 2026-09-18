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
let menuOpened: typeof import("./menus").menuOpened;
let state: typeof import("./state").state;
let btnEdit: HTMLButtonElement;
let editMenu: HTMLElement;
let editWrap: HTMLElement;
let editToast: HTMLElement;
let editToastText: HTMLElement;

beforeEach(async () => {
    document.body.innerHTML = `
        <span class="edit-wrap">
            <button id="btn-edit"></button>
            <div id="edit-menu"></div>
            <div id="edit-toast"><span id="edit-toast-text"></span></div>
        </span>
    `;
    vi.resetModules();
    ({ initEditMenu, renderEditButton } = await import("./edit"));
    ({ menuOpened } = await import("./menus"));
    ({ state } = await import("./state"));
    btnEdit = document.getElementById("btn-edit") as HTMLButtonElement;
    editMenu = document.getElementById("edit-menu")!;
    editWrap = btnEdit.closest(".edit-wrap") as HTMLElement;
    editToast = document.getElementById("edit-toast")!;
    editToastText = document.getElementById("edit-toast-text")!;
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
    initEditMenu({ svg: false, md: false }, null);
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

test("a single editable file acts directly on click, no dropdown, and flashes a copy confirmation", () => {
    state.slides = [
        slideWith({
            label: "Layout",
            name: "slide.svg",
            path: "/deck/slide.svg",
        }),
    ];
    initEditMenu({ svg: false, md: false }, 7778);
    btnEdit.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.svg",
    );
    expect(editMenu.classList.contains("open")).toBe(false);
    expect(editToast.classList.contains("visible")).toBe(true);
    expect(editToastText.textContent).toBe("Copied slide.svg");
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
    initEditMenu({ svg: false, md: false }, 7778);
    btnEdit.click();
    expect(editToast.classList.contains("visible")).toBe(true);
    vi.advanceTimersByTime(1600);
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
    initEditMenu({ svg: false, md: false }, 7778);
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
    initEditMenu({ svg: false, md: false }, 7778);
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
    initEditMenu({ svg: false, md: false }, 7778);
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
    initEditMenu({ svg: true, md: false }, 7778);
    btnEdit.click();
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
    initEditMenu({ svg: true, md: false }, 7778);
    btnEdit.click();
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
    initEditMenu({ svg: false, md: false }, 7778);
    btnEdit.click();
    expect(send).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.svg",
    );
});
