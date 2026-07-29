const auth = {
  gate: {
    title: "Iniciar sessão no Aera",
    checking: "A verificar a sua sessão do Aera…",
    browserNote:
      "O registo, início de sessão e recuperação da palavra-passe são efetuados em segurança no navegador. O Aera nunca recolhe a sua palavra-passe nem o código de verificação.",
    openBrowser: "Abrir o navegador para iniciar sessão ou registar",
    waitingForBrowser: "A aguardar autorização no navegador…",
    cancel: "Cancelar",
    retry: "Tentar novamente",
    retrying: "A verificar novamente…",
    loginFailed:
      "A autorização no navegador não foi concluída. Tente novamente.",
    retryFailed:
      "O Aera não conseguiu verificar a sua sessão. Tente novamente.",
    cancelled: "A autorização no navegador foi cancelada.",
    secureStorageTitle: "O armazenamento seguro não está disponível",
    secureStorageDescription:
      "O Aera não consegue guardar a sessão deste dispositivo em segurança. Ative o porta-chaves ou serviço de credenciais do sistema e tente novamente. Nunca é usado armazenamento em texto simples.",
    reasons: {
      sign_in_required:
        "Inicie sessão ou crie uma conta antes de usar o Aera.",
      offline_expired:
        "O acesso offline de sete dias expirou. Ligue-se à internet e inicie sessão novamente.",
      clock_rollback:
        "O relógio do sistema mudou inesperadamente. Ligue-se à internet para verificar este dispositivo.",
      device_revoked:
        "Este dispositivo já não está autorizado. Inicie sessão para o autorizar novamente.",
      account_disabled:
        "Esta conta do Aera está desativada. Use a página da conta no navegador para obter ajuda.",
      account_pending_deletion:
        "Esta conta aguarda eliminação e não pode autorizar o Aera.",
      secure_storage_unavailable:
        "As sessões do Aera exigem armazenamento seguro do sistema.",
    },
  },
  profile: {
    checkingTitle: "A verificar o acesso aos dados locais",
    checkingDescription:
      "O Aera verifica apenas os metadados de propriedade sem abrir o conteúdo privado do Runtime.",
    title: "Escolha como usar os seus dados locais",
    existingDescription:
      "Foram encontrados dados do Aera Runtime neste dispositivo. Associe-os no local atual ou comece num espaço vazio separado.",
    noUpload:
      "Nenhuma opção envia, copia, combina ou reescreve a sua Memory, sessões, ficheiros, competências, dados USER ou estado de aprendizagem.",
    useExisting: "Usar os dados locais existentes",
    createNew: "Criar um novo espaço",
    binding: "A associar em segurança…",
    creating: "A criar um espaço vazio…",
    emptyBindingTitle: "A preparar o seu espaço pessoal",
    emptyBindingDescription:
      "O ambiente de execução do Agente local está a ser preparado automaticamente.",
    connectionBindingTitle: "A proteger esta ligação do Runtime",
    connectionBindingDescription:
      "A ligação remota ou SSH está a ser associada ao proprietário do Aera com sessão iniciada. Os tokens do produto não são enviados ao Runtime.",
    otherOwnerTitle: "Estes dados locais pertencem a outra conta",
    otherOwnerDescription:
      "O Aera não abrirá nem reatribuirá dados de um Agente local pertencentes a outra conta. Crie um espaço vazio separado ou inicie sessão como proprietário.",
    remoteOtherOwnerTitle: "Esta ligação do Runtime pertence a outra conta",
    remoteOtherOwnerDescription:
      "O Aera não herdará o contexto remoto ou SSH do proprietário anterior.",
    differentAccount: "Iniciar sessão com outra conta",
    failedTitle: "Não foi possível preparar o acesso local",
    failedDescription:
      "Nenhum dado privado do Runtime foi alterado. Volte a verificar a propriedade quando estiver pronto.",
    retry: "Voltar a verificar a propriedade",
  },
  offline: {
    title: "Modo local offline",
    description:
      "As funcionalidades da conta na nuvem estão suspensas. O Agent local, APIs de modelos e aprendizagem Aera Runtime continuam até ao prazo assinado.",
  },
  account: {
    settingsNav: "Conta Aera",
    title: "Conta Aera",
    openMenu: "Abrir menu da conta Aera",
    online: "Online · verificada",
    offline: "Offline · acesso local",
    manage: "Gerir conta",
    devices: "Gerir dispositivos",
    recharge: "Carregar API de modelos",
    switch: "Mudar de conta",
    signOut: "Terminar sessão",
    actionFailed: "Não foi possível concluir esta ação da conta.",
    unavailable: "As informações da conta Aera não estão disponíveis.",
    userId: "ID da conta",
    deviceId: "Dispositivo",
    offlineUntil: "O acesso offline assinado é válido até {{date}}.",
    localDataWarning:
      "Eliminar a conta na nuvem ou terminar sessão não apaga, move, envia nem desassocia dados de Agentes locais, Memory, sessões, ficheiros, competências ou aprendizagem do Aera Runtime.",
    rechargeSeparateAccount:
      "O carregamento abre o site independente de API de modelos. Contas, saldos, chaves, cookies e tokens são separados da conta Aera.",
    pendingRevocationWarning:
      "Ao terminar sessão sem acesso ao serviço de controlo, o dispositivo pode continuar no limite de cinco até a revogação assinada ser entregue automaticamente.",
  },
};

export default auth;
