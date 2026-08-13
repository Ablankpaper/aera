import { parseDocument } from "yaml";

/**
 * Migrate legacy scalar `model: value` to the canonical mapping format.
 *
 * Legacy config (pre-Beta.27):
 *   model: gpt-4
 *
 * Canonical config (Beta.27+):
 *   model:
 *     provider: "openai"
 *     default: "gpt-4"
 *     base_url: "https://api.openai.com/v1"
 *
 * Problem: When Beta.27's upsertBlockChild() encounters a scalar `model:`,
 * it doesn't recognize it as the target block and appends a second `model:`.
 * Result: duplicate top-level keys → YAML parse error → native_route stage fails.
 *
 * This migration runs before any model-config write to ensure exactly one
 * well-formed `model:` mapping exists.
 */

export interface MigrationResult {
  /** Whether any changes were made to the content */
  modified: boolean;
  /** The normalized content (always valid, even if no changes) */
  content: string;
  /** Human-readable description of what was done */
  summary: string;
}

/**
 * Normalize config.yaml to have exactly one well-formed `model:` block.
 *
 * Handles:
 * - Legacy scalar `model: value` → converted to mapping
 * - Duplicate `model:` keys → merged into one canonical block
 * - Missing `model:` → left unchanged (caller will bootstrap)
 *
 * Preserves all other top-level keys (`providers:`, `auxiliary:`, etc.)
 * and their structure intact.
 */
export function migrateModelConfigFormat(content: string): MigrationResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      modified: false,
      content,
      summary: "Empty config, no migration needed",
    };
  }

  const notes: string[] = [];
  let working = trimmed;

  // Phase 1 — strip duplicate top-level `model:` keys by line scan. This must
  // happen before parsing: the YAML parser rejects duplicate keys outright, so
  // it would never give us a document to repair.
  if (countTopLevelKeyLines(working, "model") > 1) {
    working = removeDuplicateModelKeys(working);
    notes.push(
      "Removed duplicate model: keys, keeping the most complete definition",
    );
  }

  // Phase 2 — parse the *cleaned* text. Re-parsing here is what makes the
  // result trustworthy: a cleanup that still leaves the file unparseable fails
  // now, instead of being returned as half-repaired content.
  const document = parseWorkingDocument(working);
  const root = document.toJS() as Record<string, unknown> | null;
  if (root !== null && (typeof root !== "object" || Array.isArray(root))) {
    throw Object.assign(
      new Error("Cannot migrate model config: root must be a mapping"),
      { code: "model_config_migration_invalid_root" },
    );
  }

  // Phase 3 — normalize the surviving `model` into mapping form. A duplicate
  // cleanup can leave a scalar behind (two legacy scalars and no mapping), so
  // this runs on the cleaned document rather than only on untouched input.
  const modelValue = root?.model;
  if (modelValue === undefined) {
    // No model key: nothing to normalize. The caller bootstraps the block.
    if (!notes.length) {
      return {
        modified: false,
        content,
        summary: "No model key, no migration needed",
      };
    }
  } else if (
    modelValue !== null &&
    typeof modelValue === "object" &&
    !Array.isArray(modelValue)
  ) {
    if (!notes.length) {
      return {
        modified: false,
        content,
        summary: "Model block already well-formed",
      };
    }
  } else {
    const legacyModel = String(modelValue ?? "").trim();
    if (legacyModel) {
      // provider/base_url are unknown here; setModelConfig fills them in.
      document.set("model", { default: legacyModel });
      notes.push(
        `Migrated legacy scalar model: ${legacyModel} → model.default`,
      );
    } else {
      // A valueless `model:` carries no information — drop it so the caller
      // bootstraps a well-formed block.
      document.delete("model");
      notes.push("Removed empty legacy model scalar");
    }
  }

  if (!notes.length) {
    return { modified: false, content, summary: "No migration needed" };
  }

  const migrated = document.toString({ lineWidth: 0 });

  // Phase 4 — never hand back content we would refuse to commit. If the repair
  // could not produce a structurally valid config, the original must stay on
  // disk for a manual fix.
  const problem = inspectModelConfigStructure(migrated);
  if (problem) {
    throw Object.assign(
      new Error(
        `Cannot migrate model config: repair left it invalid (${problem.kind}): ${problem.detail}`,
      ),
      { code: "model_config_migration_unrepairable", problem: problem.kind },
    );
  }

  return { modified: true, content: migrated, summary: notes.join("; ") };
}

function parseWorkingDocument(
  working: string,
): ReturnType<typeof parseDocument> {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(working || "{}");
  } catch (error) {
    throw Object.assign(
      new Error(`Cannot migrate model config: YAML parse failed: ${error}`),
      { code: "model_config_migration_parse_failed" },
    );
  }
  if (document.errors.length > 0) {
    throw Object.assign(
      new Error(`Cannot migrate model config: ${document.errors[0].message}`),
      { code: "model_config_migration_validation_failed" },
    );
  }
  return document;
}

/**
 * Count lines that open a top-level `key:` at column 0.
 *
 * A line scan is the only way to see this: YAML parsers either reject the
 * document or surface a single winner, so `document.toJS()` cannot reveal that
 * duplicates exist. Indented (nested) keys are never counted.
 */
