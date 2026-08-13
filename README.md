# Aera

Aera is the Aera desktop application for installing, configuring, and using Aera Runtime. It combines chat, sessions, agents, memory, skills, tools, schedules, messaging gateways, providers, and a live 3D office in one native interface.

[Releases](https://github.com/Ablankpaper/aera/releases) · [Issues](https://github.com/Ablankpaper/aera/issues) · [License](LICENSE)

English · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [Español (LATAM)](README.es-LATAM.md)

> Aera is under active development. Features and packaging details may change between releases.

## Highlights

- Guided installation and updates for Aera Runtime
- Local, SSH tunnel, and remote server connection modes
- Streaming chat with tools, attachments, slash commands, reasoning, and usage data
- Multiple agents with isolated configuration, sessions, memory, skills, and personas
- Provider and model management for hosted and local OpenAI-compatible endpoints
- Session search and continuation, scheduled tasks, messaging gateways, and Kanban
- Backup, import, diagnostics, logs, and automatic desktop updates
- Interactive Aera office and Aera Motors showroom
- Localized interface for 12 languages

## Install

Download the latest macOS, Windows, or Linux build from [GitHub Releases](https://github.com/Ablankpaper/aera/releases).

### Windows

The installer may trigger Windows SmartScreen when a build is not code-signed. Select **More info** and then **Run anyway** only when the file came from the Aera release page.

### Linux

Package names use the `Aera` prefix. For example:

```bash
sudo dnf install ./Aera-<version>.rpm
```

## How it works

On first launch, Aera lets you choose a local or remote Aera Runtime:

1. Local mode detects an existing runtime or offers to install it.
2. Remote and SSH modes validate the target connection without installing a local runtime.
3. Provider and model settings are configured in the desktop interface.
4. The workspace opens after the selected runtime is ready.

Aera Runtime retains its compatibility paths and command surface, including:

- `~/.hermes`
- `~/.hermes/.env`
- `~/.hermes/config.yaml`
- `~/.hermes/hermes-agent`
- `HERMES_HOME` and other `HERMES_*` environment variables
- the `hermes` command

These identifiers remain stable so existing installations, profiles, scripts, and data continue to work after the desktop brand change.

## Supported providers

Aera supports OpenRouter, Anthropic, OpenAI, Google Gemini, xAI, Nous Portal, Qwen, MiniMax, Hugging Face, Groq, and custom OpenAI-compatible endpoints. Local presets include LM Studio, Atomic Chat, Ollama, vLLM, and llama.cpp.

## Development

Requirements:

- Node.js 22+
- npm
- macOS, Windows, or Linux

Install dependencies and start the desktop app:

```bash
npm ci
npm run dev
```

Run verification:

```bash
npm test
npm run typecheck
npm run build
```

### Official Managed Agent V1 development gate

The local Cloud, Aera Admin, and Desktop `main` branches implement the PLATFORM-owned official Agent control plane. The desktop still creates one fresh physical Hermes Profile per Installation; immutable version updates and rollback affect only later RuntimeBindings. Memory, conversations, files, credentials, Curator state, and private learned Skills remain local and are not part of the managed Agent protocol.

The complete local gate is:

```bash
# aera-cloud, with disposable PostgreSQL and Redis
go test ./... -count=1
go vet ./...
AERA_INTEGRATION_TESTS=1 go test -p 1 ./... -count=1

# aera-admin
make verify
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e

# desktop
npm run typecheck
npm run lint
npm test
npm run check:agentera-cloud-contract
AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud \
AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO=/Users/zizimutou/Desktop/aera/aera-admin \
npm run test:e2e:official-managed-agent
npm exec --yes --package=lat.md@0.12.1 -- lat check
```

On 2026-07-23 the executable gates passed locally at Cloud `16ee99a`, Admin `b184e25`, and Desktop `ed6685a`; the Desktop evidence tip is `f5cd58c`. These tips were fast-forwarded into their respective local `main` branches and the merged core suites were reverified. The acceptance run proved v1 publication and installation, deterministic eligibility, v2 update for new conversations, stable existing bindings, dual-control rollback, pause, offline continuation, reconnect, read-only assets, and unchanged private-state hashes. This is local development evidence only; it is not remote push, deployment, production-key readiness, or release evidence.

## Project structure

```text
src/main/                Electron main process and Aera Runtime integration
src/preload/             Secure renderer bridge
src/renderer/src/        React desktop interface
src/shared/              Shared contracts, branding, and localization
resources/               Packaged runtime resources
build/                   Installer and platform assets
tests/                   Cross-process and packaging tests
```

## License

Aera is distributed under the [MIT License](LICENSE).
