// FindImageAI – Cloudflare Worker
// Phục vụ trang web (thư mục public/) và API lưu ảnh / chỉ mục khuôn mặt trên R2.
//
// Biến môi trường:
//   ADMIN_PASSWORD  (Secret)  – mật khẩu quản trị album
//   PUBLIC_URL      (tuỳ chọn) – tên miền công khai của bucket R2, VD https://anh.tenmien.com
// Binding:
//   BUCKET – R2 bucket chứa ảnh và index.json
//   ASSETS – thư mục public/

const INDEX_KEY = 'index.json';
const FILE_RE = /^(p|t)\/[A-Za-z0-9_-]{6,64}\.jpg$/;

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
          httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
        });
        return json({ ok: true, key });
      }
      if (method === 'DELETE') {
        if (!isAdmin(req, env)) return json({ error: 'Sai mật khẩu' }, 401);
        await env.BUCKET.delete(key);
        return json({ ok: true });
      }
    }

    return json({ error: 'Không tìm thấy' }, 404);
  },
};
