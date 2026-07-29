export default {
  title: "配置检查",
  description: "自动检查本地连接和模型配置，并在可以安全处理时直接完成修复。",
  rerun: "重新检查",
  allGood: "未发现问题，当前配置可以正常使用。",
  banner: {
    lead: "发现配置问题：",
    errors: "{{count}} 项错误",
    warnings: "{{count}} 项提醒",
    infos: "{{count}} 项说明",
    showDetails: "查看详情",
  },
  fix: {
    apply: "应用修复",
    running: "正在修复…",
    success: "修复已完成。",
    failure: "修复失败。",
  },
};
