# AgentEra External Recharge Button Design

## Goal

Add one clear recharge entry to AgentEra Studio that opens the existing `agentera-claw-api` purchase page in the user's system browser while leaving the current relay API-key workflow unchanged.

## Approved Scope

- Add a localized recharge button to the model-provider and API-key configuration surface.
- Open the existing `agentera-claw-api` `/purchase` page in the system default browser.
- Keep the current model provider, base URL, relay API key, credential storage, and request routing unchanged.
- Reuse the desktop's existing bounded `openExternal` preload and main-process path.
- Make the recharge destination a build-time configuration value so a later domain change does not require restructuring the UI.

The feature does not add login handoff, single sign-on, token transfer, balance synchronization, payment callbacks, an embedded payment webview, or a new payment page.

## Approaches Considered

### Chosen: configured external purchase URL

The renderer reads a dedicated non-secret recharge URL from its build configuration and passes it to the existing `window.hermesAPI.openExternal` API. Development defaults to `http://localhost:8080/purchase`; production packaging supplies the deployed HTTPS `/purchase` URL.

This keeps the first release small, preserves the current API-key architecture, and allows the production domain to change without coupling recharge behavior to provider credentials.

### Rejected: hard-coded production URL

A fixed URL is the smallest code diff, but every domain or path change would require another desktop release. It also prevents a clean local development target.

### Rejected: authenticated handoff or server-discovered URL

An authenticated handoff would require desktop identity, short-lived tickets, web sessions, and callback behavior. Server discovery would add a network dependency before the browser can open. Both exceed the approved direct-link scope.

## User Experience

The Providers screen shows a secondary `Recharge` action in the large-model provider/API-key section header. The Chinese Simplified label is `充值`. Every shipped locale dictionary receives the new action and unavailable-hint keys; locales without a reviewed translation use the exact English strings `Recharge` and `Recharge is unavailable in this build.`

The action remains independent of the selected provider and does not inspect, copy, alter, or submit an API key. Clicking it opens the configured purchase URL in the system browser and leaves AgentEra Studio open in its current state.

The payment website owns sign-in, payment selection, order creation, payment status, and all post-payment behavior. Returning to AgentEra Studio does not trigger an automatic balance refresh because the desktop does not yet own an account-to-balance relationship.

## URL Configuration

`VITE_AGENTERA_RECHARGE_URL` is the single renderer build setting for the complete purchase-page URL.

- Development fallback: `http://localhost:8080/purchase`.
- Production contract: an absolute HTTPS URL ending at the deployed purchase route.
- The value is public configuration, not a secret, and must never contain an API key, bearer token, user identifier, email address, or other credential.
- Missing, malformed, or non-HTTPS production configuration disables the action and shows a localized unavailable hint instead of opening an unintended destination.
- Loopback HTTP is accepted only for development.

No recharge URL is derived from a user-entered provider base URL. This prevents a custom provider configuration from redirecting the product-owned recharge action to an arbitrary site.

## Data Flow and Boundaries

1. The user opens the Providers screen.
2. The renderer resolves the validated recharge URL from build configuration.
3. The user clicks `Recharge`.
4. The renderer calls the existing `window.hermesAPI.openExternal(rechargeUrl)` preload method.
5. The main process handles `open-external`, applies the existing external-URL safety check, and delegates the URL to Electron `shell.openExternal`.
6. The operating system opens the URL in the default browser.

No model request, account request, payment request, API-key mutation, or new IPC channel is introduced. `agentera-claw-api` remains the sole owner of the purchase page and payment workflow.

## Error and Security Behavior

- The purchase page is never embedded inside AgentEra Studio.
- The URL contains no desktop session, API key, access token, or payment data.
- Production configuration must use HTTPS; only the loopback development target may use HTTP.
- Invalid or absent production configuration leaves the button disabled and exposes no raw configuration value to the user.
- A system-browser launch failure follows the existing `openExternalUrl` logging path and does not change provider state.
- Repeated clicks are stateless and may open repeated browser tabs; the desktop neither creates nor retries payment orders.

## Testing Strategy

Implementation follows test-driven development.

Focused renderer tests verify that:

- the Providers surface renders the localized recharge action;
- one click invokes `window.hermesAPI.openExternal` exactly once with the configured purchase URL;
- the click does not call API-key, provider, account, or model-configuration mutations;
- invalid or missing production configuration disables the action and presents the unavailable hint;
- the development fallback resolves only to the loopback `/purchase` page.

The native button remains keyboard-focusable, exposes its localized text as its accessible name, and uses the existing disabled-button presentation when the production URL is unavailable.

Existing Electron security tests continue to verify that `shell.openExternal` is reachable only through the main-process allowlist helper. Verification also includes renderer and Node typechecks, focused Vitest tests, the full relevant test suite, a production build with an HTTPS recharge URL, and `lat check`.

## Acceptance Criteria

- AgentEra Studio displays a recharge button in the model-provider/API-key configuration area.
- Clicking the enabled button opens the configured `agentera-claw-api` `/purchase` page in the system default browser.
- The application does not embed the website or change the current provider, base URL, relay API key, account state, or model request path.
- The desktop does not append credentials or identity data to the URL.
- A missing or unsafe production URL cannot open an external destination.
- No change is required in the `agentera-claw-api` repository for this feature.
