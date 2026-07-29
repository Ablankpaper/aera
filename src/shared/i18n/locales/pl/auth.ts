const auth = {
  gate: {
    title: "Zaloguj się do Aera",
    checking: "Sprawdzanie sesji Aera…",
    browserNote:
      "Rejestracja, logowanie i odzyskiwanie hasła odbywają się bezpiecznie w przeglądarce. Aera nigdy nie zbiera hasła ani kodu weryfikacyjnego.",
    openBrowser: "Otwórz przeglądarkę, aby się zalogować lub zarejestrować",
    waitingForBrowser: "Oczekiwanie na autoryzację w przeglądarce…",
    cancel: "Anuluj",
    retry: "Spróbuj ponownie",
    retrying: "Ponowne sprawdzanie…",
    loginFailed:
      "Autoryzacja w przeglądarce nie została ukończona. Spróbuj ponownie.",
    retryFailed: "Aera nie mogła zweryfikować sesji. Spróbuj ponownie.",
    cancelled: "Autoryzacja w przeglądarce została anulowana.",
    secureStorageTitle: "Bezpieczny magazyn jest niedostępny",
    secureStorageDescription:
      "Aera nie może bezpiecznie zapisać sesji tego urządzenia. Włącz systemowy pęk kluczy lub usługę poświadczeń i spróbuj ponownie. Dane nigdy nie są zapisywane jawnym tekstem.",
    reasons: {
      sign_in_required:
        "Zaloguj się lub utwórz konto przed użyciem Aera.",
      offline_expired:
        "Siedmiodniowy dostęp offline wygasł. Połącz się z internetem i zaloguj ponownie.",
      clock_rollback:
        "Czas systemowy zmienił się nieoczekiwanie. Połącz się z internetem, aby zweryfikować urządzenie.",
      device_revoked:
        "To urządzenie nie jest już autoryzowane. Zaloguj się, aby autoryzować je ponownie.",
      account_disabled:
        "To konto Aera jest wyłączone. Skorzystaj ze strony konta w przeglądarce.",
      account_pending_deletion:
        "To konto oczekuje na usunięcie i nie może autoryzować Aera.",
      secure_storage_unavailable:
        "Sesje Aera wymagają bezpiecznego magazynu systemowego.",
    },
  },
  profile: {
    checkingTitle: "Sprawdzanie dostępu do danych lokalnych",
    checkingDescription:
      "Aera sprawdza wyłącznie metadane właściciela i nie otwiera prywatnej zawartości Runtime.",
    title: "Wybierz sposób użycia danych lokalnych",
    existingDescription:
      "Na tym urządzeniu znaleziono dane Aera Runtime. Możesz powiązać je w miejscu lub utworzyć oddzielną pustą przestrzeń.",
    noUpload:
      "Żadna opcja nie przesyła, nie kopiuje, nie scala ani nie nadpisuje Memory, sesji, plików, umiejętności, danych USER ani stanu uczenia.",
    useExisting: "Użyj istniejących danych lokalnych",
    createNew: "Utwórz nową przestrzeń",
    binding: "Bezpieczne powiązywanie…",
    creating: "Tworzenie pustej przestrzeni…",
    emptyBindingTitle: "Przygotowywanie przestrzeni osobistej",
    emptyBindingDescription:
      "Lokalne środowisko Agenta jest przygotowywane automatycznie.",
    connectionBindingTitle: "Zabezpieczanie połączenia Runtime",
    connectionBindingDescription:
      "Połączenie zdalne lub SSH jest wiązane z zalogowanym właścicielem Aera. Tokeny produktu nie są wysyłane do Runtime.",
    otherOwnerTitle: "Te dane lokalne należą do innego konta",
    otherOwnerDescription:
      "Aera nie otworzy ani nie przypisze ponownie lokalnych danych Agenta należących do innego konta. Utwórz oddzielną pustą przestrzeń lub zaloguj się jako właściciel.",
    remoteOtherOwnerTitle: "To połączenie Runtime należy do innego konta",
    remoteOtherOwnerDescription:
      "Aera nie odziedziczy kontekstu zdalnego ani SSH poprzedniego właściciela.",
    differentAccount: "Zaloguj się na inne konto",
    failedTitle: "Nie udało się przygotować dostępu lokalnego",
    failedDescription:
      "Żadne prywatne dane Runtime nie zostały zmienione. Spróbuj ponownie sprawdzić właściciela.",
    retry: "Ponów sprawdzanie właściciela",
  },
  offline: {
    title: "Lokalny tryb offline",
    description:
      "Funkcje konta w chmurze są wstrzymane. Lokalny Agent, API modeli i uczenie Aera Runtime działają do końca podpisanego okresu offline.",
  },
  account: {
    settingsNav: "Konto Aera",
    title: "Konto Aera",
    openMenu: "Otwórz menu konta Aera",
    online: "Online · zweryfikowano",
    offline: "Offline · dostęp lokalny",
    manage: "Zarządzaj kontem",
    devices: "Zarządzaj urządzeniami",
    recharge: "Doładuj API modeli",
    switch: "Przełącz konto",
    signOut: "Wyloguj",
    actionFailed: "Nie udało się wykonać operacji na koncie.",
    unavailable: "Informacje o koncie Aera są niedostępne.",
    userId: "Identyfikator konta",
    deviceId: "Urządzenie",
    offlineUntil: "Podpisany dostęp offline jest ważny do {{date}}.",
    localDataWarning:
      "Usunięcie konta w chmurze lub wylogowanie nie usuwa, przenosi, wysyła ani odłącza lokalnych danych Agentów, Memory, sesji, plików, umiejętności ani nauki Aera Runtime.",
    rechargeSeparateAccount:
      "Doładowanie otwiera niezależny serwis API modeli. Jego konta, salda, klucze, cookies i tokeny są oddzielne od Aera.",
    pendingRevocationWarning:
      "Wylogowanie bez dostępu do usługi sterującej może pozostawić urządzenie w limicie pięciu do czasu automatycznego dostarczenia podpisanego odwołania.",
  },
};

export default auth;
