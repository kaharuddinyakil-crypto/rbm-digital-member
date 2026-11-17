const PAGE_PARAMS = new URLSearchParams(window.location.search);
const IS_PWA_START = PAGE_PARAMS.get('source') === 'pwa';
const EXP_SAVED_MEMBER_TOKEN_KEY = 'expVipMemberCardToken';

function readSavedMemberTokenFromCookie() {
  try {
    const prefix = EXP_SAVED_MEMBER_TOKEN_KEY + '=';
    const item = document.cookie.split(';').map(function(part) { return part.trim(); })
      .find(function(part) { return part.indexOf(prefix) === 0; });
    return item ? decodeURIComponent(item.substring(prefix.length)) : '';
  } catch (error) {
    return '';
  }
}

function readSavedMemberToken() {
  // Cookie didahulukan agar token terbaru dari Safari ikut terbaca saat
  // Home Screen web app iPhone dibuat dari browser yang terpisah.
  let token = readSavedMemberTokenFromCookie();
  if (/^[a-f0-9]{32}$/i.test(token)) return token;

  try { token = localStorage.getItem(EXP_SAVED_MEMBER_TOKEN_KEY) || ''; } catch (error) {}
  return /^[a-f0-9]{32}$/i.test(token) ? token : '';
}

function clearSavedMemberToken() {
  try { localStorage.removeItem(EXP_SAVED_MEMBER_TOKEN_KEY); } catch (error) {}
  try {
    document.cookie = EXP_SAVED_MEMBER_TOKEN_KEY +
      '=; Max-Age=0; Path=/; SameSite=Lax; Secure';
  } catch (error) {}
}

const SAVED_MEMBER_TOKEN = IS_PWA_START ? readSavedMemberToken() : '';
const REQUESTED_PAGE = PAGE_PARAMS.get('page') || '';
const PAGE = REQUESTED_PAGE || (IS_PWA_START && SAVED_MEMBER_TOKEN ? 'card' : 'home');
const TOKEN = PAGE_PARAMS.get('id') || (IS_PWA_START && PAGE === 'card' ? SAVED_MEMBER_TOKEN : '');
// QR kartu baru membuka halaman admin dengan token tertunda. Detail tetap
// terkunci sampai PIN admin berhasil diverifikasi.
const ADMIN_SCAN_TOKEN = PAGE_PARAMS.get('scan') || PAGE_PARAMS.get('token') || '';

let adminPin = '';
let dashboardMembers = [];
let html5Qr = null;
let currentMemberCardQrValue = '';
let currentMemberCard = null;
let deferredInstallPrompt = null;
let pwaInstalledInSession = false;

// Runtime navigation state. Admin card previews stay inside this document,
// so the verified admin session remains in memory when returning from a card.
let currentAppView = PAGE;
let activeCardToken = TOKEN;
let adminDashboardScrollY = 0;

function setVisiblePage(page) {
  const allowed = ['home', 'register', 'login', 'card', 'admin'];
  const view = allowed.includes(page) ? page : 'home';

  currentAppView = view;
  document.body.dataset.page = view;
  document.getElementById('homePage').hidden = view !== 'home';
  document.getElementById('registerPage').hidden = view !== 'register';
  document.getElementById('customerLoginPage').hidden = view !== 'login';
  document.getElementById('cardPage').hidden = view !== 'card';
  document.getElementById('adminPage').hidden = view !== 'admin';

  const topbarSide = document.querySelector('.topbar-side');
  if (topbarSide) topbarSide.hidden = view === 'home';
}

function showPage() {
  const allowed = ['home', 'register', 'login', 'card', 'admin'];
  const page = allowed.includes(PAGE) ? PAGE : 'home';
  setVisiblePage(page);

  // A fresh admin page load always starts at the PIN screen.
  // Successful login replaces this state instead of adding a fake PIN history step.
  if (page === 'admin') {
    const state = window.history.state && typeof window.history.state === 'object'
      ? window.history.state
      : {};
    window.history.replaceState(
      Object.assign({}, state, { expView: 'admin-pin' }),
      '',
      window.location.href
    );
  }

  if (page === 'card') loadMemberCard(TOKEN);
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

function brandUiText(value) {
  return String(value == null ? '' : value)
    .replace(/database RBM/gi, 'database EXP')
    .replace(/member RBM/gi, 'member EXP')
    .replace(/website RBM/gi, 'website EXPHONE SERVICE JAYAPURA')
    .replace(/RBM Digital Member/gi, 'EXP Digital Member');
}

function showError(id, error) {
  const target = document.getElementById(id);
  if (!target) return;
  target.textContent = brandUiText(error && error.message ? error.message : String(error));
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

function formatMemberName(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
}

function buildAdminScanUrl(token) {
  const url = new URL('/', window.location.origin);
  url.searchParams.set('page', 'admin');
  url.searchParams.set('scan', String(token || '').trim());
  return url.toString();
}

function makeWhatsAppUrl(phone, message) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.substring(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  else if (!digits.startsWith('62')) digits = '62' + digits;
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(message || '');
}

function showRegistrationResult(result, messageId) {
  const message = document.getElementById(messageId || 'regMsg');
  if (!message) return;
  const cardUrl = String(result.cardUrl || '');
  const displayName = formatMemberName(result.name || 'Tanpa nama');

  message.innerHTML =
    '<div class="success-box">' +
      '<strong class="success">Pendaftaran berhasil.</strong><br>' +
      'Nama: ' + escapeHtml(displayName) + '<br>' +
      'Member ID: ' + escapeHtml(result.memberId) + '<br><br>' +
      '<a class="text-link" href="' + escapeHtml(cardUrlWithReturn(cardUrl, 'register')) + '">Buka kartu digital</a>' +
    '</div>';
}

function initialiseRegistration() {
  const forms = [
    { form: 'regForm', button: 'regBtn', message: 'regMsg', submitLabel: '<span>Buat Kartu Member</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' }
  ];

  forms.forEach(function(config) {
    const form = document.getElementById(config.form);
    if (!form || form.dataset.initialised === 'true') return;
    form.dataset.initialised = 'true';
    const button = document.getElementById(config.button);
    const message = document.getElementById(config.message);
    const originalButtonHtml = button ? button.innerHTML : config.submitLabel;

    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      const formData = Object.fromEntries(new FormData(form).entries());
      formData.name = formatMemberName(formData.name);

      if (button) {
        button.disabled = true;
        button.innerHTML = '<span>Mendaftarkan...</span>';
      }
      if (message) message.textContent = '';

      try {
        const result = await api('registerMember', { form: formData });
        showRegistrationResult(result, config.message);
        form.reset();
      } catch (error) {
        showError(config.message, error);
      } finally {
        if (button) {
          button.disabled = false;
          button.innerHTML = originalButtonHtml;
        }
      }
    });
  });
}

