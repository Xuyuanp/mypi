/**
 * Multiplexer abstraction for /subagent attach.
 *
 * Detects the active terminal multiplexer (tmux or herdr) at extension
 * startup and provides a uniform attach() interface for opening panes
 * and running commands in them.
 *
 * Three implementations:
 * - tmuxMultiplexer: uses tmux split-window / new-window
 * - herdrMultiplexer: uses herdr pane split / tab create + pane run
 * - noopMultiplexer: returns error when no multiplexer is available
 *
 * The exec function is injected by the factory caller (typically index.ts
 * wrapping pi.exec) and closed over — attach() callers never see it.
 */

// ── Types ────────────────────────────────────────────────────────────

/** Minimal exec interface — mirrors pi.exec without opts (not needed). */
export type ExecFn = (
    cmd: string,
    args: string[],
) => Promise<{ code: number; stderr?: string; stdout?: string }>;

export interface PaneDirection<D extends string = string> {
    value: D;
    label: string;
}

export interface Multiplexer<D extends string = string> {
    readonly name: string;
    readonly directions: PaneDirection<D>[];
    readonly available: boolean;

    /**
     * Human-readable explanation of why this multiplexer is unavailable.
     * Only meaningful when `available` is false.
     */
    readonly unavailableHint?: string;

    /**
     * Open a new pane/window in the given direction and run
     * shellCommand in it.
     *
     * @param direction - One of this.directions[].value.
     * @param cwd - Working directory for the new pane.
     * @param shellCommand - Full shell command string to execute.
     * @returns { code: 0 } on success, { code: non-zero, stderr } on failure.
     */
    attach(
        direction: D,
        cwd: string,
        shellCommand: string,
    ): Promise<{ code: number; stderr?: string }>;
}

// ── Shell quoting ────────────────────────────────────────────────────

/**
 * Shell-quote a string for safe embedding in a shell command.
 * Uses single quotes and escapes embedded single quotes.
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

// ── Tmux direction flags ────────────────────────────────────────────

const TMUX_FLAGS = {
    right: ["split-window", "-h"],
    bottom: ["split-window", "-v"],
    left: ["split-window", "-hb"],
    top: ["split-window", "-vb"],
    "new-window": ["new-window"],
} as const satisfies Record<string, string[]>;

/**
 * Build the tmux argument array for opening a pane/window.
 * Exported for testing.
 */
export function buildTmuxArgs(
    direction: string,
    cwd: string,
    shellCommand: string,
): string[] {
    const flags = TMUX_FLAGS[direction];
    if (!flags) {
        throw new Error(`Unknown tmux direction: ${direction}`);
    }
    return [...flags, "-c", cwd, shellCommand];
}

export type TmuxDirection = keyof typeof TMUX_FLAGS;

// ── Tmux implementation ──────────────────────────────────────────────

function createTmuxMultiplexer(exec: ExecFn): Multiplexer<TmuxDirection> {
    const directions: PaneDirection<TmuxDirection>[] = [
        { label: "Right", value: "right" },
        { label: "Bottom", value: "bottom" },
        { label: "Left", value: "left" },
        { label: "Top", value: "top" },
        { label: "New window", value: "new-window" },
    ];

    return {
        name: "tmux",
        directions,
        available: true,
        async attach(direction, cwd, shellCommand) {
            const args = buildTmuxArgs(direction, cwd, shellCommand);
            const result = await exec("tmux", args);
            return { code: result.code, stderr: result.stderr };
        },
    };
}

// ── Herdr implementation ─────────────────────────────────────────────

type HerdrDirection = "right" | "down" | "new-tab";

function createHerdrMultiplexer(exec: ExecFn): Multiplexer<HerdrDirection> {
    // Read env vars once at construction (inside detectMultiplexer).
    const paneId = process.env.HERDR_PANE_ID ?? "";
    const workspaceId = process.env.HERDR_WORKSPACE_ID ?? "";

    const directions: PaneDirection<HerdrDirection>[] = [
        { label: "Right", value: "right" },
        { label: "Bottom", value: "down" },
        { label: "New tab", value: "new-tab" },
    ];

    return {
        name: "herdr",
        directions,
        available: true,
        async attach(direction, cwd, shellCommand) {
            let newPaneId: string;

            try {
                if (direction === "new-tab") {
                    const r = await exec("herdr", [
                        "tab",
                        "create",
                        "--workspace",
                        workspaceId,
                        "--cwd",
                        cwd,
                        "--focus",
                    ]);
                    if (r.code !== 0) {
                        return { code: r.code, stderr: r.stderr };
                    }
                    const parsed = JSON.parse(r.stdout ?? "{}");
                    newPaneId = parsed.result?.root_pane?.pane_id;
                    if (!newPaneId) {
                        return {
                            code: 1,
                            stderr: "could not parse pane id from tab create response",
                        };
                    }
                } else {
                    const r = await exec("herdr", [
                        "pane",
                        "split",
                        paneId,
                        "--direction",
                        direction,
                        "--cwd",
                        cwd,
                        "--focus",
                    ]);
                    if (r.code !== 0) {
                        return { code: r.code, stderr: r.stderr };
                    }
                    const parsed = JSON.parse(r.stdout ?? "{}");
                    newPaneId = parsed.result?.pane?.pane_id;
                    if (!newPaneId) {
                        return {
                            code: 1,
                            stderr: "could not parse pane id from split response",
                        };
                    }
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : "unknown error";
                return {
                    code: 1,
                    stderr: `failed to create herdr pane: ${msg}`,
                };
            }

            const result = await exec("herdr", [
                "pane",
                "run",
                newPaneId,
                shellCommand,
            ]);
            return { code: result.code, stderr: result.stderr };
        },
    };
}

// ── Noop implementation ──────────────────────────────────────────────

function createNoopMultiplexer(): Multiplexer {
    return {
        name: "none",
        directions: [],
        available: false,
        unavailableHint: "attach requires tmux or herdr",
        async attach(_direction, _cwd, _shellCommand) {
            return {
                code: 1,
                stderr: "attach requires tmux or herdr",
            };
        },
    };
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Detect the active multiplexer at startup and return the appropriate
 * implementation.
 *
 * The exec function is closed over by each implementation so that
 * attach() callers never need to pass it. The caller (typically index.ts)
 * wraps pi.exec to preserve this binding:
 *
 *   detectMultiplexer((cmd, args) => pi.exec(cmd, args))
 */
export function detectMultiplexer(exec: ExecFn): Multiplexer {
    if (process.env.HERDR_ENV === "1") return createHerdrMultiplexer(exec);
    if (process.env.TMUX) return createTmuxMultiplexer(exec);
    return createNoopMultiplexer();
}
