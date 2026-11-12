# RBM Digital Member | Cloudflare Pages

Paket ini memisahkan tampilan RBM dari backend Google Apps Script:

- **Cloudflare Pages Free** menyajikan halaman pendaftaran, kartu digital, dan dashboard admin.
- **Cloudflare Pages Function** pada `functions/api.js` meneruskan permintaan API ke Google Apps Script.
- **Google Apps Script + Google Sheets** tetap menjadi backend dan database yang sudah digunakan.

Tidak ada kolom database baru. Paket ini mempertahankan alur dan operasi yang sudah ada: pendaftaran, pembuatan kartu digital, QR Code, simpan kartu ke HP, bagikan link kartu, login PIN admin, statistik member, pencarian/filter, ubah status, serta verifikasi QR melalui kamera atau token manual.

## 1. Pasang API bridge pada Apps Script

1. Buka proyek Google Apps Script RBM yang saat ini terhubung ke database.
2. Salin isi `apps-script/Code.gs` dari paket ini ke file `Code.gs` di proyek tersebut. Kode ini mempertahankan fungsi backend yang ada dan menambahkan `doPost(e)` sebagai jalur API untuk Cloudflare.
3. Pertahankan file `Index.html` yang sudah ada di proyek Apps Script. File itu tidak menjadi tampilan utama Cloudflare, tetapi tetap dipertahankan agar deployment lama tidak kehilangan file yang dirujuk oleh `doGet()`.
4. Pastikan Script Properties yang sudah dipakai tetap ada, terutama `RBM_ADMIN_PIN` dan `RBM_SPREADSHEET_ID`. Jangan menaruh PIN di dalam kode.
5. Pilih **Deploy → New deployment → Web app**.
6. Atur **Execute as: Me** dan **Who has access: Anyone**. Pengaturan ini diperlukan agar customer dapat mengakses API tanpa login Google. Admin tetap harus memasukkan PIN RBM.
7. Deploy, lalu salin URL Web App yang berakhiran `/exec`.

Jika pilihan **Anyone** tidak tersedia karena kebijakan akun Google Workspace, Cloudflare tidak dapat menghilangkan pembatasan tersebut. Gunakan akun/proyek Google yang mengizinkan akses publik sebelum melanjutkan.

## 2. Deploy tampilan ke Cloudflare Pages

1. Buat repository GitHub baru, misalnya `rbm-digital-member`.
2. Unggah isi folder paket ini ke root repository. Pastikan folder `public` dan `functions` berada sejajar di root.
3. Di Cloudflare, buka **Workers & Pages → Create → Pages → Connect to Git**.
4. Pilih repository tersebut.
5. Gunakan pengaturan build berikut:
   - Framework preset: **None**
   - Build command: kosongkan
   - Build output directory: `public`
6. Deploy proyek. Cloudflare akan memberikan alamat `*.pages.dev`.
7. Buka **Settings → Variables and Secrets → Add** dan tambahkan variable:
   - Name: `RBM_GAS_URL`
   - Value: URL Web App Apps Script yang berakhiran `/exec`
8. Simpan variable, lalu lakukan redeploy agar Pages Function menggunakan konfigurasi baru.

## 3. Satu link untuk customer dan admin

Setelah deployment aktif, gunakan satu alamat Cloudflare Pages:

- Customer: `https://NAMA-PROJECT.pages.dev/`
- Admin: `https://NAMA-PROJECT.pages.dev/?page=admin`
- Kartu member: dibuat otomatis sebagai `https://NAMA-PROJECT.pages.dev/?page=card&id=TOKEN`

Nama project pada alamat di atas akan mengikuti nama project Cloudflare Pages yang dibuat. Link kartu yang dibagikan dari halaman pendaftaran dan daftar member admin akan diarahkan ke domain Cloudflare yang sama.

## 4. Biaya

Cloudflare Pages memiliki paket Free yang dapat digunakan untuk hosting tampilan RBM tanpa biaya hosting bulanan selama pemakaian tetap dalam batas paket gratis. Alamat `pages.dev` tidak memerlukan pembelian domain. Jika ingin memakai domain sendiri, biaya pendaftaran/perpanjangan domain tetap terpisah. Google Apps Script dan Google Sheets tetap mengikuti kuota serta kebijakan layanan Google.

## 5. Catatan penting

- Jangan menghapus atau mengganti database Google Sheets yang sedang aktif.
- Jangan menjalankan fungsi migrasi database hanya untuk mengganti tampilan.
- Jangan mengubah `HEADERS` atau struktur sheet `Members`.
- Jangan membagikan PIN admin atau URL deployment Apps Script kepada customer.
- Link utama customer dan admin adalah link Cloudflare Pages. URL Apps Script hanya disimpan sebagai variable di pengaturan Cloudflare.
- Setelah mengubah `Code.gs`, buat versi deployment Web App baru melalui **Manage deployments → Edit → New version → Deploy**. Jika URL deployment tetap sama, variable `RBM_GAS_URL` di Cloudflare tidak perlu diganti.
