// Reads author-written `@keyframes anim-*` rules from the document's stylesheets and
// turns them into Web Animations API keyframe arrays for the step engine. Built-in
// keyframes live in the global presenter stylesheet; custom ones (from `Deck(style=...)`)
// are kept unscoped by the pipeline so they are discoverable here too.
//
// Each cue's own params are substituted for `var(--anim-<field>)` tokens (e.g.
// `var(--anim-from-x)`), so multiple cues on one element never collide over a shared
// custom property. Non-`--anim-*` vars (theme tokens like `var(--accent)`) are left for
// the browser to resolve.

export type CueVars = Record<string, string>;

// Parsed templates keyed by keyframes name. Values may still contain var(--anim-*)
// placeholders; substitution happens per cue in buildKeyframes(). null = not found.
const templates = new Map<string, Keyframe[] | null>();

function parseOffsets(keyText: string): number[] {
    return keyText
        .split(",")
        .map((part) => {
            const t = part.trim();
            if (t === "from") return 0;
            if (t === "to") return 1;
            return Number.parseFloat(t) / 100; // "50%" -> 0.5
        })
        .filter((n) => Number.isFinite(n));
}

function kebabToCamel(prop: string): string {
    return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function ruleToKeyframes(rule: CSSKeyframesRule): Keyframe[] {
    const frames: Keyframe[] = [];
    for (const raw of Array.from(rule.cssRules)) {
        const kf = raw as CSSKeyframeRule;
        const style = kf.style;
        const props: Record<string, string> = {};
        for (let i = 0; i < style.length; i++) {
            const name = style[i];
            props[kebabToCamel(name)] = style.getPropertyValue(name).trim();
        }
        for (const offset of parseOffsets(kf.keyText)) {
            frames.push({ offset, ...props });
        }
    }
    frames.sort((a, b) => (a.offset as number) - (b.offset as number));
    return frames;
}

function findKeyframes(
    name: string,
    rules: CSSRuleList,
): CSSKeyframesRule | null {
    for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule) {
            if (rule.name === name) return rule;
            continue;
        }
        // Recurse into grouping rules (@media, @supports, @scope, @layer, nesting).
        const grouping = rule as CSSGroupingRule;
        if (grouping.cssRules) {
            const found = findKeyframes(name, grouping.cssRules);
            if (found) return found;
        }
    }
    return null;
}

function templateFor(name: string): Keyframe[] | null {
    const cached = templates.get(name);
    if (cached !== undefined) return cached;
    let result: Keyframe[] | null = null;
    for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            continue; // cross-origin sheet — not ours
        }
        const rule = findKeyframes(name, rules);
        if (rule) {
            result = ruleToKeyframes(rule);
            break;
        }
    }
    templates.set(name, result);
    return result;
}

const VAR_ANIM = /var\(\s*--anim-([\w-]+)\s*(?:,[^()]*)?\)/g;

// Replace var(--anim-<key>) (with or without a fallback) by the cue's value for <key>.
// Unknown --anim-* tokens are left untouched so a keyframe's own fallback still applies.
export function substituteVars(value: string, vars: CueVars): string {
    return value.replace(VAR_ANIM, (match, key: string) =>
        key in vars ? vars[key] : match,
    );
}

// Build a concrete WAAPI keyframe array for the named animation, substituting the cue's
// params. Returns [] when the named @keyframes rule is not present.
export function buildKeyframes(name: string, vars: CueVars): Keyframe[] {
    const template = templateFor(name);
    if (!template) return [];
    if (Object.keys(vars).length === 0) return template;
    return template.map((frame) => {
        const out: Keyframe = {};
        for (const [k, v] of Object.entries(frame)) {
            out[k] = typeof v === "string" ? substituteVars(v, vars) : v;
        }
        return out;
    });
}
