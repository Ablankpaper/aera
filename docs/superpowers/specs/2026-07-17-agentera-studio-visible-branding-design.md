# AgentEra Studio Visible Branding Design

## Goal

Move every user-visible desktop-product surface under the AgentEra brand while preserving the current application behavior and Hermes runtime compatibility.

## Chosen Approach

Restore the already approved AgentEra visual assets and partial branding work onto the latest GitHub `main`, then complete a source-backed visible-brand audit. This preserves previous work without replacing the freshly synchronized repository or performing an unsafe global string replacement.

The change is deliberately limited to brand names, brand assets, product metadata, and product-owned links. It does not redesign screens, change application behavior, rename runtime protocols, or migrate internal APIs.

## Naming Contract

- Desktop product name: `AgentEra Studio`.
- Parent brand, publisher, vendor, and ecosystem name: `AgentEra`.
- Bundled engine name when shown to users: `AgentEra Runtime`.
- Package and artifact stem: `agentera-studio`.
- Electron bundle/application id: `com.bignormal.agentera.studio`.
- Windows executable name: `agentera-studio`.
- Windows package identifier: `Bignormal.AgentEraStudio`.
- Source, issue, release, and desktop-update repository: `Ablankpaper/aera`.

Functional suffixes such as `Studio` and `Runtime` describe product roles; `AgentEra` remains the only first-party brand.

## User-Visible Scope

The following desktop-owned surfaces use `AgentEra Studio`, `AgentEra`, or `AgentEra Runtime` according to the naming contract:

- Window, HTML document, Dock/taskbar, application menu, notification, dialog, and error titles.
- Startup splash wordmark and accessibility text.
- Installer, shortcut, uninstaller, package descriptions, artifact names, Winget metadata, and Linux desktop metadata.
- Application icon, tray/taskbar icon, installer icon, in-app brand marks, and About/update branding.
- First-run, install, settings, diagnostics, local command output, Office/3D labels, and all supported locale strings.
- Desktop-owned repository, issue, release, update, community, social, donation, and analytics explanations.
- Active public product documentation and README branding where it describes this desktop product.

The existing upstream follow-on-X prompt, donation link, and upstream community links are removed because no AgentEra-owned replacements have been supplied. Source, issue, release, and update links point to `https://github.com/Ablankpaper/aera`. No new analytics, community, social, or donation endpoint is invented.

Third-party provider and service names such as OpenAI remain factual provider labels. Functional third-party integrations remain available and are not relabeled as AgentEra. Upstream surfaces that only promote the former desktop brand, rather than provide a product function, are removed.

## Startup and Visual Assets

The startup flow, timing, status messages, connection checks, and local-mode escape hatch stay unchanged. The splash keeps the current black-and-gray abstract motion background and replaces the Hermes SVG with a CSS-rendered gradient `AgentEra Studio` wordmark.

The purple system overlay in the supplied screenshot and the white system corner artifact are not part of the application design. They are not reproduced.

The approved blue-purple AgentEra icon is the canonical source for macOS, Windows, Linux, installer, shortcut, taskbar, Dock, and in-app brand assets. Required platform sizes are derived from that source without changing the visual design.

## Compatibility Boundary

The following internal compatibility surfaces remain unchanged unless a separate migration is approved:

- `HERMES_*` environment variables, including `HERMES_HOME` and the existing desktop override variables.
- `.hermes` directories, `hermes-agent`, `hermes_cli`, IPC bridge names, API headers, routes, database schemas, provider ids, and model ids.
- Runtime command syntax and filesystem paths required by the bundled engine.
- Existing application data and user configuration locations.

Branding metadata must not make an existing user appear to have lost settings, history, profiles, or update preferences. If the packaged product-name change would alter Electron's default `userData` path, the implementation must preserve or non-destructively adopt the existing data location.

Internal comments and test fixtures may retain Hermes terms when they document a real compatibility contract and cannot be displayed to users. A global search-and-replace is explicitly prohibited.

## Legal Attribution

The MIT license, copyright notices, source history, and required third-party notices remain intact. They may be presented through a neutral licenses or acknowledgements surface, but upstream author, social, donation, or community branding is not presented as AgentEra product identity.

## Testing and Verification

Implementation starts with a focused visible-brand contract test. It scans desktop-owned source, metadata, locales, documentation, and composed UI entrypoints for forbidden first-party Hermes/Nous/fathah branding while maintaining an explicit allowlist for internal compatibility and factual third-party references.

Verification includes:

- Focused brand, icon, packaging, locale, and startup-screen tests.
- Existing affected renderer and main-process tests.
- Type checking and the full Vitest suite.
- An unsigned production code build; signing, notarization, and release publication are excluded.
- `lat check` after documenting the brand contract, or a clearly reported environment blocker if the repository's `lat` command is unavailable.
- A live desktop launch using the existing installation-download bypass, verifying the `AgentEra Studio` splash, window title, icon, main UI, and absence of upstream promotion.

## Out of Scope

- Feature, layout, color-system, navigation, workflow, or startup-behavior changes.
- Runtime protocol, API, IPC, database, environment-variable, or filesystem renames.
- Creating AgentEra cloud, account, analytics, social, donation, or community services.
- Dependency upgrades or broad audit fixes.
- Signing, notarization, publishing a release, or pushing implementation changes without separate authorization.
