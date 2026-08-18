#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

/**
 * Structural gate for the five managed model-configuration files.
 *
 * This is deliberately a source-level guard, not a claim that a static graph
 * can prove arbitrary JavaScript.  It catches the two regressions that caused
 * the Beta.29 incident: a new raw filesystem writer resolving one of the
 * managed filenames, and a profile-materialization subprocess that bypasses
 * the staging capability.  Every intentionally indirect writer is listed in
 * the capability registry below; an unregistered source file is a release
 * failure and must be reviewed rather than silently whitelisted.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const MANAGED_MODEL_ROLES = Object.freeze([
  "env",
  "providers",
  "models",
  "modelDefinitions",
  "config",
]);

const ROLE_FILENAMES = Object.freeze({
  env: ".env",
  providers: "providers.json",
  models: "models.json",
  modelDefinitions: "model-definitions.json",
  config: "config.yaml",
});

const UNKNOWN_RAW_WRITER = Object.freeze({ allowUnknown: true });

/**
 * Explicit capabilities for the current tree. `managedRoles` documents which
 * live model roles a feature may mutate through the Main transaction port; it
 * never grants raw filesystem authority. `rawWriters` is deliberately scoped
 * to one named function at a time and is reserved for generic infrastructure,
 * non-managed state, or isolated staging. Adding a second raw writer to an
 * already registered file therefore remains a release failure.
 */
