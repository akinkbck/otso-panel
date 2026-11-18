// ============================================================
// ORDU TSO – ETKİNLİK PANELİ – GOOGLE APPS SCRIPT
// Bu kodu Google Sheets > Uzantılar > Apps Script'e yapıştırın
//
// KURULUM (bir kez):
//  1. Proje Ayarları (dişli simgesi) > Komut dosyası özellikleri bölümüne
//     "PANEL_PIN" adında bir özellik ekleyin. Değeri, panelde girilecek PIN'dir
//     (en az 8 karakter). PIN ayarlanmadan hiçbir istek kabul edilmez.
//  2. Dağıt > Dağıtımları yönet > (kalem) > Sürüm: "Yeni sürüm" > Dağıt.
//     "Yeni dağıtım" OLUŞTURMAYIN: adres değişir ve eski, korumasız sürüm açık kalır.
//  3. Tablonun paylaşımını "Kısıtlı" yapın. Panel veriyi artık bu betik üzerinden
//     okur; tablonun bağlantıyla herkese açık olması gerekmez.
// ============================================================

// Panel (/api/config) bu sayıya bakar: 2'den küçükse arka ucu korumasız sayar ve
// adresini tarayıcıya vermez. Yalnızca istek biçimi değişirse artırın.
const API_VERSION = 2;

const SHEET_NAME = 'Sayfa1'; // Sheets'teki sekme adı neyse onu yazın
const PUBLIC_VIEW = false;   // true: etkinlik listesi PIN'siz görüntülenir (yazma yine PIN ister)
const DRIVE_FOLDER_ID = ''; // Boş bırakırsanız UPLOAD_FOLDER_NAME adlı klasör otomatik oluşturulur
const UPLOAD_FOLDER_NAME = 'Ordu TSO Etkinlik Dosyaları';
const DEBUG_ENABLED = false; // true: Apps Script > Yürütmeler günlüğüne yazar (tabloya değil)

const COLUMN_COUNT = 14;     // A..N: Etkinlik Adı ... Notlar
const FILE_LINK_COLUMN = 13; // "Dosya Linki" sütunu (M)
const MAX_FILE_MB = 10;
const ALLOWED_FILE_TYPES = {
  pdf:  'application/pdf',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:  'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  txt:  'text/plain',
  csv:  'text/csv'
};

const MIN_PIN_LENGTH = 8;        // Daha kısa PANEL_PIN ile giriş açılmaz
const MAX_PIN_FAILS = 10;        // Bu kadar hatalı denemeden sonra giriş kilitlenir
const PIN_LOCK_SECONDS = 600;    // Kilit süresi (10 dk)
const TOKEN_TTL_SECONDS = 21600; // Oturum süresi (6 saat, CacheService üst sınırı)

function doPost(e) {
  try {
    const data = parsePayload_(e);
    const action = String(data.action || 'save');

    if (action === 'login') {
      // Kilit, eşzamanlı denemelerin hata sayacını atlatmasını engeller.
      return json_({ success: true, token: withLock_(function () { return login_(data.pin); }) });
    }
    if (action === 'logout') {
      logout_(data.token);
      return json_({ success: true });
    }
    if (action === 'list') {
      if (!PUBLIC_VIEW) requireToken_(data.token);
      return json_({ success: true, rows: listEvents_() });
    }
    if (action === 'save') {
      requireToken_(data.token);
      withLock_(function () { saveEvent_(data); });
      return json_({ success: true });
    }
    throw fail_('VALIDATION', 'Bilinmeyen işlem.');

  } catch (err) {
    if (err && err.panelCode) {
      return json_({ success: false, code: err.panelCode, error: err.message });
    }
    // Beklenmeyen hata: ayrıntı yalnızca Yürütmeler günlüğüne yazılır, istemciye sızdırılmaz.
    console.error(err && err.stack ? err.stack : String(err));
    return json_({ success: false, code: 'SERVER', error: 'Sunucu hatası. Lütfen tekrar deneyin.' });
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ── YETKİLENDİRME ───────────────────────────────────────────

function login_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('PANEL_PIN');
  if (!expected) {
    throw fail_('NOPIN', 'Sunucuda PIN ayarlanmamış. Apps Script > Proje Ayarları > Komut dosyası özellikleri bölümüne PANEL_PIN ekleyin.');
  }
  if (expected.length < MIN_PIN_LENGTH) {
    throw fail_('NOPIN', 'Sunucudaki PANEL_PIN çok kısa. En az ' + MIN_PIN_LENGTH + ' karakterlik bir PIN ayarlayın.');
  }

  const cache = CacheService.getScriptCache();
  const fails = parseInt(cache.get('pin_fails') || '0', 10) || 0;
  if (fails >= MAX_PIN_FAILS) {
    throw fail_('LOCKED', 'Çok fazla hatalı deneme yapıldı. 10 dakika sonra tekrar deneyin.');
  }

  if (!safeEqual_(String(pin == null ? '' : pin), expected)) {
    cache.put('pin_fails', String(fails + 1), PIN_LOCK_SECONDS);
    throw fail_('AUTH', 'Hatalı PIN. Lütfen tekrar deneyin.');
  }

  cache.remove('pin_fails');
  const token = Utilities.getUuid();
  cache.put('tok_' + token, '1', TOKEN_TTL_SECONDS);
  return token;
}

function logout_(token) {
  const t = String(token || '');
  if (isTokenShaped_(t)) CacheService.getScriptCache().remove('tok_' + t);
}

function requireToken_(token) {
  const t = String(token || '');
  if (!isTokenShaped_(t) || !CacheService.getScriptCache().get('tok_' + t)) {
    throw fail_('AUTH', 'Oturum geçersiz veya süresi dolmuş. Lütfen PIN ile tekrar giriş yapın.');
  }
}

function isTokenShaped_(t) {
  return /^[0-9a-f-]{36}$/i.test(t);
}

// Karşılaştırma süresinden PIN hakkında bilgi sızmaması için özetler üzerinden karşılaştırır.
function safeEqual_(a, b) {
  const da = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a, Utilities.Charset.UTF_8);
  const db = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b, Utilities.Charset.UTF_8);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

