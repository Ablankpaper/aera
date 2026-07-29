export default {
  preparing: "Hazırlanıyor...",
  startingInstall: "Kurulum başlatılıyor",
  installationComplete: "Kurulum Tamamlandı",
  installationFailed: "Kurulum Başarısız",
  installingHermes: "Aera Runtime Kuruluyor",
  retryInstallation: "Kurulumu Tekrar Dene",
  copied: "Kopyalandı!",
  copyLogs: "Günlükleri Kopyala",
  stepLabel: "Adım {{step}}/{{total}}: {{title}}",
  waitingToStart: "Başlamayı bekliyor...",
  continueToSetup: "Kuruluma Devam Et",
  confirmTitle: "Kurmadan Önce",
  confirmLocationLabel: "Aera şuraya kurulacak:",
  confirmFresh:
    "Burada mevcut bir kurulum bulunamadı — yeni bir kopya oluşturulacak.",
  confirmUpdate:
    "Burada mevcut bir Aera kurulumu var — en son sürüme güncellenecek.",
  confirmReplace:
    "Burada bir klasör var ancak geçerli bir Aera kurulumu değil — kurulum bu klasörü silip yenisiyle değiştirecektir.",
  confirmNotInherited:
    "Aera'i başka bir yere veya komut satırından kurduysanız, buraya taşınmayacaktır.",
  confirmInstallBtn: "Aera'i Kur",
  useExistingBtn: "Mevcut harici Runtime'ı kullan",
  useExistingHint:
    "hermes-agent klasörünü içeren Aera Runtime ana klasörünü seçin. Bu Runtime harici ve yönetilmeyen olarak kalır; güncelleme yalnızca o checkout'ın yerel komutunu çalıştırır.",
  useExistingInvalid:
    "Bu klasörde kullanılabilir bir Aera kurulumu bulunamadı.",
  useExistingDone:
    "Harici Runtime seçildi — uygulamak için Aera'i kapatıp yeniden açın. Aera bu checkout'ı değiştirmez veya silmez.",
  useExistingQuitBtn: "Aera'ten Çık",
} as const;