export const MANAGED_WRITER_CAPABILITIES = Object.freeze({
  "src/main/utils.ts": {
    capability: "safe-write-boundary",
    rawWriters: {
      writeSafeTemporary: UNKNOWN_RAW_WRITER,
      replaceSafeTemporary: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/model-configuration-managed-files.ts": {
    capability: "managed-file-boundary",
    managedRoles: [...MANAGED_MODEL_ROLES],
    managedBoundaryFunctions: ["writeManagedModelFile"],
  },
  "src/main/model-configuration-operation-store.ts": {
    capability: "journal-backup-recovery",
    managedRoles: [...MANAGED_MODEL_ROLES],
    rawWriters: {
      writeDurableTemporary: UNKNOWN_RAW_WRITER,
      replaceDurableTemporary: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/model-configuration-coordinator.ts": {
    capability: "coordinator-transaction",
    managedRoles: [...MANAGED_MODEL_ROLES],
  },
  "src/main/config.ts": {
    capability: "coordinated-config-writer",
    managedRoles: ["env", "config"],
    rawWriters: {
      writeDesktopConfig: UNKNOWN_RAW_WRITER,
      appendConfigFixLog: UNKNOWN_RAW_WRITER,
      writeAuthStore: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/models.ts": {
    capability: "coordinated-model-catalog-writer",
    managedRoles: ["models", "modelDefinitions"],
  },
  "src/main/providers-store.ts": {
    capability: "coordinated-provider-writer",
    managedRoles: ["providers"],
  },
  "src/main/native-custom-provider.ts": {
    capability: "coordinated-native-provider-writer",
    managedRoles: ["config"],
  },
  "src/main/config-health.ts": {
    capability: "coordinated-config-health-writer",
    managedRoles: ["env", "config"],
  },
  "src/main/agent-sync.ts": {
    capability: "agent-sync-mutation-port",
    managedRoles: ["config"],
    rawWriters: { writeSyncState: UNKNOWN_RAW_WRITER },
  },
  "src/main/auxiliary-config.ts": {
    capability: "auxiliary-config-mutation-port",
    managedRoles: ["config"],
  },
  "src/main/tools.ts": {
    capability: "toolset-mutation-port",
    managedRoles: ["config"],
  },
  "src/main/image-generation-config.ts": {
    capability: "image-generation-mutation-port",
    managedRoles: ["config"],
  },
  "src/main/registry.ts": {
    capability: "registry-mutation-port",
    managedRoles: ["config"],
    rawWriters: { downloadFolder: UNKNOWN_RAW_WRITER },
  },
  "src/main/hermes.ts": {
    capability: "gateway-mutation-port",
    managedRoles: ["config"],
    rawWriters: {
      transcribeAudioViaLocalPython: UNKNOWN_RAW_WRITER,
      restoreGatewayAfterRestartFailure: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/agentera-agent-control/model-profile-seed.ts": {
    capability: "profile-seed-mutation-port",
    managedRoles: [...MANAGED_MODEL_ROLES],
  },
  "src/main/agentera-agent-control/runtime-model-routes.ts": {
    capability: "runtime-route-mutation-port",
    managedRoles: ["config", "models", "modelDefinitions"],
  },
  "src/main/agentera-agent-control/hermes-projection.ts": {
    capability: "hermes-projection-mutation-port",
    managedRoles: ["config"],
    rawWriters: { writeAndSync: UNKNOWN_RAW_WRITER },
  },
  "src/main/agentera-agent-control/installation-manager.ts": {
    capability: "profile-staging-materializer",
    stagedRoles: [...MANAGED_MODEL_ROLES],
    rawWriters: { copyRestoreFile: UNKNOWN_RAW_WRITER },
  },
  "src/main/agentera-encrypted-backup/restore.ts": {
    capability: "encrypted-restore-staging",
    stagedRoles: [...MANAGED_MODEL_ROLES],
    rawWriters: { writeDownloadedObject: UNKNOWN_RAW_WRITER },
  },
  "src/main/agentera-encrypted-backup/manager.ts": {
    capability: "encrypted-backup-state-writer",
    rawWriters: {
      persistArchive: UNKNOWN_RAW_WRITER,
      write: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/agentera-encrypted-backup/snapshot.ts": {
    capability: "encrypted-backup-snapshot-writer",
    rawWriters: {
      captureStableFile: UNKNOWN_RAW_WRITER,
      writePrivateFile: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/app/updater.ts": {
    capability: "updater-state-writer",
    rawWriters: { setAutoUpgradeEnabled: UNKNOWN_RAW_WRITER },
  },
  "src/main/claw3d.ts": {
    capability: "runtime-port-state-writer",
    rawWriters: {
      setClaw3dPort: UNKNOWN_RAW_WRITER,
      setClaw3dWsUrl: UNKNOWN_RAW_WRITER,
      writeOfficeFileIfChanged: UNKNOWN_RAW_WRITER,
      writePid: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/gpu-fallback.ts": {
    capability: "gpu-state-writer",
    rawWriters: {
      setGpuPreference: UNKNOWN_RAW_WRITER,
      persistGpuDisabled: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/hermes-agent-compat.ts": {
    capability: "compatibility-source-writer",
    rawWriters: {
      writeLocalMarker: UNKNOWN_RAW_WRITER,
      writeCompatFileAtomically: UNKNOWN_RAW_WRITER,
    },
  },
  "src/main/mcp-servers.ts": {
    capability: "mcp-mutation-port",
    managedRoles: ["config"],
  },
  "src/main/model-configuration-staged-profile.ts": {
    capability: "profile-staging-activation",
    stagedRoles: [...MANAGED_MODEL_ROLES],
    rawWriters: { activate: UNKNOWN_RAW_WRITER },
  },
  "src/main/profile-meta.ts": {
    capability: "profile-metadata-writer",
    rawWriters: { writeProfileMeta: UNKNOWN_RAW_WRITER },
  },
  "src/main/profiles.ts": {
    capability: "profile-clone-staging",
    stagedRoles: [...MANAGED_MODEL_ROLES],
    rawWriters: {
      stageGlobalCatalog: UNKNOWN_RAW_WRITER,
      stageCloneSource: UNKNOWN_RAW_WRITER,
      prepareProfile: UNKNOWN_RAW_WRITER,
      setActiveProfile: UNKNOWN_RAW_WRITER,
    },
    profileMaterializationFunctions: ["prepareProfile"],
  },
});

const RAW_WRITER_NAMES = new Set([
  "safeWriteFile",
  "writeFileSync",
  "writeFile",
  "copyFileSync",
  "renameSync",
]);

const SUBPROCESS_MARKER =
  /\bprofile\b[\s\S]{0,80}\bcreate\b[\s\S]{0,200}--clone-from/i;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function sourceFiles(root, includeRoot = "src/main") {
  const start = resolve(root, includeRoot);
  const result = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "out" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) &&
        !/\.(test|spec)\.[^.]+$/.test(entry.name)
      ) {
        result.push(path);
      }
    }
  };
  visit(start);
  return result.sort();
}

function roleForText(text) {
  for (const [role, filename] of Object.entries(ROLE_FILENAMES)) {
    if (role === "env") {
      // Match the managed filename `.env`, never the JavaScript property in
      // `process.env`/`import.meta.env` that can appear inside unrelated path
      // option objects propagated through the call graph.
      if (text === filename || /(?:^|[\\/'"`])\.env(?:$|[\\/'"`])/.test(text)) {
        return role;
      }
      continue;
    }
    if (text.includes(filename)) return role;
  }
  return null;
}

function expressionHints(expression, bindings, depth = 0) {
  if (!expression || depth > 8)
    return { text: "", roles: new Set(), unknown: true };
  const text = expression.getText();
  const roles = new Set();
  const addRole = (value) => {
    const role = roleForText(value);
    if (role) roles.add(role);
  };
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    addRole(expression.text);
    return { text, roles, unknown: false };
  }
  if (ts.isIdentifier(expression) && bindings.has(expression.text)) {
    const value = bindings.get(expression.text);
    return expressionHints(value, bindings, depth + 1);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const property = expression.name.text;
    addRole(property);
    const object = expressionHints(expression.expression, bindings, depth + 1);
    for (const role of object.roles) roles.add(role);
    // `plan.target` and `paths.config` are intentionally treated as unknown;
    // their owning module must therefore be registered explicitly.
    return { text, roles, unknown: true };
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression.getText();
    if (
      callee === "join" ||
      callee === "resolve" ||
      callee.endsWith(".join") ||
      callee.endsWith(".resolve")
    ) {
      let unknown = false;
      for (const argument of expression.arguments) {
        const child = expressionHints(argument, bindings, depth + 1);
        for (const role of child.roles) roles.add(role);
        unknown ||= child.unknown;
      }
      return { text, roles, unknown };
    }
    if (
      /profileHome|profilePaths|configFile|providersPath|modelsFile|modelDefinitionsFile/i.test(
        callee,
      )
    ) {
      return { text, roles, unknown: true };
    }
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = expressionHints(expression.left, bindings, depth + 1);
    const right = expressionHints(expression.right, bindings, depth + 1);
    for (const role of left.roles) roles.add(role);
    for (const role of right.roles) roles.add(role);
    return { text, roles, unknown: left.unknown || right.unknown };
  }
  addRole(text);
  return { text, roles, unknown: true };
}

function capabilityFor(relativeFile, capabilities) {
  return capabilities[relativeFile] ?? null;
}

function functionNameForNode(node) {
  for (let current = node; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return "<module>";
}

function capabilityAllowsRawWriter(capability, role, functionName) {
  if (!capability || !capability.rawWriters) return false;
  const rule = capability.rawWriters[functionName];
  if (!rule) return false;
  if (!role) return rule.allowUnknown === true;
  return Array.isArray(rule.roles) && rule.roles.includes(role);
}

function capabilityAllowsProfileMaterialization(capability, functionName) {
  return Boolean(
    capability?.profileMaterializationFunctions?.includes(functionName),
  );
}

function importBindingsFor(sourceFile) {
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) {
      imports.set(clause.name.text, {
        kind: "default",
        importedName: "default",
        moduleSpecifier,
      });
    }
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      imports.set(named.name.text, {
        kind: "namespace",
        importedName: "*",
        moduleSpecifier,
      });
    } else if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        imports.set(element.name.text, {
          kind: "named",
          importedName: element.propertyName?.text ?? element.name.text,
          moduleSpecifier,
        });
      }
    }
  }
  return imports;
}

function callName(expression, imports = new Map()) {
  if (ts.isIdentifier(expression)) {
    return imports.get(expression.text)?.importedName ?? expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = expression.expression.getText();
    const binding = imports.get(owner);
    if (binding?.kind === "namespace") return expression.name.text;
    if (owner === "fs" || owner === "fsp" || owner === "promises") {
      return expression.name.text;
    }
    return null;
  }
  return expression.getText();
}

function staticStrings(expression, bindings, depth = 0, seen = new Set()) {
  if (!expression || depth > 12) return [];
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return [expression.text];
  }
  if (ts.isIdentifier(expression) && bindings.has(expression.text)) {
    if (seen.has(expression.text)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(expression.text);
    return staticStrings(
      bindings.get(expression.text),
      bindings,
      depth + 1,
      nextSeen,
    );
  }
  const values = [];
  ts.forEachChild(expression, (child) => {
    values.push(...staticStrings(child, bindings, depth + 1, seen));
  });
  return values;
}

function lineOf(sourceFile, node) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function inspectFile(file, root, capabilities) {
  const source = readFileSync(file, "utf8");
  const relativeFile = relative(root, file).replaceAll("\\", "/");
  const capability = capabilityFor(relativeFile, capabilities);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = importBindingsFor(sourceFile);
  const bindings = new Map();
  const issues = [];
  const sourceMentionsManagedBoundary = Object.values(ROLE_FILENAMES).some(
    (filename) => source.includes(filename),
  );
  const rememberBindings = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      bindings.set(node.name.text, node.initializer);
    }
  };
  const report = (node, kind, role, reason) => {
    const functionName = functionNameForNode(node);
    if (
      kind === "raw_managed_writer" &&
      capabilityAllowsRawWriter(capability, role, functionName)
    ) {
      return;
    }
    if (
      kind === "profile_materialization_subprocess" &&
      capabilityAllowsProfileMaterialization(capability, functionName)
    ) {
      return;
    }
    issues.push({
      file: relativeFile,
      line: lineOf(sourceFile, node),
      functionName,
      kind,
      role,
      reason,
    });
  };
  const visit = (node) => {
    rememberBindings(node);
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression, imports);
      if (name && RAW_WRITER_NAMES.has(name)) {
        const target = node.arguments[0];
        const hints = expressionHints(target, bindings);
        const role = [...hints.roles][0] ?? null;
        if (role || (hints.unknown && sourceMentionsManagedBoundary)) {
          report(
            node,
            "raw_managed_writer",
            role,
            role
              ? `resolved ${role}`
              : "writer target is not statically bounded",
          );
        }
      }
      if (
        (name === "spawn" ||
          name === "spawnSync" ||
          name === "execFile" ||
          name === "execFileSync") &&
        SUBPROCESS_MARKER.test(
          node.arguments
            .flatMap((argument) => staticStrings(argument, bindings))
            .join(" "),
        )
      ) {
        report(
          node,
          "profile_materialization_subprocess",
          null,
          "profile create --clone-from must use staging capability",
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return issues;
}

function isFunctionNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function modulePathForImport(fromFile, moduleSpecifier, fileSet) {
  if (!moduleSpecifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), moduleSpecifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
    resolve(base, "index.js"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function collectVariableBindings(node, skipNestedFunctions = true) {
  const bindings = new Map();
  const visit = (current) => {
    if (current !== node && skipNestedFunctions && isFunctionNode(current)) {
      return;
    }
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer
    ) {
      bindings.set(current.name.text, current.initializer);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return bindings;
}

function topLevelFunctionRecords(info) {
  const records = [];
  const add = (name, node) => {
    if (!name || records.some((record) => record.name === name)) return;
    records.push({ name, node });
  };
  for (const statement of info.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        add(declaration.name.text, declaration.initializer);
      }
    }
  }
  add("<module>", info.sourceFile);
  return records;
}

function parameterIndexesForExpression(
  expression,
  bindings,
  parameterIndexes,
  depth = 0,
  seen = new Set(),
) {
  const indexes = new Set();
  if (!expression || depth > 12) return indexes;
  if (ts.isIdentifier(expression)) {
    if (parameterIndexes.has(expression.text)) {
      indexes.add(parameterIndexes.get(expression.text));
      return indexes;
    }
    if (bindings.has(expression.text) && !seen.has(expression.text)) {
      const nextSeen = new Set(seen);
      nextSeen.add(expression.text);
      return parameterIndexesForExpression(
        bindings.get(expression.text),
        bindings,
        parameterIndexes,
        depth + 1,
        nextSeen,
      );
    }
  }
  ts.forEachChild(expression, (child) => {
    for (const index of parameterIndexesForExpression(
      child,
      bindings,
      parameterIndexes,
      depth + 1,
      seen,
    )) {
      indexes.add(index);
    }
  });
  return indexes;
}

function recordIsAuthorizedTerminal(record, capabilities) {
  const capability = capabilityFor(record.relativeFile, capabilities);
  return Boolean(
    capability?.managedBoundaryFunctions?.includes(record.name) ||
    capability?.rawWriters?.[record.name],
  );
}

function resolveCalledRecord(expression, record, infoByFile, fileSet) {
  if (ts.isIdentifier(expression)) {
    const local = record.info.recordsByName.get(expression.text);
    if (local) return local;
    const binding = record.info.imports.get(expression.text);
    if (!binding || binding.kind !== "named") return null;
    const targetFile = modulePathForImport(
      record.info.file,
      binding.moduleSpecifier,
      fileSet,
    );
    return targetFile
      ? (infoByFile.get(targetFile)?.recordsByName.get(binding.importedName) ??
          null)
      : null;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (!ts.isIdentifier(expression.expression)) return null;
    const binding = record.info.imports.get(expression.expression.text);
    if (!binding || binding.kind !== "namespace") return null;
    const targetFile = modulePathForImport(
      record.info.file,
      binding.moduleSpecifier,
      fileSet,
    );
    return targetFile
      ? (infoByFile.get(targetFile)?.recordsByName.get(expression.name.text) ??
          null)
      : null;
  }
  return null;
}

function inspectIndirectWriterGraph(files, root, capabilities, directIssues) {
  const fileSet = new Set(files.map((file) => resolve(file)));
  const infoByFile = new Map();
  for (const file of fileSet) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const info = {
      file,
      relativeFile: relative(root, file).replaceAll("\\", "/"),
      sourceFile,
      imports: importBindingsFor(sourceFile),
      moduleBindings: collectVariableBindings(sourceFile),
      recordsByName: new Map(),
    };
    infoByFile.set(file, info);
  }

  const records = [];
  for (const info of infoByFile.values()) {
    for (const candidate of topLevelFunctionRecords(info)) {
      const parameters = new Map();
      for (const [index, parameter] of (
        candidate.node.parameters ?? []
      ).entries()) {
        if (ts.isIdentifier(parameter.name)) {
          parameters.set(parameter.name.text, index);
        }
      }
      const bindings = new Map(info.moduleBindings);
      for (const [name, initializer] of collectVariableBindings(
        candidate.node,
      )) {
        bindings.set(name, initializer);
      }
      const record = {
        info,
        relativeFile: info.relativeFile,
        name: candidate.name,
        node: candidate.node,
        bindings,
        parameters,
        edges: [],
        rawParameters: new Set(),
        fixedRoles: new Set(),
      };
      info.recordsByName.set(record.name, record);
      records.push(record);
    }
  }

  for (const record of records) {
    if (recordIsAuthorizedTerminal(record, capabilities)) continue;
    const visit = (node) => {
      if (node !== record.node && isFunctionNode(node)) return;
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression, record.info.imports);
        if (name && RAW_WRITER_NAMES.has(name)) {
          const target = node.arguments[0];
          const hints = expressionHints(target, record.bindings);
          for (const role of hints.roles) record.fixedRoles.add(role);
          for (const index of parameterIndexesForExpression(
            target,
            record.bindings,
            record.parameters,
          )) {
            record.rawParameters.add(index);
          }
        } else {
          const callee = resolveCalledRecord(
            node.expression,
            record,
            infoByFile,
            fileSet,
          );
          if (callee) record.edges.push({ node, callee });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(record.node);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (recordIsAuthorizedTerminal(record, capabilities)) continue;
      for (const edge of record.edges) {
        for (const role of edge.callee.fixedRoles) {
          if (!record.fixedRoles.has(role)) {
            record.fixedRoles.add(role);
            changed = true;
          }
        }
        for (const calleeIndex of edge.callee.rawParameters) {
          const argument = edge.node.arguments[calleeIndex];
          if (!argument) continue;
          const hints = expressionHints(argument, record.bindings);
          for (const role of hints.roles) {
            if (!record.fixedRoles.has(role)) {
              record.fixedRoles.add(role);
              changed = true;
            }
          }
          for (const index of parameterIndexesForExpression(
            argument,
            record.bindings,
            record.parameters,
          )) {
            if (!record.rawParameters.has(index)) {
              record.rawParameters.add(index);
              changed = true;
            }
          }
        }
      }
    }
  }

  const existing = new Set(
    directIssues.map(
      (issue) =>
        `${issue.file}\u0000${issue.functionName}\u0000${issue.role ?? ""}`,
    ),
  );
  const issues = [];
  for (const record of records) {
    if (recordIsAuthorizedTerminal(record, capabilities)) continue;
    const capability = capabilityFor(record.relativeFile, capabilities);
    for (const role of record.fixedRoles) {
      const key = `${record.relativeFile}\u0000${record.name}\u0000${role}`;
      if (existing.has(key)) continue;
      if (capabilityAllowsRawWriter(capability, role, record.name)) continue;
      issues.push({
        file: record.relativeFile,
        line: lineOf(record.info.sourceFile, record.node),
        functionName: record.name,
        kind: "indirect_raw_managed_writer",
        role,
        reason:
          "managed role reaches a raw writer through the import/call graph",
      });
      existing.add(key);
    }
  }
  return issues;
}

function loadCapabilities(root, extra) {
  const merged = {};
  for (const [file, value] of Object.entries(MANAGED_WRITER_CAPABILITIES))
    merged[file] = value;
  for (const [file, value] of Object.entries(extra ?? {}))
    merged[file.replaceAll("\\", "/")] = value;
  return merged;
}

export function verifyManagedModelWriters({
  root = process.cwd(),
  includeRoot = "src/main",
  capabilities,
  fixtureRoot,
} = {}) {
  const projectRoot = resolve(root);
  const files = fixtureRoot
    ? sourceFiles(resolve(projectRoot, fixtureRoot), "")
    : sourceFiles(projectRoot, includeRoot);
  const registry = loadCapabilities(projectRoot, capabilities);
  const directIssues = files.flatMap((file) =>
    inspectFile(file, projectRoot, registry),
  );
  const graphIssues = inspectIndirectWriterGraph(
    files,
    projectRoot,
    registry,
    directIssues,
  );
  const issues = [...directIssues, ...graphIssues];
  return {
    ok: issues.length === 0,
    root: projectRoot,
    filesScanned: files.length,
    issues,
    capabilities: registry,
  };
}

function printReport(report) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: report.ok,
        root: report.root,
        filesScanned: report.filesScanned,
        issueCount: report.issues.length,
        issues: report.issues,
      },
      null,
      2,
    ) + "\n",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.url.slice("file://".length))
) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
  const report = verifyManagedModelWriters({ root });
  printReport(report);
  process.exitCode = report.ok ? 0 : 1;
}
