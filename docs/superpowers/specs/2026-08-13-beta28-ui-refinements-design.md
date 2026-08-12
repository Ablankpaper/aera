# Beta.28 UI Refinements Design

**Status:** Approved in conversation on 2026-08-13; awaiting written-spec review

**Desktop base:** `origin/main` at `1c469844b36fe8375ee3e784a74912283e24be39`

**Implementation branch:** `aera/beta28-image-generation`

## Goal

Polish three bounded Desktop surfaces before Beta.28 packaging: make the image-generation configuration collapsible, show user-facing Agent names in conversation headers, and hide the Workspace entry from the sidebar without deleting its implementation.

This work remains inside the independent Aera Desktop repository. It does not modify Runtime, Cloud, Admin, API, the public site, or either separately active user task. It does not authorize packaging, version changes, pushing, merging, deployment, or release.

## Image-Generation Configuration Collapse

The existing image-generation configuration card remains expanded when first mounted. Its heading becomes a dedicated disclosure button containing the title and directional arrow. The enabled switch stays a separate control at the right side of the same header and never toggles disclosure.

The disclosure button supports pointer activation, Enter, and Space through native button behavior. It exposes `aria-expanded` and an accessible name. The arrow points down while expanded and right while collapsed.

Collapsing hides the configuration body, including its subtitle, fields, status, actions, confirmation prompt, and preview. It does not unmount or reset the component state, clear unsaved input, cancel or start a provider request, save data, or change the enabled switch. Re-expanding shows the same unsaved values and current status. Disclosure state is local to the mounted card, is not persisted, and resets to expanded after the card is remounted.

Loading and remote-mode rendering keep their existing safety behavior. Remote mode may use the same disclosure header, but collapsing must never make the unsupported-state message look like a successfully editable configuration.

## Conversation Agent Display Name

Conversation routing continues to use the stable Profile ID. The header display follows these exact rules:

1. Profile ID `default` always renders the literal `default`, even if default Profile metadata contains another name.
2. A non-default Profile with a non-empty metadata display name renders that trimmed user-facing name, for example “智能短视频分析”.
3. A non-default Profile whose name is absent, unreadable, or only whitespace renders the localized fallback “未命名智能体”.
4. A UUID, numbered identifier, internal Profile ID, directory name, or Runtime Profile ID is never used as the non-default display fallback.

`listProfiles()` will expose a nullable display-name field that preserves the distinction between real metadata and the existing compatibility `name` fallback. Existing consumers may retain `name`; the conversation header consumes the explicit display name.

`Layout` keeps the display value beside the existing Profile appearance data and passes it to `Chat` without changing the Profile ID used by sessions, permissions, RuntimeBinding selection, or IPC. `Layout` also subscribes to the existing Agent identity-change event and updates the matching appearance entry, so a successful rename refreshes every mounted conversation header without restarting the application. Failed or unrelated identity events leave the existing display intact.

The localized unnamed fallback is owned by the chat locale. All supported locale modules receive the required key so locale-shape validation stays complete; Simplified Chinese renders “未命名智能体”.

## Hide the Workspace Sidebar Entry

The visible pinned sidebar no longer renders the `office` item whose Simplified Chinese label is “工作区”. This is a presentation-only disablement.

The implementation retains:

- the `office` member of the `View` type;
- the `Office` import, component, and view-rendering branch;
- Workspace dialogs, switcher actions, routing state, persisted data, IPC, services, and permissions;
- the `navigation.office` locale keys and Office feature code.

The navigation list keeps the remaining order: Discover, Kanban, Schedules, and Agents. No stored state or Workspace data is migrated or deleted. Restoring the menu later requires only re-enabling the retained navigation descriptor rather than reconstructing the feature.

If an existing internal state opens the Office view, the renderer may continue to show it; this change only removes the ordinary sidebar entry point.

## Error and State Behavior

- Disclosure never masks an in-flight result by resetting form or request state; reopening exposes the resulting status.
- The enabled switch remains independently operable while the body is collapsed, subject to its existing busy-state rules.
- A missing non-default display name is a normal fallback state, not a renderer error.
- Identity-event payloads update display metadata only; stable identity and active session ownership never change.
- Hiding the Workspace menu performs no destructive operation and produces no data cleanup.

## Test Design

Focused tests will cover only the changed boundaries.

### Image-generation card

- it is expanded by default and reports `aria-expanded=true`;
- activating the title-and-arrow button collapses and re-expands the body;
- keyboard activation works through native button semantics;
- unsaved field values survive collapse and re-expansion;
- the enabled switch changes only enablement and does not change disclosure;
- the arrow state follows disclosure;
- the existing remote-mode and busy-state safeguards remain intact.

### Conversation header

- the default Profile renders `default` regardless of metadata name;
- a named non-default Profile renders its trimmed metadata display name;
- an unnamed non-default Profile renders the localized unnamed fallback and never its ID;
- `listProfiles()` preserves a nullable metadata display name while keeping the compatibility name field;
- an Agent identity-change event refreshes the corresponding mounted header without changing Profile routing.

### Sidebar

- the visible pinned navigation list excludes `office` and retains the expected order of all other entries;
- the `office` view and rendering capability remain present, proving that only its menu entry is disabled;
- Simplified Chinese may retain `navigation.office = "工作区"` for future restoration.

## Verification

Implementation is complete only after:

1. focused Vitest suites for Profile listing, conversation boundary, Layout navigation and identity refresh, and image-generation configuration;
2. Node and web TypeScript checks;
3. affected formatting or lint checks;
4. required `lat.md` behavior updates and `lat check`;
5. an isolated Electron journey with temporary `userData` and `HERMES_HOME`, using the repository fixture rather than a paid image provider, proving disclosure behavior, readable Agent naming, and the hidden Workspace menu.

The in-app Browser controls browser tabs rather than the standalone Electron process, so the repository's existing Playwright Electron harness is the correct rendered-validation path. The journey must not read or modify the daily app Profile, credentials, sessions, or Runtime data, and must terminate only processes it started.

## Non-goals and Release Boundary

This change does not:

- redesign the full Tools page or navigation system;
- persist disclosure state;
- alter image-generation provider behavior, credentials, defaults, or paid-test semantics;
- rename any stable Profile, Runtime Profile, Agent installation, session, route, or directory;
- delete or disable the Workspace page, Workspace management, underlying data, or service APIs;
- call a real paid image-generation API during validation;
- package, change the application version, push, merge, deploy, or publish Beta.28.

Packaging and every later release action remain separate user decisions after the other requested Beta.28 work is complete.
