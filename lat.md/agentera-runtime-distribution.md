# AgentEra Runtime distribution

AgentEra Studio ships a signed, platform-specific Runtime seed so first launch works without GitHub while Hermes Profile data and self-learning remain isolated.

## Distribution boundary

The public `Ablankpaper/aera-runtime` repository produces versioned Runtime artifacts, while the desktop validates, packages, installs, updates, and rolls them back.

The cloud account service does not distribute Runtime binaries or expose GitHub credentials. Desktop application updates remain a separate channel described by [[desktop-updates|Desktop Updates]].

## Runtime seed

A seed contains runnable Python, locked core dependencies, AgentEra Runtime, CLI, Dashboard assets, base tools, a manifest, and an Ed25519 signature.

The seed excludes Git history, tests, caches, credentials, Profiles, Memory, sessions, Chromium, speech models, and local model weights. macOS ARM64 and Windows x64 are the first supported seed targets.

The source-controlled staging directory may retain its regular-file `.gitkeep` sentinel. Runtime preparation and final-package verification ignore only that exact sentinel; every other extra entry still fails closed.

## Offline first installation

After product authentication, the main process verifies the packaged seed, installs it into a versioned application-data directory, and atomically selects it without network access.

When the local Runtime is missing, [[src/renderer/src/App.tsx#App]] routes straight to [[src/renderer/src/screens/Install/Install.tsx#Install]]. Preparation starts once per attempt, does not restart on locale or callback rerenders, and successful activation continues automatically into Profile ownership and setup; no welcome, source selection, path selection, prepare, cancel, or continue action is shown.

A missing or invalid seed enters a repair state. Only then may the desktop show bounded repair guidance. It never falls back to cloning upstream `main`, executing a remote install script, choosing an external Runtime, or downloading an unsigned Runtime.

## Offline Seed installation and repair

Packaged Seed installation is verified, transactional, local-only, and isolated from Hermes-owned adaptive state.

[[src/main/agentera-runtime-distribution/extractor.ts#extractRuntimeArchive]] accepts only the signed platform format: TAR/Zstandard for macOS ARM64 and ZIP for Windows x64. Archive paths, normalized metadata, case-folded Windows duplicates, symlink targets, entry types, modes, sizes, and the decompression budget are checked against the signed inventory before a version can be published. Runtime ZIP members are pre-scanned without writing. In packaged Windows Electron, the external credential-free validator reads exactly the signed `archive_size` through a bounded sequence of native file-handle reads and parses it with yauzl's buffer reader; development and non-packaged paths retain the `original-fs` random-access reader. The packaged native extractor then writes the validated archive into a fresh transaction with a bounded worker pool. Windows extraction temporarily disables Electron ASAR interception and always restores the prior setting. The packaged Windows app runs the final external staging-tree inventory verifier through the same Aera executable in `ELECTRON_RUN_AS_NODE` mode, with a generated helper outside `app.asar`, a one-use request file, and a credential-free environment; the helper uses native Node filesystem calls, `Dirent` entry kinds to avoid redundant per-entry stats, one bounded `readFile` for entries no larger than 256 KiB, positional file-handle reads for larger entries, and a bounded 32-file hash pool. This avoids Electron main-process filesystem interception and excessive per-entry handle round trips while preserving the same path, size, symlink, byte-budget, and SHA-256 checks. The fresh staging tree is walked exactly once without following links; every file is re-hashed in bounded batches and compared path-for-path with the manifest. POSIX hosts normalize and recheck non-Windows filesystem modes; Windows hosts skip that unrepresentable post-extraction check while retaining the signed archive-mode validation.

Extraction occurs only below a fresh `userData/runtime/staging/seed-*` transaction. Failure or cancellation deletes the destination owned by that transaction; it cannot clean another staging child, a current version, or `HERMES_HOME`.

[[src/main/agentera-runtime-distribution/seed-installer.ts#installPackagedSeed]] discovers exactly one packaged archive, canonical manifest, and signature, verifies them with the production trust set, and checks free space for archive bytes plus extracted bytes plus one rollback-version reserve plus a ten-percent margin. It health-checks the candidate in staging, stores the verified manifest and signature as managed sidecars, renames the verified payload into `versions`, writes `current.json` atomically, selects managed mode, and refreshes the live invocation. The sidecars let every later startup re-hash the full signed inventory before selecting that managed version.

The welcome installer and Runtime distribution manager may remain alive in the same main process. After a packaged Seed install atomically replaces `current.json`, the manager compares the exact current pointer with the one it observed at startup, discards any stale update offer, and republishes journal-derived state before activation is reported. A same-version repair directory is also detected, and that launch remains offline-only until the next startup restores normal update checks.

[[src/main/agentera-runtime-distribution/health.ts#runIsolatedRuntimeHealthCheck]] runs version, server-help, and core-import probes with Python isolation plus `-B`, a disposable fake HOME and HERMES_HOME, an allowlisted environment, no inherited credentials, and offline package-manager flags. Disabling bytecode writes keeps the verified signed inventory immutable even when Python's isolated mode ignores environment configuration. A corrupt same-version current Runtime is repaired into a new version directory, leaving the old directory and every Hermes-owned Profile, Memory, session, learned Skill, and Curator file untouched.

The authenticated `start-install` IPC path is invoked automatically and calls only the packaged Seed installer. Missing or corrupt packaged resources return `repair-required` with reinstall-desktop guidance; low disk returns a retryable free-space action. No remote shell or PowerShell installer is shipped as a first-install fallback.

## Version state journal

Mutable Runtime versions and current, previous, and candidate pointers live only below Electron `userData/runtime`. Each pointer update fsyncs a temp file, renames it atomically, then fsyncs the parent directory where supported.

Recovery removes only pointer temp files and stale transactions proven to be under Runtime staging or downloads. Version cleanup keeps every referenced directory and rejects lexical or real-path escape, including parent symlinks.

Startup recovery reads current, previous, and candidate pointers independently. A malformed or missing-directory pointer is removed without exposing its contents, while an operational file-read failure stops recovery without deleting a pointer that could not be validated. A valid previous Runtime becomes current when the current pointer or required program layout is unusable. If neither is usable, startup continues into the packaged-Seed repair state rather than selecting an online or system Runtime.

## Program and Profile isolation

Runtime program versions live below Electron `userData`, while Hermes-owned state remains in its physically isolated `HERMES_HOME`.

Installation, update, rollback, and cleanup never overwrite or traverse private Memory, USER data, sessions, learned Skills, Curator state, credentials, Gateway state, Cron state, logs, or workspace files. This is governed by [[agentera-self-evolution|AgentEra self-evolution compatibility]].

## Live Runtime invocation

Every local Runtime operation resolves the currently selected managed or explicit external installation at call time through one main-process abstraction.

[[src/main/agentera-runtime-distribution/invocation.ts#getRuntimeInvocation]] returns one immutable invocation snapshot containing the interpreter, working directory, bundled Skills, Dashboard assets, module CLI builder, and environment builder. A spawn uses that same snapshot throughout so a concurrent version switch cannot mix files from two Runtime versions.

Both managed and external modes launch `python -m hermes_cli.main`. Managed mode points into the installed seed, removes inherited `PYTHONHOME` and `PYTHONPATH`, and forces `PYTHONNOUSERSITE=1` plus `PYTHONDONTWRITEBYTECODE=1` so ordinary Runtime calls cannot mutate the signed program tree; explicit external mode keeps the existing `HERMES_HOME/hermes-agent` compatibility layout.

Callers continue to supply the existing physical `HERMES_HOME` or Profile home. Runtime selection never redirects, migrates, copies, or deletes Memory, Profiles, sessions, learned Skills, credentials, or other adaptive state. Missing or stale selections return a bounded "Runtime is not prepared" result instead of invoking a fallback executable.

Chat and Gateway, Dashboard, Skills, Profiles, Cron, model discovery, MCP, account authentication, Kanban, compatibility probing, and startup preflight all consume the live invocation rather than module-level executable paths. [[src/main/agentera-runtime-distribution/invocation.ts#refreshRuntimeInvocation]] re-resolves the selection after seed installation or activation.

## Desktop TUI backend lifecycle

Desktop owns every local headless TUI backend independently from the ordinary Gateway ownership ledger. Warm-up happens only on demand or after the owning Profile's Gateway is readiness-gated serving.

A TUI backend never cold-starts concurrently with a primary Gateway launch: both share the Runtime's Python interpreter, and a dual cold start (first Windows launch under Defender scan) starves the primary Gateway before it can write its pid file or bind its port. A Profile switch warms nothing.

### Runtime 0.20 headless contract

The Desktop TUI transport launches Runtime through `hermes serve` with `HERMES_DESKTOP=1`, retaining per-Profile state and JSON-RPC/WebSocket support without machine-dashboard routing or a browser SPA.

### Exact process-tree shutdown

Desktop starts each POSIX TUI child as a dedicated process-group leader and records that exact PGID. The shared Electron process group is never signalled.

Shutdown targets only that dedicated group. Windows instead captures the exact root and child tree with invariant UTC file-time identities, using bounded root/parent CIM filters rather than enumerating the machine process table. No path selects processes by name, port, Profile label, command line, or environment.

Windows initial ownership capture shares one six-second deadline across the primary CIM query and one explicit WMI fallback. The cold-start-sensitive CIM attempt may consume at most one third of that deadline, preserving the remaining budget for WMI on loaded hosts. Every returned row must have valid PID/parent fields and an invariant creation identity; timeout, unavailable, malformed, empty, or partial output remains fail-closed. Optional hosted-runner diagnostics contain only the phase, attempt, elapsed time, outcome, sanitized Profile key, and root PID. A daemon listener represented only by its verified pid uses the same snapshot, identity, graceful-tree, and force-escalation path through [[src/main/process-tree.ts#terminateProcessTreeByPid]]; it is never cast to an already-exited synthetic child.

### Bounded force escalation

SIGTERM receives a fixed grace window. A still-live owned group or verified Windows tree is force-stopped only after that window; missing or changed ownership evidence fails closed.

POSIX force targets only the same dedicated PGID, including when its leader already exited. Windows refreshes invariant process identities before escalation. Query timeout, parse failure, or identity mismatch never falls back to a positive PID kill.

Windows uses an exact-root tree kill while the root remains alive and individually terminates captured descendants when the root exits before escalation. After force, it condition-polls the captured tree for up to three seconds, then refreshes the creation identity of every still-live PID that was actually forced so an immediately reused PID is not mistaken for the terminated process. An unavailable final snapshot or creation identity, or any still-matching forced identity, remains a fail-closed cleanup error; an unforced PID is never cleared by this final reuse check.

### Port reuse across restarts

Desktop closes per-Profile pooled Gateway connections before signalling shutdown, so a restart can rebind the same port immediately without interrupting another Profile. Bindability is probed only as an advisory hint and never blocks a launch.

Desktop talks to a local Gateway over keep-alive sockets. If those sockets are still established when the Gateway exits, the Gateway is the peer that closes first and the kernel parks a `TIME_WAIT` on _its_ listening port; the port then rejects `bind()` for the full MSL window, which outlasts any practical restart deadline. Closing from the Desktop side first moves that `TIME_WAIT` onto an ephemeral client port, where it costs nothing. The health, capability, run, probe, and chat requests use the Profile's dedicated loopback agents; `stopGateway` and the app-shutdown process-tree path drain that Profile's agents while the listener is still up, ahead of every Gateway termination signal.

Runtime treats `EADDRINUSE` as fatal and never retries the bind itself, so a doomed spawn cannot recover in place. Desktop still refuses to gate a launch on a pre-bind probe: a strict gate turns a transient `TIME_WAIT` into a hard startup stall. The probe only reports an already-healthy Gateway worth adopting, and a spawn otherwise proceeds and surfaces the real bind result.

Recovery both reconciles the port and spawns, so one call site never spawns ahead of it. A plain launch followed by a recovery launch makes recovery observe the process it just created as running-but-not-yet-healthy and restart it, and the replacement then races the dying Gateway for the same port — the identical collision, from a single request.

### Cancelled startup cannot outlive Desktop

Every asynchronous TUI or local Dashboard start belongs to one generation. Stop invalidates that generation before releasing ownership, so no old continuation can publish a late process.

The guarded boundaries include port selection, Gateway recovery, HTTP readiness, and WebSocket setup. Each stop waits a bounded three seconds for the startup continuation, then performs one exact late-child pass; a third-party readiness promise that never settles therefore cannot make Electron cleanup unbounded.

### Gateway readiness evidence

Readiness-gated launch holds its answer until the listener's verified `gateway.pid` exists and the authenticated `/v1/capabilities` route answers on the prepared port.

A spawned Gateway process is never reported as serving on process identity alone. [[src/main/hermes.ts#startGatewayWithReadiness]], used by the `start-gateway` IPC, requires the daemonized listener's `gateway.pid` to parse, to differ from the pre-launch stale pid, and to resolve to a live Python process, plus the Bearer-protected `/v1/capabilities` route to answer with the launch's prepared credential. Both the listener probe and the launch-wrapper evidence capture use bounded asynchronous PowerShell/CIM commands; no process-table query synchronously blocks Electron's main loop. A timeout remains an evidence miss and readiness stays fail-closed until a later complete identity/image read succeeds. When Windows runs the Gateway in the foreground and `gateway.pid` names the same PID as the launch wrapper, that later listener proof is reused for the wrapper only after strict same-PID equality, so the same process can be cleaned up without weakening cross-PID ownership checks. The dashboard backend warms only after that proof, never concurrently with a cold-starting primary Gateway, and the local Dashboard spawn path joins the same readiness gate before it launches its own Runtime Python process.

A readiness timeout terminates what the launch actually left behind: the wrapper child while it lives, and the verified listener pid from `gateway.pid` once the short-lived wrapper has exited — both with the same bounded force escalation as ordinary shutdown. Durable ownership transfers atomically from the exact recorded wrapper PID to a fresh, live Python listener PID that differs from the pre-launch snapshot, with separate identity/image proof for a cross-PID hand-off; a changed pid file while that wrapper remains live is an unverified replacement and is never adopted or signalled. A same-PID Windows foreground launch uses the listener proof for the tracked wrapper only after strict PID equality and a fresh identity/image re-read. App shutdown uses the PID-only tree terminator for an adopted cross-PID listener and the identity-bound child terminator for a same-PID listener. A Gateway the call did not spawn is reported, never killed. The result carries the listener PID (not the short-lived wrapper's), the launch command, the wrapper's exit code or signal when it died, a bounded stderr tail, and the parsed capabilities document as evidence. Feature flags remain evidence for the caller's acceptance check and never gate readiness, so an older Runtime still counts as serving. Regression fixtures that launch a real child use a separate bounded scheduler allowance (the queued-restart fixture allows 1s on every platform) to publish `gateway.pid`; this does not change the production readiness deadline. Diagnostic-only Windows wrapper CPU sampling is single-flight and asynchronous: each readiness poll records the last value plus a path-free sample state/error, and a slow or failed PowerShell query cannot extend the production readiness deadline.

#### Managed Gateway diagnostic

The workflow-dispatch Windows diagnostic reproduces the packaged Desktop managed Gateway boundary and stops at the first unresolved import or initialization phase.

The diagnostic's six bounded phases use the same packaged Python, managed site-packages working directory, optional Profile selector, and one diagnostic-only `-X importtime` flag. The final phase is the exact `python -m hermes_cli.main gateway` dispatch; `gateway-stacktrace` is appended only after its readiness timeout and enables bounded `faulthandler` output.

The managed environment follows [[src/main/hermes.ts#buildGatewayEnv]] while replacing only the physical home and API-server key/port with disposable values. Process evidence retries only empty, timeout, query-error, or invalid-JSON Windows queries; a complete PID, creation identity, image, executable path, and command line remains required, and an identity mismatch is terminal. The diagnostic retains wrapper/listener evidence, every `gateway.pid` transition, authenticated capabilities results, import-time and faulthandler tails, cleanup attempts, and residual PIDs. A live or unverified process keeps its sandbox, so `EBUSY` cannot erase the first-failure evidence.

The packaged Electron acceptance adds an external observer in the Playwright process. During Runtime installation it samples only the same Profile's stage files and lock candidates; it does not start a Windows process-table/CIM query while extraction, inventory, or hashing is active. Gateway-launch observation may query the installed Runtime's Python processes through a bounded CIM command and records parent PID, creation identity, executable image, command shape, CPU counters, thread count, and working set independently of the Electron main loop. If installation fails, the failure snapshot may take one bounded final process sample after the install boundary has returned. Failure artifacts include the bounded Profile inventory, known Runtime log tails, and a redacted full readiness stderr capture; the observer is diagnostic-only and never changes the launch deadline, inventory behavior, or ownership decisions.

#### Managed Gateway diagnostic test specifications

Focused Node tests lock the managed invocation contract and the fail-closed evidence boundary used before any new packaged candidate is attempted.

##### Invocation and phase boundaries

The diagnostic environment keeps fake home/API-server inputs and excludes inherited Python roots, CI markers, credentials, and probe-only overrides.

The bind host lives in the materialized `config.yaml`, never in the spawn environment, and the managed PATH prepends only the selected interpreter directory. Phase argv and the single timeout stacktrace branch match Desktop dispatch, with an optional `--profile` selector placed before the gateway command.

##### Evidence and fail-closed cleanup

Evidence retries only transient provider misses within a bounded attempt count; valid evidence returns without retry. Readiness requires a verified listener plus authenticated capabilities.

Cleanup terminates only identity-verified wrapper/listener PIDs and never signals a pre-launch stale PID, even while alive.

It preserves PID transitions, identity mismatches, import-time and faulthandler tails, and live residue; a sandbox with residual PIDs is retained and reports its reason, so `EBUSY` cannot erase the first-failure evidence.

The phase summary retains wrapper/listener evidence, pid-file transitions, capabilities, tails, cleanup attempts, and sandbox outcome for the emitted artifact. Packaged acceptance additionally emits `gateway-profile-snapshot.json`, bounded Runtime log-tail files, `electron-stderr-full.log`, and external process samples so a pre-`gateway.pid` stall can be attributed to a concrete initialization stage rather than inferred from a missing PID.

Dashboard startup is fail-closed: if the shared primary-Gateway recovery returns false, it returns `running:false` before allocating a Dashboard token or port and before spawning another Runtime Python process.

Local `gateway-status` answers from an authenticated readiness probe instead of process liveness, and the Gateway screen consumes `ready`, so neither surface can present a cold-starting process as a running Gateway. SSH start, restart, and status resolve the selected Profile's api-server port and require the remote `/health` probe; PID/systemd liveness is necessary but never sufficient, and the zero-retry status path still performs exactly one API probe.

`set-active-profile` propagates Gateway readiness instead of unconditionally returning success. A live local process enters bounded recovery, a stopped local Profile uses the pid-plus-authenticated-API launch gate, and an SSH Profile waits for its resolved remote API; any false readiness result returns false to the caller.

### Pool-wide App shutdown

Pool shutdown closes TUI and local Dashboard admission before it awaits every mapped, pending-start, or already-stopping client.

App quit closes both admissions permanently; ordinary Runtime cleanup reopens them only after a clean drain. A same-Profile Dashboard restart outside pool shutdown serializes behind its exact stop, while a start racing pool shutdown returns `running:false` and cannot create a replacement after the cleanup barrier reports success.

Failed clients retain their exact child ownership and a non-secret failure marker for a later bounded retry. This includes a process spawned by a Dashboard start whose readiness or WebSocket probe failed but whose tree could not be fully terminated. Concurrent cleanup requests serialize, attempt all exact clients with `allSettled`, and propagate any remaining process or termination error instead of reporting a clean drain.

### Awaited Electron quit barrier

The first quit request pauses Electron and retries only after bounded Runtime cleanup succeeds. Cleanup awaits the TUI pool and every Aera-owned ordinary Gateway process tree.

Dashboard, TUI, ordinary Gateway, SSH transport, and database cleanup are observed concurrently after Runtime activity drains. One branch rejecting cannot prevent the remaining branches from running; the barrier aggregates their results and fails closed when any exact ownership remains.

Repeated in-flight requests reuse one cleanup; unresolved ownership or termination keeps Electron open and a later explicit quit may retry.

## Explicit external compatibility

External Runtime use is retained only as a legacy persisted compatibility mode for existing developer installations; packaged managed mode is the only first-install product path.

[[src/main/agentera-runtime-distribution/selection-store.ts#readRuntimeSelection]] migrates only the exact legacy `{ hermesHome }` record to external mode. New product installations do not expose that selection in startup UI. Existing records retain an exact schema, selection mode, and physical Hermes home; compatibility never moves, rewrites, or deletes the external checkout or its adaptive data.

[[src/main/installer.ts#runHermesUpdate]] rejects managed mode and, in explicit external mode, invokes only the selected checkout's interpreter with `python -m hermes_cli.main update` from that checkout. The Settings card labels this path unmanaged and offers a separate switch to the signed managed Runtime. The welcome and repair surfaces no longer expose upstream `curl`, PowerShell, Git clone, or remote-script commands.

## Update policy

The desktop checks for stable Runtime updates automatically but downloads only after explicit user confirmation and switches only after the user restarts.

Downloads are resumable and must pass repository, platform, architecture, compatibility, Ed25519 signature, and SHA-256 checks. A candidate is staged outside the current Runtime and failed health checks restore the previous version.

[[src/main/agentera-runtime-distribution/update-client.ts#checkStableRuntimeUpdate]] obtains only the reviewed stable index, its signature, and the selected target's manifest and signature. The configured Aera Cloud origin's exact `/runtime-updates/stable/` route is the primary transport, with the public GitHub stable channel retained as a fallback only when the complete primary-source attempt has a transport failure. A signature, schema, URL, or cross-check failure is terminal and never triggers source fallback; metadata from two sources is never mixed. The client verifies both signed layers against the production trust set, cross-checks repository, full commit, version, target, names, and archive hash, and returns an offer without requesting archive bytes. Older, equal, or desktop-incompatible versions produce no offer; failure of every available transport leaves the current Runtime usable with a bounded public error code.

Logical update URLs are restricted to either the configured HTTPS Aera origin's exact stable metadata and immutable `releases/<tag>/<asset>` paths or the public `Ablankpaper/aera-runtime` GitHub stable-index redirect and immutable release-asset paths. Loopback HTTP remains available only for isolated development. Redirect hostnames are transport only: signatures and hashes remain the trust boundary, and no GitHub token is stored or exposed by the desktop. Main-process diagnostics record only the source, bounded request/verification stage, and stable failure class; they never include redirect URLs, response bodies, local paths, credentials, or raw exceptions.

Runtime metadata and archive traffic use Electron's Chromium network stack so the updater honors the operating system's proxy configuration. First-party metadata is requested directly; GitHub fallback metadata follows the reviewed redirect inside Chromium. Before an archive stream starts, [[src/main/agentera-runtime-distribution/electron-transport.ts#createElectronRuntimeDownloadUrlResolver]] uses `net.request` to validate every redirect synchronously, enforce the redirect limit and HTTPS anti-downgrade rule, and resolve the final transport URL; [[src/main/agentera-runtime-distribution/downloader.ts#downloadWithResume]] then streams that exact URL through `net.fetch` with further redirects disabled. The final signed manifest, expected size, and SHA-256 remain authoritative even when GitHub's transport hostname changes.

[[src/main/agentera-runtime-distribution/downloader.ts#downloadWithResume]] writes only to a destination `.part` plus `.part.json` below the caller-owned Runtime downloads directory. Resume requires the same URL, expected size, expected SHA-256, unexpired metadata, exact local byte count, valid `Content-Range`, and matching ETag and Last-Modified validators when present. A server that ignores Range safely restarts from byte zero.

Connect, idle-read, overall, and redirect limits are bounded. Cancellation and transport interruption retain a verified-length partial for retry; stale or mismatched metadata and completed wrong-size or wrong-hash bytes are deleted. Only a complete streaming SHA-256 match is atomically renamed to the requested destination.

The cancellation regression aborts only after observed download progress, proving resumable partial retention without depending on operating-system scheduler timing.

[[src/main/agentera-runtime-distribution/manager.ts#createRuntimeDistributionManager]] is the only archive-download entrypoint. After explicit confirmation it independently re-verifies the downloaded artifact, extracts into a fresh Runtime-owned transaction, adds the signed manifest sidecars, publishes a version directory, and writes a non-active candidate pointer. Cancellation or any verification/extraction failure leaves `current.json` unchanged. [[src/main/runtime-activity.ts#RuntimeActivityCoordinator]] reserves each chat before gateway or transport setup begins and atomically excludes new runs once a Runtime transition is reserved; stale completion callbacks cannot remove a replacement run with the same ID. Restart is refused while a task is active; otherwise the transition reservation is acquired before Runtime-owned processes stop, the candidate is marked for next-launch activation, and the app requests relaunch. A failed restart preparation releases the reservation without changing the running Runtime.

[[src/main/app/start.ts#startMainProcess]] creates the lifecycle manager from the same trust and target context as startup bootstrap. Once the authenticated online main window is available it performs a non-blocking metadata-only check once per signed-in user; offline sessions do not check. Failed candidates are discarded before returning to a healthy current version, while a missing Runtime can be repaired only through the signed packaged Seed installer.

The launch that installs or repairs from the exact packaged Seed does not immediately contact the public stable channel. The manager marks that in-memory state as not checkable for the remainder of the launch; a later app launch reconstructs the journal with normal stable-update checks enabled. This keeps first installation local-only without permanently disabling reviewed updates.

[[src/shared/agentera-runtime-distribution.ts#serializeRuntimeDistributionPublicState]] rebuilds every renderer-visible lifecycle state from an exact field allowlist and accepts only bounded Runtime error codes. The authenticated `window.agenteraRuntimeDistribution` preload namespace exposes state, check, explicit download, cancellation, restart, repair, and state-change events without URLs, paths, signatures, keys, tokens, or owner identifiers.

[[src/renderer/src/components/settings/RuntimeDistributionCard.tsx#RuntimeDistributionCard]] gives Runtime updates their own About card, separate from the desktop app updater. It shows managed status, version, and short source commit; download requires a modal that names the version, trusted `Ablankpaper/aera-runtime` source, and size. The checkout-local unmanaged updater appears only in explicit external mode.

The card claims “up to date” only after a successful metadata check with no offer. If the stable channel cannot be reached or its metadata is rejected, the current signed Runtime remains active but is labeled only as usable; the bounded update error remains visible so transport failure cannot be mistaken for freshness proof.

[[src/main/agentera-runtime-distribution/bootstrap.ts#bootstrapRuntimeDistribution]] runs before `app/start` is dynamically imported. An approved candidate's signature, pointer binding, complete extracted inventory, and isolated offline health are checked again below `userData/runtime/health`; only then does the journal move current to previous and candidate to current. Failure keeps the existing current version, records only an error code, numeric exit code, version, short commit, and timestamp, and durably suppresses the failed candidate until a newer staging action replaces it. No path, credential, Profile, Memory, session, learned Skill, or raw exception enters the diagnostic.

The crash-recovery test preserves all real temporary-file and pointer assertions while allowing a Windows-specific I/O budget; other platforms retain the default five-second bound.

### Stable update test specifications

These focused tests lock the source-authority and supported-platform behavior of signed stable Runtime update checks.

#### Primary stable source

The configured Aera stable origin can produce a verified offer without consulting GitHub, so GitHub availability is not required for the primary update path.

#### Transport-only fallback

A complete first-party transport failure may restart metadata retrieval from GitHub while recording a bounded diagnostic and never mixing metadata across sources.

#### Invalid metadata fails closed

Invalid first-party signatures or metadata terminate the check without consulting GitHub, preventing an authority downgrade after verification failure.

#### Seed point-one to stable point-three

macOS ARM64 and Windows x64 both offer the signed Runtime `.3` release when the installed packaged Seed is `.1`.

## Release gate

Every seed must pass the native Hermes compatibility gate and a clean extracted-artifact smoke test before publication or desktop packaging.

The gate proves stable conversations, background learning, next-conversation recall, Curator behavior, Profile isolation, offline use, migration, update, and rollback without changing private adaptive state.

[[tests/runtime-data-boundary.test.ts]] hashes realistic default and named Profiles, modes, symlink targets, sessions, Memory, learned Skills, Curator state, Gateway/Cron state, logs, attachments, and workspaces after every install/update/activation/rollback/cleanup/selection/repair transition. [[tests/e2e/agentera-runtime-seed.e2e.ts]] adds the product-level proof: enter through the account-required product, complete explicit online browser authentication, automatically prepare and invoke the native packaged Seed with public Runtime HTTP blocked and no Runtime-choice controls, stop the control plane, restart under the signed offline entitlement, and confirm the same Runtime version plus every pre-existing Hermes-owned entry survives unchanged. It also follows `current.json` into the installed version, binds the installed manifest and executable hashes to the locked source commit, resolves the one active Profile's PID and configured port, proves that the live Gateway uses that installed Python, and requires both request-scoped model-route and tool-policy capabilities. Runtime-owned logs may append while their original prefix and permissions remain intact; other pre-existing entries remain byte-identical. The E2E command rebuilds first so stale `out/` assets cannot reintroduce removed startup screens.

### Packaged live Runtime contract

Each macOS and Windows Internal Beta job launches the exact packaged Electron executable in an isolated data root and installs only the Seed inside that same package.

[[tests/e2e/agentera-runtime-contract.e2e.ts]] follows `current.json` to the installed manifest, requires its SHA-256 to equal the packaged Seed manifest SHA-256, hashes the installed Python and Hermes entrypoint, starts the real Gateway, binds its PID and listening port to that Python, and requires `request_tool_policy` plus `request_model_route`. The emitted candidate evidence contains only bounded identities, hashes, PID, port, and capabilities; it excludes local paths and credentials.

The packaged contract has a dedicated bounded budget that includes first-install filesystem work, but its install, installed-file inspection, Profile binding, Gateway IPC, process, endpoint, capability, and shutdown boundaries remain independently timed. The install IPC result is authoritative for completion; the contract then performs one independently bounded renderer state read so a slow or queued Electron IPC response cannot turn a completed install into a polling-timeout failure. Both platforms emit bounded state-transition evidence while Runtime activation is pending; the isolated health runner records each probe's ordinal/name, elapsed time, exit code, signal, timeout classification, output byte counts, and short redacted stdout/stderr tails only when diagnostics are explicitly enabled. Windows additionally records archive-validation, extraction, inventory-helper, verified listener-PID, and process-tree cleanup phases. A failed contract uploads the platform timeline, Playwright log, and isolated-run trace for fourteen days; Gateway and Electron tails are bounded and redact local paths, Bearer credentials, `API_SERVER_KEY`, tokens, and secrets. Successful candidates do not publish these diagnostic artifacts.

When the packaged install itself times out or fails, the diagnostic observer is started before `startInstall` and records bounded Profile stage facts plus matching Python, Node, Electron, and Runtime-helper process samples from outside the Electron main loop. The failure snapshot also writes a bounded Profile/Runtime inventory, known Runtime log tails, full redacted Electron stderr, and the final process sample. These artifacts are evidence-only: they do not extend install or readiness deadlines, alter ownership, or make a failed contract pass.

With the explicit inventory diagnostic output enabled, final extracted verification emits path-free walk start/progress/complete and hash start/bounded-batch-progress/complete events with only counts and elapsed time. External observer failures are classified as timeout, output bound, nonzero exit, or spawn failure instead of a generic error. This evidence never changes hash concurrency, helper deadlines, inventory acceptance, or cleanup behavior.

[[src/main/agentera-runtime-distribution/health.ts#runIsolatedRuntimeHealthCheck]] keeps every offline version, command-surface, and required-import probe fail-closed. Windows receives a bounded 120-second cold-start allowance because Defender can keep a newly extracted 14k-entry Runtime busy after inventory verification; macOS and Linux remain bounded at 45 seconds, and explicit test timeouts still override either platform default. The gating probe always keeps the production command line. An investigative `-X importtime` waterfall is available only with the explicit `AGENTERA_E2E_IMPORTTIME=1` opt-in, so diagnostic acceptance cannot perturb the health result or its cold-start budget.

#### Health child-process lifecycle evidence

When diagnostics are enabled, each isolated health probe records its child lifecycle and timeout state so a packaged stall can be classified from evidence rather than timing assumptions.

The bounded JSONL sequence records the child PID, spawn, timeout/liveness, exit, stdout/stderr stream closure, and final callback boundaries. It also records whether the callback arrived after the timeout and whether the child had exited while a stream remained open; this distinguishes a live child from inherited-handle callback lag. The observer is diagnostic-only and does not alter the production timeout, command, or cleanup semantics.

[[src/main/agentera-runtime-distribution/health.ts#runIsolatedRuntimeHealthCheck]] passes the observer only when the explicit packaged diagnostic environment is active. [[tests/runtime-health-diagnostics.test.ts]] uses deterministic lifecycle events to cover the timeout-to-callback boundary without relying on operating-system process timing.

##### Windows real-runtime diagnostic

The dispatch-only Windows health lane runs the exact health runner against one freshly extracted signed Seed and preserves its JSONL lifecycle evidence; it reports a reproduced health failure without turning that diagnostic into a release gate.

The lane uses the same `-I -B` probes and platform timeout as the installer, so a direct Node result can be compared with the packaged Electron result. A child that exits before its stream/callback boundary points to inherited-handle delay; a live child at timeout points to the Runtime or parent-process launch itself. The lane never changes readiness, timeout, ownership, or release state.

On packaged Windows, ZIP extraction runs in the credential-free `ELECTRON_RUN_AS_NODE` archive-extraction helper outside the Electron main process. The parent independently verifies the signed manifest, archive size, and archive SHA-256; the archive-validation helper performs the structural inventory check against that signed manifest, and the parent performs the complete post-extraction inventory/hash verification. Each helper receives only absolute paths and the minimum manifest/request data, and returns a strict `{schemaVersion:1,ok:true}` result. Archive validation, extraction, and final inventory helpers each have an independent eight-minute deadline with bounded timeout diagnostics, so a filesystem/Defender stall becomes a recoverable install failure instead of leaving the renderer and Electron process waiting indefinitely. Development and POSIX paths retain the direct extractor.

## Independent verification

The main process verifies canonical manifest bytes, Ed25519 trust, signed context, archive size, and SHA-256 before accepting a Runtime artifact.

A separate build-time MJS verifier repeats the checks without importing desktop TypeScript. Packaging reads an exact repository, tag, full commit, and target asset lock; it never resolves `latest`.

## Native packaging gate

Native packaging embeds one exact verified Seed and fails closed if any required artifact or proof is missing.

`scripts/prepare-agentera-runtime-seed.mjs` selects exactly one locked native target, obtains only its archive, manifest, and signature, runs the independent verifier, compares the verified repository, Runtime version, and full source commit with the lock, then atomically replaces the ignored build-staging directory. An explicit `AGENTERA_RUNTIME_SEED_DIR` is development-only; CI rejects it, and failed verification leaves the previous stage unchanged. Both importable Runtime packaging CLI modules are pinned to LF checkout bytes so their hashbang lines remain parseable under Windows Git configurations that otherwise convert text files to CRLF.

Electron Builder excludes the staging directory from `app.asar`, then copies only the three verified files from `resources/agentera-runtime-seed` into the application `Resources/agentera-runtime-seed` directory. Windows additionally packages the generated credential-free archive-validation, archive-extraction, and inventory helpers outside `app.asar`; macOS does not carry these Windows-only helpers. `scripts/verify-packaged-runtime-seed.mjs` rejects partial, mixed-target, or extra Seed contents and can prove every packaged Seed byte matches the verified staging reference.

[[src/main/agentera-runtime-distribution/seed-path.ts#resolvePackagedRuntimeSeedDirectory]] resolves packaged resources from Electron `resourcesPath`. Development and native E2E resolve the same verified staging directory, with an absolute explicit override allowed only outside packaged builds, so source runs exercise the real local installer instead of reporting a false missing-Seed failure.

Stable and beta release workflows currently build only macOS ARM64 and Windows x64. Each native job prepares the exact Seed before packaging and verifies the unpacked application plus final DMG, ZIP, NSIS, and portable artifacts. CI may use its workflow token while fetching the public locked Release, but no token enters the desktop package. Linux and macOS x64 publishing remain disabled until signed native Seed targets and the same final-artifact proof exist.

## Later delivery

After Runtime distribution is stable, delivery continues with workspace cloud foundations and then desktop workspace adoption.

The cloud phase adds membership, invitations, Owner/Admin/Member policy, and audit. The desktop then adds personal/workspace switching plus Agent definition, draft, immutable-version, and permission sync. Organization and official Agent management follow separately.

Neither later project may reintroduce whole-file Memory sync or make local Hermes learning depend on the control plane.
