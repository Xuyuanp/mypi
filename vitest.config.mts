import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Resolve @earendil-works peer-dependency packages to the single hoisted
 * copy in the repo's node_modules so that tests and the runtime share the
 * same module-level singletons (e.g. the faux API provider registry).
 *
 * pi 1.0 dedupes these packages to one hoisted copy. The previous alias
 * pointed at a pi-ai copy nested inside pi-coding-agent, which no longer
 * exists.
 */
const peerModules = resolve("node_modules/@earendil-works");

const piAiDir = resolve(peerModules, "pi-ai");

export default defineConfig({
    resolve: {
        alias: {
            // compat is a strict superset of the root entrypoint.
            // Both aliases are needed: explicit compat imports and bare root imports.
            "@earendil-works/pi-ai/compat": resolve(piAiDir, "dist/compat.js"),
            "@earendil-works/pi-ai": resolve(piAiDir, "dist/compat.js"),
            "@earendil-works/pi-agent-core": resolve(
                peerModules,
                "pi-agent-core/dist/index.js",
            ),
        },
    },
    test: {
        isolate: false,
        maxWorkers: 1,
    },
});
