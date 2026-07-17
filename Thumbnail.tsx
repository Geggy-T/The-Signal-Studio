/**
 * Pulse — the demand signal for discovery v2.
 *
 * Instead of only scanning a fixed list of YouTube channels (supply), Pulse detects
 * what AI/tech stories are SURGING right now (demand), pulled from where news actually
 * breaks first: Hacker News (rich velocity data, free Algolia API) and a set of AI/tech
 * news RSS feeds. Everything is best-effort and resilient — a dead source is skipped,
 * never fatal.
 *
 * Returns a de-duplicated, momentum-ranked list of candidate stories. The Studio then
 * clusters + scores these (LLM) and turns the top ones into a YouTube search for the
 * best clip on that exact story.
 */

export interface PulseItem {
  title: string;
  url: string;
  source: string; // "hn" | "rss:<name>"
  points: number | null;
  comments: number | null;
  published: number | null; // unix seconds
  velocity: number; // momentum score (higher = hotter)
}

// On-brand gate: keep only clearly AI/tech stories. Kept deliberately broad; the
// Studio's relevance + story-appeal scoring does the finer filtering downstream.
const AI_TERMS =
  /\b(A\.?I\.?|artificial intelligence|LLM|GPT|Claude|Gemini|Grok|OpenAI|Anthropic|Nvidia|Mistral|DeepSeek|Llama|AGI|agent(?:ic|s)?|chatbot|model|inference|training|diffusion|neural|machine learning|robot|chip|semiconductor|datacenter|data center)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hacker News via the free Algolia API: recent stories with real points velocity. */
async function fetchHN(sinceHours: number): Promise<PulseItem[]> {
  const since = Math.floor(Date.now() / 1000) - sinceHours * 3600;
  const url = `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since},points>15&hitsPerPage=100`;
  const res = await fetch(url, { headers: { "User-Agent": "signal-pulse/1.0" } });
  if (!res.ok) throw new Error(`hn ${res.status}`);
  const j = (await res.json()) as {
    hits?: Array<{
      title?: string;
      url?: string;
      points?: number;
      num_comments?: number;
      created_at_i?: number;
      objectID?: string;
    }>;
  };
  const now = Date.now() / 1000;
  return (j.hits ?? [])
    .map((h) => {
      const pub = typeof h.created_at_i === "number" ? h.created_at_i : null;
      const ageH = pub ? Math.max(2, (now - pub) / 3600) : 48;
      const points = h.points ?? 0;
      return {
        title: (h.title ?? "").trim(),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        source: "hn",
        points: h.points ?? null,
        comments: h.num_comments ?? null,
        published: pub,
        // Momentum: points per hour, softened, so a fast-rising new story beats a
        // stale high-total one. Comments add a small engagement bonus.
        velocity: points / ageH + (h.num_comments ?? 0) / (ageH * 4),
      } as PulseItem;
    })
    .filter((i) => i.title && AI_TERMS.test(i.title));
}

/** Minimal RSS/Atom parse (no dependency): pull item title + link + date. */
async function fetchRSS(name: string, feedUrl: string, sinceHours: number): Promise<PulseItem[]> {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "signal-pulse/1.0", Accept: "application/rss+xml,application/xml,text/xml" },
  });
  if (!res.ok) throw new Error(`${name} ${res.status}`);
  const xml = await res.text();
  const now = Date.now() / 1000;
  const cutoff = now - sinceHours * 3600;
  const blocks = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  const out: PulseItem[] = [];
  for (const b of blocks) {
    const titleM = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkM =
      b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || b.match(/<link[^>]*href="([^"]+)"/i);
    const dateM = b.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\//i);
    const title = titleM ? decodeEntities(titleM[1]) : "";
    const link = linkM ? decodeEntities(linkM[1]) : "";
    if (!title || !link || !AI_TERMS.test(title)) continue;
    let pub: number | null = null;
    if (dateM) {
      const t = Date.parse(dateM[1].trim());
      if (!isNaN(t)) pub = Math.floor(t / 1000);
    }
    if (pub && pub < cutoff) continue;
    const ageH = pub ? Math.max(2, (now - pub) / 3600) : 24;
    out.push({
      title,
      url: link,
      source: `rss:${name}`,
      points: null,
      comments: null,
      published: pub,
      // No points on RSS; use recency as the momentum proxy (fresher = hotter).
      velocity: 24 / ageH,
    });
  }
  return out;
}

const RSS_FEEDS: Array<[string, string]> = [
  ["theverge", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"],
  ["techcrunch", "https://techcrunch.com/category/artificial-intelligence/feed/"],
  ["venturebeat", "https://venturebeat.com/category/ai/feed/"],
  ["arstechnica", "https://arstechnica.com/ai/feed/"],
];

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Aggregate all sources into one momentum-ranked, de-duplicated list.
 * @param sinceHours look-back window (default 72h)
 */
export async function pulse(sinceHours = 72): Promise<PulseItem[]> {
  const jobs: Promise<PulseItem[]>[] = [
    fetchHN(sinceHours),
    ...RSS_FEEDS.map(([n, u]) => fetchRSS(n, u, sinceHours)),
  ];
  const settled = await Promise.allSettled(jobs);
  const items: PulseItem[] = [];
  for (const s of settled) if (s.status === "fulfilled") items.push(...s.value);

  // De-dup by normalized title; keep the highest-velocity instance, but note how many
  // sources carried it (cross-source coverage is itself a strong "this is a real story"
  // signal, so it gets a coverage boost).
  const byKey = new Map<string, PulseItem & { coverage: number }>();
  for (const it of items) {
    const key = normTitle(it.title).slice(0, 80);
    if (!key) continue;
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { ...it, coverage: 1 });
    else {
      cur.coverage += 1;
      if (it.velocity > cur.velocity) {
        cur.velocity = it.velocity;
        cur.url = it.url;
        cur.source = it.source;
        cur.points = it.points ?? cur.points;
      }
    }
  }
  const ranked = Array.from(byKey.values())
    .map((x) => ({ ...x, velocity: x.velocity * (1 + 0.5 * (x.coverage - 1)) }))
    .sort((a, b) => b.velocity - a.velocity);

  // Drop the coverage helper from the returned shape.
  return ranked.map(({ coverage: _c, ...rest }) => rest);
}
