// Gom nhóm khuôn mặt thành từng người.
// Nguyên tắc: thà sót còn hơn nhầm.
//  - Chỉ mặt đủ to, rõ (q >= CORE_Q) mới được dùng để lập nhóm.
//  - Hai mặt chỉ được nối với nhau khi rất giống (khoảng cách < T), rồi lan nhãn theo đồ thị (Chinese Whispers).
//  - Nhóm nào lỏng lẻo (các mặt bên trong không giống nhau) thì bị tách lại với ngưỡng chặt hơn.
//  - Mặt nhỏ chỉ được gán vào nhóm khi cực kỳ giống tâm nhóm; mặt quá nhỏ thì không gán.

export const CORE_Q = 56;      // cỡ mặt (px) tối thiểu để tham gia lập nhóm
export const SMALL_Q = 40;     // mặt nhỏ hơn mức này không được gán vào người nào
// Các ngưỡng dưới đây tính theo khoảng cách giữa 2 vector SFace đã chuẩn hoá:
// cùng một người thường < 0.9, khác người thường > 1.2 (OpenCV coi < 1.128 là cùng người).
const T0 = 0.85;               // ngưỡng nối 2 mặt
const T_STEP = 0.05, T_MIN = 0.65;
const LOOSE = 0.98;            // khoảng cách trung bình trong nhóm vượt mức này = nhóm lỏng, phải tách
const OUTLIER = 1.0;           // xa tâm nhóm hơn mức này thì loại khỏi nhóm
const SMALL_T = 0.75;          // mặt nhỏ phải gần tâm nhóm hơn mức này
const SAME_REP = 0.85;         // 2 nhóm có mặt mẫu gần hơn mức này là cùng một người

function d2(a, b, limit) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; if (s > limit) return s; }
  return s;
}
const dist = (a, b) => Math.sqrt(d2(a, b, Infinity));
const tick = () => new Promise(r => setTimeout(r, 0));

function centroid(idx, F) {
  const c = new Float32Array(128);
  for (const i of idx) { const d = F[i].d; for (let k = 0; k < 128; k++) c[k] += d[k]; }
  for (let k = 0; k < 128; k++) c[k] /= idx.length;
  return c;
}
function meanPairwise(idx, F) {
  const s = idx.length > 30 ? idx.filter((_, i) => i % Math.ceil(idx.length / 30) === 0) : idx;
  let sum = 0, n = 0;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) { sum += dist(F[s[i]].d, F[s[j]].d); n++; }
  return n ? sum / n : 0;
}

// Chinese Whispers trên tập chỉ số idx với ngưỡng T. Trả về mảng các nhóm (mỗi nhóm là mảng chỉ số).
async function whispers(idx, F, T, onProgress) {
  const n = idx.length, T2 = T * T;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const a = F[idx[i]].d;
    for (let j = i + 1; j < n; j++) {
      const s = d2(a, F[idx[j]].d, T2);
      if (s < T2) { const w = T - Math.sqrt(s); adj[i].push(j, w); adj[j].push(i, w); }
    }
    if (i % 200 === 0) { onProgress?.(i / n); await tick(); }
  }
  const label = Int32Array.from({ length: n }, (_, i) => i);
  const order = Array.from({ length: n }, (_, i) => i);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let it = 0; it < 25; it++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let changed = 0;
    for (const i of order) {
      const a = adj[i]; if (!a.length) continue;
      const score = new Map();
      for (let k = 0; k < a.length; k += 2) { const l = label[a[k]]; score.set(l, (score.get(l) || 0) + a[k + 1]); }
      let best = label[i], bs = score.get(best) || 0;
      for (const [l, s] of score) if (s > bs + 1e-9) { bs = s; best = l; }
      if (best !== label[i]) { label[i] = best; changed++; }
    }
    if (!changed) break;
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { if (!groups.has(label[i])) groups.set(label[i], []); groups.get(label[i]).push(idx[i]); }
  return [...groups.values()];
}

// F: [{d: Float32Array(128), q: cỡ mặt px, pid: mã ảnh}]
// Trả về { labels: Int32Array (0 = không thuộc ai, 1..K), reps: chỉ số mặt đại diện của từng người }
export async function clusterFaces(F, { minPhotos = 2, maxPeople = 400, onProgress } = {}) {
  const core = []; for (let i = 0; i < F.length; i++) if (F[i].q >= CORE_Q) core.push(i);
  const done = [];
  let queue = [{ idx: core, T: T0 }];
  while (queue.length) {
    const { idx, T } = queue.pop();
    const groups = await whispers(idx, F, T, idx === core ? onProgress : null);
    for (const g of groups) {
      if (g.length < 2) continue;
      if (g.length >= 6 && T - T_STEP >= T_MIN && meanPairwise(g, F) > LOOSE) queue.push({ idx: g, T: T - T_STEP });   // nhóm lỏng: tách lại
      else done.push(g);
    }
    await tick();
  }
  // Loại mặt nằm xa tâm nhóm
  let clusters = done.map(g => {
    let c = centroid(g, F);
    const kept = g.filter(i => dist(F[i].d, c) <= OUTLIER);
    if (kept.length >= 2 && kept.length < g.length) c = centroid(kept, F);
    return { m: kept, c };
  }).filter(x => x.m.length >= 2);
  // Mặt nhỏ: chỉ gán khi cực kỳ giống tâm của đúng một nhóm
  for (let i = 0; i < F.length; i++) {
    const f = F[i]; if (f.q >= CORE_Q || f.q < SMALL_Q) continue;
    let best = null, bd = SMALL_T, second = 9;
    for (const cl of clusters) { const d = dist(f.d, cl.c); if (d < bd) { second = bd; bd = d; best = cl; } else if (d < second) second = d; }
    if (best && second - bd > 0.15) (best.extra ||= []).push(i);
  }
  for (const cl of clusters) {
    cl.all = cl.m.concat(cl.extra || []);
    cl.photos = new Set(cl.all.map(i => F[i].pid)).size;
  }
  clusters = clusters.filter(c => c.photos >= minPhotos).sort((a, b) => b.photos - a.photos).slice(0, maxPeople);
  // Mỗi người: chọn tối đa 3 mặt mẫu to, rõ, gần tâm nhóm nhất (mặt đầu tiên làm ảnh đại diện)
  const score = (i, cl) => Math.min(F[i].q, 200) - 150 * dist(F[i].d, cl.c);
  for (const cl of clusters) cl.tops = [...cl.m].sort((a, b) => score(b, cl) - score(a, cl)).slice(0, 3);
  // Hai nhóm có mặt mẫu quá giống nhau là cùng một người bị tách: chỉ giữ nhóm lớn hơn
  const kept = [];
  for (const cl of clusters) if (!kept.some(k => dist(F[k.tops[0]].d, F[cl.tops[0]].d) < SAME_REP)) kept.push(cl);
  const labels = new Int32Array(F.length), reps = [], tops = [];
  kept.forEach((cl, k) => { for (const i of cl.all) labels[i] = k + 1; reps.push(cl.tops[0]); tops.push(cl.tops); });
  return { labels, reps, tops };
}
