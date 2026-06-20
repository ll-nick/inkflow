// Custom transition for the feature-test deck: 3D card flip (Flip → "flip").
// Same handler as demo/scripts.js — a progress-driven render: given the two layers
// and a progress value (0 = old slide shown, 1 = new shown), paint the frame. The
// framework owns the rAF loop, easing, and mid-flight reversal.
window.inkflow.registerProgressTransition(
    "flip",
    (context, progress, params) => {
        const axis = params.axis === "vertical" ? "X" : "Y";
        const sign = params.reverse ? -1 : 1;

        let oldAngle;
        let newAngle;
        if (progress <= 0.5) {
            oldAngle = -sign * 90 * (progress / 0.5);
            newAngle = sign * 90;
        } else {
            oldAngle = -sign * 90;
            newAngle = sign * 90 * (1 - (progress - 0.5) / 0.5);
        }

        context.stage.style.perspective = `${params.perspective ?? 1200}px`;
        context.oldLayer.style.transform = `rotate${axis}(${oldAngle}deg)`;
        context.newLayer.style.transform = `rotate${axis}(${newAngle}deg)`;
    },
    { easing: "ease-in-out" },
);
