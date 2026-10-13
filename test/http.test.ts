import assert from "node:assert/strict";
import { test } from "node:test";
import { SageApi, SageError } from "../src/index.ts";
import type { Content, Question } from "../src/index.ts";

const request = {
  content: "hello",
  question: { kind: "yesno" as const, id: "q", instructions: "yes?" },
};

function yesNoResponse(answer: "yes" | "no" | null = "yes") {
  return {
    id: "q",
    kind: "yesno",
    result: { answer, probability: answer === null ? 0.5 : 0.91 },
    meta: {
      model: "levanto-sage-v1.4",
      reasoning: { fired: false, ran: false, finished: null, tokens: null },
    },
  };
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("sends the bearer key and parses a decision", async () => {
  let auth = "";
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: (_input, init) => {
      const headers = new Headers(init?.headers);
      auth = headers.get("authorization") ?? "";
      return Promise.resolve(jsonResponse(200, yesNoResponse()));
    },
  });
  const decision = await sage.decide(request);
  assert.equal(auth, "Bearer lv_live_test");
  assert.equal(decision.result.answer, "yes");
  assert.equal(decision.meta.model, "levanto-sage-v1.4");
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function env(): Record<string, unknown> {
  const scope: unknown = globalThis;
  if (!isRecord(scope) || !isRecord(scope.process) || !isRecord(scope.process.env)) {
    throw new Error("process.env is required for this test");
  }
  return scope.process.env;
}

test("falls back to SAGE_API_KEY", async () => {
  const previous = env().SAGE_API_KEY;
  env().SAGE_API_KEY = "lv_live_env";
  try {
    let auth = "";
    const sage = new SageApi({
      fetch: (_input, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return Promise.resolve(jsonResponse(200, yesNoResponse("no")));
      },
    });
    const decision = await sage.decide(request);
    assert.equal(auth, "Bearer lv_live_env");
    assert.equal(decision.result.answer, "no");
  } finally {
    if (previous === undefined) delete env().SAGE_API_KEY;
    else env().SAGE_API_KEY = previous;
  }
});

test("402 is not retried", async () => {
  let calls = 0;
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        jsonResponse(402, { detail: "This period's included usage is used up." }),
      );
    },
  });
  await assert.rejects(
    () => sage.decide(request),
    (error: unknown) =>
      error instanceof SageError && error.kind === "http" && error.status === 402 && /usage/.test(error.detail),
  );
  assert.equal(calls, 1);
});

test("503 retries once", async () => {
  let calls = 0;
  const sage = new SageApi({
    apiKey: "lv_live_test",
    timeoutMs: 5_000,
    fetch: () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse(503, { detail: "Service is still loading." }, { "retry-after": "0" }));
      return Promise.resolve(jsonResponse(200, yesNoResponse()));
    },
  });
  const decision = await sage.decide(request);
  assert.equal(decision.result.answer, "yes");
  assert.equal(calls, 2);
});

test("a non-JSON error is the body snippet", async () => {
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: () => Promise.resolve(new Response("<html>gateway</html>", { status: 502 })),
  });
  await assert.rejects(
    () => sage.decide(request),
    (error: unknown) => error instanceof SageError && error.kind === "http" && error.status === 502 && error.detail.includes("gateway"),
  );
});

test("a 200 that is not the decision is a protocol error", async () => {
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: () =>
      Promise.resolve(
        jsonResponse(200, {
          id: "other",
          kind: "yesno",
          result: { answer: "yes", probability: 1 },
          meta: { model: "levanto-sage-v1.4" },
        }),
      ),
  });
  await assert.rejects(
    () => sage.decide(request),
    (error: unknown) => error instanceof SageError && error.kind === "protocol",
  );
});

test("choice membership is checked", async () => {
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: () =>
      Promise.resolve(
        jsonResponse(200, {
          id: "d",
          kind: "choice",
          result: {
            chosen: "nope",
            probability: 0.9,
            probabilities: [
              { option: "approve", probability: 0.1 },
              { option: "revise", probability: 0.9 },
            ],
          },
          meta: { model: "levanto-sage-v1.4" },
        }),
      ),
  });
  await assert.rejects(
    () =>
      sage.decide({
        content: "c",
        question: {
          kind: "choice",
          id: "d",
          instructions: "pick",
          options: [{ option: "approve" }, { option: "revise" }],
        },
      }),
    (error: unknown) => error instanceof SageError && error.kind === "protocol" && /nope/.test(error.detail),
  );
});

