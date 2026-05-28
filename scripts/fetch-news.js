import Parser from 'rss-parser';
import { translate as googleTranslate } from '@vitalets/google-translate-api';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'news.json');

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'DailyNewsAggregator/1.0' },
});

const FEEDS = [
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', color: '#b80000' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', color: '#052962' },
  { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml', color: '#e57300' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', color: '#f79120' },
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
      if (!t) return true; // keep blank lines for paragraph breaks
      // Image credit lines: "Carolyn Kaster/AP", "Josh Edelson/AFP via Getty Images"
      if (/^[A-Z][a-z]+ [A-Z][a-z]+\/(AP|Getty|Reuters|AFP|EPA|NPR|BBC|CNN)\b/.test(t)) return false;
      if (/^(AP|Getty|Reuters|AFP|EPA)\b/i.test(t) && t.length < 40) return false;
      // "hide caption" / "toggle caption" / "show caption"
      if (/^(hide|toggle|show) caption$/i.test(t)) return false;
      // Timestamp noise: "42 minutes ago", "2 hours ago"
      if (/^\d+ (minute|hour|day|second)s? ago/.test(t)) return false;
      // Standalone byline markers
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

// Translate paragraph by paragraph for aligned display
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
    console.log(`    [${i + 1}/${paragraphs.length}] ${en.slice(0, 50)}...`);
    const zh = await translateText(en);
    pairs.push({ en, zh: zh || en });
    if (i < paragraphs.length - 1) await new Promise((r) => setTimeout(r, 200));
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

    // Try JSON-LD structured data first (more reliable, works for BBC)
    try {
      const scripts = doc.window.document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        // Handle @graph structure
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
  console.log(`[RSS] Fetching ${feed.name}...`);
  try {
    const result = await parser.parseURL(feed.url);
    const items = (result.items || []).slice(0, 6).map((item) => {
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

// --- Main ---

async function main() {
  console.log('=== Daily News Fetcher ===');
  console.log(new Date().toISOString());

  // Step 1: Fetch RSS feeds
  const results = await Promise.all(FEEDS.map(fetchFeed));
  let articles = results.flat();
  articles = deduplicate(articles);
  articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  articles = articles.slice(0, 12);

  console.log(`[INFO] Total after dedup: ${articles.length} articles`);

  if (articles.length === 0) {
    console.log('[WARN] No articles fetched.');
    const output = { updated: new Date().toISOString(), count: 0, articles: [] };
    const dir = dirname(DATA_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), 'utf-8');
    console.log('[DONE] Empty result written.');
    return;
  }

  // Step 2: Translate titles & summaries
  console.log(`[TRANS] Translating ${articles.length} titles & summaries...`);
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    console.log(`[TRANS] [${i + 1}/${articles.length}] ${a.title.slice(0, 60)}...`);
    const [titleZh, summaryZh] = await Promise.all([
      translateText(a.title),
      translateText(a.summary),
    ]);
    a.titleZh = titleZh;
    a.summaryZh = summaryZh;
    if (i < articles.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  // Step 3: Get full content, clean, translate paragraph by paragraph
  console.log(`[PAGE] Extracting & translating full content (paragraph-aligned)...`);
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    console.log(`[PAGE] [${i + 1}/${articles.length}] ${a.title.slice(0, 50)}...`);

    // Get raw content
    const pageContent = await extractFromPage(a.link);
    let rawContent = '';
    if (pageContent && pageContent.length > (a.rssBody || '').length) {
      rawContent = pageContent;
      console.log(`  Page: ${rawContent.length} chars`);
    } else if (a.rssBody && a.rssBody.length > 80) {
      rawContent = a.rssBody.slice(0, 6000);
      console.log(`  RSS fallback: ${rawContent.length} chars`);
    } else {
      console.log(`  No content (page=${pageContent.length}, rss=${(a.rssBody||'').length})`);
    }

    if (rawContent) {
      a.contentParagraphs = await translateContent(rawContent);
      console.log(`  Paragraphs: ${a.contentParagraphs.length} pairs`);
    } else {
      a.contentParagraphs = [];
    }
    delete a.rssBody;
    delete a.content;
    delete a.contentZh;
    if (i < articles.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  // Write output
  const dir = dirname(DATA_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const output = {
    updated: new Date().toISOString(),
    count: articles.length,
    articles,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[DONE] Written ${articles.length} articles to news.json`);
}

main().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
