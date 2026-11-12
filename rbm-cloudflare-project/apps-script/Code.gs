/**
 * RBM DIGITAL MEMBER SYSTEM
 * Google Apps Script backend with migration-safe database replacement.
 *
 * MIGRATION:
 * - The existing spreadsheet remains untouched.
 * - migrateRBMToNewDatabase() makes a complete copy of the existing spreadsheet.
 * - The copy is verified before the application switches to it.
 * - All tabs, used cell values, and formulas are retained.
 *
 * SECURITY:
 * - Store the admin PIN in Script Properties as RBM_ADMIN_PIN.
 * - Do not store the PIN in this source file.
 *
 * FIRST-TIME SETUP:
 * 1. Keep this project connected to the existing RBM spreadsheet, or ensure
 *    RBM_SPREADSHEET_ID already exists in Script Properties.
 * 2. In Project Settings > Script Properties, set RBM_ADMIN_PIN to a NEW PIN.
 * 3. Run setupRBM() only if the old database ID has not yet been registered.
 * 4. Run inspectRBMDatabase() to confirm the source database.
 * 5. Run migrateRBMToNewDatabase() once.
 * 6. Run inspectRBMDatabase() again to confirm the new database is active.
 */

const SHEET_NAME = 'Members';
const HEADERS = ['Token', 'Member ID', 'Name', 'Phone', 'Email', 'Status', 'Created At'];

const RBM_ADMIN_PIN_PROPERTY = 'RBM_ADMIN_PIN';
const RBM_SPREADSHEET_ID_PROPERTY = 'RBM_SPREADSHEET_ID';
const RBM_PREVIOUS_SPREADSHEET_ID_PROPERTY = 'RBM_PREVIOUS_SPREADSHEET_ID';
const RBM_MIGRATION_SOURCE_ID_PROPERTY = 'RBM_MIGRATION_SOURCE_ID';
const RBM_MIGRATION_TARGET_ID_PROPERTY = 'RBM_MIGRATION_TARGET_ID';
const RBM_MIGRATION_COMPLETED_AT_PROPERTY = 'RBM_MIGRATION_COMPLETED_AT';

const RBM_ADMIN_SESSION_PREFIX = 'RBM_ADMIN_SESSION_';
const RBM_ADMIN_SESSION_TTL_SECONDS = 900;

function doGet(e) {
  if (e && e.parameter && e.parameter.rbmApi === '1') {
    return rbmJsonpApi_(e);
  }

  const page = (e && e.parameter && e.parameter.page) || 'register';
  const allowed = ['register', 'card', 'admin'];
  const view = allowed.includes(page) ? page : 'register';

  const template = HtmlService.createTemplateFromFile('Index');
  template.page = view;
  template.token = (e && e.parameter && e.parameter.id) ? e.parameter.id : '';
  template.appUrl = ScriptApp.getService().getUrl();

  return template.evaluate()
    .setTitle('RBM Digital Member')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Registers the currently bound spreadsheet only if no database ID exists.
 * It never silently changes an existing database pointer.
 */
function setupRBM() {
  const props = PropertiesService.getScriptProperties();
  let spreadsheetId = props.getProperty(RBM_SPREADSHEET_ID_PROPERTY);

  if (!spreadsheetId) {
    const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!activeSpreadsheet) {
      throw new Error(
        'Database lama belum terdaftar. Buka Apps Script melalui Extensions > Apps Script dari Google Sheets lama, lalu jalankan setupRBM().'
      );
    }
    spreadsheetId = activeSpreadsheet.getId();
    props.setProperty(RBM_SPREADSHEET_ID_PROPERTY, spreadsheetId);
  }

  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#171717')
      .setFontColor('#D9B66F');
    sheet.autoResizeColumns(1, HEADERS.length);
  } else {
    assertMemberHeaders_(sheet);
  }

  return 'Setup selesai. Database aktif: ' + ss.getName();
}

/**
 * Returns database metadata without exposing member personal information.
 */
