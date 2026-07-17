const auth = {
  gate: {
    title: "Iniciar sessão no AgentEra",
    checking: "A verificar a sua sessão do AgentEra…",
    browserNote:
      "O registo, início de sessão e recuperação da palavra-passe são efetuados em segurança no navegador. O AgentEra Studio nunca recolhe a sua palavra-passe nem o código de verificação.",
    openBrowser: "Abrir o navegador para iniciar sessão ou registar",
    waitingForBrowser: "A aguardar autorização no navegador…",
    cancel: "Cancelar",
    retry: "Tentar novamente",
    retrying: "A verificar novamente…",
    loginFailed:
      "A autorização no navegador não foi concluída. Tente novamente.",
    retryFailed:
      "O AgentEra não conseguiu verificar a sua sessão. Tente novamente.",
    cancelled: "A autorização no navegador foi cancelada.",
    secureStorageTitle: "O armazenamento seguro não está disponível",
    secureStorageDescription:
      "O AgentEra não consegue guardar a sessão deste dispositivo em segurança. Ative o porta-chaves ou serviço de credenciais do sistema e tente novamente. Nunca é usado armazenamento em texto simples.",
    reasons: {
      sign_in_required:
        "Inicie sessão ou crie uma conta antes de usar o AgentEra Studio.",
      offline_expired:
        "O acesso offline de sete dias expirou. Ligue-se à internet e inicie sessão novamente.",
      clock_rollback:
        "O relógio do sistema mudou inesperadamente. Ligue-se à internet para verificar este dispositivo.",
      device_revoked:
        "Este dispositivo já não está autorizado. Inicie sessão para o autorizar novamente.",
      account_disabled:
        "Esta conta do AgentEra está desativada. Use a página da conta no navegador para obter ajuda.",
      account_pending_deletion:
        "Esta conta aguarda eliminação e não pode autorizar o AgentEra Studio.",
      secure_storage_unavailable:
        "As sessões do AgentEra exigem armazenamento seguro do sistema.",
    },
  },
  profile: {
    checkingTitle: "A verificar o acesso aos dados locais",
    checkingDescription:
      "O AgentEra verifica apenas os metadados de propriedade sem abrir o conteúdo privado do Runtime.",
    title: "Escolha como usar os seus dados locais",
    existingDescription:
      "Foram encontrados dados do AgentEra Runtime neste dispositivo. Associe-os no local atual ou comece num espaço vazio separado.",
    noUpload:
      "Nenhuma opção envia, copia, combina ou reescreve a sua Memory, sessões, ficheiros, competências, perfil USER ou estado de aprendizagem.",
    useExisting: "Usar os dados locais existentes",
    createNew: "Criar um novo espaço",
    binding: "A associar em segurança…",
    creating: "A criar um espaço vazio…",
    emptyBindingTitle: "A preparar o seu espaço pessoal",
    emptyBindingDescription:
      "Este Profile local vazio está a ser associado à sua conta do AgentEra.",
    connectionBindingTitle: "A proteger esta ligação do Runtime",
    connectionBindingDescription:
      "A ligação remota ou SSH está a ser associada ao proprietário do AgentEra com sessão iniciada. Os tokens do produto não são enviados ao Runtime.",
    otherOwnerTitle: "Estes dados locais pertencem a outra conta",
    otherOwnerDescription:
      "O AgentEra não abrirá nem reatribuirá este Profile físico. Crie um espaço vazio separado ou inicie sessão como proprietário.",
    remoteOtherOwnerTitle: "Esta ligação do Runtime pertence a outra conta",
    remoteOtherOwnerDescription:
      "O AgentEra não herdará o contexto remoto ou SSH do proprietário anterior.",
    differentAccount: "Iniciar sessão com outra conta",
    failedTitle: "Não foi possível preparar o acesso local",
    failedDescription:
      "Nenhum dado privado do Runtime foi alterado. Volte a verificar a propriedade quando estiver pronto.",
    retry: "Voltar a verificar a propriedade",
  },
};

export default auth;
