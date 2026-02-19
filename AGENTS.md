# Development Guide

## About

- This is my personal pi package

## Code Style

- Keep utility functions generic and pure — push context-specific logic (cwd resolution, env construction, etc.) to callers
- Prefer passing primitive/standard types (`string`, `NodeJS.ProcessEnv`) over domain objects into low-level helpers
