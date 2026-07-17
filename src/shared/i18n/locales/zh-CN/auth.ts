const auth = {
  gate: {
    title: "登录 AgentEra",
    checking: "正在检查 AgentEra 会话…",
    browserNote:
      "注册、登录和找回密码会在系统浏览器中安全完成。AgentEra Studio 不会收集你的密码或验证码。",
    openBrowser: "打开浏览器登录或注册",
    waitingForBrowser: "正在等待浏览器授权…",
    cancel: "取消",
    retry: "重试",
    retrying: "正在重新检查…",
    loginFailed: "浏览器授权未完成，请重试。",
    retryFailed: "AgentEra 无法验证当前会话，请重试。",
    cancelled: "已取消浏览器授权。",
    secureStorageTitle: "安全存储不可用",
    secureStorageDescription:
      "AgentEra 无法安全保存此设备会话。请启用系统钥匙串或凭据服务后重试，软件绝不会降级为明文存储。",
    reasons: {
      sign_in_required: "使用 AgentEra Studio 前，请先登录或创建账户。",
      offline_expired: "7 天离线使用期限已到，请联网并重新登录。",
      clock_rollback: "系统时间出现异常变化，请联网验证此设备。",
      device_revoked: "此设备已被撤销授权，请重新登录完成授权。",
      account_disabled: "此 AgentEra 账户目前已停用，请前往网页账户中心处理。",
      account_pending_deletion:
        "此账户正在等待注销，无法授权 AgentEra Studio。",
      secure_storage_unavailable: "AgentEra 会话必须使用系统安全存储。",
    },
  },
  profile: {
    checkingTitle: "正在检查本地数据访问权",
    checkingDescription:
      "AgentEra 只检查归属元数据，不会打开你的 Runtime 私有内容。",
    title: "选择如何使用本地数据",
    existingDescription:
      "此设备上检测到已有 AgentEra Runtime 数据。你可以原地绑定，也可以创建一个独立的全新空间。",
    noUpload:
      "两个选项都不会上传、复制、合并或改写你的 Memory、会话、文件、技能、USER 资料或学习状态。",
    useExisting: "使用现有本地数据",
    createNew: "创建全新空间",
    binding: "正在安全绑定…",
    creating: "正在创建空白空间…",
    emptyBindingTitle: "正在准备个人空间",
    emptyBindingDescription:
      "正在将此空白本地 Profile 绑定到你的 AgentEra 账户。",
    connectionBindingTitle: "正在保护此 Runtime 连接",
    connectionBindingDescription:
      "正在把远程或 SSH 连接绑定到当前 AgentEra 所有者，产品 Token 不会发送给 Runtime。",
    otherOwnerTitle: "此本地数据属于另一个账户",
    otherOwnerDescription:
      "AgentEra 不会打开或重新分配此物理 Profile。请创建独立空白空间，或使用其所有者账户登录。",
    remoteOtherOwnerTitle: "此 Runtime 连接属于另一个账户",
    remoteOtherOwnerDescription:
      "AgentEra 不会继承上一位所有者的远程或 SSH 连接上下文。",
    differentAccount: "使用其他账户登录",
    failedTitle: "无法准备本地访问",
    failedDescription:
      "没有任何 Runtime 私有数据被更改。准备好后可重新检查归属。",
    retry: "重新检查归属",
  },
};

export default auth;
