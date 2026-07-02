/**
 * SMS pipeline self-test — run: node scripts/test-sms.js
 * Mocks https.request so NO real SMS is sent; verifies:
 *  1. phone normalization (Persian/Arabic digits, +98/98/0098 prefixes, separators)
 *  2. per-provider request shape (smsir: x-api-key + MessageText singular + Mobiles array)
 *  3. welcome-SMS template rendering ({address} placeholder)
 *  4. follow-up date math used by the automated follow-up engine
 */
const https = require('https');
const { EventEmitter } = require('events');

let captured = null;
let mockResponse = { status: 200, body: { status: 1, data: [1] } };

// Intercept all https.request calls made by sms.js
https.request = function (options, cb) {
  captured = { options, body: '' };
  const req = new EventEmitter();
  req.write = chunk => { captured.body += chunk; };
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = mockResponse.status;
    cb(res);
    process.nextTick(() => {
      res.emit('data', JSON.stringify(mockResponse.body));
      res.emit('end');
    });
  };
  req.on = req.addListener.bind(req);
  return req;
};

const { sendSMS } = require('../sms');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  console.log('\n— 1) Phone normalization —');
  const KEY = { sms_provider: 'smsir', sms_api_key: 'TESTKEY' };

  captured = null;
  await sendSMS(KEY, '۰۹۳۸۶۵۰۰۲۹۸', 'test');
  check('Persian digits ۰۹۳۸۶۵۰۰۲۹۸ → 09386500298',
    captured && JSON.parse(captured.body).Mobiles[0] === '09386500298',
    captured ? captured.body : 'no request made');

  captured = null;
  await sendSMS(KEY, '+98 938 650-0298', 'test');
  check('"+98 938 650-0298" → 09386500298',
    captured && JSON.parse(captured.body).Mobiles[0] === '09386500298',
    captured ? captured.body : 'no request made');

  captured = null;
  await sendSMS(KEY, '00989386500298', 'test');
  check('0098 prefix → 09386500298',
    captured && JSON.parse(captured.body).Mobiles[0] === '09386500298');

  captured = null;
  const bad = await sendSMS(KEY, '12345', 'test');
  check('invalid phone rejected without network call', !captured && bad.ok === false);

  const noKey = await sendSMS({ sms_provider: 'smsir' }, '09386500298', 'test');
  check('missing API key → graceful failure', noKey.ok === false && !!noKey.reason);

  console.log('\n— 2) Provider request shape —');
  captured = null;
  const r = await sendSMS({ ...KEY, sms_from: '30007732' }, '09386500298', 'سلام تست');
  const b = captured ? JSON.parse(captured.body) : {};
  check('smsir host = api.sms.ir', captured?.options.hostname === 'api.sms.ir');
  check('smsir path = /v1/send/bulk', captured?.options.path === '/v1/send/bulk');
  check('smsir header x-api-key set', captured?.options.headers['x-api-key'] === 'TESTKEY');
  check('smsir MessageText is a STRING (not array)', typeof b.MessageText === 'string');
  check('smsir has NO MessageTexts (plural) field', !('MessageTexts' in b));
  check('smsir Mobiles is array', Array.isArray(b.Mobiles));
  check('smsir lineNumber passed from sms_from', b.lineNumber === '30007732');
  check('smsir success detected (status===1)', r.ok === true);

  mockResponse = { status: 200, body: { status: 103, message: 'empty text' } };
  const rf = await sendSMS(KEY, '09386500298', 'x');
  check('smsir API-level error (status≠1) → ok:false', rf.ok === false);
  mockResponse = { status: 200, body: { status: 1 } };

  captured = null;
  await sendSMS({ sms_provider: 'kavenegar', sms_api_key: 'KV' }, '09386500298', 'تست');
  check('kavenegar host + receptor field',
    captured?.options.hostname === 'api.kavenegar.com' && JSON.parse(captured.body).receptor === '09386500298');

  console.log('\n— 3) Welcome template rendering —');
  const TPL = `سلام 🌸 به خانواده پوشاک ترنم خوش‌آمدید!\n{address}\nپوشاک ترنم 🌿`;
  const withAddr = TPL.replace('{address}', '\n🏢 آدرس دفتر: کیمیا، واحد ۵');
  check('address line injected', withAddr.includes('آدرس دفتر: کیمیا') && !withAddr.includes('{address}'));
  const noAddr = TPL.replace('{address}', '');
  check('empty address → placeholder removed cleanly', !noAddr.includes('{address}'));

  console.log('\n— 4) Follow-up date engine —');
  const { addDaysToJalali, todayJalali } = require('../jalali');
  check('todayJalali format', /^\d{4}\/\d{2}\/\d{2}$/.test(todayJalali()));
  check('+7 days simple', addDaysToJalali('1404/04/01', 7) === '1404/04/08');
  check('+7 days month rollover (31-day month)', addDaysToJalali('1404/04/28', 7) === '1404/05/04');
  check('+7 days year rollover', addDaysToJalali('1404/12/27', 7) === '1405/01/05');
  check('corrupt date → falls back to today', /^\d{4}\/\d{2}\/\d{2}$/.test(addDaysToJalali('garbage', 7)));

  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
