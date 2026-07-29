export default {
  preparing: "准备中...",
  preparingRuntime: "正在准备 Aera Runtime",
  verifyingPackagedRuntime: "正在校验 Aera 安装包内的 Runtime",
  installationComplete: "Aera Runtime 已就绪",
  installationFailed: "Runtime 准备失败",
  preparationFailedHint: "无法从本地安装资源准备 Aera Runtime。",
  packagedRuntimeInvalid:
    "Aera 安装包内的 Runtime 缺失或无效。请重新安装 Aera；本次未回退到在线下载。",
  insufficientDiskSpace:
    "可用磁盘空间不足，无法准备 Aera Runtime。请清理空间后重试。",
  retryPreparation: "重新准备",
  reinstallDesktop: "重新安装 Aera",
  copied: "已复制！",
  copyLogs: "复制日志",
  stepLabel: "步骤 {{step}}/{{total}}：{{title}}",
  waitingToStart: "等待开始...",
  continueToSetup: "继续前往设置",
  confirmTitle: "准备 Aera Runtime",
  confirmBundledRuntime:
    "Aera Runtime 已随桌面应用内置，将直接在本机完成准备。",
  confirmOfflinePreparation:
    "首次准备不会从 GitHub 下载 Aera Runtime，也不会改动你的智能体数据、Memory、会话或已学习 Skills。",
  confirmPrepareBtn: "准备 Runtime",
  useExistingBtn: "使用现有外部 Runtime",
  useExistingHint:
    "选择包含 hermes-agent 的 Aera Runtime 主目录。该 Runtime 将保持为不受托管的外部模式，更新只运行此 checkout 自带的本地命令。",
  useExistingInvalid: "在该文件夹中未找到可用的外部 Aera Runtime。",
  useExistingDone:
    "已选择外部 Runtime — 退出并重新打开 Aera 以应用。Aera 不会修改或删除该 checkout。",
  useExistingQuitBtn: "退出 Aera",
} as const;
