// FindImageAI – Cloudflare Worker
// Phục vụ trang web (thư mục public/) và API lưu ảnh / chỉ mục khuôn mặt trên R2.
//
// Biến môi trường:
//   ADMIN_PASSWORD  (Secret)  – mật khẩu quản trị album
//   PUBLIC_URL      (tuỳ chọn) – tên miền công khai của bucket R2, VD https://anh.tenmien.com
//   GOOGLE_API_KEY  (Secret, tuỳ chọn) – để nhập ảnh từ thư mục Google Drive công khai
// Binding:
//   BUCKET – R2 bucket chứa ảnh và index.json
//   ASSETS – thư mục public/

const INDEX_KEY = 'index.json';
const FILE_RE = /^((p|t|f)\/[A-Za-z0-9_-]{6,80}\.jpg|l\/[A-Za-z0-9_-]{6,64}\.png)$/;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,100}$/;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

function isAdmin(req, env) {
  const pw = env.ADMIN_PASSWORD;
  if (!pw) return false;
  const got = req.headers.get('authorization') || '';
  const want = 'Bearer ' + pw;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (!env.BUCKET) return json({ error: 'Chưa gắn R2 bucket (binding BUCKET).' }, 500);

    const method = req.method;

    // Cấu hình công khai cho trang web
    if (path === '/api/config' && method === 'GET') {
      return json({
        publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
        hasPassword: !!env.ADMIN_PASSWORD,
        hasDrive: !!env.GOOGLE_API_KEY,
      });
    }

    // Kiểm tra mật khẩu quản trị
    if (path === '/api/auth' && method === 'POST') {
      return isAdmin(req, env) ? json({ ok: true }) : json({ ok: false }, 401);
    }

    // Chỉ mục album: thông tin + danh sách ảnh + vector khuôn mặt
    if (path === '/api/index') {
      if (method === 'GET') {
        const obj = await env.BUCKET.get(INDEX_KEY);
        if (!obj) return json({ v: 1, info: {}, photos: [] });
        return new Response(obj.body, {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (method === 'PUT') {
        if (!isAdmin(req, env)) return json({ error: 'Sai mật khẩu' }, 401);
        await env.BUCKET.put(INDEX_KEY, req.body, {
          httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
        });
        return json({ ok: true });
      }
    }

    // Xoá toàn bộ ảnh (giữ logo). Mỗi lần gọi xoá 1 đợt; trang web gọi lặp đến khi done = true.
    if (path === '/api/purge' && method === 'POST') {
      if (!isAdmin(req, env)) return json({ error: 'Sai mật khẩu' }, 401);
      for (const prefix of ['p/', 't/', 'f/']) {
        const l = await env.BUCKET.list({ prefix, limit: 500 });
        const keys = l.objects.map(o => o.key);
        if (keys.length) {
          await env.BUCKET.delete(keys);
          return json({ deleted: keys.length, done: false });
        }
      }
      return json({ deleted: 0, done: true });
    }

    // File ảnh: p/<id>.jpg (ảnh lớn), t/<id>.jpg (ảnh thu nhỏ)
    if (path.startsWith('/api/file/')) {
      const key = decodeURIComponent(path.slice('/api/file/'.length));
      if (!FILE_RE.test(key)) return json({ error: 'Tên file không hợp lệ' }, 400);

      if (method === 'GET' || method === 'HEAD') {
        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        const h = new Headers();
        obj.writeHttpMetadata(h);
        h.set('etag', obj.httpEtag);
        h.set('cache-control', 'public, max-age=31536000, immutable');
        return new Response(method === 'HEAD' ? null : obj.body, { headers: h });
      }
      if (method === 'PUT') {
        if (!isAdmin(req, env)) return json({ error: 'Sai mật khẩu' }, 401);
        await env.BUCKET.put(key, req.body, {
          httpMetadata: { contentType: key.endsWith('.png') ? 'image/png' : 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
        });
        return json({ ok: true, key });
      }
      if (method === 'DELETE') {
        if (!isAdmin(req, env)) return json({ error: 'Sai mật khẩu' }, 401);
        await env.BUCKET.delete(key);
        return json({ ok: true });
      }
    }

    // Nhập ảnh từ Google Drive (chỉ quản trị)
    if (path.startsWith('/api/drive/') && method === 'GET') {
      if (!isAdmin(req, env)) return json({ error: 'Sai mật khẩu' }, 401);
      const key = env.GOOGLE_API_KEY;
      const apiBase = env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';

      if (path === '/api/drive/list') {
        if (!key) return json({ error: 'Chưa đặt GOOGLE_API_KEY trên Cloudflare.' }, 400);
        const folder = url.searchParams.get('folder') || '';
        if (!DRIVE_ID_RE.test(folder)) return json({ error: 'Link thư mục Drive không hợp lệ' }, 400);
        const qs = new URLSearchParams({
          q: `'${folder}' in parents and trashed = false and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')`,
          fields: 'nextPageToken,files(id,name,size,modifiedTime,mimeType)',
          pageSize: '1000',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          key,
        });
        const token = url.searchParams.get('pageToken');
        if (token) qs.set('pageToken', token);
        const r = await fetch(`${apiBase}/files?${qs}`);
        if (!r.ok) {
          let msg = '';
          try { msg = (await r.json()).error?.message || ''; } catch (e) {}
          return json({ error: `Google Drive báo lỗi ${r.status}. ${msg}`.trim() }, 502);
        }
        const d = await r.json();
        const all = d.files || [];
        return json({
          files: all.filter(f => f.mimeType !== 'application/vnd.google-apps.folder'),
          folders: all.filter(f => f.mimeType === 'application/vnd.google-apps.folder').map(f => ({ id: f.id, name: f.name })),
          next: d.nextPageToken || null,
        });
      }

      if (path === '/api/drive/img') {
        const id = url.searchParams.get('id') || '';
        if (!DRIVE_ID_RE.test(id)) return json({ error: 'Mã file không hợp lệ' }, 400);
        const isImg = r => r.ok && (r.headers.get('content-type') || '').startsWith('image/');
        // Ưu tiên bản Google đã thu nhỏ (nhẹ hơn ảnh gốc nhiều lần); không được thì lấy ảnh gốc
        const thumbBase = env.DRIVE_THUMB_BASE || 'https://drive.google.com/thumbnail';
        const wantOrig = url.searchParams.get('orig') === '1' && key;
        let r = wantOrig ? null : await fetch(`${thumbBase}?id=${id}&sz=w3200`).catch(() => null);
        let src = 'thumb';
        if (!r || !isImg(r)) {
          if (!key) return json({ error: 'Không lấy được ảnh từ Drive' }, 502);
          r = await fetch(`${apiBase}/files/${id}?alt=media&supportsAllDrives=true&key=${key}`);
          src = 'original';
          if (!isImg(r)) return json({ error: 'Không lấy được ảnh từ Drive (' + r.status + ')' }, 502);
        }
        return new Response(r.body, {
          headers: { 'content-type': r.headers.get('content-type'), 'cache-control': 'no-store', 'x-drive-source': src },
        });
      }
    }

    return json({ error: 'Không tìm thấy' }, 404);
  },
};
