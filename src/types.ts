export type ReasoningMode = "off" | "auto" | "on";
export type LatencyMode = "quality" | "fast";
export type GroundingTrigger = "always" | "low_confidence" | "never";

export type Grounding = {
  trigger?: GroundingTrigger;
  confidence_floor?: number;
  max_results?: number;
  max_context_tokens?: number;
  return_sources?: boolean;
};

export type TextContent = { kind: "text"; value: string };
export type ImageContent = { kind: "image"; media: string; text?: string | null };
export type ListItem = { id: string; content: string | TextContent };
export type ListContent = { kind: "list"; value: readonly ListItem[] };
export type Content = string | TextContent | ImageContent | ListContent;

export type YesNoQuestion = { kind: "yesno"; id: string; instructions: string };
export type ChoiceOption = { option: string; description?: string | null };
export type ChoiceQuestion = {
  kind: "choice";
  id: string;
  instructions: string;
  options: readonly ChoiceOption[];
};
export type ScaleLevel = { level: number; description?: string | null };
export type ScaleQuestion = {
  kind: "scale";
  id: string;
  instructions: string;
  levels: readonly ScaleLevel[];
};
export type SortQuestion = { kind: "sort"; id: string; instructions: string };
export type TagSpec = {
  id: string;
  name?: string | null;
  /** Accepted and ignored by the server. */
  threshold?: number | null;
};
export type TagsQuestion = {
  kind: "tags";
  id: string;
  instructions?: string | null;
  tags: readonly TagSpec[];
};
export type Question = YesNoQuestion | ChoiceQuestion | ScaleQuestion | SortQuestion | TagsQuestion;

export type ContentFor<Q> = Q extends { kind: "sort" } ? ListContent : Content;

type GroundingField<Q, C> = C extends ImageContent
  ? { grounding?: null }
  : Q extends SortQuestion
    ? { grounding?: null }
    : { grounding?: Grounding | null };

/** Body of `POST /decide`. Sort requires list content. Images and sort cannot set grounding. */
export type DecideBody<Q extends Question, C> = {
  content: C;
  question: Q;
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
} & GroundingField<Q, C>;

export type BatchQuestion =
  | (YesNoQuestion & { grounding?: Grounding | null })
  | (ChoiceQuestion & { grounding?: Grounding | null })
  | (ScaleQuestion & { grounding?: Grounding | null })
  | SortQuestion
  | (TagsQuestion & { grounding?: Grounding | null });

export type BatchGroup = {
  content: Content;
  questions: readonly BatchQuestion[];
};

/** Body of `POST /decide/batch`. `reasoning` applies to every question. */
export type BatchBody<Groups extends readonly BatchGroup[]> = {
  requests: Groups;
  reasoning?: ReasoningMode;
  latency_mode?: LatencyMode;
};

export type Usage = {
  billed_input_tokens: number;
  rendered_tokens: number | null;
  image_count: number;
  image_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
};

export type ReasoningMeta = {
  fired: boolean;
  ran: boolean;
  finished: boolean | null;
  tokens: number | null;
  margin: number | null;
  limited: string | null;
  forced: boolean | null;
};

export type Meta = {
  model: string | null;
  latency_ms: number | null;
  question_count: number | null;
  compute_mode: string | null;
  usage: Usage | null;
  reasoning: ReasoningMeta | null;
  escalated: boolean | null;
};

export type GroundingSource = {
  url: string | null;
  title: string | null;
  snippet: string | null;
};

export type GroundingMeta = {
  triggered: boolean;
  trigger_reason: string | null;
  queries: readonly string[];
  sources: readonly GroundingSource[];
  added_context_tokens: number | null;
  search_ms: number | null;
};

export type ChoiceProbabilities<Opts extends readonly { readonly option: string }[]> = {
  readonly [I in keyof Opts]: Opts[I] extends { readonly option: infer Name extends string }
    ? { readonly option: Name; readonly probability: number }
    : never;
};

export type ScaleProbabilities<Levels extends readonly { readonly level: number }[]> = {
  readonly [I in keyof Levels]: Levels[I] extends { readonly level: infer Level extends number }
    ? { readonly level: Level; readonly probability: number }
    : never;
};

type IdOf<Q> = Q extends { id: infer Id extends string } ? Id : string;
type OptionsOf<Q> = Q extends { options: infer Opts extends readonly { readonly option: string }[] }
  ? Opts
  : never;
type LevelsOf<Q> = Q extends { levels: infer Levels extends readonly { readonly level: number }[] }
  ? Levels
  : never;
type TagsOf<Q> = Q extends { tags: infer Tags extends readonly { readonly id: string }[] } ? Tags : never;

type ListIds<C> = C extends { readonly value: readonly (infer Item)[] }
  ? Item extends { readonly id: infer Id extends string }
    ? Id
    : never
  : string;

type SameLength<T extends readonly unknown[], V> = { readonly [I in keyof T]: V };

