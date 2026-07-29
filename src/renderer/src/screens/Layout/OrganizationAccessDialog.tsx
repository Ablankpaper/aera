import { useEffect, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type { AgenteraOrganizationErrorCode } from "../../../../shared/agentera-organization";
import type { ProductSpaceErrorCode } from "../../../../shared/agentera-product-space";
import { Building, Plus, X } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

type AuthorizedState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

interface OrganizationAccessDialogProps {
  open: boolean;
  authState: AuthorizedState;
  onClose: () => void;
}

type AccessErrorCode = AgenteraOrganizationErrorCode | ProductSpaceErrorCode;

export default function OrganizationAccessDialog({
  open,
  authState,
  onClose,
}: OrganizationAccessDialogProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [invitationLink, setInvitationLink] = useState("");
  const [createName, setCreateName] = useState("");
  const [busy, setBusy] = useState<"invitation" | "create" | null>(null);
  const [errorCode, setErrorCode] = useState<AccessErrorCode | null>(null);
  const online =
    authState.status === "authenticated" && authState.cloudAvailable;

  useEffect(() => {
    if (!open) return;
    setInvitationLink("");
    setCreateName("");
    setBusy(null);
    setErrorCode(null);
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [authState.userId, onClose, open]);

  if (!open) return null;

  const handleInvitation = async (): Promise<void> => {
    const inviteUrl = invitationLink.trim();
    if (!inviteUrl || busy) return;
    setBusy("invitation");
    setErrorCode(null);
    try {
      const result = await window.agenteraOrganization.submitInvitationLink({
        inviteUrl,
      });
      if (!result.ok) {
        setErrorCode(result.errorCode);
        return;
      }
      setInvitationLink("");
      onClose();
    } catch {
      setErrorCode("service_unavailable");
    } finally {
      setBusy(null);
    }
  };

  const handleCreate = async (): Promise<void> => {
    const displayName = createName.trim();
    if (!displayName || !online || busy) return;
    setBusy("create");
    setErrorCode(null);
    try {
      const created = await window.agenteraOrganization.create({
        displayName,
      });
      if (!created.ok) {
        setErrorCode(created.errorCode);
        return;
      }
      const refreshed = await window.agenteraProductSpace.refresh();
      if (!refreshed.ok) {
        setErrorCode(refreshed.errorCode);
        return;
      }
      const selected = await window.agenteraProductSpace.select({
        kind: "ORGANIZATION",
        organizationId: created.data.id,
      });
      if (!selected.ok) {
        setErrorCode(selected.errorCode);
        return;
      }
      setCreateName("");
      onClose();
    } catch {
      setErrorCode("service_unavailable");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="workspace-management-overlay organization-access-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="workspace-management-dialog organization-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-access-title"
      >
        <header className="workspace-management-header">
          <div>
            <h2 id="organization-access-title">
              {t("navigation.organization.access.title")}
            </h2>
            <p>{t("navigation.organization.access.description")}</p>
          </div>
          <button
            type="button"
            className="workspace-management-close"
            aria-label={t("navigation.organization.access.close")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {!online && (
          <div className="workspace-management-readonly" role="status">
            {t("navigation.organization.access.offline")}
          </div>
        )}
        {errorCode && (
          <div className="workspace-management-error" role="alert">
            {t(`navigation.organization.errors.${errorCode}`)}
          </div>
        )}

        <div className="organization-access-body">
          <form
            className="organization-access-section"
            onSubmit={(event) => {
              event.preventDefault();
              void handleInvitation();
            }}
          >
            <div className="organization-access-heading">
              <Building size={18} aria-hidden="true" />
              <div>
                <h3>{t("navigation.organization.access.joinTitle")}</h3>
                <p>{t("navigation.organization.access.joinDescription")}</p>
              </div>
            </div>
            <label>
              <span>{t("navigation.organization.access.invitationLink")}</span>
              <input
                aria-label={t("navigation.organization.access.invitationLink")}
                value={invitationLink}
                placeholder={t(
                  "navigation.organization.access.invitationLinkPlaceholder",
                )}
                onChange={(event) => setInvitationLink(event.target.value)}
                disabled={busy !== null}
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy !== null || invitationLink.trim().length === 0}
            >
              {t("navigation.organization.access.reviewInvitation")}
            </button>
          </form>

          <form
            className="organization-access-section"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <div className="organization-access-heading">
              <Plus size={18} aria-hidden="true" />
              <div>
                <h3>{t("navigation.organization.access.createTitle")}</h3>
                <p>{t("navigation.organization.access.createDescription")}</p>
              </div>
            </div>
            <label>
              <span>{t("navigation.organization.access.createName")}</span>
              <input
                aria-label={t("navigation.organization.access.createName")}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                disabled={!online || busy !== null}
              />
            </label>
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={
                !online || busy !== null || createName.trim().length === 0
              }
            >
              {t("navigation.organization.access.create")}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
