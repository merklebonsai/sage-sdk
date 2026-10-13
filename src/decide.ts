import { SageError } from "./error.ts";
import { invariant } from "./invariant.ts";
import type {
  BatchBody,
  TagRecord,
  BatchGroup,
  BatchMeta,
  BatchOf,
  BatchQuestion,
  ChoiceQuestion,
  Content,
  ContentFor,
  DecideBody,
  DecisionOf,
  Estimate,
  EstimateBody,
  Grounding,
  GroundingMeta,
  LatencyMode,
  ListContent,
  Meta,
  Question,
  ReasoningMeta,
  ReasoningMode,
  ScaleQuestion,
  SortQuestion,
  TagsQuestion,
  Usage,
  YesNoQuestion,
} from "./types.ts";

// OpenAPI ChoiceQuestion.maxItems is 256 as of 2026-10-08. limits.md still says 120.
const CHOICE_MIN = 2;
const CHOICE_MAX = 256;
const CHOICE_MAX_IMAGE = 20;
const SCALE_MIN = 2;
const SCALE_MAX = 26;
const SORT_MIN = 2;
const SORT_MAX = 120;
const TAGS_MIN = 1;
const TAGS_MAX = 120;

const FNV_OFFSET = 2166136261;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImage(content: Content): content is { kind: "image"; media: string; text?: string | null } {
  return typeof content === "object" && content.kind === "image";
}

function isList(content: Content): content is ListContent {
  return typeof content === "object" && content.kind === "list";
}

function record(value: unknown, path: string): Record<string, unknown> {
  invariant(isRecord(value), `${path} must be an object`, "protocol");
  return value;
}

function list(value: unknown, path: string): readonly unknown[] {
  invariant(Array.isArray(value), `${path} must be an array`, "protocol");
  return value;
}

function at<T>(values: readonly T[], index: number, path: string): T {
  const value = values[index];
  invariant(value !== undefined, `${path} is missing`, "protocol");
  return value;
}

function reqString(value: unknown, path: string): string {
  invariant(typeof value === "string", `${path} must be a string`, "protocol");
  return value;
}

function reqNumber(value: unknown, path: string): number {
  invariant(typeof value === "number" && Number.isFinite(value), `${path} must be a finite number`, "protocol");
  return value;
}

function reqProbability(value: unknown, path: string): number {
  const probability = reqNumber(value, path);
  invariant(probability >= 0 && probability <= 1, `${path} must be between 0 and 1`, "protocol");
  return probability;
}

function optProbability(value: unknown, path: string): number | null {
  return value == null ? null : reqProbability(value, path);
}

function reqBoolean(value: unknown, path: string): boolean {
  invariant(typeof value === "boolean", `${path} must be a boolean`, "protocol");
  return value;
}

function optString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return reqString(value, path);
}

function optNumber(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  return reqNumber(value, path);
}

function optBoolean(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null;
  return reqBoolean(value, path);
}

function assertFinite(value: unknown, path: string): void {
  if (typeof value === "number") {
    invariant(Number.isFinite(value), `${path} must be a finite number`);
    return;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFinite(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) assertFinite(item, `${path}.${key}`);
    return;
  }
  throw new SageError("invalid", null, `${path} is not JSON`);
}