function resetMemberCardView() {
  const loading = document.getElementById('cardLoading');
  const content = document.getElementById('cardContent');
  const error = document.getElementById('cardError');
  const saveMessage = document.getElementById('saveMsg');
  const qr = document.getElementById('qr');
  const status = document.getElementById('cardStatus');

  if (loading) loading.hidden = false;
  if (content) content.hidden = true;
  if (error) error.textContent = '';
  if (saveMessage) saveMessage.textContent = '';
  if (qr) qr.innerHTML = '';
  if (status) status.classList.remove('status-inactive');
}

function openAdminCardInApp(token) {
  const memberToken = String(token || '').trim();
  const dashboard = document.getElementById('adminDashboard');

  if (!memberToken || !adminPin || !dashboard || dashboard.hidden) return false;

  // Stop any active camera before switching views, but keep the dashboard DOM
  // and the verified PIN in memory.
  if (typeof stopScanner === 'function') {
    Promise.resolve(stopScanner()).catch(function() {});
  }

  adminDashboardScrollY = window.scrollY || window.pageYOffset || 0;

  const currentState = window.history.state && typeof window.history.state === 'object'
    ? window.history.state
    : {};
  window.history.replaceState(
    Object.assign({}, currentState, { expView: 'admin-dashboard' }),
    '',
    window.location.href
  );

  const cardUrl = new URL('/', window.location.origin);
  cardUrl.searchParams.set('page', 'card');
  cardUrl.searchParams.set('id', memberToken);
  cardUrl.searchParams.set('from', 'admin');

  window.history.pushState(
    {
      expView: 'admin-card',
      token: memberToken,
      returnScrollY: adminDashboardScrollY
    },
    '',
    cardUrl.toString()
  );

  activeCardToken = memberToken;
  resetMemberCardView();
  setVisiblePage('card');
  window.scrollTo({ top: 0, behavior: 'auto' });
  loadMemberCard(memberToken);
  return true;
}

function navigateBack(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();

  const page = document.body.dataset.page || currentAppView || PAGE;

  // Use the actual browser history. Admin dashboard is not a separate fake
  // history step, so Back leaves the dashboard instead of reopening the PIN form.
  if (window.history.length > 1) {
    window.history.back();
    return false;
  }

  // Directly opened pages have no previous entry. Use a safe route fallback.
  if (page === 'card') {
    const currentUrl = new URL(window.location.href);
    const requestedReturn = currentUrl.searchParams.get('from') || PAGE_PARAMS.get('from') || 'login';
    const allowedReturn = ['register', 'login', 'admin'];
    const returnPage = allowedReturn.includes(requestedReturn) ? requestedReturn : 'login';
    window.location.replace('/?page=' + returnPage);
    return false;
  }

  window.location.replace('/');
  return false;
}

function cardUrlWithReturn(cardUrl, source) {
  const value = String(cardUrl || '').trim();
  if (!value) return '';

  const allowedSources = ['register', 'login', 'admin'];
  const returnPage = allowedSources.includes(source) ? source : 'login';

  try {
    const originalUrl = new URL(value, window.location.origin);
    const cardPage = originalUrl.searchParams.get('page') === 'card';
    const token = originalUrl.searchParams.get('id') || originalUrl.searchParams.get('token');

    // Normalize legacy Apps Script card URLs to the Cloudflare application origin.
    if (cardPage && token) {
      const localCardUrl = new URL('/', window.location.origin);
      localCardUrl.searchParams.set('page', 'card');
      localCardUrl.searchParams.set('id', token);
      localCardUrl.searchParams.set('from', returnPage);
      return localCardUrl.toString();
    }

    if (originalUrl.origin === window.location.origin && cardPage) {
      originalUrl.searchParams.set('from', returnPage);
    }
    return originalUrl.toString();
  } catch (error) {
    return value;
  }
}

function normalizeNameForSort(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizePhoneForSearch(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('62')) digits = '0' + digits.substring(2);
  else if (digits.startsWith('8')) digits = '0' + digits;
  return digits;
}

function normalizeMemberIdForSearch(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function memberMatchesQuery(member, query) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return true;

  const nameQuery = normalizeNameForSort(rawQuery);
  const nameValue = normalizeNameForSort(member && member.name);
  const nameParts = nameQuery.split(/\s+/).filter(Boolean);
  const nameMatch = nameParts.length > 0 && nameParts.every(function(part) {
    return nameValue.includes(part);
  });

  const queryDigits = rawQuery.replace(/\D/g, '');
  const phoneRaw = String(member && member.phone || '').replace(/\D/g, '');
  const phoneNormalized = normalizePhoneForSearch(member && member.phone);
  const queryPhoneNormalized = normalizePhoneForSearch(rawQuery);
  const phoneMatch = queryDigits.length >= 3 && (
    phoneRaw.includes(queryDigits) ||
    phoneNormalized.includes(queryDigits) ||
    (queryPhoneNormalized.length >= 3 && phoneNormalized.includes(queryPhoneNormalized))
  );

  const queryId = normalizeMemberIdForSearch(rawQuery);
  const memberId = normalizeMemberIdForSearch(member && member.memberId);
  const idMatch = queryId.length >= 2 && memberId.includes(queryId);

  return nameMatch || phoneMatch || idMatch;
}