function inspectRBMDatabase() {
  const spreadsheetId = getCurrentSpreadsheetId_();
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheets = ss.getSheets().map(function(sheet) {
    return {
      name: sheet.getName(),
      rows: sheet.getLastRow(),
      columns: sheet.getLastColumn(),
      dataRows: Math.max(0, sheet.getLastRow() - 1)
    };
  });

  const memberSheet = ss.getSheetByName(SHEET_NAME);
  if (!memberSheet) {
    throw new Error('Sheet Members tidak ditemukan pada database aktif.');
  }

  return {
    spreadsheetName: ss.getName(),
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    memberCount: Math.max(0, memberSheet.getLastRow() - 1),
    sheets: sheets,
    migrationCompletedAt: PropertiesService.getScriptProperties()
      .getProperty(RBM_MIGRATION_COMPLETED_AT_PROPERTY) || null
  };
}

/**
 * Makes a full copy of the existing spreadsheet.
 * The original spreadsheet is not edited or deleted.
 * The app switches to the copy only after values and formulas match.
 */
function migrateRBMToNewDatabase() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const props = PropertiesService.getScriptProperties();
    const sourceId = getCurrentSpreadsheetId_();

    if (props.getProperty(RBM_MIGRATION_COMPLETED_AT_PROPERTY)) {
      const current = SpreadsheetApp.openById(sourceId);
      return {
        ok: true,
        alreadyMigrated: true,
        message: 'Migrasi sebelumnya sudah selesai. Tidak ada salinan baru yang dibuat.',
        spreadsheetName: current.getName(),
        spreadsheetId: current.getId(),
        spreadsheetUrl: current.getUrl()
      };
    }

    const sourceFile = DriveApp.getFileById(sourceId);
    if (sourceFile.getMimeType() !== MimeType.GOOGLE_SHEETS) {
      throw new Error('Sumber database bukan file Google Sheets.');
    }

    const sourceSpreadsheet = SpreadsheetApp.openById(sourceId);
    const sourceMembers = sourceSpreadsheet.getSheetByName(SHEET_NAME);
    if (!sourceMembers) {
      throw new Error('Sheet Members tidak ditemukan pada database lama.');
    }
    assertMemberHeaders_(sourceMembers);

    const sourceSnapshot = spreadsheetSnapshot_(sourceSpreadsheet);
    const timestamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'yyyyMMdd-HHmmss'
    );
    const copyName = 'RBM Digital Member Database - ' + timestamp;

    // Copy every tab in the spreadsheet, not only Members.
    const copiedFile = sourceFile.makeCopy(copyName);

    try {
      const targetSpreadsheet = SpreadsheetApp.openById(copiedFile.getId());
      const targetMembers = targetSpreadsheet.getSheetByName(SHEET_NAME);

      if (!targetMembers) {
        throw new Error('Salinan database tidak memiliki sheet Members.');
      }
      assertMemberHeaders_(targetMembers);

      const targetSnapshot = spreadsheetSnapshot_(targetSpreadsheet);
      if (JSON.stringify(sourceSnapshot) !== JSON.stringify(targetSnapshot)) {
        throw new Error(
          'Pemeriksaan salinan tidak cocok. Database lama tetap aktif dan tidak diubah. ID salinan yang perlu diperiksa: ' +
          copiedFile.getId()
        );
      }

      // Switch the app only after the copied spreadsheet passes verification.
      props.setProperty(RBM_PREVIOUS_SPREADSHEET_ID_PROPERTY, sourceId);
      props.setProperty(RBM_MIGRATION_SOURCE_ID_PROPERTY, sourceId);
      props.setProperty(RBM_MIGRATION_TARGET_ID_PROPERTY, targetSpreadsheet.getId());
      props.setProperty(RBM_SPREADSHEET_ID_PROPERTY, targetSpreadsheet.getId());
      props.setProperty(
        RBM_MIGRATION_COMPLETED_AT_PROPERTY,
        new Date().toISOString()
      );

      return {
        ok: true,
        alreadyMigrated: false,
        message: 'Database baru berhasil dibuat, diverifikasi, dan diaktifkan.',
        sourceSpreadsheetId: sourceId,
        targetSpreadsheetId: targetSpreadsheet.getId(),
        targetSpreadsheetName: targetSpreadsheet.getName(),
        targetSpreadsheetUrl: targetSpreadsheet.getUrl(),
        memberCount: Math.max(0, targetMembers.getLastRow() - 1),
        preservedSheets: targetSnapshot.map(function(item) { return item.name; })
      };
    } catch (error) {
      // Only the copy created in this execution is moved to Trash after a failed check.
      // The original database is never touched.
      try {
        copiedFile.setTrashed(true);
      } catch (trashError) {
        // Preserve the original migration error.
      }
      throw error;
    }
  } finally {
    lock.releaseLock();
  }
}

