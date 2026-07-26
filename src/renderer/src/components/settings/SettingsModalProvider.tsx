import { useCallback, useMemo, useState } from "react";
import SettingsPage from "./SettingsModal";
import {
  SettingsModalContext,
  type OpenSettingsOptions,
} from "./SettingsModalContext";

interface OpenState {
  /** Nav item to land on (resolved by SettingsModal). */
  section?: string;
  profile?: string;
}

/**
 * Mounts the single global settings page at the app root and exposes
 * `openSettings` / `closeSettings` via context (see `useSettingsModal`). Only
 * one settings page is open at a time; opening again replaces the target.
 *
 * The main app remains mounted while hidden so chat/session state survives the
 * round trip, but the settings page is the only visible app surface.
 */
export function SettingsModalProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState<OpenState | null>(null);

  const openSettings = useCallback(
    (section?: string, opts?: OpenSettingsOptions) => {
      setOpen({ section, profile: opts?.profile });
    },
    [],
  );
  const closeSettings = useCallback(() => setOpen(null), []);

  const value = useMemo(
    () => ({ openSettings, closeSettings }),
    [openSettings, closeSettings],
  );

  return (
    <SettingsModalContext.Provider value={value}>
      <div
        className={`settings-page-background${open ? " is-hidden" : ""}`}
        aria-hidden={open ? "true" : undefined}
      >
        {children}
      </div>
      {open && (
        <SettingsPage
          profile={open.profile}
          initialSection={open.section}
          onBack={closeSettings}
        />
      )}
    </SettingsModalContext.Provider>
  );
}
