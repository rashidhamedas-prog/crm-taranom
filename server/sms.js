const https = require('https');

function postJSON(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendSMS(settings, to, text) {
  const provider = (settings.sms_provider || 'kavenegar').trim();
  const apiKey = (settings.sms_api_key || '').trim();
  const from = (settings.sms_from || '').trim();

  if (!apiKey || !to) return { ok: false, reason: 'missing api_key or phone' };

  // Normalize Iranian phone: ensure starts with 09
  const phone = String(to).replace(/\s+/g, '').replace(/^(\+98|98)/, '0');
  if (!/^09\d{9}$/.test(phone)) return { ok: false, reason: 'invalid phone: ' + phone };

  try {
    if (provider === 'kavenegar') {
      const r = await postJSON(
        'api.kavenegar.com',
        `/v1/${encodeURIComponent(apiKey)}/sms/send.json`,
        { receptor: phone, message: text, ...(from ? { sender: from } : {}) }
      );
      return { ok: r.status === 200, data: r.body };
    }

    if (provider === 'melipayamak') {
      // api_key field stores "username:password" for Melipayamak
      const [username = '', password = ''] = apiKey.split(':');
      const r = await postJSON(
        'rest.payamak-panel.com',
        '/api/SendSMS/SendSMS',
        { username, password, to: [phone], from, text, isFlash: false }
      );
      return { ok: r.status === 200, data: r.body };
    }

    if (provider === 'niksms') {
      // NikSMS REST API — api_key stores "username:password"
      const [username = '', password = ''] = apiKey.split(':');
      const r = await postJSON(
        'api.niksms.com',
        '/fa/api/sms/single',
        { username, password, textBody: text, receiver: phone, senderNumber: from || '' }
      );
      const ok = r.status === 200 && r.body && r.body.status !== false;
      return { ok, data: r.body };
    }

    if (provider === 'smsir') {
      // SMS.ir REST API v1 — X-API-KEY header; lineNumber must be omitted (not empty) if not set
      if (!from) return { ok: false, reason: 'شماره فرستنده (خط اختصاصی) برای SMS.ir الزامی است. آن را در تنظیمات پیامک وارد کنید.' };
      const r = await postJSON(
        'api.sms.ir',
        '/v1/send/bulk',
        { lineNumber: from, messageTexts: [text], mobiles: [phone] },
        { 'x-api-key': apiKey }
      );
      const ok = r.status === 200 && r.body && r.body.status === 1;
      return { ok, data: r.body };
    }

    return { ok: false, reason: `unsupported provider: ${provider}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { sendSMS };
