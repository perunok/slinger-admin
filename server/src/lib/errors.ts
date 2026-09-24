export type ErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "workspace_access_denied"
  | "version_mismatch"
  | "invite_invalid"
  | "join_request_not_allowed"
  | "sync_conflict"
  | "csrf_invalid"
  | "origin_not_allowed"
  | "internal_error";

const statusByCode: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  workspace_access_denied: 403,
  version_mismatch: 409,
  invite_invalid: 403,
  join_request_not_allowed: 400,
  sync_conflict: 409,
  csrf_invalid: 403,
  origin_not_allowed: 403,
  internal_error: 500
};

export class AppError extends Error {
  code: ErrorCode;
  status: number;
  details?: Record<string, unknown>;

  /** Alias used by @fastify/rate-limit, which reads `statusCode` off thrown errors. */
  get statusCode(): number {
    return this.status;
  }

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, status?: number) {
    super(message);
    this.code = code;
    this.status = status ?? statusByCode[code];
    this.details = details;
  }
}

export function errorBody(code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      details: details ?? {},
      request_id: requestId
    }
  };
}

export function statusForCode(code: ErrorCode): number {
  return statusByCode[code];
}
