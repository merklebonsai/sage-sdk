/**
 * One document, one decision.
 *
 * `SageSDK` holds one client. `sage(context)` and `sageAnswer(context)` bind a document to it.
 * `Sage` returns `{ value, confidence }` plus the distribution and call meta.
 * `SageAnswer` returns `value` only. Both call `SageApi.decide`.
 * Question ids are fixed per method and are not part of the reading.
 *
 * YES/NO. `confidence` is how sure `value` is: P(yes) on yes, the complement on no,
 * and null when `value` is null. `probability` remains P(yes).
 *
 * SCALE. `value` is the expectation in level units. It is always a number.
 * `confidence` is always a number; a weak score is low, not null.
 * Gauge is that scale over an inclusive integer range. `rangeStep` defaults to 1,
 * or to -1 when the range decreases. `rangeEnd` must fall on a step. Levels are 2..26.
 *
 * SORT. The items are the content. The document on the instance is not sent.
 * An element with a string `id` and a `content` field is one list item.
 * Anything else is a map of id → content, flattened in enumeration order.
 * A map cannot hold two items named `id` and `content`; use list items for those ids.
 *
 * RECORDS. Keys come out in ordinary property order: integer-like keys first,
 * ascending, then the rest in insertion order. Arrays keep the order written.
 *
 * TAGS. `value` is whether each tag applies (`null` means unsure). On an image it is
 * boolean. `confidence` is that tag's probability.
 */

import { SageApi } from "./client.ts";
import { invariant } from "./invariant.ts";
import type {
  AppliesOf,
  CallOptions,
  ChoiceOption,
  ChoiceProbabilities,
  Content,
  ContentFor,
  DecideBody,
  DecisionOf,
  Grounding,
  GroundingMeta,
  ImageContent,
  LatencyMode,
  ListItem,
  Meta,
  Question,
  ReasoningMode,
  SageOptions,
  ScaleLevel,
  ScaleProbabilities,
  TagSpec,
} from "./types.ts";

export type AskOptions<C = Content> = CallOptions & {
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
} & (C extends ImageContent ? { grounding?: null } : { grounding?: Grounding | null });

export type SortAskOptions = CallOptions & {
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
};

export type YesNoReading = {
  /** P(yes). Set even when `value` is null. */
  probability: number;
  meta: Meta;
  grounding_meta: GroundingMeta | null;
} & ({ value: "yes" | "no"; confidence: number } | { value: null; confidence: null });

export type ChoiceReading<Name extends string, Probabilities> = {
  probabilities: Probabilities;
  meta: Meta;
  grounding_meta: GroundingMeta | null;
} & ({ value: Name; confidence: number } | { value: null; confidence: null });

export type ScaleReading<
  Levels extends readonly { readonly level: number }[] = readonly { readonly level: number }[],
> = {
  value: number;
  confidence: number;
  probabilities: ScaleProbabilities<Levels>;
  meta: Meta;
  grounding_meta: GroundingMeta | null;
};

export type GaugeReading = {
  value: number;
  confidence: number;
  probabilities: readonly { readonly level: number; readonly probability: number }[];
  meta: Meta;
  grounding_meta: GroundingMeta | null;
};

export type SortReading<Items extends readonly unknown[]> = {
  value: { readonly [I in keyof Items]: Items[number] };
  confidence: number | null;
  meta: Meta;
  grounding_meta: GroundingMeta | null;
};

type IsListItem<T> = string extends keyof T
  ? false
  : [T] extends [{ id: string; content: string | { kind: "text"; value: string } }]
    ? true
    : false;

export type SortRecordReading<Groups extends readonly Record<string, string>[]> = {
  value: readonly { id: GroupIds<Groups>; content: string }[];
  confidence: number | null;
  meta: Meta;
  grounding_meta: GroundingMeta | null;
};

type RecordKeys<T> = T extends unknown ? `${Extract<keyof T, string | number>}` : never;

type GroupIds<Groups extends readonly Record<string, string>[]> = Groups[number] extends infer Item
  ? Item extends Record<string, string>
    ? RecordKeys<Item>
    : never
  : never;

