// The clock behind progress-driven transitions. It walks a normalized `value`
// (0 = old slide shown, 1 = new shown) toward a target across animation frames,
// reporting the value each frame. Because the value lives on the instance and a
// reversal is just another `animateTo` toward the opposite end, direction changes
// pick up smoothly from wherever the value currently is.
//
// The driver is deliberately easing-agnostic: it advances a linear value, and the
// caller eases that value before painting. It also owns no DOM.
export class ProgressDriver {
    value = 0;
    // The end the most recent animateTo is travelling toward. Callers read this to
    // decide which way a reversal should go.
    heading = 1;

    animateTo(
        target: number,
        durationSeconds: number,
        signal: AbortSignal,
        onFrame: (value: number) => void,
    ): Promise<void> {
        this.heading = target;
        const ratePerMillisecond = 1 / (durationSeconds * 1000);
        return new Promise((resolve) => {
            let lastTimestamp: number | null = null;
            const step = (timestamp: number) => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                if (lastTimestamp === null) lastTimestamp = timestamp;
                const direction = target >= this.value ? 1 : -1;
                this.value +=
                    direction *
                    ratePerMillisecond *
                    (timestamp - lastTimestamp);
                lastTimestamp = timestamp;

                const reachedTarget =
                    (direction === 1 && this.value >= target) ||
                    (direction === -1 && this.value <= target);
                if (reachedTarget) {
                    this.value = target;
                    onFrame(this.value);
                    resolve();
                    return;
                }
                onFrame(this.value);
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
    }
}
