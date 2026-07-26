const auth = {
  gate: {
    title: "Iniciar sesión en AgentEra",
    checking: "Comprobando tu sesión de AgentEra…",
    browserNote:
      "El registro, el inicio de sesión y la recuperación de contraseña se realizan de forma segura en el navegador. AgentEra Studio nunca recopila tu contraseña ni el código de verificación.",
    openBrowser: "Abrir el navegador para entrar o registrarse",
    waitingForBrowser: "Esperando la autorización del navegador…",
    cancel: "Cancelar",
    retry: "Reintentar",
    retrying: "Comprobando de nuevo…",
    loginFailed: "La autorización no terminó. Inténtalo de nuevo.",
    retryFailed: "AgentEra no pudo verificar tu sesión. Inténtalo de nuevo.",
    cancelled: "Se canceló la autorización del navegador.",
    secureStorageTitle: "El almacenamiento seguro no está disponible",
    secureStorageDescription:
      "AgentEra no puede guardar esta sesión de forma segura. Activa el llavero o servicio de credenciales del sistema y vuelve a intentarlo. Nunca se usa almacenamiento en texto plano.",
    reasons: {
      sign_in_required:
        "Inicia sesión o crea una cuenta antes de usar AgentEra Studio.",
      offline_expired:
        "El acceso sin conexión de siete días caducó. Conéctate e inicia sesión de nuevo.",
      clock_rollback:
        "La hora del sistema cambió de forma inesperada. Conéctate para verificar el dispositivo.",
      device_revoked:
        "Este dispositivo ya no está autorizado. Inicia sesión para autorizarlo de nuevo.",
      account_disabled:
        "Esta cuenta de AgentEra está desactivada. Consulta la página de la cuenta en el navegador.",
      account_pending_deletion:
        "Esta cuenta está pendiente de eliminación y no puede autorizar AgentEra Studio.",
      secure_storage_unavailable:
        "Las sesiones de AgentEra requieren almacenamiento seguro del sistema.",
    },
  },
  profile: {
    checkingTitle: "Comprobando el acceso a los datos locales",
    checkingDescription:
      "AgentEra comprueba solo los metadatos de propiedad sin abrir el contenido privado del Runtime.",
    title: "Elige cómo usar tus datos locales",
    existingDescription:
      "Se encontraron datos de AgentEra Runtime en este dispositivo. Puedes vincularlos donde están o empezar en un espacio vacío independiente.",
    noUpload:
      "Ninguna opción sube, copia, combina ni reescribe tu Memory, sesiones, archivos, habilidades, perfil USER o estado de aprendizaje.",
    useExisting: "Usar los datos locales existentes",
    createNew: "Crear un espacio nuevo",
    binding: "Vinculando de forma segura…",
    creating: "Creando un espacio vacío…",
    emptyBindingTitle: "Preparando tu espacio personal",
    emptyBindingDescription:
      "Este Profile local vacío se está vinculando a tu cuenta de AgentEra.",
    connectionBindingTitle: "Protegiendo esta conexión de Runtime",
    connectionBindingDescription:
      "La conexión remota o SSH se vincula al propietario de AgentEra conectado. Los tokens del producto no se envían al Runtime.",
    otherOwnerTitle: "Estos datos locales pertenecen a otra cuenta",
    otherOwnerDescription:
      "AgentEra no abrirá ni reasignará este Profile físico. Crea un espacio vacío separado o inicia sesión con su propietario.",
    remoteOtherOwnerTitle: "Esta conexión de Runtime pertenece a otra cuenta",
    remoteOtherOwnerDescription:
      "AgentEra no heredará el contexto remoto o SSH del propietario anterior.",
    differentAccount: "Iniciar sesión con otra cuenta",
    failedTitle: "No se pudo preparar el acceso local",
    failedDescription:
      "No se modificó ningún dato privado del Runtime. Vuelve a comprobar la propiedad cuando quieras.",
    retry: "Reintentar la comprobación",
  },
  offline: {
    title: "Modo local sin conexión",
    description:
      "Las funciones de cuenta en la nube están pausadas. El Agent local, las API de modelos y el aprendizaje de Hermes siguen disponibles hasta el límite firmado.",
  },
  account: {
    settingsNav: "Cuenta AgentEra",
    title: "Cuenta AgentEra",
    openMenu: "Abrir menú de cuenta AgentEra",
    online: "En línea · verificada",
    offline: "Sin conexión · acceso local",
    manage: "Gestionar cuenta",
    devices: "Gestionar dispositivos",
    recharge: "Recargar API de modelos",
    switch: "Cambiar de cuenta",
    signOut: "Cerrar sesión",
    actionFailed: "No se pudo completar esta acción de cuenta.",
    unavailable: "La información de la cuenta AgentEra no está disponible.",
    userId: "ID de la cuenta",
    deviceId: "Dispositivo",
    offlineUntil: "El acceso firmado sin conexión es válido hasta {{date}}.",
    localDataWarning:
      "Eliminar la cuenta en la nube o cerrar sesión no borra, mueve, sube ni desvincula Profiles, Memory, sesiones, archivos, habilidades ni aprendizaje local de Hermes.",
    rechargeSeparateAccount:
      "La recarga abre el sitio independiente de API de modelos. Sus cuentas, saldos, claves, cookies y tokens están separados de AgentEra.",
    pendingRevocationWarning:
      "Si cierras sesión sin conexión al servicio de control, el dispositivo puede contar entre los cinco permitidos hasta que se entregue automáticamente la revocación firmada.",
  },
};

export default auth;
