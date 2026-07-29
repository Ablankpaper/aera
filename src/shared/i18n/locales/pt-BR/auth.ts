const auth = {
  gate: {
    title: "Entrar no AgentEra",
    checking: "Verificando sua sessão do AgentEra…",
    browserNote:
      "Cadastro, login e recuperação de senha são feitos com segurança no navegador. O AgentEra Studio nunca coleta sua senha nem o código de verificação.",
    openBrowser: "Abrir o navegador para entrar ou cadastrar",
    waitingForBrowser: "Aguardando autorização no navegador…",
    cancel: "Cancelar",
    retry: "Tentar novamente",
    retrying: "Verificando novamente…",
    loginFailed:
      "A autorização no navegador não foi concluída. Tente novamente.",
    retryFailed:
      "O AgentEra não conseguiu verificar sua sessão. Tente novamente.",
    cancelled: "A autorização no navegador foi cancelada.",
    secureStorageTitle: "O armazenamento seguro não está disponível",
    secureStorageDescription:
      "O AgentEra não pode salvar a sessão deste dispositivo com segurança. Ative o chaveiro ou serviço de credenciais do sistema e tente novamente. O armazenamento em texto simples nunca é usado.",
    reasons: {
      sign_in_required:
        "Entre ou crie uma conta antes de usar o AgentEra Studio.",
      offline_expired:
        "O acesso offline de sete dias expirou. Conecte-se à internet e entre novamente.",
      clock_rollback:
        "O relógio do sistema mudou inesperadamente. Conecte-se para verificar este dispositivo.",
      device_revoked:
        "Este dispositivo não está mais autorizado. Entre para autorizá-lo novamente.",
      account_disabled:
        "Esta conta do AgentEra está desativada. Use a página da conta no navegador para obter ajuda.",
      account_pending_deletion:
        "Esta conta está aguardando exclusão e não pode autorizar o AgentEra Studio.",
      secure_storage_unavailable:
        "As sessões do AgentEra exigem armazenamento seguro do sistema.",
    },
  },
  profile: {
    checkingTitle: "Verificando o acesso aos dados locais",
    checkingDescription:
      "O AgentEra verifica somente os metadados de propriedade sem abrir o conteúdo privado do Runtime.",
    title: "Escolha como usar seus dados locais",
    existingDescription:
      "Foram encontrados dados existentes do AgentEra Runtime neste dispositivo. Vincule-os no local atual ou comece em um espaço vazio separado.",
    noUpload:
      "Nenhuma opção envia, copia, mescla ou regrava sua Memory, sessões, arquivos, habilidades, dados USER ou estado de aprendizado.",
    useExisting: "Usar os dados locais existentes",
    createNew: "Criar um novo espaço",
    binding: "Vinculando com segurança…",
    creating: "Criando um espaço vazio…",
    emptyBindingTitle: "Preparando seu espaço pessoal",
    emptyBindingDescription:
      "O ambiente de execução do Agente local está sendo preparado automaticamente.",
    connectionBindingTitle: "Protegendo esta conexão do Runtime",
    connectionBindingDescription:
      "A conexão remota ou SSH está sendo vinculada ao proprietário do AgentEra conectado. Tokens do produto não são enviados ao Runtime.",
    otherOwnerTitle: "Estes dados locais pertencem a outra conta",
    otherOwnerDescription:
      "O AgentEra não abrirá nem reatribuirá dados de um Agente local pertencentes a outra conta. Crie um espaço vazio separado ou entre como o proprietário.",
    remoteOtherOwnerTitle: "Esta conexão do Runtime pertence a outra conta",
    remoteOtherOwnerDescription:
      "O AgentEra não herdará o contexto remoto ou SSH do proprietário anterior.",
    differentAccount: "Entrar com outra conta",
    failedTitle: "Não foi possível preparar o acesso local",
    failedDescription:
      "Nenhum dado privado do Runtime foi alterado. Tente verificar a propriedade novamente.",
    retry: "Verificar a propriedade novamente",
  },
  offline: {
    title: "Modo local offline",
    description:
      "Os recursos da conta na nuvem estão pausados. Agent local, APIs de modelos e aprendizado do Hermes continuam até o prazo offline assinado.",
  },
  account: {
    settingsNav: "Conta AgentEra",
    title: "Conta AgentEra",
    openMenu: "Abrir menu da conta AgentEra",
    online: "Online · verificada",
    offline: "Offline · acesso local",
    manage: "Gerenciar conta",
    devices: "Gerenciar dispositivos",
    recharge: "Recarregar API de modelos",
    switch: "Trocar conta",
    signOut: "Sair",
    actionFailed: "Não foi possível concluir esta ação da conta.",
    unavailable: "As informações da conta AgentEra não estão disponíveis.",
    userId: "ID da conta",
    deviceId: "Dispositivo",
    offlineUntil: "O acesso offline assinado é válido até {{date}}.",
    localDataWarning:
      "Excluir a conta na nuvem ou sair não apaga, move, envia nem desvincula dados de Agentes locais, Memory, sessões, arquivos, skills ou aprendizado do Hermes.",
    rechargeSeparateAccount:
      "A recarga abre o site independente de API de modelos. Contas, saldos, chaves, cookies e tokens são separados da conta AgentEra.",
    pendingRevocationWarning:
      "Ao sair sem acesso ao serviço de controle, o dispositivo pode continuar no limite de cinco até a revogação assinada ser entregue automaticamente.",
  },
};

export default auth;
