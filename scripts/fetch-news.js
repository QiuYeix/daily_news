import Parser from 'rss-parser';
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

// --- Translation via Youdao (works in China, no VPN needed) ---

async function translateText(text) {
  if (!text || text.trim().length < 3) return '';
  try {
    const url = `https://fanyi.youdao.com/translate?doctype=json&type=EN2ZH_CN&i=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.errorCode === 0 && data.translateResult) {
      const parts = data.translateResult[0].map((r) => r.tgt);
      return parts.join('');
    }
    return '';
  } catch {
    return '';
  }
}

async function translateLongText(text, maxChars = 450) {
  if (!text || text.trim().length < 3) return '';
  const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 0);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && (current + p).length > maxChars) {
      chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? '\n' : '') + p;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const translated = [];
  for (const chunk of chunks) {
    const t = await translateText(chunk);
    translated.push(t || chunk);
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 200));
  }
  return translated.join('\n');
}

// --- Article content extraction from web page ---

async function extractFromPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const doc = new JSDOM(html, { url });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();
    if (article && article.textContent) {
      return article.textContent.replace(/\s{3,}/g, '\n\n').trim().slice(0, 5000);
    }
    return '';
  } catch {
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
        rssBody: content.length > 200 ? content : '',
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
    console.log('[WARN] No articles fetched. Check VPN connection.');
    const output = { updated: new Date().toISOString(), count: 0, articles: [] };
    const dir = dirname(DATA_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), 'utf-8');
    console.log('[DONE] Empty result written.');
    return;
  }

  // Step 2: Translate titles and summaries (Youdao - works in China)
  console.log(`[TRANS] Translating ${articles.length} titles & summaries via Youdao...`);
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

  // Step 3: Get full article content from web pages (needs VPN)
  console.log(`[PAGE] Extracting full article content...`);
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    console.log(`[PAGE] [${i + 1}/${articles.length}] ${a.title.slice(0, 50)}...`);

    const pageContent = await extractFromPage(a.link);
    if (pageContent && pageContent.length > (a.rssBody || '').length) {
      a.content = pageContent;
      console.log(`  Got ${pageContent.length} chars from page`);
    } else if (a.rssBody && a.rssBody.length > 200) {
      a.content = a.rssBody.slice(0, 5000);
      console.log(`  Using RSS body: ${a.content.length} chars`);
    } else {
      a.content = '';
      console.log(`  No content`);
    }

    if (a.content) {
      a.contentZh = await translateLongText(a.content);
      console.log(`  Translated: ${a.contentZh.length} chars`);
    } else {
      a.contentZh = '';
    }
    delete a.rssBody;
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
