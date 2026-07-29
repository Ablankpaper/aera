export default {
  preparing: "準備中...",
  preparingRuntime: "正在準備 Aera Runtime",
  verifyingPackagedRuntime: "正在驗證 Aera 安裝包內的 Runtime",
  installationComplete: "Aera Runtime 已就緒",
  installationFailed: "Runtime 準備失敗",
  preparationFailedHint: "無法從本機安裝資源準備 Aera Runtime。",
  packagedRuntimeInvalid:
    "Aera 安裝包內的 Runtime 遺失或無效。請重新安裝 Aera；本次未使用線上回退。",
  insufficientDiskSpace:
    "可用磁碟空間不足，無法準備 Aera Runtime。請清理空間後再試一次。",
  retryPreparation: "重新準備",
  reinstallDesktop: "重新安裝 Aera",
  copied: "已複製！",
  copyLogs: "複製記錄",
  stepLabel: "步驟 {{step}}/{{total}}：{{title}}",
  waitingToStart: "等待開始...",
  continueToSetup: "繼續前往設定",
  confirmTitle: "準備 Aera Runtime",
  confirmBundledRuntime:
    "Aera Runtime 已內建於桌面應用，將直接在本機完成準備。",
  confirmOfflinePreparation:
    "首次準備不會從 GitHub 下載 Aera Runtime，也不會修改你的智慧體資料、Memory、工作階段或已學習 Skills。",
  confirmPrepareBtn: "準備 Runtime",
  useExistingBtn: "使用現有外部 Runtime",
  useExistingHint:
    "選擇包含 hermes-agent 的 Aera Runtime 主目錄。該 Runtime 會保持為不受託管的外部模式，更新只執行此 checkout 內建的本機命令。",
  useExistingInvalid: "在該資料夾中找不到可用的外部 Aera Runtime。",
  useExistingDone:
    "已選擇外部 Runtime — 結束並重新開啟 Aera 以套用。Aera 不會修改或刪除該 checkout。",
  useExistingQuitBtn: "結束 Aera",
} as const;
