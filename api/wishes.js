// Vercel/Netlify-style serverless function (Node.js)
// - GET  /api/wishes?limit=30
// - POST /api/wishes { name, message }
//
// IMPORTANT: set DATABASE_URL as an environment variable in your hosting platform.
// Do NOT commit secrets.

const postgres = require('postgres');

const MAX_NAME = 40;
const MAX_MESSAGE = 240;
const MAX_IMAGE_URL = 800;

function asInt(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v || ''), 10);
  return Number.isFinite(n) ? n : NaN;
}

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const err = new Error('Missing DATABASE_URL env var');
    err.statusCode = 500;
    throw err;
  }

  return postgres(url, {
    ssl: 'require',
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15
  });
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS wishes (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  await sql`
    ALTER TABLE wishes
    ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
  `;
  await sql`
    ALTER TABLE wishes
    ADD COLUMN IF NOT EXISTS hearts_count INT NOT NULL DEFAULT 0;
  `;
  await sql`CREATE INDEX IF NOT EXISTS wishes_created_at_idx ON wishes (created_at DESC);`;
  await sql`CREATE INDEX IF NOT EXISTS wishes_created_at_id_idx ON wishes (created_at DESC, id DESC);`;

  // Helpful for Vercel logs: confirms schema ran and which DB/schema it hit.
  try {
    const info = await sql`SELECT current_database() AS db, current_schema() AS schema;`;
    console.log('[wishes] schema ensured', info[0]);
  } catch (_) {
    // ignore logging failures
  }
}

function encodeCursor(row) {
  if (!row || !row.created_at || row.id == null) return null;
  const raw = `${new Date(row.created_at).toISOString()}|${String(row.id)}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  let raw;
  try {
    raw = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const [iso, idStr] = raw.split('|');
  if (!iso || !idStr) return null;
  const date = new Date(iso);
  const id = Number(idStr);
  if (!Number.isFinite(id) || Number.isNaN(date.getTime())) return null;
  return { createdAt: date.toISOString(), id };
}

function safeText(v, maxLen) {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safeUrl(v, maxLen) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

module.exports = async (req, res) => {
  withCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  let sql;
  try {
    sql = getSql();
    await ensureSchema(sql);

    // Optional: quick health check for deployment/debugging
    if (req.method === 'GET' && req.query && (req.query.ping === '1' || req.query.ping === 'true')) {
      const info = await sql`SELECT current_database() AS db, current_schema() AS schema;`;
      const tbl = await sql`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name = 'wishes'
        ) AS exists;
      `;
      const count = await sql`SELECT COUNT(*)::int AS count FROM wishes;`;

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, db: info[0]?.db, schema: info[0]?.schema, wishesTable: !!tbl[0]?.exists, count: count[0]?.count }));
      return;
    }

    if (req.method === 'GET') {
      const limitRaw = (req.query && req.query.limit) || '30';
      const limit = Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 30));

      const cursorRaw = req.query && (req.query.cursor || req.query.before);
      const cursor = decodeCursor(cursorRaw);

      let rows;
      if (cursor) {
        rows = await sql`
          SELECT id, name, message, image_url, hearts_count, created_at
          FROM wishes
          WHERE (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::bigint)
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `;
      } else {
        rows = await sql`
          SELECT id, name, message, image_url, hearts_count, created_at
          FROM wishes
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `;
      }

      const nextCursor = rows.length ? encodeCursor(rows[rows.length - 1]) : null;
      const hasMore = rows.length === limit;

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify({ wishes: rows, nextCursor, hasMore }));
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
      if (action === 'like') {
        const id = asInt(body.id ?? body.wishId);
        if (!Number.isFinite(id)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Valid id is required' }));
          return;
        }

        const updated = await sql`
          UPDATE wishes
          SET hearts_count = hearts_count + 1
          WHERE id = ${id}::bigint
          RETURNING id, name, message, image_url, hearts_count, created_at
        `;
        if (!updated.length) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Wish not found' }));
          return;
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;
        res.end(JSON.stringify({ wish: updated[0] }));
        return;
      }

      const name = safeText(body.name || '', MAX_NAME);
      const message = safeText(body.message || '', MAX_MESSAGE);
      const imageUrl = safeUrl(body.imageUrl || body.image_url || '', MAX_IMAGE_URL);

      if (!message) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Message is required' }));
        return;
      }

      const inserted = await sql`
        INSERT INTO wishes (name, message, image_url)
        VALUES (${name}, ${message}, ${imageUrl})
        RETURNING id, name, message, image_url, hearts_count, created_at
      `;

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 201;
      res.end(JSON.stringify({ wish: inserted[0] }));
      return;
    }

    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (e) {
    const status = e && (e.statusCode || e.status) ? (e.statusCode || e.status) : 500;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Server error', detail: String(e && e.message ? e.message : e) }));
  } finally {
    if (sql) {
      try { await sql.end({ timeout: 1 }); } catch (_) { /* ignore */ }
    }
  }
};
