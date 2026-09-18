export const azureSdkOperationOptions = (
  timeoutMs: number,
  signal?: AbortSignal,
): {
  abortSignal?: AbortSignal;
  requestOptions: { timeout: number };
} => ({
  ...(signal === undefined ? {} : { abortSignal: signal }),
  requestOptions: { timeout: timeoutMs },
});
