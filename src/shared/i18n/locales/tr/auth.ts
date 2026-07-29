const auth = {
  gate: {
    title: "Aera'da oturum açın",
    checking: "Aera oturumunuz denetleniyor…",
    browserNote:
      "Kayıt, oturum açma ve parola kurtarma tarayıcınızda güvenle yapılır. Aera parolanızı veya doğrulama kodunuzu hiçbir zaman toplamaz.",
    openBrowser: "Oturum açmak veya kaydolmak için tarayıcıyı aç",
    waitingForBrowser: "Tarayıcı yetkilendirmesi bekleniyor…",
    cancel: "İptal",
    retry: "Yeniden dene",
    retrying: "Yeniden denetleniyor…",
    loginFailed:
      "Tarayıcı yetkilendirmesi tamamlanmadı. Lütfen yeniden deneyin.",
    retryFailed: "Aera oturumunuzu doğrulayamadı. Lütfen yeniden deneyin.",
    cancelled: "Tarayıcı yetkilendirmesi iptal edildi.",
    secureStorageTitle: "Güvenli depolama kullanılamıyor",
    secureStorageDescription:
      "Aera bu cihaz oturumunu güvenle saklayamıyor. Sistem anahtarlığını veya kimlik bilgisi hizmetini etkinleştirip yeniden deneyin. Düz metin depolama hiçbir zaman kullanılmaz.",
    reasons: {
      sign_in_required:
        "Aera'yu kullanmadan önce oturum açın veya hesap oluşturun.",
      offline_expired:
        "Yedi günlük çevrimdışı erişiminiz sona erdi. İnternete bağlanıp yeniden oturum açın.",
      clock_rollback:
        "Sistem saati beklenmedik şekilde değişti. Bu cihazı doğrulamak için internete bağlanın.",
      device_revoked:
        "Bu cihaz artık yetkili değil. Yeniden yetkilendirmek için oturum açın.",
      account_disabled:
        "Bu Aera hesabı devre dışı. Yardım için tarayıcıdaki hesap sayfasını kullanın.",
      account_pending_deletion:
        "Bu hesap silinmeyi bekliyor ve Aera'yu yetkilendiremez.",
      secure_storage_unavailable:
        "Aera oturumları için güvenli sistem depolaması gerekir.",
    },
  },
  profile: {
    checkingTitle: "Yerel veri erişimi denetleniyor",
    checkingDescription:
      "Aera özel Runtime içeriğinizi açmadan yalnızca sahiplik meta verilerini denetler.",
    title: "Yerel verilerinizi nasıl kullanacağınızı seçin",
    existingDescription:
      "Bu cihazda mevcut Aera Runtime verileri bulundu. Yerinde bağlayın veya ayrı bir boş alanla başlayın.",
    noUpload:
      "Her iki seçenek de Memory, oturumlar, dosyalar, beceriler, USER verileri veya öğrenme durumunuzu yüklemez, kopyalamaz, birleştirmez ya da yeniden yazmaz.",
    useExisting: "Mevcut yerel verileri kullan",
    createNew: "Yeni alan oluştur",
    binding: "Güvenle bağlanıyor…",
    creating: "Boş alan oluşturuluyor…",
    emptyBindingTitle: "Kişisel alanınız hazırlanıyor",
    emptyBindingDescription:
      "Yerel Ajan çalışma ortamı otomatik olarak hazırlanıyor.",
    connectionBindingTitle: "Bu Runtime bağlantısı güvenceye alınıyor",
    connectionBindingDescription:
      "Uzak veya SSH bağlantısı, oturum açmış Aera sahibine bağlanıyor. Ürün tokenları Runtime'a gönderilmez.",
    otherOwnerTitle: "Bu yerel veriler başka bir hesaba ait",
    otherOwnerDescription:
      "Aera başka bir hesaba ait yerel Ajan verilerini açmaz veya yeniden atamaz. Ayrı bir boş alan oluşturun ya da sahibiyle oturum açın.",
    remoteOtherOwnerTitle: "Bu Runtime bağlantısı başka bir hesaba ait",
    remoteOtherOwnerDescription:
      "Aera önceki sahibin uzak veya SSH bağlantı bağlamını devralmaz.",
    differentAccount: "Farklı bir hesapla oturum aç",
    failedTitle: "Yerel erişim hazırlanamadı",
    failedDescription:
      "Hiçbir özel Runtime verisi değiştirilmedi. Hazır olduğunuzda sahiplik denetimini yeniden deneyin.",
    retry: "Sahiplik denetimini yeniden dene",
  },
  offline: {
    title: "Yerel çevrimdışı mod",
    description:
      "Bulut hesap özellikleri duraklatıldı. Yerel Agent, model API'leri ve Aera Runtime öğrenmesi imzalı çevrimdışı süre dolana kadar kullanılabilir.",
  },
  account: {
    settingsNav: "Aera hesabı",
    title: "Aera hesabı",
    openMenu: "Aera hesap menüsünü aç",
    online: "Çevrimiçi · doğrulandı",
    offline: "Çevrimdışı · yerel erişim",
    manage: "Hesabı yönet",
    devices: "Cihazları yönet",
    recharge: "Model API bakiyesi yükle",
    switch: "Hesap değiştir",
    signOut: "Çıkış yap",
    actionFailed: "Bu hesap işlemi tamamlanamadı.",
    unavailable: "Aera hesap bilgileri kullanılamıyor.",
    userId: "Hesap kimliği",
    deviceId: "Cihaz",
    offlineUntil:
      "İmzalı çevrimdışı erişim {{date}} tarihine kadar geçerlidir.",
    localDataWarning:
      "Bulut hesabını silmek veya çıkış yapmak yerel Ajan verilerini, Memory, oturum, dosya, beceri ya da öğrenme durumunu silmez, taşımaz, yüklemez veya bağını kaldırmaz.",
    rechargeSeparateAccount:
      "Bakiye yükleme bağımsız model API sitesini açar. Hesapları, bakiyeleri, anahtarları, çerezleri ve tokenları Aera hesabından ayrıdır.",
    pendingRevocationWarning:
      "Kontrol hizmetine erişilemezken çıkış yapılırsa, imzalı iptal otomatik teslim edilene kadar cihaz beş cihaz sınırında sayılabilir.",
  },
};

export default auth;
