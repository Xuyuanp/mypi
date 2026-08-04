import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Resolve @earendil-works peer-dependency packages to the copies nested
 * inside pi-coding-agent so that tests and the runtime share the same
 * module-level singletons (e.g. the faux API provider registry).
 *
 * Without this, npm may hoist duplicate copies and the faux provider
 * registered in tests is invisible to the agent session at runtime.
 */
const piCodingAgentModules = resolve(
    "node_modules/@earendil-works/pi-coding-agent/node_modules",
);

const piAiDir = resolve(piCodingAgentModules, "@earendil-works/pi-ai");

export default defineConfig({
    resolve: {
        alias: {
            // compat is a strict superset of the root entrypoint.
            // Both aliases are needed: explicit compat imports and bare root imports.
            "@earendil-works/pi-ai/compat": resolve(piAiDir, "dist/compat.js"),
            "@earendil-works/pi-ai": resolve(piAiDir, "dist/compat.js"),
            "@earendil-works/pi-agent-core": resolve(
                piCodingAgentModules,
                "@earendil-works/pi-agent-core/dist/index.js",
            ),
        },
    },
    test: {
        isolate: false,
        maxWorkers: 1,
    },
});
