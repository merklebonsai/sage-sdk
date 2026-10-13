import { indexTags, Sage, SageAnswer, SageApi, SageSDK } from "../src/index.ts";

type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const sage = new SageApi({ stub: true });

const choice = await sage.decide({
  content: "contract",
  question: {
    kind: "choice",
    id: "disposition",
    instructions: "How should legal handle this contract?",
    options: [
      { option: "approve", description: "Sign" },
      { option: "revise", description: "Redline" },
    ],
  },
});
type _Chosen = Assert<Eq<(typeof choice)["result"]["chosen"], "approve" | "revise" | null>>;
type _Id = Assert<Eq<(typeof choice)["id"], "disposition">>;
type _P0 = Assert<Eq<(typeof choice)["result"]["probabilities"][0]["option"], "approve">>;
type _Kind = Assert<Eq<(typeof choice)["kind"], "choice">>;

const scored = await sage.decide({
  content: "interview",
  question: {
    kind: "scale",
    id: "score",
    instructions: "How strong?",
    levels: [
      { level: 0, description: "No" },
      { level: 1, description: "Weak" },
      { level: 4, description: "Strong" },
    ],
  },
});
type _L0 = Assert<Eq<(typeof scored)["result"]["probabilities"][0]["level"], 0>>;
type _L2 = Assert<Eq<(typeof scored)["result"]["probabilities"][2]["level"], 4>>;
type _Exp = Assert<Eq<(typeof scored)["result"]["expectation"], number>>;

const ranked = await sage.decide({
  content: {
    kind: "list",
    value: [
      { id: "typo", content: "spell" },
      { id: "db_down", content: "down" },
      { id: "pricing", content: "price" },
    ],
  },
  question: { kind: "sort", id: "triage", instructions: "urgency" },
});
type _S0 = Assert<Eq<(typeof ranked)["result"]["sorted"][0], "typo" | "db_down" | "pricing">>;
type _SLen = Assert<Eq<(typeof ranked)["result"]["sorted"]["length"], 3>>;

const tagged = await sage.decide({
  content: "post",
  question: {
    kind: "tags",
    id: "moderate",
    tags: [
      { id: "spam", name: "spam: bulk" },
      { id: "promotion", name: "promotion: ad" },
    ],
  },
});
type _T0 = Assert<Eq<(typeof tagged)["result"]["tags"][0]["id"], "spam">>;
type _T1 = Assert<Eq<(typeof tagged)["result"]["tags"][1]["applies"], boolean | null>>;
const byId = indexTags(tagged.result.tags);
type _Spam = Assert<Eq<(typeof byId)["spam"]["applies"], boolean | null>>;

const pictureTags = await sage.decide({
  content: { kind: "image", media: "data:image/png;base64,qq" },
  question: { kind: "tags", id: "shot", tags: [{ id: "bug" }, { id: "noise" }] },
});
type _Img = Assert<Eq<(typeof pictureTags)["result"]["tags"][0]["applies"], boolean>>;

const batched = await sage.batch({
  requests: [
    {
      content: "doc",
      questions: [
        { kind: "yesno", id: "a", instructions: "urgent?" },
        {
          kind: "choice",
          id: "c",
          instructions: "which",
          options: [{ option: "left" }, { option: "right" }],
        },
      ],
    },
  ],
});
type Row = (typeof batched)["results"][0]["answers"][1];
type _Batch = Assert<Eq<Extract<Row, { ok: true }>["result"]["result"]["chosen"], "left" | "right" | null>>;

void sage.decide({
  // @ts-expect-error sort content must be a list
  content: "nope",
  question: { kind: "sort", id: "t", instructions: "u" },
});
void sage.decide({
  content: { kind: "image", media: "data:image/png;base64,qq" },
  question: { kind: "yesno", id: "i", instructions: "q" },
  // @ts-expect-error an image cannot be grounded
  grounding: { trigger: "always" },
});
void sage.decide({
  content: {
    kind: "list",
    value: [
      { id: "a", content: "a" },
      { id: "b", content: "b" },
    ],
  },
  question: { kind: "sort", id: "s", instructions: "rank" },
  // @ts-expect-error sort cannot be grounded
  grounding: { trigger: "always" },
});

const doc = new Sage("contract", { stub: true });

const picked = await doc.choose("How should legal handle this contract?", {
  approve: "Sign",
  revise: "Redline",
});
type _High = Assert<Eq<(typeof picked)["value"], "approve" | "revise" | null>>;
if (picked.value === null) {
  type _NullConf = Assert<Eq<typeof picked.confidence, null>>;
} else {
  type _SetConf = Assert<Eq<typeof picked.confidence, number>>;
}

const pickedArray = await doc.choose("which", [
  { option: "approve", description: "Sign" },
  { option: "revise", description: "Redline" },
]);
type _Arr = Assert<Eq<(typeof pickedArray)["value"], "approve" | "revise" | null>>;
type _Opt0 = Assert<Eq<(typeof pickedArray)["probabilities"][0]["option"], "approve">>;

