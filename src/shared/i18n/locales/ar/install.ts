export default {
  preparing: "جارٍ التحضير...",
  startingInstall: "بدء التثبيت",
  installationComplete: "اكتمل التثبيت",
  installationFailed: "فشل التثبيت",
  installingHermes: "جارٍ تثبيت AgentEra Runtime",
  retryInstallation: "إعادة محاولة التثبيت",
  copied: "تم النسخ!",
  copyLogs: "نسخ السجلات",
  stepLabel: "الخطوة {{step}}/{{total}}: {{title}}",
  waitingToStart: "في انتظار البدء...",
  continueToSetup: "متابعة إلى الإعداد",
  confirmTitle: "قبل التثبيت",
  confirmLocationLabel: "سيتم تثبيت AgentEra في:",
  confirmFresh: "لم يتم العثور على تثبيت موجود هنا — سيتم إعداد نسخة جديدة.",
  confirmUpdate: "يوجد تثبيت AgentEra موجود هنا — سيتم تحديثه إلى أحدث إصدار.",
  confirmReplace:
    "يوجد مجلد هنا لكنه ليس تثبيتاً صالحاً لـ AgentEra — التثبيت سيحذفه ويستبدله.",
  confirmNotInherited:
    "إذا قمت بتثبيت AgentEra في مكان آخر، أو عبر سطر الأوامر، فلن يتم نقله.",
  confirmInstallBtn: "تثبيت AgentEra",
  useExistingBtn: "استخدام Runtime خارجي موجود",
  useExistingHint:
    "اختر مجلد Hermes الرئيسي الذي يحتوي على hermes-agent. سيبقى Runtime خارجياً وغير مُدار، ولن تعمل التحديثات إلا عبر الأمر المحلي لهذا المستودع.",
  useExistingInvalid: "لم يتم العثور على تثبيت AgentEra صالح في هذا المجلد.",
  useExistingDone:
    "تم اختيار Runtime الخارجي — أغلق AgentEra وأعد فتحه لتطبيقه. لن يعدّل AgentEra Studio هذا المستودع أو يحذفه.",
  useExistingQuitBtn: "إنهاء AgentEra",
} as const;
