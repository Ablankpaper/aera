export interface RuntimeSnapshotChange {
  catalogRevision?: string;
  profile?: string;
}

function normalizedProfile(profile?: string): string {
  return profile?.trim() || "default";
}

export function runtimeSnapshotAppliesToProfile(
  change: RuntimeSnapshotChange | undefined,
  profile?: string,
): boolean {
  if (!change?.profile) return true;
  return normalizedProfile(change.profile) === normalizedProfile(profile);
}
