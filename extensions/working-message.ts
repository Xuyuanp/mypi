/**
 * Working Message Extension
 *
 * Replaces pi's default streaming loader during each turn with:
 *   - pi's default braille spinner (colored with the theme `accent`) as a
 *     prefix, followed by a randomly composed phrase shaped like
 *     `<Verbing> the <adj> <noun>`, rendered as the animated working
 *     *indicator* with a truecolor "shimmer sweep" (a bright band glides
 *     across the phrase), and
 *   - `...` as the working *message*.
 * Restores the defaults on turn_end and on agent_end.
 *
 * Colors are pulled from the active theme (`accent` spinner, `text` peak,
 * `dim` base) and emitted as truecolor (`38;2;r;g;b`) escapes, which pi-tui
 * passes through verbatim. Tone: mixed -- silly with a technical seasoning.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const VERBS = [
    "Frobnicating",
    "Wrangling",
    "Bamboozling",
    "Marinating",
    "Compiling",
    "Untangling",
    "Caffeinating",
    "Massaging",
    "Negotiating with",
    "Optimizing",
    "Refactoring",
    "Yeeting",
    "Linting",
    "Whispering to",
    "Bribing",
    "Hydrating",
    "Tracing",
    "Reticulating",
    "Defragmenting",
    "Coaxing",
    "Herding",
    "Polishing",
    "Stewing",
    "Tickling",
    "Interrogating",
    "Smuggling",
    "Decompiling",
    "Sharpening",
    "Untwisting",
    "Pickling",
    "Marshaling",
    "Hexing",
    "Summoning",
    "Sandwiching",
    "Photocopying",
    "Bedazzling",
    "Tranquilizing",
    "Apologizing to",
    "Gaslighting",
    "Buffering",
    "Memoizing",
    "Throttling",
    "Jiggling",
    "Confiscating",
    "Reanimating",
    "Wiggling",
    "Provoking",
    "Quarantining",
    "Steamrolling",
    "Disenchanting",
    "Roasting",
    "Chastising",
    "Embiggening",
    "Decoupling",
    "Hot-swapping",
    "Garbage-collecting",
    "Sandpapering",
    "Yodeling at",
    "Threatening",
    "Speedrunning",
];

const ADJECTIVES = [
    "spicy",
    "recursive",
    "stubborn",
    "elusive",
    "lossy",
    "caffeinated",
    "feral",
    "unstable",
    "judgmental",
    "sentient",
    "off-by-one",
    "non-deterministic",
    "dangling",
    "anxious",
    "smug",
    "haunted",
    "lukewarm",
    "rebellious",
    "overengineered",
    "deprecated",
    "monolithic",
    "asynchronous",
    "rusty",
    "snarky",
    "gluten-free",
    "quantum",
    "cursed",
    "lazy",
    "introverted",
    "verbose",
    "flaky",
    "immutable",
    "stale",
    "soggy",
    "paranoid",
    "undocumented",
    "unhinged",
    "polymorphic",
    "brittle",
    "sketchy",
    "indignant",
    "malloc'd",
    "eldritch",
    "sleep-deprived",
    "idempotent",
    "vintage",
    "mutinous",
    "whimsical",
    "fragmented",
    "leaky",
    "gassy",
    "invincible",
    "semi-functional",
    "alleged",
    "opinionated",
    "disgruntled",
    "redundant",
    "blockchain-enabled",
    "mid",
    "untestable",
];

const NOUNS = [
    "bytes",
    "tensors",
    "ducks",
    "hashmaps",
    "gradients",
    "semicolons",
    "linked lists",
    "race conditions",
    "yaks",
    "monads",
    "side effects",
    "stack frames",
    "regexes",
    "promises",
    "callbacks",
    "borrow checkers",
    "garbage collectors",
    "merge conflicts",
    "null pointers",
    "edge cases",
    "tech debts",
    "ASTs",
    "heisenbugs",
    "footguns",
    "kernel panics",
    "off-brand goblins",
    "rubber ducks",
    "cron jobs",
    "feature flags",
    "type errors",
    "mutexes",
    "daemons",
    "segfaults",
    "build artifacts",
    "microservices",
    "lambdas",
    "buffer overflows",
    "deadlocks",
    "env vars",
    "syscalls",
    "dependency trees",
    "lockfiles",
    "gremlins",
    "snapshots",
    "breakpoints",
    "hash collisions",
    "stack traces",
    "exceptions",
    "dangling pointers",
    "JSON blobs",
    "side quests",
    "retry storms",
    "ghost commits",
    "zombie processes",
    "timeouts",
    "vibes",
    "opcodes",
    "banana peels",
    "B-trees",
    "cache misses",
];

interface PickedWords {
    verb: string;
    adjective: string;
    noun: string;
}

interface Rgb {
    r: number;
    g: number;
    b: number;
}

interface SpinnerPrefix {
    glyphs: readonly string[];
    color: Rgb;
}

// pi's default braille spinner glyphs (see Loader in @earendil-works/pi-tui).
const SPINNER_GLYPHS = [
    "\u280B",
    "\u2819",
    "\u2839",
    "\u2838",
    "\u283C",
    "\u2834",
    "\u2826",
    "\u2827",
    "\u2807",
    "\u280F",
] as const;

// Shimmer-sweep animation tuning. FRAME_COUNT is a multiple of the spinner
// glyph count so the prefixed spinner cycles seamlessly across the loop.
const FRAME_COUNT = 40;
const INTERVAL_MS = 70;
// Falloff width (in characters) of the bright band around the peak.
const WAVE_WIDTH = 3.5;
// Extra travel distance past both ends so the bright band fully enters/exits
// and the loop is seamless even for the longest possible phrase. Enforced by
// the "fully exits at both ends" regression test. Must also be >= WAVE_WIDTH.
const WAVE_LEAD = 6;

// Endpoints used when the theme color cannot be resolved to RGB (e.g. the
// active theme runs in 256-color mode, or the color is unset). Truecolor is
// emitted regardless; these only seed the gradient.
const FALLBACK_PEAK: Rgb = { r: 212, g: 212, b: 212 }; // #D4D4D4 text
const FALLBACK_BASE: Rgb = { r: 107, g: 114, b: 128 }; // #6B7280 gray
const FALLBACK_ACCENT: Rgb = { r: 138, g: 190, b: 183 }; // #8ABEB7 accent

const FG_RGB_PATTERN = /\x1b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})m/;
const RESET = "\x1b[0m";

function pickFrom(pool: readonly string[], exclude?: string): string {
    // If excluding the previous pick would empty the pool (length <= 1),
    // fall back to the full pool rather than returning undefined.
    const candidates =
        exclude !== undefined && pool.length > 1
            ? pool.filter((w) => w !== exclude)
            : pool;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickWorkingWords(previous?: PickedWords): PickedWords {
    return {
        verb: pickFrom(VERBS, previous?.verb),
        adjective: pickFrom(ADJECTIVES, previous?.adjective),
        noun: pickFrom(NOUNS, previous?.noun),
    };
}

function formatPhrase(words: PickedWords): string {
    return `${words.verb} the ${words.adjective} ${words.noun}`;
}

/**
 * Extract an RGB triple from a foreground ANSI sequence of the form
 * `\x1b[38;2;r;g;bm`. Returns undefined for any other sequence (256-color,
 * default `39`, etc.) so callers can fall back to a fixed endpoint.
 */
