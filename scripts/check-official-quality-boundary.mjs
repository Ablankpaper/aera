import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qualityRoot = join(projectRoot, "src/main/agentera-official-quality");

const expectedEnvelopeFields = [
  "protocol_version",
  "consent_version",
  "event_id",
  "platform_id",
  "definition_id",
  "version_id",
  "release_id",
  "release_revision_id",
  "desktop_version",
  "runtime_version",
  "event_day",
  "kind",
  "result",
  "latency_bucket",
  "total_token_bucket",
  "crash_code",
  "feedback_rating",
  "feedback_reason_codes",
  "binding_proof",
  "device_signature",
];

const expectedOutboxColumns = [
  "event_id",
  "account_id",
  "device_id",
  "purpose",
  "consent_version",
  "event_day",
  "envelope_json",
  "attempt_count",
  "next_attempt_at",
  "created_at",
  "expires_at",
];

const forbiddenPublicFields = new Set([
  "prompt",
  "response",
  "reasoning",
  "raw_error",
  "error_text",
  "stack",
  "log",
  "file",
  "file_path",
  "memory",
  "user_id",
  "account_id",
  "device_id",
  "installation_id",
  "profile_id",
  "profile_path",
  "session_id",
  "conversation_id",
  "conversation_key",
  "runtime_binding_id",
  "private_skill",
  "curator",
  "credential",
  "attachment",
]);

const forbiddenOutboxColumnFragments = [
  "prompt",
  "response",
  "reasoning",
  "raw_error",
  "error_text",
  "stack",
  "log_text",
  "file_path",
  "memory",
  "session",
  "conversation",
  "profile",
  "installation",
  "attachment",
  "private_skill",
  "curator",
  "credential",
];

const forbiddenImportFragments = [
  "/memory",
  "/skill",
  "/curator",
  "/session-content",
  "/attachment",
];

function fail(message) {
  throw new Error(`Official quality privacy boundary failed: ${message}`);
}

function sameOrderedValues(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function quotedValues(source, label) {
  const values = [...source.matchAll(/"([a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );
  if (values.length === 0) fail(`${label} could not be parsed`);
  return values;
}

const modelSource = await readFile(join(qualityRoot, "model.ts"), "utf8");
const envelopeMatch = modelSource.match(
  /const ENVELOPE_FIELDS = \[([\s\S]*?)\] as const;/,
);
if (!envelopeMatch) fail("ENVELOPE_FIELDS is missing or no longer static");
const envelopeFields = quotedValues(envelopeMatch[1], "ENVELOPE_FIELDS");
if (!sameOrderedValues(envelopeFields, expectedEnvelopeFields)) {
  fail(
    `public envelope changed: expected ${expectedEnvelopeFields.join(",")}; received ${envelopeFields.join(",")}`,
  );
}
const forbiddenEnvelopeField = envelopeFields.find((field) =>
  forbiddenPublicFields.has(field),
);
if (forbiddenEnvelopeField) {
  fail(`public envelope contains forbidden field ${forbiddenEnvelopeField}`);
}

const databaseSource = await readFile(join(qualityRoot, "db.ts"), "utf8");
const outboxMatch = databaseSource.match(
  /CREATE TABLE official_quality_outbox \(([\s\S]*?)\n\s*\);/,
);
if (!outboxMatch) fail("official_quality_outbox schema is missing");
const outboxColumns = outboxMatch[1]
  .split("\n")
  .map((line) => line.match(/^\s*([a-z][a-z0-9_]*)\s+/)?.[1] ?? null)
  .filter((value) => value !== null);
if (!sameOrderedValues(outboxColumns, expectedOutboxColumns)) {
  fail(
    `local outbox columns changed: expected ${expectedOutboxColumns.join(",")}; received ${outboxColumns.join(",")}`,
  );
}
for (const column of outboxColumns) {
  const forbidden = forbiddenOutboxColumnFragments.find((fragment) =>
    column.includes(fragment),
  );
  if (forbidden) fail(`local outbox column ${column} contains ${forbidden}`);
}

const qualityFiles = (await readdir(qualityRoot))
  .filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts"),
  )
  .sort();
for (const name of qualityFiles) {
  const source = await readFile(join(qualityRoot, name), "utf8");
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const importPath = match[1].toLowerCase();
    const forbidden = forbiddenImportFragments.find((fragment) =>
      importPath.includes(fragment),
    );
    if (forbidden) {
      fail(`${basename(name)} imports forbidden Hermes domain ${match[1]}`);
    }
  }
}

console.log(
  `Official quality privacy boundary verified: ${envelopeFields.length} public fields, ${outboxColumns.length} local outbox columns, ${qualityFiles.length} production modules.`,
);