function spreadsheetSnapshot_(ss) {
  return ss.getSheets().map(function(sheet) {
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    let values = [];
    let formulas = [];

    if (lastRow > 0 && lastColumn > 0) {
      const range = sheet.getRange(1, 1, lastRow, lastColumn);
      values = range.getValues();
      formulas = range.getFormulas();
    }

    return {
      name: sheet.getName(),
      rows: lastRow,
      columns: lastColumn,
      valuesHash: digest_(values),
      formulasHash: digest_(formulas)
    };
  });
}

function digest_(value) {
  const serialized = JSON.stringify(value);
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    serialized,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64Encode(bytes);
}

function assertMemberHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    throw new Error('Sheet Members belum memiliki header.');
  }

  const actual = sheet.getRange(1, 1, 1, HEADERS.length)
    .getDisplayValues()[0]
    .map(function(value) { return String(value).trim(); });

  const matches = HEADERS.every(function(header, index) {
    return actual[index] === header;
  });

  if (!matches) {
    throw new Error(
      'Header sheet Members tidak sesuai. Migrasi dihentikan agar struktur data lama tidak berubah. Header yang diharapkan: ' +
      HEADERS.join(' | ')
    );
  }
}

function getCurrentSpreadsheetId_() {
  const props = PropertiesService.getScriptProperties();
  let spreadsheetId = props.getProperty(RBM_SPREADSHEET_ID_PROPERTY);

  if (!spreadsheetId) {
    const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!activeSpreadsheet) {
      throw new Error(
        'RBM_SPREADSHEET_ID belum diatur. Daftarkan database lama melalui setupRBM() terlebih dahulu.'
      );
    }
    spreadsheetId = activeSpreadsheet.getId();
    props.setProperty(RBM_SPREADSHEET_ID_PROPERTY, spreadsheetId);
  }

  return spreadsheetId;
}

