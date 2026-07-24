/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const implementationFiles = [
  "bootstrap-host.sh",
  "generate-secrets.sh",
  "install-ip-certificate.sh",
  "render-operator-record.mjs",
];

const policies = [
  {
    label: "literal IPv4 address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
  },
  {
    label: "embedded private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
  {
    label: "credential-shaped token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/u,
  },
  {
    label: "hard-coded secret assignment",
    pattern:
      /\b(?:PASSWORD|TOKEN|SECRET|API_KEY|HMAC_KEY|PRIVATE_KEY)\s*=\s*["']?(?![$%])[A-Za-z0-9+/_=-]{12,}["']?/iu,
  },
  {
    label: "disabled SSH host-key verification",
    pattern: /StrictHostKeyChecking\s*=\s*no/iu,
  },
  {
    label: "unsafe recursive delete",
    pattern:
      /\brm\s+(?:-[^\n ]*r[^\n ]*\s+|--recursive\s+)(?:\/(?:\s|$)|~(?:\/|\s|$)|["']?\$(?:HOME|[A-Z_]*ROOT|[A-Z_]*DIR)\b)/iu,
  },
  {
    label: "shell tracing",
    pattern: /\bset\s+-[a-z]*x[a-z]*\b/iu,
  },
  {
    label: "password helper or persisted password",
    pattern: /\b(?:sshpass|chpasswd)\b|(?:password|passwd).*(?:>>?|tee)\s/iu,
  },
  {
    label: "secret echo",
    pattern:
      /\becho\s+["']?\$\{?[^}\n]*(?:PASSWORD|TOKEN|SECRET|PRIVATE_KEY|HMAC_KEY)/iu,
  },
];

function assertPolicySafe(source, label) {
  for (const policy of policies) {
    assert.doesNotMatch(source, policy.pattern, `${label}: ${policy.label}`);
  }
}

test("policy catches every prohibited source shape", () => {
  const badSources = [
    `PUBLIC_ORIGIN=https://${[203, 0, 113, 9].join(".")}`,
    ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
    `TOKEN='${`ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`}'`,
    `PASSWORD='${"fixture-password-value"}'`,
    `ssh -o ${["StrictHostKeyChecking", "no"].join("=")} host`,
    `rm -rf ${"$"}HOME`,
    `set ${"-"}x`,
    `${["ssh", "pass"].join("")} -p value ssh host`,
    `echo "${"$"}SERVICE_TOKEN"`,
  ];

  for (let index = 0; index < badSources.length; index += 1) {
    assert.throws(
      () => assertPolicySafe(badSources[index], `fixture-${index}`),
      /fixture-/,
    );
  }
});

test("tracked internal-beta operator implementations contain no prohibited material", async () => {
  for (const file of implementationFiles) {
    const source = await readFile(path.join(directory, file), "utf8");
    assertPolicySafe(source, file);
  }
});

test("host preparation persists and validates the requested SSH port before firewall reload", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  assert.match(source, /configure_ssh_port\(\)/u);
  assert.match(source, /printf 'Port %s\\n' "\$ssh_port"/u);
  assert.match(source, /\/usr\/sbin\/sshd -T/u);

  const configure = source.indexOf('configure_ssh_port "$ssh_port"');
  const firewall = source.indexOf('configure_firewall "$ssh_port"');
  const reload = source.indexOf("reload_ssh_service", firewall);
  assert.ok(configure >= 0, "prepare must configure the requested SSH port");
  assert.ok(firewall > configure, "firewall must follow validated SSH config");
  assert.ok(reload > firewall, "SSH reload must follow the firewall update");
});

test("Docker repository downloads tolerate unreachable CDN edges", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  const repositoryInstaller = source.slice(
    source.indexOf("install_docker_repository()"),
    source.indexOf("install_certbot()"),
  );

  assert.match(repositoryInstaller, /curl[\s\S]*--ipv4/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--retry 5/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--retry-all-errors/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--connect-timeout 10/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--max-time 60/u);
});

test("deployment account can traverse the root-owned application directory", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  const directoryConfiguration = source.slice(
    source.indexOf("configure_directories()"),
    source.indexOf("configure_unattended_updates()"),
  );

  assert.match(
    directoryConfiguration,
    /install -d -m 0755 -o root -g root \/opt\/aera/u,
  );
  assert.ok(
    directoryConfiguration.indexOf(
      "install -d -m 0755 -o root -g root /opt/aera",
    ) < directoryConfiguration.indexOf('"$install_root"'),
    "the traversable application parent must exist before the deploy-owned root",
  );
  assert.match(
    directoryConfiguration,
    /install -d -m 0755 -o root -g root \/etc\/aera/u,
  );
  assert.match(
    directoryConfiguration,
    /install -d -m 0755 -o root -g root \/var\/lib\/aera/u,
  );
  assert.ok(
    directoryConfiguration.indexOf(
      "install -d -m 0755 -o root -g root /etc/aera",
    ) < directoryConfiguration.indexOf('"$secret_root"'),
    "the traversable secret parent must exist before the restricted secret root",
  );
  assert.ok(
    directoryConfiguration.indexOf(
      "install -d -m 0755 -o root -g root /var/lib/aera",
    ) < directoryConfiguration.indexOf('"$state_root"'),
    "the traversable state parent must exist before the deploy-owned state root",
  );
});

test("secret generation does not hide OpenSSL diagnostics", async () => {
  const source = await readFile(
    path.join(directory, "generate-secrets.sh"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /openssl (?:genpkey|pkey|req|x509)[\s\S]{0,240}2>\/dev\/null/u,
  );
});
