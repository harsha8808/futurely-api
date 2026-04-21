// ============================================================
//  Futurely — Cloudflare Worker API
//  Delivery channels: Email (Resend) · Telegram (Bot API)
//
//  Routes:
//    POST   /api/waitlist             → join waitlist
//    POST   /api/auth/request         → request 6-digit pin
//    POST   /api/auth/verify          → verify pin & get userId
//    POST   /api/letters              → create / save draft (Auth required)
//    GET    /api/letters              → list user's letters (Auth required)
//    GET    /api/letters/:id          → get single letter (Auth required)
//    PATCH  /api/letters/:id/seal     → seal a letter (Auth required)
//    DELETE /api/letters/:id          → delete draft (Auth required)
//    GET    /api/vault/stats          → vault summary stats (Auth required)
//
//  Secrets (set via: wrangler secret put <NAME>):
//    RESEND_API_KEY       → resend.com
//    FROM_EMAIL           → e.g. letters@futurely.unbeated.com
//    TELEGRAM_BOT_TOKEN   → from @BotFather on Telegram
// ============================================================

// ─── Helpers ─────────────────────────────────────────────────

const uuid = () => crypto.randomUUID();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

const error = (msg, status = 400) => json({ success: false, error: msg }, status);
const ok    = (data)              => json({ success: true, ...data });

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  
  // Whitelist: Main site, pages.dev previews, and local development
  const isAllowed = origin && (
    origin === 'https://futurely.unbeated.com' ||
    origin.endsWith('.futurely-unbeated.pages.dev') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1')
  );
  
  const corsOrigin = isAllowed ? origin : 'https://futurely.unbeated.com';
  
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin' // Important when using dynamic Origin
  };
}

function applyCors(response, request, env) {
  const headers = new Headers(response.headers);
  const cors = getCorsHeaders(request, env);
  Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { 
    status: response.status, 
    statusText: response.statusText, 
    headers 
  });
}

// ─── Router ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    console.log(`[Worker] ${method} ${path} (Origin: ${origin})`);

    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: getCorsHeaders(request, env) });
    }

    // Safety Check for DB
    if (!env.DB) {
      return applyCors(error("D1 Database 'DB' not found. Check your bindings in Cloudflare.", 500), request, env);
    }

    const authHeader = request.headers.get('Authorization') || '';
    const userId     = authHeader.replace('Bearer ', '').trim();

    let response;
    try {
      if      (path === '/api/waitlist'     && method === 'POST')   response = await handleWaitlist(request, env);
      else if (path === '/api/auth/request' && method === 'POST')   response = await handleAuthRequest(request, env);
      else if (path === '/api/auth/verify'  && method === 'POST')   response = await handleAuthVerify(request, env);
      
      // Protected Routes
      else if (path === '/api/letters' && method === 'POST') {
        if (!userId) return error('Unauthorized', 401);
        response = await createLetter(request, env, userId);
      }
      else if (path === '/api/letters' && method === 'GET') {
        if (!userId) return error('Unauthorized', 401);
        response = await listLetters(env, userId, url);
      }
      else if (path.match(/^\/api\/letters\/[\w-]+$/) && method === 'GET') {
        if (!userId) return error('Unauthorized', 401);
        const id = path.split('/').pop();
        response = await getLetter(id, env, userId);
      }
      else if (path.match(/^\/api\/letters\/[\w-]+\/seal$/) && method === 'PATCH') {
        if (!userId) return error('Unauthorized', 401);
        const id = path.split('/')[3];
        response = await sealLetter(id, env, userId);
      }
      else if (path.match(/^\/api\/letters\/[\w-]+$/) && method === 'DELETE') {
        if (!userId) return error('Unauthorized', 401);
        const id = path.split('/').pop();
        response = await deleteLetter(id, env, userId);
      }
      else if (path === '/api/vault/stats' && method === 'GET') {
        if (!userId) return error('Unauthorized', 401);
        response = await vaultStats(env, userId);
      }
      else response = error('Route not found', 404);
    } catch (e) {
      console.error('[Worker]', e);
      response = error('Internal server error: ' + e.message, 500);
    }

    return applyCors(response, request, env);
  },

  // Runs daily via Cron Trigger: "0 8 * * *"
  async scheduled(event, env) {
    await deliverDueLetters(env);
  }
};

