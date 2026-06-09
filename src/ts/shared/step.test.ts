// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { applyStep, applyStepInstant, maxStep } from "./step";

function buildSvg(html: string): Element {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container;
}

describe("applyStep", () => {
    test("activates elements whose data-step was authored directly in the SVG", () => {
        // No deck.py involvement: these data-step attributes are hand-authored.
        // applyStep reads the DOM, so they must animate identically.
        const root = buildSvg(
            `<rect id="a" class="anim-fade-in" data-step="1"></rect>
             <rect id="b" class="anim-fade-in" data-step="2"></rect>`,
        );

        applyStep(root, 1);
        expect(root.querySelector("#a")!.classList.contains("active")).toBe(
            true,
        );
        expect(root.querySelector("#b")!.classList.contains("active")).toBe(
            false,
        );

        applyStep(root, 2);
        expect(root.querySelector("#b")!.classList.contains("active")).toBe(
            true,
        );
    });

    test("backward navigation removes active", () => {
        const root = buildSvg(`<rect data-step="1"></rect>`);
        const el = root.querySelector("[data-step]")!;

        applyStep(root, 1);
        expect(el.classList.contains("active")).toBe(true);

        applyStep(root, 0);
        expect(el.classList.contains("active")).toBe(false);
    });
});

describe("applyStepInstant", () => {
    test("activates the same elements as applyStep", () => {
        const root = buildSvg(
            `<rect class="anim-fade-in" data-step="1"></rect>
             <rect class="anim-fade-in" data-step="2"></rect>`,
        );
        document.body.appendChild(root);

        applyStepInstant(root, 1);
        const els = root.querySelectorAll("[data-step]");
        expect(els[0].classList.contains("active")).toBe(true);
        expect(els[1].classList.contains("active")).toBe(false);

        root.remove();
    });
});

describe("maxStep", () => {
    test("returns the highest data-step in the tree", () => {
        const root = buildSvg(
            `<rect data-step="1"></rect><rect data-step="4"></rect><rect data-step="2"></rect>`,
        );
        expect(maxStep(root)).toBe(4);
    });

    test("returns 0 when there are no steps", () => {
        expect(maxStep(buildSvg("<rect></rect>"))).toBe(0);
    });
});
