export type RuntimeCleanupOperation = () => void | Promise<void>;

export async function settleRuntimeCleanup(
  operations: readonly RuntimeCleanupOperation[],
): Promise<void> {
  const results = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation)),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Aera Runtime cleanup failed.");
  }
}