function initialiseCustomerLogin() {
  const form = document.getElementById('customerLoginForm');
  if (!form || form.dataset.initialised === 'true') return;
  form.dataset.initialised = 'true';

  form.addEventListener('submit', async function(event) {
    event.preventDefault();

    const phone = document.getElementById('customerPhone').value.trim();
    const nameHint = normalizeNameForSort(document.getElementById('customerName').value);
    const button = document.getElementById('customerLoginBtn');
    const message = document.getElementById('customerLoginMsg');
    const cards = document.getElementById('customerCards');

    button.disabled = true;
    button.innerHTML = '<span>Mencari kartu...</span>';
    message.textContent = '';
    cards.innerHTML = '';

    try {
      const data = await api('findMembersByPhone', { phone: phone });
      const members = Array.isArray(data.members) ? data.members.slice() : [];

      if (!members.length) {
        message.textContent = 'Nomor WhatsApp belum ditemukan. Periksa kembali angka nomor yang digunakan saat pendaftaran.';
        message.className = 'customer-login-status is-error';
        return;
      }

      if (nameHint) {
        members.sort(function(a, b) {
          const aName = normalizeNameForSort(a.name);
          const bName = normalizeNameForSort(b.name);
          const aScore = aName === nameHint ? 0 : (aName.includes(nameHint) || nameHint.includes(aName) ? 1 : 2);
          const bScore = bName === nameHint ? 0 : (bName.includes(nameHint) || nameHint.includes(bName) ? 1 : 2);
          return aScore - bScore;
        });
      }

      message.textContent = members.length === 1
        ? 'Kartu member ditemukan. Tekan tombol untuk membukanya.'
        : 'Ditemukan ' + members.length + ' kartu dengan nomor ini. Pilih kartu yang sesuai dengan nama Anda.';
      message.className = 'customer-login-status is-success';

      cards.innerHTML = members.map(function(member) {
        const status = String(member.status || '').toLowerCase() === 'aktif' ? 'Aktif' : 'Nonaktif';
        const statusClass = status === 'Aktif' ? 'customer-status-active' : 'customer-status-inactive';
        const cardUrl = String(member.cardUrl || '');
        const customerCardUrl = cardUrlWithReturn(cardUrl, 'login');
        return '<article class="customer-card-result">' +
          '<div class="customer-card-info">' +
            '<strong>' + escapeHtml(formatMemberName(member.name || 'Tanpa nama')) + '</strong>' +
            '<span>' + escapeHtml(member.memberId || '-') + '</span>' +
            '<span class="customer-card-status ' + statusClass + '">' + status + '</span>' +
          '</div>' +
          (cardUrl
            ? '<a class="button button-primary" href="' + escapeHtml(customerCardUrl) + '">Buka kartu digital</a>'
            : '<span class="member-code">Link kartu belum tersedia.</span>') +
        '</article>';
      }).join('');
    } catch (error) {
      message.textContent = brandUiText(error && error.message ? error.message : String(error));
      message.className = 'customer-login-status is-error';
    } finally {
      button.disabled = false;
      button.innerHTML = '<span>Temukan Kartu Saya</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
  });
}

function initialiseCardQrPopup() {
  const modal = document.getElementById('qrCardModal');
  if (!modal || modal.dataset.initialised === 'true') return;
  modal.dataset.initialised = 'true';

  modal.addEventListener('click', function(event) {
    if (event.target.closest('[data-qr-close]')) closeCardQrPopup();
  });

  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && !modal.hidden) closeCardQrPopup();
  });
}

