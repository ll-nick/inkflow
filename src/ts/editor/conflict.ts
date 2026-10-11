// Typing that could not be saved because someone else changed the same text
// meanwhile: their version is on the slide, this person's is kept here to copy
// (or to put back over theirs, on purpose). Typing is never silently lost.

import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";

export function showConflict(
    why: string,
    mine: string,
    useMine: (() => Promise<boolean>) | null,
): void {
    const area = h("textarea", {
        readonly: true,
        "aria-label": "Your version",
    });
    area.value = mine;
    const copy = () => {
        area.select();
        const done = () => toast("Your version copied", "ok");
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(mine).then(done, () => {
                document.execCommand("copy");
                done();
            });
        } else {
            document.execCommand("copy");
            done();
        }
    };
    const body = h(
        "div",
        { class: "conflict-dialog" },
        h(
            "p",
            {},
            `${why.replace(/[.;:]?\s*$/, ".")} Yours is below: copy what you need, or put it back in place of theirs.`,
        ),
        area,
        h(
            "div",
            { class: "dialog-actions" },
            h(
                "button",
                { type: "button", class: "pbtn", onclick: copy },
                "Copy",
            ),
            useMine
                ? h(
                      "button",
                      {
                          type: "button",
                          class: "pbtn",
                          onclick: async () => {
                              if (await useMine()) closeDialog();
                          },
                      },
                      "Use mine instead",
                  )
                : null,
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn primary",
                    onclick: () => closeDialog(),
                },
                "Keep theirs",
            ),
        ),
    );
    openDialog("Changed by someone else", body, { wide: true });
}
