# sage-sdk

TypeScript client for [Levanto Sage](https://docs.levanto.ai/). One decision in, a typed answer or `null` out.

Three classes. `SageSDK` holds the client. `sage(context)` returns a `Sage`: the value, how sure that value is, and the rest of the decision. `sageAnswer(context)` returns a `SageAnswer`: the value only. `SageApi` is the HTTP client underneath: `decide`, `batch`, `estimate`, and `ready`.

The package is private until the npm scope is real. Publish name to use then: `@levanto/sage`. `jsr.json` points at the same source under the placeholder scope `@scope`.

```ts
import { SageSDK } from "sage-sdk";

const sdk = new SageSDK({ apiKey: process.env.SAGE_API_KEY });
const refund = "Refund request: order #4411, $180, bought 41 days ago.";
const options = {
  refund: "Cash refund within policy",
  credit: "Store credit only",
  deny: "Outside policy",
};

const reading = await sdk.sage(refund).choose("What should support do?", options);
reading.value; // "refund" | "credit" | "deny" | null
reading.confidence; // number when value is set, otherwise null

const chosen = await sdk.sageAnswer(refund).choose("What should support do?", options);
chosen; // "refund" | "credit" | "deny" | null
```

The document is the argument to `sage` and `sageAnswer`. `new Sage(document, options)` and `new SageAnswer(document, options)` are those same classes. `options` is client options, or an existing `SageApi`. `SageSDK` takes them once. Sort does not use that document. It ranks the items you pass.

| Method | Value | Confidence |
| --- | --- | --- |
| `yesOrNo(instructions)` | `"yes" \| "no" \| null` | how sure that answer is; `probability` stays P(yes) |
| `choose(instructions, options)` | one option, or null | probability of that option, or null |
| `scale(instructions, levels)` | expectation, in level units | the scale confidence, always a number |
| `gauge(instructions, start, end, step?)` | expectation on that integer range | same as scale |
| `sort(instructions, items)` | the items, ranked | number or null |
| `tag(instructions, tags)` | applies per tag | probability per tag |

`choose` and `tag` take a record (`{ refund: "Cash refund…" }`, `{ spam: "bulk or unsolicited" }`) or an array (`{ option, description }[]`, `{ tag, description }[]`). Record keys come out in ordinary property order: integer-like keys first, ascending, then the rest in insertion order. Arrays keep the order you wrote.

`gauge` is a scale. `rangeEnd` is inclusive. `rangeStep` defaults to 1, or to -1 when the range decreases, and `rangeEnd` has to fall on a step. A gauge has 2 to 26 levels.

Sort items are either `{ id, content }[]` or an array of id → content maps. An object with a string `id` and a `content` field is a list item, so a map cannot hold two items named `id` and `content`.

On an image, each tag applies as `boolean`. On text, `boolean | null`. Pass the image inline with `kind: "image" as const`.

An options object may carry `reasoning`, `latency_mode`, `grounding`, and `signal`. Sort cannot be grounded. An image cannot be grounded.

`null` is Sage saying it is not sure. It is HTTP 200. Do not retry it. On yes/no, `confidence` is null together with `value`, and `probability` is still P(yes). On choice, `confidence` is null together with `value`. Scale and gauge always return a number; a weak score is a low `confidence`, not null.

Pass the object inline (or `as const` on a variable). A widened `string` stays `string`.

```ts
import { SageApi } from "sage-sdk";

const api = new SageApi({ apiKey: process.env.SAGE_API_KEY });

const decision = await api.decide({
  content: refund,
  question: {
    kind: "choice",
    id: "refund",
    instructions: "What should support do?",
    options: [
      { option: "refund", description: "Cash refund within policy" },
      { option: "credit", description: "Store credit only" },
      { option: "deny", description: "Outside policy" },
    ],
  },
});

decision.result.chosen; // "refund" | "credit" | "deny" | null
```

Tag rows on `SageApi` stay in request order (`result.tags[0].id` is the first id you sent). `indexTags` turns that array into a record keyed by id.

| Call | Endpoint |
| --- | --- |
| `Sage` / `SageAnswer` methods, from `SageSDK` or directly | `POST /decide` |
| `decide` | `POST /decide` |
| `batch` | `POST /decide/batch` |
| `estimate` | `POST /usage/estimate` |
| `ready` | `GET /ready` (no key) |

Auth is `Authorization: Bearer`. `apiKey` wins, otherwise `SAGE_API_KEY` when `process` exists. The key is not logged. Default timeout is 30s, one shared deadline for the call and a single 503 retry. `retry-after` is honored up to 2s. A blank `retry-after` waits 200ms. 400, 401, and 402 are not retried.

Errors are one `SageError`. `kind` is `"http" | "protocol" | "timeout" | "network" | "invalid"`. `status` is the HTTP code, or `null`.

```ts
const sdk = new SageSDK({ stub: true });
const offline = sdk.sage("contract");
const api = new SageApi({ stub: true });
```

Stub mode does not use the network. The seed is FNV-1a over an allowlist of the request, not `JSON.stringify`: object keys are sorted, array order is kept, unknown keys and the deprecated tag `threshold` are ignored. Omitted grounding and `grounding: null` match. A null option description, level description, tag name, or image text matches omitting it. Explicit `reasoning: "off"` and `latency_mode: "fast"` do not match omitting those fields, so a future server default cannot move old seeds. Strings, including image `media`, are hashed as UTF-16 code units with no Unicode normalization. About one request in five comes back unsure (`null`), from a fixed bucket of that hash. Image tags are `true` or `false`, matching the live API. Choice, scale, sort, and tags stay inside the options, levels, ids, and tags you sent. Each batch answer is seeded from that question, its content, and the group and question indexes, not from its siblings. `meta.model` is `"levanto-sage-stub"` and `latency_ms` is `0`.

Scale `expectation` is a number in your level units, not a level literal. The level literals are on `result.probabilities[i].level`. Sort `sorted` is a permutation of your item ids; each index is the union of those ids.

`POST /v1/systemone` (the Jev-compatible body) is not wrapped. Confidence on that route is Sage's max probability, not TypeSafe's formula. Call it with `fetch` if you are moving an existing Jev client.
