import Parser from 'rss-parser';
import { translate as googleTranslate } from '@vitalets/google-translate-api';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'news.json');

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'DailyNewsAggregator/1.0' },
});

const CATEGORIES = {
  world: { label: '国际', icon: '🌍' },
  tech: { label: '科技', icon: '💻' },
  business: { label: '商业', icon: '📈' },
  science: { label: '科学', icon: '🔬' },
};

const FEEDS = [
  // World
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world', color: '#b80000' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', category: 'world', color: '#052962' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', category: 'world', color: '#e57300' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world', color: '#f79120' },
  // Technology
  { name: 'BBC Tech', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'tech', color: '#1a73e8' },
  { name: 'NPR Technology', url: 'https://feeds.npr.org/1019/rss.xml', category: 'tech', color: '#1a73e8' },
  { name: 'Guardian Tech', url: 'https://www.theguardian.com/technology/rss', category: 'tech', color: '#1a73e8' },
  // Business
  { name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'business', color: '#0d7a3e' },
  { name: 'NPR Business', url: 'https://feeds.npr.org/1006/rss.xml', category: 'business', color: '#0d7a3e' },
  // Science
  { name: 'NPR Science', url: 'https://feeds.npr.org/1007/rss.xml', category: 'science', color: '#6a1b9a' },
  { name: 'BBC Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science', color: '#6a1b9a' },
];

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n').trim();
}

// --- Content cleaning ---

function cleanContent(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^[A-Z][a-z]+ [A-Z][a-z]+\/(AP|Getty|Reuters|AFP|EPA|NPR|BBC|CNN)\b/.test(t)) return false;
      if (/^(AP|Getty|Reuters|AFP|EPA)\b/i.test(t) && t.length < 40) return false;
      if (/^(hide|toggle|show) caption$/i.test(t)) return false;
      if (/^\d+ (minute|hour|day|second)s? ago/.test(t)) return false;
      if (/^More on this story$/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Translation: Google primary, MyMemory fallback ---

async function translateWithGoogle(text) {
  const result = await googleTranslate(text, { to: 'zh-CN' });
  return result.text;
}

async function translateWithMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
  const res = await fetch(url);
  const data = await res.json();
  const translated = data.responseData?.translatedText || '';
  if (translated.startsWith('MYMEMORY WARNING')) return '';
  return translated;
}

async function translateText(text) {
  if (!text || text.trim().length < 3) return '';
  try { return await translateWithGoogle(text); } catch {
    try { return await translateWithMyMemory(text); } catch { return ''; }
  }
}

async function translateContent(text) {
  if (!text || text.trim().length < 3) return [];
  const cleaned = cleanContent(text);
  const paragraphs = cleaned
    .split(/\n\n/)
    .map((p) => p.trim().replace(/\n/g, ' ').replace(/\s+/g, ' '))
    .filter((p) => p.length >= 15);

  if (paragraphs.length === 0) return [];

  const pairs = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const en = paragraphs[i];
    const zh = await translateText(en);
    pairs.push({ en, zh: zh || en });
  }
  return pairs;
}

// --- Article content extraction ---

async function extractFromPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(`    HTTP ${res.status} for ${url.slice(0, 60)}`);
      return '';
    }
    const html = await res.text();
    const doc = new JSDOM(html, { url });

    // Try JSON-LD first
    try {
      const scripts = doc.window.document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        const items = data['@graph'] || [data];
        for (const item of items) {
          if (item['@type'] === 'NewsArticle' || item['@type'] === 'Article') {
            const body = item.articleBody || '';
            if (body && body.length > 100) {
              console.log(`    JSON-LD: ${body.length} chars`);
              return body.replace(/\s{3,}/g, '\n\n').trim().slice(0, 6000);
            }
          }
        }
      }
    } catch {}

    // Fallback to Readability
    const reader = new Readability(doc.window.document);
    const article = reader.parse();
    if (article && article.textContent) {
      return article.textContent.replace(/\s{3,}/g, '\n\n').trim().slice(0, 6000);
    }
    console.log(`    Readability returned null for ${url.slice(0, 60)}`);
    return '';
  } catch (e) {
    console.log(`    Page fetch error: ${e.message}`);
    return '';
  }
}

// --- RSS Fetching ---

async function fetchFeed(feed) {
  console.log(`[RSS] Fetching ${feed.name} (${feed.category})...`);
  try {
    const result = await parser.parseURL(feed.url);
    const items = (result.items || []).slice(0, 4).map((item) => {
      const rssContent = stripHtml(item['content:encoded'] || item.content || '');
      const rssSummary = stripHtml(item.contentSnippet || item.summary || item.description || '');
      const content = rssContent.length > rssSummary.length ? rssContent : rssSummary;

      return {
        title: item.title?.trim() || '',
        link: item.link || '',
        summary: rssSummary.slice(0, 280),
        rssBody: content.length > 80 ? content : rssSummary,
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        source: feed.name,
        category: feed.category,
        sourceColor: feed.color,
      };
    });
    console.log(`[RSS] ${feed.name}: ${items.length} articles`);
    return items;
  } catch (e) {
    console.warn(`[RSS] ${feed.name} FAILED: ${e.message}`);
    return [];
  }
}

