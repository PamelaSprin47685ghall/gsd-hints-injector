# GSD Hints Injector

This is a GSD extension that injects `HINTS.md` (global and project-level) into every GSD session.

## Installation

```bash
gsd install git:github.com/PamelaSprin47685ghall/gsd-hints-injector
```

## Usage

1. **Global Hints:** Create `~/.gsd/HINTS.md`.
2. **Project Hints:** Create `HINTS.md` or `.gsd/HINTS.md` in your project root.

The extension will automatically read these files and inject them into every new session.
