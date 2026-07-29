const auth = {
  gate: {
    title: "כניסה ל-Aera",
    checking: "בודק את הפעלת Aera שלך…",
    browserNote:
      "הרשמה, כניסה ושחזור סיסמה מתבצעים באופן מאובטח בדפדפן. Aera לעולם אינו אוסף את הסיסמה או את קוד האימות שלך.",
    openBrowser: "פתיחת הדפדפן לכניסה או להרשמה",
    waitingForBrowser: "ממתין לאישור בדפדפן…",
    cancel: "ביטול",
    retry: "ניסיון חוזר",
    retrying: "בודק שוב…",
    loginFailed: "האישור בדפדפן לא הושלם. יש לנסות שוב.",
    retryFailed: "Aera לא הצליח לאמת את ההפעלה. יש לנסות שוב.",
    cancelled: "האישור בדפדפן בוטל.",
    secureStorageTitle: "אחסון מאובטח אינו זמין",
    secureStorageDescription:
      "Aera אינו יכול לשמור את הפעלת המכשיר בבטחה. יש להפעיל את מחזיק המפתחות או שירות האישורים של המערכת ולנסות שוב. לעולם לא נעשה שימוש באחסון טקסט גלוי.",
    reasons: {
      sign_in_required:
        "יש להיכנס או ליצור חשבון לפני השימוש ב-Aera.",
      offline_expired:
        "תוקף הגישה הלא-מקוונת לשבעה ימים פג. יש להתחבר לאינטרנט ולהיכנס שוב.",
      clock_rollback:
        "שעון המערכת השתנה באופן בלתי צפוי. יש להתחבר לאינטרנט כדי לאמת את המכשיר.",
      device_revoked:
        "המכשיר הזה אינו מורשה עוד. יש להיכנס כדי לאשר אותו מחדש.",
      account_disabled:
        "חשבון Aera זה מושבת כעת. לקבלת עזרה יש להשתמש בדף החשבון בדפדפן.",
      account_pending_deletion:
        "החשבון ממתין למחיקה ואינו יכול לאשר את Aera.",
      secure_storage_unavailable: "הפעלות Aera דורשות אחסון מערכת מאובטח.",
    },
  },
  profile: {
    checkingTitle: "בודק גישה לנתונים המקומיים",
    checkingDescription:
      "Aera בודק רק מטא-נתוני בעלות מבלי לפתוח תוכן Runtime פרטי.",
    title: "בחירת אופן השימוש בנתונים המקומיים",
    existingDescription:
      "נמצאו במכשיר נתוני Aera Runtime קיימים. אפשר לקשר אותם במקום או להתחיל במרחב ריק ונפרד.",
    noUpload:
      "אף אפשרות אינה מעלה, מעתיקה, ממזגת או משכתבת את ה-Memory, ההפעלות, הקבצים, המיומנויות, נתוני USER או מצב הלמידה.",
    useExisting: "שימוש בנתונים המקומיים הקיימים",
    createNew: "יצירת מרחב חדש",
    binding: "מקשר באופן מאובטח…",
    creating: "יוצר מרחב ריק…",
    emptyBindingTitle: "מכין את המרחב האישי שלך",
    emptyBindingDescription: "סביבת ההפעלה של הסוכן המקומי מוכנה אוטומטית.",
    connectionBindingTitle: "מאבטח את חיבור ה-Runtime",
    connectionBindingDescription:
      "החיבור המרוחק או חיבור SSH מקושר לבעל חשבון Aera המחובר. אסימוני המוצר אינם נשלחים ל-Runtime.",
    otherOwnerTitle: "הנתונים המקומיים האלה שייכים לחשבון אחר",
    otherOwnerDescription:
      "Aera לא יפתח ולא יקצה מחדש נתוני סוכן מקומי השייכים לחשבון אחר. יש ליצור מרחב ריק נפרד או להיכנס כבעלים שלו.",
    remoteOtherOwnerTitle: "חיבור ה-Runtime הזה שייך לחשבון אחר",
    remoteOtherOwnerDescription:
      "Aera לא יירש את הקשר החיבור המרוחק או SSH של הבעלים הקודם.",
    differentAccount: "כניסה באמצעות חשבון אחר",
    failedTitle: "לא ניתן היה להכין גישה מקומית",
    failedDescription:
      "לא שונו נתוני Runtime פרטיים. אפשר לנסות שוב את בדיקת הבעלות.",
    retry: "בדיקה חוזרת של הבעלות",
  },
  offline: {
    title: "מצב מקומי לא מקוון",
    description:
      "תכונות החשבון בענן מושהות. עבודה מקומית, ממשקי מודלים ולמידת Aera Runtime ממשיכים עד מועד ההרשאה החתומה.",
  },
  account: {
    settingsNav: "חשבון Aera",
    title: "חשבון Aera",
    openMenu: "פתיחת תפריט חשבון Aera",
    online: "מקוון · מאומת",
    offline: "לא מקוון · גישה מקומית",
    manage: "ניהול חשבון",
    devices: "ניהול מכשירים",
    recharge: "טעינת API למודלים",
    switch: "החלפת חשבון",
    signOut: "יציאה",
    actionFailed: "לא ניתן להשלים את פעולת החשבון.",
    unavailable: "פרטי חשבון Aera אינם זמינים.",
    userId: "מזהה חשבון",
    deviceId: "מכשיר",
    offlineUntil: "הגישה החתומה הלא מקוונת תקפה עד {{date}}.",
    localDataWarning:
      "מחיקת חשבון הענן או יציאה אינן מוחקות, מעבירות, מעלות או מנתקות נתוני סוכנים מקומיים, Memory, הפעלות, קבצים, מיומנויות או למידת Aera Runtime.",
    rechargeSeparateAccount:
      "הטעינה פותחת אתר API עצמאי; החשבונות, היתרות, המפתחות, העוגיות והאסימונים שלו נפרדים מחשבון Aera.",
    pendingRevocationWarning:
      "ביציאה כאשר שירות הבקרה אינו זמין, המכשיר עשוי להיספר במגבלת חמשת המכשירים עד למסירת הביטול החתום אוטומטית.",
  },
};

export default auth;
