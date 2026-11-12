const PAGE = new URLSearchParams(window.location.search).get('page') || 'register';
const TOKEN = new URLSearchParams(window.location.search).get('id') || '';

let adminPin = '';
let dashboardMembers = [];
let html5Qr = null;
let cardImageObjectUrl = null;

function showPage() {
  const allowed = ['register', 'card', 'admin'];
  const page = allowed.includes(PAGE) ? PAGE : 'register';
  document.getElementById('registerPage').hidden = page !== 'register';
  document.getElementById('cardPage').hidden = page !== 'card';
  document.getElementById('adminPage').hidden = page !== 'admin';
  document.querySelectorAll('[data-nav]').forEach(function(link) {
    link.classList.toggle('active', link.dataset.nav === (page === 'card' ? 'register' : page));
  });
  if (page === 'card') loadMemberCard();
  if (page === 'admin') initialiseAdmin();
}

async function api(action, payload) {
  const response = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(Object.assign({ action: action }, payload || {}))
  });

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error('Server tidak mengirim respons yang valid. Periksa konfigurasi Cloudflare dan Apps Script.');
  }

  if (!response.ok || !result || result.ok !== true) {
    throw new Error(result && result.message ? result.message : 'Permintaan belum berhasil. Silakan coba kembali.');
  }
  return result.data;
}

function showError(id, error) {
  const target = document.getElementById(id);
  if (!target) return;
  target.textContent = error && error.message ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(char) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char];
  });
}

function makeWhatsAppUrl(phone, message) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.substring(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  else if (!digits.startsWith('62')) digits = '62' + digits;
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(message || '');
}

function showRegistrationResult(result, phone) {
  const message = document.getElementById('regMsg');
  const cardUrl = String(result.cardUrl || '');
  const whatsappMessage = 'Halo ' + String(result.name || '') +
    ', pendaftaran member RBM Anda berhasil. Berikut link kartu digital Anda: ' + cardUrl;
  const whatsappUrl = makeWhatsAppUrl(phone, whatsappMessage);

  message.innerHTML =
    '<div class="success-box">' +
      '<strong class="success">Pendaftaran berhasil.</strong><br>' +
      'Nama: ' + escapeHtml(result.name) + '<br>' +
      'Member ID: ' + escapeHtml(result.memberId) + '<br><br>' +
      '<a class="text-link" href="' + escapeHtml(cardUrl) + '" target="_blank" rel="noopener">Buka Kartu Digital</a>' +
      (whatsappUrl
        ? '<br><br><a class="text-link" href="' + escapeHtml(whatsappUrl) + '" target="_blank" rel="noopener">Kirim Link Kartu melalui WhatsApp</a>'
        : '') +
    '</div>';
}

