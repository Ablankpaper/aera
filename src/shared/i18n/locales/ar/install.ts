export default {
  preparing: "جارٍ التحضير...",
  startingInstall: "بدء التثبيت",
  installationComplete: "اكتمل التثبيت",
  installationFailed: "فشل التثبيت",
  installingHermes: "جارٍ تثبيت Aera Runtime",
  retryInstallation: "إعادة محاولة التثبيت",
  copied: "تم النسخ!",
  copyLogs: "نسخ السجلات",
  stepLabel: "الخطوة {{step}}/{{total}}: {{title}}",
  waitingToStart: "في انتظار البدء...",
  continueToSetup: "متابعة إلى الإعداد",
  confirmTitle: "قبل التثبيت",
  confirmLocationLabel: "سيتم تثبيت Aera في:",
  confirmFresh: "لم يتم العثور على تثبيت موجود هنا — سيتم إعداد نسخة جديدة.",
  confirmUpdate: "يوجد تثبيت Aera موجود هنا — سيتم تحديثه إلى أحدث إصدار.",
  confirmReplace:
    "يوجد مجلد هنا لكنه ليس تثبيتاً صالحاً لـ Aera — التثبيت سيحذفه ويستبدله.",
  confirmNotInherited:
    "إذا قمت بتثبيت Aera في مكان آخر، أو عبر سطر الأوامر، فلن يتم نقله.",
  confirmInstallBtn: "تثبيت Aera",
  useExistingBtn: "استخدام Runtime خارجي موجود",
  useExistingHint:
    "اختر مجلد Aera Runtime الرئيسي الذي يحتوي على hermes-agent. سيبقى Runtime خارجياً وغير مُدار، ولن تعمل التحديثات إلا عبر الأمر المحلي لهذا المستودع.",
  useExistingInvalid: "لم يتم العثور على تثبيت Aera صالح في هذا المجلد.",
  useExistingDone:
    "تم اختيار Runtime الخارجي — أغلق Aera وأعد فتحه لتطبيقه. لن يعدّل Aera هذا المستودع أو يحذفه.",
  useExistingQuitBtn: "إنهاء Aera",
} as const;
