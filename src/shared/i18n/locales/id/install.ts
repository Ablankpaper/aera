export default {
  preparing: "Menyiapkan...",
  startingInstall: "Memulai instalasi",
  installationComplete: "Instalasi Selesai",
  installationFailed: "Instalasi Gagal",
  installingHermes: "Menginstal Aera Runtime",
  retryInstallation: "Ulangi Instalasi",
  copied: "Tersalin!",
  copyLogs: "Salin Log",
  stepLabel: "Langkah {{step}}/{{total}}: {{title}}",
  waitingToStart: "Menunggu untuk mulai...",
  continueToSetup: "Lanjut ke Setup",
  confirmTitle: "Sebelum memasang",
  confirmLocationLabel: "Aera akan dipasang di:",
  confirmFresh:
    "Tidak ada pemasangan yang ditemukan di sini — salinan baru akan disiapkan.",
  confirmUpdate:
    "Ada pemasangan Aera di sini — akan diperbarui ke versi terbaru.",
  confirmReplace:
    "Ada folder di sini tetapi bukan pemasangan Aera yang valid — memasang akan menghapus dan menggantinya.",
  confirmNotInherited:
    "Jika Anda memasang Aera di tempat lain, atau melalui baris perintah, itu tidak akan dibawa serta.",
  confirmInstallBtn: "Pasang Aera",
  useExistingBtn: "Gunakan Runtime eksternal yang ada",
  useExistingHint:
    "Pilih folder utama Aera Runtime yang memuat hermes-agent. Runtime ini tetap eksternal dan tidak dikelola; pembaruan hanya menjalankan perintah lokal checkout tersebut.",
  useExistingInvalid:
    "Tidak ada pemasangan Aera yang dapat digunakan di folder itu.",
  useExistingDone:
    "Runtime eksternal dipilih — tutup dan buka kembali Aera untuk menerapkannya. Aera tidak akan mengubah atau menghapus checkout tersebut.",
  useExistingQuitBtn: "Keluar dari Aera",
} as const;