// ─── Waitlist ─────────────────────────────────────────────────

async function handleWaitlist(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.email) return error('Email is required');

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(body.email)) return error('Invalid email');

  try {
    await env.DB.prepare(`INSERT INTO waitlist (id, email, name) VALUES (?, ?, ?)`)
      .bind(uuid(), body.email.toLowerCase().trim(), body.name || null).run();
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return ok({ message: "You're already on the waitlist!" });
    throw e;
  }

  return ok({ message: "Welcome to Futurely! We'll be in touch soon." });
}

// ─── Authentication ──────────────────────────────────────────

async function handleAuthRequest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.email) return error('Email is required');

  const email = body.email.toLowerCase().trim();
  const pin   = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit pin
  const exp   = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 mins

  // Store pin
  await env.DB.prepare(`
    INSERT INTO auth_codes (email, code, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at
  `).bind(email, pin, exp).run();

  // Send Pin via Email
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          from:    env.FROM_EMAIL || 'Futurely <auth@futurely.unbeated.com>',
          to:      [email],
          subject: `✦ Your Futurely access code: ${pin}`,
          html:    `<div style="font-family:Georgia,serif; color:#0f172a; padding:20px; border-top:3px solid #3b82f6; background:#f8fafc;">
                      <p>Your 6-digit access code for <strong>Futurely</strong> is:</p>
                      <h1 style="letter-spacing:0.2em; color:#3b82f6;">${pin}</h1>
                      <p style="font-size:0.9rem; color:#64748b;">It will expire in 10 minutes.</p>
                    </div>`
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error('[Auth] Resend API Error:', res.status, errorText);
      }
    } catch (e) {
      console.error('[Auth] Fetch to Resend failed:', e.message);
    }
  }

  return ok({ message: "Access code sent to your email." });
}

async function handleAuthVerify(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.email || !body?.code) return error('Email and code are required');

  const email = body.email.toLowerCase().trim();
  const now   = new Date().toISOString();

  const record = await env.DB.prepare(`
    SELECT * FROM auth_codes WHERE email = ? AND code = ? AND expires_at > ?
  `).bind(email, body.code, now).first();

  if (!record) return error('Invalid or expired code', 401);

  // Success: Clear code
  await env.DB.prepare(`DELETE FROM auth_codes WHERE email = ?`).bind(email).run();

  // Get or Create User
  let user = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (!user) {
    const newUserId = uuid();
    await env.DB.prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).bind(newUserId, email).run();
    user = { id: newUserId };
  }

  return ok({ userId: user.id, message: "Login successful" });
}

// ─── Letters ─────────────────────────────────────────────────

async function createLetter(request, env, userId) {
  const body = await request.json().catch(() => null);
  if (!body?.body)      return error('Letter body is required');
  if (!body?.deliverOn) return error('deliverOn date is required');

  const deliverDate = new Date(body.deliverOn);
  if (isNaN(deliverDate.getTime()) || deliverDate <= new Date()) {
    return error('deliverOn must be a future date');
  }

  // Validate channel
  const channel       = body.deliveryChannel || 'email';
  const validChannels = ['email', 'telegram'];
  if (!validChannels.includes(channel)) {
    return error(`Invalid deliveryChannel. Must be one of: ${validChannels.join(', ')}`);
  }

  // Validate channel-specific recipient
  if (channel === 'email' && !body.recipientEmail) {
    return error('recipientEmail is required for email delivery');
  }
  if (channel === 'telegram' && !body.recipientTelegram) {
    return error('recipientTelegram is required (e.g. @username or numeric chat_id)');
  }

  const id = body.id || uuid();
  const res = await env.DB.prepare(`
    INSERT INTO letters
      (id, user_id, status, salutation, body, sign_off,
       font_family, font_size, paper_style,
       delivery_channel, recipient_name,
       recipient_email, recipient_telegram, deliver_on)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      salutation = excluded.salutation,
      body = excluded.body,
      sign_off = excluded.sign_off,
      font_family = excluded.font_family,
      font_size = excluded.font_size,
      paper_style = excluded.paper_style,
      delivery_channel = excluded.delivery_channel,
      recipient_name = excluded.recipient_name,
      recipient_email = excluded.recipient_email,
      recipient_telegram = excluded.recipient_telegram,
      deliver_on = excluded.deliver_on
    WHERE user_id = ? AND status = 'draft'
  `).bind(
    id, userId,
    body.salutation        || 'Dear future me,',
    body.body,
    body.signOff           || '— Your past self',
    body.fontFamily        || 'EB Garamond, serif',
    body.fontSize          || 16,
    body.paperStyle        || 'lined',
    channel,
    body.recipientName     || null,
    body.recipientEmail    || null,
    body.recipientTelegram || null,
    body.deliverOn,
    userId // for the WHERE clause in the ON CONFLICT
  ).run();

  if (body.id && res.changes === 0) {
    return error('Letter not found or already sealed/delivered', 404);
  }

  return ok({ letterId: id, message: body.id ? 'Draft updated.' : 'Letter saved as draft.' });
}

