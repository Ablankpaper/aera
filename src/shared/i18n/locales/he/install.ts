export default {
  preparing: "מתכונן...",
  startingInstall: "מתחיל בהתקנה",
  installationComplete: "ההתקנה הושלמה",
  installationFailed: "ההתקנה נכשלה",
  installingHermes: "מתקין את AgentEra Runtime",
  retryInstallation: "נסה התקנה שוב",
  copied: "הועתק!",
  copyLogs: "העתקת היומנים",
  stepLabel: "שלב {{step}}/{{total}}: {{title}}",
  waitingToStart: "ממתין להתחלה...",
  continueToSetup: "המשך להגדרה",
  confirmTitle: "לפני ההתקנה",
  confirmLocationLabel: "‏AgentEra יותקן בנתיב:",
  confirmFresh: "לא נמצאה התקנה קיימת כאן - תוגדר עותק חדש.",
  confirmUpdate: "קיימת כאן התקנת AgentEra - היא תעודכן לגרסה האחרונה.",
  confirmReplace:
    "קיימת כאן תיקייה אך היא אינה התקנת AgentEra תקפה - ההתקנה תמחק ותחליף אותה.",
  confirmNotInherited:
    "אם התקנתם את AgentEra במקום אחר, או דרך שורת הפקודה, ההתקנה הזו לא תועבר.",
  confirmInstallBtn: "התקנת AgentEra",
  useExistingBtn: "שימוש ב-Runtime חיצוני קיים",
  useExistingHint:
    "בחרו את תיקיית הבית של Hermes שמכילה את hermes-agent. ה-Runtime יישאר חיצוני ולא מנוהל; עדכונים מפעילים רק את הפקודה המקומית של אותו checkout.",
  useExistingInvalid: "לא נמצאה התקנת AgentEra תקינה בתיקייה זו.",
  useExistingDone:
    "ה-Runtime החיצוני נבחר - צאו ופתחו מחדש את AgentEra כדי להחיל אותו. AgentEra Studio לא ישנה או ימחק את ה-checkout.",
  useExistingQuitBtn: "יציאה מ-AgentEra",
} as const;
