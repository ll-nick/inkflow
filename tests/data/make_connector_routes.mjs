// Writes connector_routes.json: cases for the connector and move/resize maths
// with the answers the editor's own TypeScript gives (src/ts/editor/
// connectors.ts and geom.ts). Both test suites read the file: vitest checks
// the TypeScript still gives these answers, pytest that the Python port
// (inkflow/editor/routing.py, geometry.py) gives the same, so the two cannot
// drift apart. Run after changing either side's maths:
//
//     node tests/data/make_connector_routes.mjs
//
// (from the repository root, after `pnpm install`).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "inkflow-routes-"));

async function load(name) {
    const out = join(tmp, `${name}.mjs`);
    await build({
        entryPoints: [join(root, "src", "ts", "editor", `${name}.ts`)],
        bundle: true,
        format: "esm",
        outfile: out,
        logLevel: "error",
    });
    return import(pathToFileURL(out).href);
}

const C = await load("connectors");
const G = await load("geom");
rmSync(tmp, { recursive: true });

// A small deterministic generator, so the file only changes with the maths.
let seed = 20261010;
function rand() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
// Coordinates as authors and the editor write them: whole numbers, halves,
// thirds, and some long fractions.
const coord = () =>
    pick([
        () => Math.round(rand() * 1900),
        () => Math.round(rand() * 3800) / 2,
        () => Math.round(rand() * 1900) / 3,
        () => rand() * 1900,
        () => Math.round(rand() * 190000) / 100 + 0.005,
    ])();

function corners(kind) {
    const x = coord();
    const y = coord();
    const w = 40 + Math.round(rand() * 400);
    const h = 40 + Math.round(rand() * 300);
    const box = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
    ];
    if (kind === "box") return box;
    // Turned about its centre (a rotate() transform), or sheared.
    const cx = x + w / 2;
    const cy = y + h / 2;
    const a = ((rand() * 360 - 180) * Math.PI) / 180;
    const k = kind === "skew" ? rand() - 0.5 : 0;
    return box.map((p) => {
        const dx = p.x - cx + k * (p.y - cy);
        const dy = p.y - cy;
        return {
            x: cx + dx * Math.cos(a) - dy * Math.sin(a),
            y: cy + dx * Math.sin(a) + dy * Math.cos(a),
        };
    });
}

const plain = (s) => ({ name: s.name, x: s.x, y: s.y, dx: s.dx, dy: s.dy });

const sites = [];
for (let i = 0; i < 24; i++) {
    const c = corners(pick(["box", "box", "turned", "skew"]));
    const per = pick([1, 1, 2, 3, 0, 12, 2.5]);
    const round = rand() < 0.3;
    sites.push({
        corners: c,
        per,
        round,
        expected: C.sitesFromCorners(c, per, round).map(plain),
    });
}

const named = [];
const NAMES = [
    "top",
    "right",
    "bottom",
    "left",
    "top@0.25",
    "right@0.1",
    "bottom@0.333",
    "left@1",
    "top@0",
    "middle",
    "top@1.5",
    "top@",
    "left@0.5@2",
    "right@ 0.75 ",
    "bottom@1e-1",
];
for (const name of NAMES) {
    for (const round of [false, true]) {
        const c = corners(pick(["box", "turned"]));
        const s = C.siteByName(c, name, round);
        named.push({ corners: c, name, round, expected: s ? plain(s) : null });
    }
}

function end(free) {
    const p = { x: coord(), y: coord() };
    if (free) return p;
    const [dx, dy] = pick([
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [0.6, 0.8],
        [-0.8, 0.6],
    ]);
    return { ...p, dx, dy };
}

const routes = [];
const routeCase = (style, a, b, bend) => {
    const r = C.route(style, a, b, bend);
    routes.push({
        style,
        a,
        b,
        bend,
        expected: {
            d: C.pathData(r),
            bend: r.bend ? { axis: r.bend.axis, at: r.bend.at } : null,
        },
    });
};
// The editor's own unit-test cases first, then generated ones.
const right = { x: 100, y: 25, dx: 1, dy: 0 };
const left = { x: 300, y: 125, dx: -1, dy: 0 };
routeCase("straight", right, left, null);
routeCase("elbow", right, left, null);
routeCase("elbow", right, { x: 300, y: 125, dx: 0, dy: -1 }, null);
routeCase("elbow", right, { x: 300, y: 25, dx: -1, dy: 0 }, null);
routeCase("curved", right, left, null);
routeCase("elbow", { x: 0, y: 0 }, { x: 100, y: 40 }, null);
routeCase("elbow", right, left, { axis: "x", at: 150 });
routeCase("elbow", right, left, { axis: "y", at: 150 });
routeCase("elbow", right, { x: 300, y: 125, dx: 1, dy: 0 }, null);
routeCase(
    "elbow",
    right,
    { x: 300, y: 125, dx: 0, dy: -1 },
    {
        axis: "x",
        at: 200,
    },
);
routeCase("straight", { x: 0.125, y: -0.125 }, { x: 1.005, y: 2.675 }, null);
routeCase("elbow", { x: 10, y: 10, dx: 0, dy: 1 }, { x: 10, y: 10 }, null);
for (let i = 0; i < 160; i++) {
    const style = pick(["straight", "elbow", "elbow", "elbow", "curved"]);
    const bend =
        style === "elbow" && rand() < 0.35
            ? { axis: pick(["x", "y"]), at: coord() }
            : null;
    routeCase(style, end(rand() < 0.2), end(rand() < 0.2), bend);
}

const bends = ["x:640", "y:-12.5", "x:1e3", "X:5", "z:1", "x:", "", "y:.5"].map(
    (text) => {
        const b = C.parseBend(text);
        return {
            text,
            parsed: b,
            formatted: b ? C.formatBend(b) : null,
        };
    },
);

