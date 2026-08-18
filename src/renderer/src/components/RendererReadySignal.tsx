import { useEffect } from "react";

export default function RendererReadySignal(): null {
  useEffect(() => {
    const markRendererReady = window.hermesAPI?.markRendererReady;
    if (typeof markRendererReady !== "function") {
      console.error("[UPDATER] Renderer readiness bridge is unavailable");
      return;
    }
    void markRendererReady().then(
      (accepted) => {
        if (!accepted) {
          console.error("[UPDATER] Renderer readiness handshake was rejected");
        }
      },
      () => {
        console.error("[UPDATER] Renderer readiness handshake failed");
      },
    );
  }, []);

  return null;
}
