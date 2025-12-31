const express = require('express');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '.env'),
  override: true,
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ================== REDIS ================== */
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    tls: true,
    rejectUnauthorized: false,
  },
});

redis.on('error', err => console.error('Redis error:', err));

(async () => {
  await redis.connect();
  console.log('✅ Redis connected');
})();

/* ================== HELPERS ================== */
function now(req) {
  if (process.env.TEST_MODE === '1' && req.headers['x-test-now-ms']) {
    return Number(req.headers['x-test-now-ms']);
  }
  return Date.now();
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/* ================== HEALTH ================== */
app.get('/api/healthz', async (req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* ================== CREATE ================== */
app.post('/api/pastes', async (req, res) => {
  const { content, ttl_seconds, max_views } = req.body;

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content required' });
  }

  if (ttl_seconds !== undefined && (!Number.isInteger(ttl_seconds) || ttl_seconds < 1)) {
    return res.status(400).json({ error: 'invalid ttl_seconds' });
  }

  if (max_views !== undefined && (!Number.isInteger(max_views) || max_views < 1)) {
    return res.status(400).json({ error: 'invalid max_views' });
  }

  const id = uuidv4().slice(0, 8);
  const key = `paste:${id}`;

  await redis.hSet(key, {
    content: content.trim(),
    created_at: Date.now(),
    ttl_seconds: ttl_seconds ?? '',
    max_views: max_views ?? '',
    views: 0,
  });

  res.status(201).json({
    id,
    url: `http://localhost:3000/p/${id}`,
  });
});

/* ================== FETCH (API) ================== */
app.get('/api/pastes/:id', async (req, res) => {
  const key = `paste:${req.params.id}`;
  const p = await redis.hGetAll(key);

  if (!p || !p.content) {
    return res.status(404).json({ error: 'Not found' });
  }

  const nowMs = now(req);
  const created = Number(p.created_at);
  const ttl = p.ttl_seconds ? Number(p.ttl_seconds) : null;
  const maxViews = p.max_views ? Number(p.max_views) : null;
  const views = Number(p.views);

  if (ttl && nowMs >= created + ttl * 1000) {
    return res.status(404).json({ error: 'Expired' });
  }

  if (maxViews && views >= maxViews) {
    return res.status(404).json({ error: 'View limit exceeded' });
  }

  const newViews = await redis.hIncrBy(key, 'views', 1);

  res.json({
    content: p.content,
    remaining_views: maxViews ? Math.max(maxViews - newViews, 0) : null,
    expires_at: ttl ? new Date(created + ttl * 1000).toISOString() : null,
  });
});

/* ================== VIEW (HTML) ================== */
app.get('/p/:id', async (req, res) => {
  const key = `paste:${req.params.id}`;
  const p = await redis.hGetAll(key);

  if (!p || !p.content) {
    return res.status(404).send('<h1>404 - Paste not found</h1>');
  }

  const nowMs = now(req);
  const created = Number(p.created_at);
  const ttl = p.ttl_seconds ? Number(p.ttl_seconds) : null;
  const maxViews = p.max_views ? Number(p.max_views) : null;
  const views = Number(p.views);

  if (ttl && nowMs >= created + ttl * 1000) {
    return res.status(404).send('<h1>Expired</h1>');
  }

  if (maxViews && views >= maxViews) {
    return res.status(404).send('<h1>View limit exceeded</h1>');
  }

  const newViews = await redis.hIncrBy(key, 'views', 1);

  res.send(`
    <html>
      <body style="font-family:monospace;max-width:800px;margin:40px auto">
        <pre>${escapeHtml(p.content)}</pre>
        <p>Views: ${newViews}${maxViews ? ` / ${maxViews}` : ''}</p>
      </body>
    </html>
  `);
});

app.listen(3000, () => console.log('🚀 Server on 3000'));
