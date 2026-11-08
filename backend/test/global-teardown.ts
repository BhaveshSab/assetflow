export default async function globalTeardown() {
  const state = globalThis as typeof globalThis & {
    __assetflowTestCleanup?: () => Promise<void>;
  };
  await state.__assetflowTestCleanup?.();
  delete state.__assetflowTestCleanup;
}
