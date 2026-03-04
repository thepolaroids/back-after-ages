export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId, prompt } = req.body || {};

  // ── MODE 1: Fetch transcript server-side (no CORS restrictions) ──
  if (videoId && !prompt) {
    const transcript = await fetchTranscript(videoId);
    return res.status(200).json({ transcript });
  }

  // ── MODE 2: Call Claude API ──
  if (prompt) {
    const apiKey = process.env.ANTHROPIC_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY not configured in Vercel' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    return res.status(200).json(data);
  }

  return res.status(400).json({ error: 'Provide either videoId or prompt' });
}

// ── TRANSCRIPT FETCHER ─────────────────────────────────────────────────────
async function fetchTranscript(videoId) {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
  };

  // Try captions in priority order: auto-generated Hindi, manual Hindi, English variants
  const langs = ['a.hi', 'hi', 'hi-IN', 'a.en', 'en', 'en-US', 'en-GB'];

  for (const lang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&fmt=json3`;
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) continue;

      const data = await res.json();
      if (!data.events || data.events.length < 5) continue;

      // Build timed transcript [MM:SS] text
      const lines = data.events
        .filter(e => e.segs && e.tStartMs != null)
        .map(e => {
          const secs = Math.floor(e.tStartMs / 1000);
          const mm = Math.floor(secs / 60);
          const ss = String(secs % 60).padStart(2, '0');
          const text = e.segs.map(s => s.utf8 || '').join('').trim().replace(/\n/g, ' ');
          return text ? `[${mm}:${ss}] ${text}` : null;
        })
        .filter(Boolean);

      if (lines.length > 10) {
        return { type: 'timed', lang, text: lines.join('\n'), source: `captions (${lang})` };
      }
    } catch (e) { continue; }
  }

  // Fallback: scrape page for title + description
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: HEADERS });
    const html = await res.text();
    const title = (html.match(/"title":"([^"]{5,200})"/) || [])[1];
    const desc = (html.match(/"shortDescription":"([\s\S]{10,2000})"/) || [])[1];
    const clean = s => s ? s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\u([\da-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) : '';

    if (title) {
      return {
        type: 'meta',
        text: `TITLE: ${clean(title)}\nDESCRIPTION: ${clean(desc).slice(0, 1500)}`,
        source: 'title+description'
      };
    }
  } catch (e) {}

  return { type: 'none', text: null, source: 'unavailable' };
}