const endpoints = [
    "M1.5,2 C3,4 5,6 7,-8.25",
    "M1,2",
    "M 10 20 L 30 40 L 50 60",
    "M-5-5L1e2,3",
    "M0,0 L.5.5",
].map((d) => ({ d, expected: C.endpointsOf(d) }));

const connections = [
    "box-1:right",
    "box:middle",
    "box:right@0.25",
    ":top",
    "a:b:left",
    "zone-text-2:bottom@0.75",
    "",
].map((value) => ({ value, expected: C.parseConnection(value || null) }));

// ── geom.ts: what a move or resize writes ──

const transforms = [
    null,
    "translate(10,20)",
    "translate(5)",
    "rotate(30 100 100)",
    "translate(3,4) rotate(15)",
    "matrix(1,0,0,1,7,8)",
    "matrix(0.5,0.2,-0.2,0.5,10,10)",
    "scale(2) translate(4,5)",
    "skewX(10)",
];
const parents = [
    G.IDENTITY,
    { a: 1, b: 0, c: 0, d: 1, e: 40, f: -20 },
    { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 },
    { a: 0.866, b: 0.5, c: -0.5, d: 0.866, e: 10, f: 5 },
];
const shapes = [
    { tag: "rect", attrs: { x: "10", y: "20", width: "100", height: "50" } },
    { tag: "ellipse", attrs: { cx: "300", cy: "200", rx: "80", ry: "40" } },
    { tag: "circle", attrs: { cx: "300", cy: "200", r: "40" } },
    { tag: "line", attrs: { x1: "0", y1: "0", x2: "100.5", y2: "33.3" } },
    { tag: "text", attrs: { x: "10 20 30", y: "50" } },
    { tag: "path", attrs: { d: "M0,0 L10,10" } },
    {
        tag: "image",
        attrs: { x: "1.5", y: "2.25", width: "640", height: "480" },
    },
    {
        tag: "svg",
        attrs: {
            x: "0",
            y: "0",
            width: "200",
            height: "100",
            viewBox: "0 0 2 1",
        },
    },
];
const moves = [];
const resizes = [];
for (let i = 0; i < 90; i++) {
    const shape = shapes[i % shapes.length];
    const transform = pick(transforms);
    const parent = pick(parents);
    const attrs = { ...shape.attrs, transform };
    const g = {
        tag: shape.tag,
        sourceTag: shape.tag,
        attrs,
        own: G.parseTransform(transform),
        parentToSlide: parent,
        localBox: { x: 0, y: 0, width: 0, height: 0 },
    };
    const geom = { tag: shape.tag, attrs, parentToSlide: parent };
    const dx = pick([10, -7.5, 0.3333, 120]);
    const dy = pick([0, 4.25, -60, 1 / 3]);
    const kids =
        shape.tag === "text"
            ? [{ attrs: { x: "10", y: "50" } }, { attrs: { x: null, y: "80" } }]
            : [];
    moves.push({
        geom,
        dx,
        dy,
        kids: kids.map((k) => k.attrs),
        expected: G.planMove(g, dx, dy, kids),
    });
    const from = { x: 10, y: 20, width: 100, height: 50 };
    const to = pick([
        { x: 10, y: 20, width: 200, height: 50 },
        { x: 0, y: 0, width: 50, height: 25 },
        { x: 15.5, y: 21.25, width: 99, height: 77.7 },
    ]);
    resizes.push({ geom, from, to, expected: G.planResize(g, from, to) });
}
const prepends = [
    [null, { x: 5, y: 6 }],
    ["translate(1,2)", { x: 5, y: 6 }],
    ["translate(1 2) rotate(45)", { x: -1, y: -2 }],
    ["rotate(45)", { x: 3, y: 0 }],
    ["matrix(1,0,0,1,7,8)", { x: 1, y: 1 }],
    ["matrix(1.0, 0, 0, 1.0, 7, 8)", { x: 0.0005, y: 1 }],
    ["translate(5,5)", { x: -5, y: -5 }],
    ["translate(1e1,2)", { x: 0, y: 0 }],
].map(([transform, d]) => ({
    transform,
    d,
    expected: G.prependTranslate(transform, d),
}));
const formats = [
    G.IDENTITY,
    { a: 1, b: 0, c: 0, d: 1, e: 1.23456, f: -0.0001 },
    {
        a: 0.8660254037844387,
        b: 0.5,
        c: -0.5,
        d: 0.8660254037844387,
        e: 1,
        f: 2,
    },
    { a: 2, b: 0, c: 0, d: 3, e: 4.5, f: 5.25 },
].map((m) => ({ matrix: m, expected: G.formatTransform(m) }));

const fixture = {
    comment:
        "Answers from src/ts/editor/connectors.ts and geom.ts; regenerate with node tests/data/make_connector_routes.mjs. Read by connectors.test.ts and tests/test_routing.py.",
    sites,
    named,
    routes,
    bends,
    endpoints,
    connections,
    moves,
    resizes,
    prepends,
    formats,
};
// One case per line: small, and a changed answer is a one-line diff.
const lines = Object.entries(fixture).map(([key, value]) =>
    Array.isArray(value)
        ? `${JSON.stringify(key)}: [\n${value.map((v) => `  ${JSON.stringify(v)}`).join(",\n")}\n ]`
        : `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
);
writeFileSync(
    join(here, "connector_routes.json"),
    `{\n ${lines.join(",\n ")}\n}\n`,
);
console.log(
    `wrote ${routes.length} routes, ${sites.length + named.length} site cases, ${moves.length + resizes.length} plans`,
);