function openCardQrPopup() {
  const modal = document.getElementById('qrCardModal');
  if (!modal || !currentMemberCardQrValue || !currentMemberCard) return;

  const qrTarget = document.getElementById('qrPopup');
  if (typeof QRCode === 'undefined' || !qrTarget) {
    showError('saveMsg', new Error('QR Code belum dapat dimuat. Periksa koneksi internet lalu muat ulang halaman.'));
    return;
  }

  qrTarget.innerHTML = '';
  new QRCode(qrTarget, {
    text: currentMemberCardQrValue,
    width: 320,
    height: 320,
    colorDark: '#17182b',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  document.getElementById('qrPopupName').textContent = currentMemberCard.name || '-';
  document.getElementById('qrPopupId').textContent = currentMemberCard.memberId || '-';
  modal.hidden = false;
  document.body.classList.add('qr-modal-open');
  const closeButton = modal.querySelector('.qr-sheet-close');
  if (closeButton) closeButton.focus();
}

function closeCardQrPopup() {
  const modal = document.getElementById('qrCardModal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('qr-modal-open');
  const trigger = document.getElementById('showCardQrBtn');
  if (trigger) trigger.focus();
}

async function loadMemberCard(tokenOverride) {
  const loading = document.getElementById('cardLoading');
  const content = document.getElementById('cardContent');
  const memberToken = String(tokenOverride || TOKEN || '').trim();
  activeCardToken = memberToken;

  if (!memberToken) {
    loading.hidden = true;
    showError('cardError', new Error('Link kartu tidak memiliki kode member. Buka tautan kartu yang diberikan saat pendaftaran.'));
    return;
  }

  try {
    const member = await api('getMemberCard', { token: memberToken });
    currentMemberCard = member;

    // Simpan token saat kartu dibuka dari PWA, atau melalui tautan khusus
    // perpindahan browser yang dibuat oleh tombol pemasangan.
    const shouldRememberCard = isRunningAsInstalledApp() || PAGE_PARAMS.get('exp-install') === '1';
    if (shouldRememberCard && rememberMemberForInstalledApp() && PAGE_PARAMS.has('exp-install')) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('exp-install');
      window.history.replaceState({}, '', cleanUrl.toString());
    }
    document.getElementById('cardName').textContent = formatMemberName(member.name || '-');
    document.getElementById('cardId').textContent = member.memberId || '-';
    const status = document.getElementById('cardStatus');
    status.textContent = String(member.status || 'Aktif').toLowerCase().replace(/^./, function(letter) { return letter.toUpperCase(); });
    if (String(member.status || '').toLowerCase() !== 'aktif') {
      status.classList.add('status-inactive');
    }

    if (typeof QRCode === 'undefined') throw new Error('Library QR Code belum termuat. Periksa koneksi internet lalu muat ulang halaman.');
    const qrTarget = document.getElementById('qr');
    qrTarget.innerHTML = '';
    // QR kartu berisi URL EXP menuju halaman admin dengan token member.
    // Kamera bawaan HP dapat membuka URL ini; detail tetap terkunci oleh PIN admin.
    // Scanner dashboard juga dapat membaca URL ini dan QR lama yang hanya berisi token.
    currentMemberCardQrValue = buildAdminScanUrl(memberToken);
    new QRCode(qrTarget, {
      text: currentMemberCardQrValue,
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

    // Jika shortcut menyimpan token member yang sudah tidak valid,
    // hapus akses lama dan minta customer login kembali.
    const errorMessage = error && error.message ? error.message : String(error);
    if (IS_PWA_START && /member tidak ditemukan|kode member tidak ditemukan/i.test(errorMessage)) {
      clearSavedMemberToken();
      window.location.replace('/?page=login');
      return;
    }

    showError('cardError', error);
  }
}

function isRunningAsInstalledApp() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;
}

function isAppleMobileDevice() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function getInstallEnvironment() {
  const ua = navigator.userAgent || '';
  const apple = isAppleMobileDevice();
  const inApp = /GSA\/|GoogleApp|; wv\)|FBAN|FBAV|Instagram|Line\//i.test(ua);
  if (apple) return inApp ? 'ios-inapp' : 'ios';
  if (/Android/i.test(ua)) return inApp ? 'android-inapp' : 'android';
  return 'other';
}

function closeEXPInstallModal() {
  const modal = document.getElementById('expInstallModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('exp-install-open');
}

function openEXPInstallModal(config) {
  const modal = document.getElementById('expInstallModal');
  const title = document.getElementById('expInstallTitle');
  const description = document.getElementById('expInstallDescription');
  const steps = document.getElementById('expInstallSteps');
  const primary = document.getElementById('expInstallPrimary');
  const secondary = document.getElementById('expInstallSecondary');
  if (!modal || !title || !description || !steps || !primary || !secondary) return;

  title.textContent = config.title || 'Tambahkan Kartu Member ke Layar Utama';
  description.textContent = config.description || '';
  steps.innerHTML = config.steps || '';
  primary.textContent = config.primaryLabel || 'Mengerti';
  primary.onclick = config.primaryAction || closeEXPInstallModal;
  secondary.hidden = !config.secondaryLabel;
  secondary.textContent = config.secondaryLabel || '';
  secondary.onclick = config.secondaryAction || null;
  modal.hidden = false;
  document.body.classList.add('exp-install-open');
  primary.focus();
}

function copyEXPHONEInstallLink() {
  const cardUrl = new URL(window.location.href);
  cardUrl.searchParams.set('exp-install', '1');
  const url = cardUrl.toString();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function() {
      const description = document.getElementById('expInstallDescription');
      if (description) description.textContent = 'Tautan kartu sudah disalin. Buka Safari dan tempel tautan tersebut. Akses kartu akan tersimpan di Safari sebelum Anda menambahkannya ke Layar Utama.';
    }).catch(function() {
      const description = document.getElementById('expInstallDescription');
      if (description) description.textContent = 'Salin tautan kartu, buka Safari, lalu tempel tautan tersebut. Setelah kartu terbuka, tambahkan ke Layar Utama.';
    });
  } else {
    const description = document.getElementById('expInstallDescription');
    if (description) description.textContent = 'Salin tautan kartu, buka Safari, lalu tempel tautan tersebut. Setelah kartu terbuka, tambahkan ke Layar Utama.';
  }
}

function openEXPHONEInChrome() {
  const current = new URL(window.location.href);
  current.searchParams.set('exp-install', '1');
  const intentUrl = 'intent://' + current.host + current.pathname + current.search + current.hash +
    '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' +
    encodeURIComponent(current.href) + ';end';
  window.location.href = intentUrl;
}

function installStep(number, icon, heading, detail) {
  return '<div class="exp-install-step"><span class="exp-install-step-number">' + number + '</span>' +
    '<span class="exp-install-step-icon" aria-hidden="true">' + icon + '</span>' +
    '<span class="exp-install-step-copy"><strong>' + heading + '</strong><small>' + detail + '</small></span></div>';
}

function rememberMemberForInstalledApp() {
  const token = String(activeCardToken || TOKEN || '').trim();
  if (!token || !/^[a-f0-9]{32}$/i.test(token)) return false;

  let saved = false;
  try {
    localStorage.setItem(EXP_SAVED_MEMBER_TOKEN_KEY, token);
    saved = true;
  } catch (error) {}

  // iOS Home Screen web apps do not inherit localStorage from Safari.
  // WebKit copies first-party cookies when the user adds the site to Home Screen.
  try {
    document.cookie = EXP_SAVED_MEMBER_TOKEN_KEY + '=' + encodeURIComponent(token) +
      '; Max-Age=31536000; Path=/; SameSite=Lax; Secure';
    if (readSavedMemberTokenFromCookie() === token) saved = true;
  } catch (error) {}

  return saved;
}

function updateInstallButton() {
  const button = document.getElementById('saveCardBtn');
  if (!button) return;

  if (isRunningAsInstalledApp() || pwaInstalledInSession) {
    button.disabled = false;
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Simpan Akses Kartu Ini';
  } else {
    button.disabled = false;
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="6" y="2.8" width="12" height="18.4" rx="2.3" stroke="currentColor" stroke-width="1.7"/><path d="M10 18h4M12 6.5v5m0 0 2.2-2.2M12 11.5 9.8 9.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg> Tambahkan Kartu Member ke Layar Utama';
  }
}

function initialiseSavedMemberShortcut() {
  const container = document.getElementById('savedMemberShortcut');
  const link = document.getElementById('savedMemberShortcutLink');
  const clearButton = document.getElementById('clearSavedMemberShortcut');
  if (!container || !link) return;

  const savedToken = readSavedMemberToken();

  if (!/^[a-f0-9]{32}$/i.test(savedToken)) {
    clearSavedMemberToken();
    return;
  }

  const cardUrl = new URL('/', window.location.origin);
  cardUrl.searchParams.set('page', 'card');
  cardUrl.searchParams.set('id', savedToken);
  link.href = cardUrl.toString();
  container.hidden = false;

  if (clearButton) {
    clearButton.addEventListener('click', function() {
      clearSavedMemberToken();
      container.hidden = true;
    });
  }
}

function initialisePWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none'
    }).catch(function(error) {
      console.warn('PWA service worker belum dapat didaftarkan:', error);
    });
  }

  window.addEventListener('beforeinstallprompt', function(event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallButton();
  });

  window.addEventListener('appinstalled', function() {
    deferredInstallPrompt = null;
    pwaInstalledInSession = true;
    updateInstallButton();
    const message = document.getElementById('saveMsg');
    if (message) {
      message.hidden = false;
      message.textContent = 'Kartu member siap diakses dari ikon aplikasi pada layar utama.';
    }
  });

  document.querySelectorAll('[data-exp-install-close]').forEach(function(element) {
    element.addEventListener('click', closeEXPInstallModal);
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeEXPInstallModal();
  });

  updateInstallButton();
  initialiseSavedMemberShortcut();
}

