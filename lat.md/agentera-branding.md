# AgentEra branding

The desktop exposes one AgentEra product identity while retaining internal Hermes runtime compatibility.

## Naming contract

First-party product, publisher, package, and runtime display names are fixed so every release surface stays consistent.

### Desktop identity

The desktop product is AgentEra Studio, published by AgentEra from `bignormal/aera`, with package stem `agentera-studio`.

### Visible application names

Composed UI surfaces use AgentEra Studio for the desktop and AgentEra Runtime for the bundled engine.

## Localization

Every supported locale keeps the AgentEra names unchanged while translating the surrounding sentence normally.

### All supported locales

All twelve locale packs expose AgentEra Studio consistently and contain no inherited first-party promotion copy.

Branding and desktop-identity regression tests use Node path utilities for filenames and data directories, preserving identical assertions across macOS, Windows, and Linux.

### Windows executable and shortcut icon

Windows packages use the AgentEra icon in the executable and generated shortcuts, including unsigned Internal-Beta builds.

`electron-builder.yml` explicitly assigns `build/icon.ico` to `win.icon`. The `build/electron-builder.internal-beta.yml` overlay must not set `win.signAndEditExecutable: false`: that switch also disables Electron Builder's PE resource editing, which leaves the executable and generated shortcut with Electron's atom icon.

`scripts/internal-beta/workflow-policy.test.mjs` locks both the explicit icon and the absence of that resource-disabling override.

### Aila sign-in identity

The account gate uses the native Three.js model at `src/renderer/src/assets/aila.glb` as Aila's product character. It must match the approved source model byte-for-byte.

Loading the GLB may show a neutral progress indicator, but must not replace Aila with a generated avatar, a flat “A” mark, the Electron icon, or another character. If WebGL is unavailable, the gate explains that 3D acceleration is required instead of presenting a substitute identity.

## Compatibility boundary

Branding changes never rename runtime protocols, data directories, commands, provider ids, or third-party services.

### Stable runtime identifiers

`HERMES_*`, `.hermes`, `hermes_cli`, `hermesAPI`, provider ids, and factual third-party names remain stable.
