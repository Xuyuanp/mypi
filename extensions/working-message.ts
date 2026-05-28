/**
 * Working Message Extension
 *
 * Replaces pi's default streaming loader text with a randomly composed
 * phrase shaped like `<Verbing> the <adj> <noun>...` for the duration
 * of each turn. Restores the default message on turn_end.
 *
 * Tone: mixed -- silly with a technical seasoning.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function formatMessage(words: PickedWords): string {
    return `${words.verb} the ${words.adjective} ${words.noun}...`;
}

export default function (pi: ExtensionAPI) {
    let lastWords: PickedWords | undefined;

    pi.on("turn_start", async (_event, ctx) => {
        if (!ctx.hasUI) return;
        const words = pickWorkingWords(lastWords);
        lastWords = words;
        ctx.ui.setWorkingMessage(formatMessage(words));
    });

    pi.on("turn_end", async (_event, ctx) => {
        if (!ctx.hasUI) return;
        ctx.ui.setWorkingMessage();
    });
}
