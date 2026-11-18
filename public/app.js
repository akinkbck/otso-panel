'use strict';

// Bu dosyada ne PIN ne de Google adresi/kimliği bulunur:
//  - Apps Script adresi /api/config üzerinden (Vercel ortam değişkeninden) gelir.
//  - PIN, Apps Script tarafında doğrulanır; tarayıcı yalnızca geçici oturum anahtarı tutar.
//  - Tablo verisi de Apps Script'ten, oturum anahtarıyla okunur.

// Dosya yükleme sınırları (apps-script/Code.js içindeki değerlerle aynı tutun)
const MAX_FILE_MB = 10;
const ALLOWED_EXT = ['pdf','doc','docx','xls','xlsx','ppt','pptx','jpg','jpeg','png','txt','csv'];

// Yalnızca gerçek bir Apps Script web uygulaması adresine istek gönderilir.
const API_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

let apiUrl      = '';
let allRows     = [];   // her eleman: [col0..col13] + _sheetRow
let sortCol     = -1, sortAsc = true;
let pinCallback = null; // PIN onaylandıktan sonra çağrılacak fonksiyon
let loadSeq     = 0;

const $ = id => document.getElementById(id);

//  YARDIMCILAR
// Tablodan gelen her değer HTML'e basılmadan önce bu fonksiyondan geçer.
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Yalnızca http(s) bağlantılarına izin verir (javascript: vb. engellenir).
function safeUrl(v) {
  const s = String(v == null ? '' : v).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// Sunucu sayıları sayı olarak gönderir; metin gelirse Türkçe biçim (1.250,50) çözülür.
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  return parseFloat(String(v == null ? '' : v).replace(/\./g, '').replace(',', '.')) || 0;
}

function fmtNum(v) {
  return typeof v === 'number' ? v.toLocaleString('tr-TR') : String(v == null ? '' : v);
}

// Arama ve filtre için metni sadeleştirir: Türkçe kurallarıyla küçültür, sonra
// işaretleri atar. Böylece "ISTANBUL", "İstanbul" ve "istanbul" ya da "egitim" ve
// "Eğitim" aynı sayılır.
function fold(v) {
  return String(v == null ? '' : v)
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i');
}

// Sıralama anahtarı: sütunun türüne göre karşılaştırılabilir bir değer üretir.
const NUMERIC_COLS = [3, 8, 9]; // Süre, Katılımcı, Ücret

function sortKey(row, col) {
  const v = row[col];
  if (v === '' || v == null) return null; // boşlar her zaman sonda
  if (col === 1) {
    // GG.AA.YYYY -> YYYYAAGG (gün değil, takvim sırası)
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(v).trim());
    return m ? Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]) : fold(v);
  }
  if (NUMERIC_COLS.includes(col)) return num(v);
  return fold(v);
}

function applySort() {
  if (sortCol < 0) return;
  const dir = sortAsc ? 1 : -1;
  allRows.sort((a, b) => {
    const ka = sortKey(a, sortCol), kb = sortKey(b, sortCol);
    if (ka === null || kb === null) return (ka === null) - (kb === null);
    if (typeof ka === 'number' && typeof kb === 'number') return (ka - kb) * dir;
    return String(ka).localeCompare(String(kb), 'tr', { numeric: true }) * dir;
  });
}

//  SUNUCU
// Apps Script adresini alır. Sunucu, arka uç korumalı sürümde değilse adresi vermez.
async function loadConfig() {
  if (apiUrl) return;
  let out;
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    out = await res.json();
  } catch (e) {
    throw new Error('Panel yapılandırması alınamadı. İnternet bağlantınızı kontrol edin.');
  }
  if (!out || !out.ok || !API_URL_PATTERN.test(String(out.url || ''))) {
    const err = new Error((out && out.error) || 'Panel yapılandırması geçersiz.');
    err.code = (out && out.code) || 'CONFIG';
    throw err;
  }
  apiUrl = out.url;
}

// Apps Script'e istek gönderir ve gerçek yanıtı okur; başarısızsa hata fırlatır.
async function api(payload) {
  await loadConfig();
  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      // text/plain "basit istek" sayılır; CORS ön kontrolü (preflight) tetiklemez.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    throw new Error('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
  }
  let out;
  try { out = await res.json(); }
  catch (e) { throw new Error('Sunucudan geçersiz yanıt alındı.'); }
  if (!out || !out.success) {
    const err = new Error((out && out.error) || 'İşlem başarısız.');
    err.code = out && out.code;
    throw err;
  }
  return out;
}

