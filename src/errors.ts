/** An error answer from the Vercel API, or a request that timed out (status 504, code "timeout"). */
export class VercelApiError extends Error {
  override readonly name = "VercelApiError";

  constructor(
    /** The HTTP status. 504 for a request that timed out on our side. */
    readonly status: number,
    /** Vercel's error code, e.g. "forbidden" or "rate_limited", else `http_<status>`. */
    readonly code: string,
    message: string,
    /** How long Vercel asked us to wait before the next request, from `retry-after` or `x-ratelimit-reset`. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }

  /** The token is wrong, expired, or has no access to this team or project. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Vercel rate-limited the token. `retryAfterMs` says how long to wait. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * The team's plan doesn't include this query. Vercel answers 402 to UTM breakdowns without Web Analytics Plus
   * (or Enterprise).
   */
  get isPlanRequired(): boolean {
    return this.status === 402;
  }
}
