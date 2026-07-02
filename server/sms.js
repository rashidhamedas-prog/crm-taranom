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

  // Normalize Iranian phone: Persian/Arabic digits → ASCII, strip separators, ensure starts with 09
  const phone = String(to)
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-()]+/g, '')
    .replace(/^(\+98|0098|98)/, '0');
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
      // SMS.ir REST API v1: X-API-KEY header, body uses MessageText (singular) + Mobiles array
      const body = { MessageText: text, Mobiles: [phone] };
      if (from) body.lineNumber = from; // optional — uses account default line if omitted
      console.log('[smsir] sending to', phone, '| body keys:', Object.keys(body));
      const r = await postJSON(
        'api.sms.ir',
        '/v1/send/bulk',
        body,
        { 'x-api-key': apiKey }
      );
      console.log('[smsir] response status:', r.status, '| body:', JSON.stringify(r.body));
      const ok = r.status === 200 && r.body && r.body.status === 1;
      return { ok, data: r.body };
    }

    return { ok: false, reason: `unsupported provider: ${provider}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { sendSMS };