function registerMember(form) {
  form = form || {};
  const name = clean_(form.name, 100);
  const phone = clean_(form.phone, 30);
  const email = clean_(form.email, 120).toLowerCase();

  if (!name || !phone) {
    throw new Error('Nama dan nomor WhatsApp wajib diisi.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Format email tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getSheet_();
    const rows = sheet.getDataRange().getValues();
    const normalizedPhone = normalizePhone_(phone);

    for (let i = 1; i < rows.length; i++) {
      if (
        normalizePhone_(String(rows[i][3] || '')) === normalizedPhone &&
        String(rows[i][5] || '').toLowerCase() === 'aktif'
      ) {
        throw new Error('Nomor WhatsApp ini sudah terdaftar sebagai member RBM.');
      }
    }

    const token = Utilities.getUuid().replace(/-/g, '');
    const memberId = 'RBM-' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMdd') +
      '-' + token.substring(0, 6).toUpperCase();
    const createdAt = new Date();

    sheet.appendRow([token, memberId, name, phone, email, 'Aktif', createdAt]);

    const appUrl = ScriptApp.getService().getUrl();
    return {
      ok: true,
      memberId: memberId,
      name: name,
      cardUrl: appUrl + '?page=card&id=' + encodeURIComponent(token)
    };
  } finally {
    lock.releaseLock();
  }
}

function getMemberCard(token) {
  token = clean_(token, 100);
  if (!token) throw new Error('Kode member tidak ditemukan.');

  const row = findByToken_(token);
  if (!row) throw new Error('Member tidak ditemukan.');

  return {
    memberId: String(row[1]),
    name: String(row[2]),
    status: String(row[5]),
    createdAt: formatDate_(row[6])
  };
}

/** Used by the Apps Script-hosted admin page. */
function checkAdminPin(pin) {
  assertAdmin_(pin);
  return { ok: true };
}

function verifyMember(token, pin) {
  assertAdmin_(pin);
  return rbmFindMemberByToken_(token);
}

function rbmFindMemberByToken_(token) {
  token = clean_(token, 100);
  if (!token) throw new Error('QR Code tidak berisi kode member.');

  const row = findByToken_(token);
  if (!row) {
    return {
      found: false,
      message: 'Member tidak ditemukan di database RBM.'
    };
  }

  return {
    found: true,
    memberId: String(row[1]),
    name: String(row[2]),
    phone: String(row[3]),
    email: String(row[4] || '-'),
    status: String(row[5]),
    createdAt: formatDate_(row[6])
  };
}

function setMemberStatus(memberId, status, pin) {
  assertAdmin_(pin);
  if (!['Aktif', 'Nonaktif'].includes(status)) {
    throw new Error('Status tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getSheet_();
    const rows = sheet.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1]) === String(memberId)) {
        sheet.getRange(i + 1, 6).setValue(status);
        return { ok: true, status: status };
      }
    }
    throw new Error('Member tidak ditemukan.');
  } finally {
    lock.releaseLock();
  }
}

function findByToken_(token) {
  const sheet = getSheet_();
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === token) return rows[i];
  }
  return null;
}

function getSheet_() {
  const spreadsheetId = getCurrentSpreadsheetId_();
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error('Sheet Members tidak ditemukan. Jalankan setupRBM() untuk memeriksa database.');
  }
  return sheet;
}

/**
 * The admin PIN is read from Script Properties.
 * Add RBM_ADMIN_PIN in Apps Script > Project Settings > Script Properties.
 */
function assertAdmin_(pin) {
  const configuredPin = PropertiesService.getScriptProperties()
    .getProperty(RBM_ADMIN_PIN_PROPERTY);

  if (!configuredPin) {
    throw new Error(
      'PIN admin belum diatur. Tambahkan RBM_ADMIN_PIN pada Project Settings > Script Properties.'
    );
  }

  if (String(pin == null ? '' : pin) !== configuredPin) {
    throw new Error('PIN admin salah.');
  }
}

/**
 * JSONP API for the optional GitHub Pages scanner.
 * Admin sessions expire after 15 minutes.
 */
