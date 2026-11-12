const ALLOWED_ACTIONS = new Set([
  'registerMember',
  'getMemberCard',
  'checkAdminPin',
  'getAdminDashboard',
  'setMemberStatus',
  'verifyMember'
]);

export async function onRequestPost({ request, env }) {
  if (!env.RBM_GAS_URL) {
    return Response.json(
      { ok: false, message: 'Konfigurasi RBM_GAS_URL belum dipasang pada Cloudflare Pages.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return Response.json(
      { ok: false, message: 'Format permintaan tidak valid.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const action = String(body && body.action || '');
  if (!ALLOWED_ACTIONS.has(action)) {
    return Response.json(
      { ok: false, message: 'Aksi tidak dikenali.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const upstream = await fetch(env.RBM_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });

    const raw = await upstream.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch (error) {
      return Response.json(
        {
          ok: false,
          message: 'Apps Script tidak mengirim JSON. Pastikan Web App sudah dideploy dengan akses Anyone dan URL yang dipasang berakhiran /exec.'
        },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (!upstream.ok) {
      return Response.json(
        { ok: false, message: result && result.message ? result.message : 'Layanan database RBM sedang tidak tersedia.' },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Tautan kartu selalu memakai satu domain Cloudflare, bukan URL Apps Script.
    const publicOrigin = new URL(request.url).origin;
    if (result && result.ok === true && result.data) {
      if (action === 'registerMember' && result.data.cardUrl) {
        result.data.cardUrl = toPublicCardUrl(result.data.cardUrl, publicOrigin);
      }

      if (action === 'getAdminDashboard' && Array.isArray(result.data.members)) {
        result.data.members = result.data.members.map(function(member) {
          if (member && member.cardUrl) {
            member.cardUrl = toPublicCardUrl(member.cardUrl, publicOrigin);
          }
          return member;
        });
      }
    }

    return Response.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    return Response.json(
      { ok: false, message: 'Cloudflare tidak dapat menghubungi Apps Script. Periksa URL deployment dan koneksi layanan.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function onRequestGet() {
  return Response.json(
    { ok: true, service: 'RBM Digital Member API', message: 'API aktif. Gunakan metode POST.' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

function toPublicCardUrl(cardUrl, publicOrigin) {
  try {
    const source = new URL(cardUrl);
    const token = source.searchParams.get('id');
    if (!token) return cardUrl;
    return publicOrigin + '/?page=card&id=' + encodeURIComponent(token);
  } catch (error) {
    return cardUrl;
  }
}
