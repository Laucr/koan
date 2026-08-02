/**
 * Tiny in-process metrics registry — Prometheus text format on demand.
 *
 * We don't pull `prom-client`; the framework only needs four metric
 * families and the text-format encoder is ~30 lines.
 *
 * Metrics surfaced:
 *   koan_rounds_total{profile,model}                counter
 *   koan_tool_calls_total{tool,outcome}             counter (outcome: ok|error|denied)
 *   koan_tokens_total{kind,model}                   counter (kind: prompt|completion)
 *   koan_round_duration_seconds{profile,model}      histogram (default buckets)
 *   koan_active_sessions                            gauge
 *   koan_http_requests_total{method,path,status}    counter
 *   koan_http_request_duration_seconds{method,path} histogram
 *   koan_cost_usd_total{model}                      counter
 *
 * Labels with arbitrary user data (path, profile names) are bounded by the
 * caller — the path passed in should be the route pattern (`/v1/sessions/:id`)
 * not the concrete path, to keep cardinality finite.
 */

type LabelMap = Record<string, string | number>;

interface CounterEntry {
  labels: LabelMap;
  value: number;
}

interface GaugeEntry {
  labels: LabelMap;
  value: number;
}

interface HistogramEntry {
  labels: LabelMap;
  buckets: Map<number, number>; // bucket upper bound → count
  sum: number;
  count: number;
}

const DEFAULT_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

export class MetricsRegistry {
  private counters = new Map<string, { help: string; entries: CounterEntry[] }>();
  private gauges = new Map<string, { help: string; entries: GaugeEntry[] }>();
  private histograms = new Map<string, { help: string; buckets: number[]; entries: HistogramEntry[] }>();

  counter(name: string, labels: LabelMap, value = 1, help = ''): void {
    let m = this.counters.get(name);
    if (!m) { m = { help, entries: [] }; this.counters.set(name, m); }
    if (help && !m.help) m.help = help;
    const existing = m.entries.find(e => sameLabels(e.labels, labels));
    if (existing) existing.value += value;
    else m.entries.push({ labels: { ...labels }, value });
  }

  gauge(name: string, labels: LabelMap, value: number, help = ''): void {
    let m = this.gauges.get(name);
    if (!m) { m = { help, entries: [] }; this.gauges.set(name, m); }
    if (help && !m.help) m.help = help;
    const existing = m.entries.find(e => sameLabels(e.labels, labels));
    if (existing) existing.value = value;
    else m.entries.push({ labels: { ...labels }, value });
  }

  observe(name: string, labels: LabelMap, valueSeconds: number, help = '', buckets = DEFAULT_BUCKETS_SECONDS): void {
    let m = this.histograms.get(name);
    if (!m) {
      m = { help, buckets, entries: [] };
      this.histograms.set(name, m);
    }
    if (help && !m.help) m.help = help;
    let entry = m.entries.find(e => sameLabels(e.labels, labels));
    if (!entry) {
      entry = { labels: { ...labels }, buckets: new Map(buckets.map(b => [b, 0])), sum: 0, count: 0 };
      m.entries.push(entry);
    }
    for (const b of buckets) {
      if (valueSeconds <= b) entry.buckets.set(b, (entry.buckets.get(b) ?? 0) + 1);
    }
    entry.sum += valueSeconds;
    entry.count += 1;
  }

  /** Render Prometheus text exposition format. */
  render(): string {
    const out: string[] = [];
    for (const [name, m] of this.counters) {
      if (m.help) out.push(`# HELP ${name} ${m.help}`);
      out.push(`# TYPE ${name} counter`);
      for (const e of m.entries) out.push(`${name}${formatLabels(e.labels)} ${e.value}`);
    }
    for (const [name, m] of this.gauges) {
      if (m.help) out.push(`# HELP ${name} ${m.help}`);
      out.push(`# TYPE ${name} gauge`);
      for (const e of m.entries) out.push(`${name}${formatLabels(e.labels)} ${e.value}`);
    }
    for (const [name, m] of this.histograms) {
      if (m.help) out.push(`# HELP ${name} ${m.help}`);
      out.push(`# TYPE ${name} histogram`);
      for (const e of m.entries) {
        // Cumulative buckets.
        let cum = 0;
        for (const b of m.buckets) {
          cum = (e.buckets.get(b) ?? 0);
          out.push(`${name}_bucket${formatLabels({ ...e.labels, le: String(b) })} ${cum}`);
        }
        out.push(`${name}_bucket${formatLabels({ ...e.labels, le: '+Inf' })} ${e.count}`);
        out.push(`${name}_sum${formatLabels(e.labels)} ${e.sum}`);
        out.push(`${name}_count${formatLabels(e.labels)} ${e.count}`);
      }
    }
    return out.join('\n') + '\n';
  }
}

function sameLabels(a: LabelMap, b: LabelMap): boolean {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function formatLabels(labels: LabelMap): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map(k => `${k}="${escapeLabelValue(String(labels[k]))}"`);
  return `{${parts.join(',')}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── shared process-level registry ──────────────────────────────────────

let globalRegistry: MetricsRegistry | null = null;

export function getMetrics(): MetricsRegistry {
  if (!globalRegistry) globalRegistry = new MetricsRegistry();
  return globalRegistry;
}

export function resetMetrics(): void {
  globalRegistry = new MetricsRegistry();
}
