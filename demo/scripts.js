// Custom transition: 3D card flip.
// Registered as "flip" (derived from the Python class name Flip → "flip").
// t.axis ("horizontal" or "vertical") comes from the Flip dataclass field.
window.inkflow.registerTransition("flip", (swap, t, then) => {
    const stage = document.getElementById("stage");
    if (!stage || t.duration <= 0) {
        swap();
        then?.();
        return;
    }

    const half = t.duration * 500;
    const cssAxis = t.axis === "vertical" ? "X" : "Y";
    // Reverse navigation flips in the opposite direction.
    const sign = t.reverse ? -1 : 1;
    const padding = getComputedStyle(stage).padding;

    const oldHTML = stage.innerHTML;
    swap();

    function makeLayer() {
        const el = document.createElement("div");
        el.style.cssText =
            "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
        el.style.padding = padding;
        return el;
    }

    function sizeChild(layer) {
        const child = layer.firstElementChild;
        if (child) {
            child.style.width = "100%";
            child.style.height = "100%";
        }
    }

    // New slide content → newLayer (behind).
    const newLayer = makeLayer();
    while (stage.firstChild) newLayer.appendChild(stage.firstChild);
    sizeChild(newLayer);
    stage.appendChild(newLayer);

    // Old slide content → oldLayer (on top, rotates away first).
    const oldLayer = makeLayer();
    oldLayer.innerHTML = oldHTML;
    sizeChild(oldLayer);
    stage.appendChild(oldLayer);

    // Perspective on the stage makes the 3D rotation visible.
    stage.style.perspective = "1200px";
    // Park the new slide edge-on so it stays invisible during phase 1.
    newLayer.style.transform = `rotate${cssAxis}(${sign * 90}deg)`;

    // Force a layout flush so the browser sees two distinct transform states.
    void stage.offsetHeight;

    const cleanup = () => {
        while (newLayer.firstChild)
            stage.insertBefore(newLayer.firstChild, newLayer);
        newLayer.remove();
        oldLayer.remove();
        stage.style.perspective = "";
        then?.();
    };

    requestAnimationFrame(() => {
        // Phase 1: old slide rotates away (ease-in accelerates into the flip).
        oldLayer.style.transition = `transform ${t.duration / 2}s ease-in`;
        oldLayer.style.transform = `rotate${cssAxis}(${-sign * 90}deg)`;

        setTimeout(() => {
            // Phase 2: new slide rotates in (ease-out decelerates to rest).
            newLayer.style.transition = `transform ${t.duration / 2}s ease-out`;
            requestAnimationFrame(() => {
                newLayer.style.transform = `rotate${cssAxis}(0deg)`;
                setTimeout(cleanup, half);
            });
        }, half);
    });
});
