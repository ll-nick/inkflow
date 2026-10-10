// The editor model sent by the server (inkflow/editor/model.py build_model).
// Field names mirror the Python side exactly; see that module for meanings.

export interface SourceInfo {
    path: string;
    rel: string;
    hash: string;
    role: "slide" | "layout" | "overlay" | "diagram" | "ink";
    writable: boolean;
    usedBy: number[];
}

export interface EmptyZone {
    zone: string;
    locator: string;
    x: number;
    y: number;
    width: number;
    height: number;
    transform: string | null;
}

export interface TextSource {
    kind: "file" | "inline" | "none";
    path: string | null;
    rel: string | null;
    text: string;
}

export interface ZoneValue {
    kind: "text" | "textbox" | "image" | "video" | "chart" | "other";
    text?: string;
    src?: string;
    fit?: string;
    // An image's or video's settings, by field name (see mediaTypes); a
    // chart's (its y is a list of column names).
    fields?: Record<string, FieldValue | string[]>;
    // A chart: its data file (absolute), whether the data is written inline
    // in deck.py, its columns (and which hold numbers), or why it cannot be read.
    path?: string;
    inline?: boolean;
    columns?: string[];
    numeric?: string[];
    error?: string;
}

export type FieldValue = string | number | boolean | null;

export interface CueInfo {
    type: string;
    slug: string;
    kind: string;
    custom: boolean;
    element: string;
    fields: Record<string, FieldValue>;
}

export interface TransitionInfo {
    type: string;
    slug: string;
    custom: boolean;
    fields: Record<string, FieldValue>;
}

export interface FieldSchema {
    name: string;
    kind:
        | "trigger"
        | "easing"
        | "enum"
        | "bool"
        | "int"
        | "float"
        | "str"
        | "other";
    choices: string[];
    default: FieldValue;
    // The field also accepts None (an emptied box sends null).
    optional?: boolean;
}

export interface TypeInfo {
    type: string;
    slug: string;
    kind?: string;
    custom: boolean;
    fields: FieldSchema[];
}

export interface SlideModel {
    deckIndex: number;
    visible: boolean;
    visibleIndex: number | null;
    src: string;
    title: string | null;
    explicitId: string | null;
    id?: string;
    srcPath: string | null;
    srcRel: string | null;
    srcShared: boolean;
    md: TextSource | null;
    notes: TextSource;
    zones: Record<string, ZoneValue>;
    transition: TransitionInfo | null;
    animations: CueInfo[];
    animationsEditable: boolean;
    fontSize: number | null;
    sources?: SourceInfo[];
    // The slide's ink file (inkflow/ink.py), which need not exist yet.
    ink?: { path: string; rel: string; exists: boolean };
    emptyZones?: EmptyZone[];
    zoneOrigins?: Record<string, string>;
    zoneText?: Record<string, string>;
}

export interface LayoutInfo {
    name: string;
    source: string;
    path: string;
}

// A Section(...) of deck.py: its slides are deck indices start..start+count-1.
export interface SectionInfo {
    name: string;
    start: number;
    count: number;
}

export interface EditorModel {
    deckPath: string;
    projectDir: string;
    deckEditable: boolean;
    slides: SlideModel[];
    sections: SectionInfo[];
    animationTypes: TypeInfo[];
    transitionTypes: TypeInfo[];
    mediaTypes: { image: FieldSchema[]; video: FieldSchema[] };
    defaultTransition: TransitionInfo;
    layouts: LayoutInfo[];
    colorTokens: string[];
    deckSize?: DeckSize;
}

// The deck's size (`Deck(size=)`, inkflow/sizes.py): the canvas a new slide
// gets and the thumbnails' shape.
export interface DeckSize {
    name: string | null; // null: the deck sets none (16:9 for new slides)
    label: string;
    canvas: [number, number];
    page: [number, number]; // points
    print: boolean;
    fontSize: number; // the deck's body text size, in canvas units
}

// A request to the server's EditorSession (inkflow/editor/session.py).
export type EditRequest = Record<string, unknown> & { action: string };

export interface EditResult {
    ok: boolean;
    error?: string;
    label?: string;
    hashes?: Record<string, string>;
    ids?: Record<string, string>;
    structural?: boolean;
    select?: number;
    canUndo?: boolean;
    canRedo?: boolean;
    undoLabel?: string | null;
    redoLabel?: string | null;
    path?: string;
    rel?: string;
    theme?: unknown;
    apps?: { id: string; label: string }[];
    // Results of the git and deck actions (git.ts, decks.ts).
    [key: string]: unknown;
}

// One selected object on the canvas.
export interface Selected {
    el: SVGGraphicsElement;
    key: number; // index into the slide's sources
    loc: string; // "<key>:<path>"
}

// An SVG op understood by inkflow/editor/svgops.py apply_ops.
export type SvgOp = Record<string, unknown> & { kind: string };
