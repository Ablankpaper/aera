export async function prepareModelConfigurationAfterAuth<TAuthState, TResult>(
  initializeAuth: () => Promise<TAuthState>,
  awaitOwnerTransition: () => Promise<void>,
  prepare: (authState: TAuthState) => Promise<TResult>,
): Promise<TResult> {
  const authState = await initializeAuth();
  await awaitOwnerTransition();
  return prepare(authState);
}
