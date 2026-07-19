# Desktop model onboarding bypass and Agent navigation

AgentEra Studio should open the desktop after authentication, Runtime preparation, and Profile ownership checks without requiring a model provider during startup.

## Startup behavior

An installed Runtime routes to the main desktop whether or not an API key or model has been configured. A fresh Runtime installation also continues to the main desktop after its empty Profile is created and bound.

The existing provider setup component remains available as reusable code, but it is no longer part of the startup state machine. Missing model credentials continue to be reported by the desktop's configuration-health banner, and users configure providers or select a model from the existing desktop surfaces.

Authentication, signed offline access, Runtime verification, and Profile ownership remain mandatory. This change does not create placeholder credentials, write an artificial model selection, or bypass any product-access check.

## Agent navigation

The pinned sidebar adds an Agent destination directly below Schedules and above recent chats. The destination opens the existing Agents screen rather than introducing a second Agent implementation.

The existing screen continues to own Agent/Profile creation, switching, editing, chat launch, gateway state, and cloud definition synchronization. Chinese labels use `智能体`; English labels use `Agents`.

## Compatibility boundary

This change only alters renderer navigation and the sanitized startup target. It does not migrate or rewrite Hermes Memory, sessions, learned Skills, Profile directories, or self-learning state.

## Verification

Automated coverage must prove that an installed Runtime with no API key targets the main desktop, legacy `setup` targets are normalized to main, post-install routing enters main, and the pinned navigation order places Agents after Schedules.

The final check includes type checking, targeted tests, the LAT graph check, and a live Electron restart with the Agent navigation visible.
