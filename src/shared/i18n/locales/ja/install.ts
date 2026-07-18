export default {
  preparing: "準備中...",
  startingInstall: "インストールを開始しています",
  installationComplete: "インストール完了",
  installationFailed: "インストール失敗",
  installingHermes: "AgentEra Runtime をインストール中",
  retryInstallation: "再試行",
  copied: "コピーしました！",
  copyLogs: "ログをコピー",
  stepLabel: "ステップ {{step}}/{{total}}：{{title}}",
  waitingToStart: "開始待機中...",
  continueToSetup: "セットアップへ進む",
  confirmTitle: "インストール前の確認",
  confirmLocationLabel: "AgentEra のインストール先:",
  confirmFresh:
    "ここに既存のインストールは見つかりませんでした。新しくインストールされます。",
  confirmUpdate:
    "ここに既存の AgentEra インストールがあります。最新バージョンに更新されます。",
  confirmReplace:
    "ここにフォルダがありますが、有効な AgentEra インストールではありません。インストールすると削除されて置き換えられます。",
  confirmNotInherited:
    "AgentEra を別の場所、またはコマンドラインでインストールした場合、それは引き継がれません。",
  confirmInstallBtn: "AgentEra をインストール",
  useExistingBtn: "既存の外部 Runtime を使用",
  useExistingHint:
    "hermes-agent を含む Hermes ホームを選択してください。この Runtime は外部・非管理のまま維持され、更新ではその checkout のローカルコマンドだけを実行します。",
  useExistingInvalid:
    "そのフォルダで使用可能な AgentEra インストールが見つかりませんでした。",
  useExistingDone:
    "外部 Runtime を選択しました。AgentEra を終了して再度開くと適用されます。AgentEra Studio はその checkout を変更または削除しません。",
  useExistingQuitBtn: "AgentEra を終了",
} as const;