async function listLetters(env, userId, url) {
  const status = url.searchParams.get('status');
  let query    = `SELECT * FROM letters WHERE user_id = ?`;
  const binds  = [userId];

  if (status) { query += ` AND status = ?`; binds.push(status); }
  query += ` ORDER BY created_at DESC`;

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return ok({ letters: results, count: results.length });
}

async function getLetter(id, env, userId) {
  const letter = await env.DB.prepare(`SELECT * FROM letters WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!letter) return error('Letter not found', 404);
  return ok({ letter });
}

async function sealLetter(id, env, userId) {
  const letter = await env.DB.prepare(`SELECT * FROM letters WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!letter)                       return error('Letter not found', 404);
  if (letter.status === 'sealed')    return error('Letter is already sealed');
  if (letter.status === 'delivered') return error('Letter has already been delivered');
  if (!letter.body?.trim())          return error('Cannot seal an empty letter');

  await env.DB.prepare(
    `UPDATE letters SET status = 'sealed', sealed_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  return ok({
    message: `Letter sealed! It will arrive via ${letter.delivery_channel} on ${letter.deliver_on}`
  });
}

async function deleteLetter(id, env, userId) {
  const letter = await env.DB.prepare(`SELECT * FROM letters WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!letter) return error('Letter not found', 404);
  if (letter.status === 'sealed') {
    return error('Sealed letters cannot be deleted — they are locked in the vault.');
  }
  await env.DB.prepare(`DELETE FROM letters WHERE id = ?`).bind(id).run();
  return ok({ message: 'Draft deleted.' });
}