function initialiseRegistration() {
  const form = document.getElementById('regForm');
  if (!form) return;

  form.addEventListener('submit', async function(event) {
    event.preventDefault();
    const formData = Object.fromEntries(new FormData(form).entries());
    const button = document.getElementById('regBtn');
    const message = document.getElementById('regMsg');

    button.disabled = true;
    button.innerHTML = '<span>Mendaftarkan...</span>';
    message.textContent = '';

    try {
      const result = await api('registerMember', { form: formData });
      showRegistrationResult(result, formData.phone);
      form.reset();
    } catch (error) {
      showError('regMsg', error);
    } finally {
      button.disabled = false;
      button.innerHTML = '<span>Buat Kartu Member</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
  });
}

async function loadMemberCard() {
  const loading = document.getElementById('cardLoading');
  const content = document.getElementById('cardContent');
  if (!TOKEN) {
    loading.hidden = true;
    showError('cardError', new Error('Link kartu tidak memiliki kode member. Buka tautan kartu yang diberikan saat pendaftaran.'));
    return;
  }

  try {
    const member = await api('getMemberCard', { token: TOKEN });
    document.getElementById('cardName').textContent = member.name || '-';
    document.getElementById('cardId').textContent = member.memberId || '-';
    const status = document.getElementById('cardStatus');
    status.textContent = String(member.status || '').toUpperCase();
    if (String(member.status || '').toLowerCase() !== 'aktif') {
      status.classList.add('status-inactive');
    }

    if (typeof QRCode === 'undefined') throw new Error('Library QR Code belum termuat. Periksa koneksi internet lalu muat ulang halaman.');
    const qrTarget = document.getElementById('qr');
    qrTarget.innerHTML = '';
    new QRCode(qrTarget, {
      text: TOKEN,
      width: 180,
      height: 180,
      colorDark: '#17182b',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
    loading.hidden = true;
    content.hidden = false;
  } catch (error) {
    loading.hidden = true;
    showError('cardError', error);
  }
}

async function saveCardToPhone() {
  const button = document.getElementById('saveCardBtn');
  const message = document.getElementById('saveMsg');
  const card = document.getElementById('memberCard');
  const imageLink = document.getElementById('cardImageLink');

  if (typeof html2canvas === 'undefined') {
    message.textContent = 'Fitur gambar belum termuat. Periksa koneksi internet dan muat ulang halaman.';
    return;
  }

  button.disabled = true;
  button.innerHTML = 'Menyiapkan Kartu...';
  message.textContent = 'Sedang membuat gambar kartu member.';

  try {
    const canvas = await html2canvas(card, {
      backgroundColor: null,
      scale: 3,
      useCORS: true,
      logging: false
    });
    const blob = await new Promise(function(resolve) { canvas.toBlob(resolve, 'image/png'); });
    if (!blob) throw new Error('Gambar kartu tidak berhasil dibuat.');
    const file = new File([blob], 'Kartu-Member-RBM.png', { type: 'image/png' });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Kartu Member RBM', text: 'Kartu digital member RBM' });
        message.textContent = 'Menu berbagi terbuka. Pilih Simpan Gambar atau Save Image untuk menyimpan kartu.';
        return;
      } catch (shareError) {
        if (shareError && shareError.name === 'AbortError') {
          message.textContent = 'Menu berbagi ditutup. Kartu belum disimpan. Tekan tombol simpan untuk mencoba lagi.';
          return;
        }
      }
    }

    if (cardImageObjectUrl) URL.revokeObjectURL(cardImageObjectUrl);
    cardImageObjectUrl = URL.createObjectURL(blob);
    imageLink.href = cardImageObjectUrl;
    imageLink.download = 'Kartu-Member-RBM.png';
    imageLink.hidden = false;

    const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isAppleMobile) {
      message.textContent = 'Di iPhone: tekan Buka Gambar Kartu. Setelah gambar terbuka, tekan dan tahan gambar, lalu pilih Tambahkan ke Foto atau Simpan ke Foto.';
    } else {
      message.textContent = 'Gambar kartu sudah dibuat. Jika unduhan tidak berjalan otomatis, tekan Buka Gambar Kartu.';
      imageLink.click();
    }
  } catch (error) {
    message.textContent = 'Kartu belum berhasil dibuat: ' + (error && error.message ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v3h16v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Simpan Kartu ke HP';
  }
}

async function shareCardLink() {
  const message = document.getElementById('saveMsg');
  const url = window.location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Kartu Member RBM', text: 'Ini link kartu digital member RBM saya.', url: url });
      message.textContent = 'Menu berbagi link sudah dibuka.';
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      message.textContent = 'Link kartu disalin. Anda dapat mengirimkannya melalui WhatsApp.';
    } else {
      message.textContent = 'Salin alamat halaman kartu dari kolom alamat browser.';
    }
  } catch (error) {
    if (!error || error.name !== 'AbortError') message.textContent = 'Link belum dapat dibagikan. Salin alamat halaman dari browser.';
  }
}

function initialiseAdmin() {
  const loginForm = document.getElementById('adminLoginForm');
  if (!loginForm || loginForm.dataset.initialised === 'true') return;
  loginForm.dataset.initialised = 'true';

  loginForm.addEventListener('submit', function(event) {
    event.preventDefault();
    loginAdmin();
  });
  document.getElementById('memberSearch').addEventListener('input', renderMembers);
  document.getElementById('memberFilter').addEventListener('change', renderMembers);
  document.getElementById('memberList').addEventListener('click', function(event) {
    const button = event.target.closest('[data-action="toggle-status"]');
    if (button) toggleMemberStatus(button.dataset.id, button.dataset.next);
  });
}

