import assert from "node:assert/strict";
import { test } from "node:test";
import { Sage, SageAnswer, SageApi, SageError, SageSDK } from "../src/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function answerFor(request: unknown): unknown {
  if (!isRecord(request) || !isRecord(request.question)) throw new Error("missing question");
  const question = request.question;
  const id = question.id;
  const kind = question.kind;
  if (kind === "yesno") return { id, kind, result: { answer: "no", probability: 0.91 }, meta: { model: "wire" } };
  if (kind === "choice" && Array.isArray(question.options)) {
    const names = question.options.map((option) => {
      if (!isRecord(option) || typeof option.option !== "string") throw new Error("option");
      return option.option;
    });
    const chosen = names[0];
    if (chosen === undefined) throw new Error("empty options");
    return {
      id,
      kind,
      meta: {},
      result: {
        chosen,
        probability: 0.8,
        probabilities: names.map((option, index) => ({ option, probability: index === 0 ? 0.8 : 0.2 })),
      },
    };
  }
  if (kind === "scale" && Array.isArray(question.levels)) {
    const levels = question.levels.map((level) => {
      if (!isRecord(level) || typeof level.level !== "number") throw new Error("level");
      return level.level;
    });
    return {
      id,
      kind,
      meta: {},
      result: {
        expectation: 1.25,
        confidence: 0.4,
        probabilities: levels.map((level) => ({ level, probability: 1 / levels.length })),
      },
    };
  }
  if (kind === "sort" && isRecord(request.content) && Array.isArray(request.content.value)) {
    const sorted = request.content.value.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string") throw new Error("item");
      return item.id;
    });
    return { id, kind, meta: {}, result: { sorted, confidence: 0.5 } };
  }
  if (kind === "tags" && Array.isArray(question.tags)) {
    return {
      id,
      kind,
      meta: {},
      result: {
        tags: question.tags.map((tag) => {
          if (!isRecord(tag) || typeof tag.id !== "string") throw new Error("tag");
          return { id: tag.id, probability: 0.7, applies: true };
        }),
      },
    };
  }
  throw new Error(`unexpected ${String(kind)}`);
}

function client(onRequest?: (body: unknown, init: RequestInit | undefined) => void): Sage<string> {
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    if (init?.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    onRequest?.(body, init);
    return Promise.resolve(jsonResponse(answerFor(body)));
  };
  return new Sage("document", { apiKey: "lv_live_test", fetch });
}

test("yes/no confidence is how sure the answer is", async () => {
  const yes = new Sage("document", {
    apiKey: "lv_live_test",
    fetch: () => Promise.resolve(jsonResponse({ id: "yesOrNo", kind: "yesno", result: { answer: "yes", probability: 0.91 }, meta: {} })),
  });
  const yesReading = await yes.yesOrNo("review?");
  assert.equal(yesReading.value, "yes");
  assert.equal(yesReading.confidence, 0.91);
  assert.equal(yesReading.probability, 0.91);

  const no = new Sage("document", {
    apiKey: "lv_live_test",
    fetch: () => Promise.resolve(jsonResponse({ id: "yesOrNo", kind: "yesno", result: { answer: "no", probability: 0.91 }, meta: {} })),
  });
  const noReading = await no.yesOrNo("review?");
  assert.equal(noReading.value, "no");
  assert.equal(noReading.confidence, 0.09);
  assert.equal(noReading.probability, 0.91);

  const unsure = new Sage("document", {
    apiKey: "lv_live_test",
    fetch: () => Promise.resolve(jsonResponse({ id: "yesOrNo", kind: "yesno", result: { answer: null, probability: 0.42 }, meta: {} })),
  });
  const unsureReading = await unsure.yesOrNo("review?");
  assert.equal(unsureReading.value, null);
  assert.equal(unsureReading.confidence, null);
  assert.equal(unsureReading.probability, 0.42);
  assert.equal(await new SageAnswer("document", {
    apiKey: "lv_live_test",
    fetch: () => Promise.resolve(jsonResponse({ id: "yesOrNo", kind: "yesno", result: { answer: null, probability: 0.42 }, meta: {} })),
  }).yesOrNo("review?"), null);
});

