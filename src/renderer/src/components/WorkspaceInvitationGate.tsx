import { useEffect, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../shared/agentera-auth";
import type { AgenteraWorkspaceErrorCode } from "../../../shared/agentera-workspace";
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
  if (
    authState.status === "authenticated" &&
    authState.cloudAvailable === true
  ) {
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

export default function WorkspaceInvitationGate({
  authState,
}: {
  authState: AgenteraAuthPublicState;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const tokenRef = useRef<string | null>(null);
  const authStateRef = useRef(authState);
  authStateRef.current = authState;
  const [phase, setPhase] = useState<InvitationPhase>("idle");
  const [errorCode, setErrorCode] = useState<AgenteraWorkspaceErrorCode | null>(
    null,
  );

  useEffect(() => {
    if (location.hash) {
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${location.search}`,
      );
    }

    const api = window.agenteraWorkspace;
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
        if (!current || !result.ok || result.value === null) return;
        receive(result.value);
      })
      .catch(() => {
        // The volatile inbox remains authoritative; a later event can still
        // deliver the invitation without exposing an error body.
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
      await window.agenteraWorkspace.dismissPendingInvitation({ token });
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
      const result = await window.agenteraWorkspace.acceptInvitation({ token });
      if (!result.ok) {
        setErrorCode(result.errorCode);
        setPhase("unavailable");
        return;
      }
      const workspaceId = result.value.workspace.id;
      if (tokenRef.current === token) tokenRef.current = null;
      setPhase("idle");
      await window.agenteraWorkspace
        .dismissPendingInvitation({ token })
        .catch(() => undefined);
      await window.agenteraWorkspace
        .select({ workspaceId })
        .catch(() => undefined);
    } catch {
      setErrorCode("cloud_unavailable");
      setPhase("unavailable");
    }
  };

  if (phase === "idle") return null;

  if (phase === "sign_in" || phase === "offline") {
    return (
      <div className="workspace-invitation-handoff" role="status">
        <strong>
          {t(
            phase === "offline"
              ? "navigation.workspace.invitation.offlinePaused"
              : "navigation.workspace.invitation.signInRequired",
          )}
        </strong>
        <button type="button" onClick={() => void dismiss()}>
          {t("navigation.workspace.invitation.dismiss")}
        </button>
      </div>
    );
  }

  return (
    <div className="workspace-invitation-gate-overlay">
      <section
        className="workspace-invitation-gate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-invitation-title"
      >
        <h2 id="workspace-invitation-title">
          {t("navigation.workspace.invitation.title")}
        </h2>
        {phase === "unavailable" ? (
          <p role="alert">
            {t(
              errorCode === "not_found"
                ? "navigation.workspace.invitation.unavailable"
                : `navigation.workspace.errors.${errorCode ?? "cloud_unavailable"}`,
            )}
          </p>
        ) : (
          <p>{t("navigation.workspace.invitation.confirmDescription")}</p>
        )}
        <div className="workspace-invitation-gate-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void dismiss()}
          >
            {t("navigation.workspace.invitation.dismiss")}
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
                  ? "navigation.workspace.invitation.accepting"
                  : "navigation.workspace.invitation.accept",
              )}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