test("batch keeps a failed sibling", async () => {
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: () =>
      Promise.resolve(
        jsonResponse(200, {
          results: [
            {
              answers: [
                { ok: true, error: null, result: yesNoResponse() },
                { ok: false, error: "level clash", result: null },
              ],
            },
          ],
          meta: { model: "levanto-sage-v1.4", request_count: 1, question_count: 2 },
        }),
      ),
  });
  const batched = await sage.batch({
    requests: [
      {
        content: "doc",
        questions: [
          { kind: "yesno", id: "q", instructions: "yes?" },
          {
            kind: "scale",
            id: "s",
            instructions: "score",
            levels: [
              { level: 0, description: "low" },
              { level: 1, description: "high" },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(batched.results[0].answers[0].ok, true);
  const failed = batched.results[0].answers[1];
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error, "level clash");
});

test("ready does not send the key", async () => {
  let auth: string | null = "unset";
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: (input, init) => {
      auth = new Headers(init?.headers).get("authorization");
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      assert.ok(url.endsWith("/ready"));
      return Promise.resolve(new Response("", { status: 503 }));
    },
  });
  assert.equal(await sage.ready(), false);
  assert.equal(auth, null);
});

test("missing key throws before fetch", () => {
  const previous = env().SAGE_API_KEY;
  delete env().SAGE_API_KEY;
  try {
    assert.throws(() => new SageApi({}), (error: unknown) => error instanceof SageError && error.kind === "invalid");
  } finally {
    if (previous !== undefined) env().SAGE_API_KEY = previous;
  }
});

test("an aborted call does not become a decision", async () => {
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: (_input, init) => {
      if (init?.signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      return Promise.resolve(jsonResponse(200, yesNoResponse()));
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => sage.decide(request, { signal: controller.signal }),
    (error: unknown) => error instanceof SageError && error.kind === "timeout",
  );
});

test("response body failures are SageErrors on POST and ready", async () => {
  for (const ready of [false, true]) {
    for (const name of ["TypeError", "AbortError", "TimeoutError"]) {
      const sage = new SageApi({
        apiKey: "lv_live_test",
        fetch: async () => new Response(new ReadableStream({
          start(controller) {
            const error = new Error("body failed");
            error.name = name;
            controller.error(error);
          },
        }), { status: ready ? 502 : 200 }),
      });
      await assert.rejects(
        () => ready ? sage.ready() : sage.decide(request),
        (error: unknown) => error instanceof SageError &&
          error.kind === (name === "TypeError" ? "network" : "timeout"),
      );
    }
  }
});

test("the deadline covers reading a response body", async () => {
  const sage = new SageApi({
    apiKey: "lv_live_test",
    timeoutMs: 10,
    fetch: async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    })),
  });
  // AbortSignal.timeout does not keep Node alive by itself.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      () => sage.decide(request),
      (error: unknown) => error instanceof SageError && error.kind === "timeout",
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("503 response cancellation failures are SageErrors", async () => {
  let calls = 0;
  const sage = new SageApi({
    apiKey: "lv_live_test",
    fetch: async () => {
      calls += 1;
      return new Response(new ReadableStream({
        cancel() { throw new TypeError("cancel failed"); },
      }), { status: 503 });
    },
  });
  await assert.rejects(
    () => sage.decide(request),
    (error: unknown) => error instanceof SageError && error.kind === "network",
  );
  assert.equal(calls, 1);
});

test("timeoutMs rejects values outside the supported timer range", () => {
  for (const timeoutMs of [0.5, 0, -1, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => new SageApi({ apiKey: "lv_live_test", timeoutMs }),
      (error: unknown) => error instanceof SageError && error.kind === "invalid",
    );
  }
  for (const timeoutMs of [1, 30_000, 2_147_483_647]) {
    assert.doesNotThrow(() => new SageApi({ apiKey: "lv_live_test", timeoutMs }));
  }
});

test("request mutations cannot change parsing or retry bodies", async () => {
  for (const retry of [false, true]) {
    for (const mode of ["decide", "batch", "estimate"] as const) {
      const question = {
        kind: "choice" as const, id: "original", instructions: "pick",
        options: [{ option: "left" }, { option: "right" }],
      };
      const single = { content: "original", question };
      const batch = { requests: [{ content: "original", questions: [question] }] };
      const bodies: string[] = [];
      const decision = {
        id: "original", kind: "choice", meta: {},
        result: {
          chosen: "left", probability: 0.8,
          probabilities: [{ option: "left", probability: 0.8 }, { option: "right", probability: 0.2 }],
        },
      };
      const response = mode === "decide" ? decision : mode === "batch" ? {
        results: [{ answers: [{ ok: true, result: decision, error: null }] }],
        meta: { request_count: 1, question_count: 1 },
      } : { usage: { min_input_tokens: 1, max_input_tokens: 1, exact: true } };
      const sage = new SageApi({
        apiKey: "test",
        fetch: async (_input, init) => {
          assert.equal(typeof init?.body, "string");
          bodies.push(init.body as string);
          if (retry && bodies.length === 1) return new Response(null, { status: 503, headers: { "retry-after": "0" } });
          return jsonResponse(200, response);
        },
      });
      const expectedBody = JSON.stringify(mode === "batch" ? batch : single);
      const pending = mode === "decide" ? sage.decide(single) : mode === "batch" ? sage.batch(batch) : sage.estimate(single);
      single.content = "modified";
      question.id = "modified";
      question.options[0]!.option = "modified";
      batch.requests[0]!.content = "modified";
      batch.requests[0]!.questions.push({ ...question, id: "extra" });
      const result = await pending;
      assert.deepEqual(bodies, Array(retry ? 2 : 1).fill(expectedBody));
      if ("id" in result) assert.equal(result.id, "original");
      if ("results" in result) {
        const answer = result.results[0]!.answers[0]!;
        assert.equal(answer.ok, true);
        if (answer.ok) assert.equal(answer.result.id, "original");
      }
    }
  }
});

test("probabilities and confidences reject out-of-range values and accept endpoints", async () => {
  const cases: {
    content: Content;
    question: Question;
    result: Record<string, unknown>;
    paths: (string | number)[][];
  }[] = [
    {
      content: "doc", question: { kind: "yesno", id: "q", instructions: "q" },
      result: { answer: "no", probability: 0.5 }, paths: [["probability"]],
    },
    {
      content: "doc", question: { kind: "choice", id: "q", instructions: "q", options: [{ option: "a" }, { option: "b" }] },
      result: { chosen: "a", probability: 0.5, probabilities: [{ option: "a", probability: 0.5 }, { option: "b", probability: 0.5 }] },
      paths: [["probability"], ["probabilities", 0, "probability"]],
    },
    {
      content: "doc", question: { kind: "scale", id: "q", instructions: "q", levels: [{ level: 0 }, { level: 10 }] },
      result: { expectation: 5, confidence: 0.5, probabilities: [{ level: 0, probability: 0.5 }, { level: 10, probability: 0.5 }] },
      paths: [["confidence"], ["probabilities", 0, "probability"]],
    },
    {
      content: { kind: "list", value: [{ id: "a", content: "a" }, { id: "b", content: "b" }] },
      question: { kind: "sort", id: "q", instructions: "q" },
      result: { sorted: ["a", "b"], confidence: 0.5 }, paths: [["confidence"]],
    },
    {
      content: "doc", question: { kind: "tags", id: "q", tags: [{ id: "a" }] },
      result: { tags: [{ id: "a", probability: 0.5, applies: true }] }, paths: [["tags", 0, "probability"]],
    },
  ];
  for (const fixture of cases) {
    for (const path of fixture.paths) {
      for (const value of [-0.1, 1.1, 0, 1]) {
        const result = structuredClone(fixture.result);
        let target: unknown = result;
        for (const key of path.slice(0, -1)) {
          assert.ok(typeof target === "object" && target !== null);
          target = Reflect.get(target, key);
        }
        assert.ok(typeof target === "object" && target !== null);
        const field = path.at(-1);
        assert.notEqual(field, undefined);
        Reflect.set(target, field!, value);
        const sage = new SageApi({ apiKey: "test", fetch: async () => jsonResponse(200, {
          id: "q", kind: fixture.question.kind, meta: {}, result,
        }) });
        const pending = sage.decide({ content: fixture.content, question: fixture.question });
        if (value < 0 || value > 1) {
          await assert.rejects(pending, (error: unknown) => error instanceof SageError && error.kind === "protocol");
        } else {
          await pending;
        }
      }
    }
  }
  const sage = new SageApi({ apiKey: "test", fetch: async () => jsonResponse(200, {
    id: "q", kind: "sort", meta: {}, result: { sorted: ["a", "b"], confidence: null },
  }) });
  const sorted = await sage.decide({
    content: { kind: "list", value: [{ id: "a", content: "a" }, { id: "b", content: "b" }] },
    question: { kind: "sort", id: "q", instructions: "q" },
  });
  assert.equal(sorted.result.confidence, null);
});