async function installEXPHONEApp() {
  const button = document.getElementById('saveCardBtn');
  const message = document.getElementById('saveMsg');
  const remembered = rememberMemberForInstalledApp();

  if (isRunningAsInstalledApp() || pwaInstalledInSession) {
    if (message) {
      message.hidden = false;
      message.textContent = remembered
        ? 'Kartu member ini tersimpan sebagai kartu utama pada perangkat. Buka ikon aplikasi dari layar utama untuk menampilkannya kembali.'
        : 'Akses kartu belum dapat disimpan. Silakan buka kembali kartu melalui Login Member.';
    }
    updateInstallButton();
    return;
  }

  // Android Chromium: use the browser's genuine native install confirmation.
  if (deferredInstallPrompt) {
    const installPrompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    if (button) {
      button.disabled = true;
      button.textContent = 'Membuka pemasangan...';
    }
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        pwaInstalledInSession = true;
        if (message) {
          message.hidden = false;
          message.textContent = remembered
            ? 'Kartu member berhasil disiapkan. Buka ikon aplikasi dari layar utama untuk mengakses kartu ini.'
            : 'Aplikasi berhasil dipasang. Buka ikon aplikasi, lalu login untuk menampilkan kartu member.';
        }
      }
    } catch (error) {
      console.warn('Dialog instalasi native tidak dapat dibuka:', error);
    } finally {
      if (button) button.disabled = false;
      updateInstallButton();
    }
    return;
  }

  const environment = getInstallEnvironment();
  const shareIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const addIcon = '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v8m-4-4h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const checkIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4.2 4.2L19 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  if (environment === 'ios') {
    openEXPInstallModal({
      title: 'Tambahkan Kartu Member ke Layar Utama',
      description: 'Di iPhone, pemasangan perlu dikonfirmasi melalui menu Bagikan pada Safari. Setelah ditambahkan, ikon akan membuka kartu member Anda.',
      steps: installStep('1', shareIcon, 'Bagikan', 'Di Safari, tekan ikon Bagikan pada bagian bawah browser.') +
        installStep('2', addIcon, 'Tambahkan ke Layar Utama', 'Pilih opsi “Tambahkan ke Layar Utama”.') +
        installStep('3', checkIcon, 'Konfirmasi', 'Tekan “Tambahkan”. Ikon kartu member akan muncul di layar utama.'),
      primaryLabel: 'Selesai'
    });
    return;
  }

  if (environment === 'ios-inapp') {
    openEXPInstallModal({
      title: 'Buka kartu melalui Safari',
      description: 'Browser di dalam aplikasi belum dapat memasang PWA iPhone. Salin tautan kartu, buka di Safari, lalu tambahkan ke Layar Utama.',
      steps: installStep('1', shareIcon, 'Salin tautan kartu', 'Gunakan tombol di bawah untuk menyalin tautan member Anda.') +
        installStep('2', addIcon, 'Buka di Safari', 'Tempel tautan kartu pada Safari. Akses kartu akan tersimpan di browser ini.') +
        installStep('3', checkIcon, 'Tambahkan ke Layar Utama', 'Di Safari, tekan Bagikan lalu pilih “Tambahkan ke Layar Utama”.'),
      primaryLabel: 'Salin Tautan Kartu',
      primaryAction: copyEXPHONEInstallLink,
      secondaryLabel: 'Tutup',
      secondaryAction: closeEXPInstallModal
    });
    return;
  }

  if (environment === 'android-inapp') {
    openEXPInstallModal({
      title: 'Lanjutkan di Chrome',
      description: 'Browser di dalam aplikasi belum mendukung pemasangan. Buka kartu ini di Chrome agar dialog pemasangan dapat ditampilkan.',
      steps: installStep('1', '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.5" stroke="currentColor" stroke-width="1.8"/></svg>', 'Buka Chrome', 'Tautan kartu akan dibuka di Google Chrome.') +
        installStep('2', addIcon, 'Tambahkan ke Layar Utama', 'Tekan tombol pemasangan jika dialog Chrome tersedia.'),
      primaryLabel: 'Buka di Chrome',
      primaryAction: openEXPHONEInChrome,
      secondaryLabel: 'Nanti saja',
      secondaryAction: closeEXPInstallModal
    });
    return;
  }

  if (environment === 'android') {
    openEXPInstallModal({
      title: 'Tambahkan Kartu Member ke Layar Utama',
      description: 'Browser belum menampilkan dialog pemasangan otomatis. Buka menu browser, lalu pilih “Install app” atau “Tambahkan ke Layar Utama”.',
      steps: installStep('1', addIcon, 'Buka menu browser', 'Tekan menu tiga titik pada browser yang digunakan.') +
        installStep('2', checkIcon, 'Pilih Install app', 'Konfirmasi pemasangan jika pilihan tersebut tersedia.'),
      primaryLabel: 'Mengerti'
    });
    return;
  }

  openEXPInstallModal({
    title: 'Tambahkan Kartu Member ke Layar Utama',
    description: 'Gunakan browser yang mendukung pemasangan aplikasi web untuk menambahkan akses kartu member ke layar utama.',
    steps: installStep('1', addIcon, 'Buka menu browser', 'Cari opsi Install app atau Tambahkan ke Layar Utama.') +
      installStep('2', checkIcon, 'Konfirmasi pemasangan', 'Ikuti dialog dari browser.'),
    primaryLabel: 'Mengerti'
  });
}

