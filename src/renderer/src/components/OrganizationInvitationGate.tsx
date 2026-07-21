import { useEffect, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../shared/agentera-auth";
import type { AgenteraOrganizationErrorCode } from "../../../shared/agentera-organization";
import { useI18n } from "./useI18n";

type InvitationPhase =
  | "idle"
  | "sign_in"
  | "offline"
  | "confirm"
  | "accepting"
  | "unavailable";

function phaseForAuth(
  authState: AgenteraAuthPublicState,
): Exclude<InvitationPhase, "idle" | "accepting" | "unavailable"> {
  if (authState.status === "authenticated" && authState.cloudAvailable) {
    return "confirm";
  }
  if (
    authState.status === "offline" ||
    (authState.status === "authenticated" && !authState.cloudAvailable)
  ) {
    return "offline";
  }
  return "sign_in";
}

export default function OrganizationInvitationGate({
  authState,
}: {
  authState: AgenteraAuthPublicState;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const tokenRef = useRef<string | null>(null);
  const authStateRef = useRef(authState);
  authStateRef.current = authState;
  const [phase, setPhase] = useState<InvitationPhase>("idle");
  const [errorCode, setErrorCode] =
    useState<AgenteraOrganizationErrorCode | null>(null);

  useEffect(() => {
    if (location.hash) {
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${location.search}`,
      );
    }
    const api = window.agenteraOrganization;
    if (!api?.getPendingInvitation || !api.onInvitationReceived) return;
    let current = true;
    const receive = ({ token }: { token: string }): void => {
      if (!current) return;
      tokenRef.current = token;
      setErrorCode(null);
      setPhase(phaseForAuth(authStateRef.current));
    };
    const unsubscribe = api.onInvitationReceived(receive);
    void api
      .getPendingInvitation()
      .then((result) => {
        if (!current || !result.ok || result.data === null) return;
        receive(result.data);
      })
      .catch(() => {
        // The main-process volatile inbox remains authoritative. A later event
        // can still deliver the token without exposing it to renderer storage.
      });
    return () => {
      current = false;
      tokenRef.current = null;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!tokenRef.current || phase === "accepting" || phase === "unavailable") {
      return;
    }
    setErrorCode(null);
    setPhase(phaseForAuth(authState));
  }, [authState, phase]);

  const dismiss = async (): Promise<void> => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await window.agenteraOrganization.dismissPendingInvitation({ token });
    } finally {
      if (tokenRef.current === token) tokenRef.current = null;
      setErrorCode(null);
      setPhase("idle");
    }
  };

  const accept = async (): Promise<void> => {
    const token = tokenRef.current;
    if (!token) return;
    setPhase("accepting");
    setErrorCode(null);
    try {
      const result = await window.agenteraOrganization.acceptInvitation({
        token,
      });
      if (!result.ok) {
        setErrorCode(result.errorCode);
        setPhase("unavailable");
        return;
      }
      const organizationId = result.data.organization.id;
      if (tokenRef.current === token) tokenRef.current = null;
      setPhase("idle");
      await window.agenteraOrganization
        .dismissPendingInvitation({ token })
        .catch(() => undefined);
      await window.agenteraProductSpace
        .select({ kind: "ORGANIZATION", organizationId })
        .catch(() => undefined);
    } catch {
      setErrorCode("service_unavailable");
      setPhase("unavailable");
    }
  };

  if (phase === "idle") return null;

  if (phase === "sign_in" || phase === "offline") {
    return (
      <div
        className="workspace-invitation-handoff organization-invitation-handoff"
        role="status"
      >
        <strong>
          {t(
            phase === "offline"
              ? "navigation.organization.invitation.offlinePaused"
              : "navigation.organization.invitation.signInRequired",
          )}
        </strong>
        <button type="button" onClick={() => void dismiss()}>
          {t("navigation.organization.invitation.dismiss")}
        </button>
      </div>
    );
  }

  return (
    <div className="workspace-invitation-gate-overlay organization-invitation-gate-overlay">
      <section
        className="workspace-invitation-gate-dialog organization-invitation-gate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-invitation-title"
      >
        <h2 id="organization-invitation-title">
          {t("navigation.organization.invitation.title")}
        </h2>
        {phase === "unavailable" ? (
          <p role="alert">
            {t(
              errorCode === "invitation_unavailable"
                ? "navigation.organization.invitation.unavailable"
                : `navigation.organization.errors.${errorCode ?? "service_unavailable"}`,
            )}
          </p>
        ) : (
          <p>{t("navigation.organization.invitation.confirmDescription")}</p>
        )}
        <div className="workspace-invitation-gate-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void dismiss()}
          >
            {t("navigation.organization.invitation.dismiss")}
          </button>
          {phase !== "unavailable" && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={phase === "accepting"}
              onClick={() => void accept()}
            >
              {t(
                phase === "accepting"
                  ? "navigation.organization.invitation.accepting"
                  : "navigation.organization.invitation.accept",
              )}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
