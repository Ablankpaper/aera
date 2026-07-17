const auth = {
  gate: {
    title: "تسجيل الدخول إلى AgentEra",
    checking: "جارٍ التحقق من جلسة AgentEra…",
    browserNote:
      "يتم التسجيل وتسجيل الدخول واستعادة كلمة المرور بأمان في المتصفح. لا يجمع AgentEra Studio كلمة المرور أو رمز التحقق مطلقًا.",
    openBrowser: "فتح المتصفح لتسجيل الدخول أو إنشاء حساب",
    waitingForBrowser: "في انتظار تفويض المتصفح…",
    cancel: "إلغاء",
    retry: "إعادة المحاولة",
    retrying: "جارٍ التحقق مرة أخرى…",
    loginFailed: "لم يكتمل تفويض المتصفح. يُرجى المحاولة مرة أخرى.",
    retryFailed: "تعذر على AgentEra التحقق من جلستك. يُرجى المحاولة مرة أخرى.",
    cancelled: "تم إلغاء تفويض المتصفح.",
    secureStorageTitle: "التخزين الآمن غير متاح",
    secureStorageDescription:
      "لا يستطيع AgentEra حفظ جلسة هذا الجهاز بأمان. فعّل سلسلة مفاتيح النظام أو خدمة بيانات الاعتماد ثم أعد المحاولة. لا يتم استخدام التخزين النصي المكشوف مطلقًا.",
    reasons: {
      sign_in_required:
        "سجّل الدخول أو أنشئ حسابًا قبل استخدام AgentEra Studio.",
      offline_expired:
        "انتهت صلاحية الوصول دون اتصال لمدة سبعة أيام. اتصل بالإنترنت وسجّل الدخول مجددًا.",
      clock_rollback:
        "تغيّرت ساعة النظام بشكل غير متوقع. اتصل بالإنترنت للتحقق من هذا الجهاز.",
      device_revoked: "لم يعد هذا الجهاز مخولًا. سجّل الدخول لتخويله من جديد.",
      account_disabled:
        "حساب AgentEra هذا معطّل حاليًا. استخدم صفحة الحساب في المتصفح للحصول على المساعدة.",
      account_pending_deletion:
        "هذا الحساب بانتظار الحذف ولا يمكنه تخويل AgentEra Studio.",
      secure_storage_unavailable:
        "تتطلب جلسات AgentEra تخزينًا آمنًا في النظام.",
    },
  },
  profile: {
    checkingTitle: "جارٍ التحقق من الوصول إلى البيانات المحلية",
    checkingDescription:
      "يتحقق AgentEra من بيانات الملكية الوصفية فقط من دون فتح محتوى Runtime الخاص.",
    title: "اختر كيفية استخدام بياناتك المحلية",
    existingDescription:
      "تم العثور على بيانات AgentEra Runtime موجودة على هذا الجهاز. اربطها في مكانها أو ابدأ بمساحة فارغة منفصلة.",
    noUpload:
      "لا يرفع أي من الخيارين أو ينسخ أو يدمج أو يعيد كتابة Memory أو الجلسات أو الملفات أو المهارات أو ملف USER أو حالة التعلم.",
    useExisting: "استخدام البيانات المحلية الموجودة",
    createNew: "إنشاء مساحة جديدة",
    binding: "جارٍ الربط بأمان…",
    creating: "جارٍ إنشاء مساحة فارغة…",
    emptyBindingTitle: "جارٍ إعداد مساحتك الشخصية",
    emptyBindingDescription:
      "يتم ربط Profile المحلي الفارغ بحساب AgentEra الخاص بك.",
    connectionBindingTitle: "جارٍ تأمين اتصال Runtime",
    connectionBindingDescription:
      "يتم ربط الاتصال البعيد أو SSH بمالك AgentEra المسجل دخوله. لا تُرسل رموز المنتج إلى Runtime.",
    otherOwnerTitle: "هذه البيانات المحلية مملوكة لحساب آخر",
    otherOwnerDescription:
      "لن يفتح AgentEra هذا الـ Profile الفعلي أو يعيد تعيينه. أنشئ مساحة فارغة منفصلة أو سجّل الدخول بحساب مالكه.",
    remoteOtherOwnerTitle: "اتصال Runtime هذا مملوك لحساب آخر",
    remoteOtherOwnerDescription:
      "لن يرث AgentEra سياق الاتصال البعيد أو SSH للمالك السابق.",
    differentAccount: "تسجيل الدخول بحساب مختلف",
    failedTitle: "تعذر إعداد الوصول المحلي",
    failedDescription:
      "لم يتم تغيير أي بيانات Runtime خاصة. أعد التحقق من الملكية عندما تكون جاهزًا.",
    retry: "إعادة التحقق من الملكية",
  },
  offline: {
    title: "وضع محلي دون اتصال",
    description:
      "تتوقف ميزات الحساب السحابي مؤقتًا، بينما يستمر عمل Agent المحلي وواجهات النماذج وتعلّم Hermes حتى انتهاء التفويض الموقّع.",
  },
  account: {
    settingsNav: "حساب AgentEra",
    title: "حساب AgentEra",
    openMenu: "فتح قائمة حساب AgentEra",
    online: "متصل · تم التحقق",
    offline: "غير متصل · وصول محلي",
    manage: "إدارة الحساب",
    devices: "إدارة الأجهزة",
    recharge: "شحن API النماذج",
    switch: "تبديل الحساب",
    signOut: "تسجيل الخروج",
    actionFailed: "تعذر إكمال إجراء الحساب.",
    unavailable: "معلومات حساب AgentEra غير متاحة.",
    userId: "المستخدم",
    deviceId: "الجهاز",
    offlineUntil: "الوصول الموقّع دون اتصال صالح حتى {{date}}.",
    localDataWarning:
      "حذف الحساب السحابي أو تسجيل الخروج لا يحذف أو ينقل أو يرفع أو يفك ربط Profiles أو Memory أو الجلسات أو الملفات أو المهارات أو حالة تعلّم Hermes المحلية.",
    rechargeSeparateAccount:
      "يفتح الشحن موقع API النماذج المستقل؛ حساباته وأرصدته ومفاتيحه وملفات Cookie ورموزه منفصلة عن حساب AgentEra.",
    pendingRevocationWarning:
      "عند تسجيل الخروج أثناء تعذر الوصول إلى خدمة التحكم، قد يبقى الجهاز محسوبًا ضمن حد الأجهزة الخمسة حتى إرسال الإلغاء الموقّع تلقائيًا.",
  },
};

export default auth;
