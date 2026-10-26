import type { ModelRef } from "./types.ts";

export type BudgetTier = "cheaper" | "medium" | "expensive";

export interface ModelPolicyEntry {
  model: ModelRef;
  retry: number;
  budget: BudgetTier;
}

const tiers: BudgetTier[] = ["cheaper", "medium", "expensive"];

export function validateModelPolicy(value: unknown): ModelPolicyEntry[] {
  if (!Array.isArray(value)) throw new Error("models must be an array");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`models[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    if (typeof item.model !== "string" || !/^\S+\/\S+(?:#\S+)?$/.test(item.model)) {
      throw new Error(`models[${index}].model must be provider/model`);
    }
    if (seen.has(item.model)) throw new Error(`duplicate model ${item.model}`);
    seen.add(item.model);
    if (!Number.isInteger(item.retry) || (item.retry as number) < 1) {
      throw new Error(`models[${index}].retry must be a positive integer`);
    }
    if (!tiers.includes(item.budget as BudgetTier)) {
      throw new Error(`models[${index}].budget must be cheaper, medium, or expensive`);
    }
    return { model: item.model, retry: item.retry as number, budget: item.budget as BudgetTier };
  });
}

export function selectPolicyEntry(
  entries: ModelPolicyEntry[],
  preferred: BudgetTier,
  attemptsByModel: Record<string, number> | number,
): ModelPolicyEntry | undefined {
  const preferredIndex = tiers.indexOf(preferred);
  const ordered = tiers.slice(preferredIndex).concat(tiers.slice(0, preferredIndex));
  const attemptsFor = (entry: ModelPolicyEntry) => typeof attemptsByModel === "number"
    ? attemptsByModel
    : attemptsByModel[entry.model] ?? 0;
  const preferredEntry = entries.find((entry) => entry.budget === preferred);
  if (preferredEntry && attemptsFor(preferredEntry) >= preferredEntry.retry) {
    const nextTier = tiers.slice(preferredIndex + 1)
      .find((tier) => entries.some((entry) => entry.budget === tier && attemptsFor(entry) < entry.retry));
    if (nextTier) return entries.find((entry) => entry.budget === nextTier && attemptsFor(entry) < entry.retry);
  }
  for (const tier of ordered) {
    const entry = entries.find((candidate) => candidate.budget === tier &&
      attemptsFor(candidate) < candidate.retry);
    if (entry) return entry;
  }
  return undefined;
}

export function classifyComplexity(output: string): "simple" | "medium" | "complex" | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = output.indexOf("{");
  const end = output.indexOf("}", start + 1);
  const candidate = fenced ?? (start >= 0 && end > start ? output.slice(start, end + 1) : output);
  try {
    const value: unknown = JSON.parse(candidate);
    if (typeof value !== "object" || value === null) return undefined;
    const complexity = (value as Record<string, unknown>).complexity;
    return complexity === "simple" || complexity === "medium" || complexity === "complex" ? complexity : undefined;
  } catch {
    return undefined;
  }
}

export function complexityTier(complexity: "simple" | "medium" | "complex"): BudgetTier {
  return complexity === "simple" ? "cheaper" : "medium";
}

export function nextTier(entries: ModelPolicyEntry[], current: BudgetTier): BudgetTier | undefined {
  const tiers: BudgetTier[] = ["cheaper", "medium", "expensive"];
  return tiers.slice(tiers.indexOf(current) + 1)
    .find((tier) => entries.some((entry) => entry.budget === tier));
}
