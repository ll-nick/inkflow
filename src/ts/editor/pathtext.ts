// Paths typed in the folder picker, as text: pure, so they are unit-tested.

export function sepOf(path: string): string {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function withSep(dir: string): string {
    const sep = sepOf(dir);
    return dir.endsWith(sep) ? dir : dir + sep;
}

export function joinPath(dir: string, name: string): string {
    return withSep(dir) + name;
}

export function baseName(path: string): string {
    return (
        path
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || path
    );
}

export function samePath(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/(.)[\\/]+$/, "$1");
    return norm(a) === norm(b);
}

/** The longest start every name shares (case as in the first name). */
export function commonPrefix(names: string[]): string {
    if (!names.length) return "";
    let prefix = names[0];
    for (const name of names.slice(1)) {
        let i = 0;
        while (
            i < prefix.length &&
            i < name.length &&
            prefix[i].toLowerCase() === name[i].toLowerCase()
        ) {
            i++;
        }
        prefix = prefix.slice(0, i);
    }
    return prefix;
}

/** The names that start with ``typed``, ignoring case. */
export function startingWith(names: string[], typed: string): string[] {
    const t = typed.toLowerCase();
    return names.filter((n) => n.toLowerCase().startsWith(t));
}

/** A typed path as the folder it names and the start of a name in it. */
export function splitTyped(value: string): { dir: string; prefix: string } {
    const i = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    if (i < 0) return { dir: "", prefix: value };
    return { dir: value.slice(0, i + 1), prefix: value.slice(i + 1) };
}

/** An asset reference as written in the deck: the server stamps served
 * slides with the file's version (``?v=…``) so a changed file reloads. */
export function assetRef(href: string): string {
    return href.replace(/\?v=[0-9a-f]+$/, "");
}

/** Whether a reference names a PDF (a figure; its page after ``#``). */
export function isPdfRef(ref: string): boolean {
    return /\.pdf(?:[#?]|$)/i.test(ref) && !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/** The page a PDF reference shows (``plot.pdf#page=2``): 1 without one. */
export function pdfPage(ref: string): number {
    const m = /#(?:.*&)?page=(\d+)/i.exec(ref);
    return m ? Math.max(1, Number(m[1])) : 1;
}

/** The reference to ``page`` of a PDF (the first page needs no fragment). */
export function withPage(ref: string, page: number): string {
    const file = ref.replace(/#.*$/, "");
    return page > 1 ? `${file}#page=${page}` : file;
}

/** A project file's path as its folder, its name without the extension, and
 * the extension (``.drawio.svg`` is one: a diagram stays a diagram). */
export function splitFileName(rel: string): {
    folder: string;
    stem: string;
    ext: string;
} {
    const cut = rel.lastIndexOf("/");
    const folder = cut < 0 ? "" : rel.slice(0, cut);
    const name = rel.slice(cut + 1);
    const drawio = /\.drawio\.svg$/i.exec(name);
    const dot = name.lastIndexOf(".");
    const ext = drawio ? drawio[0] : dot > 0 ? name.slice(dot) : "";
    return { folder, stem: name.slice(0, name.length - ext.length), ext };
}

/** ``folder/stem.ext`` from the rename dialog's fields (slashes trimmed). */
export function joinFileName(
    folder: string,
    stem: string,
    ext: string,
): string {
    const dir = folder
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
    const name = `${stem.trim()}${ext}`;
    return dir ? `${dir}/${name}` : name;
}

/** A path the model gives (absolute, or relative to the project) as one
 * relative to the project, or null when it is outside it. */
export function projectRel(path: string, projectDir: string): string | null {
    if (!path) return null;
    if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) {
        return path.split("/").includes("..") ? null : path;
    }
    const root = projectDir.replace(/[\\/]+$/, "");
    if (!path.startsWith(`${root}/`)) return null;
    return path.slice(root.length + 1);
}
