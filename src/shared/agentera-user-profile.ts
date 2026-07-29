/**
 * Renderer-safe, non-secret personal information owned by one Aera
 * account. Authentication material and account identities deliberately stay
 * outside this shape.
 */
export interface AgenteraUserProfile {
  userId: string;
  displayName: string;
  occupation: string;
  bio: string;
  avatarDataUrl: string | null;
  updatedAt: string | null;
}

export interface AgenteraUserProfileInput {
  displayName: string;
  occupation: string;
  bio: string;
  avatarDataUrl: string | null;
}

export function emptyAgenteraUserProfile(userId: string): AgenteraUserProfile {
  return {
    userId,
    displayName: "",
    occupation: "",
    bio: "",
    avatarDataUrl: null,
    updatedAt: null,
  };
}

export function serializeAgenteraUserProfile(
  profile: AgenteraUserProfile,
): AgenteraUserProfile {
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    occupation: profile.occupation,
    bio: profile.bio,
    avatarDataUrl: profile.avatarDataUrl,
    updatedAt: profile.updatedAt,
  };
}
