# Runtime distribution test keys

These Ed25519 keys are deterministic test fixtures only. The private key is
intentionally committed so tests can construct signed manifests without any
production signing material.

The key id is `agentera-runtime-test-01`. It is not present in the production
Aera Runtime trust set and cannot sign a distributable Runtime release.
