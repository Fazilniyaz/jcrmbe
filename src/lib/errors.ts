/**
 * The one error type routes and services throw.
 *
 * `code` is a stable machine-readable slug the frontend can branch on; `message`
 * is safe to show a user. Anything not an ApiError reaching the error handler is
 * treated as a bug and answered with a generic 500 — internal detail never
 * leaves the process.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, "bad_request", message, details);
  }

  static unauthorized(message = "Authentication required.") {
    return new ApiError(401, "unauthorized", message);
  }

  static forbidden(message = "You don't have access to this.") {
    return new ApiError(403, "forbidden", message);
  }

  static notFound(message = "Not found.") {
    return new ApiError(404, "not_found", message);
  }

  static conflict(message: string, details?: unknown) {
    return new ApiError(409, "conflict", message, details);
  }

  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, "validation_error", message, details);
  }

  static tooMany(message = "Too many requests. Try again shortly.") {
    return new ApiError(429, "rate_limit_exceeded", message);
  }
}

/**
 * Deliberately identical for "no such user", "wrong password", "account
 * disabled" and "still invited". Distinguishing them turns the login form into
 * an account-existence oracle.
 */
export const INVALID_CREDENTIALS = "Those credentials don't match an account.";