function rbmJsonpApi_(e) {
  const params = e.parameter || {};
  const callback = String(params.callback || '');

  if (!/^rbmJsonp_[A-Za-z0-9_]+$/.test(callback)) {
    return ContentService.createTextOutput('/* Invalid callback */')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  let result;

  try {
    const action = String(params.action || '');

    if (action === 'login') {
      assertAdmin_(String(params.pin || ''));
      const session = Utilities.getUuid().replace(/-/g, '');
      CacheService.getScriptCache().put(
        RBM_ADMIN_SESSION_PREFIX + session,
        '1',
        RBM_ADMIN_SESSION_TTL_SECONDS
      );
      result = {
        ok: true,
        session: session,
        expiresIn: RBM_ADMIN_SESSION_TTL_SECONDS
      };
    } else if (action === 'verify') {
      const session = String(params.session || '');
      const valid = session
        ? CacheService.getScriptCache().get(RBM_ADMIN_SESSION_PREFIX + session)
        : null;

      if (valid !== '1') {
        throw new Error('Sesi admin berakhir. Silakan masuk kembali dengan PIN.');
      }

      result = rbmFindMemberByToken_(String(params.token || '').trim());
      result.ok = true;
    } else if (action === 'logout') {
      CacheService.getScriptCache().remove(
        RBM_ADMIN_SESSION_PREFIX + String(params.session || '')
      );
      result = { ok: true };
    } else {
      throw new Error('Aksi tidak dikenali.');
    }
  } catch (error) {
    result = {
      ok: false,
      message: String(error && error.message ? error.message : error)
    };
  }

  const json = JSON.stringify(result).replace(/</g, '\\u003c');
  return ContentService.createTextOutput(callback + '(' + json + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function clean_(value, maxLength) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[<>]/g, '')
    .substring(0, maxLength);
}

function normalizePhone_(phone) {
  return String(phone)
    .replace(/[^\d]/g, '')
    .replace(/^62/, '0');
}

function formatDate_(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value);

  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'dd MMM yyyy'
  );
}

function inspectRBMDatabase() {
  const OLD_DATABASE_ID = '1POy6LbpOpS4MYm70GejhSuoJJsfnvPxY3GoTe54bQjg';

  const ss = SpreadsheetApp.openById(OLD_DATABASE_ID);

  const report = {
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    sheets: ss.getSheets().map(sheet => ({
      sheetName: sheet.getName(),
      totalRows: sheet.getLastRow(),
      totalColumns: sheet.getLastColumn(),
      estimatedMemberRows: Math.max(0, sheet.getLastRow() - 1)
    }))
  };

  Logger.log(JSON.stringify(report, null, 2));

  return report;
}

function inspectRBMHeaders() {
  const OLD_DATABASE_ID = '1POy6LbpOpS4MYm70GejhSuoJJsfnvPxY3GoTe54bQjg';

  const ss = SpreadsheetApp.openById(OLD_DATABASE_ID);

  ['Members', 'Form Responses 1', 'RBM Setup'].forEach(name => {
    const sheet = ss.getSheetByName(name);

    if (sheet && sheet.getLastColumn() > 0) {
      const headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getDisplayValues()[0];

      Logger.log(name + ': ' + JSON.stringify(headers));
    }
  });
}

/**
 * RBM DATABASE MIGRATION
 * Menyalin database lama dan memverifikasi hasilnya.
 * Database aktif hanya dialihkan setelah verifikasi berhasil.
 */

function migrateRBMToNewDatabase() {

  const SOURCE_ID = '1POy6LbpOpS4MYm70GejhSuoJJsfnvPxY3GoTe54bQjg';

  const props = PropertiesService.getScriptProperties();
  const source = SpreadsheetApp.openById(SOURCE_ID);

  // Jika migrasi pernah berhasil, gunakan salinan yang sama.
  const previousCopyId = props.getProperty('RBM_NEW_SPREADSHEET_ID');

  if (previousCopyId) {
    const previousCopy = SpreadsheetApp.openById(previousCopyId);
    const previousCheck = rbmMigrationCompare_(source, previousCopy);

    if (!previousCheck.ok) {
      throw new Error(
        'Salinan database sebelumnya tidak lolos pemeriksaan. Database aktif tidak diubah.'
      );
    }

    props.setProperty('RBM_SPREADSHEET_ID', previousCopyId);

    Logger.log('Migrasi sebelumnya sudah berhasil.');
    Logger.log('Database baru: ' + previousCopy.getUrl());
    return;
  }

  // Pastikan database aktif tidak menunjuk ke file lain.
  const activeId = props.getProperty('RBM_SPREADSHEET_ID');

  if (activeId && activeId !== SOURCE_ID) {
    throw new Error(
      'ID database aktif berbeda dari database lama. Migrasi dihentikan untuk keamanan.'
    );
  }

  // Buat salinan spreadsheet lengkap.
  const timestamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyyMMdd_HHmmss'
  );

  const newFile = DriveApp.getFileById(SOURCE_ID).makeCopy(
    source.getName() + ' - RBM Database Baru ' + timestamp
  );

  const newId = newFile.getId();

  try {

    const target = SpreadsheetApp.openById(newId);

    // Bandingkan database lama dan salinan.
    const result = rbmMigrationCompare_(source, target);

    Logger.log('HASIL PEMERIKSAAN: ' + JSON.stringify(result));

    if (!result.ok) {
      throw new Error(
        'Verifikasi gagal. Database aktif tidak dialihkan. Periksa log.'
      );
    }

    // Alihkan database hanya setelah pemeriksaan berhasil.
    props.setProperties({
      RBM_OLD_SPREADSHEET_ID: SOURCE_ID,
      RBM_NEW_SPREADSHEET_ID: newId,
      RBM_SPREADSHEET_ID: newId
    }, false);

    Logger.log('MIGRASI BERHASIL.');
    Logger.log('Database lama: ' + source.getUrl());
    Logger.log('Database baru: ' + target.getUrl());
    Logger.log('Seluruh pemeriksaan berhasil.');

  } catch (error) {

    props.setProperty('RBM_FAILED_COPY_ID', newId);
    throw error;

  }
}


