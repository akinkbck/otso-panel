# Ordu TSO Etkinlik Paneli

Etkinlikleri Google Sheets'te tutan, PIN ile korunan küçük bir yönetim paneli.

| Klasör | İçerik |
|---|---|
| `public/` | Panel arayüzü (Vercel'in yayınladığı statik dosyalar) |
| `api/config.js` | Apps Script adresini ortam değişkeninden okuyup panele veren Vercel fonksiyonu |
| `apps-script/Code.js` | Google Apps Script arka ucu (giriş, listeleme, kayıt, dosya yükleme) |
| `vercel.json` | Güvenlik başlıkları (CSP vb.) |

## Güvenlik modeli

- Bu depoda **PIN, tablo kimliği ya da Apps Script adresi yoktur.** Adres Vercel ortam değişkeninde, PIN Apps Script özelliklerinde durur.
- Tablo "Kısıtlı" paylaşımda kalır; veriyi yalnızca Apps Script okur ve PIN ile giriş yapanlara verir.
- PIN sunucuda doğrulanır. 10 hatalı denemeden sonra giriş 10 dakika kilitlenir; oturum 6 saat sürer.
- `/api/config`, Apps Script korumalı sürümde değilse adresi tarayıcıya vermez.

## Kurulum

### 1. Apps Script

1. Tablodan Uzantılar > Apps Script'i açın, `apps-script/Code.js` içeriğini yapıştırın.
2. Proje Ayarları > Komut dosyası özellikleri: `PANEL_PIN` ekleyin (en az 8 karakter).
3. Dağıt > Dağıtımları yönet > kalem > Sürüm: **Yeni sürüm** > Dağıt.
   İlk kurulumda: Dağıt > Yeni dağıtım > Web uygulaması, "Ben" olarak çalıştır, erişim "Herkes".
4. Tablonun paylaşımını **Kısıtlı** yapın.

### 2. Vercel

1. Bu depoyu Vercel'e aktarın (çerçeve: Other, derleme komutu yok).
2. Settings > Environment Variables: `APPS_SCRIPT_URL` = Apps Script web uygulaması adresi (`https://script.google.com/macros/s/.../exec`).
3. Yeniden yayınlayın.

## Ayarlar

| Ayar | Yer | Açıklama |
|---|---|---|
| `PANEL_PIN` | Apps Script özellikleri | Giriş PIN'i |
| `APPS_SCRIPT_URL` | Vercel ortam değişkeni | Arka uç adresi |
| `PUBLIC_VIEW` | `apps-script/Code.js` | `true` yapılırsa liste PIN'siz görüntülenir |
| `MAX_FILE_MB`, izinli türler | `apps-script/Code.js` ve `public/app.js` | Dosya yükleme sınırları (iki yerde aynı tutulmalı) |