const only = await new SageAnswer("contract", { stub: true }).choose("which", { left: "L", right: "R" });
type _Only = Assert<Eq<typeof only, "left" | "right" | null>>;

const rubric = await doc.scale("How strong?", [
  { level: 0, description: "No" },
  { level: 1, description: "Weak" },
  { level: 4, description: "Strong" },
]);
type _Rubric0 = Assert<Eq<(typeof rubric)["probabilities"][0]["level"], 0>>;
type _Rubric2 = Assert<Eq<(typeof rubric)["probabilities"][2]["level"], 4>>;
type _RubricValue = Assert<Eq<(typeof rubric)["value"], number>>;

const urgency = await new SageAnswer("ticket", { stub: true }).gauge("How urgent?", 0, 4);
void doc.gauge("How urgent?", 0, 4, { reasoning: "on" });
void doc.gauge("How urgent?", 0, 4, 2, { reasoning: "off" });
type _Gauge = Assert<Eq<typeof urgency, number>>;

const rankedHigh = await doc.sort("urgency", [
  { id: "typo", content: "spell" },
  { id: "db_down", content: "down" },
  { id: "pricing", content: "price" },
]);
type _Sort0 = Assert<
  Eq<
    (typeof rankedHigh)["value"][0],
    | { readonly id: "typo"; readonly content: "spell" }
    | { readonly id: "db_down"; readonly content: "down" }
    | { readonly id: "pricing"; readonly content: "price" }
  >
>;
type _SortLen = Assert<Eq<(typeof rankedHigh)["value"]["length"], 3>>;

const rankedMaps = await doc.sort("urgency", [{ typo: "spell" }, { db_down: "down" }]);
type _MapId = Assert<Eq<(typeof rankedMaps)["value"][number]["id"], "typo" | "db_down">>;

const labeled = await doc.tag("labels", { spam: "bulk", promo: "ad" });
type _Label = Assert<Eq<(typeof labeled)["value"]["spam"], boolean | null>>;
type _PromoP = Assert<Eq<(typeof labeled)["confidence"]["promo"], number>>;

const picture = new Sage({ kind: "image" as const, media: "data:image/png;base64,qq" }, { stub: true });
const shot = await picture.tag("labels", [
  { tag: "bug", description: "defect" },
  { tag: "noise", description: "grain" },
]);
type _Shot = Assert<Eq<(typeof shot)["value"]["bug"], boolean>>;

const answerTags = await new SageAnswer("post", { stub: true }).tag("labels", { spam: "bulk" });
type _AnswerTag = Assert<Eq<(typeof answerTags)["spam"], boolean | null>>;

void picture.yesOrNo("shown?", {
  // @ts-expect-error an image cannot be grounded
  grounding: { trigger: "always" },
});
const sdk = new SageSDK({ stub: true });
const viaSdk = await sdk.sage("contract").choose("which", { approve: "Sign", revise: "Redline" });
type _Sdk = Assert<Eq<(typeof viaSdk)["value"], "approve" | "revise" | null>>;
const viaAnswer = await sdk.sageAnswer("contract").choose("which", { left: "L", right: "R" });
type _SdkOnly = Assert<Eq<typeof viaAnswer, "left" | "right" | null>>;
const viaImage = await sdk
  .sage({ kind: "image" as const, media: "data:image/png;base64,qq" })
  .tag("labels", { bug: "defect" });
type _SdkShot = Assert<Eq<(typeof viaImage)["value"]["bug"], boolean>>;

void doc.sort(
  "rank",
  [
    { id: "a", content: "a" },
    { id: "b", content: "b" },
  ],
  {
    // @ts-expect-error sort cannot be grounded
    grounding: { trigger: "always" },
  },
);

const numericChoice = await doc.choose("which", { 0: "Zero", 1: "One", other: "Other" });
type _NumericChoice = Assert<Eq<typeof numericChoice.value, "0" | "1" | "other" | null>>;
type _NumericChoiceProbability = Assert<Eq<(typeof numericChoice.probabilities)[number]["option"], "0" | "1" | "other">>;
const numericAnswer = await new SageAnswer("doc", { stub: true }).choose("which", { 0: "Zero", 1: "One" });
type _NumericAnswer = Assert<Eq<typeof numericAnswer, "0" | "1" | null>>;
const numericTags = await doc.tag("labels", { 0: "Zero", named: "Named" });
type _NumericTags = Assert<Eq<keyof typeof numericTags.value, "0" | "named">>;
type _NumericTagConfidence = Assert<Eq<typeof numericTags.confidence["0"], number>>;
const numericSort = await doc.sort("rank", [{ 0: "Zero" }, { 1: "One", named: "Named" }]);
type _NumericSort = Assert<Eq<(typeof numericSort.value)[number]["id"], "0" | "1" | "named">>;
