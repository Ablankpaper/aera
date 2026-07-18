export default {
  preparing: "Menyiapkan...",
  startingInstall: "Memulai instalasi",
  installationComplete: "Instalasi Selesai",
  installationFailed: "Instalasi Gagal",
  installingHermes: "Menginstal AgentEra Runtime",
  retryInstallation: "Ulangi Instalasi",
  copied: "Tersalin!",
  copyLogs: "Salin Log",
  stepLabel: "Langkah {{step}}/{{total}}: {{title}}",
  waitingToStart: "Menunggu untuk mulai...",
  continueToSetup: "Lanjut ke Setup",
  confirmTitle: "Sebelum memasang",
  confirmLocationLabel: "AgentEra akan dipasang di:",
  confirmFresh:
    "Tidak ada pemasangan yang ditemukan di sini — salinan baru akan disiapkan.",
  confirmUpdate:
    "Ada pemasangan AgentEra di sini — akan diperbarui ke versi terbaru.",
  confirmReplace:
    "Ada folder di sini tetapi bukan pemasangan AgentEra yang valid — memasang akan menghapus dan menggantinya.",
  confirmNotInherited:
    "Jika Anda memasang AgentEra di tempat lain, atau melalui baris perintah, itu tidak akan dibawa serta.",
  confirmInstallBtn: "Pasang AgentEra",
  useExistingBtn: "Gunakan Runtime eksternal yang ada",
  useExistingHint:
    "Pilih folder utama Hermes yang memuat hermes-agent. Runtime ini tetap eksternal dan tidak dikelola; pembaruan hanya menjalankan perintah lokal checkout tersebut.",
  useExistingInvalid:
    "Tidak ada pemasangan AgentEra yang dapat digunakan di folder itu.",
  useExistingDone:
    "Runtime eksternal dipilih — tutup dan buka kembali AgentEra untuk menerapkannya. AgentEra Studio tidak akan mengubah atau menghapus checkout tersebut.",
  useExistingQuitBtn: "Keluar dari AgentEra",
} as const;
