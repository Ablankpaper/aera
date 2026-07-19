import type {
  AgenteraRuntimeOwner,
  AgenteraProfileBindingStore,
} from "../agentera-profile-binding";
import type {
  AgenteraHermesAdapter,
  PreparedInstalledHermesTurn,
} from "./hermes-adapter";

export interface PrepareAgenteraHermesTurnInput {
  conversationKey: string;
  profilePath: string;
  owner: AgenteraRuntimeOwner;
  resumeSessionId: string | null;
}

export interface AgenteraAgentControlManagerOptions {
  profileBindings: AgenteraProfileBindingStore;
  hermesAdapter: AgenteraHermesAdapter;
}

/**
 * Main-process facade for the AgentEra control plane. Task-specific stores are
 * long-lived dependencies; no renderer request can manufacture an owner,
 * database, trust store, or Profile path.
 */
export class AgenteraAgentControlManager {
  private readonly profileBindings: AgenteraProfileBindingStore;
  private readonly hermesAdapter: AgenteraHermesAdapter;

  constructor(options: AgenteraAgentControlManagerOptions) {
    this.profileBindings = options.profileBindings;
    this.hermesAdapter = options.hermesAdapter;
  }

  async prepareHermesTurn(
    input: PrepareAgenteraHermesTurnInput,
  ): Promise<PreparedInstalledHermesTurn | null> {
    const profile = this.profileBindings.verifyProfileBinding(
      input.profilePath,
      input.owner,
    );
    if (profile.agentInstallationId === null) return null;
    return this.hermesAdapter.prepareInstalledTurn(input);
  }

  attachHermesSession(bindingId: string, sessionId: string): void {
    this.hermesAdapter.attachHermesSession(bindingId, sessionId);
  }
}