async function shareCardLink() {
  const message = document.getElementById('saveMsg');
  const url = window.location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Kartu Member EXP', text: 'Ini link kartu digital member EXPHONE SERVICE JAYAPURA saya.', url: url });
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
    const deleteButton = event.target.closest('[data-action="delete-member"]');
    if (deleteButton) {
      deleteMember(deleteButton.dataset.id, deleteButton.dataset.name);
      return;
    }
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

    // Tandai halaman yang sedang aktif tanpa menambah entri PIN palsu.
    // Tombol Kembali dari dashboard akan menuju halaman sebelum Admin.
    const currentState = window.history.state && typeof window.history.state === 'object'
      ? window.history.state
      : {};
    window.history.replaceState(
      Object.assign({}, currentState, { expView: 'admin-dashboard' }),
      '',
      window.location.href
    );

    document.getElementById('adminLogin').hidden = true;
    document.getElementById('adminDashboard').hidden = false;
    await loadDashboard();

    // Jika admin masuk dari QR yang dipindai kamera bawaan HP, lanjutkan
    // verifikasi otomatis setelah PIN benar dan tampilkan hasil di dashboard.
    if (ADMIN_SCAN_TOKEN) {
      const searchInput = document.getElementById('manualToken');
      if (searchInput) searchInput.value = ADMIN_SCAN_TOKEN;
      await verifyToken(ADMIN_SCAN_TOKEN);
      const result = document.getElementById('memberResult');
      if (result && result.firstElementChild) {
        result.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
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
  showAdminPinView(true);
  setVisiblePage('admin');

  const historyState = window.history.state && typeof window.history.state === 'object'
    ? window.history.state
    : {};
  window.history.replaceState(
    Object.assign({}, historyState, { expView: 'admin-pin' }),
    '',
    window.location.href
  );
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
    list.innerHTML = '<div class="empty-state error">' + escapeHtml(brandUiText(error && error.message ? error.message : error)) + '</div>';
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
  const query = document.getElementById('memberSearch').value.trim();
  const filter = document.getElementById('memberFilter').value;
  const filtered = dashboardMembers.filter(function(member) {
    const status = String(member.status || '').toLowerCase();
    return memberMatchesQuery(member, query) && (filter === 'all' || status === filter);
  });

  document.getElementById('memberCount').textContent = 'Menampilkan ' + filtered.length + ' dari ' + dashboardMembers.length + ' member.';
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">Tidak ada member yang sesuai dengan pencarian.</div>';
    return;
  }

  list.innerHTML = filtered.map(function(member) {
    const memberStatus = String(member.status || '').toLowerCase();
    const active = memberStatus === 'aktif';
    const statusText = active ? 'Aktif' : 'Nonaktif';
    const nextStatus = active ? 'Nonaktif' : 'Aktif';
    const phone = String(member.phone || '-');
    const cardUrl = String(member.cardUrl || '');
    const adminCardUrl = cardUrlWithReturn(cardUrl, 'admin');
    const displayName = formatMemberName(member.name || 'Tanpa nama');
    const waMessage = [
      '*Notifikasi|ExphoneServiceJayapura|DigitalMember*',
      '',
      'Halo, *' + displayName + '*.',
      '',
      'Selamat bergabung dengan *Exphone VIP Member*.',
      '',
      'Nikmati tambahan *diskon sebesar 5%* untuk setiap penggantian sparepart iPhone di seluruh cabang Exphone Service Jayapura. Tunjukkan kartu member Anda saat bertransaksi.',
      '',
      'Kartu member digital:',
      cardUrlWithReturn(cardUrl, 'login')
    ].join('\n');
    const waUrl = makeWhatsAppUrl(phone, waMessage);

    return '<article class="member-item">' +
      '<div class="member-head">' +
        '<div><strong>' + escapeHtml(displayName) + '</strong>' +
        '<div class="member-code">' + escapeHtml(member.memberId || '-') + '</div></div>' +
        '<span class="badge-status ' + (active ? 'badge-active' : 'badge-inactive') + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="member-meta">' +
        '<div>WhatsApp: ' + escapeHtml(phone) + '</div>' +
        '<div>Bergabung: ' + escapeHtml(member.createdAt || '-') + '</div>' +
      '</div>' +
      '<div class="member-actions">' +
        (adminCardUrl ? '<a href="' + escapeHtml(adminCardUrl) + '">Lihat Kartu</a>' : '<span class="member-code">Link kartu tidak tersedia</span>') +
        (waUrl ? '<a class="whatsapp" href="' + escapeHtml(waUrl) + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
        '<button type="button" data-action="toggle-status" data-id="' + escapeHtml(member.memberId || '') + '" data-next="' + nextStatus + '">' + (active ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
        '<button type="button" class="delete-member-button" data-action="delete-member" data-id="' + escapeHtml(member.memberId || '') + '" data-name="' + escapeHtml(displayName) + '">Hapus Member</button>' +
      '</div>' +
    '</article>';
  }).join('');
}

async function toggleMemberStatus(memberId, nextStatus) {
  if (!memberId || !['Aktif', 'Nonaktif'].includes(nextStatus)) return;

  const member = dashboardMembers.find(function(item) {
    return String(item.memberId || '') === String(memberId);
  });
  const confirmed = await confirmMemberStatusChange(
    member ? member.name : 'Tanpa nama',
    memberId,
    nextStatus
  );
  if (!confirmed) return;

  const statusButton = Array.from(document.querySelectorAll('[data-action="toggle-status"]')).find(function(button) {
    return button.dataset.id === String(memberId);
  });
  if (statusButton) {
    statusButton.disabled = true;
    statusButton.textContent = nextStatus === 'Nonaktif' ? 'Menonaktifkan...' : 'Mengaktifkan...';
  }

  try {
    await api('setMemberStatus', { memberId: memberId, status: nextStatus, pin: adminPin });
    await loadDashboard();
    showAdminToast(
      nextStatus === 'Nonaktif'
        ? 'Status member berhasil diubah menjadi Nonaktif.'
        : 'Member berhasil diaktifkan kembali.',
      'success'
    );
  } catch (error) {
    if (statusButton) {
      statusButton.disabled = false;
      statusButton.textContent = nextStatus === 'Nonaktif' ? 'Nonaktifkan' : 'Aktifkan';
    }
    showAdminToast(brandUiText(error && error.message ? error.message : String(error)), 'error');
  }
}

function confirmMemberStatusChange(memberName, memberId, nextStatus) {
  const isDeactivating = nextStatus === 'Nonaktif';
  let modal = document.getElementById('rbmStatusMemberModal');

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'rbmStatusMemberModal';
    modal.className = 'rbm-delete-modal rbm-status-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="rbm-modal-backdrop" data-modal-close></div>' +
      '<section class="rbm-confirm-dialog rbm-status-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rbmStatusTitle" aria-describedby="rbmStatusDescription">' +
        '<button type="button" class="rbm-modal-close" data-modal-close aria-label="Tutup dialog">×</button>' +
        '<div class="rbm-confirm-icon" aria-hidden="true"><span id="rbmStatusIcon">!</span></div>' +
        '<span class="rbm-modal-kicker">KONFIRMASI ADMIN</span>' +
        '<h2 id="rbmStatusTitle">Ubah status member?</h2>' +
        '<p id="rbmStatusDescription"></p>' +
        '<div class="rbm-delete-member-summary">' +
          '<small id="rbmStatusSummaryLabel">MEMBER</small>' +
          '<strong id="rbmStatusMemberName"></strong>' +
          '<span id="rbmStatusMemberId"></span>' +
        '</div>' +
        '<div class="rbm-delete-warning"><span aria-hidden="true">i</span><p id="rbmStatusWarning"></p></div>' +
        '<div class="rbm-modal-actions">' +
          '<button type="button" class="rbm-modal-cancel" data-modal-cancel>Batal</button>' +
          '<button type="button" class="rbm-modal-confirm" data-modal-confirm>Konfirmasi</button>' +
        '</div>' +
      '</section>';
    document.body.appendChild(modal);
  }

  const dialog = modal.querySelector('.rbm-status-confirm-dialog');
  dialog.classList.toggle('is-deactivate', isDeactivating);
  dialog.classList.toggle('is-activate', !isDeactivating);
  document.getElementById('rbmStatusIcon').textContent = isDeactivating ? '!' : '✓';
  document.getElementById('rbmStatusTitle').textContent = isDeactivating
    ? 'Nonaktifkan member?'
    : 'Aktifkan member kembali?';
  document.getElementById('rbmStatusDescription').textContent = isDeactivating
    ? 'Pastikan Anda memilih data member yang benar sebelum mengubah status ke Nonaktif.'
    : 'Pastikan Anda memilih data member yang benar sebelum mengaktifkan kembali keanggotaannya.';
  document.getElementById('rbmStatusSummaryLabel').textContent = isDeactivating
    ? 'Member yang akan dinonaktifkan'
    : 'Member yang akan diaktifkan';
  document.getElementById('rbmStatusMemberName').textContent = formatMemberName(memberName || 'Tanpa nama');
  document.getElementById('rbmStatusMemberId').textContent = String(memberId || '');
  document.getElementById('rbmStatusWarning').textContent = isDeactivating
    ? 'Status keanggotaan akan diubah menjadi Nonaktif. Data member tetap tersimpan dan dapat diaktifkan kembali kapan saja.'
    : 'Status keanggotaan akan diubah menjadi Aktif. Data member tetap tersimpan dan keanggotaannya dapat digunakan kembali.';
  modal.querySelector('[data-modal-confirm]').textContent = isDeactivating
    ? 'Ya, Nonaktifkan'
    : 'Ya, Aktifkan';

  return new Promise(function(resolve) {
    let finished = false;

    function finish(confirmed) {
      if (finished) return;
      finished = true;
      modal.hidden = true;
      document.body.classList.remove('rbm-modal-open');
      modal.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeydown);
      resolve(confirmed);
    }

    function handleClick(event) {
      if (event.target.closest('[data-modal-cancel]') || event.target.closest('[data-modal-close]')) {
        finish(false);
      } else if (event.target.closest('[data-modal-confirm]')) {
        finish(true);
      }
    }

    function handleKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    }

    modal.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeydown);
    modal.hidden = false;
    document.body.classList.add('rbm-modal-open');
    modal.querySelector('[data-modal-cancel]').focus();
  });
}