function countTopLevelKeyLines(content: string, key: string): number {
  const keyPattern = new RegExp(`^${escapeRegex(key)}:`);
  let count = 0;
  for (const line of content.split("\n")) {
    if (keyPattern.test(line)) count++;
  }
  return count;
}

/** Does the `model:` line at `index` open a mapping with real children? */
function opensPopulatedMapping(lines: string[], index: number): boolean {
  if (/^model:\s*\S/.test(lines[index])) return false; // scalar on the same line
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Indented content directly under the key means it is a populated mapping.
    return line.length - line.trimStart().length > 0;
  }
  return false;
}

/**
 * Reduce several top-level `model:` occurrences to the single most informative
 * one, dropping the rest along with their child lines.
 *
 * Preference order, most informative first:
 *   1. a mapping block with children — the canonical Beta.27 form, and in the
 *      append-driven corruption pattern also the newest write;
 *   2. a scalar carrying a value — a legacy model name worth preserving;
 *   3. a valueless `model:` — carries nothing, kept only if nothing else exists.
 *
 * Whatever survives may still be a scalar, so the caller must re-run mapping
 * normalization afterwards rather than treating this as the final repair.
 */
function removeDuplicateModelKeys(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  const modelLineIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^model:/.test(lines[i])) modelLineIndexes.push(i);
  }

  let firstModelLineIndex =
    modelLineIndexes.find((index) => opensPopulatedMapping(lines, index)) ?? -1;
  if (firstModelLineIndex === -1) {
    firstModelLineIndex =
      modelLineIndexes.find((index) => /^model:\s*\S/.test(lines[index])) ?? -1;
  }
  if (firstModelLineIndex === -1) {
    firstModelLineIndex = modelLineIndexes[0] ?? -1;
  }

  // Second pass: copy lines, skipping duplicate model: blocks
  let insideSkippedBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // Skip if we're inside a block we're removing
    if (insideSkippedBlock) {
      // Continue skipping while indented or empty/comment
      if (indent > 0 || trimmed === "" || trimmed.startsWith("#")) {
        continue;
      } else {
        // Back to column 0, non-empty → block ended
        insideSkippedBlock = false;
      }
    }

    // Detect model: at column 0
    if (/^model:/.test(line)) {
      if (i === firstModelLineIndex) {
        // This is the one we're keeping
        result.push(line);
      } else {
        // This is a duplicate → skip it and its children
        const scalarMatch = line.match(/^model:\s+(.+)$/);
        if (!scalarMatch) {
          // Mapping block → skip this line and enter skip mode
          insideSkippedBlock = true;
        }
        // Scalar → just skip this line, don't enter block mode
      }
      continue;
    }

    // Regular line
    result.push(line);
  }

  return result.join("\n");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Distinct ways a `config.yaml` can be structurally unsafe to commit. */
export type ConfigStructureProblemKind =
  | "duplicate_model_key"
  | "invalid_yaml"
  | "invalid_root"
  | "providers_not_mapping";

export interface ConfigStructureProblem {
  kind: ConfigStructureProblemKind;
  /** Operator-facing description. Never contains a credential value. */
  detail: string;
}

/**
 * Classify the first structural problem in a `config.yaml`, or null when it is
 * safe to commit. Callers that need to *report* a problem use this; callers
 * that only need a pass/fail gate use [[validateModelConfiguration]].
 *
 * Check order is deliberate. A duplicate top-level `model:` also makes the
 * document unparseable, so it must be recognized first — otherwise every
 * legacy-corrupted config would be misreported as a syntax error and offered
 * the wrong repair.
 */
export function inspectModelConfigStructure(
  content: string,
): ConfigStructureProblem | null {
  if (!content.trim()) return null;

  if (countTopLevelKeyLines(content, "model") > 1) {
    return {
      kind: "duplicate_model_key",
      detail:
        "config.yaml declares the top-level `model:` key more than once; YAML requires it to be unique.",
    };
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(content.trim());
  } catch (error) {
    return {
      kind: "invalid_yaml",
      detail: `config.yaml could not be parsed: ${String(error)}`,
    };
  }
  if (document.errors.length > 0) {
    return {
      kind: "invalid_yaml",
      detail: `config.yaml is not valid YAML: ${document.errors[0].message}`,
    };
  }

  const root = document.toJS() as Record<string, unknown> | null;
  if (root === null) return null;
  if (typeof root !== "object" || Array.isArray(root)) {
    return {
      kind: "invalid_root",
      detail: "config.yaml must contain a mapping at the top level.",
    };
  }

  // An empty `providers:` parses as null and is equivalent to having none, so
  // it is accepted. A scalar or array there would break every provider reader.
  const providers = root.providers;
  if (
    providers !== undefined &&
    providers !== null &&
    (typeof providers !== "object" || Array.isArray(providers))
  ) {
    return {
      kind: "providers_not_mapping",
      detail: "The `providers:` block must be a mapping of provider names.",
    };
  }

  return null;
}

/**
 * Assert a `config.yaml` is structurally safe to commit, throwing with
 * `code: "model_config_validation_failed"` (and a `problem` discriminator)
 * otherwise. Used as the transaction's final guard so a corrupted config can
 * never be persisted. Returns true when valid.
 */
export function validateModelConfiguration(content: string): true {
  const problem = inspectModelConfigStructure(content);
  if (problem) {
    throw Object.assign(new Error(problem.detail), {
      code: "model_config_validation_failed",
      problem: problem.kind,
    });
  }
  return true;
}
