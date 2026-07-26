import { useCallback, useEffect, useState } from "react";
import {
  emptyAgenteraUserProfile,
  type AgenteraUserProfile,
  type AgenteraUserProfileInput,
} from "../../../shared/agentera-user-profile";

/**
 * Keeps the account profile in sync across the sidebar and Settings without
 * putting profile data in a global React store. The main process remains the
 * owner of persistence and scopes every read/write to the authenticated user.
 */
export function useAgenteraUserProfile(userId: string | null): {
  profile: AgenteraUserProfile;
  loading: boolean;
  save: (input: AgenteraUserProfileInput) => Promise<AgenteraUserProfile>;
} {
  const [profile, setProfile] = useState(() =>
    emptyAgenteraUserProfile(userId ?? ""),
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setProfile(emptyAgenteraUserProfile(userId ?? ""));
    if (!userId) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);

    const api = window.agenteraAuth;
    const unsubscribe = api.onUserProfileChanged?.((next) => {
      if (active && next.userId === userId) {
        setProfile(next);
        setLoading(false);
      }
    });
    const load = api.getUserProfile
      ? api.getUserProfile()
      : Promise.resolve(emptyAgenteraUserProfile(userId));
    void load
      .then((next) => {
        if (active && next.userId === userId) {
          setProfile(next);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [userId]);

  const save = useCallback(async (input: AgenteraUserProfileInput) => {
    const next = await window.agenteraAuth.updateUserProfile(input);
    setProfile(next);
    return next;
  }, []);

  return { profile, loading, save };
}
