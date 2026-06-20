// Custom transition: 3D card flip.
// Registered as "flip" (derived from the Python class name Flip → "flip").
// params.axis ("horizontal" or "vertical") comes from the Flip dataclass field.
//
// This is the canonical custom-transition example. A progress-driven transition is
// just a render function: given the two layers and a progress value (0 = old slide
// shown, 1 = new shown), paint the frame. The framework owns the requestAnimationFrame
// loop, the easing, and mid-flight reversal — reversing direction is automatic, the
// render never has to think about it.
window.inkflow.registerProgressTransition(
    "flip",
    (context, progress, params) => {
        const axis = params.axis === "vertical" ? "X" : "Y";
        const sign = params.reverse ? -1 : 1;

        // The old card turns edge-on over the first half (0 → -90°), the new card
        // turns face-on over the second (+90° → 0°). Each is invisible while parked
        // at ±90°, so the pair reads as a single card flipping over.
        let oldAngle;
        let newAngle;
        if (progress <= 0.5) {
            oldAngle = -sign * 90 * (progress / 0.5);
            newAngle = sign * 90;
        } else {
            oldAngle = -sign * 90;
            newAngle = sign * 90 * (1 - (progress - 0.5) / 0.5);
        }

        // Perspective on the stage makes the rotation read as 3D. The distance
        // comes from the Flip dataclass (smaller = more dramatic foreshortening).
        context.stage.style.perspective = `${params.perspective ?? 1200}px`;
        context.oldLayer.style.transform = `rotate${axis}(${oldAngle}deg)`;
        context.newLayer.style.transform = `rotate${axis}(${newAngle}deg)`;
    },
    { easing: "ease-in-out" },
);
