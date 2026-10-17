/**
 * The model an upstream reports, versus the one we asked for.
 *
 * These are different facts and the codebase keeps them apart on purpose.
 * `requested_model` is what the client asked for; `reported_model` is what the
 * provider said it ran. A provider that answers a `muse-spark` request as
 * `deepseek-v4.1-flash` is telling the operator something the request cannot,
 * and filling in the ask where the response carried none would report the ask
 * as if it were the answer.
 *
 * The value is taken **verbatim**: no prefix stripping, no normalisation, no
 * comparison. An earlier draft stripped the provider prefix and hid the chip
 * when the stripped names matched — which suppressed exactly the case worth
 * seeing (`dine-free/muse-spark-1.3` answering `muse-spark-1.3`).
 */
import { describe, expect, test } from "bun:test";
import { extractReportedModel } from "../../src/providers/discovery/probe-phases";
import { reportedModelFrom } from "../../src/transport/dispatch/upstream";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";

function start(model?: string): CanonicalEvent[] {
  return [
    {
      type: "response_start",
      sequence_number: 1,
      ...(model === undefined ? {} : { model }),
    },
  ];
}

describe("reported model extraction", () => {
  test("the probe takes the id verbatim, prefix included", () => {
    expect(extractReportedModel(start("dine-free/muse-spark-1.3-contributor"))).toBe(
      "dine-free/muse-spark-1.3-contributor",
    );
  });

  test("the dispatch path reads the same field", () => {
    expect(reportedModelFrom(start("bansos/glm-5.3-flash"))).toBe("bansos/glm-5.3-flash");
  });

  test("an unqualified id is returned unchanged", () => {
    expect(extractReportedModel(start("deepseek-v4.1-flash"))).toBe("deepseek-v4.1-flash");
  });

  test("a response that names no model yields nothing, not the requested id", () => {
    // The caller must not backfill: absent means the upstream said nothing.
    expect(extractReportedModel(start())).toBeUndefined();
    expect(reportedModelFrom(start())).toBeUndefined();
  });

  test("a blank model is treated as absent", () => {
    expect(extractReportedModel(start("   "))).toBeUndefined();
  });

  test("message_start carries it too, for providers on that wire", () => {
    const events: CanonicalEvent[] = [
      { type: "message_start", sequence_number: 1, model: "claude-sonnet-4" },
    ];
    expect(reportedModelFrom(events)).toBe("claude-sonnet-4");
  });

  test("a stream that opens with content still reports the opening model", () => {
    const events: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 1, model: "glm-5.3-flash" },
      { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "hi" } },
    ];
    expect(reportedModelFrom(events)).toBe("glm-5.3-flash");
  });
});