async function loginAdmin() {
  const pinInput = document.getElementById('pin');
  const button = document.getElementById('loginBtn');
  const message = document.getElementById('loginMsg');
  adminPin = pinInput.value.trim();
  if (!adminPin) {
    message.textContent = 'Masukkan PIN admin.';
    return;
  }

  button.disabled = true;
  button.textContent = 'Memeriksa PIN...';
  message.textContent = '';
  try {
    await api('checkAdminPin', { pin: adminPin });
    document.getElementById('adminLogin').hidden = true;
    document.getElementById('adminDashboard').hidden = false;
    await loadDashboard();
  } catch (error) {
    adminPin = '';
    showError('loginMsg', error);
  } finally {
    button.disabled = false;
    button.textContent = 'Masuk ke Dashboard →';
  }
}

async function logoutAdmin() {
  await stopScanner();
  adminPin = '';
  dashboardMembers = [];
  document.getElementById('adminDashboard').hidden = true;
  document.getElementById('adminLogin').hidden = false;
  document.getElementById('adminLoginForm').reset();
  document.getElementById('scannerPanel').hidden = true;
  document.getElementById('scannerToggle').textContent = 'Buka Scanner QR →';
  document.getElementById('memberList').innerHTML = '';
  document.getElementById('memberCount').textContent = '';
}

async function loadDashboard() {
  const list = document.getElementById('memberList');
  const refreshButton = document.getElementById('refreshBtn');
  if (!adminPin) return;
  list.innerHTML = '<div class="empty-state">Memuat data member...</div>';
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Memuat...';
  }

  try {
    const data = await api('getAdminDashboard', { pin: adminPin });
    dashboardMembers = Array.isArray(data.members) ? data.members : [];
    document.getElementById('statTotal').textContent = data.total || 0;
    document.getElementById('statActive').textContent = data.active || 0;
    document.getElementById('statInactive').textContent = data.inactive || 0;
    renderMembers();
  } catch (error) {
    list.innerHTML = '<div class="empty-state error">' + escapeHtml(error && error.message ? error.message : error) + '</div>';
  } finally {
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5m10-1a7 7 0 0 0-12.2-4.6L4 8m16 8-2.8 2.6A7 7 0 0 1 4 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg> Muat Ulang';
    }
  }
}

function renderMembers() {
  const list = document.getElementById('memberList');
  if (!list) return;
  const query = document.getElementById('memberSearch').value.trim().toLowerCase();
  const filter = document.getElementById('memberFilter').value;
  const filtered = dashboardMembers.filter(function(member) {
    const status = String(member.status || '').toLowerCase();
    const searchable = [member.name, member.phone, member.memberId, member.email].join(' ').toLowerCase();
    return (!query || searchable.includes(query)) && (filter === 'all' || status === filter);
  });

  document.getElementById('memberCount').textContent = 'Menampilkan ' + filtered.length + ' dari ' + dashboardMembers.length + ' member.';
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">Tidak ada member yang sesuai dengan pencarian.</div>';
    return;
  }

  list.innerHTML = filtered.map(function(member) {
    const active = String(member.status || '').toLowerCase() === 'aktif';
    const statusText = active ? 'Aktif' : 'Nonaktif';
    const nextStatus = active ? 'Nonaktif' : 'Aktif';
    const phone = String(member.phone || '-');
    const cardUrl = String(member.cardUrl || '');
    const waMessage = 'Halo ' + String(member.name || '') + ', berikut link kartu digital member RBM Anda: ' + cardUrl;
    const waUrl = makeWhatsAppUrl(phone, waMessage);

    return '<article class="member-item">' +
      '<div class="member-head">' +
        '<div><strong>' + escapeHtml(member.name || 'Tanpa nama') + '</strong>' +
        '<div class="member-code">' + escapeHtml(member.memberId || '-') + '</div></div>' +
        '<span class="badge-status ' + (active ? 'badge-active' : 'badge-inactive') + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="member-meta">' +
        '<div>WhatsApp: ' + escapeHtml(phone) + '</div>' +
        '<div>Email: ' + escapeHtml(member.email || '-') + '</div>' +
        '<div>Bergabung: ' + escapeHtml(member.createdAt || '-') + '</div>' +
      '</div>' +
      '<div class="member-actions">' +
        (cardUrl ? '<a href="' + escapeHtml(cardUrl) + '" target="_blank" rel="noopener">Lihat Kartu</a>' : '<span class="member-code">Link kartu tidak tersedia</span>') +
        (waUrl ? '<a class="whatsapp" href="' + escapeHtml(waUrl) + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
        '<button type="button" data-action="toggle-status" data-id="' + escapeHtml(member.memberId || '') + '" data-next="' + nextStatus + '">' + (active ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
      '</div>' +
    '</article>';
  }).join('');
}

async function toggleMemberStatus(memberId, nextStatus) {
  if (!memberId || !['Aktif', 'Nonaktif'].includes(nextStatus)) return;
  const promptText = nextStatus === 'Nonaktif' ? 'Nonaktifkan member ini?' : 'Aktifkan kembali member ini?';
  if (!window.confirm(promptText)) return;
  try {
    await api('setMemberStatus', { memberId: memberId, status: nextStatus, pin: adminPin });
    await loadDashboard();
  } catch (error) {
    window.alert(error && error.message ? error.message : String(error));
  }
}

async function toggleScanner() {
  const panel = document.getElementById('scannerPanel');
  const button = document.getElementById('scannerToggle');
  if (panel.hidden) {
    panel.hidden = false;
    button.textContent = 'Tutup Scanner QR';
    await startScanner();
  } else {
    await stopScanner();
    panel.hidden = true;
    button.textContent = 'Buka Scanner QR →';
  }
}

async function startScanner() {
  const message = document.getElementById('scanMsg');
  if (typeof Html5Qrcode === 'undefined') {
    message.textContent = 'Library scanner tidak berhasil dimuat. Gunakan input token manual.';
    return;
  }
  if (html5Qr && html5Qr.isScanning) return;
  try {
    if (html5Qr) {
      try { await html5Qr.clear(); } catch (clearError) {}
      html5Qr = null;
    }
    html5Qr = new Html5Qrcode('reader');
    await html5Qr.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      async function(decodedText) {
        await stopScanner();
        verifyToken(decodedText);
      },
      function() {}
    );
  } catch (error) {
    message.textContent = 'Kamera tidak dapat dibuka. Izinkan akses kamera atau gunakan input token manual. ' +
      (error && error.message ? error.message : '');
  }
}

