# Sidebar recent sessions

The sidebar starts with New Chat, keeps app destinations pinned, then gives conversations and projects their own scroll area.

[[src/renderer/src/screens/Layout/Layout.tsx#Layout]] renders a New Chat action before Discover, Office, Kanban, Schedules, and Agents from `PINNED_NAV_ITEMS`; Agents sits directly after Schedules and before the chat history. It then renders [[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] inside a flexible `.sidebar-chat-section`. New Chat is active when the visible Chat view has no session id yet. The standalone `sessions` view is still absent from the `View` union; the full list opens from the Cmd/Ctrl+K menu action.

## Collapse toggle brand mark

The sidebar header's collapse control doubles as the brand mark: collapsed it shows a circular dot that swaps to the expand icon on hover; expanded it shows the full wordmark beside the collapse icon.

[[src/renderer/src/screens/Layout/Layout.tsx#Layout]] renders `.sidebar-collapse-toggle`. Collapsed, it holds a fixed-size `.sidebar-collapse-swap` box stacking a `.sidebar-collapse-mark` circle (filled with `--text-primary`, so white on dark themes and dark on light) over the `PanelLeftOpen` icon; only opacity toggles on hover/focus, so the button never reflows. Expanded, the maskable `.sidebar-logo` wordmark shows next to the `PanelLeftClose` icon.

## Infinite sidebar list

The inline list lazily loads cached sessions in pages as the user scrolls, so the sidebar can expose the full chat history without a fixed inline cap.

[[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] fetches `RECENT_SESSIONS_PAGE_SIZE + 1` rows from the `sessions.json` cache to detect whether another page exists. [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] passes the chat scroll container ref down, and the sidebar loads the next page when that container nears the bottom. The initial sync still refreshes `state.db`, then paints the first page.

Session titles in the inline list are constrained to the sidebar width and truncate with ellipses, while the chat section only scrolls vertically. This keeps long generated titles from creating a horizontal scrollbar.

The native sidebar scrollbar is hidden to avoid layout shifts. [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] measures the chat scroll container and renders an absolutely positioned overlay thumb only while the user is scrolling, so showing or hiding the scrollbar never changes row width.

## Project grouping

Workspace-linked conversations are grouped under project rows so repository chats stay together without hiding ordinary chats.

[[src/main/session-cache.ts#syncSessionCache]] attaches each row's context folder in one batched [[src/main/session-context-folder-store.ts#getSessionContextFolders]] read and persists `contextFolder` into the `sessions.json` cache. [[src/main/session-cache.ts#listCachedSessions]] stays a DB-free cache read — it returns the persisted `contextFolder` without re-querying the store. The sidebar groups rows with a `contextFolder` under a Projects section by folder basename, while rows without one remain under Chats.

When [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] saves a session context folder, it emits a renderer event that [[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] uses to force-refresh the cache. This keeps project grouping visible immediately after a workspace is linked.

Projects and Chats are top-level collapsible sections, and each project folder can also be expanded or collapsed. [[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] persists those disclosure states in `localStorage`; the sidebar CSS keeps section and folder rows on the same left rail, keeps disclosure arrows right-aligned, animates each disclosure with grid-row transitions, and removes hidden rows from keyboard tab order.

## Row context menu

Each sidebar session row exposes a ChatGPT-style options menu — Pin, Rename, Move to project, and Delete — opened from a hover-revealed `…` button or by right-clicking the row.

[[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] renders each row as a `div role="button"` (so the trailing `.sidebar-recent-session-options` button is valid nested markup) and tracks the open row in `menuTarget`. [[src/renderer/src/screens/Layout/SidebarSessionMenu.tsx#SidebarSessionMenu]] renders the menu in a `document.body` portal at clamped viewport coordinates so it escapes the sidebar's clipped scroll container, and closes on outside click, Escape, a scroll of the sidebar list's own `scrollContainer`, or window blur. The scroll listener is scoped to that one container (not a global capture listener) so the chat's streaming auto-scroll — which fires window-level scroll events on every chunk — no longer dismisses the menu mid-stream. "Move to project" swaps the menu to a second in-place page listing every distinct context folder (`projectChoices`) plus **New folder…** ([[src/preload/index.ts]] `selectFolder`) and **Remove from project**, rather than a hover flyout.

Transitions are `motion/react`-driven (the same library as [[src/renderer/src/components/modal/AppModal.tsx#AppModal]]): the whole menu fades/scales/blurs from its top-left anchor on open, and an internal `open` flag plays the exit before the parent unmounts it (`AnimatePresence onExitComplete` → `onClose`). Switching between the main and project pages cross-slides them (direction-aware) inside a `.sidebar-session-menu-body` wrapper whose `layout` prop animates the height difference; the wrapper clips the sliding pages. Viewport clamping measures the offset box, not `getBoundingClientRect`, so an in-flight scale/height animation doesn't skew positioning.

Each action calls an existing desktop API with an optimistic local update and rollback on failure: Rename → `updateSessionTitle` (inline `.sidebar-recent-session-rename` input), Move → [[src/main/session-context-folder-store.ts#setSessionContextFolder]] then a `hermes-session-context-folder-changed` event so other surfaces re-group, Delete → a confirmation dialog (portal overlay) then [[src/main/sessions.ts#deleteSessionRows|deleteSession]]. Deleting the open chat calls `onSessionDeleted`, which [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] uses to drop to a fresh New Chat.

Pinned rows are a desktop-only affordance: their ids live in `localStorage` (`hermes.sidebar.pinnedSessions`), and pinned sessions are pulled out of the normal grouping into a collapsible **Pinned** section at the top of the list.

## Full-list modal

The Cmd/Ctrl+K menu action opens an 80%×80% modal that reuses the existing Sessions screen rather than a separate route.

The modal in [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] renders [[src/renderer/src/screens/Sessions/Sessions.tsx]] inside a `.sessions-modal` over the shared `.models-modal-overlay` backdrop. Resuming a session or starting a new chat from the modal closes it; Esc and a backdrop click also close it. Because the Sessions screen owns its own fetching gated on `visible`, it loads only while the modal is open.

## Profile switch and active chat

The footer profile switcher keeps the selected shell profile aligned with the visible chat run, while preserving older conversations under their original profiles.

[[src/renderer/src/screens/Layout/ProfileSwitcher.tsx#ProfileSwitcher]] persists the selected profile through main-process profile switching, then [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] applies [[src/renderer/src/screens/Layout/chatRuns.ts#selectProfileRunTransition]] before rendering Chat. If the active chat is blank, it is re-homed to the selected profile; if it already belongs to another profile, the shell activates an existing blank run for the selected profile or creates a fresh one. This prevents the footer, Settings, recent sessions, and chat transport from disagreeing about which agent is active.

Opening a sidebar session after switching profiles consumes that blank selected-profile run instead of appending beside it. [[src/renderer/src/screens/Layout/chatRuns.ts#openSessionRunTransition]] replaces the active scratch run when it belongs to the same profile as the resumed session, so the tab strip shows the previous session without an extra "New conversation" tab.

The switcher trigger preserves the old app-brand label for an unrenamed default profile: when `listProfiles` returns the fallback `name === id === "default"`, the button shows `common.appName`; once a custom name is stored, it shows that user-facing name.

The same per-profile appearance also drives the agent avatar inside the transcript. [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] passes `getAppearance(run.profile)` to each [[src/renderer/src/screens/Chat/Chat.tsx]] as `agentAppearance`, which forwards `{ name, color, avatar }` through [[src/renderer/src/screens/Chat/MessageList.tsx]] to every [[src/renderer/src/screens/Chat/MessageRow.tsx#HermesAvatar]] (and the reasoning/tool-activity rows in [[src/renderer/src/screens/Chat/HistoryRow.tsx]]). `HermesAvatar` plays the looping `loadingo.gif` only while a turn is generating (`active`); once generation stops it runs out the current gif loop, then swaps to the agent's [[src/renderer/src/components/common/ProfileAvatar.tsx]] so idle turns are identified by who produced them. The live typing indicator has no resolved agent yet, so it falls back to the gif.

### SSH tunnel profile routing

SSH tunnel chat must retarget the tunnel to the selected profile's port before sending a turn — the dashboard port for dashboard transport, or the api_server port on the gateway-only fallback.

The primary path tunnels to the remote **unified machine dashboard** (see [[main-process#SSH dashboard transport]]): ONE dashboard on a single port serves every profile (scoped via `?profile=`), so [[src/main/ipc/register.ts#getSshDashboardSessionConfig]] / [[src/main/dashboard.ts#sshDashboardConnectionFromConfig]] / the send-message preamble all call [[src/main/ssh-tunnel.ts#ensureSshTunnel]] with that **same** port regardless of profile. This is essential: the single global tunnel can only point at one remote port, so per-profile dashboard ports (an earlier attempt) made concurrent profile queries thrash it. On the gateway-only fallback (no dashboard), the tunnel instead targets the profile's `platforms.api_server.extra.port` via [[src/main/ssh-remote.ts#sshResolveApiServerPort]], which auto-allocates and persists a remote profile port when one is missing. Tunnel starts are serialized by target, and stale SSH process exit/error callbacks cannot clear a newer retargeted tunnel.

### Remote launcher profile resolution

Managed SSH installs can store Hermes outside the SSH user's home or under a different `HERMES_HOME`, so Office/Agents must read profiles from the actual remote runtime rather than a `~/.hermes` filesystem scan.

[[src/main/ssh-remote.ts#buildRemoteHermesCmd]] probes per-user launcher hooks (`$HOME/.config/hermes-desktop/remote-hermes`, `$HOME/.hermes/desktop-remote-hermes`) before the default venv/PATH locations, letting a deployment supply its own wrapper that sets the right command, service user, and `HERMES_HOME`. [[src/main/ssh-remote.ts#sshListProfiles]] detects whether such a launcher actually exists in one round trip, then [[src/main/ssh-remote.ts#selectSshProfiles]] treats a present launcher as authoritative — preferring its profiles over the scan even on an equal count, so a managed `default`-only install shows live gateway state instead of stale home-directory data. Named-profile Schedules route the same way through [[src/main/ssh-remote.ts#sshRunCron]], while the default profile keeps the existing HTTP `/api/jobs` path.

Every SSH-invoked `hermes` command resolves the CLI through `buildRemoteHermesCmd`, never a bare `hermes` — a non-interactive SSH shell does not source the profile that puts the CLI on PATH, so a bare invocation fails with "command not found" on otherwise-healthy remotes. This covers gateway lifecycle ([[src/main/ssh-remote.ts#buildGatewayStartCommand]] / [[src/main/ssh-remote.ts#buildGatewayStopCommand]] non-systemd branch, for both named and default profiles), skills ([[src/main/ssh-remote.ts#sshInstallSkill]], [[src/main/ssh-remote.ts#sshUninstallSkill]], [[src/main/ssh-remote.ts#sshSearchSkills]]), and profile create/delete ([[src/main/ssh-remote.ts#sshCreateProfile]] / [[src/main/ssh-remote.ts#sshDeleteProfile]], which also use the **singular** `profile` subcommand). The systemd branch still prefers `systemctl` when a `hermes.service` unit exists, and [[src/main/ssh-remote.ts#buildGatewayStatusCommand]] remains a pid-file liveness check. The non-systemd branch launches the gateway with `gateway run` (foreground, backgrounded via `nohup`), **not** `gateway start` — `gateway start` drives the systemd/launchd service and fails with "Gateway service is not installed" on a bare VPS that never ran `hermes gateway install`, whereas `gateway run` launches the gateway and its api_server directly and writes the pid file the status/stop commands read.

### Remote-mode skills routing

In remote (HTTP) mode the Skills surface must read and mutate the REMOTE machine's skills — the handlers used to fall through to the local CLI, showing (and installing into!) the wrong machine's skills.

[[src/main/remote-skills.ts]] routes the four skills IPC handlers to the dashboard API when `conn.mode === "remote"`: list via `GET /api/skills`, content via `GET /api/skills/content?name=`, install/uninstall via `POST /api/skills/hub/install|uninstall`. Remote skills are keyed by NAME + PROFILE on the API but the desktop keys content lookups by path alone, so listed skills carry a `remote-skill:<profile>:<name>` marker path ([[src/main/remote-skills.ts#remoteSkillPath]]) that [[src/main/remote-skills.ts#remoteGetSkillContent]] unwraps. The profile MUST ride in the path (mirroring how local/SSH paths carry the full location) — the content IPC has no profile argument, and falling back to the globally active profile would query the wrong profile whenever the Skills screen is scoped to a named one. Named profiles ride as `?profile=` (the unified-dashboard scoping convention); `default` sends no param. All query params go through `URL.searchParams` so encoding stays consistent whether or not a profile param is appended.

Two deliberate asymmetries: bundled skills stay local in remote mode (that list is the shipped catalog, not per-machine state), and the hub install/uninstall endpoints SPAWN the CLI on the remote and return `{ok, pid}` immediately — success means "started", not "completed", unlike the local/SSH paths which await and classify the CLI output.

## Agents page

The Agents page is a catalog-first surface with separate Official Agents and My Agents tabs; legacy Runtime Profile and governance controls remain available under collapsed advanced management.

[[src/renderer/src/screens/Agents/Agents.tsx]] opens [[src/renderer/src/screens/Agents/AgentControlPanel.tsx#AgentControlPanel]] on the Official Agents tab with advanced management collapsed. The toolbar keeps tab selection, search, refresh, and context-appropriate creation together. Official, personal, Workspace, and Organization entries use the same compact card anatomy; search and small status filters change the visible card set without changing the trusted scope.

Opening a card uses [[src/renderer/src/screens/Agents/AgentHubDetailDialog.tsx#AgentHubDetailDialog]] to show capability text, expertise tags, example prompts, and one primary action. Official installation and managed update still use their dedicated confirmation/API paths; a linked installation starts chat through its renderer-safe local Profile id. Personal entries route to the existing draft editor, version install/retry, Profile chat/edit, update, and archive handlers rather than simulated actions.

My Agents contains actual draft, published, pending, or installed control-plane Agents. A bare legacy Runtime Profile no longer prevents the true empty state from appearing. Search misses and status-filter misses use their own recovery hints, so an existing Agent hidden by a query or filter is never reported as an empty catalog and the create action appears only for the genuine empty state. Those Profiles move to the expanded Advanced management list with their real edit, chat, create, and account-sync actions; drafts, immutable versions, installations, experience candidates, and Organization review controls remain in the same collapsed area.

Legacy Profile creation still opens an [[src/renderer/src/components/modal/AppModal.tsx#AppModal]] with a user-facing agent-name field, a "clone config & API keys" toggle, and a source-profile selector defaulting to the active Profile id. Create calls `window.hermesAPI.createProfile(name, cloneFrom)` where `name` is the label and `cloneFrom` is a source id or `null`; the modal remains open on failure. [[src/main/profiles.ts#createProfile]] generates a CLI-safe internal id, stores display metadata, and maps a non-null source to `hermes profile create <id> --clone-from <source>`. Selecting **Start using** still switches by Profile id and starts its gateway before navigation; SSH persistence and gateway startup retain their existing main-process behavior.

The profile modal's inline name editor saves on Enter/blur, but Escape is a real cancel path: it restores the current saved name and suppresses the blur-save that browsers fire as the input unmounts.

## Office profile labels

The Office scene shows each profile's user-facing name while keeping profile ids stable for routing.

[[src/renderer/src/screens/Office/Office.tsx]] loads profiles through `listProfiles()` and maps them with [[src/renderer/src/screens/Office/office3d/agents.ts#profileToOfficeAgent]]. The mapped Office agent keeps `id = profile.id` for selection, CEO persistence, and One Chat routing, but uses `profile.name` as `agent.name`, so the 3D speech bubble, details sidebar, and One Chat labels match the renamed agent. The visible-tab poll uses [[src/renderer/src/screens/Office/office3d/agents.ts#officeAgentsChanged]] so name changes refresh without requiring a manual Office reload.

## Profile detail modal

A single global modal (80vw × 80vh) with a left-section nav views and edits a profile, opened from anywhere via a context hook so future profile features share one surface.

[[src/renderer/src/components/profile/ProfileModalProvider.tsx#ProfileModalProvider]] mounts [[src/renderer/src/components/profile/ProfileModal.tsx#ProfileModal]] at the app root and exposes `openProfile(id, opts)` through [[src/renderer/src/components/profile/ProfileModalContext.ts#useProfileModal]]. The sidebar popover's active profile (a button in [[src/renderer/src/screens/Layout/ProfileSwitcher.tsx#ProfileSwitcher]]) and each profile row's edit control in [[src/renderer/src/screens/Agents/Agents.tsx]] both call `openProfile`, passing `onChanged` to refresh their lists and `onDeleted` to fall back to the default profile when the active one is removed. `opts.initialSection` deep-links to a specific left-nav section on open — the Office tab's bank ATMs use it to jump straight to **Wallet** (see [[office-3d-interiors#Office 3D Interiors#Interactables]]). The header shows the profile avatar and user-facing name; the icon'd left nav (`PROFILE_SECTIONS`) switches the right pane between **Profile** (inline name editing in the identity title, avatar upload/remove, colour, and lucide provider/model/skills/gateway chips), **Persona** (a profile-scoped copy of [[src/renderer/src/screens/Soul/Soul.tsx#Soul]]), **Agent Memory** (a profile-scoped copy of [[src/renderer/src/screens/Memory/MemoryEntries.tsx#MemoryEntries]] loaded through `readMemory(profile.id)`), **Wallet** (a profile-scoped Base wallet pane in [[src/renderer/src/components/profile/ProfileWalletPane.tsx#ProfileWalletPane]]), and **Advanced** (the delete danger zone). Every profile — including default — is editable; only the default profile can't be deleted, so its Advanced pane just says so. The modal self-loads via `listProfiles()` and re-reads after every mutation, replacing the former inline `agents-appearance` modal.

Agent names are desktop metadata in `profile-meta.json`, surfaced as `ProfileInfo.name` from [[src/main/profiles.ts#listProfiles]] and mutated through [[src/main/profile-meta.ts#setProfileName]]. They do not rename the stable profile id or directory, so profile-scoped memory, wallets, sessions, active profile selection, and gateway routing continue to use `profile.id`. If the save IPC rejects, the inline editor remains open, clears its Saving tag, and shows the name-update error instead of trapping the user in a pending state.

Legacy renderer state can still contain a run without a profile id during upgrades. Profile avatars and the active-session strip treat a missing profile as `default`, and profile-name IPC handlers accept omitted names as an empty value, so stale state cannot trip a `.trim()` exception and black-screen the app.

### Profile wallets

Profile wallets are local Base-network Ethereum wallets, capped per profile and kept separate from chat/provider credentials.

[[src/renderer/src/components/profile/ProfileWalletPane.tsx#ProfileWalletPane]] lists public wallet metadata from `listWallets(profile)`, opens a create/import modal, and only displays a recovery phrase in the one-time success state after `createWallet` or `importWallet`. [[src/main/wallet-store.ts#createWallet]] generates a BIP-39 recovery phrase with Node crypto entropy, derives the Ethereum address with `ethers`, and stores public metadata plus an encrypted recovery phrase in `wallets.json` under the profile home. [[src/main/wallet-store.ts#importWallet]] validates an existing recovery phrase, rejects duplicate addresses in the same profile, and uses the same Base wallet metadata shape from [[src/shared/wallets.ts#ProfileWallet]].

### Shared modal shell

Reusable modals use a single animated shell so dialogs open and close consistently.

[[src/renderer/src/components/modal/AppModal.tsx#AppModal]] wraps Radix Dialog with Motion's `AnimatePresence`, keeping focus trapping, escape/outside-close behavior, and exit transitions in one memoized component. The shell keeps its Radix portal present through the exit phase and animates the backdrop plus content with visible fade, scale, slide, and blur. Profile modal is the first consumer: [[src/renderer/src/components/profile/ProfileModalProvider.tsx#ProfileModalProvider]] keeps its target profile mounted until `AppModal` finishes the close animation, then clears the modal state.

## Account menu and settings entry

The sidebar footer keeps one account trigger, while administrative configuration lives inside Settings instead of a parallel icon rail.

[[src/renderer/src/screens/Layout/Layout.tsx#Layout]] keeps Providers, Gateway, Tools, and Memory out of both the main sidebar list and the footer. The footer now renders only [[src/renderer/src/components/AgenteraAccountMenu.tsx]], whose popover retains Manage account, Manage devices, Recharge model API, Switch account, and Sign out while adding **Settings** between Switch account and the divider before Sign out. Layout passes the active profile when that action opens the global settings page.

When the sidebar is collapsed, the account avatar remains anchored at the bottom of the 64px rail. Its menu opens to the right at full width, so removing the standalone gear does not make Settings unreachable.

## Settings page

A single responsive full-window page with a grouped left nav presents app settings plus provider, gateway, tool, and memory configuration.

[[src/renderer/src/components/settings/SettingsModalProvider.tsx#SettingsModalProvider]] mounts [[src/renderer/src/components/settings/SettingsModal.tsx]] at the app root (inside `ProfileModalProvider`) and exposes `openSettings(section?, { profile })` through [[src/renderer/src/components/settings/SettingsModalContext.ts#useSettingsModal]]. Three entry points call it: the AgentEra account menu, the `/settings` command, and a global **Cmd/Ctrl+,** keydown handler in [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] — each passes the active profile so the page reads/writes the right config. While Settings is open the main surface remains mounted but is removed from layout, preserving chats and navigation state. Settings fills the application window, has no modal backdrop or close icon, and returns through the top-left **Back** action (or Escape).

The left nav is two labelled groups — **General** (AgentEra Account, Appearance, Language, Privacy, Connection, Data) and **AgentEra Studio** (Providers, Gateway, Tools, Memory, About & Updates, Logs & Diagnostics) — and `SETTINGS_NAV`/`resolveSection` in [[src/renderer/src/components/settings/SettingsModal.tsx]] map ids to panes. The four feature panes preserve their existing profile scope and stay mounted after first visit so tab-local edit state is not discarded. Pure HTTP remote mode keeps the existing unavailable notices for Providers, Gateway, and Memory; Tools retains its supported remote subset. Its Browse Skills/MCP actions close Settings and focus the matching Discover catalog through `navigation:focus-discover`.

Network settings (Force IPv4 + proxy) are not a separate tab: they apply to every outgoing connection, so they live as a `Network` subsection at the bottom of [[src/renderer/src/components/settings/ConnectionPane.tsx]], and `resolveSection` aliases the legacy `/settings network` argument to the Connection pane. All shared state, the config-load effect, and the mutation handlers live in [[src/renderer/src/components/settings/useSettingsData.ts#useSettingsData]] (relocated wholesale from the former `Settings` screen) and reach each pane through [[src/renderer/src/components/settings/SettingsDataContext.ts#useSettings]], so the panes (`AppearancePane`, `ConnectionPane`, `AboutPane`, …) stay purely presentational. One exception: `AppearancePane`'s hardware-acceleration field reads `getGpuStatus` from the preload bridge directly, because GPU state is per-launch main-process state rather than profile config (see [[main-process#GPU Fallback#User preference]]). The page chrome is `user-select: none` (drag-selection highlighting nav labels and field captions read as broken UI); form fields and `pre`/`code` output — notably the Logs pane — opt back into text selection so they stay copyable.

The About pane renders the managed Runtime lifecycle through [[src/renderer/src/components/settings/RuntimeDistributionCard.tsx#RuntimeDistributionCard]] and keeps the AgentEra Studio app updater as a separate card. Runtime metadata checks are automatic only after online product authentication; archive download is always a confirmed user action, and the existing diagnosis/debug tools remain independent of the update controls.

## Provisional fresh sessions

Fresh chat session ids are provisional until a turn produces output or completes successfully, so provider errors do not create visible recent-session rows.

The main-process transports still send a generated `X-Hermes-Session-Id` on fresh requests to avoid gateway fingerprint collisions, but [[src/main/hermes.ts#sendMessageViaApi]] and the runs transport announce that id to the renderer only after visible output, tool/reasoning activity, or successful completion. Resumed sessions are announced immediately because the renderer already knows they are existing conversations. This keeps [[src/renderer/src/screens/Chat/hooks/useChatIPC.ts#useChatIPC]] from binding a failed first turn to a new sidebar entry.
