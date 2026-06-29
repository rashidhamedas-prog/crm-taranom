// Proven Gregorian <-> Jalali conversion (jalaali-js algorithm).
function div(a, b) { return ~~(a / b); }

function g2j(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = 355666 + (365 * gy) + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) + gd + g_d_m[gm - 1];
  let jy = -1595 + (33 * div(days, 12053));
  days %= 12053;
  jy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) { jy += div(days - 1, 365); days = (days - 1) % 365; }
  let jm, jd;
  if (days < 186) { jm = 1 + div(days, 31); jd = 1 + (days % 31); }
  else { jm = 7 + div(days - 186, 30); jd = 1 + ((days - 186) % 30); }
  return [jy, jm, jd];
}

function j2g(jy, jm, jd) {
  let gy, gm, gd, days;
  jy += 1595;
  days = -355668 + (365 * jy) + (div(jy, 33) * 8) + div(((jy % 33) + 3), 4) + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
  gy = 400 * div(days, 146097); days %= 146097;
  if (days > 36524) { gy += 100 * div(--days, 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * div(days, 1461); days %= 1461;
  if (days > 365) { gy += div((days - 1), 365); days = (days - 1) % 365; }
  gd = days + 1;
  const sal_a = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (gm = 0; gm < 13 && gd > sal_a[gm]; gm++) gd -= sal_a[gm];
  return [gy, gm, gd];
}

function todayJalali() {
  const d = new Date();
  const [jy, jm, jd] = g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Add N calendar days to a Jalali date string "YYYY/MM/DD"
function addDaysToJalali(jalaliStr, days) {
  try {
    const parts = jalaliStr.split('/').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return todayJalali();
    const [jy, jm, jd] = parts;
    const [gy, gm, gd] = j2g(jy, jm, jd);
    const d = new Date(gy, gm - 1, gd);
    d.setDate(d.getDate() + days);
    const [ny, nm, nd] = g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return `${ny}/${String(nm).padStart(2, '0')}/${String(nd).padStart(2, '0')}`;
  } catch {
    return todayJalali();
  }
}

module.exports = { g2j, j2g, todayJalali, nowHHMM, addDaysToJalali };
