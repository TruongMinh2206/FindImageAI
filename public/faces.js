// Bộ AI khuôn mặt của FindImageAI
//  - Tìm vị trí mặt: SSD MobileNet v1 (face-api), quét toàn ảnh + từng ô phóng to để bắt mặt nhỏ
//  - Điểm mốc: Face Landmark 68 (face-api) -> lấy 5 điểm (2 mắt, mũi, 2 khoé miệng) để căn thẳng mặt
//  - Nhận diện: SFace (OpenCV Zoo, Apache 2.0) chạy bằng onnxruntime-web, cho vector 128 chiều đã chuẩn hoá
import * as ort from './ort/ort.wasm.min.mjs';

export const FACE_VERSION = 3;          // đổi số này mỗi khi vector khuôn mặt không còn tương thích
const BIG = 3200, TILE = 1280, TSTEP = 1000;
export const MIN_FACE = 30;             // cỡ mặt (px trên ảnh 3200) tối thiểu để lấy
const MAX_FACES = 80;
// Vị trí chuẩn của 5 điểm mốc trên ảnh mặt 112x112 (chuẩn ArcFace/SFace)
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

let faceapi = null, session = null, loading = null;

async function fetchParts(urls, onProgress) {
  const bufs = []; let got = 0;
  for (const u of urls) {
    const r = await fetch(u); if (!r.ok) throw new Error('Không tải được mô hình (' + r.status + ')');
    const reader = r.body.getReader(); const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress?.(got); }
    bufs.push(...chunks);
  }
  const out = new Uint8Array(got); let o = 0; for (const c of bufs) { out.set(c, o); o += c.length; }
  return out;
}

export function loadModels(onMsg) {
  if (!loading) {
    loading = (async () => {
      onMsg?.('Đang tải bộ AI (lần đầu khoảng 60 MB)…');
      faceapi = await import('./face-api.esm.js');
      try { await faceapi.tf.setBackend('webgl'); } catch (e) {}
      await faceapi.tf.ready();
      ort.env.wasm.numThreads = 1; ort.env.logLevel = 'error';
      ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
      const [, , model] = await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri('./model'),
        faceapi.nets.faceLandmark68Net.loadFromUri('./model'),
        fetchParts(['./model/sface.part0.bin', './model/sface.part1.bin'], n => onMsg?.(`Đang tải bộ AI… ${Math.round(n / 1048576)}/37 MB`)),
      ]);
      onMsg?.('Đang khởi động bộ AI…');
      session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    })().catch(e => { loading = null; throw e; });
  }
  return loading;
}

export function toCanvas(src, max) {
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function tileStarts(L) { if (L <= TILE) return [0]; const n = Math.ceil((L - TILE) / TSTEP) + 1, st = (L - TILE) / (n - 1); return Array.from({ length: n }, (_, i) => Math.round(i * st)); }
function iou(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), X = Math.min(a.x + a.w, b.x + b.w), Y = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, X - x) * Math.max(0, Y - y); return i / (a.w * a.h + b.w * b.h - i || 1);
}
const mean = (pts, from, to) => { let x = 0, y = 0; for (let i = from; i <= to; i++) { x += pts[i].x; y += pts[i].y; } const n = to - from + 1; return [x / n, y / n]; };

// Phép biến đổi đồng dạng (xoay + co giãn + tịnh tiến) đưa 5 điểm mốc về vị trí chuẩn
function similarity(src, dst) {
  let sx = 0, sy = 0, dx = 0, dy = 0; const n = src.length;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let a = 0, b = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy, qx = dst[i][0] - dx, qy = dst[i][1] - dy;
    a += px * qx + py * qy; b += px * qy - py * qx; den += px * px + py * py;
  }
  a /= den; b /= den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

const alignCv = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 112, height: 112 }) : null;
async function embed(big, pts5) {
  const t = similarity(pts5, TEMPLATE);
  const ctx = alignCv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 112, 112);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(t.a, t.b, -t.b, t.a, t.tx, t.ty);
  // chỉ vẽ vùng quanh mặt để nhanh và nét
  const s = Math.hypot(t.a, t.b), r = 112 / s * 1.2, cx = (pts5[0][0] + pts5[1][0] + pts5[3][0] + pts5[4][0]) / 4, cy = (pts5[0][1] + pts5[1][1] + pts5[3][1] + pts5[4][1]) / 4;
  const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r)), x1 = Math.min(big.width, Math.ceil(cx + r)), y1 = Math.min(big.height, Math.ceil(cy + r));
  ctx.drawImage(big, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  const px = ctx.getImageData(0, 0, 112, 112).data, N = 112 * 112, data = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) { data[i] = px[i * 4]; data[N + i] = px[i * 4 + 1]; data[2 * N + i] = px[i * 4 + 2]; }   // RGB, 0..255 (mô hình tự chuẩn hoá)
  const out = await session.run({ data: new ort.Tensor('float32', data, [1, 3, 112, 112]) });
  const v = Float32Array.from(out.fc1.data); let nrm = 0; for (const x of v) nrm += x * x; nrm = Math.sqrt(nrm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= nrm;
  return v;
}

