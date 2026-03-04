export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, videoId } = req.body;

    // If videoId provided, fetch transcript server-side (no CORS issues)
    if (videoId) {
      const transcript = await fetchTranscriptServerSide(videoId);
      return res.status(200).json({ transcript });
    }

    if (!prompt) return res.status(400).json({ error: 'No prompt provided' });

    const apiKey = process.env.ANTHROPIC_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY not set in Vercel environment variables' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function fetchTranscriptServerSide(videoId) {
  const langs = ['en', 'en-US', 'en-GB', 'a.en', 'hi', 'a.hi', 'hi-IN'];

  for (const lang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&fmt=json3`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
        }
      });

      if (!res.ok) continue;
      const data = await res.json();
      if (!data.events) continue;

      const lines = data.events
        .filter(e => e.segs && e.tStartMs != null)
        .map(e => {
          const secs = Math.floor(e.tStartMs / 1000);
          const m = Math.floor(secs / 60);
          const s = secs % 60;
          const ts = `${m}:${String(s).padStart(2, '0')}`;
          const text = e.segs.map(s => s.utf8 || '').join('').trim();
          return text ? `[${ts}] ${text}` : null;
        })
        .filter(Boolean);

      if (lines.length > 10) {
        return { type: 'timed', text: lines.join('\n'), source: `captions (${lang})` };
      }
    } catch (e) { continue; }
  }

  // Fallback: scrape title + description
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const html = await res.text();
    const titleMatch = html.match(/"title":"([^"]{5,200})"/);
    const descMatch = html.match(/"shortDescription":"([\s\S]{10,2000})"/);
    const title = titleMatch ? titleMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : '';
    const desc = descMatch ? descMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').slice(0, 1500) : '';
    if (title.length > 3) {
      return { type: 'meta', text: `VIDEO TITLE: ${title}\n\nDESCRIPTION: ${desc}`, source: 'title+description' };
    }
  } catch (e) {}

  return { type: 'none', text: null, source: 'unavailable' };
}
