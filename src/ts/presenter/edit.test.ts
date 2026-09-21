// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// edit.ts captures DOM element references at module evaluation time via
// getElementById, and initEditMenu() is not idempotent (each call adds another
// click listener to the same button) — production code only ever calls it once
// per page load. So each test gets a fresh DOM fragment *and* a fresh module
// instance via vi.resetModules() + dynamic import, mirroring transitions.test.ts,
// rather than reusing one initEditMenu() call across tests.
//
// edit.ts imports ./ui (for showNotify), which captures its own DOM references
// at module-evaluation time too, so the fixture needs ui.ts's required elements
// as well as edit.ts's own — mirrors picker.test.ts / overview.test.ts.

let initEditMenu: typeof import("./edit").initEditMenu;
let renderEditButton: typeof import("./edit").renderEditButton;
let editMenuSetActive: typeof import("./edit").editMenuSetActive;
let editMenuCommit: typeof import("./edit").editMenuCommit;
let menuOpened: typeof import("./menus").menuOpened;
let state: typeof import("./state").state;
let btnEdit: HTMLButtonElement;
let editMenu: HTMLElement;
let editWrap: HTMLElement;
let notifyText: HTMLElement;

beforeEach(async () => {
    document.body.innerHTML = `
        <span class="edit-wrap">
            <button id="btn-edit"></button>
            <div id="edit-menu"></div>
        </span>
        <div id="curtain"></div>
        <div id="help"></div>
        <div id="error-overlay"></div>
        <div id="error-msg"></div>
        <div id="log-banner"><ul id="log-list"></ul><button id="log-close"></button></div>
        <button id="log-indicator"></button>
        <div id="statusbar"></div>
        <div id="mobile-hud"></div>
        <div id="notify">
            <div id="notify-body">
                <span id="notify-text"></span>
                <button id="notify-close"></button>
            </div>
            <div id="notify-progress"></div>
        </div>
        <button id="notify-history-btn"></button>
        <div id="notify-history"><button id="notify-history-close"></button></div>
    `;
    vi.resetModules();
    ({ initEditMenu, renderEditButton, editMenuSetActive, editMenuCommit } =
        await import("./edit"));
    ({ menuOpened } = await import("./menus"));
    ({ state } = await import("./state"));
    btnEdit = document.getElementById("btn-edit") as HTMLButtonElement;
    editMenu = document.getElementById("edit-menu")!;
    editWrap = btnEdit.closest(".edit-wrap") as HTMLElement;
    notifyText = document.getElementById("notify-text")!;
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

test("clicking the lone row copies the full path and shows a confirmation", () => {
    // Timer/dismiss/style mechanics of the notification itself are covered by
    // notify.test.ts — this only checks edit.ts hands showNotify the right text.
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
    // The full path, not just the filename — a bare "slide.svg" would read as
    // though only the name had been copied.
    expect(notifyText.textContent).toBe("Copied /deck/slide.svg");
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
    expect(notifyText.textContent).toBe("Opened slide.svg");
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

// ── Keyboard navigation (editMenuSetActive / editMenuCommit) ──────────────────
// The arrow/j/k/Enter wiring itself lives in keyboard.ts's global cascade (not
// tested here — no keyboard.test.ts exists in this codebase, matching how
// overview.ts's identically-shaped overviewSetActive/overviewCommit also have
// no dedicated cascade test); this covers the exported units keyboard.ts calls.

test("opening the menu highlights the first row", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "a.svg", path: "/deck/a.svg" },
            { label: "Content", name: "b.md", path: "/deck/b.md" },
        ),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    const rows = editMenu.querySelectorAll(".edit-row");
    expect(rows[0].classList.contains("active")).toBe(true);
    expect(rows[1].classList.contains("active")).toBe(false);
    expect(state._editActive).toBe(0);
});

test("editMenuSetActive moves the highlight and clamps at both ends", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "a.svg", path: "/deck/a.svg" },
            { label: "Content", name: "b.md", path: "/deck/b.md" },
        ),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    const rows = editMenu.querySelectorAll(".edit-row");
    editMenuSetActive(1);
    expect(rows[1].classList.contains("active")).toBe(true);
    expect(rows[0].classList.contains("active")).toBe(false);
    editMenuSetActive(5); // past the end
    expect(state._editActive).toBe(1);
    editMenuSetActive(-3); // before the start
    expect(state._editActive).toBe(0);
});

test("editMenuCommit acts on the highlighted row, not necessarily the first", () => {
    state.slides = [
        slideWith(
            { label: "Layout", name: "a.svg", path: "/deck/a.svg" },
            { label: "Content", name: "b.md", path: "/deck/b.md" },
        ),
    ];
    initEditMenu({ svg: false, default: false }, 7778);
    btnEdit.click();
    editMenuSetActive(1);
    editMenuCommit();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/deck/b.md");
    expect(editMenu.classList.contains("open")).toBe(false);
});
