# Aera

Aera 是 Aera 的桌面应用，用于安装、配置和使用 Aera Runtime。它在一个原生桌面界面中整合了聊天、会话、智能体、记忆、技能、工具、计划任务、消息网关、模型提供商和实时 3D 办公室。

[版本下载](https://github.com/bignormal/aera/releases) · [问题反馈](https://github.com/bignormal/aera/issues) · [许可证](LICENSE)

[English](README.md) · 简体中文 · [日本語](README.ja-JP.md) · [Español (LATAM)](README.es-LATAM.md)

> Aera 正在持续开发，功能和打包细节可能随版本调整。

## 主要能力

- 引导式安装和更新 Aera Runtime
- 本地、SSH 隧道和远程服务器连接模式
- 支持工具、附件、斜杠命令、推理过程和用量信息的流式聊天
- 多智能体隔离配置、会话、记忆、技能和人格
- 云端及本地 OpenAI 兼容模型的提供商与模型管理
- 会话搜索与续接、计划任务、消息网关和看板
- 备份、导入、诊断、日志和桌面自动更新
- 可交互的 Aera 办公室与 Aera Motors 展厅
- 支持 12 种界面语言

## 安装

请从 [GitHub Releases](https://github.com/bignormal/aera/releases) 下载最新的 macOS、Windows 或 Linux 安装包。

### Windows

未进行代码签名的构建可能触发 Windows SmartScreen。只有在文件来自 Aera 官方 Release 页面时，才选择“更多信息”并继续运行。

### Linux

安装包统一使用 `Aera` 前缀，例如：

```bash
sudo dnf install ./Aera-<version>.rpm
```

## 工作方式

首次启动时，Aera 会让你选择本地或远程 Aera Runtime：

1. 本地模式会检测现有 Runtime，未检测到时提供安装流程。
2. 远程与 SSH 模式会验证目标连接，不要求安装本地 Runtime。
3. 可在桌面界面内配置模型提供商和默认模型。
4. Runtime 就绪后进入主工作区。

Aera Runtime 继续保留兼容路径和命令，包括：

- `~/.hermes`
- `~/.hermes/.env`
- `~/.hermes/config.yaml`
- `~/.hermes/hermes-agent`
- `HERMES_HOME` 及其他 `HERMES_*` 环境变量
- `hermes` 命令

这些标识保持稳定，确保品牌更新后已有安装、配置档案、脚本和数据仍可继续使用。

## 支持的模型提供商

Aera 支持 OpenRouter、Anthropic、OpenAI、Google Gemini、xAI、Nous Portal、Qwen、MiniMax、Hugging Face、Groq，以及自定义 OpenAI 兼容端点。本地预设包括 LM Studio、Atomic Chat、Ollama、vLLM 和 llama.cpp。

## 开发

环境要求：

- Node.js 22+
- npm
- macOS、Windows 或 Linux

安装依赖并启动桌面端：

```bash
npm ci
npm run dev
```

运行验证：

```bash
npm test
npm run typecheck
npm run build
```

## 项目结构

```text
src/main/                Electron 主进程和 Aera Runtime 集成
src/preload/             安全的渲染进程桥接
src/renderer/src/        React 桌面界面
src/shared/              共享契约、品牌和多语言资源
resources/               打包资源
build/                   安装包与平台资源
tests/                   跨进程和打包测试
```

## 许可证

Aera 使用 [MIT License](LICENSE) 发布。
