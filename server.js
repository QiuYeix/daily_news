import express from 'express';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.static(__dirname));

let isUpdating = false;
let updateLog = [];

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json({ updating: isUpdating, log: updateLog });
});

app.post('/api/refresh', (req, res) => {
  if (isUpdating) {
    return res.json({ ok: false, message: '已经在更新中，请稍候' });
  }
  isUpdating = true;
  updateLog = [];
  res.json({ ok: true, message: '开始更新…' });

  const child = spawn('node', ['scripts/fetch-news.js'], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    const lines = stdoutBuf.split('\n');
    // Keep the last incomplete line in buffer
    stdoutBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) updateLog.push(trimmed);
    }
  });

  let stderrBuf = '';
  child.stderr.on('data', (data) => {
    stderrBuf += data.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) updateLog.push('[ERR] ' + trimmed);
    }
  });

  child.on('close', (code) => {
    if (stdoutBuf.trim()) updateLog.push(stdoutBuf.trim());
    if (stderrBuf.trim()) updateLog.push('[ERR] ' + stderrBuf.trim());
    isUpdating = false;
    updateLog.push(code === 0 ? '[DONE] 更新完成' : '[DONE] 更新失败，退出码: ' + code);
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
