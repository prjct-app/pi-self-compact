# Contributing

Integration branch is `develop`.

```bash
npm run check
npm test
npm run check:package
```

Do not add `let` in `src/`. Pi packages stay peer dependencies. Use public Pi 0.85.1 APIs only, and keep the extension working on newer Pi releases that are installed locally (0.86 sends the system prompt as a leading system message; see `src/summary.ts`).

Build the compiled copy Pi loads with `npm run build:pi` (or `~/Apps/pi/install-local.sh pi-self-compact`). It writes `~/.pi/agent/builds/pi-self-compact`, outside the repository.