function deduplicate(articles) {
  const seen = new Set();
  return articles.filter((a) => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Persistence: merge new articles with existing ---

function loadExisting() {
  try {
    if (existsSync(DATA_PATH)) {
      const raw = readFileSync(DATA_PATH, 'utf-8');
      const data = JSON.parse(raw);
      return data.articles || [];
    }
  } catch {}
  return [];
}

function mergeArticles(existing, incoming) {
  const all = deduplicate([...incoming, ...existing]);
  all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Remove articles older than 36 hours
  const cutoff = Date.now() - 36 * 3600 * 1000;
  const fresh = all.filter((a) => new Date(a.pubDate).getTime() > cutoff);

  console.log(`[MERGE] ${existing.length} existing + ${incoming.length} new → ${all.length} after dedup → ${fresh.length} fresh`);

  return fresh;
}

// --- Main ---

async function main() {
  console.log('=== Daily News Fetcher ===');
  console.log(new Date().toISOString());

  // Step 1: Fetch RSS feeds (each source gets fewer articles to keep total manageable)
  const results = await Promise.all(FEEDS.map(fetchFeed));
  let newArticles = results.flat();
  newArticles = deduplicate(newArticles);
  console.log(`[INFO] ${newArticles.length} new articles from RSS`);

  // Step 2: Translate titles & summaries for new articles
  console.log(`[TRANS] Translating ${newArticles.length} titles & summaries...`);
  for (let i = 0; i < newArticles.length; i++) {
    const a = newArticles[i];
    console.log(`[TRANS] [${i + 1}/${newArticles.length}] ${a.title.slice(0, 60)}...`);
    const [titleZh, summaryZh] = await Promise.all([
      translateText(a.title),
      translateText(a.summary),
    ]);
    a.titleZh = titleZh;
    a.summaryZh = summaryZh;
    if (i < newArticles.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  // Step 3: Get full content & translate for new articles
  console.log(`[PAGE] Extracting & translating full content...`);
  for (let i = 0; i < newArticles.length; i++) {
    const a = newArticles[i];
    console.log(`[PAGE] [${i + 1}/${newArticles.length}] ${a.title.slice(0, 50)}...`);

    const pageContent = await extractFromPage(a.link);
    let rawContent = '';
    if (pageContent && pageContent.length > (a.rssBody || '').length) {
      rawContent = pageContent;
      console.log(`  Page: ${rawContent.length} chars`);
    } else if (a.rssBody && a.rssBody.length > 80) {
      rawContent = a.rssBody.slice(0, 6000);
      console.log(`  RSS fallback: ${rawContent.length} chars`);
    } else {
      console.log(`  No content`);
    }

    if (rawContent) {
      a.contentParagraphs = await translateContent(rawContent);
      console.log(`  Paragraphs: ${a.contentParagraphs.length} pairs`);
    } else {
      a.contentParagraphs = [];
    }
    delete a.rssBody;
    if (i < newArticles.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  // Step 4: Merge with existing articles
  const existing = loadExisting();
  const merged = mergeArticles(existing, newArticles);

  // Ensure at least some per category, max 20 total
  const byCategory = {};
  for (const a of merged) {
    if (!byCategory[a.category]) byCategory[a.category] = [];
    byCategory[a.category].push(a);
  }

  // Interleave: take 1 from each category, repeat, until we have 20
  const categories = Object.keys(CATEGORIES);
  const final = [];
  const indices = Object.fromEntries(categories.map((c) => [c, 0]));
  while (final.length < 20) {
    let added = false;
    for (const cat of categories) {
      const pool = byCategory[cat] || [];
      if (indices[cat] < pool.length) {
        final.push(pool[indices[cat]]);
        indices[cat]++;
        added = true;
        if (final.length >= 20) break;
      }
    }
    if (!added) break;
  }

  // Add any remaining if interleave didn't fill 20
  for (const a of merged) {
    if (final.length >= 20) break;
    if (!final.find((f) => f.title === a.title)) {
      final.push(a);
    }
  }

  console.log(`[FINAL] ${final.length} articles (${categories.map((c) => `${c}: ${indices[c]}`).join(', ')})`);

  // Write output
  const dir = dirname(DATA_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const output = {
    updated: new Date().toISOString(),
    count: final.length,
    categories: CATEGORIES,
    articles: final,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[DONE] Written ${final.length} articles to news.json`);
}

main().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
