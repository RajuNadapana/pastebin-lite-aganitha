const express = require('express');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

/* ================== FORCE dotenv (Windows safe) ================== */
require('dotenv').config({
  path: path.resolve(__dirname, '.env'),
  override: true,
});

/* ================== APP SETUP ================== */
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

/* ================== REDIS (UPSTASH SAFE CONFIG) ================== */
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    tls: true,
    rejectUnauthorized: false,
    reconnectStrategy: retries => Math.min(retries * 100, 3000),
  },
});

/* Prevent Node crash */
redis.on('error', err => {
  console.error('❌ Redis error:', err.message);
});

/* Connect Redis */
(async () => {
  try {
    await redis.connect();
    console.log('✅ Redis connected');
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
  }
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

/* ================== HEALTH CHECK ================== */
app.get('/api/healthz', async (req, res) => {
  try {
    await redis.ping();
    res.status(200).json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* ================== CREATE PASTE ================== */
app.post('/api/pastes', async (req, res) => {
  try {
    const { content, ttl_seconds, max_views } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content must be a non-empty string' });
    }

    if (ttl_seconds !== undefined && (!Number.isInteger(ttl_seconds) || ttl_seconds < 1)) {
      return res.status(400).json({ error: 'ttl_seconds must be integer >= 1' });
    }

    if (max_views !== undefined && (!Number.isInteger(max_views) || max_views < 1)) {
      return res.status(400).json({ error: 'max_views must be integer >= 1' });
    }

    const id = uuidv4().slice(0, 8);
    const key = `paste:${id}`;
    const createdAt = Date.now();

    await redis.hSet(key, {
      content: content.trim(),
      created_at: createdAt,
      ttl_seconds: ttl_seconds ?? '',
      max_views: max_views ?? '',
      views: 0,
    });

    if (ttl_seconds) {
      await redis.expire(key, ttl_seconds);
    }

    const baseUrl = req.get('host')?.includes('localhost')
      ? 'http://localhost:3000'
      : `https://${req.get('host')}`;

    res.status(201).json({
      id,
      url: `${baseUrl}/p/${id}`,
    });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ================== FETCH PASTE (API) ================== */
app.get('/api/pastes/:id', async (req, res) => {
  try {
    const key = `paste:${req.params.id}`;
    const paste = await redis.hGetAll(key);

    if (!paste || !paste.content) {
      return res.status(404).json({ error: 'Paste not found' });
    }

    const createdAt = Number(paste.created_at);
    const ttl = paste.ttl_seconds ? Number(paste.ttl_seconds) : null;
    const maxViews = paste.max_views ? Number(paste.max_views) : null;
    const views = Number(paste.views);
    const currentTime = now(req);

    if (ttl && currentTime >= createdAt + ttl * 1000) {
      await redis.del(key);
      return res.status(404).json({ error: 'Paste expired' });
    }

    if (maxViews && views >= maxViews) {
      await redis.del(key);
      return res.status(404).json({ error: 'View limit exceeded' });
    }

    const newViews = await redis.hIncrBy(key, 'views', 1);

    res.json({
      content: paste.content,
      remaining_views: maxViews ? Math.max(maxViews - newViews, 0) : null,
      expires_at: ttl ? new Date(createdAt + ttl * 1000).toISOString() : null,
    });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ================== VIEW PASTE (HTML) ================== */
app.get('/p/:id', async (req, res) => {
  try {
    const key = `paste:${req.params.id}`;
    const paste = await redis.hGetAll(key);

    if (!paste || !paste.content) {
      return res.status(404).send('<h1>404 - Paste not found</h1>');
    }

    const createdAt = Number(paste.created_at);
    const ttl = paste.ttl_seconds ? Number(paste.ttl_seconds) : null;
    const maxViews = paste.max_views ? Number(paste.max_views) : null;
    const views = Number(paste.views);
    const currentTime = now(req);

    if (ttl && currentTime >= createdAt + ttl * 1000) {
      await redis.del(key);
      return res.status(404).send('<h1>404 - Paste expired</h1>');
    }

    if (maxViews && views >= maxViews) {
      await redis.del(key);
      return res.status(404).send('<h1>404 - View limit exceeded</h1>');
    }

    const newViews = await redis.hIncrBy(key, 'views', 1);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Paste ${req.params.id}</title>
        <style>
          body { max-width: 800px; margin: 40px auto; font-family: monospace; }
          pre { background: #f4f4f4; padding: 20px; white-space: pre-wrap; }
        </style>
      </head>
      <body>
        <h1>Paste</h1>
        <pre>${escapeHtml(paste.content)}</pre>
        <p>
          Views: ${newViews}${maxViews ? ` / ${maxViews}` : ''}<br/>
          Expires: ${ttl ? new Date(createdAt + ttl * 1000).toLocaleString() : 'Never'}
        </p>
      </body>
      </html>
    `);
  } catch {
    res.status(500).send('<h1>Server error</h1>');
  }
});

/* ================== START SERVER ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
