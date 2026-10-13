export type SageErrorKind = "http" | "protocol" | "timeout" | "network" | "invalid";

/** One error for HTTP, protocol, transport, and local rejects. Switch on `kind` and `status`. */
export class SageError extends Error {
  readonly name = "SageError";
  readonly kind: SageErrorKind;
  readonly status: number | null;
  readonly detail: string;

  constructor(kind: SageErrorKind, status: number | null, detail: string) {
    super(detail);
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}
