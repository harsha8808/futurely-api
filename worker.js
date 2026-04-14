/**
 * Cloudflare Worker — AI Cold Email Tool
 *
 * Routes:
 *   GET  /test       — health check
 *   POST /generate   — AI writes cold email (free OpenRouter models)
 *   POST /send       — sends via Resend (email) or Telegram
 *
 * Environment variables:
 *   OPENROUTER_API_KEY — OpenRouter API key (free tier, no credits needed)
 *   RESEND_API_KEY     — Resend API key
 *   RESEND_FROM        — verified sender e.g. hello@unbeated.com
 *   TELEGRAM_BOT_TOKEN — Telegram bot token
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Free models tried in order — falls back down the list if one fails
const FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',        // Llama 3.3 70B — GPT-4 level, most reliable
  'google/gemma-3-27b-it:free',                    // Gemma 3 27B — strong general purpose
  'mistralai/mistral-small-3.1-24b-instruct:free', // Mistral Small 3.1
  'deepseek/deepseek-r1:free',                     // DeepSeek R1 — great reasoning
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── GET /test ────────────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/test') {
      return Response.json({ status: 'ok', message: 'Worker is running' }, { headers: CORS });
    }

    // ── POST /generate ──────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/generate') {
      try {
        if (!env.OPENROUTER_API_KEY) {
          return Response.json(
            { error: 'OPENROUTER_API_KEY is not set in Worker environment variables' },
            { status: 500, headers: CORS }
          );
        }

        const body = await request.json();
        const {
          prospectName,
          prospectRole,
          companyName,
          companyIndustry,
          painPoint,
          yourName,
          yourOffer,
          tone,
        } = body;

        if (!companyName || !yourOffer) {
          return Response.json(
            { error: 'Company name and your offer are required' },
            { status: 400, headers: CORS }
          );
        }

        const prompt = `Write a cold outreach email with these details:

Prospect Name: ${prospectName || 'there'}
Prospect Role: ${prospectRole || 'Decision Maker'}
Company: ${companyName}
Industry: ${companyIndustry || 'their industry'}
Their Pain Point: ${painPoint || 'growth and efficiency'}
Sender Name: ${yourName || 'Me'}
Offer/Value Proposition: ${yourOffer}
Tone: ${tone || 'professional and friendly'}

Requirements:
- Subject line that gets opened (not clickbait, genuinely relevant)
- Opening line that shows research about their company
- 2-3 sentences max on the pain point you solve
- Clear single call to action (15 min call or reply)
- Keep total email under 150 words
- No generic phrases like "I hope this email finds you well"
- No excessive flattery
- Sound human, not AI-written

Respond in this exact JSON format:
{
  "subject": "the subject line here",
  "body": "the full email body here with line breaks as \\n"
}

Reply with ONLY the JSON, no markdown, no explanation.`;

        // Try models in order until one works
        let raw = '';
        let lastError = '';

        for (const model of FREE_MODELS) {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
              'HTTP-Referer': 'https://unbeated.com',
              'X-Title': 'Cold Email Tool',
            },
            body: JSON.stringify({
              model: model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.8,
              max_tokens: 600,
            }),
          });

          if (!res.ok) {
            lastError = `${model} failed with status ${res.status}`;
            continue; // try next model
          }

          const data = await res.json();

          if (data.error) {
            lastError = `${model} error: ${data.error.message}`;
            continue;
          }

          raw = data?.choices?.[0]?.message?.content?.trim() || '';
          if (raw) break; // got a valid response, stop
        }

        if (!raw) {
          return Response.json(
            { error: 'All free models failed. Last error: ' + lastError },
            { status: 500, headers: CORS }
          );
        }

        // Parse JSON — strip markdown fences if present
        let email;
        try {
          const clean = raw.replace(/```json|```/g, '').trim();
          email = JSON.parse(clean);
        } catch {
          const subjectMatch = raw.match(/"subject"\s*:\s*"([^"]+)"/);
          const bodyMatch = raw.match(/"body"\s*:\s*"([\s\S]+?)"\s*}/);
          if (subjectMatch && bodyMatch) {
            email = {
              subject: subjectMatch[1],
              body: bodyMatch[1].replace(/\\n/g, '\n'),
            };
          } else {
            return Response.json(
              { error: 'Failed to parse response. Raw: ' + raw.slice(0, 200) },
              { status: 500, headers: CORS }
            );
          }
        }

        return Response.json(
          { success: true, subject: email.subject, body: email.body },
          { headers: CORS }
        );

      } catch (err) {
        return Response.json(
          { error: 'Generate failed: ' + err.message },
          { status: 500, headers: CORS }
        );
      }
    }

    // ── POST /send ──────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/send') {
      try {
        const body = await request.json();
        const { channel, subject, emailBody, toEmail, telegramChatId } = body;

        if (!subject || !emailBody) {
          return Response.json(
            { error: 'Subject and email body are required' },
            { status: 400, headers: CORS }
          );
        }

        // ── Email via Resend ─────────────────────────────────────────────────
        if (channel === 'email') {
          if (!toEmail) {
            return Response.json(
              { error: 'Recipient email is required' },
              { status: 400, headers: CORS }
            );
          }
          if (!env.RESEND_API_KEY) {
            return Response.json(
              { error: 'RESEND_API_KEY is not set in Worker environment variables' },
              { status: 500, headers: CORS }
            );
          }

          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: env.RESEND_FROM || 'Futurely <hello@unbeated.com>',
              to: [toEmail],
              subject: subject,
              text: emailBody,
              html: emailBody
                .split('\n')
                .map((l) => (l ? `<p>${l}</p>` : '<br/>'))
                .join(''),
            }),
          });

          const result = await res.json();
          if (!res.ok) {
            return Response.json(
              { error: 'Resend error: ' + (result.message || JSON.stringify(result)) },
              { status: 500, headers: CORS }
            );
          }

          return Response.json(
            { success: true, message: 'Email sent successfully!', id: result.id },
            { headers: CORS }
          );
        }

        // ── Telegram ─────────────────────────────────────────────────────────
        if (channel === 'telegram') {
          if (!telegramChatId) {
            return Response.json(
              { error: 'Telegram Chat ID is required' },
              { status: 400, headers: CORS }
            );
          }
          if (!env.TELEGRAM_BOT_TOKEN) {
            return Response.json(
              { error: 'TELEGRAM_BOT_TOKEN is not set in Worker environment variables' },
              { status: 500, headers: CORS }
            );
          }

          const message = `📧 *${subject}*\n\n${emailBody}`;
          const res = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: telegramChatId,
                text: message,
                parse_mode: 'Markdown',
              }),
            }
          );

          const result = await res.json();
          if (!result.ok) {
            return Response.json(
              { error: 'Telegram error: ' + result.description },
              { status: 500, headers: CORS }
            );
          }

          return Response.json(
            { success: true, message: 'Sent to Telegram successfully!' },
            { headers: CORS }
          );
        }

        return Response.json(
          { error: 'Invalid channel. Use email or telegram' },
          { status: 400, headers: CORS }
        );

      } catch (err) {
        return Response.json(
          { error: 'Send failed: ' + err.message },
          { status: 500, headers: CORS }
        );
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
