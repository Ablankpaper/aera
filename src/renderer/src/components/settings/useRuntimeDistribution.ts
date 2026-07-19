import { useCallback, useEffect, useState } from "react";

import type { RuntimeDistributionPublicState } from "../../../../shared/agentera-runtime-distribution";

export interface RuntimeDistributionViewModel {
  state: RuntimeDistributionPublicState | null;
  checkForUpdate: () => Promise<void>;
  downloadConfirmed: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  restartToApply: () => Promise<void>;
  retryRepair: () => Promise<void>;
}

export function useRuntimeDistribution(): RuntimeDistributionViewModel {
  const [state, setState] = useState<RuntimeDistributionPublicState | null>(
    null,
  );

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.agenteraRuntimeDistribution.onStateChanged(
      (next) => {
        if (mounted) setState(next);
      },
    );
    void window.agenteraRuntimeDistribution.getState().then((next) => {
      if (mounted) setState(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const run = useCallback(
    async (
      operation: () => Promise<RuntimeDistributionPublicState>,
    ): Promise<void> => {
      setState(await operation());
    },
    [],
  );

  return {
    state,
    checkForUpdate: () =>
      run(() => window.agenteraRuntimeDistribution.checkForUpdate()),
    downloadConfirmed: () =>
      run(() => window.agenteraRuntimeDistribution.downloadConfirmed()),
    cancelDownload: () =>
      run(() => window.agenteraRuntimeDistribution.cancelDownload()),
    restartToApply: () =>
      run(() => window.agenteraRuntimeDistribution.restartToApply()),
    retryRepair: () =>
      run(() => window.agenteraRuntimeDistribution.retryRepair()),
  };
}
