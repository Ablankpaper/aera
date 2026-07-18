export default {
  preparing: "Hazırlanıyor...",
  startingInstall: "Kurulum başlatılıyor",
  installationComplete: "Kurulum Tamamlandı",
  installationFailed: "Kurulum Başarısız",
  installingHermes: "AgentEra Runtime Kuruluyor",
  retryInstallation: "Kurulumu Tekrar Dene",
  copied: "Kopyalandı!",
  copyLogs: "Günlükleri Kopyala",
  stepLabel: "Adım {{step}}/{{total}}: {{title}}",
  waitingToStart: "Başlamayı bekliyor...",
  continueToSetup: "Kuruluma Devam Et",
  confirmTitle: "Kurmadan Önce",
  confirmLocationLabel: "AgentEra şuraya kurulacak:",
  confirmFresh:
    "Burada mevcut bir kurulum bulunamadı — yeni bir kopya oluşturulacak.",
  confirmUpdate:
    "Burada mevcut bir AgentEra kurulumu var — en son sürüme güncellenecek.",
  confirmReplace:
    "Burada bir klasör var ancak geçerli bir AgentEra kurulumu değil — kurulum bu klasörü silip yenisiyle değiştirecektir.",
  confirmNotInherited:
    "AgentEra'i başka bir yere veya komut satırından kurduysanız, buraya taşınmayacaktır.",
  confirmInstallBtn: "AgentEra'i Kur",
  useExistingBtn: "Mevcut harici Runtime'ı kullan",
  useExistingHint:
    "hermes-agent klasörünü içeren Hermes ana klasörünü seçin. Bu Runtime harici ve yönetilmeyen olarak kalır; güncelleme yalnızca o checkout'ın yerel komutunu çalıştırır.",
  useExistingInvalid:
    "Bu klasörde kullanılabilir bir AgentEra kurulumu bulunamadı.",
  useExistingDone:
    "Harici Runtime seçildi — uygulamak için AgentEra'i kapatıp yeniden açın. AgentEra Studio bu checkout'ı değiştirmez veya silmez.",
  useExistingQuitBtn: "AgentEra'ten Çık",
} as const;
