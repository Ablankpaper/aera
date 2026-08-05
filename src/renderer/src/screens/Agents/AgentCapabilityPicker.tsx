import { useRef, useState } from "react";
import type {
  AgentDraftAssetInput,
  AgentMcpRequirementV3,
  AgenteraAgentControlErrorCode,
  AuthoringCapabilityProfileSummary,
  AuthoringCapabilitySummary,
  McpRequirementPreview,
  SkillSnapshotPreview,
} from "../../../../shared/agentera-agent-control";
import { Plus, X } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

export interface AgentCapabilityPickerProps {
  profiles: readonly AuthoringCapabilityProfileSummary[];
  initialProfileId?: string;
  existingSkillPrefixes: readonly string[];
  existingRequirements: readonly AgentMcpRequirementV3[];
  onApplySkillSnapshot: (
    skillName: string,
    assets: AgentDraftAssetInput[],
  ) => void;
  onAddMcpRequirement: (requirement: AgentMcpRequirementV3) => void;
  onRemoveMcpRequirement: (logicalName: string) => void;
  onError: (code: AgenteraAgentControlErrorCode) => void;
  onBusyChange?: (busy: boolean) => void;
}

function firstProfileId(
  profiles: readonly AuthoringCapabilityProfileSummary[],
  preferred?: string,
): string {
  return profiles.some((profile) => profile.profileHandle === preferred)
    ? preferred!
    : (profiles[0]?.profileHandle ?? "");
}

