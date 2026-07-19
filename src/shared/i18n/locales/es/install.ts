export default {
  preparing: "Preparando...",
  startingInstall: "Iniciando la instalación",
  installationComplete: "Instalación completada",
  installationFailed: "La instalación falló",
  installingHermes: "Instalando AgentEra Runtime",
  retryInstallation: "Reintentar la instalación",
  copied: "¡Copiado!",
  copyLogs: "Copiar registros",
  stepLabel: "Paso {{step}}/{{total}}: {{title}}",
  waitingToStart: "Esperando para iniciar...",
  continueToSetup: "Continuar con la configuración",
  confirmTitle: "Antes de instalar",
  confirmLocationLabel: "AgentEra se instalará en:",
  confirmFresh:
    "No se encontró ninguna instalación existente aquí — se configurará una copia nueva.",
  confirmUpdate:
    "Aquí hay una instalación de AgentEra existente — se actualizará a la última versión.",
  confirmReplace:
    "Existe una carpeta aquí, pero no es una instalación válida de AgentEra — instalar la eliminará y la reemplazará.",
  confirmNotInherited:
    "Si instalaste AgentEra en otro lugar, o mediante la línea de comandos, no se conservará.",
  confirmInstallBtn: "Instalar AgentEra",
  useExistingBtn: "Usar un Runtime externo existente",
  useExistingHint:
    "Selecciona la carpeta principal de Hermes que contiene hermes-agent. Este Runtime seguirá siendo externo y no administrado; las actualizaciones solo ejecutan el comando local de ese checkout.",
  useExistingInvalid:
    "No se encontró una instalación de AgentEra utilizable en esa carpeta.",
  useExistingDone:
    "Runtime externo seleccionado — cierra y vuelve a abrir AgentEra para aplicarlo. AgentEra Studio no modificará ni eliminará ese checkout.",
  useExistingQuitBtn: "Salir de AgentEra",
} as const;
