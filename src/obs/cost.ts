/**
 * Token-cost accounting.
 *
 * The price table is intentionally a small built-in map of common models.
 * It's a best-effort approximation; production deployments should override
 * via KOAN_MODEL_PRICES (JSON-encoded) when they care about exact billing.
 *
 * Prices are USD per million tokens. The 0-fallback returns null so the
 * caller can render "(unknown)" instead of suggesting a phony number.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  promptUsdPerMTok: number;
  /** USD per 1M output tokens. */
  completionUsdPerMTok: number;
}

const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI (approx, public list pricing — verify before production).
  'gpt-4o':            { promptUsdPerMTok: 2.5,  completionUsdPerMTok: 10 },
  'gpt-4o-mini':       { promptUsdPerMTok: 0.15, completionUsdPerMTok: 0.6 },
  'gpt-4-turbo':       { promptUsdPerMTok: 10,   completionUsdPerMTok: 30 },
  'gpt-3.5-turbo':     { promptUsdPerMTok: 0.5,  completionUsdPerMTok: 1.5 },
  // Anthropic Claude family.
  'claude-opus-4-7':       { promptUsdPerMTok: 15, completionUsdPerMTok: 75 },
  'claude-opus-4-8':       { promptUsdPerMTok: 15, completionUsdPerMTok: 75 },
  'claude-sonnet-4-6':     { promptUsdPerMTok: 3,  completionUsdPerMTok: 15 },
  'claude-haiku-4-5':      { promptUsdPerMTok: 1,  completionUsdPerMTok: 5 },
};

let overrideTable: Record<string, ModelPrice> | null = null;

export function loadPriceOverrides(): void {
  const raw = process.env.KOAN_MODEL_PRICES;
  if (!raw) { overrideTable = null; return; }
  try { overrideTable = JSON.parse(raw); }
  catch { overrideTable = null; /* silently ignore — logged elsewhere */ }
}

function pricesFor(model: string): ModelPrice | null {
  if (overrideTable && model in overrideTable) return overrideTable[model];
  if (model in DEFAULT_PRICES) return DEFAULT_PRICES[model];
  // Suffix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o").
  for (const key of Object.keys(overrideTable ?? DEFAULT_PRICES)) {
    if (model.startsWith(key)) return (overrideTable ?? DEFAULT_PRICES)[key];
  }
  return null;
}

/**
 * Compute the USD cost of a (model, promptTokens, completionTokens) triple.
 * Returns null when the model isn't in the table — callers should render
 * "(unknown)" rather than guess.
 */
export function costFor(model: string, promptTokens: number, completionTokens: number): number | null {
  const p = pricesFor(model);
  if (!p) return null;
  return (promptTokens / 1_000_000) * p.promptUsdPerMTok
       + (completionTokens / 1_000_000) * p.completionUsdPerMTok;
}

/** Format a USD cost for display. */
export function formatCost(usd: number | null): string {
  if (usd === null) return '(unknown)';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// initialise once at module load
loadPriceOverrides();