// Tìm mọi khuôn mặt trong ảnh. Trả về [{d: vector 128 chiều, b: khung mặt (phần nghìn), q: cỡ mặt px}], mặt to trước.
export async function scanFaces(src, deep = true) {
  const big = toCanvas(src, BIG), W = big.width, H = big.height, cands = [];
  const opt = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45, maxResults: 100 });
  const full = toCanvas(big, 1600), k = W / full.width;
  for (const r of await faceapi.detectAllFaces(full, opt)) cands.push({ x: r.box.x * k, y: r.box.y * k, w: r.box.width * k, h: r.box.height * k, s: r.score });
  if (deep && Math.max(W, H) > TILE * 1.2) {
    const tw = Math.min(TILE, W), th = Math.min(TILE, H), t = document.createElement('canvas'); t.width = tw; t.height = th;
    const ctx = t.getContext('2d');
    for (const y0 of tileStarts(H)) for (const x0 of tileStarts(W)) {
      ctx.drawImage(big, x0, y0, tw, th, 0, 0, tw, th);
      for (const r of await faceapi.detectAllFaces(t, opt)) {
        const b = r.box, e = 3;
        if ((b.x < e && x0 > 0) || (b.y < e && y0 > 0) || (b.x + b.width > tw - e && x0 + tw < W) || (b.y + b.height > th - e && y0 + th < H)) continue;   // mặt bị cắt ở mép ô
        cands.push({ x: b.x + x0, y: b.y + y0, w: b.width, h: b.height, s: r.score });
      }
    }
  }
  cands.sort((a, b) => b.s - a.s);
  const keep = []; for (const c of cands) if (Math.min(c.w, c.h) >= MIN_FACE && !keep.some(q => iou(q, c) > 0.35)) keep.push(c);
  keep.sort((a, b) => b.w * b.h - a.w * a.h); keep.length = Math.min(keep.length, MAX_FACES);
  const out = [], one = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 });
  for (const c of keep) {
    // cắt vùng quanh mặt, tìm lại mặt + 68 điểm mốc trên vùng đó
    const side = Math.max(c.w, c.h) * 2.2, sx = c.x + c.w / 2 - side / 2, sy = c.y + c.h / 2 - side / 2, cs = Math.max(160, Math.min(420, Math.round(side)));
    const cv = document.createElement('canvas'); cv.width = cv.height = cs;
    const cx = cv.getContext('2d'); cx.fillStyle = '#777'; cx.fillRect(0, 0, cs, cs);
    const ix = Math.max(0, sx), iy = Math.max(0, sy), iX = Math.min(W, sx + side), iY = Math.min(H, sy + side), f = cs / side;
    cx.drawImage(big, ix, iy, iX - ix, iY - iy, (ix - sx) * f, (iy - sy) * f, (iX - ix) * f, (iY - iy) * f);
    const r = await faceapi.detectSingleFace(cv, one).withFaceLandmarks();
    if (!r) continue;                                   // không xác nhận lại được: bỏ (thường là nhận nhầm)
    const p = r.landmarks.positions, toBig = ([x, y]) => [x / f + sx, y / f + sy];
    const pts5 = [mean(p, 36, 41), mean(p, 42, 47), [p[30].x, p[30].y], [p[48].x, p[48].y], [p[54].x, p[54].y]].map(toBig);
    const eye = Math.hypot(pts5[1][0] - pts5[0][0], pts5[1][1] - pts5[0][1]);
    if (eye < MIN_FACE * 0.25) continue;                 // mặt quay ngang hẳn hoặc quá nhỏ: vector không đáng tin
    out.push({ d: await embed(big, pts5), b: [c.x / W, c.y / H, c.w / W, c.h / H].map(v => Math.round(v * 1000)), q: Math.round(Math.min(c.w, c.h)) });
  }
  return out;
}