function parseFgAnsiToRgb(ansi: string): Rgb | undefined {
    const match = FG_RGB_PATTERN.exec(ansi);
    if (!match) return undefined;
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    if (r > 255 || g > 255 || b > 255) return undefined;
    return { r, g, b };
}

function lerpChannel(a: number, b: number, t: number): number {
    return Math.round(a + (b - a) * t);
}

function truecolorFg({ r, g, b }: Rgb): string {
    return `\x1b[38;2;${r};${g};${b}m`;
}

interface SweepOptions {
    text: string;
    /** Bright endpoint at the wave peak. */
    peak: Rgb;
    /** Low-contrast endpoint away from the peak. */
    base: Rgb;
    /** Optional cycling spinner glyph prefixed to every frame. */
    spinner?: SpinnerPrefix;
}

/**
 * Build the shimmer-sweep animation frames for `text`. Each frame colors every
 * character by interpolating `base` -> `peak` using a narrow falloff around a
 * peak position that advances across the string (and past both ends) over the
 * course of the loop. When `spinner` is provided, each frame is prefixed with
 * the cycling spinner glyph (colored, then reset, then a space). Every frame is
 * terminated with a full reset so color never bleeds into the trailing working
 * message.
 */
function buildSweepFrames({ text, peak, base, spinner }: SweepOptions): string[] {
    const n = text.length;
    if (n === 0) return [""];

    const frames: string[] = [];
    const span = n - 1 + WAVE_LEAD * 2;
    const baseFg = truecolorFg(base);
    for (let f = 0; f < FRAME_COUNT; f++) {
        const peakPos = -WAVE_LEAD + (f / FRAME_COUNT) * span;
        let frame = spinner
            ? `${truecolorFg(spinner.color)}${
                  spinner.glyphs[f % spinner.glyphs.length]
              }${RESET} `
            : "";
        for (let i = 0; i < n; i++) {
            const k = Math.max(0, 1 - Math.abs(i - peakPos) / WAVE_WIDTH);
            // Most characters per frame sit outside the band (k === 0) and
            // render the precomputed base color verbatim.
            if (k === 0) {
                frame += baseFg + text[i];
                continue;
            }
            const e = k * k;
            const color: Rgb = {
                r: lerpChannel(base.r, peak.r, e),
                g: lerpChannel(base.g, peak.g, e),
                b: lerpChannel(base.b, peak.b, e),
            };
            frame += truecolorFg(color) + text[i];
        }
        frames.push(frame + RESET);
    }
    return frames;
}