// ── OKUMA ───────────────────────────────────────────────────

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

// Etkinlikleri panelin beklediği biçimde döndürür: { row: tablo satır no, c: [14 sütun] }.
// Yalnızca A..N sütunları gönderilir; tablonun başka sekmesi ya da sütunu dışarı çıkmaz.
function listEvents_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const range   = sheet.getRange(2, 1, lastRow - 1, COLUMN_COUNT);
  const values  = range.getValues();
  const display = range.getDisplayValues();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i], d = display[i];
    if (d.every(function (cell) { return cell === ''; })) continue; // boş satır

    const cols = d.slice();
    // Tarih hücre biçiminden bağımsız olarak GG.AA.YYYY gönderilir.
    if (isDate_(v[1])) cols[1] = Utilities.formatDate(v[1], tz, 'dd.MM.yyyy');
    // Saat, hücrede görünen değerden alınır (SS:DD).
    const hm = /^(\d{1,2}):(\d{2})/.exec(d[2]);
    if (hm) cols[2] = ('0' + hm[1]).slice(-2) + ':' + hm[2];
    // Sayılar biçimlenmiş metin yerine sayı olarak gönderilir (binlik/ondalık ayracı karışmaz).
    [3, 8, 9].forEach(function (c) { if (typeof v[c] === 'number') cols[c] = v[c]; });

    rows.push({ row: i + 2, c: cols });
  }
  return rows;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

// ── KAYIT ───────────────────────────────────────────────────

function saveEvent_(data) {
  const sheet = getSheet_();

  const ad = text_(data.ad, 200);
  if (!ad) throw fail_('VALIDATION', 'Etkinlik adı zorunludur.');
  const tarih = date_(data.tarih);
  if (!tarih) throw fail_('VALIDATION', 'Geçerli bir tarih girin.');

  let rowIndex = 0;
  const rawRow = data.rowIndex;
  if (rawRow !== undefined && rawRow !== null && rawRow !== '') {
    // Yalnızca düz tam sayı kabul edilir ("2abc", 2.5, [2] gibi değerler reddedilir).
    const isPlainInt = (typeof rawRow === 'number' || typeof rawRow === 'string') && /^\d+$/.test(String(rawRow));
    rowIndex = isPlainInt ? Number(rawRow) : NaN;
    if (!Number.isInteger(rowIndex) || rowIndex < 2 || rowIndex > sheet.getLastRow()) {
      throw fail_('VALIDATION', 'Güncellenecek satır bulunamadı. Sayfayı yenileyip tekrar deneyin.');
    }
  }

  // Dosya, Drive'a yazılmadan önce doğrulanır.
  const blob = readUpload_(data);

  // Mevcut dosya bağlantısı istemciden değil, tablodan okunur.
  let dosyaLink = rowIndex ? String(sheet.getRange(rowIndex, FILE_LINK_COLUMN).getValue() || '') : '';
  let newFile = null;
  if (blob) {
    newFile = saveFileToDrive_(blob);
    dosyaLink = newFile.getUrl();
  }

  // Satır verileri (Panel sütun sırasıyla aynı)
  const row = [
    ad,
    tarih,
    time_(data.saat),
    num_(data.sure),
    text_(data.konum, 200),
    text_(data.egitmen, 200),
    text_(data.egitmenMail, 200),
    phone_(data.egitmenTel),
    num_(data.katilimci),
    num_(data.ucret),
    text_(data.durum, 50) || 'Planlandı',
    text_(data.kategori, 50),
    dosyaLink,
    text_(data.notlar, 2000)
  ];

  try {
    if (rowIndex) {
      sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  } catch (err) {
    // Tabloya yazılamadıysa yüklenen dosya sahipsiz kalmasın.
    if (newFile) { try { newFile.setTrashed(true); } catch (trashErr) { /* yoksay */ } }
    throw err;
  }

  debugLog_(rowIndex ? 'SHEET_UPDATE' : 'SHEET_APPEND', { rowIndex: rowIndex, fileSaved: !!newFile });
}

// ── DOSYA ───────────────────────────────────────────────────

// Yüklenen dosyayı doğrular; dosya yoksa null, varsa Blob döndürür.
function readUpload_(data) {
  const b64 = String(data.fileData || data.fileBase64 || '');
  if (!b64) return null;

  const name = String(data.fileName || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim().slice(-120);
  const dot  = name.lastIndexOf('.');
  const ext  = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_FILE_TYPES, ext)) {
    throw fail_('VALIDATION', 'Bu dosya türüne izin verilmiyor. İzin verilenler: ' + Object.keys(ALLOWED_FILE_TYPES).join(', '));
  }
  if (Math.floor(b64.length * 3 / 4) > MAX_FILE_MB * 1024 * 1024) {
    throw fail_('VALIDATION', 'Dosya en fazla ' + MAX_FILE_MB + ' MB olabilir.');
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(b64);
  } catch (err) {
    throw fail_('VALIDATION', 'Dosya okunamadı. Lütfen tekrar seçip kaydedin.');
  }
  // İçerik türü istemcinin beyanından değil, izin verilen uzantıdan belirlenir.
  return Utilities.newBlob(bytes, ALLOWED_FILE_TYPES[ext], name);
}

