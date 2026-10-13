import assert from "node:assert/strict";
import { test } from "node:test";
import { indexTags, SageApi, SageError } from "../src/index.ts";

const yesNo = {
  content: "Marketing email promises risk-free returns.",
  question: {
    kind: "yesno" as const,
    id: "review",
    instructions: "Does this need compliance review?",
  },
};

test("the same request is the same nonsense", async () => {
  const sage = new SageApi({ stub: true });
  const first = await sage.decide(yesNo);
  const second = await sage.decide(yesNo);
  assert.deepEqual(first, second);
  assert.equal(first.meta.model, "levanto-sage-stub");
  assert.equal(first.meta.latency_ms, 0);
  assert.equal(first.id, "review");
  assert.equal(first.kind, "yesno");
});

test("key order and null-versus-omitted do not change the seed", async () => {
  const sage = new SageApi({ stub: true });
  const reordered = await sage.decide({
    grounding: null,
    question: { instructions: "Does this need compliance review?", id: "review", kind: "yesno" },
    content: "Marketing email promises risk-free returns.",
  });
  const plain = await sage.decide(yesNo);
  assert.deepEqual(reordered, plain);

  const described = await sage.decide({
    content: "contract",
    question: {
      kind: "choice",
      id: "d",
      instructions: "pick",
      options: [{ option: "approve", description: null }, { option: "revise" }],
    },
  });
  const omitted = await sage.decide({
    content: "contract",
    question: {
      kind: "choice",
      id: "d",
      instructions: "pick",
      options: [{ option: "approve" }, { option: "revise" }],
    },
  });
  assert.deepEqual(described, omitted);

  const explicitOff = await sage.decide({ ...yesNo, reasoning: "off" });
  assert.notDeepEqual(explicitOff, plain);
});

test("a different field changes the answer", async () => {
  const sage = new SageApi({ stub: true });
  const a = await sage.decide(yesNo);
  const b = await sage.decide({ ...yesNo, content: "A different email." });
  assert.notDeepEqual(a, b);
});

test("null is a stable bucket, not a throw", async () => {
  const sage = new SageApi({ stub: true });
  let sawNull = false;
  let sawAnswer = false;
  for (let i = 0; i < 80; i++) {
    const decision = await sage.decide({
      content: `probe-${i}`,
      question: { kind: "yesno", id: "p", instructions: "yes?" },
    });
    if (decision.result.answer === null) sawNull = true;
    else sawAnswer = true;
    assert.equal(typeof decision.result.probability, "number");
  }
  assert.equal(sawNull, true);
  assert.equal(sawAnswer, true);
});