export type SortResult<Items> = [Items] extends [readonly (infer Item)[]]
  ? IsListItem<Item> extends true
    ? SortReading<Items>
    : SortRecordReading<Items extends readonly Record<string, string>[] ? Items : never>
  : never;

export type TagVerdict<Names extends string, Applies extends boolean | null = boolean | null> = {
  [Name in Names]: Applies;
};

export type TagReading<Names extends string, Applies extends boolean | null = boolean | null> = {
  value: TagVerdict<Names, Applies>;
  confidence: { [Name in Names]: number };
  meta: Meta;
  grounding_meta: GroundingMeta | null;
};

type ChoiceInput = readonly { option: string; description?: string | null }[] | Record<string, string>;
type TagInput = readonly { tag: string; description?: string | null }[] | Record<string, string>;
type SortInput = readonly ListItem[] | readonly Record<string, string>[];

export type ChoiceNames<Options> = [Options] extends [readonly (infer Item)[]]
  ? Item extends { option: infer Name extends string }
    ? Name
    : never
  : RecordKeys<Options>;

export type ChoiceProbs<Options> = [Options] extends [readonly { option: string }[]]
  ? ChoiceProbabilities<Options>
  : readonly { option: RecordKeys<Options>; probability: number }[];

export type TagNames<Tags> = [Tags] extends [readonly (infer Item)[]]
  ? Item extends { tag: infer Name extends string }
    ? Name
    : never
  : RecordKeys<Tags>;

// Same bounds as scale levels in assertQuestion.
const GAUGE_MIN = 2;
const GAUGE_MAX = 26;

