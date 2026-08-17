/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { homedir } from "node:os";

const SENSITIVE_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|authorization|credential|private(?:[_-]?key)?)/i;
const MAX_TEXT = 64 * 1024;

export const redactionCounters = {
  replacements: 0,
  dropped: 0,
  truncated: 0,
};

function increment(name) {
  redactionCounters[name] = (redactionCounters[name] || 0) + 1;
}

function redactUrl(value) {
  return value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+(?::[^\s/@]*)?@)?([^\s/?#]+)([^\s?#]*)?(?:\?[^\s#]*)?(?:#[^\s]*)?/gi,
    (_match, scheme, userInfo, host, path = "") => {
      increment("replacements");
      return `${scheme}${host}${path || ""}`;
    },
  );
}

/** Redact untrusted text before it can enter a shareable file. */
export function redactText(input, maximum = MAX_TEXT) {
  const original = String(input ?? "");
  let value = original.slice(0, maximum);
  if (original.length > maximum) increment("truncated");
  const replacements = [
    [
      /-----BEGIN [^-\r\n]{1,100}-----[\s\S]*?-----END [^-\r\n]{1,100}-----/gi,
      "[REDACTED_PEM]",
    ],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
    [/\b(?:Basic|Digest)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]"],
    [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[REDACTED_JWT]"],
    [
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|credential|private(?:[_-]?key)?)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`,
    ],
    [
      /(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
      (match) => `${match.slice(0, match.indexOf(":") + 1)} [REDACTED]`,
    ],
    [
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g,
      "[REDACTED_KEY]",
    ],
  ];
  for (const [pattern, replacement] of replacements) {
    const next = value.replace(pattern, replacement);
    if (next !== value) increment("replacements");
    value = next;
  }
  const home = homedir();
  if (home && value.includes(home)) {
    value = value.split(home).join("$HOME");
    increment("replacements");
  }
  for (const username of [process.env.USER, process.env.USERNAME].filter(
    Boolean,
  )) {
    if (username && username.length > 2 && value.includes(username)) {
      value = value.split(username).join("$USER");
      increment("replacements");
    }
  }
  value = redactUrl(value);
  return value.length > maximum ? value.slice(0, maximum) : value;
}

export function redactStructured(value, key = "", depth = 0) {
  if (SENSITIVE_KEY.test(key)) {
    const text = value == null ? "" : String(value);
    increment("replacements");
    return { present: text.length > 0, length: text.length };
  }
  if (depth > 12) {
    increment("dropped");
    return "[DEPTH_LIMIT]";
  }
  if (typeof value === "string") return redactText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value))
    return value
      .slice(0, 200)
      .map((item) => redactStructured(item, "", depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) {
      result[childKey] = redactStructured(childValue, childKey, depth + 1);
    }
    return result;
  }
  return redactText(value);
}

export function scanShareableText(input) {
  const text = String(input ?? "");
  const patterns = [
    ["pem", /-----BEGIN [A-Z0-9 ]*(?:PRIVATE|RSA|EC|OPENSSH) KEY-----/i],
    ["authorization", /\b(?:Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{12,}/i],
    ["jwt", /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}\b/],
    [
      "credential_assignment",
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|credential|private(?:[_-]?key)?)\s*[:=]\s*(?!\[REDACTED)[^\s,;}"']{8,}/i,
    ],
    [
      "known_api_key",
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/,
    ],
  ];
  const findings = patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([kind]) => kind);
  return { passed: findings.length === 0, findings };
}

export function resetRedactionCounters() {
  redactionCounters.replacements = 0;
  redactionCounters.dropped = 0;
  redactionCounters.truncated = 0;
}
