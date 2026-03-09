# Development Guide

## About

- This is my personal pi package

## Structure

- `extensions/` - Custom pi extensions
- `themes/` - Custom themes for pi TUI
- `prompts/` - Prompt templates
- `skills/` - Specialized skills (future use)

## Code Style

### Design Principles

- Keep utility functions generic and pure — push context-specific logic (cwd resolution, env construction, etc.) to callers
- Prefer passing primitive/standard types (`string`, `NodeJS.ProcessEnv`) over domain objects into low-level helpers
- Each extension is a self-contained module: types, helpers, and default export in one file
- State lives in closures inside the default export function, not in module-level mutable variables
- Use classes only for TUI components (implementing `Component` interface); prefer closures + plain objects elsewhere
- Export internal helpers as named exports only when they need to be tested or reused (e.g. `buildFallbackTitle`, `postProcessTitle`)

### TypeScript Conventions

- ES module syntax with `import`/`export`; use `.js` extension for relative imports (e.g. `"./agents.js"`)
- Use `import type` for type-only imports
- Node.js built-ins use the `node:` prefix (e.g. `node:fs`, `node:path`, `node:os`)
- Define interfaces/types locally in each file rather than in shared type files
- Tool parameter schemas use `@sinclair/typebox` (`Type.Object`, `Type.String`, etc.) and `StringEnum` from `@mariozechner/pi-ai`
- Default export is `export default function(pi: ExtensionAPI) { ... }` (anonymous) or a named function for larger extensions

### Formatting & Linting

- Enforced by [Biome](https://biomejs.dev/) via `biome.json`
- Run `make format` to format, `make lint` to check, `make fix` to format + auto-fix safe lint issues
- 4-space indentation, semicolons, double quotes for strings
- Trailing commas in multi-line constructs
- Line width: 85
- Prefer template literals over string concatenation
- Use `Number.isNaN()` over global `isNaN()`
- `const` by default; `let` only when reassignment is needed
- Module-level constants in `UPPER_SNAKE_CASE`
- Top-level helpers as `function` declarations; callbacks as arrow functions

### Naming Conventions

- `ctx` for pi `ExtensionContext` or `ExtensionCommandContext`.

### Error Handling

- `try/catch` with empty catch body (`catch { }`) when errors are intentionally ignored
- Return fallback values from catch blocks rather than re-throwing
- Retry loops with a `MAX_RETRIES` constant and final fallback (see `session-name.ts`)

### Extension Structure

```ts
/**
 * Block comment describing the extension's purpose and usage.
 */

import type { ... } from "@mariozechner/pi-coding-agent";
// other imports

// Types / interfaces
// Constants (UPPER_SNAKE_CASE)
// Pure helper functions

export default function(pi: ExtensionAPI) {
    // Mutable state (closures)
    // Event listeners: pi.on(...)
    // Commands: pi.registerCommand(...)
    // Tools: pi.registerTool(...)
    // Shortcuts: pi.registerShortcut(...)
}
```
