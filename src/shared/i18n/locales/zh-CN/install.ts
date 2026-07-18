export default {
  preparing: "准备中...",
  startingInstall: "开始安装",
  preparingRuntime: "正在准备 AgentEra Runtime",
  verifyingPackagedRuntime: "正在校验 AgentEra Studio 安装包内的 Runtime",
  installationComplete: "AgentEra Runtime 已就绪",
  installationFailed: "Runtime 准备失败",
  installingHermes: "正在安装 AgentEra Runtime",
  installationFailedHint: "安装失败，请重试或改用终端安装。",
  preparationFailedHint: "无法从本地安装资源准备 AgentEra Runtime。",
  packagedRuntimeInvalid:
    "AgentEra Studio 安装包内的 Runtime 缺失或无效。请重新安装 AgentEra Studio；本次未回退到在线下载。",
  insufficientDiskSpace:
    "可用磁盘空间不足，无法准备 AgentEra Runtime。请清理空间后重试。",
  retryInstallation: "重新安装",
  retryPreparation: "重新准备",
  reinstallDesktop: "重新安装 AgentEra Studio",
  copied: "已复制！",
  copyLogs: "复制日志",
  stepLabel: "步骤 {{step}}/{{total}}：{{title}}",
  waitingToStart: "等待开始...",
  continueToSetup: "继续前往设置",
  confirmTitle: "准备 AgentEra Runtime",
  confirmBundledRuntime:
    "AgentEra Runtime 已随桌面应用内置，将直接在本机完成准备。",
  confirmOfflinePreparation:
    "首次准备不会从 GitHub 下载 Hermes，也不会改动你的 Profile、Memory、会话或已学习 Skills。",
  confirmPrepareBtn: "准备 Runtime",
  confirmLocationLabel: "AgentEra 将安装到：",
  confirmFresh: "此处未找到现有安装 — 将进行全新安装。",
  confirmUpdate: "此处已有 AgentEra 安装 — 将更新到最新版本。",
  confirmReplace:
    "此处存在一个文件夹，但不是有效的 AgentEra 安装 — 安装将删除并替换它。",
  confirmNotInherited:
    "如果你在其他位置或通过命令行安装过 AgentEra，那些安装不会被沿用。",
  confirmInstallBtn: "安装 AgentEra",
  useExistingBtn: "使用现有安装",
  useExistingHint:
    "选择包含你现有 AgentEra 安装的文件夹（即包含 hermes-agent 文件夹的那个）。",
  useExistingInvalid: "在该文件夹中未找到可用的 AgentEra 安装。",
  useExistingDone: "已设置现有安装 — 退出并重新打开 AgentEra 以应用。",
  useExistingQuitBtn: "退出 AgentEra",
} as const;
