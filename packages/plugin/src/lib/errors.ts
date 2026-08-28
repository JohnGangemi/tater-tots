export type PluginErrorCode =
  "usage" | "config" | "not_found" | "io" | "internal";

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly hint?: string;

  constructor(code: PluginErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    if (hint !== undefined) {
      this.hint = hint;
    }
  }
}

export function isPluginError(value: unknown): value is PluginError {
  return value instanceof PluginError;
}

export function pluginExitCode(err: PluginError): number {
  switch (err.code) {
    case "usage":
    case "config":
    case "not_found":
      return 1;
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