function confirmDeleteMember(memberName, memberId) {
  let modal = document.getElementById('rbmDeleteMemberModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'rbmDeleteMemberModal';
    modal.className = 'rbm-delete-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="rbm-modal-backdrop" data-modal-close></div>' +
      '<section class="rbm-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rbmDeleteTitle" aria-describedby="rbmDeleteDescription">' +
        '<button type="button" class="rbm-modal-close" data-modal-close aria-label="Tutup dialog">×</button>' +
        '<div class="rbm-confirm-icon" aria-hidden="true"><span>!</span></div>' +
        '<span class="rbm-modal-kicker">KONFIRMASI ADMIN</span>' +
        '<h2 id="rbmDeleteTitle">Hapus data member?</h2>' +
        '<p id="rbmDeleteDescription">Pastikan Anda memilih data yang benar sebelum melanjutkan penghapusan.</p>' +
        '<div class="rbm-delete-member-summary">' +
          '<small>Member yang akan dihapus</small>' +
          '<strong id="rbmDeleteMemberName"></strong>' +
          '<span id="rbmDeleteMemberId"></span>' +
        '</div>' +
        '<div class="rbm-delete-warning"><span aria-hidden="true">i</span><p>Data member akan dihapus permanen dari Dashboard Admin dan Google Spreadsheet. Tindakan ini tidak dapat dibatalkan.</p></div>' +
        '<div class="rbm-modal-actions">' +
          '<button type="button" class="rbm-modal-cancel" data-modal-cancel>Batal</button>' +
          '<button type="button" class="rbm-modal-confirm" data-modal-confirm>Ya, Hapus Member</button>' +
        '</div>' +
      '</section>';
    document.body.appendChild(modal);
  }

  document.getElementById('rbmDeleteMemberName').textContent = formatMemberName(memberName || 'Tanpa nama');
  document.getElementById('rbmDeleteMemberId').textContent = String(memberId || '');

  return new Promise(function(resolve) {
    let finished = false;

    function finish(confirmed) {
      if (finished) return;
      finished = true;
      modal.hidden = true;
      document.body.classList.remove('rbm-modal-open');
      modal.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeydown);
      resolve(confirmed);
    }

    function handleClick(event) {
      if (event.target.closest('[data-modal-cancel]') || event.target.closest('[data-modal-close]')) {
        finish(false);
      } else if (event.target.closest('[data-modal-confirm]')) {
        finish(true);
      }
    }

    function handleKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    }

    modal.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeydown);
    modal.hidden = false;
    document.body.classList.add('rbm-modal-open');
    modal.querySelector('[data-modal-cancel]').focus();
  });
}

