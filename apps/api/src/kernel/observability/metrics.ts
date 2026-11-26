/**
 * Metrics registry (P6) with the Prometheus text exposition format. Labels are an allowlist of
 * low-cardinality values (never IDs or personal data). Exposed only on the operations port, which
 * hotel staff can't reach (map P6, Q-18).
 */
type Labels = Readonly<Record<string, string>>;
const NAME = /^[a-z_][a-z0-9_]*$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:/{}-]{0,120}$/;
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function key(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
}

function safeLabels(labels: Labels): Labels {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(labels)) {
    if (!NAME.test(name)) continue;
    out[name] = LABEL_VALUE.test(value) ? value : 'invalid';
  }
  return out;
}

interface Histogram {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();
  private readonly help = new Map<string, string>();

  describe(name: string, help: string): void {
    this.help.set(name, help.replace(/\n/g, ' '));
  }

  increment(name: string, labels: Labels = {}, value = 1): void {
    if (!NAME.test(name)) return;
    const series = this.counters.get(name) ?? new Map<string, number>();
    const k = key(safeLabels(labels));
    series.set(k, (series.get(k) ?? 0) + value);
    this.counters.set(name, series);
  }

  set(name: string, labels: Labels, value: number): void {
    if (!NAME.test(name)) return;
    const series = this.gauges.get(name) ?? new Map<string, number>();
    series.set(key(safeLabels(labels)), value);
    this.gauges.set(name, series);
  }

  observe(
    name: string,
    labels: Labels,
    seconds: number,
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ): void {
    if (!NAME.test(name)) return;
    const series = this.histograms.get(name) ?? new Map<string, Histogram>();
    const k = key(safeLabels(labels));
    const h = series.get(k) ?? {
      buckets: [...buckets],
      counts: buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    h.buckets.forEach((bound, i) => {
      if (seconds <= bound) h.counts[i] = (h.counts[i] ?? 0) + 1;
    });
    h.sum += seconds;
    h.count += 1;
    series.set(k, h);
    this.histograms.set(name, series);
  }

  counterValue(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(key(safeLabels(labels))) ?? 0;
  }

  /** Prometheus text exposition format 0.0.4. */
  render(): string {
    const lines: string[] = [];
    const header = (name: string, type: string) => {
      const help = this.help.get(name);
      if (help !== undefined) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    const series = (name: string, labels: string, value: number) =>
      lines.push(`${name}${labels === '' ? '' : `{${labels}}`} ${value}`);
    for (const [name, values] of this.counters) {
      header(name, 'counter');
      for (const [labels, value] of values) series(name, labels, value);
    }
    for (const [name, values] of this.gauges) {
      header(name, 'gauge');
      for (const [labels, value] of values) series(name, labels, value);
    }
    for (const [name, values] of this.histograms) {
      header(name, 'histogram');
      for (const [labels, h] of values) {
        const prefix = labels === '' ? '' : `${labels},`;
        h.buckets.forEach((bound, i) =>
          series(`${name}_bucket`, `${prefix}le="${bound}"`, h.counts[i] ?? 0),
        );
        series(`${name}_bucket`, `${prefix}le="+Inf"`, h.count);
        series(`${name}_sum`, labels, h.sum);
        series(`${name}_count`, labels, h.count);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
