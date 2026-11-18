// GET /api/config
//
// Panelin konuşacağı Apps Script adresini verir. Adres depoda değil, Vercel ortam
// değişkeninde (APPS_SCRIPT_URL) durur. Arka uç korumalı sürümde (api >= 2) değilse
// adres tarayıcıya hiç verilmez; böylece panel, PIN denetimi olmayan eski bir betiğe
// yanlışlıkla istek gönderemez.

const URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const MIN_API_VERSION = 2;
const VERIFY_TTL_MS = 10 * 60 * 1000;

// Aynı fonksiyon örneği yaşadıkça doğrulama sonucu yeniden kullanılır.
let verified = { url: '', at: 0 };

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });
}

async function backendVersion(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const info = await res.json();
    return info && typeof info === 'object' ? Number(info.api) || 0 : null;
  } catch (err) {
    return null; // ulaşılamadı ya da JSON değil
  }
}

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return json({ ok: false, code: 'METHOD', error: 'Yalnızca GET desteklenir.' }, 405, 'no-store');
    }

    const url = String(process.env.APPS_SCRIPT_URL || '').trim();
    if (!URL_PATTERN.test(url)) {
      return json({
        ok: false,
        code: 'NOT_CONFIGURED',
        error: 'Panel henüz yapılandırılmamış: Vercel proje ayarlarında APPS_SCRIPT_URL ortam değişkeni tanımlı değil.',
      }, 503, 'no-store');
    }

    if (verified.url !== url || Date.now() - verified.at > VERIFY_TTL_MS) {
      const version = await backendVersion(url);
      if (version === null) {
        return json({
          ok: false,
          code: 'BACKEND_DOWN',
          error: 'Apps Script sunucusuna ulaşılamadı. Biraz sonra tekrar deneyin.',
        }, 502, 'no-store');
      }
      if (version < MIN_API_VERSION) {
        return json({
          ok: false,
          code: 'BACKEND_OLD',
          error: 'Sunucu tarafı güncel değil: Apps Script\'e yeni kodu yapıştırıp dağıtımı "Yeni sürüm" olarak güncelleyin.',
        }, 503, 'no-store');
      }
      verified = { url, at: Date.now() };
    }

    return json({ ok: true, url }, 200, 'public, max-age=0, s-maxage=300');
  },
};
