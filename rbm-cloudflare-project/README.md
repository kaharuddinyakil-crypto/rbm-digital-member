# EXPHONE VIP MEMBER | Cloudflare Pages

Paket ini memisahkan tampilan RBM dari backend Google Apps Script:

- **Cloudflare Pages Free** menyajikan halaman pendaftaran, kartu digital, dan dashboard admin.
- **Cloudflare Pages Function** pada `functions/api.js` meneruskan permintaan API ke Google Apps Script.
- **Google Apps Script + Google Sheets** tetap menjadi backend dan database yang sudah digunakan.

Tidak ada kolom database baru. Paket ini mempertahankan alur dan operasi yang sudah ada: pendaftaran, pembuatan kartu digital, QR Code, simpan kartu ke HP, bagikan link kartu, login PIN admin, statistik member, pencarian/filter, ubah status, serta verifikasi QR melalui kamera atau token manual.

## Pembaruan halaman utama, navigasi, dan dashboard

Halaman utama sekarang berfungsi sebagai halaman pemilihan akses. Pengunjung langsung melihat tiga tombol utama: **Pendaftaran**, **Login Member**, dan **Admin/Kasir**. Formulir pendaftaran hanya muncul setelah pengunjung memilih Pendaftaran. Pada ponsel, ketiga tombol ditempatkan tepat setelah judul dan informasi diskon agar mudah dijangkau tanpa harus mencari menu di header.

Perbaikan yang diterapkan:
- `public/index.html`: tiga akses utama dipindahkan ke dalam hero utama. Formulir pendaftaran cepat di beranda dihapus. Header hanya menampilkan identitas EXPHONE dan tombol kembali pada halaman internal.
- `public/app.js`: halaman baru dan PWA tanpa kartu tersimpan membuka beranda. Tombol kembali memakai riwayat browser jika halaman asal berasal dari domain yang sama, lalu memakai parameter `from` sebagai fallback untuk kartu yang dibuka dari tab baru atau aplikasi lain.
- `public/site-final-fixes.css`: satu lapisan final untuk tata letak tombol utama, header, dashboard admin, dan responsivitas desktop, tablet, serta ponsel.
- Dashboard admin: karakter `x` yang tertinggal dihapus. Tombol Keluar duplikat dan tombol Kembali di sidebar dihapus. Satu tombol Keluar yang konsisten tetap tersedia di area judul dashboard.
- Halaman kartu digital: tombol kembali di bagian atas menjadi kontrol utama. Tautan kartu dari pendaftaran, login customer, dan dashboard admin menyimpan konteks halaman asal.
- Placeholder yang salah diperbaiki menjadi `Masukkan nama lengkap` dan `Masukkan PIN Admin`. Label tombol admin diperbaiki menjadi `Masuk ke Dashboard`.
- `public/sw.js`: cache PWA diperbarui agar browser mengambil JavaScript dan stylesheet terbaru.

Backend dan database tidak diubah. `functions/api.js`, `apps-script/Code.gs`, `apps-script/Index.html`, URL API, nama sheet, dan struktur Google Sheets tetap dipertahankan.

## Struktur file dan konfigurasi deployment

Gunakan satu sumber halaman publik, yaitu folder `public` di root repository. Salinan `public/public` yang bertingkat, duplikasi backend di dalam folder publik, file konfigurasi Wrangler di dalam folder publik, stylesheet desain lama yang tidak lagi dipanggil, dan aset yang identik serta tidak direferensikan sudah dibersihkan. Sumber Apps Script tetap berada di folder `apps-script` pada root, sedangkan Cloudflare Pages Function tetap berada di folder `functions` pada root.

Konfigurasi Cloudflare yang benar:
- Root directory: kosong atau `/`
- Framework preset: None
- Build command: kosong
- Build output directory: `public`

Jangan mengatur Root directory `public` sekaligus build output directory `public`. Konfigurasi tersebut membuat Cloudflare mencari folder `public/public`. Gunakan `wrangler.toml` di root repository sebagai konfigurasi proyek.

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


## 6. Catatan logo dan pengujian visual

Logo EXP pada `public/assets/logo-exphone-exp.svg` berasal dari file SVG yang pengguna lampirkan. File mempertahankan viewBox asli 1080 × 500 dan data gambar tertanam. Kode menampilkan logo dengan lebar fleksibel dan tinggi otomatis. Jangan mengubah tinggi dan lebar secara terpisah, memakai `object-fit: cover`, atau memberi transformasi rotasi/skew pada logo.

Hero menampilkan animasi floating pada ponsel, kartu member, dan badge VIP. Perangkat dengan pengaturan `prefers-reduced-motion` akan menonaktifkan animasi. Setelah deploy, uji halaman utama pada lebar 320 px, 375 px, 390 px, 768 px, 1024 px, 1366 px, dan 1920 px. Periksa juga formulir pendaftaran, tautan login, login admin, QR Code, dan tombol kembali dari kartu digital.


## 7. Penyempurnaan lintas perangkat

Paket terbaru menghapus tombol aksi duplikat pada area hero. Akses Pendaftaran, Login Member, dan Admin/Kasir tersedia sebagai tiga tombol utama pada halaman depan. Header hanya menampilkan logo dan nama EXPHONE, sehingga ruang navigasi lebih bersih. Pada ponsel, headline, ilustrasi HP/kartu, dan formulir memakai blok layout terpisah. Kartu digital memakai baris konten yang terukur agar QR, nama, ID, status, dan footer tidak saling menimpa.

Logo pada `public/assets/logo-exphone-exp.svg` disalin langsung dari SVG yang pengguna lampirkan. Jangan mengubah rasio viewBox atau memberi transformasi pada elemen logo.


## Konfigurasi deployment yang benar

Gunakan Root directory kosong atau `/`, build command kosong, dan build output directory `public`. Jangan memilih Root directory `public` sekaligus output directory `public`.

Folder `public/public` dan turunannya tidak ada lagi dalam paket ini. Jika pengaturan Cloudflare sebelumnya menunjuk ke folder bertingkat, ubah Root directory menjadi kosong sebelum deployment. Setelah deployment, lakukan hard refresh. Jika PWA lama masih terpasang, tutup aplikasi web dan buka ulang dari browser agar service worker baru aktif.


## 8. Penyempurnaan hero EXPHONE v14

- Pada desktop/laptop mulai lebar 1024 px, teks, informasi diskon, dan tiga tombol akses berada di kolom kiri. Ilustrasi ponsel dan kartu member tetap berada di kolom kanan.
- Pada tablet sempit dan ponsel, konten memakai satu kolom. Urutannya headline, informasi diskon, tiga tombol akses, slogan, lalu ilustrasi floating.
- Headline dan label kecil `EXPHONE MEMBER · JAYAPURA` memakai ukuran responsif agar tidak terpotong atau menabrak elemen lain.
- Tombol Pendaftaran memakai gradasi biru EXPHONE. Warna hijau neon tidak lagi menjadi warna dasar tombol tersebut. Tombol Login Member dan Admin/Kasir tetap mempertahankan karakter biru-putih dan navy.
- Slogan tampil satu kali di bagian hero: **EXPHONE SERVICE JAYAPURA — Merawat yang Berharga untuk Anda.**
- Perubahan hanya menyentuh `public/index.html`, `public/site-final-fixes.css`, dan versi cache di `public/sw.js`. Alur pendaftaran, login, admin, API, Apps Script, serta database tidak diubah.
