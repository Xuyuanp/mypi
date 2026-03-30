/**
 * peon-ping -- CESP v1.0 Sound Pack Extension
 *
 * Plays sound effects from OpenPeon-compatible sound packs when coding
 * events occur: session start, task completion, errors, input prompts.
 *
 * Conforms to the CESP v1.0 specification:
 * https://github.com/PeonPing/openpeon
 *
 * Pi Event -> CESP Category mapping:
 *   session_start             -> session.start
 *   turn_start                -> task.acknowledge
 *   agent_end (no errors)     -> task.complete
 *   agent_end (with errors)   -> task.error
 *   tool_call (questionnaire) -> input.required
 *   session_shutdown          -> session.end
 *   input (rapid)             -> user.spam
 *   resource.limit            -> not wired (needs error message parsing)
 *
 * Configuration: ~/.pi/agent/peon-ping.json
 * Packs directory: ~/.openpeon/packs/
 *
 * Commands:
 *   /sounds              -- show status
 *   /sounds install <n>  -- install pack from registry
 *   /sounds list         -- list installed packs
 *   /sounds mute         -- mute for this session
 *   /sounds unmute       -- unmute for this session
 *
 * CLI flag:
 *   --mute               -- start muted
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── CESP v1.0 Types ────────────────────────────────────────────────────

type CESPCategory =
    | "session.start"
    | "session.end"
    | "task.acknowledge"
    | "task.complete"
    | "task.error"
    | "task.progress"
    | "input.required"
    | "resource.limit"
    | "user.spam";

interface CESPSound {
    file: string;
    label: string;
}

interface CESPCategoryEntry {
    sounds: CESPSound[];
}

interface CESPManifest {
    cesp_version: string;
    name: string;
    display_name: string;
    version: string;
    categories: Partial<Record<CESPCategory, CESPCategoryEntry>>;
    category_aliases?: Record<string, string>;
}

// ── Config Types ───────────────────────────────────────────────────────

interface PeonConfig {
    pack: string;
    volume: number;
    enabled: boolean;
    categories: Partial<Record<CESPCategory, boolean>>;
    debounce_ms: number;
}

const DEFAULT_CONFIG: PeonConfig = {
    pack: "peasant",
    volume: 0.5,
    enabled: true,
    categories: {
        "session.start": true,
        "session.end": true,
        "task.acknowledge": true,
        "task.complete": true,
        "task.error": true,
        "task.progress": true,
        "input.required": true,
        "resource.limit": true,
        "user.spam": true,
    },
    debounce_ms: 500,
};

const PACKS_DIR = join(homedir(), ".openpeon", "packs");
const CONFIG_PATH = join(homedir(), ".pi", "agent", "peon-ping.json");
const REGISTRY_URL = "https://peonping.github.io/registry/index.json";

// ── Config ─────────────────────────────────────────────────────────────

function loadConfig(): PeonConfig {
    try {
        if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_CONFIG,
            ...parsed,
            categories: {
                ...DEFAULT_CONFIG.categories,
                ...parsed.categories,
            },
        };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

// ── Manifest Loading ───────────────────────────────────────────────────

function loadManifest(packDir: string): CESPManifest | null {
    const manifestPath = join(packDir, "openpeon.json");
    try {
        if (!existsSync(manifestPath)) return null;
        const raw = readFileSync(manifestPath, "utf-8");
        return JSON.parse(raw) as CESPManifest;
    } catch {
        return null;
    }
}

function resolveCategory(
    manifest: CESPManifest,
    category: CESPCategory,
): CESPCategoryEntry | null {
    // Direct lookup
    const direct = manifest.categories[category];
    if (direct && direct.sounds.length > 0) return direct;

    // Alias lookup
    if (manifest.category_aliases) {
        for (const [alias, target] of Object.entries(manifest.category_aliases)) {
            if (target === category) {
                const aliased = manifest.categories[alias as CESPCategory] as
                    | CESPCategoryEntry
                    | undefined;
                if (aliased && aliased.sounds.length > 0) return aliased;
            }
        }
    }

    return null;
}

function resolveSoundPath(packDir: string, fileRef: string): string {
    const normalized = fileRef.includes("/") ? fileRef : `sounds/${fileRef}`;
    return join(packDir, normalized);
}

// ── Pack Discovery ─────────────────────────────────────────────────────

interface PackInfo {
    name: string;
    displayName: string;
    version: string;
    categoryCount: number;
    soundCount: number;
}

function listPacks(): PackInfo[] {
    try {
        if (!existsSync(PACKS_DIR)) return [];
        return readdirSync(PACKS_DIR)
            .filter((name) => {
                const dir = join(PACKS_DIR, name);
                try {
                    return (
                        statSync(dir).isDirectory() &&
                        existsSync(join(dir, "openpeon.json"))
                    );
                } catch {
                    return false;
                }
            })
            .map((name) => {
                const manifest = loadManifest(join(PACKS_DIR, name));
                if (!manifest)
                    return {
                        name,
                        displayName: name,
                        version: "?",
                        categoryCount: 0,
                        soundCount: 0,
                    };
                const cats = Object.values(manifest.categories);
                const soundCount = cats.reduce(
                    (sum, c) => sum + (c?.sounds.length ?? 0),
                    0,
                );
                return {
                    name: manifest.name,
                    displayName: manifest.display_name,
                    version: manifest.version,
                    categoryCount: cats.length,
                    soundCount,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

// ── Sound Selection (no-repeat) ────────────────────────────────────────

function pickSound(
    entry: CESPCategoryEntry,
    lastFile: string | undefined,
): CESPSound {
    const sounds = entry.sounds;
    if (sounds.length === 1) return sounds[0];

    let candidates = sounds;
    if (lastFile) {
        const filtered = sounds.filter((s) => s.file !== lastFile);
        if (filtered.length > 0) candidates = filtered;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
}

// ── Audio Playback ─────────────────────────────────────────────────────

type LinuxBackend = "pw-play" | "paplay" | "aplay" | null;

function detectLinuxBackend(): LinuxBackend {
    for (const cmd of ["pw-play", "paplay", "aplay"] as const) {
        try {
            const result = spawnSync("which", [cmd], {
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 2000,
            });
            if (result.status === 0) return cmd;
        } catch {
            // continue
        }
    }
    return null;
}

function playSoundFile(
    filePath: string,
    volume: number,
    linuxBackend: LinuxBackend,
): void {
    if (!existsSync(filePath)) return;

    try {
        const os = platform();
        if (os === "darwin") {
            const child = spawn("afplay", ["-v", String(volume), filePath], {
                detached: true,
                stdio: "ignore",
            });
            child.unref();
        } else if (os === "linux" && linuxBackend) {
            let args: string[];
            switch (linuxBackend) {
                case "pw-play":
                    args = ["pw-play", "--volume", String(volume), filePath];
                    break;
                case "paplay": {
                    const paVol = Math.round(
                        Math.max(0, Math.min(65536, volume * 65536)),
                    );
                    args = ["paplay", `--volume=${paVol}`, filePath];
                    break;
                }
                case "aplay":
                    args = ["aplay", "-q", filePath];
                    break;
            }
            const child = spawn(args[0], args.slice(1), {
                detached: true,
                stdio: "ignore",
            });
            child.unref();
        }
    } catch {
        // Fire and forget -- never crash on playback failure
    }
}

// ── Debounce ───────────────────────────────────────────────────────────

function createDebouncer(debounceMs: number) {
    const lastFired: Partial<Record<CESPCategory, number>> = {};

    return function shouldSkip(category: CESPCategory): boolean {
        const now = Date.now();
        const last = lastFired[category];
        if (last !== undefined && now - last < debounceMs) return true;
        lastFired[category] = now;
        return false;
    };
}

// ── Spam Detection ─────────────────────────────────────────────────────

const SPAM_THRESHOLD = 3;
const SPAM_WINDOW_SECONDS = 10;

function createSpamDetector() {
    const timestamps: number[] = [];

    return function isSpam(): boolean {
        const now = Date.now() / 1000;
        const cutoff = now - SPAM_WINDOW_SECONDS;
        while (timestamps.length > 0 && timestamps[0] < cutoff) {
            timestamps.shift();
        }
        timestamps.push(now);
        return timestamps.length >= SPAM_THRESHOLD;
    };
}

// ── Pack Installation ──────────────────────────────────────────────────

interface RegistryEntry {
    name: string;
    display_name: string;
    source_repo: string;
    source_ref: string;
    source_path: string;
    categories: string[];
    sound_count: number;
    total_size_bytes: number;
}

async function fetchRegistry(): Promise<RegistryEntry[]> {
    const response = await fetch(REGISTRY_URL);
    if (!response.ok) {
        throw new Error(`Registry fetch failed: HTTP ${response.status}`);
    }
    return (await response.json()) as RegistryEntry[];
}

async function installPack(
    entry: RegistryEntry,
    exec: ExtensionAPI["exec"],
): Promise<void> {
    const tarUrl = `https://github.com/${entry.source_repo}/archive/refs/tags/${entry.source_ref}.tar.gz`;
    const destDir = join(PACKS_DIR, entry.name);

    mkdirSync(PACKS_DIR, { recursive: true });

    // Download and extract to temp
    const tmpDir = join(PACKS_DIR, `.tmp-${entry.name}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
        const { code: dlCode, stderr: dlErr } = await exec(
            "bash",
            ["-c", `curl -fsSL "${tarUrl}" | tar xz -C "${tmpDir}"`],
            { timeout: 60000 },
        );
        if (dlCode !== 0) {
            throw new Error(`Download failed: ${dlErr}`);
        }

        // Find the extracted directory (format: repo-name-ref/)
        const { stdout: lsOut } = await exec("ls", [tmpDir]);
        const extractedDir = lsOut.trim().split("\n")[0];
        if (!extractedDir) {
            throw new Error("Could not find extracted directory");
        }

        const sourceDir = join(tmpDir, extractedDir, entry.source_path);
        if (!existsSync(join(sourceDir, "openpeon.json"))) {
            throw new Error(`No openpeon.json found in ${entry.source_path}/`);
        }

        // Remove existing pack if present, then move
        await exec("rm", ["-rf", destDir]);
        await exec("mv", [sourceDir, destDir]);
    } finally {
        // Clean up temp dir
        await exec("rm", ["-rf", tmpDir]);
    }

    // Verify
    if (!existsSync(join(destDir, "openpeon.json"))) {
        throw new Error("Installation verification failed: openpeon.json missing");
    }
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let config = loadConfig();
    let manifest: CESPManifest | null = null;
    let packDir = "";
    let muted = false;
    let linuxBackend: LinuxBackend = null;
    let turnHadError = false;

    const lastPlayed: Partial<Record<CESPCategory, string>> = {};
    const shouldSkip = createDebouncer(config.debounce_ms);
    const isSpam = createSpamDetector();

    // Detect Linux audio backend once at load time
    if (platform() === "linux") {
        linuxBackend = detectLinuxBackend();
    }

    // Register --mute flag
    pi.registerFlag("mute", {
        description: "Start with sounds muted",
        type: "boolean",
    });

    function loadActivePack(): boolean {
        const dir = join(PACKS_DIR, config.pack);
        const m = loadManifest(dir);
        if (!m) {
            manifest = null;
            packDir = "";
            return false;
        }
        manifest = m;
        packDir = dir;
        return true;
    }

    function emit(category: CESPCategory): void {
        if (muted || !config.enabled) return;
        if (!manifest) return;
        if (config.categories[category] === false) return;
        if (shouldSkip(category)) return;

        const entry = resolveCategory(manifest, category);
        if (!entry) return;

        const sound = pickSound(entry, lastPlayed[category]);
        lastPlayed[category] = sound.file;

        const filePath = resolveSoundPath(packDir, sound.file);
        playSoundFile(filePath, config.volume, linuxBackend);
    }

    // ── Status display ─────────────────────────────────────────────────

    function updateStatus(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        if (!manifest) {
            ctx.ui.setStatus("sounds", undefined);
            return;
        }
        const state = muted
            ? ctx.ui.theme.fg("dim", "muted")
            : ctx.ui.theme.fg("success", "on");
        ctx.ui.setStatus("sounds", `${ctx.ui.theme.fg("dim", "sounds:")}${state}`);
    }

    // ── Lifecycle Events ───────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        config = loadConfig();
        const loaded = loadActivePack();

        if (pi.getFlag("mute")) {
            muted = true;
        }

        if (loaded) {
            const packCount = listPacks().length;
            ctx.ui.notify(
                `peon-ping: ${manifest!.display_name} v${manifest!.version} (${packCount} pack${packCount === 1 ? "" : "s"} installed)`,
                "info",
            );
        }

        updateStatus(ctx);
        emit("session.start");
    });

    pi.on("turn_start", async () => {
        turnHadError = false;
        emit("task.acknowledge");
    });

    pi.on("tool_call", async (event) => {
        if (event.toolName === "questionnaire") {
            emit("input.required");
        }
    });

    pi.on("tool_result", async (event) => {
        if (event.isError) {
            turnHadError = true;
        }
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (turnHadError) {
            emit("task.error");
        } else {
            emit("task.complete");
        }
        updateStatus(ctx);
    });

    pi.on("session_shutdown", async () => {
        emit("session.end");
    });

    pi.on("input", async () => {
        if (isSpam()) {
            emit("user.spam");
        }
    });

    // ── Commands ───────────────────────────────────────────────────────

    pi.registerCommand("sounds", {
        description: "Sound pack management (install <name>, list, mute, unmute)",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/);
            const subcommand = parts[0] || "";

            switch (subcommand) {
                case "install": {
                    const packName = parts[1];
                    if (!packName) {
                        ctx.ui.notify("Usage: /sounds install <pack-name>", "error");
                        return;
                    }

                    ctx.ui.notify(
                        `Fetching registry to install "${packName}"...`,
                        "info",
                    );

                    let registry: RegistryEntry[];
                    try {
                        registry = await fetchRegistry();
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.ui.notify(`Failed to fetch registry: ${msg}`, "error");
                        return;
                    }

                    const entry = registry.find((e) => e.name === packName);
                    if (!entry) {
                        const available = registry
                            .map((e) => e.name)
                            .slice(0, 20)
                            .join(", ");
                        ctx.ui.notify(
                            `Pack "${packName}" not found in registry. Available: ${available}...`,
                            "error",
                        );
                        return;
                    }

                    const sizeKB = Math.round(entry.total_size_bytes / 1024);
                    ctx.ui.notify(
                        `Installing ${entry.display_name} (${entry.sound_count} sounds, ${sizeKB}KB)...`,
                        "info",
                    );

                    try {
                        await installPack(entry, pi.exec);
                        ctx.ui.notify(
                            `Installed "${entry.display_name}" to ${PACKS_DIR}/${entry.name}`,
                            "info",
                        );

                        // If this is the configured pack, reload it
                        if (entry.name === config.pack) {
                            loadActivePack();
                            updateStatus(ctx);
                            emit("session.start");
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.ui.notify(`Install failed: ${msg}`, "error");
                    }
                    return;
                }

                case "list": {
                    const packs = listPacks();
                    if (packs.length === 0) {
                        ctx.ui.notify(
                            `No packs installed. Run: /sounds install peasant\nPacks dir: ${PACKS_DIR}`,
                            "info",
                        );
                        return;
                    }

                    const lines = packs.map((p) => {
                        const active = p.name === config.pack ? " (active)" : "";
                        return `  ${p.displayName} v${p.version} -- ${p.soundCount} sounds, ${p.categoryCount} categories${active}`;
                    });

                    ctx.ui.notify(`Installed packs:\n${lines.join("\n")}`, "info");
                    return;
                }

                case "mute": {
                    muted = true;
                    updateStatus(ctx);
                    ctx.ui.notify("Sounds muted", "info");
                    return;
                }

                case "unmute": {
                    muted = false;
                    updateStatus(ctx);
                    ctx.ui.notify("Sounds unmuted", "info");
                    emit("session.start");
                    return;
                }

                default: {
                    // No subcommand -- show status
                    const packName = manifest
                        ? `${manifest.display_name} v${manifest.version}`
                        : "(no pack loaded)";
                    const state = muted
                        ? "muted"
                        : config.enabled
                          ? "enabled"
                          : "disabled";
                    const vol = `${Math.round(config.volume * 100)}%`;
                    const packCount = listPacks().length;

                    const categorySummary = manifest
                        ? Object.entries(config.categories)
                              .filter(([, v]) => v !== false)
                              .map(([k]) => k)
                              .join(", ")
                        : "n/a";

                    ctx.ui.notify(
                        [
                            `Pack: ${packName}`,
                            `State: ${state}`,
                            `Volume: ${vol}`,
                            `Installed: ${packCount} pack${packCount === 1 ? "" : "s"}`,
                            `Categories: ${categorySummary}`,
                            `Packs dir: ${PACKS_DIR}`,
                            `Config: ${CONFIG_PATH}`,
                            "",
                            "Commands: /sounds install <name> | list | mute | unmute",
                        ].join("\n"),
                        "info",
                    );
                    return;
                }
            }
        },
    });
}
