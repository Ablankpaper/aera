const auth = {
  gate: {
    title: "AgentEra'da oturum açın",
    checking: "AgentEra oturumunuz denetleniyor…",
    browserNote:
      "Kayıt, oturum açma ve parola kurtarma tarayıcınızda güvenle yapılır. AgentEra Studio parolanızı veya doğrulama kodunuzu hiçbir zaman toplamaz.",
    openBrowser: "Oturum açmak veya kaydolmak için tarayıcıyı aç",
    waitingForBrowser: "Tarayıcı yetkilendirmesi bekleniyor…",
    cancel: "İptal",
    retry: "Yeniden dene",
    retrying: "Yeniden denetleniyor…",
    loginFailed:
      "Tarayıcı yetkilendirmesi tamamlanmadı. Lütfen yeniden deneyin.",
    retryFailed: "AgentEra oturumunuzu doğrulayamadı. Lütfen yeniden deneyin.",
    cancelled: "Tarayıcı yetkilendirmesi iptal edildi.",
    secureStorageTitle: "Güvenli depolama kullanılamıyor",
    secureStorageDescription:
      "AgentEra bu cihaz oturumunu güvenle saklayamıyor. Sistem anahtarlığını veya kimlik bilgisi hizmetini etkinleştirip yeniden deneyin. Düz metin depolama hiçbir zaman kullanılmaz.",
    reasons: {
      sign_in_required:
        "AgentEra Studio'yu kullanmadan önce oturum açın veya hesap oluşturun.",
      offline_expired:
        "Yedi günlük çevrimdışı erişiminiz sona erdi. İnternete bağlanıp yeniden oturum açın.",
      clock_rollback:
        "Sistem saati beklenmedik şekilde değişti. Bu cihazı doğrulamak için internete bağlanın.",
      device_revoked:
        "Bu cihaz artık yetkili değil. Yeniden yetkilendirmek için oturum açın.",
      account_disabled:
        "Bu AgentEra hesabı devre dışı. Yardım için tarayıcıdaki hesap sayfasını kullanın.",
      account_pending_deletion:
        "Bu hesap silinmeyi bekliyor ve AgentEra Studio'yu yetkilendiremez.",
      secure_storage_unavailable:
        "AgentEra oturumları için güvenli sistem depolaması gerekir.",
    },
  },
  profile: {
    checkingTitle: "Yerel veri erişimi denetleniyor",
    checkingDescription:
      "AgentEra özel Runtime içeriğinizi açmadan yalnızca sahiplik meta verilerini denetler.",
    title: "Yerel verilerinizi nasıl kullanacağınızı seçin",
    existingDescription:
      "Bu cihazda mevcut AgentEra Runtime verileri bulundu. Yerinde bağlayın veya ayrı bir boş alanla başlayın.",
    noUpload:
      "Her iki seçenek de Memory, oturumlar, dosyalar, beceriler, USER profili veya öğrenme durumunuzu yüklemez, kopyalamaz, birleştirmez ya da yeniden yazmaz.",
    useExisting: "Mevcut yerel verileri kullan",
    createNew: "Yeni alan oluştur",
    binding: "Güvenle bağlanıyor…",
    creating: "Boş alan oluşturuluyor…",
    emptyBindingTitle: "Kişisel alanınız hazırlanıyor",
    emptyBindingDescription:
      "Bu boş yerel Profile, AgentEra hesabınıza bağlanıyor.",
    connectionBindingTitle: "Bu Runtime bağlantısı güvenceye alınıyor",
    connectionBindingDescription:
      "Uzak veya SSH bağlantısı, oturum açmış AgentEra sahibine bağlanıyor. Ürün tokenları Runtime'a gönderilmez.",
    otherOwnerTitle: "Bu yerel veriler başka bir hesaba ait",
    otherOwnerDescription:
      "AgentEra bu fiziksel Profile'ı açmaz veya başka hesaba atamaz. Ayrı bir boş alan oluşturun ya da sahibiyle oturum açın.",
    remoteOtherOwnerTitle: "Bu Runtime bağlantısı başka bir hesaba ait",
    remoteOtherOwnerDescription:
      "AgentEra önceki sahibin uzak veya SSH bağlantı bağlamını devralmaz.",
    differentAccount: "Farklı bir hesapla oturum aç",
    failedTitle: "Yerel erişim hazırlanamadı",
    failedDescription:
      "Hiçbir özel Runtime verisi değiştirilmedi. Hazır olduğunuzda sahiplik denetimini yeniden deneyin.",
    retry: "Sahiplik denetimini yeniden dene",
  },
};

export default auth;
