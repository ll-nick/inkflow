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
let state: typeof import("./state").state;
let btnEdit: HTMLButtonElement;
let editMenu: HTMLElement;
let editWrap: HTMLElement;

beforeEach(async () => {
    document.body.innerHTML = `
        <span class="edit-wrap">
            <button id="btn-edit"></button>
            <div id="edit-menu"></div>
        </span>
    `;
    vi.resetModules();
    ({ initEditMenu, renderEditButton } = await import("./edit"));
    ({ state } = await import("./state"));
    btnEdit = document.getElementById("btn-edit") as HTMLButtonElement;
    editMenu = document.getElementById("edit-menu")!;
    editWrap = btnEdit.closest(".edit-wrap") as HTMLElement;
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

function slideWith(...editableFiles: { label: string; path: string }[]) {
    return { id: "s", svg: "", title: "", notes: "", editableFiles };
}

test("hides the wrap entirely when there is no WS port (static export)", () => {
    initEditMenu({ svg: false, md: false }, null);
    expect(editWrap.style.display).toBe("none");
});

test("renderEditButton populates one row per editable file", () => {
    state.slides = [
        slideWith(
            { label: "Layout", path: "/deck/slide.svg" },
            { label: "Content", path: "/deck/slide.md" },
        ),
    ];
    renderEditButton();
    const rows = editMenu.querySelectorAll(".edit-row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toBe("Layout");
    expect(rows[1].textContent).toBe("Content");
});

test("a single editable file acts directly on click, no dropdown", () => {
    state.slides = [slideWith({ label: "Layout", path: "/deck/slide.svg" })];
    initEditMenu({ svg: false, md: false }, 7778);
    btnEdit.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.svg",
    );
    expect(editMenu.classList.contains("open")).toBe(false);
});

test("multiple editable files open a dropdown instead of acting directly", () => {
    state.slides = [
        slideWith(
            { label: "Layout", path: "/deck/slide.svg" },
            { label: "Content", path: "/deck/slide.md" },
        ),
    ];
    initEditMenu({ svg: false, md: false }, 7778);
    btnEdit.click();
    expect(editMenu.classList.contains("open")).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

test("clicking a dropdown row acts on that file and closes the menu", () => {
    state.slides = [
        slideWith(
            { label: "Layout", path: "/deck/slide.svg" },
            { label: "Content", path: "/deck/slide.md" },
        ),
    ];
    initEditMenu({ svg: false, md: false }, 7778);
    btnEdit.click();
    const contentRow = Array.from(
        editMenu.querySelectorAll<HTMLButtonElement>(".edit-row"),
    ).find((r) => r.textContent === "Content")!;
    contentRow.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.md",
    );
    expect(editMenu.classList.contains("open")).toBe(false);
});

test("a configured command with a live WS connection sends an edit message instead of copying", () => {
    state.slides = [slideWith({ label: "Layout", path: "/deck/slide.svg" })];
    const send = vi.fn();
    state.ws = { send, readyState: WebSocket.OPEN } as unknown as WebSocket;
    initEditMenu({ svg: true, md: false }, 7778);
    btnEdit.click();
    expect(send).toHaveBeenCalledWith(
        JSON.stringify({ type: "edit", path: "/deck/slide.svg" }),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

test("a configured command falls back to clipboard when the WS is not open", () => {
    state.slides = [slideWith({ label: "Layout", path: "/deck/slide.svg" })];
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
    state.slides = [slideWith({ label: "Layout", path: "/deck/slide.svg" })];
    const send = vi.fn();
    state.ws = { send, readyState: WebSocket.OPEN } as unknown as WebSocket;
    initEditMenu({ svg: false, md: false }, 7778);
    btnEdit.click();
    expect(send).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/deck/slide.svg",
    );
});