function assertQuestion(question: Question, content: Content, path: string): void {
  invariant(question.id !== "", `${path}.id must not be empty`);
  switch (question.kind) {
    case "yesno":
      return;
    case "choice": {
      const max = isImage(content) ? CHOICE_MAX_IMAGE : CHOICE_MAX;
      const count = question.options.length;
      invariant(count >= CHOICE_MIN && count <= max, `${path}.options must have ${CHOICE_MIN}..${max} items`);
      const seen = new Set<string>();
      for (const [index, option] of question.options.entries()) {
        invariant(option.option !== "", `${path}.options[${index}].option must not be empty`);
        invariant(!seen.has(option.option), `${path}.options[${index}].option is duplicated`);
        seen.add(option.option);
      }
      return;
    }
    case "scale": {
      const count = question.levels.length;
      invariant(count >= SCALE_MIN && count <= SCALE_MAX, `${path}.levels must have ${SCALE_MIN}..${SCALE_MAX} items`);
      const seen = new Set<number>();
      for (const [index, level] of question.levels.entries()) {
        invariant(Number.isInteger(level.level), `${path}.levels[${index}].level must be an integer`);
        invariant(!seen.has(level.level), `${path}.levels[${index}].level is duplicated`);
        seen.add(level.level);
      }
      return;
    }
    case "sort": {
      invariant(isList(content), 'sort requires content.kind "list"');
      const count = content.value.length;
      invariant(count >= SORT_MIN && count <= SORT_MAX, `content.value must have ${SORT_MIN}..${SORT_MAX} items`);
      const seen = new Set<string>();
      for (const [index, item] of content.value.entries()) {
        invariant(item.id !== "", `content.value[${index}].id must not be empty`);
        invariant(!seen.has(item.id), `content.value[${index}].id is duplicated`);
        seen.add(item.id);
      }
      return;
    }
    case "tags": {
      const count = question.tags.length;
      invariant(count >= TAGS_MIN && count <= TAGS_MAX, `${path}.tags must have ${TAGS_MIN}..${TAGS_MAX} items`);
      const seen = new Set<string>();
      for (const [index, tag] of question.tags.entries()) {
        invariant(tag.id !== "", `${path}.tags[${index}].id must not be empty`);
        invariant(!seen.has(tag.id), `${path}.tags[${index}].id is duplicated`);
        seen.add(tag.id);
      }
      return;
    }
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

export function assertDecide(request: {
  content: Content;
  question: Question;
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
  grounding?: Grounding | null;
}): void {
  assertFinite(request, "request");
  assertQuestion(request.question, request.content, "question");
  invariant(
    request.grounding == null || !isImage(request.content),
    "grounding cannot be combined with an image",
  );
  invariant(
    request.grounding == null || request.question.kind !== "sort",
    "grounding cannot be combined with sort",
  );
}

export function assertBatch(request: {
  requests: readonly { content: Content; questions: readonly BatchQuestion[] }[];
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
}): void {
  assertFinite(request, "request");
  invariant(request.requests.length >= 1, "requests must not be empty");
  for (const [groupIndex, group] of request.requests.entries()) {
    invariant(group.questions.length >= 1, `requests[${groupIndex}].questions must not be empty`);
    for (const [questionIndex, question] of group.questions.entries()) {
      const path = `requests[${groupIndex}].questions[${questionIndex}]`;
      assertQuestion(question, group.content, path);
      const raw: unknown = question;
      if (question.kind === "sort") {
        invariant(
          !isRecord(raw) || raw.grounding == null,
          `${path}.grounding cannot be combined with sort`,
        );
      } else {
        invariant(
          question.grounding == null || !isImage(group.content),
          `${path}.grounding cannot be combined with an image`,
        );
      }
    }
  }
}

export function assertEstimate(body: EstimateBody): void {
  if ("requests" in body) assertBatch(body);
  else assertDecide(body);
}

function parseUsage(value: unknown, path: string): Usage {
  const usage = record(value, path);
  return {
    billed_input_tokens: reqNumber(usage.billed_input_tokens, `${path}.billed_input_tokens`),
    rendered_tokens: optNumber(usage.rendered_tokens, `${path}.rendered_tokens`),
    image_count: usage.image_count == null ? 0 : reqNumber(usage.image_count, `${path}.image_count`),
    image_tokens: usage.image_tokens == null ? 0 : reqNumber(usage.image_tokens, `${path}.image_tokens`),
    input_tokens: optNumber(usage.input_tokens, `${path}.input_tokens`),
    output_tokens: optNumber(usage.output_tokens, `${path}.output_tokens`),
  };
}

function parseReasoning(value: unknown): ReasoningMeta {
  const row = record(value, "meta.reasoning");
  return {
    fired: reqBoolean(row.fired, "meta.reasoning.fired"),
    ran: reqBoolean(row.ran, "meta.reasoning.ran"),
    finished: row.finished == null ? null : reqBoolean(row.finished, "meta.reasoning.finished"),
    tokens: optNumber(row.tokens, "meta.reasoning.tokens"),
    margin: optNumber(row.margin, "meta.reasoning.margin"),
    limited: optString(row.limited, "meta.reasoning.limited"),
    forced: row.forced == null ? null : reqBoolean(row.forced, "meta.reasoning.forced"),
  };
}

function parseMeta(value: unknown): Meta {
  const meta = record(value, "meta");
  return {
    model: optString(meta.model, "meta.model"),
    latency_ms: optNumber(meta.latency_ms, "meta.latency_ms"),
    question_count: optNumber(meta.question_count, "meta.question_count"),
    compute_mode: optString(meta.compute_mode, "meta.compute_mode"),
    usage: meta.usage == null ? null : parseUsage(meta.usage, "meta.usage"),
    reasoning: meta.reasoning == null ? null : parseReasoning(meta.reasoning),
    escalated: optBoolean(meta.escalated, "meta.escalated"),
  };
}

function parseGroundingMeta(value: unknown): GroundingMeta {
  const row = record(value, "grounding_meta");
  const queries =
    row.queries == null
      ? []
      : list(row.queries, "grounding_meta.queries").map((query, index) =>
          reqString(query, `grounding_meta.queries[${index}]`),
        );
  const sources =
    row.sources == null
      ? []
      : list(row.sources, "grounding_meta.sources").map((source, index) => {
          const item = record(source, `grounding_meta.sources[${index}]`);
          return {
            url: optString(item.url, `grounding_meta.sources[${index}].url`),
            title: optString(item.title, `grounding_meta.sources[${index}].title`),
            snippet: optString(item.snippet, `grounding_meta.sources[${index}].snippet`),
          };
        });
  return {
    triggered: reqBoolean(row.triggered, "grounding_meta.triggered"),
    trigger_reason: optString(row.trigger_reason, "grounding_meta.trigger_reason"),
    queries,
    sources,
    added_context_tokens: optNumber(row.added_context_tokens, "grounding_meta.added_context_tokens"),
    search_ms: optNumber(row.search_ms, "grounding_meta.search_ms"),
  };
}

function parseBatchMeta(value: unknown): BatchMeta {
  const meta = record(value, "meta");
  return {
    model: optString(meta.model, "meta.model"),
    request_count: reqNumber(meta.request_count, "meta.request_count"),
    question_count: reqNumber(meta.question_count, "meta.question_count"),
    latency_ms: optNumber(meta.latency_ms, "meta.latency_ms"),
    usage: meta.usage == null ? null : parseUsage(meta.usage, "meta.usage"),
  };
}

function numberMap(rows: unknown, path: string, keyName: "option" | "id" | "level"): Map<string | number, number> {
  const map = new Map<string | number, number>();
  for (const [index, row] of list(rows, path).entries()) {
    const item = record(row, `${path}[${index}]`);
    const key =
      keyName === "level"
        ? reqNumber(item.level, `${path}[${index}].level`)
        : reqString(item[keyName], `${path}[${index}].${keyName}`);
    invariant(keyName !== "level" || Number.isInteger(key), `${path}[${index}].level must be an integer`, "protocol");
    invariant(!map.has(key), `${path}[${index}].${keyName} is duplicated`, "protocol");
    map.set(key, reqProbability(item.probability, `${path}[${index}].probability`));
  }
  return map;
}

function parseYesNo(question: YesNoQuestion, result: Record<string, unknown>, meta: Meta, grounding: GroundingMeta | null) {
  const answer = result.answer;
  invariant(answer === "yes" || answer === "no" || answer === null, 'result.answer must be "yes", "no", or null', "protocol");
  return {
    id: question.id,
    kind: "yesno" as const,
    result: { answer, probability: reqProbability(result.probability, "result.probability") },
    meta,
    grounding_meta: grounding,
  };
}

function parseChoice(question: ChoiceQuestion, result: Record<string, unknown>, meta: Meta, grounding: GroundingMeta | null) {
  const names = question.options.map((option) => option.option);
  const chosen = result.chosen;
  invariant(chosen === null || typeof chosen === "string", "result.chosen must be a string or null", "protocol");
  invariant(typeof chosen !== "string" || names.includes(chosen), `result.chosen ${chosen} is not an option`, "protocol");
  const probabilities = numberMap(result.probabilities, "result.probabilities", "option");
  invariant(probabilities.size === names.length, "result.probabilities must list every option once", "protocol");
  const rows = names.map((option) => {
    const probability = probabilities.get(option);
    invariant(probability !== undefined, `result.probabilities is missing ${option}`, "protocol");
    return { option, probability };
  });
  if (chosen === null) {
    invariant(result.probability === null, "result.probability must be null when chosen is null", "protocol");
    return {
      id: question.id,
      kind: "choice" as const,
      result: { chosen: null, probability: null, probabilities: rows },
      meta,
      grounding_meta: grounding,
    };
  }
  return {
    id: question.id,
    kind: "choice" as const,
    result: {
      chosen,
      probability: reqProbability(result.probability, "result.probability"),
      probabilities: rows,
    },
    meta,
    grounding_meta: grounding,
  };
}

function parseScale(question: ScaleQuestion, result: Record<string, unknown>, meta: Meta, grounding: GroundingMeta | null) {
  const levels = question.levels.map((level) => level.level);
  const probabilities = numberMap(result.probabilities, "result.probabilities", "level");
  invariant(probabilities.size === levels.length, "result.probabilities must list every level once", "protocol");
  const rows = levels.map((level) => {
    const probability = probabilities.get(level);
    invariant(probability !== undefined, `result.probabilities is missing level ${level}`, "protocol");
    return { level, probability };
  });
  return {
    id: question.id,
    kind: "scale" as const,
    result: {
      expectation: reqNumber(result.expectation, "result.expectation"),
      confidence: reqProbability(result.confidence, "result.confidence"),
      probabilities: rows,
    },
    meta,
    grounding_meta: grounding,
  };
}

function parseSort(
  question: SortQuestion,
  content: Content,
  result: Record<string, unknown>,
  meta: Meta,
  grounding: GroundingMeta | null,
) {
  invariant(isList(content), "sort response requires list content", "protocol");
  const expected = new Map<string, number>();
  for (const item of content.value) expected.set(item.id, (expected.get(item.id) ?? 0) + 1);
  const sorted = list(result.sorted, "result.sorted").map((id, index) => reqString(id, `result.sorted[${index}]`));
  invariant(sorted.length === content.value.length, "result.sorted must list each item once", "protocol");
  for (const id of sorted) {
    const left = expected.get(id);
    invariant(left !== undefined && left !== 0, `result.sorted has unexpected id ${id}`, "protocol");
    expected.set(id, left - 1);
  }
  return {
    id: question.id,
    kind: "sort" as const,
    result: { sorted, confidence: optProbability(result.confidence, "result.confidence") },
    meta,
    grounding_meta: grounding,
  };
}

function parseTags(
  question: TagsQuestion,
  content: Content,
  result: Record<string, unknown>,
  meta: Meta,
  grounding: GroundingMeta | null,
) {
  const ids = question.tags.map((tag) => tag.id);
  const rows = list(result.tags, "result.tags");
  const byId = new Map<string, { probability: number; applies: boolean | null }>();
  for (const [index, row] of rows.entries()) {
    const item = record(row, `result.tags[${index}]`);
    const id = reqString(item.id, `result.tags[${index}].id`);
    const applies = item.applies;
    invariant(
      applies === true || applies === false || applies === null,
      `result.tags[${index}].applies must be true, false, or null`,
      "protocol",
    );
    invariant(!(isImage(content) && applies === null), `result.tags[${index}].applies is null on an image`, "protocol");
    invariant(!byId.has(id), `result.tags[${index}].id is duplicated`, "protocol");
    byId.set(id, { probability: reqProbability(item.probability, `result.tags[${index}].probability`), applies });
  }
  invariant(byId.size === ids.length, "result.tags must list every tag once", "protocol");
  const tags = ids.map((id) => {
    const entry = byId.get(id);
    invariant(entry !== undefined, `result.tags is missing ${id}`, "protocol");
    return { id, probability: entry.probability, applies: entry.applies };
  });
  return {
    id: question.id,
    kind: "tags" as const,
    result: { tags },
    meta,
    grounding_meta: grounding,
  };
}

function parseWide(question: Question, content: Content, raw: unknown) {
  const body = record(raw, "response");
  const kind = reqString(body.kind, "kind");
  invariant(kind === question.kind, `kind ${kind} does not match ${question.kind}`, "protocol");
  const id = reqString(body.id, "id");
  invariant(id === question.id, `id ${id} does not match ${question.id}`, "protocol");
  const result = record(body.result, "result");
  const meta = parseMeta(body.meta);
  const grounding = body.grounding_meta == null ? null : parseGroundingMeta(body.grounding_meta);
  switch (question.kind) {
    case "yesno":
      return parseYesNo(question, result, meta, grounding);
    case "choice":
      return parseChoice(question, result, meta, grounding);
    case "scale":
      return parseScale(question, result, meta, grounding);
    case "sort":
      return parseSort(question, content, result, meta, grounding);
    case "tags":
      return parseTags(question, content, result, meta, grounding);
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

export function parseDecide<const Q extends Question, const C extends ContentFor<Q>>(
  request: DecideBody<Q, C>,
  raw: unknown,
): DecisionOf<Q, C> {
  const question: Question = request.question;
  const content: Content = request.content;
  // Checker cannot reduce DecisionOf<Q, C>. Kind, id, and membership were checked against this request.
  return parseWide(question, content, raw) as DecisionOf<Q, C>;
}

export function parseBatch<const Groups extends readonly BatchGroup[]>(
  request: BatchBody<Groups>,
  raw: unknown,
): BatchOf<Groups> {
  const body = record(raw, "response");
  const results = list(body.results, "results");
  invariant(results.length === request.requests.length, "results must match requests", "protocol");
  const parsed = request.requests.map((group, groupIndex) => {
    const row = record(at(results, groupIndex, `results[${groupIndex}]`), `results[${groupIndex}]`);
    const answers = list(row.answers, `results[${groupIndex}].answers`);
    invariant(answers.length === group.questions.length, `results[${groupIndex}].answers must match questions`, "protocol");
    return {
      answers: group.questions.map((question, questionIndex) => {
        const path = `results[${groupIndex}].answers[${questionIndex}]`;
        const answer = record(at(answers, questionIndex, path), path);
        if (answer.ok === true) {
          invariant(answer.error == null, `${path}.error must be null when ok is true`, "protocol");
          return {
            ok: true as const,
            result: parseWide(question, group.content, answer.result),
            error: null,
          };
        }
        invariant(answer.ok === false, `${path}.ok must be a boolean`, "protocol");
        invariant(answer.result == null, `${path}.result must be null when ok is false`, "protocol");
        return { ok: false as const, result: null, error: reqString(answer.error, `${path}.error`) };
      }),
    };
  });
  // Same hole as parseDecide: the tuple of kinds is the request, not the JSON.
  return { results: parsed, meta: parseBatchMeta(body.meta) } as BatchOf<Groups>;
}

export function parseEstimate(raw: unknown): Estimate {
  const body = record(raw, "response");
  const usage = record(body.usage, "usage");
  return {
    usage: {
      min_input_tokens: reqNumber(usage.min_input_tokens, "usage.min_input_tokens"),
      max_input_tokens: reqNumber(usage.max_input_tokens, "usage.max_input_tokens"),
      exact: reqBoolean(usage.exact, "usage.exact"),
      min_output_tokens: optNumber(usage.min_output_tokens, "usage.min_output_tokens"),
      max_output_tokens: optNumber(usage.max_output_tokens, "usage.max_output_tokens"),
      sequences: optNumber(usage.sequences, "usage.sequences"),
      basis: optString(usage.basis, "usage.basis"),
    },
  };
}

// Canonical hash: UTF-16 code units, object keys sorted, array order kept, undefined dropped.
// Same request bytes hash the same on every engine. Do not NFC-normalize.
function mix(hash: number, text: string): number {
  let next = hash >>> 0;
  for (let index = 0; index < text.length; index++) {
    next ^= text.charCodeAt(index);
    next = Math.imul(next, 16777619);
  }
  return next >>> 0;
}

function hashValue(hash: number, value: unknown): number {
  if (value === undefined) return mix(hash, "u");
  if (value === null) return mix(hash, "z");
  switch (typeof value) {
    case "string":
      return mix(mix(hash, `s${value.length}:`), value);
    case "boolean":
      return mix(hash, value ? "b1" : "b0");
    case "number": {
      invariant(Number.isFinite(value), "numbers must be finite");
      return mix(mix(hash, "n"), Object.is(value, -0) ? "-0" : String(value));
    }
    case "object": {
      if (Array.isArray(value)) {
        let next = mix(hash, `a${value.length}:`);
        for (const item of value) next = hashValue(next, item);
        return next;
      }
      invariant(isRecord(value), "unsupported value in request");
      const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort();
      let next = mix(hash, `o${keys.length}:`);
      for (const key of keys) {
        next = mix(mix(next, `k${key.length}:`), key);
        next = hashValue(next, value[key]);
      }
      return next;
    }
    default:
      throw new SageError("invalid", null, "unsupported value in request");
  }
}

function unit(seed: number, salt: number): number {
  let next = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return (next >>> 0) % 10000;
}

function unsure(seed: number): boolean {
  return unit(seed, 1) % 5 === 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function pointAt(points: readonly number[], index: number): number {
  const point = points[index];
  invariant(point !== undefined, "probability index");
  return point;
}

function splitPoints(seed: number, count: number, winner: number | null): number[] {
  if (winner === null) {
    const left = unit(seed, 4) % count;
    const other = unit(seed, 5) % count;
    const right = other === left ? (left + 1) % count : other;
    const top = 4000 + (unit(seed, 6) % 800);
    if (count === 2) {
      return Array.from({ length: count }, (_, index) => (index === left ? top : 10000 - top));
    }
    const rest = count - 2;
    const each = Math.floor((10000 - top * 2) / rest);
    let leftover = 10000 - top * 2 - each * rest;
    return Array.from({ length: count }, (_, index) => {
      if (index === left || index === right) return top;
      const extra = leftover > 0 ? 1 : 0;
      leftover -= extra;
      return each + extra;
    });
  }
  const win = 5500 + (unit(seed, 7) % 4000);
  const each = Math.floor((10000 - win) / (count - 1));
  let leftover = 10000 - win - each * (count - 1);
  return Array.from({ length: count }, (_, index) => {
    if (index === winner) return win;
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    return each + extra;
  });
}

function xorshift(value: number): number {
  let next = value >>> 0;
  if (next === 0) next = 0x6d2b79f5;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function permute(ids: readonly string[], seed: number): string[] {
  const order = ids.slice();
  let state = seed || 1;
  for (let index = order.length - 1; index > 0; index--) {
    state = xorshift(state);
    const swap = state % (index + 1);
    const here = order[index];
    const there = order[swap];
    invariant(here !== undefined && there !== undefined, "sort permutation");
    order[index] = there;
    order[swap] = here;
  }
  return order;
}

function stubMeta(
  seed: number,
  reasoning: ReasoningMode | undefined,
  latency: LatencyMode | undefined,
  kind: Question["kind"],
  image: boolean,
): Meta {
  const mode = reasoning ?? "off";
  const ran = mode === "on" || (mode === "auto" && unsure(seed));
  const tokens = ran ? unit(seed, 8) % 400 : null;
  const billed = 10 + (seed % 200);
  return {
    model: "levanto-sage-stub",
    latency_ms: 0,
    question_count: null,
    compute_mode: kind === "choice" && latency === "quality" ? "fanout_candidates" : "fanout",
    usage: {
      billed_input_tokens: billed,
      rendered_tokens: null,
      image_count: image ? 1 : 0,
      image_tokens: image ? 80 + (seed % 40) : 0,
      input_tokens: billed,
      output_tokens: tokens ?? 1,
    },
    reasoning: {
      fired: ran,
      ran,
      finished: ran ? true : null,
      tokens,
      margin: null,
      limited: null,
      forced: null,
    },
    escalated: null,
  };
}

function stubGrounding(seed: number, grounding: Grounding | null | undefined): GroundingMeta | null {
  if (grounding == null || grounding.trigger === "never") return null;
  const trigger = grounding.trigger ?? "low_confidence";
  const triggered = trigger === "always" || unsure(seed);
  if (!triggered) {
    return {
      triggered: false,
      trigger_reason: "confidence_above_floor",
      queries: [],
      sources: [],
      added_context_tokens: null,
      search_ms: null,
    };
  }
  const id = seed.toString(16).padStart(8, "0");
  return {
    triggered: true,
    trigger_reason: trigger === "always" ? "always" : "low_confidence",
    queries: [`stub ${id}`],
    sources: [{ url: `https://stub.invalid/${id}`, title: "stub", snippet: "stable nonsense" }],
    added_context_tokens: 12,
    search_ms: seed % 200,
  };
}

function wireResult(question: Question, content: Content, seed: number): unknown {
  switch (question.kind) {
    case "yesno": {
      if (unsure(seed)) {
        return { answer: null, probability: round4(0.4 + (unit(seed, 2) % 2001) / 10000) };
      }
      const yes = unit(seed, 3) % 2 === 0;
      const span = (unit(seed, 4) % 4501) / 10000;
      return { answer: yes ? "yes" : "no", probability: round4(yes ? 0.55 + span : span) };
    }
    case "choice": {
      const count = question.options.length;
      const winner = unsure(seed) ? null : unit(seed, 2) % count;
      const points = splitPoints(seed, count, winner);
      const chosen = winner === null ? null : at(question.options, winner, "options").option;
      return {
        chosen,
        probability: winner === null ? null : pointAt(points, winner) / 10000,
        probabilities: question.options.map((option, index) => ({
          option: option.option,
          probability: pointAt(points, index) / 10000,
        })),
      };
    }
    case "scale": {
      const count = question.levels.length;
      const index = unit(seed, 2) % count;
      const points = splitPoints(seed, count, unsure(seed) ? null : index);
      const confidence = unsure(seed)
        ? round4(0.2 + (unit(seed, 4) % 3000) / 10000)
        : round4(0.6 + (unit(seed, 4) % 3900) / 10000);
      return {
        expectation: round4(question.levels.reduce(
          (sum, row, rowIndex) => sum + row.level * (pointAt(points, rowIndex) / 10000),
          0,
        )),
        confidence,
        probabilities: question.levels.map((row, rowIndex) => ({
          level: row.level,
          probability: pointAt(points, rowIndex) / 10000,
        })),
      };
    }
    case "sort": {
      invariant(isList(content), 'sort requires content.kind "list"');
      return {
        sorted: permute(
          content.value.map((item) => item.id),
          seed,
        ),
        confidence: unsure(seed) ? null : round4(0.5 + (unit(seed, 4) % 5000) / 10000),
      };
    }
    case "tags":
      return {
        tags: question.tags.map((tag, index) => {
          const bucket = unit(seed, 20 + index) % 5;
          const applies =
            bucket === 0 ? (isImage(content) ? unit(seed, 60 + index) % 2 === 0 : null) : bucket % 2 === 0 ? false : true;
          const roll = unit(seed, 40 + index);
          const probability =
            applies === true
              ? round4(0.7 + (roll % 3000) / 10000)
              : applies === false
                ? round4((roll % 2500) / 10000)
                : round4(0.45 + (roll % 1000) / 10000);
          return { id: tag.id, probability, applies };
        }),
      };
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

type SeededDecide = {
  content: Content;
  question: Question;
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
  grounding?: Grounding | null;
};

function optionalString(value: string | null | undefined): { value: string } | undefined {
  return typeof value === "string" ? { value } : undefined;
}

function projectQuestion(question: Question): unknown {
  switch (question.kind) {
    case "yesno":
    case "sort":
      return { id: question.id, instructions: question.instructions, kind: question.kind };
    case "choice":
      return {
        id: question.id,
        instructions: question.instructions,
        kind: question.kind,
        options: question.options.map((option) => {
          const description = optionalString(option.description);
          return description === undefined ? { option: option.option } : { description: description.value, option: option.option };
        }),
      };
    case "scale":
      return {
        id: question.id,
        instructions: question.instructions,
        kind: question.kind,
        levels: question.levels.map((level) => {
          const description = optionalString(level.description);
          return description === undefined ? { level: level.level } : { description: description.value, level: level.level };
        }),
      };
    case "tags": {
      const instructions = optionalString(question.instructions);
      return {
        id: question.id,
        kind: question.kind,
        ...(instructions === undefined ? {} : { instructions: instructions.value }),
        tags: question.tags.map((tag) => {
          const name = optionalString(tag.name);
          return name === undefined ? { id: tag.id } : { id: tag.id, name: name.value };
        }),
      };
    }
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

function projectContent(content: Content): unknown {
  if (typeof content === "string") return content;
  if (content.kind === "text") return { kind: "text", value: content.value };
  if (content.kind === "image") {
    const text = optionalString(content.text);
    return text === undefined ? { kind: "image", media: content.media } : { kind: "image", media: content.media, text: text.value };
  }
  return {
    kind: "list",
    value: content.value.map((item) => ({
      content: typeof item.content === "string" ? item.content : projectContent(item.content),
      id: item.id,
    })),
  };
}

function projectGrounding(grounding: Grounding | null | undefined): Grounding | null {
  if (grounding == null) return null;
  const projected: Grounding = {};
  if (grounding.trigger !== undefined) projected.trigger = grounding.trigger;
  if (grounding.confidence_floor !== undefined) projected.confidence_floor = grounding.confidence_floor;
  if (grounding.max_results !== undefined) projected.max_results = grounding.max_results;
  if (grounding.max_context_tokens !== undefined) projected.max_context_tokens = grounding.max_context_tokens;
  if (grounding.return_sources !== undefined) projected.return_sources = grounding.return_sources;
  return projected.trigger === undefined &&
    projected.confidence_floor === undefined &&
    projected.max_results === undefined &&
    projected.max_context_tokens === undefined &&
    projected.return_sources === undefined
    ? null
    : projected;
}

function decideSeed(request: SeededDecide): number {
  return hashValue(FNV_OFFSET, {
    content: projectContent(request.content),
    grounding: projectGrounding(request.grounding),
    question: projectQuestion(request.question),
    ...(request.latency_mode === undefined ? {} : { latency_mode: request.latency_mode }),
    ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
  });
}

function wireDecide(request: SeededDecide): unknown {
  const seed = decideSeed(request);
  return {
    id: request.question.id,
    kind: request.question.kind,
    result: wireResult(request.question, request.content, seed),
    meta: stubMeta(seed, request.reasoning, request.latency_mode, request.question.kind, isImage(request.content)),
    grounding_meta: stubGrounding(seed, request.grounding),
  };
}

function wireBatch(request: {
  requests: readonly { content: Content; questions: readonly BatchQuestion[] }[];
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
}): unknown {
  let questionCount = 0;
  let imageCount = 0;
  let billed = 0;
  const results = request.requests.map((group, groupIndex) => {
    if (isImage(group.content)) imageCount += 1;
    return {
      answers: group.questions.map((question, questionIndex) => {
        questionCount += 1;
        const grounding = question.kind === "sort" ? null : projectGrounding(question.grounding);
        const seed = hashValue(FNV_OFFSET, {
          content: projectContent(group.content),
          gi: groupIndex,
          qi: questionIndex,
          question: projectQuestion(question),
          ...(grounding === null ? {} : { grounding }),
          ...(request.latency_mode === undefined ? {} : { latency_mode: request.latency_mode }),
          ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
        });
        billed += 10 + (seed % 200);
        return {
          ok: true,
          error: null,
          result: {
            id: question.id,
            kind: question.kind,
            result: wireResult(question, group.content, seed),
            meta: stubMeta(seed, request.reasoning, request.latency_mode, question.kind, isImage(group.content)),
            grounding_meta: stubGrounding(seed, grounding),
          },
        };
      }),
    };
  });
  return {
    results,
    meta: {
      model: "levanto-sage-stub",
      request_count: request.requests.length,
      question_count: questionCount,
      latency_ms: 0,
      usage: {
        billed_input_tokens: billed,
        rendered_tokens: null,
        image_count: imageCount,
        image_tokens: imageCount * 80,
        input_tokens: billed,
        output_tokens: questionCount,
      },
    },
  };
}

export function stubDecide<const Q extends Question, const C extends ContentFor<Q>>(
  request: DecideBody<Q, C>,
): DecisionOf<Q, C> {
  const question: Question = request.question;
  const content: Content = request.content;
  return parseDecide(request, wireDecide({ ...request, question, content }));
}

export function stubBatch<const Groups extends readonly BatchGroup[]>(
  request: BatchBody<Groups>,
): BatchOf<Groups> {
  return parseBatch(request, wireBatch(request));
}

export function indexTags<const Tags extends readonly { readonly id: string }[]>(tags: Tags): TagRecord<Tags> {
  const indexed: Record<string, Tags[number]> = Object.fromEntries(tags.map((tag) => [tag.id, tag]));
  // fromEntries widens keys to string. Membership was copied off this array.
  return indexed as TagRecord<Tags>;
}

export function stubEstimate(body: EstimateBody): Estimate {
  const seed =
    "requests" in body
      ? hashValue(FNV_OFFSET, {
          requests: body.requests.map((group, groupIndex) => ({
            content: projectContent(group.content),
            gi: groupIndex,
            questions: group.questions.map((question, questionIndex) => ({
              qi: questionIndex,
              question: projectQuestion(question),
              ...(question.kind === "sort" || question.grounding == null
                ? {}
                : { grounding: projectGrounding(question.grounding) }),
            })),
          })),
          ...(body.latency_mode === undefined ? {} : { latency_mode: body.latency_mode }),
          ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
        })
      : decideSeed(body);
  const mayGrow = (body.reasoning ?? "off") !== "off";
  const base = 8 + (seed % 80);
  return parseEstimate({
    usage: {
      min_input_tokens: base,
      max_input_tokens: mayGrow ? base + 40 : base,
      exact: !mayGrow,
      min_output_tokens: 1,
      max_output_tokens: mayGrow ? 400 : 1,
      sequences: null,
      basis: "stub",
    },
  });
}
