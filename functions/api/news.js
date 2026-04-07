// Cloudflare Pages Function: /api/news
// Returns JSON: { ok:true, items:[{title, link, date, source, category}], errors?:[...] }
// Query: ?lang=de|en|fr|it|vi&cat=mix|world|weather|business|sport&max=1..20

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lang = (url.searchParams.get("lang") || "de").toLowerCase();
  const catRaw = (url.searchParams.get("cat") || "mix").toLowerCase();
  const max = Math.min(parseInt(url.searchParams.get("max") || "20", 10) || 20, 20);

  const cat = normalizeCat(catRaw);

  const feeds = pickFeeds(lang, cat);
  const errors = [];
  const all = [];

  // Fetch sequentially (more reliable under free limits)
  for (const feedUrl of feeds) {
    try {
      const r = await fetch(feedUrl, {
        cf: { cacheTtl: 600, cacheEverything: true },
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Cloud9Zeitung/1.2; +https://cloud9mainz.pages.dev/)",
          "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": lang
        }
      });
      if (!r.ok) {
        errors.push({ feedUrl, status: r.status });
        continue;
      }
      const txt = await r.text();
      const items = parseFeed(txt, feedUrl, cat);
      all.push(...items);
    } catch (e) {
      errors.push({ feedUrl, error: String(e?.message || e) });
    }
  }

  // Filter: BBC only for EN (some feeds can contain BBC links)
  const filtered = all.filter(it => {
    const src = (it.source || "").toLowerCase();
    return (lang === "en") || !isBBC(src);
  });

  // De-duplicate by link (preferred) or title
  const seen = new Set();
  const deduped = [];
  for (const it of filtered) {
    const key = (it.link || "").trim() || ("t:" + (it.title || "").trim().toLowerCase());
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }

  // Sort by date desc (best-effort)
  deduped.sort((a, b) => (toTime(b.date) - toTime(a.date)));

  const out = deduped.slice(0, max);

  return json({ ok: true, items: out, errors });
}

function normalizeCat(c) {
  if (!c) return "mix";
  const x = String(c).toLowerCase();
  if (["sports"].includes(x)) return "sport";
  if (["biz", "wirtschaft"].includes(x)) return "business";
  if (["weather", "wetter"].includes(x)) return "weather";
  if (["world", "weltnachrichten", "ausland", "welt"].includes(x)) return "world";
  return ["mix", "sport", "business", "weather", "world"].includes(x) ? x : "mix";
}

function pickFeeds(lang, cat) {
  const cfg = langCfg(lang);

  // Always include a solid base feed for "mix"
  if (cat === "mix") {
    return uniq([
      ...cfg.mix,
      ...cfg.world.slice(0, 1),
      ...cfg.business.slice(0, 1),
      ...cfg.weather.slice(0, 1),
      ...cfg.sport.slice(0, 1),
    ]);
  }

  return uniq(cfg[cat] || cfg.mix);
}

function langCfg(lang) {
  // Google News RSS search (language/region tuned)
  const google = (q, hl, gl, ceid) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;

  if (lang === "en") {
    return {
      mix: [
        "https://feeds.bbci.co.uk/news/rss.xml",
      ],
      world: [
        "https://feeds.bbci.co.uk/news/world/rss.xml",
      ],
      weather: [
        google("weather", "en", "US", "US:en"),
      ],
      business: [
        "https://feeds.bbci.co.uk/news/business/rss.xml",
      ],
      sport: [
        "https://feeds.bbci.co.uk/sport/rss.xml",
      ],
    };
  }

  if (lang === "fr") {
    return {
      mix: [
        "https://www.france24.com/fr/rss",
      ],
      world: [
        "https://www.france24.com/fr/europe/rss",
        "https://www.france24.com/fr/monde/rss",
      ],
      weather: [
        google("météo", "fr", "FR", "FR:fr"),
      ],
      business: [
        "https://www.france24.com/fr/eco-tech/rss",
      ],
      sport: [
        google("sport", "fr", "FR", "FR:fr"),
      ],
    };
  }

  if (lang === "it") {
    return {
      mix: [
        "https://www.rainews.it/rss/tutti.xml",
      ],
      world: [
        "https://www.rainews.it/rss/esteri.xml",
      ],
      weather: [
        google("meteo", "it", "IT", "IT:it"),
      ],
      business: [
        "https://www.rainews.it/rss/economia.xml",
      ],
      sport: [
        "https://www.rainews.it/rss/sport.xml",
      ],
    };
  }

  if (lang === "vi") {
    return {
      mix: [
        "https://vnexpress.net/rss/tin-moi-nhat.rss",
      ],
      world: [
        "https://vnexpress.net/rss/the-gioi.rss",
      ],
      weather: [
        google("thời tiết", "vi", "VN", "VN:vi"),
      ],
      business: [
        "https://vnexpress.net/rss/kinh-doanh.rss",
      ],
      sport: [
        "https://vnexpress.net/rss/the-thao.rss",
      ],
    };
  }

  // default de
  return {
    mix: [
      "https://www.tagesschau.de/xml/rss2",
      "https://www.swr.de/swraktuell/rss.xml",
    ],
    world: [
      google("Weltnachrichten", "de", "DE", "DE:de"),
    ],
    weather: [
      google("Wetter Deutschland", "de", "DE", "DE:de"),
    ],
    business: [
      google("Wirtschaft Deutschland", "de", "DE", "DE:de"),
    ],
    sport: [
      google("Sport Deutschland", "de", "DE", "DE:de"),
    ],
  };
}

function parseFeed(xml, feedUrl, category) {
  const out = [];

  // RSS
  const rssItems = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  for (const block of rssItems) {
    const title = pick(block, "title");
    const link = pick(block, "link");
    const pubDate = pick(block, "pubDate") || pick(block, "dc:date");
    const desc = pick(block, "description") || pick(block, "content:encoded");
    if (!title || !link) continue;
    out.push({
      title,
      link,
      date: pubDate || "",
      source: hostname(link || feedUrl),
      description: stripHtml(desc).slice(0, 220),
      category
    });
  }

  // Atom
  const atomEntries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(m => m[1]);
  for (const entry of atomEntries) {
    const title = pick(entry, "title");
    let link = "";
    // <link href="..."/>
    const m1 = entry.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
    if (m1) link = decodeHtml(m1[1]);
    if (!link) link = pick(entry, "link");
    const updated = pick(entry, "updated") || pick(entry, "published");
    const summary = pick(entry, "summary") || pick(entry, "content");
    if (!title || !link) continue;
    out.push({
      title,
      link,
      date: updated || "",
      source: hostname(link || feedUrl),
      description: stripHtml(summary).slice(0, 220),
      category
    });
  }

  return out;
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? decodeHtml(m[1].trim()) : "";
}

function stripHtml(s) {
  const t = decodeHtml(String(s || ""));
  return t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function hostname(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "news";
  }
}

function isBBC(host) {
  const h = String(host || "").toLowerCase();
  return h === "bbc.com" || h.endsWith(".bbc.com") ||
         h === "bbc.co.uk" || h.endsWith(".bbc.co.uk") ||
         h === "bbci.co.uk" || h.endsWith(".bbci.co.uk");
}

function decodeHtml(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function toTime(d) {
  if (!d) return 0;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : 0;
}

function uniq(arr) {
  const s = new Set();
  const out = [];
  for (const x of (arr || [])) {
    if (!x) continue;
    if (s.has(x)) continue;
    s.add(x);
    out.push(x);
  }
  return out;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