test("stub yes/no uses the same confidence rule", async () => {
  const sage = new Sage("seed", { stub: true });
  let sawNull = false;
  let sawAnswer = false;
  for (let index = 0; index < 40; index++) {
    const reading = await new Sage(`probe-${index}`, { stub: true }).yesOrNo("yes?");
    if (reading.value === null) {
      sawNull = true;
      assert.equal(reading.confidence, null);
    } else if (reading.value === "yes") {
      sawAnswer = true;
      assert.equal(reading.confidence, reading.probability);
    } else {
      sawAnswer = true;
      assert.equal(reading.confidence, Math.round((1 - reading.probability) * 1e12) / 1e12);
    }
  }
  assert.equal(sawNull, true);
  assert.equal(sawAnswer, true);
  assert.deepEqual(await sage.yesOrNo("yes?"), await sage.yesOrNo("yes?"));
  assert.equal(await new SageAnswer("seed", { stub: true }).yesOrNo("yes?"), (await sage.yesOrNo("yes?")).value);
});

test("choose returns the option or null, and a record matches the same array", async () => {
  const sage = new Sage("contract", { stub: true });
  const fromRecord = await sage.choose("pick", { approve: "Sign", revise: "Redline" });
  const fromArray = await sage.choose("pick", [
    { option: "approve", description: "Sign" },
    { option: "revise", description: "Redline" },
  ]);
  assert.deepEqual(fromRecord, fromArray);
  assert.deepEqual(
    fromArray.probabilities.map((row) => row.option),
    ["approve", "revise"],
  );
  if (fromArray.value === null) assert.equal(fromArray.confidence, null);
  else assert.equal(typeof fromArray.confidence, "number");

  const chosen = await client().choose("pick", [
    { option: "approve", description: "Sign" },
    { option: "revise", description: "Redline" },
  ]);
  assert.equal(chosen.value, "approve");
  assert.equal(chosen.confidence, 0.8);

  const none = new Sage("contract", {
    apiKey: "lv_live_test",
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          id: "choose",
          kind: "choice",
          meta: {},
          result: {
            chosen: null,
            probability: null,
            probabilities: [
              { option: "approve", probability: 0.5 },
              { option: "revise", probability: 0.5 },
            ],
          },
        }),
      ),
  });
  const blank = await none.choose("pick", { approve: "Sign", revise: "Redline" });
  assert.equal(blank.value, null);
  assert.equal(blank.confidence, null);
  assert.equal(await new SageAnswer("contract", { stub: true }).choose("pick", { approve: "Sign", revise: "Redline" }), fromRecord.value);
});

test("scale and gauge return the expectation", async () => {
  let levels: unknown;
  const sage = client((body) => {
    if (isRecord(body) && isRecord(body.question)) levels = body.question.levels;
  });
  const rubric = await sage.scale("How strong?", [
    { level: 0, description: "No" },
    { level: 4, description: "Yes" },
  ]);
  assert.equal(rubric.value, 1.25);
  assert.equal(rubric.confidence, 0.4);
  assert.deepEqual(
    rubric.probabilities.map((row) => row.level),
    [0, 4],
  );

  const stepped = await sage.gauge("How urgent?", 0, 4, 2);
  assert.deepEqual(levels, [{ level: 0 }, { level: 2 }, { level: 4 }]);
  assert.equal(stepped.value, 1.25);
  assert.equal(await new SageAnswer("document", { stub: true }).gauge("How urgent?", 5, 1), (
    await new Sage("document", { stub: true }).gauge("How urgent?", 5, 1)
  ).value);

  const descending = await client((body) => {
    if (isRecord(body) && isRecord(body.question)) levels = body.question.levels;
  }).gauge("score", 5, 1);
  assert.deepEqual(levels, [{ level: 5 }, { level: 4 }, { level: 3 }, { level: 2 }, { level: 1 }]);
  assert.equal(descending.confidence, 0.4);
});

