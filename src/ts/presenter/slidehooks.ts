// What happens around a slide change besides the slide itself. A module that
// keeps something of its own in the mounted slide (ink: presenter/ink.ts)
// registers here, so transitions.ts, which calls these, needs none of those
// modules, nor its unit tests their part of the page.

const mounted: (() => void)[] = [];
const leaving: (() => void)[] = [];

// Run after a slide's markup is put on the stage, whichever way it got there.
export function onSlideMounted(fn: () => void): void {
    mounted.push(fn);
}

// Run before the current slide is captured and replaced.
export function onSlideLeaving(fn: () => void): void {
    leaving.push(fn);
}

export function slideMounted(): void {
    for (const fn of mounted) fn();
}

export function slideLeaving(): void {
    for (const fn of leaving) fn();
}