export {
    buildSweepFrames,
    FRAME_COUNT,
    formatPhrase,
    parseFgAnsiToRgb,
    pickWorkingWords,
    SPINNER_GLYPHS,
};

export default function (pi: ExtensionAPI) {
    let lastWords: PickedWords | undefined;

    const restoreDefaults = (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;
        ctx.ui.setWorkingMessage();
        ctx.ui.setWorkingIndicator();
    };

    pi.on("turn_start", async (_event, ctx) => {
        if (!ctx.hasUI) return;
        const words = pickWorkingWords(lastWords);
        lastWords = words;

        // Resolve gradient/spinner endpoints from the active theme, falling
        // back to fixed RGB when a color cannot be parsed (e.g. 256-color mode).
        const resolve = (color: "text" | "dim" | "accent", fallback: Rgb): Rgb =>
            parseFgAnsiToRgb(ctx.ui.theme.getFgAnsi(color)) ?? fallback;
        const frames = buildSweepFrames({
            text: formatPhrase(words),
            peak: resolve("text", FALLBACK_PEAK),
            base: resolve("dim", FALLBACK_BASE),
            spinner: {
                glyphs: SPINNER_GLYPHS,
                color: resolve("accent", FALLBACK_ACCENT),
            },
        });

        ctx.ui.setWorkingMessage("...");
        ctx.ui.setWorkingIndicator({ frames, intervalMs: INTERVAL_MS });
    });

    // turn_end restores the default between turns; agent_end is the guaranteed
    // cleanup point (fires even on abort/error, when turn_end may be skipped).
    pi.on("turn_end", async (_event, ctx) => restoreDefaults(ctx));
    pi.on("agent_end", async (_event, ctx) => restoreDefaults(ctx));
}
