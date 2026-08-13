# Aera branding

The desktop, browser account center, administration surfaces, installers, and update metadata expose one Aera product identity while retaining wire, storage, and runtime compatibility with already installed builds.

## Naming contract

First-party product, publisher, installer, and runtime display names are fixed so every release surface stays consistent.

### Desktop identity

The customer-facing desktop product and publisher are Aera. Normal installer and archive filenames use the `Aera-` stem, while the internal npm package name remains `agentera-studio` so existing build, OAuth, and update contracts do not fork.

The active source, release, update, and Runtime Seed repositories are published under `Ablankpaper`; legacy `bignormal` references remain only where they are compatibility identifiers or factual Go module paths.

### Visible application names

Composed UI surfaces use Aera for the desktop and Aera Runtime for the bundled engine. Account, admin, email, API, About, menu, notification, installer, and release surfaces follow the same names.

## Localization

Every supported locale keeps the Aera names unchanged while translating the surrounding sentence normally.

### All supported locales

All twelve locale packs expose Aera consistently and contain no inherited AgentEra, WorkBuddy, or AionUI promotion copy. Hermes One may remain where it names the separate third-party provider; generic engine copy uses Aera Runtime.

Branding and desktop-identity regression tests use Node path utilities for filenames and data directories, preserving identical assertions across macOS, Windows, and Linux.

### Windows executable and shortcut icon

Windows packages use the Aera icon in the executable and generated shortcuts, including unsigned Internal-Beta builds.

`electron-builder.yml` explicitly assigns `build/icon.ico` to `win.icon`. The `build/electron-builder.internal-beta.yml` overlay must not set `win.signAndEditExecutable: false`: that switch also disables Electron Builder's PE resource editing, which leaves the executable and generated shortcut with Electron's atom icon.

`scripts/internal-beta/workflow-policy.test.mjs` locks both the explicit icon and the absence of that resource-disabling override.

### Aila sign-in identity

The account gate uses the native Three.js model at `src/renderer/src/assets/aila.glb` as Aila's product character. It must match the approved source model byte-for-byte.

Loading the GLB may show a neutral progress indicator, but must not replace Aila with a generated avatar, a flat “A” mark, the Electron icon, or another character. If WebGL is unavailable, the gate explains that 3D acceleration is required instead of presenting a substitute identity.

## Compatibility boundary

Branding changes never silently rename runtime protocols, data directories, commands, provider ids, or third-party services.

`aera://` is the primary invitation protocol, and the desktop continues accepting `agentera://` links from already deployed Cloud versions and older invitations.

### Stable runtime identifiers

Runtime, wire, package, and storage identifiers that existing installations depend on remain stable.

This includes `com.bignormal.agentera.studio`, the OAuth audience and npm package `agentera-studio`, WinGet identifier `Bignormal.AgentEraStudio`, legacy `AgentEra Studio`/`agentera-studio`/`hermes-desktop` user-data directories, `HERMES_*`, `.hermes`, `hermes_cli`, `hermesAPI`, protocol headers, provider ids, and factual third-party names.

Aera adopts an existing legacy user-data directory only when its new directory is absent, so an online upgrade retains profiles, sessions, credentials, and updater state.
