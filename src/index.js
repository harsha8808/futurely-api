// ============================================================
//  Futurely — Cloudflare Worker API
//  Delivery channels: Email (Resend) · Telegram (Bot API)
//
//  Routes:
//    POST   /api/waitlist             → join waitlist
//    POST   /api/letters              → create / save draft
//    GET    /api/letters?userId=      → list user's letters
//    GET    /api/letters/:id          → get single letter
//    PATCH  /api/letters/:id/seal     → seal a letter
//    DELETE /api/letters/:id          → delete draft
//    GET    /api/vault/stats?userId=  → vault summary stats
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

function corsHeaders(origin, env) {
  const allowed   = env.CORS_ORIGIN || 'https://futurely.unbeated.com';
  const isAllowed = origin === allowed || origin?.endsWith('.unbeated.com');
  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
  };
}

function withCors(response, origin, env) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(origin, env)).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}

// ─── Router ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    let response;
    try {
      if      (path === '/api/waitlist'  && method === 'POST')   response = await handleWaitlist(request, env);
      else if (path === '/api/letters'   && method === 'POST')   response = await createLetter(request, env);
      else if (path === '/api/letters'   && method === 'GET')    response = await listLetters(url, env);
      else if (path.match(/^\/api\/letters\/[\w-]+$/) && method === 'GET')    { const id = path.split('/').pop(); response = await getLetter(id, env); }
      else if (path.match(/^\/api\/letters\/[\w-]+\/seal$/) && method === 'PATCH') { const id = path.split('/')[3]; response = await sealLetter(id, env); }
      else if (path.match(/^\/api\/letters\/[\w-]+$/) && method === 'DELETE') { const id = path.split('/').pop(); response = await deleteLetter(id, env); }
      else if (path === '/api/vault/stats' && method === 'GET')  response = await vaultStats(url, env);
      else response = error('Route not found', 404);
    } catch (e) {
      console.error('[Worker]', e);
      response = error('Internal server error', 500);
    }

    return withCors(response, origin, env);
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

// ─── Letters ─────────────────────────────────────────────────

async function createLetter(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.userId)    return error('userId is required');
  if (!body?.body)      return error('Letter body is required');
  if (!body?.deliverOn) return error('deliverOn date is required');

  const deliverDate = new Date(body.deliverOn);
  if (isNaN(deliverDate) || deliverDate <= new Date()) {
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

  const id = uuid();
  await env.DB.prepare(`
    INSERT INTO letters
      (id, user_id, status, salutation, body, sign_off,
       font_family, font_size, paper_style,
       delivery_channel, recipient_name,
       recipient_email, recipient_telegram, deliver_on)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, body.userId,
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
    body.deliverOn
  ).run();

  return ok({ letterId: id, message: 'Letter saved as draft.' });
}

async function listLetters(url, env) {
  const userId = url.searchParams.get('userId');
  if (!userId) return error('userId is required');

  const status = url.searchParams.get('status');
  let query    = `SELECT * FROM letters WHERE user_id = ?`;
  const binds  = [userId];

  if (status) { query += ` AND status = ?`; binds.push(status); }
  query += ` ORDER BY created_at DESC`;

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return ok({ letters: results, count: results.length });
}

async function getLetter(id, env) {
  const letter = await env.DB.prepare(`SELECT * FROM letters WHERE id = ?`).bind(id).first();
  if (!letter) return error('Letter not found', 404);
  return ok({ letter });
}

async function sealLetter(id, env) {
  const letter = await env.DB.prepare(`SELECT * FROM letters WHERE id = ?`).bind(id).first();
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

async function deleteLetter(id, env) {
  const letter = await env.DB.prepare(`SELECT * FROM letters WHERE id = ?`).bind(id).first();
  if (!letter) return error('Letter not found', 404);
  if (letter.status === 'sealed') {
    return error('Sealed letters cannot be deleted — they are locked in the vault.');
  }
  await env.DB.prepare(`DELETE FROM letters WHERE id = ?`).bind(id).run();
  return ok({ message: 'Draft deleted.' });
}

async function vaultStats(url, env) {
  const userId = url.searchParams.get('userId');
  if (!userId) return error('userId is required');

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
  body{background:#0b0f1a;margin:0;padding:40px 20px;font-family:Georgia,serif;}
  .wrap{max-width:600px;margin:0 auto;}
  .header{text-align:center;margin-bottom:32px;}
  .logo{color:#d4a843;font-size:28px;font-style:italic;letter-spacing:0.1em;}
  .tagline{color:#7a5f22;font-size:11px;letter-spacing:0.3em;text-transform:uppercase;margin-top:6px;}
  .gold-line{height:1px;background:linear-gradient(90deg,transparent,#d4a843,transparent);margin:20px 0;}
  .paper{background:#f7f0e0;padding:48px 52px;border-top:3px solid #d4a843;}
  .to-label{font-size:11px;letter-spacing:0.25em;color:#7a5f22;text-transform:uppercase;margin-bottom:20px;font-family:monospace;}
  .body{font-size:16px;line-height:2.1;color:#1a1008;white-space:pre-wrap;}
  .sig{font-size:20px;font-style:italic;color:#7a5f22;margin-top:28px;}
  .footer{text-align:center;margin-top:32px;}
  .footer p{color:#2a3a5c;font-size:11px;letter-spacing:0.15em;font-family:monospace;text-transform:uppercase;}
  .footer a{color:#7a5f22;text-decoration:none;}
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