test("gauge rejects a range that is not a scale", () => {
  const sage = new Sage("ticket", { stub: true });
  const invalid = (error: unknown) => error instanceof SageError && error.kind === "invalid";
  assert.throws(() => sage.gauge("q", 0, 10, 3), invalid);
  assert.throws(() => sage.gauge("q", 0, 0), invalid);
  assert.throws(() => sage.gauge("q", 0, 4, 0), invalid);
  assert.throws(() => sage.gauge("q", 0, 4, -1), invalid);
  assert.throws(() => sage.gauge("q", 1.5, 4), invalid);
  assert.throws(() => sage.gauge("q", 0, 100), invalid);
});

test("sort ranks the items and does not send the document", async () => {
  const items = [
    { id: "typo", content: "spell" },
    { id: "db_down", content: "down" },
    { id: "pricing", content: "price" },
  ];
  const sage = new Sage("ignored document", { stub: true });
  const reading = await sage.sort("urgency", items);
  assert.equal(reading.value.length, 3);
  assert.deepEqual(reading.value.map((item) => item.id).sort(), ["db_down", "pricing", "typo"]);
  for (const item of reading.value) assert.ok(items.includes(item));
  assert.deepEqual(await new SageAnswer("ignored document", { stub: true }).sort("urgency", items), reading.value);

  const maps = await sage.sort("urgency", [{ typo: "spell", db_down: "down" }, { pricing: "price" }]);
  assert.deepEqual(maps.value.map((item) => item.id).sort(), ["db_down", "pricing", "typo"]);

  let content: unknown;
  await client((body) => {
    if (isRecord(body)) content = body.content;
  }).sort("urgency", [{ "10": "ten", "2": "two" }]);
  assert.deepEqual(content, {
    kind: "list",
    value: [
      { id: "2", content: "two" },
      { id: "10", content: "ten" },
    ],
  });

  const invalid = (error: unknown) => error instanceof SageError && error.kind === "invalid";
  assert.throws(
    () => sage.sort("urgency", [{ id: "a", content: "a" }, { typo: "spell" }]),
    invalid,
  );
});

test("tag returns applies and probability per tag", async () => {
  const sage = new Sage("post", { stub: true });
  const reading = await sage.tag("labels", { spam: "bulk", promo: "ad" });
  assert.deepEqual(Object.keys(reading.value), ["spam", "promo"]);
  assert.deepEqual(Object.keys(reading.confidence), ["spam", "promo"]);
  for (const tag of ["spam", "promo"] as const) {
    assert.equal(typeof reading.confidence[tag], "number");
    assert.ok(reading.value[tag] === true || reading.value[tag] === false || reading.value[tag] === null);
  }
  assert.deepEqual(await new SageAnswer("post", { stub: true }).tag("labels", { spam: "bulk", promo: "ad" }), reading.value);

  const special = await sage.tag("labels", { ["__proto__"]: "proto", constructor: "ctor" });
  assert.equal(Object.getPrototypeOf(special.value), Object.prototype);
  assert.equal(Object.hasOwn(special.value, "__proto__"), true);
  assert.equal(Object.hasOwn(special.confidence, "constructor"), true);
  assert.equal(typeof special.confidence.constructor, "number");

  const picture = new Sage({ kind: "image" as const, media: "data:image/png;base64,AAAA" }, { stub: true });
  const shot = await picture.tag(
    "labels",
    Array.from({ length: 24 }, (_, index) => ({ tag: `t${index}`, description: `d${index}` })),
  );
  for (const applies of Object.values(shot.value)) assert.equal(typeof applies, "boolean");
});

