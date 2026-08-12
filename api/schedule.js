import crypto from 'node:crypto';

const SPREADSHEET_ID = '1h5BOwltCQOrsfcxoaAwIkNHtbKmgzDAR-f0RKUA6ZzY';
const RANGE = "'2026 Fall'!A5:C23";
const base64url = value => Buffer.from(value).toString('base64url');

async function googleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('Google service account is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  return (await response.json()).access_token;
}

const serialToISO = serial => {
  const date = new Date(Date.UTC(1899, 11, 30) + Number(serial) * 86400000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  try {
    const token = await googleAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Google Sheets read failed (${response.status})`);
    const rows = (await response.json()).values || [];
    const events = rows
      .map(([date, title, summary]) => ({
        date: serialToISO(date),
        title: String(title || '').trim(),
        summary: String(summary || '').trim()
      }))
      .filter(event => event.date && event.title)
      .sort((a, b) => a.date.localeCompare(b.date));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ ok: true, events });
  } catch (error) {
    console.error('ECCM schedule read failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ ok: false, events: [] });
  }
}
