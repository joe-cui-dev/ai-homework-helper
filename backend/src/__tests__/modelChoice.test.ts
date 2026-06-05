import {
  computeCostUsdForModelChoice,
  normaliseModelChoice,
  parseOptionalModelChoice,
  resolveBedrockModel,
} from "../shared/modelChoice";

describe("modelChoice", () => {
  it("defaults missing legacy values to fast", () => {
    expect(normaliseModelChoice(undefined)).toBe("fast");
    expect(normaliseModelChoice(null)).toBe("fast");
    expect(normaliseModelChoice("advanced")).toBe("advanced");
    expect(normaliseModelChoice("unknown")).toBe("fast");
  });

  it("rejects invalid explicit request values", () => {
    expect(parseOptionalModelChoice(undefined)).toBe("fast");
    expect(parseOptionalModelChoice("advanced")).toBe("advanced");
    expect(() => parseOptionalModelChoice("sonnet")).toThrow(
      'modelChoice must be "fast" or "advanced"',
    );
  });

  it("resolves public choices to backend-owned Bedrock registry entries", () => {
    expect(resolveBedrockModel("fast")).toMatchObject({
      choice: "fast",
      label: "Fast",
      modelId: "au.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(resolveBedrockModel("advanced")).toMatchObject({
      choice: "advanced",
      label: "Advanced",
      modelId: "au.anthropic.claude-sonnet-4-6",
    });
  });

  it("computes cost from the selected model registry entry", () => {
    expect(computeCostUsdForModelChoice(1_000_000, 1_000_000, "fast")).toBe(6);
    expect(computeCostUsdForModelChoice(1_000_000, 1_000_000, "advanced")).toBe(18);
  });
});
