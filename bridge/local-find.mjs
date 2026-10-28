/**
 * Local stand-in for the extension's LLM-backed `find`: score the interactive
 * read_page snapshot by term overlap so the ref-based tools still work offline.
 * Shared by cli.mjs and mcp.mjs.
 */
export function localFind(snapshot, query) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const out = [];
  for (const raw of snapshot.split('\n')) {
    const line = raw.trim();
    if (!line || !/\[ref_\d+\]/.test(line)) continue;
    const low = line.toLowerCase();
    const role = (line.split(/[\s"]/)[0] || '').toLowerCase();
    let score = 0;
    for (const t of terms) if (low.includes(t)) score += t.length >= 4 ? 2 : 1;
    if (terms.some((t) => role.includes(t))) score += 1.5;
    if (score > 0) out.push({ score, line });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 20);
}
