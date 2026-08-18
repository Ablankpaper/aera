import type {
  ManagedModelFileRoots,
  ManagedWriteScope,
  ModelConfigurationWritePermit,
} from "../../src/main/model-configuration-write-authority";

export interface ManagedModelTestWriteInput {
  roots: ManagedModelFileRoots;
  scope: ManagedWriteScope;
}

/**
 * Run a low-level managed-file unit test with the same module-local root
 * registry and AsyncLocalStorage permit instance as the code under test.
 *
 * The imports intentionally happen at call time: many legacy tests use
 * `vi.resetModules()`, so a statically captured authority would issue a permit
 * that the freshly imported writer cannot recognize.
 */
export async function withManagedModelTestWrite<T>(
  input: ManagedModelTestWriteInput,
  callback: (permit: ModelConfigurationWritePermit) => T | Promise<T>,
): Promise<T> {
  const [managed, authority] = await Promise.all([
    import("../../src/main/model-configuration-managed-files"),
    import("../../src/main/model-configuration-write-authority"),
  ]);
  managed.registerManagedModelFileRoots(input.roots);
  try {
    return await new authority.ModelConfigurationWriteAuthority().run(
      input.scope,
      callback,
    );
  } finally {
    managed.clearManagedModelFileRoots();
  }
}
