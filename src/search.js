/**
 * Web search tool backing the agent.
 *
 * - web_search(query): Serper.dev Google search, top 5 organic results + answer box.
 * - fetch_url(url): server-side GET of a result page, HTML stripped to text.
 *
 * Both are cached in memory with a TTL so repeated questions are fast and
 * cheap, and concurrent searches for the same query are deduplicated.
 */
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_FETCH_CHARS = 8000;

const cache = new Map(); // key -> { ts, value }
const inflight = new Map(); // key -> Promise

function cacheKey(prefix, value) {
  return `${prefix}:${String(value).toLowerCase().trim()}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.value;
  return undefined;
}

function setCached(key, value) {
  cache.set(key, { ts: Date.now(), value });
}

export class Search {
  constructor({ apiKey }) {
    if (!apiKey) {
      this.disabled = true;
      return;
    }
    this.apiKey = apiKey;
    this.disabled = false;
  }

  async search(query) {
    if (this.disabled) {
      return { unavailable: true, note: 'SERPER_API_KEY not configured' };
    }
    const key = cacheKey('search', query);
    const cached = getCached(key);
    if (cached) return cached;

    const run = (async () => {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: 5 }),
      });
      if (!res.ok) {
        throw new Error(`Serper search failed (HTTP ${res.status})`);
      }
      const json = await res.json();

      const results = [];
      if (json.answer_box) {
        results.push({
          title: json.answer_box.title || 'Answer',
          snippet: json.answer_box.answer || json.answer_box.snippet || '',
          link: json.answer_box.link || '',
          date: json.answer_box.date || '',
        });
      }
      for (const item of (json.organic || []).slice(0, 5)) {
        results.push({
          title: item.title || '',
          snippet: item.snippet || '',
          link: item.link || '',
          date: item.date || '',
        });
      }
      const value = { query, results, fetchedAt: new Date().toISOString() };
      setCached(key, value);
      return value;
    })();

    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  }

  async fetch(url) {
    if (this.disabled) {
      return { unavailable: true, url, text: '(SERPER_API_KEY not configured)' };
    }
    const key = cacheKey('fetch', url);
    const cached = getCached(key);
    if (cached) return cached;

    const run = (async () => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'mimimi-chat-agent/1.0 (+chat agent)' },
        // Follow redirects, cap response time
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        throw new Error(`fetch failed (HTTP ${res.status})`);
      }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/html') && !ct.includes('text/plain')) {
        return { url, text: `(non-text page: ${ct})` };
      }
      const html = await res.text();
      const text = stripHtml(html).slice(0, MAX_FETCH_CHARS);
      const value = { url, text };
      setCached(key, value);
      return value;
    })();

    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  }
}

/** Very small HTML -> text conversion. Good enough for search-result pages. */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/ (p|div|h[1-6]|li|tr|br|hr)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