async function stopScanner() {
  if (!html5Qr) return;
  try {
    if (html5Qr.isScanning) await html5Qr.stop();
    await html5Qr.clear();
  } catch (error) {
    // Abaikan jika kamera sudah berhenti atau elemen scanner telah dibersihkan.
  }
  html5Qr = null;
}

function checkManual() {
  const token = document.getElementById('manualToken').value.trim();
  if (token) verifyToken(token);
  else document.getElementById('scanMsg').textContent = 'Masukkan token QR terlebih dahulu.';
}

async function verifyToken(token) {
  document.getElementById('scanMsg').textContent = 'Memeriksa database RBM...';
  document.getElementById('memberResult').innerHTML = '';
  try {
    const member = await api('verifyMember', { token: token, pin: adminPin });
    const target = document.getElementById('memberResult');
    if (!member.found) {
      target.innerHTML = '<div class="result error"><strong>MEMBER TIDAK DITEMUKAN</strong><br>' + escapeHtml(member.message) + '</div>';
    } else {
      target.innerHTML =
        '<div class="result">' +
          '<div class="success" style="font-weight:800;margin-bottom:10px">DATA MEMBER DITEMUKAN</div>' +
          field('Nama lengkap', member.name) +
          field('Nomor WhatsApp', member.phone) +
          field('Email', member.email) +
          field('Member ID', member.memberId) +
          field('Status', member.status) +
          field('Tanggal bergabung', member.createdAt) +
          '<p class="member-code" style="margin:12px 0 0;line-height:1.6">Cocokkan nama dan nomor WhatsApp dengan data pelanggan. Diskon 5% diberikan secara manual jika data sesuai dan status member Aktif.</p>' +
        '</div>';
    }
    document.getElementById('scanMsg').textContent = '';
  } catch (error) {
    showError('scanMsg', error);
  }
}

function field(label, value) {
  return '<div class="field"><small>' + escapeHtml(label) + '</small><strong>' + escapeHtml(value || '-') + '</strong></div>';
}

window.addEventListener('beforeunload', function() {
  if (cardImageObjectUrl) URL.revokeObjectURL(cardImageObjectUrl);
  if (html5Qr && html5Qr.isScanning) html5Qr.stop().catch(function() {});
});

showPage();
initialiseRegistration();
