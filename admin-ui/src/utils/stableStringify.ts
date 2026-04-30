export function stableStringify(x: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: any): any => {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normalize);
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    const keys = Object.keys(v).sort();
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = normalize(v[k]);
    return out;
  };
  return JSON.stringify(normalize(x));
}

