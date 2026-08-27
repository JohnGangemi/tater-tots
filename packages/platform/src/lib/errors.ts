export type ErrorCode =
  | "usage"
  | "config"
  | "not_found"
  | "no_command"
  | "denied"
  | "graph_unavailable"
  | "graph_timeout"
  | "io"
  | "internal";

export type PlatformErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
  };
};

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    if (hint !== undefined) {
      this.hint = hint;
    }
  }

  toJSON(): PlatformErrorBody {
    const error: PlatformErrorBody["error"] = {
      code: this.code,
      message: this.message,
    };
    if (this.hint !== undefined) {
      error.hint = this.hint;
    }
    return { error };
  }
}

export function isPlatformError(value: unknown): value is PlatformError {
  return value instanceof PlatformError;
}

export function exitCodeFor(err: PlatformError, asGate = false): number {
  switch (err.code) {
    case "usage":
    case "config":
    case "not_found":
      return 1;
    case "no_command":
    case "denied":
      return asGate ? 2 : 1;
    case "graph_unavailable":
    case "graph_timeout":
    case "io":
    case "internal":
      return 3;
    default: {
      const _never: never = err.code;
      return _never;
    }
  }
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return "internal error";
}