type Envelope<Id extends string, Kind extends string, Result> = {
  id: Id;
  kind: Kind;
  result: Result;
  meta: Meta;
  grounding_meta: GroundingMeta | null;
};

export type YesNoDecision<Id extends string = string> = Envelope<
  Id,
  "yesno",
  { answer: "yes" | "no" | null; probability: number }
>;

export type ChoiceDecision<
  Id extends string = string,
  Opts extends readonly { readonly option: string }[] = readonly { readonly option: string }[],
> = Envelope<
  Id,
  "choice",
  { probabilities: ChoiceProbabilities<Opts> } & (
    | { chosen: Opts[number]["option"]; probability: number }
    | { chosen: null; probability: null }
  )
>;

export type ScaleDecision<
  Id extends string = string,
  Levels extends readonly { readonly level: number }[] = readonly { readonly level: number }[],
> = Envelope<
  Id,
  "scale",
  { expectation: number; confidence: number; probabilities: ScaleProbabilities<Levels> }
>;

export type SortDecision<Id extends string = string, C = Content> = Envelope<
  Id,
  "sort",
  {
    sorted: C extends ListContent ? SameLength<C["value"], ListIds<C>> : readonly string[];
    confidence: number | null;
  }
>;

export type AppliesOf<C> = C extends { kind: "image" } ? boolean : boolean | null;

export type TagEntries<
  Tags extends readonly { readonly id: string }[],
  Applies extends boolean | null = boolean | null,
> = {
  readonly [I in keyof Tags]: Tags[I] extends { readonly id: infer Id extends string }
    ? { readonly id: Id; readonly probability: number; readonly applies: Applies }
    : never;
};

export type TagsDecision<
  Id extends string = string,
  Tags extends readonly { readonly id: string }[] = readonly { readonly id: string }[],
  Applies extends boolean | null = boolean | null,
> = Envelope<Id, "tags", { tags: TagEntries<Tags, Applies> }>;

export type TagRecord<Tags extends readonly { readonly id: string }[]> = {
  [Tag in Tags[number] as Tag["id"]]: Tag;
};

/** Result of `decide`, inferred from the question and, for sort, from the list ids. */
export type DecisionOf<Q, C = Content> = Q extends ChoiceQuestion
  ? ChoiceDecision<IdOf<Q>, OptionsOf<Q>>
  : Q extends ScaleQuestion
    ? ScaleDecision<IdOf<Q>, LevelsOf<Q>>
    : Q extends SortQuestion
      ? SortDecision<IdOf<Q>, C>
      : Q extends TagsQuestion
        ? TagsDecision<IdOf<Q>, TagsOf<Q>, AppliesOf<C>>
        : Q extends YesNoQuestion
          ? YesNoDecision<IdOf<Q>>
          : never;

export type BatchAnswer<Q, C> =
  | { readonly ok: true; readonly result: DecisionOf<Q, C>; readonly error: null }
  | { readonly ok: false; readonly result: null; readonly error: string };

export type BatchResults<Groups extends readonly BatchGroup[]> = {
  readonly [I in keyof Groups]: Groups[I] extends {
    readonly content: infer C;
    readonly questions: infer Qs extends readonly BatchQuestion[];
  }
    ? { readonly answers: { readonly [J in keyof Qs]: BatchAnswer<Qs[J], C> } }
    : never;
};

export type BatchMeta = {
  model: string | null;
  request_count: number;
  question_count: number;
  latency_ms: number | null;
  usage: Usage | null;
};

export type BatchOf<Groups extends readonly BatchGroup[]> = {
  results: BatchResults<Groups>;
  meta: BatchMeta;
};

export type UsageEstimate = {
  min_input_tokens: number;
  max_input_tokens: number;
  exact: boolean;
  min_output_tokens: number | null;
  max_output_tokens: number | null;
  sequences: number | null;
  basis: string | null;
};

export type Estimate = { usage: UsageEstimate };

export type EstimateBody =
  | {
      content: Content;
      question: Question;
      reasoning?: ReasoningMode;
      latency_mode?: LatencyMode;
      grounding?: Grounding | null;
    }
  | {
      requests: readonly {
        content: Content;
        questions: readonly BatchQuestion[];
      }[];
      reasoning?: ReasoningMode;
      latency_mode?: LatencyMode;
    };

export type CallOptions = { signal?: AbortSignal };

export type SageOptions = {
  /** Levanto key (`lv_live_...`). Falls back to `SAGE_API_KEY` when `stub` is not set. */
  apiKey?: string;
  /** Default `https://sage.levanto.ai`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Whole-call deadline including one 503 retry. Integer milliseconds, 1..2_147_483_647. Default 30_000. */
  timeoutMs?: number;
  /** Answer locally from a hash of the request. No network, no key. */
  stub?: boolean;
  /** Retry HTTP 503 once. Default true. Ignored in stub mode. */
  retry503?: boolean;
};
