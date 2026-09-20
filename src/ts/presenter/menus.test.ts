import { beforeEach, expect, test, vi } from "vitest";
import { menuClosed, menuOpened } from "./menus";

// menus.ts holds one bit of module-level state (which close fn is "active"), so
// tests must reset it between runs rather than relying on module isolation.
beforeEach(() => {
    // Drain any leftover active closer from a previous test without invoking it.
    const noop = () => {};
    menuOpened(noop);
    menuClosed(noop);
});

test("opening a second menu closes the first", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    menuOpened(closeA);
    menuOpened(closeB);
    expect(closeA).toHaveBeenCalledOnce();
    expect(closeB).not.toHaveBeenCalled();
});

test("re-opening the same menu does not close itself", () => {
    const close = vi.fn();
    menuOpened(close);
    menuOpened(close);
    expect(close).not.toHaveBeenCalled();
});

test("menuClosed clears the active menu so the next open closes nothing", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    menuOpened(closeA);
    menuClosed(closeA);
    menuOpened(closeB);
    expect(closeA).not.toHaveBeenCalled();
});

test("menuClosed is a no-op when it isn't the active menu", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    menuOpened(closeA);
    menuClosed(closeB); // closeB was never the active one
    menuOpened(closeB);
    expect(closeA).toHaveBeenCalledOnce(); // still closed normally by B's open
});
