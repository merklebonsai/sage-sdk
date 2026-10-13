import {
  assertBatch,
  assertDecide,
  assertEstimate,
  parseBatch,
  parseDecide,
  parseEstimate,
  stubBatch,
  stubDecide,
  stubEstimate,
} from "./decide.ts";
import { SageError } from "./error.ts";
import { invariant } from "./invariant.ts";
import type {
  BatchBody,
  BatchGroup,
  BatchOf,
  CallOptions,
  ContentFor,
  DecideBody,
  DecisionOf,
  Estimate,
  EstimateBody,
  Question,
  SageOptions,
} from "./types.ts";

const DEFAULT_BASE = "https://sage.levanto.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

type Resolved = {
  apiKey: string | null;
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  stub: boolean;
  retry503: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envKey(): string | undefined {
  const scope: unknown = globalThis;
  if (!isRecord(scope)) return undefined;
  const proc = scope.process;
  if (!isRecord(proc)) return undefined;
  const env = proc.env;
  if (!isRecord(env)) return undefined;
  const key = env.SAGE_API_KEY;
  return typeof key === "string" && key !== "" ? key : undefined;
}

function resolveOptions(options: SageOptions): Resolved {
  const stub = options.stub === true;
  const apiKey = options.apiKey ?? (stub ? null : (envKey() ?? null));
  invariant(
    stub || apiKey !== null,
    "apiKey is required (or set SAGE_API_KEY). Pass stub: true to stay offline.",
  );
  invariant(
    options.timeoutMs === undefined ||
      (Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= MAX_TIMEOUT_MS),
    `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
  );
  return {
    apiKey,
    baseUrl: (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, ""),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stub,
    retry503: options.retry503 !== false,
  };
}

function httpDetail(json: unknown, text: string, status: number): string {
  if (isRecord(json) && typeof json.detail === "string" && json.detail !== "") return json.detail;
  if (isRecord(json) && Array.isArray(json.detail)) {
    const parts: string[] = [];
    for (const item of json.detail) {
      if (isRecord(item) && typeof item.msg === "string" && item.msg !== "") parts.push(item.msg);
    }
    if (parts.length > 0) return parts.join("; ");
  }
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 180);
  return snippet === "" ? `HTTP ${status}` : snippet;
}

async function readBody(response: Response): Promise<{ text: string; json: unknown | undefined }> {
  const text = await response.text();
  if (text === "") return { text, json: undefined };
  try {
    const json: unknown = JSON.parse(text);
    return { text, json };
  } catch {
    return { text, json: undefined };
  }
}

function transportError(error: unknown): SageError {
  if (error instanceof SageError) return error;
  if (isRecord(error) && error.name === "TimeoutError") return new SageError("timeout", null, "Request timed out.");
  if (isRecord(error) && error.name === "AbortError") return new SageError("timeout", null, "Request was aborted.");
  return new SageError("network", null, "Network request failed.");
}

function retryDelay(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return 200;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return 200;
  return Math.min(Math.round(seconds * 1000), 2000);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SageError("timeout", null, "Request was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SageError("timeout", null, "Request was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** HTTP client for `decide`, `batch`, `estimate`, and `ready`. */
export class SageApi {
  readonly #options: Resolved;

  constructor(options: SageOptions = {}) {
    this.#options = resolveOptions(options);
  }

  /** `POST /decide`. A null answer is a successful decision, not an error. */
  decide<const Q extends Question, const C extends ContentFor<Q>>(
    request: DecideBody<Q, C>,
    call?: CallOptions,
  ): Promise<DecisionOf<Q, C>> {
    assertDecide(request);
    if (this.#options.stub) return Promise.resolve(stubDecide(request));
    const snapshot = structuredClone(request);
    return this.#post("/decide", snapshot, call?.signal).then((raw) => parseDecide(snapshot, raw));
  }

  /** `POST /decide/batch`. One question can fail while its siblings still return. */
  batch<const Groups extends readonly BatchGroup[]>(
    request: BatchBody<Groups>,
    call?: CallOptions,
  ): Promise<BatchOf<Groups>> {
    assertBatch(request);
    if (this.#options.stub) return Promise.resolve(stubBatch(request));
    const snapshot = structuredClone(request);
    return this.#post("/decide/batch", snapshot, call?.signal).then((raw) => parseBatch(snapshot, raw));
  }

  /** `POST /usage/estimate`. Same body as decide or batch. Does not run the decision. */
  estimate(body: EstimateBody, call?: CallOptions): Promise<Estimate> {
    assertEstimate(body);
    if (this.#options.stub) return Promise.resolve(stubEstimate(body));
    return this.#post("/usage/estimate", body, call?.signal).then(parseEstimate);
  }

  /** `GET /ready`. True on 200, false on 503. No API key is sent. */
  async ready(call?: CallOptions): Promise<boolean> {
    if (this.#options.stub) return true;
    const signal = this.#signal(call?.signal);
    try {
      const response = await this.#options.fetch(`${this.#options.baseUrl}/ready`, { method: "GET", signal });
      if (response.status === 200) return true;
      if (response.status === 503) return false;
      const { text, json } = await readBody(response);
      throw new SageError("http", response.status, httpDetail(json, text, response.status));
    } catch (error) {
      throw transportError(error);
    }
  }

  #signal(caller: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.#options.timeoutMs);
    return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
  }

  async #post(path: string, body: unknown, caller: AbortSignal | undefined): Promise<unknown> {
    const signal = this.#signal(caller);
    try {
      const serialized = JSON.stringify(body);
      invariant(serialized !== undefined, "request is not JSON");
      let response = await this.#fetch(path, serialized, signal);
      if (response.status === 503 && this.#options.retry503) {
        const wait = retryDelay(response);
        await response.body?.cancel();
        await delay(wait, signal);
        response = await this.#fetch(path, serialized, signal);
      }
      const { text, json } = await readBody(response);
      invariant(response.ok, httpDetail(json, text, response.status), "http", response.status);
      invariant(json !== undefined, "Response was not JSON.", "protocol", response.status);
      return json;
    } catch (error) {
      throw transportError(error);
    }
  }

  async #fetch(path: string, body: string, signal: AbortSignal): Promise<Response> {
    const key = this.#options.apiKey;
    invariant(key !== null, "apiKey is required");
    try {
      return await this.#options.fetch(`${this.#options.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal,
      });
    } catch (error) {
      throw transportError(error);
    }
  }
}
