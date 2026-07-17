const auth = {
  gate: {
    title: "登入 AgentEra",
    checking: "正在檢查 AgentEra 工作階段…",
    browserNote:
      "註冊、登入和找回密碼會在系統瀏覽器中安全完成。AgentEra Studio 不會收集你的密碼或驗證碼。",
    openBrowser: "開啟瀏覽器登入或註冊",
    waitingForBrowser: "正在等待瀏覽器授權…",
    cancel: "取消",
    retry: "重試",
    retrying: "正在重新檢查…",
    loginFailed: "瀏覽器授權未完成，請重試。",
    retryFailed: "AgentEra 無法驗證目前工作階段，請重試。",
    cancelled: "已取消瀏覽器授權。",
    secureStorageTitle: "安全儲存空間無法使用",
    secureStorageDescription:
      "AgentEra 無法安全儲存此裝置工作階段。請啟用系統鑰匙圈或認證服務後重試，軟體絕不會改用明文儲存。",
    reasons: {
      sign_in_required: "使用 AgentEra Studio 前，請先登入或建立帳戶。",
      offline_expired: "7 天離線使用期限已到，請連線並重新登入。",
      clock_rollback: "系統時間發生異常變更，請連線驗證此裝置。",
      device_revoked: "此裝置的授權已撤銷，請重新登入完成授權。",
      account_disabled: "此 AgentEra 帳戶目前已停用，請前往網頁帳戶中心處理。",
      account_pending_deletion: "此帳戶正等待刪除，無法授權 AgentEra Studio。",
      secure_storage_unavailable: "AgentEra 工作階段必須使用系統安全儲存。",
    },
  },
  profile: {
    checkingTitle: "正在檢查本機資料存取權",
    checkingDescription:
      "AgentEra 只檢查歸屬中繼資料，不會開啟你的 Runtime 私密內容。",
    title: "選擇如何使用本機資料",
    existingDescription:
      "此裝置上偵測到既有 AgentEra Runtime 資料。你可以原地綁定，也可以建立獨立的全新空間。",
    noUpload:
      "兩個選項都不會上傳、複製、合併或改寫你的 Memory、工作階段、檔案、技能、USER 資料或學習狀態。",
    useExisting: "使用現有本機資料",
    createNew: "建立全新空間",
    binding: "正在安全綁定…",
    creating: "正在建立空白空間…",
    emptyBindingTitle: "正在準備個人空間",
    emptyBindingDescription:
      "正在將此空白本機 Profile 綁定到你的 AgentEra 帳戶。",
    connectionBindingTitle: "正在保護此 Runtime 連線",
    connectionBindingDescription:
      "正在把遠端或 SSH 連線綁定到目前 AgentEra 擁有者，產品 Token 不會傳送給 Runtime。",
    otherOwnerTitle: "此本機資料屬於另一個帳戶",
    otherOwnerDescription:
      "AgentEra 不會開啟或重新分配此實體 Profile。請建立獨立空白空間，或使用其擁有者帳戶登入。",
    remoteOtherOwnerTitle: "此 Runtime 連線屬於另一個帳戶",
    remoteOtherOwnerDescription:
      "AgentEra 不會繼承上一位擁有者的遠端或 SSH 連線內容。",
    differentAccount: "使用其他帳戶登入",
    failedTitle: "無法準備本機存取",
    failedDescription:
      "沒有任何 Runtime 私密資料被變更。準備好後可重新檢查歸屬。",
    retry: "重新檢查歸屬",
  },
};

export default auth;
