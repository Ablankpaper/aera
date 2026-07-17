const auth = {
  gate: {
    title: "Masuk ke AgentEra",
    checking: "Memeriksa sesi AgentEra Anda…",
    browserNote:
      "Pendaftaran, masuk, dan pemulihan kata sandi dibuka dengan aman di browser. AgentEra Studio tidak pernah mengumpulkan kata sandi atau kode verifikasi Anda.",
    openBrowser: "Buka browser untuk masuk atau mendaftar",
    waitingForBrowser: "Menunggu otorisasi browser…",
    cancel: "Batal",
    retry: "Coba lagi",
    retrying: "Memeriksa kembali…",
    loginFailed: "Otorisasi browser tidak selesai. Silakan coba lagi.",
    retryFailed:
      "AgentEra tidak dapat memverifikasi sesi Anda. Silakan coba lagi.",
    cancelled: "Otorisasi browser dibatalkan.",
    secureStorageTitle: "Penyimpanan aman tidak tersedia",
    secureStorageDescription:
      "AgentEra tidak dapat menyimpan sesi perangkat ini dengan aman. Aktifkan gantungan kunci atau layanan kredensial sistem, lalu coba lagi. Penyimpanan teks biasa tidak pernah digunakan.",
    reasons: {
      sign_in_required:
        "Masuk atau buat akun sebelum menggunakan AgentEra Studio.",
      offline_expired:
        "Akses offline tujuh hari telah berakhir. Sambungkan internet dan masuk lagi.",
      clock_rollback:
        "Waktu sistem berubah secara tidak terduga. Sambungkan internet untuk memverifikasi perangkat ini.",
      device_revoked:
        "Perangkat ini tidak lagi diotorisasi. Masuk untuk mengotorisasinya kembali.",
      account_disabled:
        "Akun AgentEra ini sedang dinonaktifkan. Gunakan halaman akun di browser untuk bantuan.",
      account_pending_deletion:
        "Akun ini menunggu penghapusan dan tidak dapat mengotorisasi AgentEra Studio.",
      secure_storage_unavailable:
        "Sesi AgentEra memerlukan penyimpanan sistem yang aman.",
    },
  },
  profile: {
    checkingTitle: "Memeriksa akses data lokal",
    checkingDescription:
      "AgentEra hanya memeriksa metadata kepemilikan tanpa membuka konten Runtime pribadi Anda.",
    title: "Pilih cara menggunakan data lokal",
    existingDescription:
      "Data AgentEra Runtime yang ada ditemukan di perangkat ini. Ikat di tempat atau mulai dengan ruang kosong yang terpisah.",
    noUpload:
      "Kedua pilihan tidak mengunggah, menyalin, menggabungkan, atau menulis ulang Memory, sesi, file, skill, profil USER, maupun status pembelajaran Anda.",
    useExisting: "Gunakan data lokal yang ada",
    createNew: "Buat ruang baru",
    binding: "Mengikat dengan aman…",
    creating: "Membuat ruang kosong…",
    emptyBindingTitle: "Menyiapkan ruang pribadi Anda",
    emptyBindingDescription:
      "Profile lokal kosong ini sedang diikat ke akun AgentEra Anda.",
    connectionBindingTitle: "Mengamankan koneksi Runtime ini",
    connectionBindingDescription:
      "Koneksi jarak jauh atau SSH sedang diikat ke pemilik AgentEra yang masuk. Token produk tidak dikirim ke Runtime.",
    otherOwnerTitle: "Data lokal ini milik akun lain",
    otherOwnerDescription:
      "AgentEra tidak akan membuka atau memindahkan kepemilikan Profile fisik ini. Buat ruang kosong terpisah atau masuk sebagai pemiliknya.",
    remoteOtherOwnerTitle: "Koneksi Runtime ini milik akun lain",
    remoteOtherOwnerDescription:
      "AgentEra tidak akan mewarisi konteks jarak jauh atau SSH milik pengguna sebelumnya.",
    differentAccount: "Masuk dengan akun lain",
    failedTitle: "Akses lokal tidak dapat disiapkan",
    failedDescription:
      "Tidak ada data Runtime pribadi yang diubah. Coba pemeriksaan kepemilikan lagi saat siap.",
    retry: "Coba pemeriksaan kepemilikan lagi",
  },
};

export default auth;
