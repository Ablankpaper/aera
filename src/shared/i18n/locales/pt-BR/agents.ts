import enAgents from "../en/agents";

export default {
  title: "Agentes",
  subtitle:
    "Cada agente funciona em um ambiente isolado do Aera com sua própria configuração, memória e habilidades",
  newAgent: "Novo Agente",
  namePlaceholder: "Nome do agente (ex: coder)",
  createTitle: "Novo agente",
  nameLabel: "Nome do agente",
  cloneConfig: "Clonar configuração e chaves de API",
  cloneFromLabel: "Clonar de",
  running: "Em execução",
  off: "Desligado",
  starting: "Iniciando…",
  createFailed: "Falha ao criar o agente",
  creating: "Criando...",
  create: "Criar",
  deleteFailed: "Falha ao excluir o agente",
  active: "Ativo",
  noModel: "Nenhum modelo definido",
  skillsCount: "{{count}} habilidades",
  gatewayRunning: "Gateway em execução",
  gatewayOff: "Gateway desligado",
  colProfile: "Agente",
  colModel: "Modelo",
  colStatus: "Status",
  colActions: "Ações",
  chat: "Chat",
  deleteConfirm: "Excluir?",
  yes: "Sim",
  no: "Não",
  deleteTitle: "Excluir agente",
  auto: "Auto",
  local: "Local",
  sectionWallet: "Wallet",
  walletTitle: "Base wallets",
  walletNetwork: "Network: {{network}}",
  walletCreate: "Create wallet",
  walletCreateTitle: "Create wallet",
  walletCreateNew: "New wallet",
  walletImportExisting: "Import wallet",
  walletName: "Wallet name",
  walletNamePlaceholder: "Main wallet",
  walletRecoveryPhrase: "Recovery phrase",
  walletRecoveryPlaceholder: "twelve words separated by spaces",
  walletSave: "Save wallet",
  walletCreating: "Saving...",
  walletEmpty: "No wallets yet",
  walletCopyAddress: "Copy address",
  walletCopied: "Copied",
  walletDeleteFailed: "Couldn't remove wallet",
  walletLoadFailed: "Couldn't load wallets",
  walletCreateFailed: "Couldn't add wallet",
  walletRecoveryTitle: "Recovery phrase",
  walletRecoveryInfo:
    "Save this phrase now. Aera will not show it again after this modal closes.",
  walletCopyRecovery: "Copy phrase",
  walletDone: "I've saved it",
  walletBalanceLoading: "Loading…",
  walletBalanceUnavailable: "Unavailable",
  walletBalanceRefresh: "Refresh",
  walletDeleteTitle: "Remove wallet",
  walletDeleteWarning:
    "This will permanently remove this wallet from Aera. Make sure you have backed up the recovery phrase — you won't be able to recover the wallet without it.",
  walletDeleteConfirmLabel: "Remove wallet",
  control: {
    experience: enAgents.control.experience,
    official: enAgents.control.official,
    workspaceSpace: "Espaço de trabalho",
    workspaceSpaceTitle: "Agentes do espaço de trabalho",
    workspaceAuthorSubtitle:
      "Crie rascunhos locais, publique versões imutáveis e instale-as em Perfis locais isolados.",
    workspaceMemberSubtitle:
      "Instale versões aprovadas em Perfis locais isolados. Membros não podem editar nem publicar rascunhos.",
    role: {
      owner: "Proprietário",
      admin: "Administrador",
      auditor: "Auditor",
      member: "Membro",
    },
    organization: {
      title: "Agentes empresariais",
      cachedReadOnly: "Dados empresariais em cache (somente leitura)",
      newDraft: "Novo rascunho empresarial",
      prepareSubmission: "Preparar envio",
      submitForReview: "Enviar para revisão",
      submissionPreviewTitle: "Revisar envio empresarial",
      submissionBoundary:
        "O envio inicia uma revisão por duas pessoas; não publica nem instala uma versão.",
      reviewTitle: "Revisão de publicação",
      review: "Revisar",
      approve: "Aprovar versão",
      reject: "Rejeitar envio",
      confirmApproval: "Confirmar aprovação",
      confirmRejection: "Confirmar rejeição",
      differentReviewerRequired:
        "Outro Proprietário ou Administrador deve revisar este envio.",
      submittedNotPublished:
        "Enviado para revisão. Nenhuma versão foi publicada ou instalada.",
      approvedNotInstalled:
        "Versão aprovada. Nenhum dado de execução local ou Memory de funcionário foi alterado.",
      rejectedNotPublished:
        "Envio rejeitado. Nenhuma versão foi publicada ou instalada.",
      runtimeBoundary:
        "Os ativos empresariais são somente leitura; o Agente continua executando e aprendendo localmente.",
      immutableReviewPackage: "Revise o pacote imutável exato enviado.",
      policyAndDlpPassed:
        "O envio passou pelas verificações empresariais de política e privacidade.",
      status: "Status",
      statusValue: {
        pending: "Aguardando revisão",
        approved: "Aprovado",
        rejected: "Rejeitado",
        withdrawn: "Retirado",
        superseded: "Substituído",
      },
      lifecycle: {
        localOnly: "Local draft",
        pending: "Pending review",
        rejected: "Review rejected",
        withdrawn: "Withdrawn",
        superseded: "Superseded",
        approvedCurrent: "Published",
        approvedDirty: "Published with unpublished changes",
      },
      contentDigest: "Resumo do conteúdo",
      baseVersion: "Versão base",
      initialVersion: "Versão inicial",
      author: "Enviado por",
      reviewedBy: "Revisado por",
      policyVersion: "Versão da política",
      noSubmissions: "Ainda não há envios empresariais.",
      submissionRecordUnavailable:
        "Alguns registros de envios empresariais não puderam ser exibidos com segurança; os demais continuam disponíveis.",
      referenceConflict:
        "O link do rascunho local deste envio entra em conflito com a Cloud e foi colocado em quarentena. Os demais envios empresariais não foram afetados.",
      disconnectReference: "Desconectar link do rascunho local",
      disconnectReferenceTitle:
        "Desconectar link de rascunho local em conflito",
      disconnectReferenceBoundary:
        "Somente o link deste envio da Cloud para o rascunho local será removido; o envio, o rascunho, as versões publicadas, as instalações, a Memory e os Profiles permanecem inalterados.",
      confirmDisconnectReference: "Desconectar link",
      withdraw: "Retirar envio",
      confirmWithdrawal: "Confirmar retirada",
      withdrawalBoundary:
        "A retirada só encerra este envio pendente; rascunhos locais e dados do Aera Runtime não mudam.",
      deleteDraft: "Delete draft",
      deleteDraftTitle: "Delete local draft",
      deleteDraftBoundary:
        "Only the current account's local working copy is deleted. Enterprise submissions, published versions, installations, Memory, and Profiles remain unchanged.",
      confirmDeleteDraft: "Delete draft",
      discardUnpublished: "Discard unpublished changes",
      discardUnpublishedTitle: "Discard unpublished changes",
      discardUnpublishedBoundary:
        "The current local working copy is removed. The published enterprise Agent, installation, Memory, and Profile remain unchanged.",
      confirmDiscardUnpublished: "Discard changes",
      draftReadOnly:
        "Este rascunho empresarial é somente leitura. Reconecte-se como Proprietário ou Administrador para alterá-lo.",
    },
    workspaceOfflineNotice:
      "O espaço está offline. Instalações verificadas continuam disponíveis localmente; rascunhos ficam somente leitura e publicação, descoberta, instalação e atualização são pausadas.",
    view: "Ver",
    workspaceDraftReadOnly:
      "Este rascunho fica somente leitura offline. Reconecte para alterá-lo ou publicá-lo.",
    errors: {
      workspace_forbidden:
        "Sua função atual não permite esta operação do Agente.",
      workspace_archived:
        "Este espaço está arquivado; os ativos de Agente ficam somente leitura.",
      workspace_owner_unavailable:
        "Este espaço fica somente leitura até a conta do Proprietário voltar a estar disponível.",
    },
  },
} as const;
