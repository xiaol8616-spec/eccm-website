import crypto from 'node:crypto';

const MAX = { name: 80, contact: 160, school: 120, attendance: 120, message: 800 };
const allowed = {
  faith: ['Christian', 'Exploring Christianity', 'Not sure', 'Prefer not to say'],
  ride: ['Yes', 'No', 'Not sure'],
  heard: ['Friend', 'Instagram', 'Flyer / Poster', 'Church', 'Other']
};
const labels = {
  faith: { Christian: '我是基督徒', 'Exploring Christianity': '正在了解基督信仰', 'Not sure': '还不确定', 'Prefer not to say': '暂不回答' },
  ride: { Yes: '需要', No: '不需要', 'Not sure': '还不确定' },
  heard: { Friend: '朋友介绍', Instagram: 'Instagram', 'Flyer / Poster': '海报', Church: '教会', Other: '其他' }
};
const recent = new Map();

const clean = (value, max) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
const safeCell = value => /^[=+\-@]/.test(value) ? `'${value}` : value;
const json = (res, status, body) => res.status(status).setHeader('Content-Type', 'application/json').end(JSON.stringify(body));
const base64url = value => Buffer.from(value).toString('base64url');

async function googleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('Google service account is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (body.website) return json(res, 200, { ok: true });
    if (!Number.isFinite(body.startedAt) || Date.now() - body.startedAt < 2500) return json(res, 400, { ok: false, message: 'Please check the form and try again.' });

    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const last = recent.get(ip) || 0;
    if (Date.now() - last < 30000) return json(res, 429, { ok: false, message: 'Please wait a moment before submitting again.' });

    const data = {
      name: clean(body.name, MAX.name), contact: clean(body.contact, MAX.contact), school: clean(body.school, MAX.school),
      faith: clean(body.faith, 40), ride: clean(body.ride, 20), attendance: clean(body.attendance, MAX.attendance),
      heard: clean(body.heard, 40), message: clean(body.message, MAX.message)
    };
    if (!data.name || data.contact.length < 3 || !data.school) return json(res, 400, { ok: false, message: 'Please complete your name, contact, and school.' });
    if ((data.faith && !allowed.faith.includes(data.faith)) || (data.ride && !allowed.ride.includes(data.ride)) || (data.heard && !allowed.heard.includes(data.heard))) {
      return json(res, 400, { ok: false, message: 'Please check the selected options.' });
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Google Sheet is not configured');
    const token = await googleAccessToken();
    const timestamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
    const values = [[timestamp, safeCell(data.name), safeCell(data.contact), safeCell(data.school), labels.faith[data.faith] || '', labels.ride[data.ride] || '', safeCell(data.attendance), labels.heard[data.heard] || '', safeCell(data.message), '', '新登记', '']];
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/Newcomers!A:L:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values })
    });
    if (!response.ok) throw new Error(`Google Sheets append failed (${response.status}): ${await response.text()}`);
    recent.set(ip, Date.now());
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('ECCM registration failed:', error instanceof Error ? error.message : error);
    return json(res, 500, { ok: false, message: 'Something went wrong. Please try again.' });
  }
}