/**
 * Membandingkan tab, dimensi, nilai sel, dan formula.
 */
function rbmMigrationCompare_(source, target) {

  const errors = [];

  const sourceSheets = source.getSheets();
  const targetSheets = target.getSheets();

  if (sourceSheets.length !== targetSheets.length) {
    errors.push('Jumlah tab berbeda.');
  }

  sourceSheets.forEach((src, index) => {

    const dst = target.getSheetByName(src.getName());

    if (!dst) {
      errors.push('Tab tidak ditemukan: ' + src.getName());
      return;
    }

    if (
      targetSheets[index] &&
      targetSheets[index].getName() !== src.getName()
    ) {
      errors.push('Urutan tab berbeda: ' + src.getName());
    }

    if (
      src.getMaxRows() !== dst.getMaxRows() ||
      src.getMaxColumns() !== dst.getMaxColumns()
    ) {
      errors.push('Ukuran tab berbeda: ' + src.getName());
    }

    if (src.isSheetHidden() !== dst.isSheetHidden()) {
      errors.push('Status tab tersembunyi berbeda: ' + src.getName());
    }

    const rows = src.getLastRow();
    const cols = src.getLastColumn();

    if (
      rows !== dst.getLastRow() ||
      cols !== dst.getLastColumn()
    ) {
      errors.push('Jumlah baris atau kolom berbeda: ' + src.getName());
      return;
    }

    if (rows === 0 || cols === 0) return;

    const sourceRange = src.getRange(1, 1, rows, cols);
    const targetRange = dst.getRange(1, 1, rows, cols);

    const sourceValues = sourceRange.getValues();
    const targetValues = targetRange.getValues();

    const sourceFormulas = sourceRange.getFormulas();
    const targetFormulas = targetRange.getFormulas();

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {

        if (sourceFormulas[r][c] !== targetFormulas[r][c]) {
          errors.push(
            'Formula berbeda pada ' + src.getName() +
            ', baris ' + (r + 1) +
            ', kolom ' + (c + 1)
          );
          continue;
        }

        // Bandingkan nilai literal jika sel bukan formula.
        if (
          !sourceFormulas[r][c] &&
          rbmMigrationCellKey_(sourceValues[r][c]) !==
          rbmMigrationCellKey_(targetValues[r][c])
        ) {
          errors.push(
            'Nilai berbeda pada ' + src.getName() +
            ', baris ' + (r + 1) +
            ', kolom ' + (c + 1)
          );
        }

      }
    }

  });

  return {
    ok: errors.length === 0,
    sourceSpreadsheet: source.getName(),
    targetSpreadsheet: target.getName(),
    sourceTabs: sourceSheets.length,
    targetTabs: targetSheets.length,
    errors: errors
  };
}


