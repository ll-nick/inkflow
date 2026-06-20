// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProgressDriver } from "./progress-driver";

describe("ProgressDriver", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test("animateTo(1) reaches the target, resolves, and advances monotonically", async () => {
        const driver = new ProgressDriver();
        const controller = new AbortController();
        const frames: number[] = [];

        const finished = driver.animateTo(1, 0.1, controller.signal, (value) =>
            frames.push(value),
        );
        await vi.runAllTimersAsync();
        await finished;

        expect(driver.value).toBe(1);
        expect(frames.at(-1)).toBe(1);
        for (let i = 1; i < frames.length; i++) {
            expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1]);
        }
    });

    test("retargeting to 0 mid-run reverses from the current value", async () => {
        const driver = new ProgressDriver();
        const forwardController = new AbortController();

        const forward = driver.animateTo(
            1,
            1,
            forwardController.signal,
            () => {},
        );
        await vi.advanceTimersByTimeAsync(100);
        const valueAtReversal = driver.value;
        expect(valueAtReversal).toBeGreaterThan(0);
        expect(valueAtReversal).toBeLessThan(1);

        // The host aborts the forward loop before launching the reverse.
        forwardController.abort();
        await vi.advanceTimersByTimeAsync(20);
        await forward;

        const backwardController = new AbortController();
        const backward = driver.animateTo(
            0,
            1,
            backwardController.signal,
            () => {},
        );
        await vi.runAllTimersAsync();
        await backward;

        expect(driver.value).toBe(0);
        expect(driver.heading).toBe(0);
    });

    test("abort resolves promptly and emits no further frames", async () => {
        const driver = new ProgressDriver();
        const controller = new AbortController();
        let frameCount = 0;

        const finished = driver.animateTo(1, 10, controller.signal, () => {
            frameCount++;
        });
        await vi.advanceTimersByTimeAsync(50);
        const frameCountAtAbort = frameCount;

        controller.abort();
        await vi.advanceTimersByTimeAsync(200);
        await finished;

        expect(frameCount).toBe(frameCountAtAbort);
        expect(driver.value).toBeLessThan(1);
    });
});
