# AgentEra Transparent In-App Mark Design

## Goal

Make the AgentEra mark blend naturally with both light and dark application themes without changing the established product identity or operating-system package icons.

## Chosen Approach

- Replace `src/renderer/src/assets/iconv2.png` with a transparent-background version that preserves the existing blue-purple AgentEra artwork and proportions.
- Remove the fixed black circular background from `.chat-empty-icon` while preserving its size, centering, spacing, and empty-state layout.
- Keep the macOS, Windows, Linux, installer, Dock, taskbar, and application package icon files unchanged.
- Reuse the transparent renderer mark on existing in-app surfaces that already consume `iconv2.png`; do not alter third-party provider or service icons.

## Visual Contract

- Light theme: no black ring and no opaque white square around the central mark.
- Dark theme: the blue-purple mark remains legible without a hard-coded contrasting tile.
- The mark must retain smooth edges, transparent corners, and the existing visual silhouette.
- No text, layout, sizing, interaction, or theme behavior changes.

## Verification

- Add an asset test that requires an alpha channel on the renderer-only mark while confirming the package icon set remains unchanged.
- Add a composed-surface regression assertion that rejects a fixed black background on `.chat-empty-icon`.
- Run focused tests, type checking, the full test suite, and the production code build.
- Launch the desktop with the existing Runtime-download bypass and visually inspect the empty state in both light and dark themes.
