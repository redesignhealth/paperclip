/**
 * Walks an error's `.cause` chain (guarding against cycles) looking for the
 * first node for which `extract` returns a defined value. Drizzle/pg errors
 * are sometimes wrapped (e.g. by transaction retry logic or the driver
 * itself), so a Postgres error code or constraint name can show up a level
 * or two below the error actually thrown/caught -- this is the one place
 * that walk lives, shared by every "is this a Postgres error with shape X"
 * helper instead of each call site reimplementing (and subtly diverging on)
 * the same loop.
 */
export function findInErrorCauseChain<T>(
  error: unknown,
  extract: (node: object) => T | undefined,
): T | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const result = extract(current);
    if (result !== undefined) return result;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True if `error`, or any error in its `.cause` chain, carries the given
 * Postgres error code (e.g. "23505" unique_violation, "42703"
 * undefined_column). Walks the cause chain because drizzle can wrap the
 * underlying `pg` error.
 */
export function isPostgresError(error: unknown, code: string): boolean {
  return (
    findInErrorCauseChain(error, (node) => {
      const maybe = node as { code?: string };
      return maybe.code === code ? true : undefined;
    }) ?? false
  );
}

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}
