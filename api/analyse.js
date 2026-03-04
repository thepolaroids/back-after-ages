import { YoutubeTranscript } from 'youtube-transcript';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId, prompt } = req.body || {};

  // MODE 1: Fetch transcript
  if (videoId && !prompt) {
    const transcript = await fetchTranscript(videoId);
    return res.status(200).json({ transcript });
  }

  // MODE 2: Claude API
  if (prompt) {
    const apiKey = process.env.ANTHROPIC_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

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

  return res.status(400).json({ error: 'Provide videoId or prompt' });
}

async function fetchTranscript(videoId) {
  // Try Hindi first, then English
  const langGroups = [
    { langs: ['hi'], label: 'hi' },
    { langs: ['en'], label: 'en' },
  ];

  for (const { langs, label } of langGroups) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: langs[0] });
      if (!segments || segments.length < 5) continue;

      const lines = segments.map(s => {
        const secs = Math.floor(s.offset / 1000);
        const mm = Math.floor(secs / 60);
        const ss = String(secs % 60).padStart(2, '0');
        return `[${mm}:${ss}] ${s.text.trim().replace(/\n/g, ' ')}`;
      }).filter(l => l.length > 10);

      if (lines.length > 10) {
        return { type: 'timed', text: lines.join('\n'), source: `captions (${label})` };
      }
    } catch (e) { continue; }
  }

  // Fallback: scrape title + description
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await res.text();
    const title = (html.match(/"title":"([^"]{5,200})"/) || [])[1] || '';
    const desc  = (html.match(/"shortDescription":"([\s\S]{10,2000})"/) || [])[1] || '';
    const clean = s => s.replace(/\\n/g,' ').replace(/\\"/g,'"').replace(/\\u([\da-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
    if (title) return { type: 'meta', text: `TITLE: ${clean(title)}\nDESCRIPTION: ${clean(desc).slice(0,1500)}`, source: 'title+description' };
  } catch (e) {}

  return { type: 'none', text: null, source: 'unavailable' };
}