type Call = {
  signal?: AbortSignal;
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
  grounding?: Grounding | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientOf(options?: SageOptions | SageApi): SageApi {
  return options instanceof SageApi ? options : new SageApi(options);
}

function signalOf(call: Call | undefined): CallOptions | undefined {
  return call?.signal === undefined ? undefined : { signal: call.signal };
}

async function ask<Q extends Question, C extends ContentFor<Q>>(
  api: SageApi,
  content: C,
  question: Q,
  call: Call | undefined,
): Promise<DecisionOf<Q, C>> {
  // GroundingField is conditional on Q and C. The spread is that field; assertDecide checks it again.
  return api.decide(
    {
      content,
      question,
      ...(call?.reasoning === undefined ? {} : { reasoning: call.reasoning }),
      ...(call?.latency_mode === undefined ? {} : { latency_mode: call.latency_mode }),
      ...(call?.grounding === undefined ? {} : { grounding: call.grounding }),
    } as DecideBody<Q, C>,
    signalOf(call),
  );
}

function complement(probability: number): number {
  // 1 - p is not the decimal complement (1 - 0.91).
  return Math.round((1 - probability) * 1e12) / 1e12;
}

function yesNoReading(decision: {
  result: { answer: "yes" | "no" | null; probability: number };
  meta: Meta;
  grounding_meta: GroundingMeta | null;
}): YesNoReading {
  const { answer, probability } = decision.result;
  const rest = { probability, meta: decision.meta, grounding_meta: decision.grounding_meta };
  if (answer === null) return { ...rest, value: null, confidence: null };
  return { ...rest, value: answer, confidence: answer === "yes" ? probability : complement(probability) };
}

function choiceOptions(options: ChoiceInput): ChoiceOption[] {
  if (Array.isArray(options)) {
    return options.map((option) =>
      option.description == null ? { option: option.option } : { option: option.option, description: option.description },
    );
  }
  invariant(isRecord(options), "choose options must be an array or an object");
  return Object.entries(options).map(([option, description]) => {
    invariant(option !== "", "choose option must not be empty");
    invariant(typeof description === "string", `choose description for ${option} must be a string`);
    return { option, description };
  });
}

function choiceReading(decision: {
  result: {
    chosen: string | null;
    probability: number | null;
    probabilities: readonly { option: string; probability: number }[];
  };
  meta: Meta;
  grounding_meta: GroundingMeta | null;
}): ChoiceReading<string, readonly { option: string; probability: number }[]> {
  const { chosen, probability, probabilities } = decision.result;
  const rest = {
    probabilities: probabilities.map((row) => ({ option: row.option, probability: row.probability })),
    meta: decision.meta,
    grounding_meta: decision.grounding_meta,
  };
  if (chosen === null || probability === null) return { ...rest, value: null, confidence: null };
  return { ...rest, value: chosen, confidence: probability };
}

function scaleReading(decision: {
  result: {
    expectation: number;
    confidence: number;
    probabilities: readonly { level: number; probability: number }[];
  };
  meta: Meta;
  grounding_meta: GroundingMeta | null;
}): GaugeReading {
  return {
    value: decision.result.expectation,
    confidence: decision.result.confidence,
    probabilities: decision.result.probabilities.map((row) => ({ level: row.level, probability: row.probability })),
    meta: decision.meta,
    grounding_meta: decision.grounding_meta,
  };
}

function gaugeLevels(start: number, end: number, step: number | undefined): ScaleLevel[] {
  invariant(Number.isInteger(start), "rangeStart must be an integer");
  invariant(Number.isInteger(end), "rangeEnd must be an integer");
  const resolved = step ?? (start <= end ? 1 : -1);
  invariant(Number.isInteger(resolved) && resolved !== 0, "rangeStep must be a non-zero integer");
  invariant(start !== end, "range must cover at least two levels");
  invariant((end - start) * resolved > 0, "rangeStep must move from rangeStart toward rangeEnd");
  const count = (end - start) / resolved + 1;
  invariant(Number.isInteger(count), "rangeEnd must fall on a step");
  invariant(count >= GAUGE_MIN && count <= GAUGE_MAX, `gauge must produce ${GAUGE_MIN}..${GAUGE_MAX} levels`);
  return Array.from({ length: count }, (_, index) => ({ level: start + index * resolved }));
}

function gaugeCall(
  rangeStep: number | AskOptions<Content> | undefined,
  call: AskOptions<Content> | undefined,
): { step: number | undefined; call: AskOptions<Content> | undefined } {
  if (typeof rangeStep === "number") return { step: rangeStep, call };
  return { step: undefined, call: rangeStep ?? call };
}

function isListItem(value: unknown): value is ListItem {
  if (!isRecord(value) || typeof value.id !== "string" || !("content" in value)) return false;
  const content: unknown = value.content;
  if (typeof content === "string") return true;
  return isRecord(content) && content.kind === "text" && typeof content.value === "string";
}

function rankItems(items: SortInput): ListItem[] {
  invariant(Array.isArray(items), "sort items must be an array");
  const listed = items.filter(isListItem);
  if (listed.length === items.length) return listed;
  invariant(listed.length === 0, "sort items must be { id, content } objects or id → content maps, not a mix");
  const flat: ListItem[] = [];
  for (const group of items) {
    invariant(isRecord(group), "sort items must be objects");
    for (const [id, content] of Object.entries(group)) {
      invariant(id !== "", "sort id must not be empty");
      invariant(typeof content === "string", `sort content for ${id} must be a string`);
      flat.push({ id, content });
    }
  }
  return flat;
}

function reorder<T extends { id: string }>(items: readonly T[], sorted: readonly string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return sorted.map((id) => {
    const item = byId.get(id);
    invariant(item !== undefined, `sorted id ${id} is not an item`);
    return item;
  });
}

function tagSpecs(tags: TagInput): TagSpec[] {
  if (Array.isArray(tags)) {
    return tags.map((tag) => (tag.description == null ? { id: tag.tag } : { id: tag.tag, name: tag.description }));
  }
  invariant(isRecord(tags), "tags must be an array or an object");
  return Object.entries(tags).map(([id, name]) => {
    invariant(id !== "", "tag must not be empty");
    invariant(typeof name === "string", `tag description for ${id} must be a string`);
    return { id, name };
  });
}

function pair<Key extends string, Value>(key: Key, value: Value): readonly [Key, Value] {
  return [key, value];
}

function keyed<Key extends string, Value>(entries: readonly (readonly [Key, Value])[]): { [K in Key]: Value } {
  const record: Record<string, Value> = Object.fromEntries(entries);
  // fromEntries widens keys to string. Membership was copied off these entries.
  return record as { [K in Key]: Value };
}

function tagReading(decision: {
  result: { tags: readonly { id: string; probability: number; applies: boolean | null }[] };
  meta: Meta;
  grounding_meta: GroundingMeta | null;
}): TagReading<string, boolean | null> {
  return {
    value: keyed(decision.result.tags.map((tag) => pair(tag.id, tag.applies))),
    confidence: keyed(decision.result.tags.map((tag) => pair(tag.id, tag.probability))),
    meta: decision.meta,
    grounding_meta: decision.grounding_meta,
  };
}

/** One client. `sage` and `sageAnswer` each bind a document. */
export class SageSDK {
  readonly #api: SageApi;

  constructor(options?: SageOptions | SageApi) {
    this.#api = clientOf(options);
  }

  sage<C extends Content>(context: C): Sage<C> {
    return new Sage(context, this.#api);
  }

  sageAnswer<C extends Content>(context: C): SageAnswer<C> {
    return new SageAnswer(context, this.#api);
  }
}

/** Value, confidence, and the rest of one decision. */
export class Sage<C extends Content = Content> {
  readonly #api: SageApi;
  readonly #content: C;

  constructor(content: C, options?: SageOptions | SageApi) {
    this.#content = content;
    this.#api = clientOf(options);
  }

  /** Yes, no, or null. */
  yesOrNo(instructions: string, call?: AskOptions<C>): Promise<YesNoReading> {
    return ask(this.#api, this.#content, { kind: "yesno", id: "yesOrNo", instructions }, call).then(yesNoReading);
  }

  /** One of the options, or null. */
  choose<const Options extends readonly { option: string; description?: string | null }[] | Record<string, string>>(
    instructions: string,
    options: Options,
    call?: AskOptions<C>,
  ): Promise<ChoiceReading<ChoiceNames<Options>, ChoiceProbs<Options>>> {
    return ask(
      this.#api,
      this.#content,
      { kind: "choice", id: "choose", instructions, options: choiceOptions(options) },
      call,
    ).then(
      (decision) =>
        // Option names were checked against this request. The array we sent widened them.
        choiceReading(decision) as ChoiceReading<ChoiceNames<Options>, ChoiceProbs<Options>>,
    );
  }

  /** Expectation on the rubric. */
  scale<const Levels extends readonly { level: number; description?: string | null }[]>(
    instructions: string,
    levels: Levels,
    call?: AskOptions<C>,
  ): Promise<ScaleReading<Levels>> {
    return ask(this.#api, this.#content, { kind: "scale", id: "scale", instructions, levels }, call).then(
      (decision) =>
        // Level literals were checked against this request.
        scaleReading(decision) as ScaleReading<Levels>,
    );
  }

  /** Expectation on the integer range. */
  gauge(instructions: string, rangeStart: number, rangeEnd: number, call?: AskOptions<C>): Promise<GaugeReading>;
  gauge(
    instructions: string,
    rangeStart: number,
    rangeEnd: number,
    rangeStep: number,
    call?: AskOptions<C>,
  ): Promise<GaugeReading>;
  gauge(
    instructions: string,
    rangeStart: number,
    rangeEnd: number,
    rangeStep?: number | AskOptions<C>,
    call?: AskOptions<C>,
  ): Promise<GaugeReading> {
    const resolved = gaugeCall(rangeStep, call);
    return ask(
      this.#api,
      this.#content,
      { kind: "scale", id: "gauge", instructions, levels: gaugeLevels(rangeStart, rangeEnd, resolved.step) },
      resolved.call,
    ).then(scaleReading);
  }

  /** Items in ranked order. */
  sort<const Items extends readonly ListItem[] | readonly Record<string, string>[]>(
    instructions: string,
    items: Items,
    call?: SortAskOptions,
  ): Promise<SortResult<Items>> {
    const ranked = rankItems(items);
    return ask(
      this.#api,
      { kind: "list", value: ranked },
      { kind: "sort", id: "sort", instructions },
      call,
    ).then((decision) => {
      const reading = {
        value: reorder(ranked, decision.result.sorted),
        confidence: decision.result.confidence,
        meta: decision.meta,
        grounding_meta: decision.grounding_meta,
      };
      // SortResult<Items> does not reduce while Items is generic. The value is this permutation.
      return reading as unknown as SortResult<Items>;
    });
  }

  /** Whether each tag applies. */
  tag<const Tags extends readonly { tag: string; description?: string | null }[] | Record<string, string>>(
    instructions: string,
    tags: Tags,
    call?: AskOptions<C>,
  ): Promise<TagReading<TagNames<Tags>, AppliesOf<C>>> {
    return ask(
      this.#api,
      this.#content,
      { kind: "tags", id: "tag", instructions, tags: tagSpecs(tags) },
      call,
    ).then(
      (decision) =>
        // Tag ids were checked against this request. On an image, applies is boolean.
        tagReading(decision) as TagReading<TagNames<Tags>, AppliesOf<C>>,
    );
  }
}

/** `Sage`, returning `value` only. */
export class SageAnswer<C extends Content = Content> {
  readonly #sage: Sage<C>;

  constructor(content: C, options?: SageOptions | SageApi) {
    this.#sage = new Sage(content, options);
  }

  /** Yes, no, or null. */
  yesOrNo(instructions: string, call?: AskOptions<C>): Promise<"yes" | "no" | null> {
    return this.#sage.yesOrNo(instructions, call).then((reading) => reading.value);
  }

  /** One of the options, or null. */
  choose<const Options extends readonly { option: string; description?: string | null }[] | Record<string, string>>(
    instructions: string,
    options: Options,
    call?: AskOptions<C>,
  ): Promise<ChoiceNames<Options> | null> {
    return this.#sage.choose(instructions, options, call).then((reading) => reading.value);
  }

  /** Expectation on the rubric. */
  scale<const Levels extends readonly { level: number; description?: string | null }[]>(
    instructions: string,
    levels: Levels,
    call?: AskOptions<C>,
  ): Promise<number> {
    return this.#sage.scale(instructions, levels, call).then((reading) => reading.value);
  }

  /** Expectation on the integer range. */
  gauge(instructions: string, rangeStart: number, rangeEnd: number, call?: AskOptions<C>): Promise<number>;
  gauge(
    instructions: string,
    rangeStart: number,
    rangeEnd: number,
    rangeStep: number,
    call?: AskOptions<C>,
  ): Promise<number>;
  gauge(
    instructions: string,
    rangeStart: number,
    rangeEnd: number,
    rangeStep?: number | AskOptions<C>,
    call?: AskOptions<C>,
  ): Promise<number> {
    const reading =
      typeof rangeStep === "number"
        ? this.#sage.gauge(instructions, rangeStart, rangeEnd, rangeStep, call)
        : this.#sage.gauge(instructions, rangeStart, rangeEnd, rangeStep ?? call);
    return reading.then((result) => result.value);
  }

  /** Items in ranked order. */
  sort<const Items extends readonly ListItem[] | readonly Record<string, string>[]>(
    instructions: string,
    items: Items,
    call?: SortAskOptions,
  ): Promise<SortResult<Items>["value"]> {
    return this.#sage.sort(instructions, items, call).then((reading) => reading.value);
  }

  /** Whether each tag applies. */
  tag<const Tags extends readonly { tag: string; description?: string | null }[] | Record<string, string>>(
    instructions: string,
    tags: Tags,
    call?: AskOptions<C>,
  ): Promise<TagVerdict<TagNames<Tags>, AppliesOf<C>>> {
    return this.#sage.tag(instructions, tags, call).then((reading) => reading.value);
  }
}