test("each method is one decide", async () => {
  const bodies: unknown[] = [];
  const sage = client((body) => {
    bodies.push(body);
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => sage.yesOrNo("review?", { signal: controller.signal, reasoning: "on", latency_mode: "fast", grounding: { trigger: "always" } }),
    (error: unknown) => error instanceof SageError && error.kind === "timeout",
  );

  await sage.yesOrNo("review?", { reasoning: "on", latency_mode: "fast", grounding: { trigger: "always" } });
  await sage.choose("pick", { revise: "Redline", approve: "Sign" });
  await sage.choose("pick", [{ option: "approve" }, { option: "revise" }]);
  await sage.gauge("urgent?", 0, 4, undefined, { reasoning: "on" });
  await sage.tag("labels", [{ tag: "spam", description: "bulk" }]);

  assert.deepEqual(bodies[0], {
    content: "document",
    question: { kind: "yesno", id: "yesOrNo", instructions: "review?" },
    reasoning: "on",
    latency_mode: "fast",
    grounding: { trigger: "always" },
  });
  assert.deepEqual(bodies[1], {
    content: "document",
    question: {
      kind: "choice",
      id: "choose",
      instructions: "pick",
      options: [
        { option: "revise", description: "Redline" },
        { option: "approve", description: "Sign" },
      ],
    },
  });
  assert.deepEqual(bodies[2], {
    content: "document",
    question: {
      kind: "choice",
      id: "choose",
      instructions: "pick",
      options: [{ option: "approve" }, { option: "revise" }],
    },
  });
  assert.deepEqual(bodies[3], {
    content: "document",
    reasoning: "on",
    question: {
      kind: "scale",
      id: "gauge",
      instructions: "urgent?",
      levels: [{ level: 0 }, { level: 1 }, { level: 2 }, { level: 3 }, { level: 4 }],
    },
  });
  assert.deepEqual(bodies[4], {
    content: "document",
    question: {
      kind: "tags",
      id: "tag",
      instructions: "labels",
      tags: [{ id: "spam", name: "bulk" }],
    },
  });
});

test("a shared client is the same decision", async () => {
  const api = new SageApi({ stub: true });
  const reading = await new Sage("contract", api).choose("pick", { approve: "Sign", revise: "Redline" });
  const value = await new SageAnswer("contract", api).choose("pick", { approve: "Sign", revise: "Redline" });
  assert.equal(value, reading.value);
  assert.equal(reading.meta.model, "levanto-sage-stub");
});

test("SageSDK binds each document on one client", async () => {
  const bodies: unknown[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    bodies.push(body);
    return Promise.resolve(jsonResponse(answerFor(body)));
  };
  const sdk = new SageSDK({ apiKey: "lv_live_test", fetch });
  const reading = await sdk.sage("refund").choose("pick", { approve: "Sign", revise: "Redline" });
  const value = await sdk.sageAnswer("appeal").choose("pick", { approve: "Sign", revise: "Redline" });
  assert.equal(reading.value, "approve");
  assert.equal(reading.confidence, 0.8);
  assert.equal(value, reading.value);
  assert.equal(isRecord(bodies[0]) && bodies[0].content, "refund");
  assert.equal(isRecord(bodies[1]) && bodies[1].content, "appeal");
});

test("SageSDK on a SageApi matches Sage", async () => {
  const api = new SageApi({ stub: true });
  const sdk = new SageSDK(api);
  const reading = await sdk.sage("contract").choose("pick", { approve: "Sign", revise: "Redline" });
  const direct = await new Sage("contract", api).choose("pick", { approve: "Sign", revise: "Redline" });
  const value = await sdk.sageAnswer("contract").choose("pick", { approve: "Sign", revise: "Redline" });
  assert.deepEqual(reading, direct);
  assert.equal(value, reading.value);

  const shot = await new SageSDK({ stub: true })
    .sage({ kind: "image", media: "data:image/png;base64,AAAA" })
    .tag("labels", { bug: "defect" });
  assert.equal(typeof shot.value.bug, "boolean");
});

test("numeric record keys become string IDs in choices, tags, and sort", async () => {
  const sage = new Sage("doc", { stub: true });
  const choice = await sage.choose("pick", { 0: "zero", 1: "one" });
  assert.deepEqual(choice.probabilities.map((row) => row.option), ["0", "1"]);
  assert.ok(choice.value === null || ["0", "1"].includes(choice.value));
  const tags = await sage.tag("tag", { 0: "zero", 1: "one" });
  assert.deepEqual(Object.keys(tags.value), ["0", "1"]);
  assert.deepEqual(Object.keys(tags.confidence), ["0", "1"]);
  const sorted = await sage.sort("rank", [{ 0: "zero" }, { 1: "one" }]);
  assert.deepEqual([...sorted.value].sort((a, b) => a.id.localeCompare(b.id)), [
    { id: "0", content: "zero" },
    { id: "1", content: "one" },
  ]);
});
