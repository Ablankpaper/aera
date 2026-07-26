const auth = {
  gate: {
    title: "AgentEra にサインイン",
    checking: "AgentEra セッションを確認しています…",
    browserNote:
      "登録、サインイン、パスワードの再設定はブラウザーで安全に行われます。AgentEra Studio がパスワードや確認コードを収集することはありません。",
    openBrowser: "ブラウザーでサインインまたは登録",
    waitingForBrowser: "ブラウザーの認証を待っています…",
    cancel: "キャンセル",
    retry: "再試行",
    retrying: "再確認しています…",
    loginFailed: "ブラウザー認証が完了しませんでした。もう一度お試しください。",
    retryFailed:
      "AgentEra はセッションを確認できませんでした。もう一度お試しください。",
    cancelled: "ブラウザー認証をキャンセルしました。",
    secureStorageTitle: "安全なストレージを利用できません",
    secureStorageDescription:
      "AgentEra はこのデバイスのセッションを安全に保存できません。システムのキーチェーンまたは資格情報サービスを有効にして再試行してください。平文保存には切り替わりません。",
    reasons: {
      sign_in_required:
        "AgentEra Studio を使用する前に、サインインまたはアカウント登録を行ってください。",
      offline_expired:
        "7 日間のオフライン利用期限が切れました。ネットワークに接続して再度サインインしてください。",
      clock_rollback:
        "システム時刻が予期せず変更されました。ネットワークに接続してこのデバイスを確認してください。",
      device_revoked:
        "このデバイスの認証は取り消されています。再度サインインしてください。",
      account_disabled:
        "この AgentEra アカウントは現在無効です。ブラウザーのアカウントページをご確認ください。",
      account_pending_deletion:
        "このアカウントは削除待ちのため AgentEra Studio を認証できません。",
      secure_storage_unavailable:
        "AgentEra セッションにはシステムの安全なストレージが必要です。",
    },
  },
  profile: {
    checkingTitle: "ローカルデータへのアクセスを確認中",
    checkingDescription:
      "AgentEra は所有権メタデータだけを確認し、Runtime の非公開コンテンツは開きません。",
    title: "ローカルデータの使用方法を選択",
    existingDescription:
      "このデバイスに既存の AgentEra Runtime データがあります。そのまま関連付けるか、独立した空のスペースを作成してください。",
    noUpload:
      "どちらを選んでも、Memory、セッション、ファイル、スキル、USER プロファイル、学習状態のアップロード、コピー、統合、書き換えは行われません。",
    useExisting: "既存のローカルデータを使用",
    createNew: "新しいスペースを作成",
    binding: "安全に関連付けています…",
    creating: "空のスペースを作成しています…",
    emptyBindingTitle: "個人スペースを準備中",
    emptyBindingDescription:
      "この空のローカル Profile を AgentEra アカウントに関連付けています。",
    connectionBindingTitle: "Runtime 接続を保護しています",
    connectionBindingDescription:
      "リモートまたは SSH 接続を現在の AgentEra 所有者に関連付けています。製品 Token は Runtime に送信されません。",
    otherOwnerTitle: "このローカルデータは別のアカウントに属しています",
    otherOwnerDescription:
      "AgentEra はこの物理 Profile を開いたり再割り当てしたりしません。別の空スペースを作るか、所有者としてサインインしてください。",
    remoteOtherOwnerTitle: "この Runtime 接続は別のアカウントに属しています",
    remoteOtherOwnerDescription:
      "AgentEra は以前の所有者のリモートまたは SSH 接続情報を引き継ぎません。",
    differentAccount: "別のアカウントでサインイン",
    failedTitle: "ローカルアクセスを準備できませんでした",
    failedDescription:
      "Runtime の非公開データは変更されていません。準備ができたら所有権確認を再試行してください。",
    retry: "所有権確認を再試行",
  },
  offline: {
    title: "ローカルオフラインモード",
    description:
      "クラウドアカウント機能は一時停止します。署名済み期限まではローカル Agent、モデル API、Hermes の学習を利用できます。",
  },
  account: {
    settingsNav: "AgentEra アカウント",
    title: "AgentEra アカウント",
    openMenu: "AgentEra アカウントメニューを開く",
    online: "オンライン・確認済み",
    offline: "オフライン・ローカル利用",
    manage: "アカウント管理",
    devices: "デバイス管理",
    recharge: "モデル API をチャージ",
    switch: "アカウント切替",
    signOut: "サインアウト",
    actionFailed: "アカウント操作を完了できませんでした。",
    unavailable: "AgentEra アカウント情報を利用できません。",
    userId: "アカウント ID",
    deviceId: "デバイス",
    offlineUntil: "署名済みオフラインアクセスは {{date}} まで有効です。",
    localDataWarning:
      "クラウドアカウントの削除やサインアウトで、ローカルの Hermes Profile、Memory、セッション、ファイル、スキル、学習状態が削除・移動・アップロード・解除されることはありません。",
    rechargeSeparateAccount:
      "チャージは独立したモデル API サイトを開きます。そのアカウント、残高、API キー、Cookie、Token は AgentEra と共有されません。",
    pendingRevocationWarning:
      "制御サービスに接続できない状態でサインアウトすると、署名済み取消要求が自動送信されるまで最大 5 台の枠に残る場合があります。",
  },
};

export default auth;
