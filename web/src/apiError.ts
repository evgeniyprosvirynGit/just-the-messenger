export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export async function apiErrorFromResponse(response: Response, fallback: string): Promise<ApiError> {
  let code = fallback;
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") code = payload.error;
  } catch {
    // Use the caller's stable fallback when the API response is not JSON.
  }
  const retryAfterHeader = response.status === 429 ? response.headers.get("Retry-After") : null;
  const parsedRetryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
    ? Number(retryAfterHeader)
    : Number.NaN;
  const retryAfterSeconds = Number.isSafeInteger(parsedRetryAfter) && parsedRetryAfter >= 0
    ? parsedRetryAfter
    : undefined;
  return new ApiError(code, response.status, retryAfterSeconds);
}