test("choice, scale, sort, and tags stay inside the request", async () => {
  const sage = new SageApi({ stub: true });
  const choice = await sage.decide({
    content: "contract",
    question: {
      kind: "choice",
      id: "d",
      instructions: "pick",
      options: [{ option: "approve" }, { option: "revise" }, { option: "reject" }],
    },
  });
  const names = choice.result.probabilities.map((row) => row.option);
  assert.deepEqual(names, ["approve", "revise", "reject"]);
  const mass = choice.result.probabilities.reduce((sum, row) => sum + Math.round(row.probability * 10000), 0);
  assert.equal(mass, 10000);
  if (choice.result.chosen === null) assert.equal(choice.result.probability, null);
  else {
    assert.ok(names.includes(choice.result.chosen));
    assert.equal(typeof choice.result.probability, "number");
  }

  const scale = await sage.decide({
    content: "interview",
    question: {
      kind: "scale",
      id: "s",
      instructions: "score",
      levels: [
        { level: 0, description: "no" },
        { level: 4, description: "yes" },
      ],
    },
  });
  assert.deepEqual(
    scale.result.probabilities.map((row) => row.level),
    [0, 4],
  );

  const sort = await sage.decide({
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
  assert.deepEqual([...sort.result.sorted].sort(), ["db_down", "pricing", "typo"]);
  const again = await sage.decide({
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
  assert.deepEqual(sort, again);

  const tags = await sage.decide({
    content: "post",
    question: {
      kind: "tags",
      id: "m",
      tags: [
        { id: "spam", name: "spam: bulk" },
        { id: "promotion", name: "promotion: ad" },
      ],
    },
  });
  assert.deepEqual(
    tags.result.tags.map((tag) => tag.id),
    ["spam", "promotion"],
  );
  for (const tag of tags.result.tags) {
    assert.ok(tag.applies === true || tag.applies === false || tag.applies === null);
  }
});

test("batch index is part of the seed", async () => {
  const sage = new SageApi({ stub: true });
  const batched = await sage.batch({
    requests: [
      {
        content: "same",
        questions: [
          { kind: "yesno", id: "a", instructions: "q" },
          { kind: "yesno", id: "b", instructions: "q" },
        ],
      },
    ],
  });
  const left = batched.results[0].answers[0];
  const right = batched.results[0].answers[1];
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (left.ok && right.ok) assert.notDeepEqual(left.result, right.result);
  const repeat = await sage.batch({
    requests: [
      {
        content: "same",
        questions: [
          { kind: "yesno", id: "a", instructions: "q" },
          { kind: "yesno", id: "b", instructions: "q" },
        ],
      },
    ],
  });
  assert.deepEqual(batched, repeat);
});

test("stub never calls fetch", async () => {
  const sage = new SageApi({
    stub: true,
    fetch: () => {
      throw new Error("network");
    },
  });
  const decision = await sage.decide(yesNo);
  assert.equal(decision.kind, "yesno");
  assert.equal(await sage.ready(), true);
  const estimate = await sage.estimate(yesNo);
  assert.equal(estimate.usage.basis, "stub");
  assert.equal(estimate.usage.exact, true);
});

test("a sibling question does not change this answer", async () => {
  const sage = new SageApi({ stub: true });
  const alone = await sage.batch({
    requests: [{ content: "same", questions: [{ kind: "yesno", id: "a", instructions: "q" }] }],
  });
  const withSibling = await sage.batch({
    requests: [
      {
        content: "same",
        questions: [
          { kind: "yesno", id: "a", instructions: "q" },
          { kind: "yesno", id: "b", instructions: "other" },
        ],
      },
    ],
  });
  assert.deepEqual(alone.results[0].answers[0], withSibling.results[0].answers[0]);
});

test("image tags are never null", async () => {
  const sage = new SageApi({ stub: true });
  const tagged = await sage.decide({
    content: { kind: "image", media: "data:image/png;base64,AAAA" },
    question: {
      kind: "tags",
      id: "m",
      tags: Array.from({ length: 24 }, (_, index) => ({ id: `t${index}` })),
    },
  });
  assert.equal(tagged.result.tags.length, 24);
  for (const tag of tagged.result.tags) assert.equal(typeof tag.applies, "boolean");
});

test("threshold and unknown keys are not part of the seed", async () => {
  const sage = new SageApi({ stub: true });
  const plain = await sage.decide({
    content: "post",
    question: { kind: "tags", id: "m", tags: [{ id: "spam", name: "spam: bulk" }] },
  });
  const withThreshold = await sage.decide({
    content: "post",
    question: {
      kind: "tags",
      id: "m",
      tags: [{ id: "spam", name: "spam: bulk", threshold: 0.2 }],
    },
  });
  assert.deepEqual(plain, withThreshold);
});

test("local rejects", () => {
  const sage = new SageApi({ stub: true });
  const invalid = (error: unknown) => error instanceof SageError && error.kind === "invalid";
  assert.throws(
    () => sage.decide({ content: "x", question: { kind: "yesno", id: "", instructions: "q" } }),
    invalid,
  );
  assert.throws(
    () =>
      sage.decide({
        content: "x",
        question: { kind: "choice", id: "c", instructions: "q", options: [{ option: "only" }] },
      }),
    invalid,
  );
  assert.throws(
    () =>
      sage.decide({
        content: "x",
        question: { kind: "yesno", id: "q", instructions: "q" },
        grounding: { confidence_floor: Number.NaN },
      }),
    invalid,
  );
  assert.throws(
    () =>
      sage.batch({
        requests: [
          {
            content: {
              kind: "list",
              value: [
                { id: "a", content: "a" },
                { id: "b", content: "b" },
              ],
            },
            questions: [{ kind: "sort", id: "s", instructions: "rank", grounding: { trigger: "always" } }],
          },
        ],
      }),
    invalid,
  );
});

test("indexTags preserves special property names as own entries", () => {
  const tags = [
    { id: "__proto__", probability: 0.9, applies: true },
    { id: "constructor", probability: 0.1, applies: false },
    { id: "toString", probability: 0.5, applies: null },
  ];
  const indexed = indexTags(tags);
  assert.equal(Object.getPrototypeOf(indexed), Object.prototype);
  assert.deepEqual(Object.keys(indexed), tags.map((tag) => tag.id));
  for (const tag of tags) {
    assert.equal(Object.hasOwn(indexed, tag.id), true);
    assert.equal(indexed[tag.id], tag);
    assert.deepEqual(JSON.parse(JSON.stringify(indexed))[tag.id], tag);
  }
});

test("stub scale expectations match the probability distribution in decide and batch", async () => {
  const sage = new SageApi({ stub: true });
  const question = {
    kind: "scale" as const,
    id: "score",
    instructions: "How strong?",
    levels: [{ level: -3 }, { level: 1 }, { level: 10 }],
  };
  for (let index = 0; index < 40; index++) {
    const content = `interview-${index}`;
    const decision = await sage.decide({ content, question });
    const batch = await sage.batch({ requests: [{ content, questions: [question] }] });
    const answer = batch.results[0].answers[0];
    assert.equal(answer.ok, true);
    if (!answer.ok) throw new Error(answer.error);
    for (const { result } of [decision, answer.result]) {
      const expectation = result.probabilities.reduce((sum, row) => sum + row.level * row.probability, 0);
      assert.ok(Math.abs(result.expectation - expectation) <= 0.00005);
    }
  }
});