//  OTURUM
// Oturum anahtarı sunucudan gelir; PIN tarayıcıda saklanmaz.
function getToken() {
  try { return sessionStorage.getItem('tso_token') || ''; } catch (e) { return ''; }
}
function setToken(t) {
  try { sessionStorage.setItem('tso_token', t); } catch (e) { /* depolama kapalıysa oturum tutulamaz */ }
}
function clearToken() {
  try { sessionStorage.removeItem('tso_token'); } catch (e) { /* yoksay */ }
}
function isUnlocked() { return !!getToken(); }

function requireAuth(callback) {
  if (isUnlocked()) { callback(); return; }
  pinCallback = callback;
  $('pin-input').value = '';
  $('pin-err').style.display = 'none';
  $('pin-input').classList.remove('error');
  $('pin-overlay').classList.add('open');
  setTimeout(() => $('pin-input').focus(), 100);
}

async function checkPin() {
  const inp = $('pin-input');
  const err = $('pin-err');
  const btn = $('pin-submit');
  if (!inp.value || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Kontrol ediliyor...';
  err.style.display = 'none';
  try {
    const out = await api({ action: 'login', pin: inp.value });
    setToken(out.token);
    $('pin-overlay').classList.remove('open');
    updateLockBadge();
    const cb = pinCallback;
    pinCallback = null;
    loadData();
    if (cb) cb();
  } catch (e) {
    inp.classList.add('error');
    err.textContent = e.message;
    err.style.display = 'block';
    inp.value = '';
    setTimeout(() => inp.classList.remove('error'), 600);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Giriş Yap';
  }
}

function closePinOverlay() {
  $('pin-overlay').classList.remove('open');
  pinCallback = null;
}

function handleLockClick() {
  if (isUnlocked()) {
    api({ action: 'logout', token: getToken() }).catch(() => {}); // sunucudaki oturumu da kapat
    clearToken();
    loadData(); // sunucu artık veri vermez; kilitli ekran gösterilir
  } else {
    requireAuth(() => {});
  }
}

function updateLockBadge() {
  const badge = $('lock-badge');
  if (isUnlocked()) {
    badge.textContent = 'Yetkili';
    badge.classList.add('unlocked');
  } else {
    badge.textContent = 'Kilitli';
    badge.classList.remove('unlocked');
  }
}

//  VERİ YÜKLEME
const STATES = ['loading', 'data-table', 'empty', 'locked', 'error'];

function showState(name, message) {
  STATES.forEach(id => { $(id).style.display = 'none'; });
  if (name === 'error') $('error-text').textContent = message || 'Veri çekilemedi.';
  $(name).style.display = name === 'data-table' ? 'table' : 'block';
}

async function loadData() {
  const seq = ++loadSeq;
  showState('loading');
  try {
    const out = await api({ action: 'list', token: getToken() });
    if (seq !== loadSeq) return; // daha yeni bir yükleme başlamış
    allRows = (Array.isArray(out.rows) ? out.rows : []).map(r => {
      const cols = Array.from({ length: 14 }, (_, i) => {
        const v = r && r.c ? r.c[i] : '';
        return v == null ? '' : v;
      });
      cols._sheetRow = Number(r && r.row) || 0; // satır numarası sunucudan gelir
      return cols;
    });
    updateStats();
    applySort(); // seçili sıralama yenilemeden ve kayıttan sonra da korunur
    filterTable();
    $('last-update').textContent = 'Son güncelleme: ' + new Date().toLocaleString('tr-TR');
  } catch (e) {
    if (seq !== loadSeq) return;
    allRows = [];
    $('table-body').innerHTML = ''; // oturum kapanınca eski veriler sayfada kalmasın
    clearStats();
    $('row-count').textContent = '';
    if (e.code === 'AUTH') {
      clearToken();
      showState('locked');
    } else {
      showState('error', e.message);
    }
  }
  updateLockBadge();
}

//  İSTATİSTİKLER
function updateStats() {
  const total = allRows.length;
  const done  = allRows.filter(r => String(r[10]).toLowerCase().includes('tamamlan')).length;
  const plan  = allRows.filter(r => String(r[10]).toLowerCase().includes('planland')).length;
  const katilimci = allRows.reduce((s, r) => s + num(r[8]), 0);
  const ucret     = allRows.reduce((s, r) => s + num(r[9]), 0);
  $('s-total').textContent = total;
  $('s-done').textContent  = done;
  $('s-plan').textContent  = plan;
  $('s-katilimci').textContent = katilimci.toLocaleString('tr-TR');
  $('s-ucret').textContent = ucret.toLocaleString('tr-TR');
}

function clearStats() {
  ['s-total', 's-done', 's-plan', 's-katilimci', 's-ucret'].forEach(id => { $(id).textContent = '-'; });
}

//  TABLO
function badgeDurum(val) {
  const v = String(val).toLowerCase();
  if (v.includes('tamamlan')) return `<span class="badge tamamlandi">${esc(val)}</span>`;
  if (v.includes('planland')) return `<span class="badge planlandi">${esc(val)}</span>`;
  if (v.includes('devam'))    return `<span class="badge devam">${esc(val)}</span>`;
  return `<span class="badge taslak">${esc(val)}</span>`;
}

function renderTable(rows) {
  if (!rows.length) {
    showState('empty');
    $('row-count').textContent = '0 kayıt';
    return;
  }
  $('table-body').innerHTML = rows.map(r => {
    const sr = Number(r._sheetRow) || 0;
    const dosya = safeUrl(r[12]);
    return `<tr>
      <td><strong>${esc(r[0])}</strong></td>
      <td>${esc(r[1])}</td>
      <td>${esc(r[2])}</td>
      <td>${r[3] !== '' ? esc(fmtNum(r[3])) + ' saat' : ''}</td>
      <td>${esc(r[4])}</td>
      <td>${r[5] ? esc(r[5]) : '<em style="color:#a0aec0">Belirsiz</em>'}</td>
      <td>${r[6] ? `<a href="mailto:${esc(r[6])}">${esc(r[6])}</a>` : ''}</td>
      <td>${r[7] ? `<a href="tel:${esc(String(r[7]).replace(/[^0-9+]/g, ''))}">${esc(r[7])}</a>` : ''}</td>
      <td style="text-align:center"><strong>${esc(fmtNum(r[8]))}</strong></td>
      <td style="text-align:right">${r[9] !== '' ? esc(num(r[9]).toLocaleString('tr-TR')) : ''}</td>
      <td>${badgeDurum(r[10])}</td>
      <td>${r[11] ? `<span class="cat">${esc(r[11])}</span>` : ''}</td>
      <td>${dosya ? `<a href="${esc(dosya)}" target="_blank" rel="noopener noreferrer">Dosya</a>` : ''}</td>
      <td style="color:#718096;font-size:0.82rem">${esc(r[13])}</td>
      <td><button class="btn-edit" type="button" data-row="${sr}">Düzenle</button></td>
    </tr>`;
  }).join('');
  showState('data-table');
  $('row-count').textContent = rows.length + ' kayıt gösteriliyor';
}

function filterTable() {
  const q   = fold($('search').value).trim();
  const dur = fold($('f-durum').value);
  const kat = fold($('f-kategori').value);
  const filtered = allRows.filter(r => {
    const text = fold(r.slice(0, 14).join(' '));
    return (!q   || text.includes(q))
        && (!dur || fold(r[10]).includes(dur))
        && (!kat || fold(r[11]).includes(kat));
  });
  renderTable(filtered);
}

function sortTable(col) {
  if (sortCol === col) sortAsc = !sortAsc;
  else { sortCol = col; sortAsc = true; }
  applySort();
  filterTable();
}

//  MODAL
const field = name => document.querySelector('#etkinlik-form [name=' + name + ']');

function openModal() {
  requireAuth(() => {
    $('etkinlik-form').reset();
    $('form-row-index').value = '';
    $('current-file-link').textContent = '';
    $('modal-title').textContent = 'Yeni Etkinlik Ekle';
    $('form-notice').classList.remove('show');
    field('tarih').value = new Date().toISOString().split('T')[0];
    $('modal-overlay').classList.add('open');
  });
}

function openEditModal(sheetRow) {
  requireAuth(() => {
    const row = allRows.find(r => r._sheetRow === sheetRow);
    if (!row) return;
    $('etkinlik-form').reset();
    $('form-row-index').value = sheetRow;
    $('modal-title').textContent = 'Etkinliği Düzenle';
    $('form-notice').classList.remove('show');

    // Tarihi ISO formatına çevir (GG.AA.YYYY -> YYYY-MM-DD)
    let tarihISO = '';
    if (row[1]) {
      const parts = String(row[1]).split('.');
      if (parts.length === 3) tarihISO = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    field('ad').value          = row[0];
    field('tarih').value       = tarihISO;
    field('saat').value        = row[2];
    field('sure').value        = row[3];
    field('konum').value       = row[4];
    field('egitmen').value     = row[5];
    field('egitmenMail').value = row[6];
    field('egitmenTel').value  = row[7];
    field('katilimci').value   = row[8];
    field('ucret').value       = row[9];
    field('durum').value       = row[10] || 'Planlandı';
    field('kategori').value    = row[11];
    field('notlar').value      = row[13];

    const mevcutDosya = safeUrl(row[12]);
    $('current-file-link').innerHTML = mevcutDosya
      ? `Mevcut dosya: <a href="${esc(mevcutDosya)}" target="_blank" rel="noopener noreferrer">Aç</a>`
      : '';

    $('modal-overlay').classList.add('open');
  });
}

function closeModal() {
  $('modal-overlay').classList.remove('open');
}

//  FORM GÖNDER
async function submitForm(e) {
  e.preventDefault();
  const btn    = $('submit-btn');
  const notice = $('form-notice');
  if (btn.disabled) return; // çift tıklamada ikinci kaydı engelle

  const showNotice = (ok, msg) => {
    notice.style.cssText = ok
      ? 'background:#dcfce7;border:1px solid #86efac;color:#166534;'
      : 'background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;';
    notice.textContent = msg;
    notice.classList.add('show');
  };

  const data = {
    action: 'save',
    token: getToken(),
    rowIndex: $('form-row-index').value || '',
    ad: field('ad').value || '',
    tarih: field('tarih').value || '',
    saat: field('saat').value || '',
    sure: field('sure').value || '',
    konum: field('konum').value || '',
    egitmen: field('egitmen').value || '',
    egitmenMail: field('egitmenMail').value || '',
    egitmenTel: field('egitmenTel').value || '',
    katilimci: field('katilimci').value || '',
    ucret: field('ucret').value || '',
    durum: field('durum').value || '',
    kategori: field('kategori').value || '',
    notlar: field('notlar').value || ''
  };
  const fileInput = $('event-file');
  const file = fileInput && fileInput.files && fileInput.files[0];
  const isEdit = !!data.rowIndex;

  // Dosyayı göndermeden önce tür ve boyut kontrolü (sunucu da ayrıca denetler)
  if (file) {
    const dot = file.name.lastIndexOf('.');
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
    if (!ALLOWED_EXT.includes(ext)) {
      showNotice(false, 'Bu dosya türü yüklenemez. İzin verilenler: ' + ALLOWED_EXT.join(', '));
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      showNotice(false, 'Dosya en fazla ' + MAX_FILE_MB + ' MB olabilir.');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Kaydediliyor...';
  notice.classList.remove('show');

  try {
    // Dosya seçildiyse base64 olarak API'ye ekle
    if (file) {
      data.fileName = file.name;
      data.fileData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Dosya okunamadı. Lütfen tekrar seçip kaydedin.'));
        reader.readAsDataURL(file);
      });
      if (!data.fileData) throw new Error('Dosya okunamadı. Lütfen tekrar seçip kaydedin.');
    }

    await api(data); // sunucu "success: false" dönerse hata fırlatır

    showNotice(true, isEdit ? 'Etkinlik güncellendi!' : 'Etkinlik eklendi!');
    btn.textContent = 'Kaydedildi';
    setTimeout(() => { closeModal(); loadData(); btn.disabled = false; btn.textContent = 'Kaydet'; }, 1600);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Kaydet';
    if (err.code === 'AUTH') {
      // Oturum düşmüş: form açık kalır, PIN'den sonra tekrar Kaydet'e basılır.
      clearToken();
      updateLockBadge();
      showNotice(false, 'Oturumunuz sona ermiş. PIN girdikten sonra tekrar Kaydet\'e basın.');
      requireAuth(() => {});
      return;
    }
    showNotice(false, 'Hata: ' + err.message);
  }
}

//  BAŞLANGIÇ
// Olaylar burada bağlanır; HTML içinde satır içi betik yoktur (katı CSP ile uyumlu).
function init() {
  $('refresh-btn').addEventListener('click', () => loadData());
  $('retry-btn').addEventListener('click', () => loadData());
  $('lock-badge').addEventListener('click', handleLockClick);
  $('login-btn').addEventListener('click', () => requireAuth(() => {}));
  $('search').addEventListener('input', filterTable);
  $('f-durum').addEventListener('change', filterTable);
  $('f-kategori').addEventListener('change', filterTable);
  $('add-btn').addEventListener('click', openModal);

  document.querySelector('#data-table thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) sortTable(Number(th.dataset.sort));
  });
  $('table-body').addEventListener('click', e => {
    const btn = e.target.closest('.btn-edit');
    if (btn) openEditModal(Number(btn.dataset.row));
  });

  $('pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') checkPin(); });
  $('pin-submit').addEventListener('click', checkPin);
  $('pin-cancel').addEventListener('click', closePinOverlay);

  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('etkinlik-form').addEventListener('submit', submitForm);
  $('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closePinOverlay(); } });

  updateLockBadge();
  clearStats();
  loadData();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
