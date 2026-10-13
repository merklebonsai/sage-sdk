import { SageError, type SageErrorKind } from "./error.ts";

export function invariant(
  condition: unknown,
  detail: string | (() => string),
  kind: SageErrorKind = "invalid",
  status: number | null = null,
): asserts condition {
  if (condition) return;
  throw new SageError(kind, status, typeof detail === "function" ? detail() : detail);
}
