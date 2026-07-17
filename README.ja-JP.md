# AgentEra Studio

AgentEra Studio は、AgentEra Runtime のインストール、設定、利用を行う AgentEra のデスクトップアプリです。チャット、セッション、エージェント、メモリ、スキル、ツール、スケジュール、メッセージングゲートウェイ、プロバイダー、3D オフィスを 1 つのネイティブ UI に統合します。

[リリース](https://github.com/bignormal/aera/releases) · [Issue](https://github.com/bignormal/aera/issues) · [ライセンス](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md) · 日本語 · [Español (LATAM)](README.es-LATAM.md)

> AgentEra Studio は現在も開発中です。機能やパッケージの詳細はリリースごとに変更される場合があります。

## 主な機能

- AgentEra Runtime のガイド付きインストールと更新
- ローカル、SSH トンネル、リモートサーバーの接続モード
- ツール、添付ファイル、スラッシュコマンド、推論、使用量を備えたストリーミングチャット
- エージェントごとに分離された設定、セッション、メモリ、スキル、ペルソナ
- クラウドおよびローカル OpenAI 互換エンドポイントのプロバイダー・モデル管理
- セッション検索と再開、スケジュール、メッセージングゲートウェイ、Kanban
- バックアップ、インポート、診断、ログ、デスクトップ自動更新
- AgentEra オフィスと AgentEra Motors ショールーム
- 12 言語の UI

## インストール

最新の macOS、Windows、Linux ビルドは [GitHub Releases](https://github.com/bignormal/aera/releases) からダウンロードできます。

### Windows

コード署名されていないビルドでは Windows SmartScreen が表示される場合があります。AgentEra の Release ページから取得したファイルであることを確認してから実行してください。

### Linux

パッケージ名には `agentera-studio` プレフィックスを使用します。

```bash
sudo dnf install ./agentera-studio-<version>.rpm
```

## 仕組み

初回起動時に、ローカルまたはリモートの AgentEra Runtime を選択します。

1. ローカルモードでは既存 Runtime を検出し、必要な場合はインストールします。
2. リモートおよび SSH モードでは、ローカル Runtime をインストールせず接続先を検証します。
3. デスクトップ UI からプロバイダーとモデルを設定します。
4. Runtime の準備が完了するとメインワークスペースを開きます。

AgentEra Runtime は既存環境との互換性のため、次のパスとコマンドを維持します。

- `~/.hermes`
- `~/.hermes/.env`
- `~/.hermes/config.yaml`
- `~/.hermes/hermes-agent`
- `HERMES_HOME` およびその他の `HERMES_*` 環境変数
- `hermes` コマンド

このため、ブランド変更後も既存のインストール、プロファイル、スクリプト、データを継続利用できます。

## 開発

```bash
npm ci
npm run dev
```

検証コマンド：

```bash
npm test
npm run typecheck
npm run build
```

## ライセンス

AgentEra Studio は [MIT License](LICENSE) の下で配布されます。
