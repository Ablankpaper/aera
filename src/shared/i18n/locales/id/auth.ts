const auth = {
  gate: {
    title: "Masuk ke Aera",
    checking: "Memeriksa sesi Aera Anda…",
    browserNote:
      "Pendaftaran, masuk, dan pemulihan kata sandi dibuka dengan aman di browser. Aera tidak pernah mengumpulkan kata sandi atau kode verifikasi Anda.",
    openBrowser: "Buka browser untuk masuk atau mendaftar",
    waitingForBrowser: "Menunggu otorisasi browser…",
    cancel: "Batal",
    retry: "Coba lagi",
    retrying: "Memeriksa kembali…",
    loginFailed: "Otorisasi browser tidak selesai. Silakan coba lagi.",
    retryFailed:
      "Aera tidak dapat memverifikasi sesi Anda. Silakan coba lagi.",
    cancelled: "Otorisasi browser dibatalkan.",
    secureStorageTitle: "Penyimpanan aman tidak tersedia",
    secureStorageDescription:
      "Aera tidak dapat menyimpan sesi perangkat ini dengan aman. Aktifkan gantungan kunci atau layanan kredensial sistem, lalu coba lagi. Penyimpanan teks biasa tidak pernah digunakan.",
    reasons: {
      sign_in_required:
        "Masuk atau buat akun sebelum menggunakan Aera.",
      offline_expired:
        "Akses offline tujuh hari telah berakhir. Sambungkan internet dan masuk lagi.",
      clock_rollback:
        "Waktu sistem berubah secara tidak terduga. Sambungkan internet untuk memverifikasi perangkat ini.",
      device_revoked:
        "Perangkat ini tidak lagi diotorisasi. Masuk untuk mengotorisasinya kembali.",
      account_disabled:
        "Akun Aera ini sedang dinonaktifkan. Gunakan halaman akun di browser untuk bantuan.",
      account_pending_deletion:
        "Akun ini menunggu penghapusan dan tidak dapat mengotorisasi Aera.",
      secure_storage_unavailable:
        "Sesi Aera memerlukan penyimpanan sistem yang aman.",
    },
  },
  profile: {
    checkingTitle: "Memeriksa akses data lokal",
    checkingDescription:
      "Aera hanya memeriksa metadata kepemilikan tanpa membuka konten Runtime pribadi Anda.",
    title: "Pilih cara menggunakan data lokal",
    existingDescription:
      "Data Aera Runtime yang ada ditemukan di perangkat ini. Ikat di tempat atau mulai dengan ruang kosong yang terpisah.",
    noUpload:
      "Kedua pilihan tidak mengunggah, menyalin, menggabungkan, atau menulis ulang Memory, sesi, file, skill, data USER, maupun status pembelajaran Anda.",
    useExisting: "Gunakan data lokal yang ada",
    createNew: "Buat ruang baru",
    binding: "Mengikat dengan aman…",
    creating: "Membuat ruang kosong…",
    emptyBindingTitle: "Menyiapkan ruang pribadi Anda",
    emptyBindingDescription:
      "Lingkungan runtime Agen lokal sedang disiapkan secara otomatis.",
    connectionBindingTitle: "Mengamankan koneksi Runtime ini",
    connectionBindingDescription:
      "Koneksi jarak jauh atau SSH sedang diikat ke pemilik Aera yang masuk. Token produk tidak dikirim ke Runtime.",
    otherOwnerTitle: "Data lokal ini milik akun lain",
    otherOwnerDescription:
      "Aera tidak akan membuka atau memindahkan data Agen lokal milik akun lain. Buat ruang kosong terpisah atau masuk sebagai pemiliknya.",
    remoteOtherOwnerTitle: "Koneksi Runtime ini milik akun lain",
    remoteOtherOwnerDescription:
      "Aera tidak akan mewarisi konteks jarak jauh atau SSH milik pengguna sebelumnya.",
    differentAccount: "Masuk dengan akun lain",
    failedTitle: "Akses lokal tidak dapat disiapkan",
    failedDescription:
      "Tidak ada data Runtime pribadi yang diubah. Coba pemeriksaan kepemilikan lagi saat siap.",
    retry: "Coba pemeriksaan kepemilikan lagi",
  },
  offline: {
    title: "Mode lokal offline",
    description:
      "Fitur akun cloud dijeda. Agent lokal, API model, dan pembelajaran Aera Runtime tetap tersedia sampai batas offline bertanda tangan.",
  },
  account: {
    settingsNav: "Akun Aera",
    title: "Akun Aera",
    openMenu: "Buka menu akun Aera",
    online: "Online · terverifikasi",
    offline: "Offline · akses lokal",
    manage: "Kelola akun",
    devices: "Kelola perangkat",
    recharge: "Isi saldo API model",
    switch: "Ganti akun",
    signOut: "Keluar",
    actionFailed: "Tindakan akun ini tidak dapat diselesaikan.",
    unavailable: "Informasi akun Aera tidak tersedia.",
    userId: "ID akun",
    deviceId: "Perangkat",
    offlineUntil: "Akses offline bertanda tangan berlaku hingga {{date}}.",
    localDataWarning:
      "Menghapus akun cloud atau keluar tidak menghapus, memindahkan, mengunggah, atau melepas ikatan data Agen lokal, Memory, sesi, file, skill, maupun pembelajaran Aera Runtime.",
    rechargeSeparateAccount:
      "Isi saldo membuka situs API model yang terpisah. Akun, saldo, API key, cookie, dan tokennya terpisah dari akun Aera.",
    pendingRevocationWarning:
      "Jika keluar saat layanan kontrol tidak terjangkau, perangkat mungkin tetap dihitung dalam batas lima perangkat sampai pencabutan bertanda tangan terkirim otomatis.",
  },
};

export default auth;