export default function AgentCapabilityPicker({
  profiles,
  initialProfileId,
  existingSkillPrefixes,
  existingRequirements,
  onApplySkillSnapshot,
  onAddMcpRequirement,
  onRemoveMcpRequirement,
  onError,
  onBusyChange = () => undefined,
}: AgentCapabilityPickerProps): React.JSX.Element {
  const { t } = useI18n();
  const requestGenerationRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState(() =>
    firstProfileId(profiles, initialProfileId),
  );
  const [capabilities, setCapabilities] =
    useState<AuthoringCapabilitySummary | null>(null);
  const [selectedSkill, setSelectedSkill] = useState("");
  const [skillPreview, setSkillPreview] = useState<SkillSnapshotPreview | null>(
    null,
  );
  const [selectedMcp, setSelectedMcp] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [required, setRequired] = useState(false);
  const [permissionReason, setPermissionReason] = useState("");
  const [mcpPreview, setMcpPreview] = useState<McpRequirementPreview | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const updateBusy = (nextBusy: boolean): void => {
    setBusy(nextBusy);
    onBusyChange(nextBusy);
  };

  const resetSelections = (): void => {
    setSelectedSkill("");
    setSkillPreview(null);
    setSelectedMcp("");
    setSelectedTools([]);
    setRequired(false);
    setPermissionReason("");
    setMcpPreview(null);
  };

  const loadCapabilities = async (nextProfileId: string): Promise<void> => {
    if (!nextProfileId) return;
    const generation = ++requestGenerationRef.current;
    updateBusy(true);
    const result =
      await window.agenteraAgents.listAuthoringCapabilities(nextProfileId);
    if (generation !== requestGenerationRef.current) return;
    updateBusy(false);
    if (!result.ok) {
      setCapabilities(null);
      onError(result.errorCode);
      return;
    }
    setCapabilities(result.data);
  };

  const openPicker = (): void => {
    const nextProfileId = firstProfileId(
      profiles,
      profileId || initialProfileId,
    );
    setOpen(true);
    setProfileId(nextProfileId);
    resetSelections();
    void loadCapabilities(nextProfileId);
  };

  const previewSkill = async (): Promise<void> => {
    if (!selectedSkill || !profileId || busy) return;
    updateBusy(true);
    const result = await window.agenteraAgents.prepareInstalledSkillSnapshot({
      profileId,
      skillName: selectedSkill,
    });
    updateBusy(false);
    if (!result.ok) {
      onError(result.errorCode);
      return;
    }
    setSkillPreview(result.data);
  };

  const confirmSkill = async (): Promise<void> => {
    if (!skillPreview || busy) return;
    updateBusy(true);
    const result = await window.agenteraAgents.confirmInstalledSkillSnapshot({
      snapshotHandle: skillPreview.snapshotHandle,
      confirmation: "copy-selected-skill-to-draft",
    });
    updateBusy(false);
    if (!result.ok) {
      setSkillPreview(null);
      onError(result.errorCode);
      return;
    }
    onApplySkillSnapshot(skillPreview.skillName, result.data);
    setSkillPreview(null);
  };

  const duplicateMcp = existingRequirements.some(
    (requirement) => requirement.logicalName === selectedMcp,
  );
  const selectedServer = capabilities?.mcpServers.find(
    (server) => server.logicalName === selectedMcp,
  );

  const previewMcp = async (): Promise<void> => {
    if (
      !selectedMcp ||
      selectedTools.length === 0 ||
      !permissionReason.trim() ||
      duplicateMcp ||
      busy
    ) {
      return;
    }
    updateBusy(true);
    const result = await window.agenteraAgents.prepareMcpRequirement({
      profileId,
      logicalName: selectedMcp,
      tools: selectedTools,
      required,
      permissionReason: permissionReason.trim(),
    });
    updateBusy(false);
    if (!result.ok) {
      onError(result.errorCode);
      return;
    }
    setMcpPreview(result.data);
  };

  const confirmMcp = async (): Promise<void> => {
    if (!mcpPreview || busy) return;
    updateBusy(true);
    const result = await window.agenteraAgents.confirmMcpRequirement({
      requirementHandle: mcpPreview.requirementHandle,
      confirmation: "add-logical-mcp-requirement",
    });
    updateBusy(false);
    if (!result.ok) {
      setMcpPreview(null);
      onError(result.errorCode);
      return;
    }
    onAddMcpRequirement(result.data);
    setMcpPreview(null);
    setSelectedMcp("");
    setSelectedTools([]);
    setRequired(false);
    setPermissionReason("");
  };

  const replacingSkill = skillPreview
    ? existingSkillPrefixes.includes(`skills/${skillPreview.skillName}/`)
    : false;

  return (
    <section className="agent-control-assets agent-control-wide-field">
      <div className="agent-control-assets-header">
        <div>
          <h4>{t("agents.control.capabilities.title")}</h4>
          <p>{t("agents.control.capabilities.hint")}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={openPicker}
          disabled={profiles.length === 0 || busy}
        >
          <Plus size={13} />
          {t("agents.control.capabilities.chooseInstalled")}
        </button>
      </div>

      {existingSkillPrefixes.length > 0 || existingRequirements.length > 0 ? (
        <div className="agent-control-asset-row">
          <strong>
            {t("agents.control.capabilities.selectedCapabilities")}
          </strong>
          {existingSkillPrefixes.map((prefix) => (
            <span key={prefix}>{prefix}</span>
          ))}
          {existingRequirements.map((requirement) => (
            <div
              key={requirement.logicalName}
              className="agent-control-inline-actions"
            >
              <span>
                {requirement.logicalName} · {requirement.tools.join(", ")}
              </span>
              <button
                type="button"
                className="agents-row-edit"
                aria-label={t("agents.control.capabilities.removeMcp")}
                onClick={() => onRemoveMcpRequirement(requirement.logicalName)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="agent-control-asset-row">
          <label className="agents-create-field">
            <span>{t("agents.control.capabilities.profile")}</span>
            <select
              className="input"
              aria-label={t("agents.control.capabilities.profile")}
              value={profileId}
              disabled={busy}
              onChange={(event) => {
                const nextProfileId = event.target.value;
                setProfileId(nextProfileId);
                setCapabilities(null);
                resetSelections();
                void loadCapabilities(nextProfileId);
              }}
            >
              {profiles.map((profile) => (
                <option
                  key={profile.profileHandle}
                  value={profile.profileHandle}
                >
                  {profile.displayName}
                </option>
              ))}
            </select>
          </label>

          {capabilities ? (
            <>
              <label className="agents-create-field">
                <span>{t("agents.control.capabilities.installedSkill")}</span>
                <select
                  className="input"
                  aria-label={t("agents.control.capabilities.installedSkill")}
                  value={selectedSkill}
                  onChange={(event) => {
                    setSelectedSkill(event.target.value);
                    setSkillPreview(null);
                  }}
                >
                  <option value="">
                    {t("agents.control.capabilities.chooseSkill")}
                  </option>
                  {capabilities.skills.map((skill) => (
                    <option key={skill.name} value={skill.name}>
                      {skill.name} · {skill.category}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!selectedSkill || busy}
                onClick={() => void previewSkill()}
              >
                {t("agents.control.capabilities.previewSkill")}
              </button>
              {skillPreview ? (
                <div>
                  <p>{skillPreview.description}</p>
                  {skillPreview.files.map((file) => (
                    <p key={file.draftLocation}>{file.draftLocation}</p>
                  ))}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void confirmSkill()}
                  >
                    {t(
                      replacingSkill
                        ? "agents.control.capabilities.replaceSkill"
                        : "agents.control.capabilities.addSkill",
                    )}
                  </button>
                </div>
              ) : null}

              <label className="agents-create-field">
                <span>{t("agents.control.capabilities.mcpServer")}</span>
                <select
                  className="input"
                  aria-label={t("agents.control.capabilities.mcpServer")}
                  value={selectedMcp}
                  onChange={(event) => {
                    setSelectedMcp(event.target.value);
                    setSelectedTools([]);
                    setMcpPreview(null);
                  }}
                >
                  <option value="">
                    {t("agents.control.capabilities.chooseMcp")}
                  </option>
                  {capabilities.mcpServers
                    .filter((server) => server.enabled)
                    .map((server) => (
                      <option
                        key={server.logicalName}
                        value={server.logicalName}
                      >
                        {server.logicalName}
                      </option>
                    ))}
                </select>
              </label>
              {duplicateMcp ? (
                <p>{t("agents.control.capabilities.duplicateMcp")}</p>
              ) : null}
              {selectedServer && !duplicateMcp ? (
                <fieldset className="agents-create-field">
                  <legend>{t("agents.control.capabilities.mcpTools")}</legend>
                  {selectedServer.tools.map((tool) => (
                    <label key={tool.name}>
                      <input
                        type="checkbox"
                        aria-label={tool.name}
                        checked={selectedTools.includes(tool.name)}
                        onChange={(event) =>
                          setSelectedTools((current) =>
                            event.target.checked
                              ? [...new Set([...current, tool.name])]
                              : current.filter((name) => name !== tool.name),
                          )
                        }
                      />
                      <span>{tool.name}</span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <label>
                <input
                  type="checkbox"
                  aria-label={t("agents.control.capabilities.required")}
                  checked={required}
                  onChange={(event) => setRequired(event.target.checked)}
                />
                <span>{t("agents.control.capabilities.required")}</span>
              </label>
              <label className="agents-create-field">
                <span>{t("agents.control.capabilities.permissionReason")}</span>
                <input
                  className="input"
                  aria-label={t("agents.control.capabilities.permissionReason")}
                  value={permissionReason}
                  onChange={(event) => {
                    setPermissionReason(event.target.value);
                    setMcpPreview(null);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={
                  duplicateMcp ||
                  !selectedMcp ||
                  selectedTools.length === 0 ||
                  !permissionReason.trim() ||
                  busy
                }
                onClick={() => void previewMcp()}
              >
                {t("agents.control.capabilities.previewMcp")}
              </button>
              {mcpPreview ? (
                <div>
                  <p>{mcpPreview.permissionReason}</p>
                  <p>{mcpPreview.tools.map((tool) => tool.name).join(", ")}</p>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void confirmMcp()}
                  >
                    {t("agents.control.capabilities.addMcp")}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
