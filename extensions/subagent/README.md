# Subagent Extension

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
extensions/subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
└── agents.ts            # Agent discovery logic
```

Agent definitions and workflow prompts are managed separately:

- Agents: `~/.pi/agent/agents/*.md` (user-level) or `.pi/agents/*.md` (project-level)
- Workflow prompts: Define in `prompts/` directory of this package or `~/.pi/agent/prompts/`

## Installation

This extension is part of the `@pangxuyuan/mypi` package. Install the package to use it:

```bash
npm install -g @pangxuyuan/mypi
```

Or link locally for development:

```bash
# From this repository root
npm link
```

The extension will be automatically loaded by pi when the package is installed.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent

```
Use scout to find all authentication code
```

### Parallel execution

```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow

```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts

```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode     | Parameter          | Description                                            |
| -------- | ------------------ | ------------------------------------------------------ |
| Single   | `{ agent, task }`  | One agent, one task                                    |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` placeholder               |

## Output Display

**Collapsed view** (default):

- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:

- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):

- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**

- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Creating Agents and Workflows

To create specialized agents:

1. **User-level agents**: Create `.md` files in `~/.pi/agent/agents/`
2. **Workflow prompts**: Create `.md` files in `~/.pi/agent/prompts/` or in this package's `prompts/` directory

Example agents you might create:

- `scout` - Fast codebase reconnaissance (Haiku, limited tools)
- `planner` - Creates implementation plans (Sonnet, read-only tools)
- `reviewer` - Code review specialist (Sonnet)
- `worker` - General-purpose with full capabilities (Sonnet)

Example workflow prompts:

- `/implement` - Chain scout → planner → worker
- `/scout-and-plan` - Chain scout → planner
- `/implement-and-review` - Chain worker → reviewer → worker

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
