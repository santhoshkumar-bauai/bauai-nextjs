/** Failure classes and their retry behaviour, from architecture section 11.1. */
export type FailureClass =
  | "RATE_LIMITED"
  | "TRANSIENT_HTTP"
  | "AUTHENTICATION"
  | "MONGO_TRANSIENT"
  | "MALFORMED_PAYLOAD"
  | "MISSING_IDENTITY"
  | "CIRCUIT_OPEN"
  | "PERMANENT";

export interface IngestionErrorOptions {
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class IngestionError extends Error {
  readonly failureClass: FailureClass;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    failureClass: FailureClass,
    options: IngestionErrorOptions,
  ) {
    super(message, { cause: options.cause });
    this.name = `IngestionError:${failureClass}`;
    this.failureClass = failureClass;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function rateLimited(message: string, retryAfterMs?: number): IngestionError {
  return new IngestionError(message, "RATE_LIMITED", {
    retryable: true,
    httpStatus: 429,
    retryAfterMs,
  });
}

export function transientHttp(message: string, httpStatus: number, cause?: unknown) {
  return new IngestionError(message, "TRANSIENT_HTTP", {
    retryable: true,
    httpStatus,
    cause,
  });
}

/** Never retried aggressively: a bad credential will not fix itself (§11.1). */
export function authenticationFailure(message: string, httpStatus: number) {
  return new IngestionError(message, "AUTHENTICATION", {
    retryable: false,
    httpStatus,
  });
}

export function malformedPayload(message: string, cause?: unknown): IngestionError {
  return new IngestionError(message, "MALFORMED_PAYLOAD", {
    retryable: false,
    cause,
  });
}

export function missingIdentity(message: string): IngestionError {
  return new IngestionError(message, "MISSING_IDENTITY", { retryable: false });
}

export function permanent(message: string, cause?: unknown): IngestionError {
  return new IngestionError(message, "PERMANENT", { retryable: false, cause });
}

export function circuitOpen(source: string, until: Date): IngestionError {
  return new IngestionError(
    `Circuit for ${source} is open until ${until.toISOString()}`,
    "CIRCUIT_OPEN",
    { retryable: true, retryAfterMs: Math.max(0, until.getTime() - Date.now()) },
  );
}

/** MongoDB marks its own retryable failures; honour the driver's judgement. */
export function classifyMongoError(error: unknown): IngestionError {
  const labels = (error as { errorLabels?: string[] }).errorLabels ?? [];
  const retryable =
    labels.includes("TransientTransactionError") ||
    labels.includes("UnknownTransactionCommitResult") ||
    labels.includes("RetryableWriteError");

  return new IngestionError(
    error instanceof Error ? error.message : String(error),
    retryable ? "MONGO_TRANSIENT" : "PERMANENT",
    { retryable, cause: error },
  );
}

export function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number }).code === 11000;
}