/**
 * Menyamakan format perbandingan nilai sel.
 */
function rbmMigrationCellKey_(value) {

  if (value instanceof Date) {
    return 'DATE:' + value.getTime();
  }

  if (value === null || value === undefined) {
    return 'EMPTY';
  }

  return typeof value + ':' + String(value);
}

/**
 * RBM ADMIN DASHBOARD DATA
 * Mengambil data member untuk dashboard admin.
 */

function getAdminDashboard(pin) {

  // Verifikasi PIN admin
  assertAdmin_(pin);

  // Hubungkan ke database baru
  const databaseId = PropertiesService
    .getScriptProperties()
    .getProperty('RBM_SPREADSHEET_ID');

  if (!databaseId) {
    throw new Error('Database RBM belum terhubung.');
  }

  const ss = SpreadsheetApp.openById(databaseId);
  const sheet = ss.getSheetByName('Members');

  if (!sheet) {
    throw new Error('Sheet Members tidak ditemukan.');
  }

  const data = sheet.getDataRange().getDisplayValues();

  if (data.length < 2) {
    return {
      ok: true,
      total: 0,
      active: 0,
      inactive: 0,
      members: []
    };
  }

  const headers = data[0];

  function getValue(row, name) {
    const index = headers.indexOf(name);
    return index >= 0 ? row[index] : '';
  }

  const appUrl = ScriptApp.getService().getUrl();

  const members = data.slice(1)
    .filter(row => row.some(value => String(value).trim() !== ''))
    .map(row => {

      const token = getValue(row, 'Token');
      const savedCardUrl = getValue(row, 'Card URL');

      return {
        memberId: getValue(row, 'Member ID'),
        name: getValue(row, 'Name'),
        phone: getValue(row, 'Phone'),
        email: getValue(row, 'Email'),
        status: getValue(row, 'Status'),
        createdAt: getValue(row, 'Created At'),
        cardUrl: savedCardUrl || (
          token
            ? appUrl + '?page=card&id=' +
              encodeURIComponent(token)
            : ''
        ),
        whatsappConsent: getValue(row, 'WhatsApp Consent'),
        cardStatus: getValue(row, 'Card Status')
      };
    });

  return {
    ok: true,
    total: members.length,
    active: members.filter(
      member => member.status.toLowerCase() === 'aktif'
    ).length,
    inactive: members.filter(
      member => member.status.toLowerCase() === 'nonaktif'
    ).length,
    members: members
  };
}

/**
 * Cloudflare Pages API bridge.
 * This endpoint only exposes the existing RBM operations through JSON.
 * It does not add database columns or change the existing member workflow.
 */
function doPost(e) {
  let request = {};

  try {
    const raw = e && e.postData && e.postData.contents
      ? e.postData.contents
      : '{}';
    request = JSON.parse(raw);
  } catch (error) {
    return rbmJsonResponse_({
      ok: false,
      message: 'Format permintaan tidak valid.'
    });
  }

  const action = String(request.action || '');
  let data;

  try {
    switch (action) {
      case 'registerMember':
        data = registerMember(request.form || {});
        break;
      case 'getMemberCard':
        data = getMemberCard(request.token);
        break;
      case 'checkAdminPin':
        data = checkAdminPin(request.pin);
        break;
      case 'getAdminDashboard':
        data = getAdminDashboard(request.pin);
        break;
      case 'setMemberStatus':
        data = setMemberStatus(request.memberId, request.status, request.pin);
        break;
      case 'verifyMember':
        data = verifyMember(request.token, request.pin);
        break;
      default:
        throw new Error('Aksi tidak dikenali.');
    }

    return rbmJsonResponse_({ ok: true, data: data });
  } catch (error) {
    return rbmJsonResponse_({
      ok: false,
      message: String(error && error.message ? error.message : error)
    });
  }
}

function rbmJsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
