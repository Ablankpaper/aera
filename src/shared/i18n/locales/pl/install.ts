export default {
  preparing: "Przygotowywanie...",
  startingInstall: "Rozpoczynanie instalacji",
  installationComplete: "Instalacja zakończona",
  installationFailed: "Instalacja nie powiodła się",
  installingHermes: "Instalowanie AgentEra Runtime",
  retryInstallation: "Ponów instalację",
  copied: "Skopiowano!",
  copyLogs: "Kopiuj logi",
  stepLabel: "Krok {{step}}/{{total}}: {{title}}",
  waitingToStart: "Oczekiwanie na start...",
  continueToSetup: "Przejdź do konfiguracji",
  confirmTitle: "Przed instalacją",
  confirmLocationLabel: "AgentEra zostanie zainstalowany w:",
  confirmFresh:
    "Nie znaleziono tutaj istniejącej instalacji — zostanie przygotowana świeża kopia.",
  confirmUpdate:
    "Istniejąca instalacja AgentEra jest tutaj — zostanie zaktualizowana do najnowszej wersji.",
  confirmReplace:
    "Folder istnieje, ale nie jest poprawną instalacją AgentEra — instalacja usunie go i zastąpi.",
  confirmNotInherited:
    "Jeśli AgentEra został zainstalowany gdzie indziej albo przez wiersz poleceń, nie zostanie automatycznie przeniesiony.",
  confirmInstallBtn: "Zainstaluj AgentEra",
  useExistingBtn: "Użyj istniejącego zewnętrznego Runtime",
  useExistingHint:
    "Wybierz katalog domowy Hermes zawierający hermes-agent. Ten Runtime pozostanie zewnętrzny i niezarządzany; aktualizacja uruchamia wyłącznie lokalne polecenie tego checkoutu.",
  useExistingInvalid:
    "W tym folderze nie znaleziono używalnej instalacji AgentEra.",
  useExistingDone:
    "Wybrano zewnętrzny Runtime — zamknij i ponownie otwórz AgentEra, aby go zastosować. AgentEra Studio nie zmieni ani nie usunie tego checkoutu.",
  useExistingQuitBtn: "Zamknij AgentEra",
} as const;