function saveFileToDrive_(blob) {
  const file = getUploadFolder_().createFile(blob);
  try {
    // Panel herkese açık görüntülendiği için dosya bağlantıyla görüntülenebilir olmalı.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    try { file.setTrashed(true); } catch (trashErr) { /* yoksay */ }
    throw err;
  }
  return file;
}

function getUploadFolder_() {
  if (DRIVE_FOLDER_ID) return DriveApp.getFolderById(DRIVE_FOLDER_ID);

  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('UPLOAD_FOLDER_ID');
  if (savedId) {
    try {
      const saved = DriveApp.getFolderById(savedId);
      if (!saved.isTrashed()) return saved;
    } catch (err) { /* klasör silinmiş; yenisi oluşturulur */ }
  }
  const folder = DriveApp.createFolder(UPLOAD_FOLDER_NAME);
  props.setProperty('UPLOAD_FOLDER_ID', folder.getId());
  return folder;
}

// ── GİRDİ TEMİZLEME ─────────────────────────────────────────

// Metni kırpar; "=", "+", "-", "@" ile başlıyorsa Sheets'in formül olarak
// çalıştırmaması için başına kesme işareti koyar (hücrede görünmez).
function text_(v, maxLen) {
  let s = String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLen);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

// Negatif olmayan sayı ya da boş.
function num_(v) {
  const s = String(v == null ? '' : v).trim().replace(',', '.');
  if (!s) return '';
  const n = Number(s);
  return isFinite(n) && n >= 0 ? n : '';
}

// "YYYY-AA-GG" -> "GG.AA.YYYY". Saat dilimi dönüşümü yapılmaz, gün kaymaz.
function date_(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v));
  if (!m) return '';
  const month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return m[3] + '.' + m[2] + '.' + m[1];
}

function time_(v) {
  const s = String(v == null ? '' : v).trim();
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s) ? s : '';
}

// Telefon her zaman metin olarak yazılır; baştaki 0 ve + korunur.
function phone_(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9+()\-\s]/g, '').trim().slice(0, 30);
  return s ? "'" + s : '';
}

// ── YARDIMCILAR ─────────────────────────────────────────────

function parsePayload_(e) {
  if (!e) return {};

  const raw = e.postData && e.postData.contents ? e.postData.contents : '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) {
      // JSON değilse aşağıda e.parameter ile devam edilir.
    }
  }

  return e.parameter || {};
}

function fail_(code, message) {
  const err = new Error(message);
  err.panelCode = code;
  return err;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function debugLog_(stage, obj) {
  if (!DEBUG_ENABLED) return;
  console.log(stage + ' ' + JSON.stringify(obj || {}));
}

// Drive iznini bir kez manuel tetiklemek için Apps Script editörde çalıştırın.
function authorizeDriveAccess() {
  const root = DriveApp.getRootFolder();
  return 'Drive authorization OK: ' + root.getName();
}

// GET yalnızca durum ve sürüm bilgisi verir; hiçbir veri döndürmez.
function doGet(e) {
  return json_({ status: 'Ordu TSO Apps Script çalışıyor.', api: API_VERSION });
}
