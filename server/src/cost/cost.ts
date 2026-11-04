import type { CostSummary, ModelInfo } from '@capyagents/shared';
import type { Db } from '../db/database.js';
import { kvGet, kvSet, usageTotals } from '../db/database.js';

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Custo estimado do turno.
 *
 * Quando o SDK informa o próprio custo (`total_cost_usd` do resultado), ele
 * vence: é calculado por quem fez as chamadas e já considera cache, modelo e
 * descontos. A tabela de config/models.json é só o plano B, para quando esse
 * campo não vier.
 *
 * Em qualquer caso o número é uma ESTIMATIVA de quanto isso custaria pela API.
 * Com assinatura (login do CLI) não há cobrança por token — serve para medir
 * consumo e comparar agentes, não como fatura.
 */
export function computeCost(
  model: ModelInfo | undefined,
  usage: UsageLike,
  sdkCostUsd?: number,
): {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
} {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  // tokens "frescos": o cache relido não é trabalho novo e inflava o número
  const tokensIn = usage.input_tokens + cacheWrite;
  const tokensOut = usage.output_tokens;

  if (typeof sdkCostUsd === 'number' && sdkCostUsd >= 0) {
    return { tokensIn, tokensOut, costUsd: sdkCostUsd };
  }
  if (!model) return { tokensIn, tokensOut, costUsd: 0 };
  const inUsd =
    ((usage.input_tokens + 1.25 * cacheWrite + 0.1 * cacheRead) / 1_000_000) * model.inputPerMtok;
  const outUsd = (tokensOut / 1_000_000) * model.outputPerMtok;
  return { tokensIn, tokensOut, costUsd: inUsd + outUsd };
}

export class CostTracker {
  constructor(
    private db: Db,
    private defaultBudget: number | null,
  ) {}

  get budgetUsd(): number | null {
    const stored = kvGet(this.db, 'budget_usd');
    if (stored !== null) return stored === '' ? null : Number(stored);
    return this.defaultBudget;
  }

  setBudget(value: number | null): void {
    kvSet(this.db, 'budget_usd', value === null ? '' : String(value));
  }

  summary(): CostSummary {
    const totals = usageTotals(this.db);
    const budget = this.budgetUsd;
    return {
      totalUsd: totals.totalUsd,
      budgetUsd: budget,
      budgetExceeded: budget !== null && totals.totalUsd >= budget,
      byInstance: totals.byInstance,
      byPipeline: totals.byPipeline,
    };
  }

  exceeded(): boolean {
    const budget = this.budgetUsd;
    if (budget === null) return false;
    return usageTotals(this.db).totalUsd >= budget;
  }
}