function showAdminToast(message, variant) {
  let toast = document.getElementById('rbmAdminToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rbmAdminToast';
    toast.className = 'rbm-admin-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }

  toast.className = 'rbm-admin-toast' + (variant ? ' is-' + variant : '');
  toast.textContent = message;
  toast.hidden = false;
  if (window.__rbmAdminToastTimer) window.clearTimeout(window.__rbmAdminToastTimer);
  window.__rbmAdminToastTimer = window.setTimeout(function() {
    toast.hidden = true;
  }, 4200);
}

async function deleteMember(memberId, memberName) {
  if (!memberId) return;
  const confirmed = await confirmDeleteMember(memberName, memberId);
  if (!confirmed) return;

  const deleteButton = Array.from(document.querySelectorAll('[data-action="delete-member"]')).find(function(button) {
    return button.dataset.id === memberId;
  });
  if (deleteButton) {
    deleteButton.disabled = true;
    deleteButton.textContent = 'Menghapus...';
  }

  try {
    await api('deleteMember', { memberId: memberId, pin: adminPin });
    await loadDashboard();
    showAdminToast('Data member berhasil dihapus dari database EXP.', 'success');
  } catch (error) {
    if (deleteButton) {
      deleteButton.disabled = false;
      deleteButton.textContent = 'Hapus Member';
    }
    showAdminToast(brandUiText(error && error.message ? error.message : String(error)), 'error');
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
    message.textContent = 'Library scanner tidak berhasil dimuat. Gunakan pencarian nama, nomor WhatsApp, atau Member ID di bawah.';
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
    message.textContent = 'Kamera tidak dapat dibuka. Izinkan akses kamera atau gunakan pencarian manual berdasarkan nama, nomor WhatsApp, atau Member ID. ' +
      brandUiText(error && error.message ? error.message : '');
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

function extractMemberToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  // QR baru berisi URL admin dengan parameter scan. URL kartu lama dengan
  // parameter id/token dan QR lama yang hanya berisi token tetap didukung.
  try {
    const parsed = new URL(raw, window.location.origin);
    const id = parsed.searchParams.get('scan') ||
      parsed.searchParams.get('token') || parsed.searchParams.get('id');
    if (id) return id.trim();
  } catch (error) {}

  const match = raw.match(/[?&](?:scan|token|id)=([^&#]+)/i);
  if (match) {
    try { return decodeURIComponent(match[1]).trim(); }
    catch (error) { return match[1].trim(); }
  }
  return raw;
}

function checkManual() {
  const input = document.getElementById('manualToken');
  const value = input ? input.value.trim() : '';
  const message = document.getElementById('scanMsg');
  const target = document.getElementById('memberResult');

  if (!value) {
    message.textContent = 'Masukkan nama, nomor WhatsApp, atau Member ID terlebih dahulu.';
    if (target) target.innerHTML = '';
    return;
  }

  // Tautan kartu dan QR lama tetap didukung. Token tidak perlu diketik oleh admin.
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.searchParams.get('scan') || parsed.searchParams.get('token') || parsed.searchParams.get('id')) {
      verifyToken(value);
      return;
    }
  } catch (error) {}
  if (/^[a-f0-9]{32}$/i.test(value)) {
    verifyToken(value);
    return;
  }

  const matches = dashboardMembers.filter(function(member) {
    return memberMatchesQuery(member, value);
  });
  renderValidationSearchResults(matches, value);
}

function renderValidationSearchResults(matches, query) {
  const target = document.getElementById('memberResult');
  const message = document.getElementById('scanMsg');
  if (!target) return;

  if (!matches.length) {
    message.textContent = 'Tidak ditemukan member yang cocok dengan pencarian tersebut.';
    target.innerHTML = '<div class="result error"><strong>Member tidak ditemukan</strong><p>Periksa kembali nama, nomor WhatsApp, atau Member ID yang dimasukkan.</p></div>';
    return;
  }

  message.textContent = 'Ditemukan ' + matches.length + ' member yang cocok dengan “' + query + '”.';
  const visible = matches.slice(0, 20);
  target.innerHTML = '<div class="result validation-results">' +
    '<div class="validation-results-heading">' +
      '<strong>Data member ditemukan</strong>' +
      '<span>' + matches.length + ' hasil' + (matches.length > visible.length ? ' · menampilkan 20 pertama' : '') + '</span>' +
    '</div>' +
    visible.map(function(member) {
      const active = String(member.status || '').toLowerCase() === 'aktif';
      const cardUrl = cardUrlWithReturn(member.cardUrl, 'admin');
      return '<article class="validation-member-item">' +
        '<div class="validation-member-head">' +
          '<strong>' + escapeHtml(formatMemberName(member.name || 'Tanpa nama')) + '</strong>' +
          '<span class="badge-status ' + (active ? 'badge-active' : 'badge-inactive') + '">' + (active ? 'Aktif' : 'Nonaktif') + '</span>' +
        '</div>' +
        '<div class="validation-member-phone"><small>Nomor WhatsApp</small><strong>' + escapeHtml(member.phone || '-') + '</strong></div>' +
        '<div class="validation-member-id"><small>Member ID</small><strong>' + escapeHtml(member.memberId || '-') + '</strong></div>' +
        '<div class="validation-member-date"><small>Bergabung</small><span>' + escapeHtml(member.createdAt || '-') + '</span></div>' +
        (cardUrl ? '<a class="validation-card-link" href="' + escapeHtml(cardUrl) + '">Buka kartu digital</a>' : '') +
      '</article>';
    }).join('') +
    '</div>';
}

async function verifyToken(value) {
  const token = extractMemberToken(value);
  if (!token) {
    document.getElementById('scanMsg').textContent = 'Token member tidak ditemukan pada QR atau tautan.';
    return;
  }
  document.getElementById('scanMsg').textContent = 'Memeriksa database EXP...';
  try {
    const member = await api('verifyMember', { token: token, pin: adminPin });
    const target = document.getElementById('memberResult');
    if (!member.found) {
      target.innerHTML = '<div class="result error"><strong>Member tidak ditemukan</strong><br>' + escapeHtml(brandUiText(member.message)) + '</div>';
    } else {
      const active = String(member.status || '').toLowerCase() === 'aktif';
      const cardUrl = new URL('/', window.location.origin);
      cardUrl.searchParams.set('page', 'card');
      cardUrl.searchParams.set('id', token);
      cardUrl.searchParams.set('from', 'admin');

      target.innerHTML =
        '<div class="result scan-member-result">' +
          '<div class="scan-member-card">' +
            '<div class="scan-member-card-top"><strong>EXP</strong><span>SERVICE JAYAPURA</span></div>' +
            '<small>Nama member</small>' +
            '<strong class="scan-member-card-name">' + escapeHtml(formatMemberName(member.name)) + '</strong>' +
            '<small>ID member</small>' +
            '<strong class="scan-member-card-id">' + escapeHtml(member.memberId || '-') + '</strong>' +
            '<span class="badge-status ' + (active ? 'badge-active' : 'badge-inactive') + '">' + (active ? 'Aktif' : 'Nonaktif') + '</span>' +
          '</div>' +
          '<div class="scan-member-detail-heading">Detail data member</div>' +
          field('Nama lengkap', formatMemberName(member.name)) +
          field('Nomor WhatsApp', member.phone) +
          field('Member ID', member.memberId) +
          field('Status keanggotaan', member.status) +
          field('Tanggal bergabung', member.createdAt) +
          '<a class="button button-primary scan-member-card-link" href="' + escapeHtml(cardUrl.toString()) + '">Buka tampilan kartu digital</a>' +
          '<p class="member-code scan-member-note">Hasil scan ditampilkan di dashboard admin. Halaman customer tidak dibuka otomatis.</p>' +
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


document.addEventListener('click', function(event) {
  const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if (!link || event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (PAGE !== 'admin' || !adminPin) return;

  const dashboard = document.getElementById('adminDashboard');
  if (!dashboard || dashboard.hidden) return;

  let targetUrl;
  try {
    targetUrl = new URL(link.href, window.location.href);
  } catch (error) {
    return;
  }

  if (targetUrl.origin !== window.location.origin ||
      targetUrl.searchParams.get('page') !== 'card' ||
      targetUrl.searchParams.get('from') !== 'admin') return;

  const token = targetUrl.searchParams.get('id') || targetUrl.searchParams.get('token');
  if (!token) return;

  event.preventDefault();
  openAdminCardInApp(token);
});

window.addEventListener('popstate', function(event) {
  // This handler only manages the SPA card preview opened from the admin page.
  if (PAGE !== 'admin') return;

  const state = event.state && typeof event.state === 'object' ? event.state : {};

  if (state.expView === 'admin-card' && adminPin) {
    activeCardToken = String(state.token || '');
    resetMemberCardView();
    setVisiblePage('card');
    window.scrollTo({ top: 0, behavior: 'auto' });
    loadMemberCard(activeCardToken);
    return;
  }

  if (state.expView === 'admin-dashboard' && adminPin) {
    setVisiblePage('admin');
    const login = document.getElementById('adminLogin');
    const dashboard = document.getElementById('adminDashboard');
    if (login) login.hidden = true;
    if (dashboard) dashboard.hidden = false;
    window.scrollTo({ top: Number(state.returnScrollY || adminDashboardScrollY || 0), behavior: 'auto' });
    return;
  }

  // If the admin PIN entry becomes active again, keep it visible without
  // inventing another history entry.
  if (state.expView === 'admin-pin') {
    setVisiblePage('admin');
    showAdminPinView(true);
  }
});

window.addEventListener('beforeunload', function() {
  if (html5Qr && html5Qr.isScanning) html5Qr.stop().catch(function() {});
});

window.navigateBack = navigateBack;

showPage();
initialiseRegistration();
initialiseCustomerLogin();
initialiseCardQrPopup();
initialisePWA();

