export default {
  preparing: "Przygotowywanie...",
  startingInstall: "Rozpoczynanie instalacji",
  installationComplete: "Instalacja zakończona",
  installationFailed: "Instalacja nie powiodła się",
  installingHermes: "Instalowanie Aera Runtime",
  retryInstallation: "Ponów instalację",
  copied: "Skopiowano!",
  copyLogs: "Kopiuj logi",
  stepLabel: "Krok {{step}}/{{total}}: {{title}}",
  waitingToStart: "Oczekiwanie na start...",
  continueToSetup: "Przejdź do konfiguracji",
  confirmTitle: "Przed instalacją",
  confirmLocationLabel: "Aera zostanie zainstalowany w:",
  confirmFresh:
    "Nie znaleziono tutaj istniejącej instalacji — zostanie przygotowana świeża kopia.",
  confirmUpdate:
    "Istniejąca instalacja Aera jest tutaj — zostanie zaktualizowana do najnowszej wersji.",
  confirmReplace:
    "Folder istnieje, ale nie jest poprawną instalacją Aera — instalacja usunie go i zastąpi.",
  confirmNotInherited:
    "Jeśli Aera został zainstalowany gdzie indziej albo przez wiersz poleceń, nie zostanie automatycznie przeniesiony.",
  confirmInstallBtn: "Zainstaluj Aera",
  useExistingBtn: "Użyj istniejącego zewnętrznego Runtime",
  useExistingHint:
    "Wybierz katalog domowy Aera Runtime zawierający hermes-agent. Ten Runtime pozostanie zewnętrzny i niezarządzany; aktualizacja uruchamia wyłącznie lokalne polecenie tego checkoutu.",
  useExistingInvalid:
    "W tym folderze nie znaleziono używalnej instalacji Aera.",
  useExistingDone:
    "Wybrano zewnętrzny Runtime — zamknij i ponownie otwórz Aera, aby go zastosować. Aera nie zmieni ani nie usunie tego checkoutu.",
  useExistingQuitBtn: "Zamknij Aera",
} as const;