async function vaultStats(env, userId) {
  const [total, sealed, delivered, draft, next] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as n FROM letters WHERE user_id = ?`).bind(userId).first(),
    env.DB.prepare(`SELECT COUNT(*) as n FROM letters WHERE user_id = ? AND status = 'sealed'`).bind(userId).first(),
    env.DB.prepare(`SELECT COUNT(*) as n FROM letters WHERE user_id = ? AND status = 'delivered'`).bind(userId).first(),
    env.DB.prepare(`SELECT COUNT(*) as n FROM letters WHERE user_id = ? AND status = 'draft'`).bind(userId).first(),
    env.DB.prepare(`
      SELECT deliver_on, salutation, delivery_channel FROM letters
      WHERE user_id = ? AND status = 'sealed'
      ORDER BY deliver_on ASC LIMIT 1
    `).bind(userId).first(),
  ]);

  return ok({
    stats: {
      total:       total?.n     || 0,
      sealed:      sealed?.n    || 0,
      delivered:   delivered?.n || 0,
      draft:       draft?.n     || 0,
      nextDelivery: next        || null,
    }
  });
}

// ─── Delivery Engine ─────────────────────────────────────────

async function deliverDueLetters(env) {
  const today = new Date().toISOString().slice(0, 10);

  const { results: due } = await env.DB.prepare(
    `SELECT * FROM letters WHERE status = 'sealed' AND deliver_on <= ?`
  ).bind(today).all();

  console.log(`[Delivery] ${due.length} letter(s) due on ${today}`);

  for (const letter of due) {
    let success = false;
    let errMsg  = null;

    try {
      switch (letter.delivery_channel) {
        case 'email':    await sendViaEmail(letter, env);    break;
        case 'telegram': await sendViaTelegram(letter, env); break;
        default: throw new Error(`Unknown channel: ${letter.delivery_channel}`);
      }

      success = true;

      await env.DB.prepare(
        `UPDATE letters SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`
      ).bind(letter.id).run();

      console.log(`[Delivery] ✓ ${letter.id} via ${letter.delivery_channel}`);
    } catch (e) {
      errMsg = e.message;
      console.error(`[Delivery] ✗ ${letter.id}:`, e.message);
    }

    // Always log the attempt
    await env.DB.prepare(
      `INSERT INTO delivery_log (id, letter_id, channel, success, error_msg) VALUES (?, ?, ?, ?, ?)`
    ).bind(uuid(), letter.id, letter.delivery_channel, success ? 1 : 0, errMsg).run();
  }
}

// ─── Channel: Email via Resend ────────────────────────────────

async function sendViaEmail(letter, env) {
  if (!env.RESEND_API_KEY)     throw new Error('RESEND_API_KEY not set');
  if (!letter.recipient_email) throw new Error('No recipient_email on letter');

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    env.FROM_EMAIL || 'Futurely <letters@futurely.unbeated.com>',
      to:      [letter.recipient_email],
      subject: `✦ A letter from your past has arrived`,
      html:    buildEmailHTML(letter),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}

function buildEmailHTML(letter) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{background:#ffffff;margin:0;padding:40px 20px;font-family:Georgia,serif;}
  .wrap{max-width:600px;margin:0 auto;}
  .header{text-align:center;margin-bottom:32px;}
  .logo{color:#3b82f6;font-size:28px;font-style:italic;letter-spacing:0.1em;}
  .tagline{color:#2563eb;font-size:11px;letter-spacing:0.3em;text-transform:uppercase;margin-top:6px;}
  .gold-line{height:1px;background:linear-gradient(90deg,transparent,#3b82f6,transparent);margin:20px 0;}
  .paper{background:#f8fafc;padding:48px 52px;border-top:3px solid #3b82f6;box-shadow:0 10px 30px rgba(0,0,0,0.05);}
  .to-label{font-size:11px;letter-spacing:0.25em;color:#2563eb;text-transform:uppercase;margin-bottom:20px;font-family:monospace;}
  .body{font-size:16px;line-height:2.1;color:#0f172a;white-space:pre-wrap;}
  .sig{font-size:20px;font-style:italic;color:#2563eb;margin-top:28px;}
  .footer{text-align:center;margin-top:32px;}
  .footer p{color:#94a3b8;font-size:11px;letter-spacing:0.15em;font-family:monospace;text-transform:uppercase;}
  .footer a{color:#3b82f6;text-decoration:none;}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">Futurely</div>
    <div class="tagline">A letter from your past has arrived</div>
    <div class="gold-line"></div>
  </div>
  <div class="paper">
    <div class="to-label">${letter.salutation || 'Dear future me,'}</div>
    <div class="body">${escapeHtml(letter.body)}</div>
    <div class="sig">${escapeHtml(letter.sign_off || '— Your past self')}</div>
  </div>
  <div class="footer">
    <div class="gold-line"></div>
    <p>Delivered by <a href="https://futurely.unbeated.com">Futurely</a>
       &nbsp;·&nbsp; Written ${letter.created_at?.slice(0,10)}
       &nbsp;·&nbsp; Delivered today</p>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Channel: Telegram via Bot API ───────────────────────────

async function sendViaTelegram(letter, env) {
  if (!env.TELEGRAM_BOT_TOKEN)    throw new Error('TELEGRAM_BOT_TOKEN not set');
  if (!letter.recipient_telegram) throw new Error('No recipient_telegram on letter');

  const MAX     = 3800; // Telegram max is 4096 chars
  let   body    = letter.body || '';
  if (body.length > MAX) body = body.slice(0, MAX) + '…';

  const message = [
    `✦ *Futurely* — A letter from your past has arrived`,
    ``,
    `_${letter.salutation || 'Dear future me,'}_`,
    ``,
    body,
    ``,
    `_${letter.sign_off || '— Your past self'}_`,
    ``,
    `*Written:* ${letter.created_at?.slice(0,10)}`,
    `[futurely\\.unbeated\\.com](https://futurely.unbeated.com)`,
  ].join('\n');

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    letter.recipient_telegram,
        text:       message,
        parse_mode: 'MarkdownV2',
      }),
    }
  );

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${data.description}`);
}
