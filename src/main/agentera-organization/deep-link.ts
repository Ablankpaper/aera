const INVITATION_LINK_PATTERN =
  /^(?:aera|agentera):\/\/organization-invitation#([A-Za-z0-9_-]{43})$/;

function isCanonicalToken(value: string): boolean {
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function parseOrganizationInvitationDeepLink(
  raw: unknown,
): string | null {
  if (typeof raw !== "string") return null;
  const match = INVITATION_LINK_PATTERN.exec(raw);
  if (!match || !isCanonicalToken(match[1])) return null;
  return match[1];
}

export function findOrganizationInvitationInArguments(
  arguments_: readonly string[],
): string | null {
  let found: string | null = null;
  for (const argument of arguments_) {
    const token = parseOrganizationInvitationDeepLink(argument);
    if (token !== null) found = token;
  }
  return found;
}
