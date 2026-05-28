function formatDate(isoStr) {
  const d = new Date(isoStr);
  const now = new Date();
  const diff = now - d;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.floor(diff / 60000)} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(diff / 86400000);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function sourceClass(source) {
  const map = { 'BBC News': 'bbc', 'The Guardian': 'guardian', 'NPR': 'npr', 'ABC News': 'abc', 'Al Jazeera': 'aljazeera' };
  return map[source] || 'bbc';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderParagraphContent(cp, idx) {
  if (!cp || cp.length === 0) return '';
  return `
    <button class="expand-btn" data-idx="${idx}">展开全文 ▼</button>
    <div class="article-full" id="full-${idx}" style="display:none">
      ${cp.map((p, pi) => `
        <div class="para-pair" data-pair="${idx}-${pi}">
          <p class="para-en">${escapeHtml(p.en)}</p>
          <p class="para-zh">${escapeHtml(p.zh)}</p>
        </div>
      `).join('')}
    </div>`;
}

function renderFallbackContent(a, idx) {
  if (a.content) {
    return `
      <button class="expand-btn" data-idx="${idx}">展开全文 ▼</button>
      <div class="article-full" id="full-${idx}" style="display:none">
        <div class="article-columns">
          <div class="article-col">
            <h4 class="col-label">English</h4>
            <div class="article-body">${escapeHtml(a.content).replace(/\n\n/g, '</p><p class="article-para">')}</div>
          </div>
          <div class="article-col">
            <h4 class="col-label">中文</h4>
            <div class="article-body">${escapeHtml(a.contentZh || '').replace(/\n\n/g, '</p><p class="article-para">')}</div>
          </div>
        </div>
      </div>`;
  }
  if (a.link) {
    return `<a class="read-link" href="${escapeHtml(a.link)}" target="_blank" rel="noopener">阅读原文 →</a>`;
  }
  return '';
}

function renderArticles(articles) {
  const list = document.getElementById('newsList');
  list.innerHTML = articles.map((a, idx) => `
    <article class="news-card">
      <div class="card-header">
        <span class="source-tag source-${sourceClass(a.source)}">${a.source}</span>
        <span class="card-date">${formatDate(a.pubDate)}</span>
      </div>
      <p class="title-en">${escapeHtml(a.title)}</p>
      ${a.titleZh ? `<p class="title-zh">${escapeHtml(a.titleZh)}</p>` : ''}
      ${a.summary ? `<p class="summary-en">${escapeHtml(a.summary)}</p>` : ''}
      ${a.summaryZh ? `<p class="summary-zh">${escapeHtml(a.summaryZh)}</p>` : ''}
      ${a.contentParagraphs ? renderParagraphContent(a.contentParagraphs, idx) : renderFallbackContent(a, idx)}
    </article>
  `).join('');
}

function setupExpandListeners() {
  document.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      const full = document.getElementById('full-' + idx);
      const isOpen = full.style.display !== 'none';
      full.style.display = isOpen ? 'none' : 'block';
      btn.textContent = isOpen ? '展开全文 ▼' : '收起全文 ▲';
    });
  });
}

async function loadNews() {
  try {
    const res = await fetch('data/news.json');
    if (!res.ok) throw new Error('Data not found');
    const data = await res.json();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('newsList').style.display = 'flex';

    const timeEl = document.getElementById('updateTime');
    timeEl.textContent = `更新于 ${new Date(data.updated).toLocaleString('zh-CN')}`;

    renderArticles(data.articles);
    setupExpandListeners();
  } catch (e) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('errorMsg').style.display = 'block';
    console.error('Failed to load news:', e);
  }
}

loadNews();

// Refresh button
const refreshBtn = document.getElementById('refreshBtn');
const refreshStatus = document.getElementById('refreshStatus');

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⏳ 更新中…';
  refreshStatus.textContent = '正在抓取新闻和翻译，请耐心等待（约1-2分钟）…';

  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      refreshStatus.textContent = data.message;
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 刷新新闻';
      return;
    }
  } catch (e) {
    refreshStatus.textContent = '请求失败，请确认后端已启动';
    refreshBtn.disabled = false;
    refreshBtn.textContent = '🔄 刷新新闻';
    return;
  }

  const poll = setInterval(async () => {
    try {
      const r = await fetch('/api/status');
      const s = await r.json();
      if (s.log.length > 0) {
        refreshStatus.textContent = s.log[s.log.length - 1];
      }
      if (!s.updating) {
        clearInterval(poll);
        refreshBtn.disabled = false;
        refreshBtn.textContent = '🔄 刷新新闻';
        refreshStatus.textContent = '更新完成！正在重新加载…';
        await loadNews();
        refreshStatus.textContent = '';
      }
    } catch {}
  }, 1000);
});
