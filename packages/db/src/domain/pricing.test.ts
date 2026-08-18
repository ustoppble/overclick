import { describe, expect, it } from "vitest";
import {
  areSegmentsPriced,
  assessAttemptCost,
  computeCostUsd,
  factoryModelPrices,
  findModelPrice,
  mergeCostSources,
  MODEL_PRICES_FAMILIES_SEEDED_AT,
  MODEL_PRICES_SEEDED_AT,
  normalizeModelKey,
  resolveAttemptCost,
  resolveSegmentedCost,
  type ModelPrice,
} from "./pricing";

const PRICES: ModelPrice[] = [
  { model: "opus-5", label: "opus-5", inputPerMtok: 5, outputPerMtok: 25, cachePerMtok: 0.5 },
  { model: "haiku-4-5", label: "haiku-4-5", inputPerMtok: 1, outputPerMtok: 5, cachePerMtok: 0.1 },
];

describe("model key normalization", () => {
  it("maps the binary name an agent sends to the catalog key", () => {
    expect(normalizeModelKey("claude-opus-5")).toBe("opus-5");
    expect(normalizeModelKey("  Claude-Opus-5 ")).toBe("opus-5");
  });

  it("drops vendor prefixes and dated snapshots", () => {
    expect(normalizeModelKey("anthropic/claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  it("treats dots and dashes as the same separator", () => {
    expect(normalizeModelKey("haiku-4.5")).toBe("haiku-4-5");
  });

  it("leaves an unknown model as its own key", () => {
    expect(normalizeModelKey("gpt-5.6-sol")).toBe("gpt-5-6-sol");
  });

  it("keeps CLI aliases on the same canonical price key", () => {
    expect(normalizeModelKey("gpt-5.3-codex-spark")).toBe(
      "gpt-5-3-codex-spark",
    );
    expect(normalizeModelKey("kimi-code/k3")).toBe("k3");
    expect(normalizeModelKey("kimi")).toBe("k3");
    expect(normalizeModelKey("claude-fable-5")).toBe("fable-5");
    expect(normalizeModelKey("gpt-5-codex")).toBe("gpt-5-3-codex-spark");
  });
});

describe("price lookup", () => {
  it("finds a price through any spelling", () => {
    expect(findModelPrice(PRICES, "claude-opus-5")?.model).toBe("opus-5");
    expect(findModelPrice(PRICES, "OPUS-5")?.model).toBe("opus-5");
  });

  it("returns null for an unpriced model instead of guessing", () => {
    expect(findModelPrice(PRICES, "kimi-for-coding")).toBeNull();
    expect(findModelPrice(PRICES, null)).toBeNull();
  });
});

describe("cost arithmetic", () => {
  it("prices input, output and cache per million tokens", () => {
    const price = PRICES[0]!;
    expect(
      computeCostUsd(price, { input: 1_000_000, output: 1_000_000, cache: 1_000_000 }),
    ).toBe(30.5);
  });

  it("rounds to the precision the column stores", () => {
    expect(computeCostUsd(PRICES[1]!, { input: 1 })).toBe(0.000001);
  });
});

describe("stored cost assessment", () => {
  it("normalizes Spark, computes the acceptance-case cost and snapshots the breakdown", () => {
    const result = assessAttemptCost(
      [{ model: "gpt-5.3-codex-spark", input: 100_000, output: 20_000 }],
      factoryModelPrices(),
      { tokensReported: true },
    );
    expect(result).toMatchObject({
      costUsd: 0.455,
      source: "computed",
      status: "computed",
      unpricedModels: [],
    });
    expect(result.normalizedSegments[0]?.model).toBe("gpt-5-3-codex-spark");
    expect(result.breakdown[0]).toMatchObject({
      model: "gpt-5-3-codex-spark",
      cost_usd: 0.455,
      priced: true,
    });
  });

  it("stores the missing model instead of turning an unknown cost into zero", () => {
    const result = assessAttemptCost(
      [{ model: "future-model", input: 10_000 }],
      factoryModelPrices(),
      { tokensReported: true },
    );
    expect(result).toMatchObject({
      costUsd: null,
      source: null,
      status: "unpriced",
      unpricedModels: ["future-model"],
    });
  });

  it("distinguishes absent counters, explicit zero and a genuine free tier", () => {
    expect(
      assessAttemptCost([], factoryModelPrices(), { tokensReported: false }).status,
    ).toBe("not_reported");
    expect(
      assessAttemptCost(
        [{ model: "gpt-5.6-sol", input: 0, output: 0 }],
        factoryModelPrices(),
        { tokensReported: true },
      ).status,
    ).toBe("zero_usage");
    expect(
      assessAttemptCost(
        [{ model: "mimo-v2.5-free", input: 1000 }],
        factoryModelPrices(),
        { tokensReported: true },
      ),
    ).toMatchObject({ costUsd: 0, source: "computed", status: "computed" });
  });
});

describe("cost source ladder", () => {
  it("computes from tokens and labels it computed, ignoring the agent's number", () => {
    const resolved = resolveAttemptCost(
      { tokensIn: 200_000, tokensOut: 20_000, costUsd: 99 },
      PRICES,
      "claude-opus-5",
    );
    expect(resolved).toEqual({ costUsd: 1.5, source: "computed" });
  });

  it("falls back to the reported cost when the model has no price", () => {
    const resolved = resolveAttemptCost(
      { tokensIn: 1000, costUsd: 0.42 },
      PRICES,
      "kimi-for-coding",
    );
    expect(resolved).toEqual({ costUsd: 0.42, source: "reported" });
  });

  it("labels a reported cost the executor guessed as estimated", () => {
    const resolved = resolveAttemptCost(
      { costUsd: 0.42, usageEstimated: true },
      PRICES,
      "kimi-for-coding",
    );
    expect(resolved).toEqual({ costUsd: 0.42, source: "estimated" });
  });

  it("says nothing when there are neither tokens nor a cost", () => {
    expect(resolveAttemptCost({}, PRICES, "claude-opus-5")).toEqual({
      costUsd: null,
      source: null,
    });
  });

  it("names mixed provenance instead of picking the nicest label", () => {
    expect(mergeCostSources(["computed", "computed"])).toBe("computed");
    expect(mergeCostSources(["computed", "reported"])).toBe("mixed");
    expect(mergeCostSources([null, null])).toBeNull();
  });
});

describe("seeded price list", () => {
  it("stamps every row with the date its prices were captured", () => {
    const rows = factoryModelPrices();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe("seed");
      // A date per row, not one date for the table: a family added later is
      // a week younger, and the stamp has to be able to say so.
      expect(row.seededAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.model).toBe(normalizeModelKey(row.model));
      expect(row.inputPerMtok).toBeGreaterThanOrEqual(0);
      expect(row.outputPerMtok).toBeGreaterThanOrEqual(0);
    }
    expect(rows.some((row) => row.seededAt === MODEL_PRICES_SEEDED_AT)).toBe(true);
    expect(
      rows.some((row) => row.seededAt === MODEL_PRICES_FAMILIES_SEEDED_AT),
    ).toBe(true);
  });

  it("covers the model families the CLI catalog actually offers", () => {
    const rows = factoryModelPrices();
    const priced = (model: string) => findModelPrice(rows, model) != null;
    // The names agents really send, spelled the way they send them.
    for (const model of [
      "claude-opus-5",
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "gpt-5.4-mini",
      "3.1-pro",
      "3.5-flash",
      "kimi-code/k3",
      "kimi-for-coding",
      "grok-4.6",
      "grok-composer-2.5-fast",
    ]) {
      expect(priced(model), `${model} has no price`).toBe(true);
    }
  });

  it("leaves a model with no published rate unpriced instead of guessing", () => {
    const rows = factoryModelPrices();
    // Subscription plans do not publish a per-million rate. A zero here would
    // read as free work, so the row simply is not there.
    expect(findModelPrice(rows, "auto")).toBeNull();
    expect(findModelPrice(rows, "muse-spark-1.2")).toBeNull();
  });

  it("adds GPT-5.3-Codex-Spark once it gets a published rate", () => {
    const rows = factoryModelPrices();
    expect(findModelPrice(rows, "gpt-5-3-codex-spark")).not.toBeNull();
  });

  it("prices a free tier at zero, which is a price and not a missing one", () => {
    const rows = factoryModelPrices();
    const free = findModelPrice(rows, "mimo-v2.5-free");
    expect(free).not.toBeNull();
    expect(free?.outputPerMtok).toBe(0);
  });
});

describe("cost of a run recorded in segments", () => {
  const prices = [
    { model: "sonnet-5", label: "sonnet-5", inputPerMtok: 3, outputPerMtok: 15, cachePerMtok: 0.3 },
    { model: "opus-5", label: "opus-5", inputPerMtok: 5, outputPerMtok: 25, cachePerMtok: 0.5 },
  ];

  it("prices every model at its own rate instead of the run at one", () => {
    const cost = resolveSegmentedCost(
      [
        { model: "sonnet-5", input: 1_000_000 },
        { model: "opus-5", input: 1_000_000 },
      ],
      prices,
      { costUsd: 99 },
    );
    expect(cost.costUsd).toBeCloseTo(8);
    expect(cost.source).toBe("computed");
  });

  it("falls back to the agent's figure when one model has no price", () => {
    const cost = resolveSegmentedCost(
      [
        { model: "sonnet-5", input: 1_000_000 },
        { model: "kimi-for-coding", input: 1_000_000 },
      ],
      prices,
      { costUsd: 2.5, usageEstimated: true },
    );
    expect(cost.costUsd).toBeCloseTo(2.5);
    expect(cost.source).toBe("estimated");
  });

  it("says nothing when there is neither a price nor a reported figure", () => {
    const cost = resolveSegmentedCost(
      [{ model: "kimi-for-coding", input: 10 }],
      prices,
      {},
    );
    expect(cost.costUsd).toBeNull();
    expect(cost.source).toBeNull();
  });

  it("counts a run priced end to end as priced", () => {
    expect(
      areSegmentsPriced([{ model: "opus-5", input: 10 }], prices),
    ).toBe(true);
    expect(
      areSegmentsPriced([{ model: "kimi-for-coding", input: 10 }], prices),
    ).toBe(false);
    // No tokens anywhere: nothing to price, so nothing to claim as priced.
    expect(areSegmentsPriced([{ model: "opus-5" }], prices)).toBe(false);
  });
});
