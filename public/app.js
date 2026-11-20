// FindImageAI – logic trang album (chạy trên Cloudflare Worker + R2)
const $ = s => document.querySelector(s);
const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
const ICON_SELFIE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="10" r="3"/><path d="M7 18c1-2.5 3-3.5 5-3.5s4 1 5 3.5"/></svg>';
const PAGE = 120;            // số ảnh hiển thị mỗi lần cuộn
const Q_SCALE = 300;         // lượng tử hoá vector khuôn mặt về Int8
const SAVE_EVERY = 10;       // lưu chỉ mục sau mỗi N ảnh khi thêm ảnh
const CLUSTER_T = 0.46;      // ngưỡng gom 1 khuôn mặt vào nhóm
const MERGE_T = 0.36;        // ngưỡng gộp 2 nhóm
const MIN_PHOTOS = 2;        // người xuất hiện ít nhất N ảnh mới hiện ra
const MAX_PEOPLE = 400;
const ZIP_MAX = 500;
const BIG = 3200, TILE = 1280, TSTEP = 1000;   // quét chia ô để bắt mặt nhỏ
const MIN_FACE = 26, MAX_FACES = 80, SEED_FACE = 44;   // cỡ mặt (px) tối thiểu để lấy / để làm hạt giống nhóm
const MAX_SELFIES = 3;
const SOLO_FACE = 70;         // cỡ mặt (px) để người chỉ xuất hiện 1 ảnh vẫn được hiện           // số ảnh tối đa cho 1 lần tải zip

/* ---------------- state ---------------- */
const S = {
  publicUrl:'', hasDrive:false, pw:null, canEdit:false,
  info:{}, photos:[], people:[], cat:null, sort:'time', shown:0,
  selfie:null, selfieUrl:null, threshold:0.52, matches:new Map(),
  person:null,
  lbList:[], lbIdx:0, busy:false, stop:false,
};
const fileUrl = key => key ? (S.publicUrl ? S.publicUrl + '/' + key : '/api/file/' + key) : '';
const byTime = (a,b)=>(a.taken||a.at||0)-(b.taken||b.at||0);

/* ---------------- API ---------------- */
async function api(path, opts={}){
  const headers = {...(opts.headers||{})};
  if(S.pw) headers.authorization = 'Bearer ' + S.pw;
  const r = await fetch(path, {...opts, headers});
  if(!r.ok){
    let msg = 'Lỗi ' + r.status;
    try{ msg = (await r.json()).error || msg; }catch(e){}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return r;
}
async function loadIndex(){
  const d = await (await api('/api/index?t=' + Date.now())).json();
  S.info = d.info || {};
  S.people = d.people || [];
  S.photos = (d.photos || []).map(p => ({...p, _f: (p.f||[]).map(decodeFace)}));
  S.photos.sort(byTime);
}
async function saveIndex(){
  const out = { v:2, updatedAt: Date.now(), info: S.info, people: S.people,
    photos: S.photos.map(({_f, ...rest}) => rest) };
  await api('/api/index', {method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify(out)});
}

/* ---------------- vector khuôn mặt ---------------- */
function encodeFace(desc){
  const q = new Int8Array(128);
  for(let i=0;i<128;i++) q[i] = Math.max(-127, Math.min(127, Math.round(desc[i]*Q_SCALE)));
  let s=''; for(const b of new Uint8Array(q.buffer)) s += String.fromCharCode(b);
  return btoa(s);
}
function decodeFace(b64){
  const s = atob(b64), f = new Float32Array(128);
  for(let i=0;i<128;i++){ const c = s.charCodeAt(i); f[i] = (c>127 ? c-256 : c)/Q_SCALE; }
  return f;
}
function dist(a,b){ let s=0; for(let i=0;i<128;i++){ const d=a[i]-b[i]; s+=d*d; } return Math.sqrt(s); }
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,10);
const tick = () => new Promise(r=>setTimeout(r,0));

/* ---------------- toast / confirm ---------------- */
let toastT;
function toast(msg, ms=3400){ const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add('hidden'),ms); }
function ask(title, text, yes='Đồng ý'){
  return new Promise(res=>{
    $('#cfTitle').textContent=title; $('#cfText').textContent=text; $('#cfYes').textContent=yes;
    const m=$('#confirm'); m.classList.remove('hidden');
    const done=v=>{ m.classList.add('hidden'); $('#cfYes').onclick=$('#cfNo').onclick=null; res(v); };
    $('#cfYes').onclick=()=>done(true); $('#cfNo').onclick=()=>done(false);
  });
}

/* ---------------- face-api (tải khi cần) ---------------- */
let faceapi=null, modelsP=null;
function loadModels(onMsg){
  if(!modelsP){
    modelsP=(async()=>{
      onMsg?.('Đang tải mô hình AI (lần đầu khoảng 12 MB)…');
      faceapi = await import('./face-api.esm.js');
      try{ await faceapi.tf.setBackend('webgl'); }catch(e){}
      await faceapi.tf.ready();
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri('./model'),
        faceapi.nets.faceLandmark68Net.loadFromUri('./model'),
        faceapi.nets.faceRecognitionNet.loadFromUri('./model'),
      ]);
      return faceapi;
    })().catch(e=>{ modelsP=null; throw e; });
  }
  return modelsP;
}
async function fileToBitmap(file){
  try{ return await createImageBitmap(file,{imageOrientation:'from-image'}); }
  catch(e){
    const url=URL.createObjectURL(file);
    try{ const img=new Image(); img.src=url; await img.decode(); return img; }
    finally{ setTimeout(()=>URL.revokeObjectURL(url),1000); }
  }
}
function toCanvas(src, max){
  const w=src.width||src.naturalWidth, h=src.height||src.naturalHeight;
  const k=Math.min(1, max/Math.max(w,h));
  const c=document.createElement('canvas'); c.width=Math.round(w*k); c.height=Math.round(h*k);
  c.getContext('2d').drawImage(src,0,0,c.width,c.height);
  return c;
}
const canvasBlob=(c,q=.85,type='image/jpeg')=>new Promise(r=>c.toBlob(r,type,q));
async function detectAll(canvas, minConf=0.45){
  const opts=new faceapi.SsdMobilenetv1Options({minConfidence:minConf, maxResults:60});
  return await faceapi.detectAllFaces(canvas,opts).withFaceLandmarks().withFaceDescriptors();
}

function tileStarts(L){ if(L<=TILE) return [0]; const n=Math.ceil((L-TILE)/TSTEP)+1, st=(L-TILE)/(n-1); return Array.from({length:n},(_,i)=>Math.round(i*st)); }
function iou(a,b){
  const x=Math.max(a.x,b.x), y=Math.max(a.y,b.y), X=Math.min(a.x+a.w,b.x+b.w), Y=Math.min(a.y+a.h,b.y+b.h);
  const i=Math.max(0,X-x)*Math.max(0,Y-y); return i/(a.w*a.h+b.w*b.h-i||1);
}
// Tìm mọi khuôn mặt trong ảnh: quét toàn ảnh + từng ô phóng to, rồi lấy vector từ vùng mặt nét nhất
async function scanFaces(src, deep){
  const big=toCanvas(src,BIG), W=big.width, H=big.height, cands=[];
  const opt=new faceapi.SsdMobilenetv1Options({minConfidence:0.45,maxResults:100});
  const full=toCanvas(big,1600), k=W/full.width;
  for(const r of await faceapi.detectAllFaces(full,opt)) cands.push({x:r.box.x*k,y:r.box.y*k,w:r.box.width*k,h:r.box.height*k,s:r.score});
  if(deep && Math.max(W,H)>TILE*1.2){
    const tw=Math.min(TILE,W), th=Math.min(TILE,H), t=document.createElement('canvas'); t.width=tw; t.height=th;
    const ctx=t.getContext('2d');
    for(const y0 of tileStarts(H)) for(const x0 of tileStarts(W)){
      ctx.drawImage(big,x0,y0,tw,th,0,0,tw,th);
      for(const r of await faceapi.detectAllFaces(t,opt)){
        const b=r.box, e=3;
        if((b.x<e&&x0>0)||(b.y<e&&y0>0)||(b.x+b.width>tw-e&&x0+tw<W)||(b.y+b.height>th-e&&y0+th<H)) continue;   // mặt bị cắt ở mép ô
        cands.push({x:b.x+x0,y:b.y+y0,w:b.width,h:b.height,s:r.score});
      }
    }
  }
  cands.sort((a,b)=>b.s-a.s);
  const keep=[]; for(const c of cands) if(Math.min(c.w,c.h)>=MIN_FACE && !keep.some(q=>iou(q,c)>0.35)) keep.push(c);
  keep.sort((a,b)=>b.w*b.h-a.w*a.h); keep.length=Math.min(keep.length,MAX_FACES);
  const out=[], one=new faceapi.SsdMobilenetv1Options({minConfidence:0.3});
  for(const c of keep){
    const side=Math.max(c.w,c.h)*2.2, sx=c.x+c.w/2-side/2, sy=c.y+c.h/2-side/2, cs=Math.max(160,Math.min(420,Math.round(side)));
    const cv=document.createElement('canvas'); cv.width=cv.height=cs;
    const cx=cv.getContext('2d'); cx.fillStyle='#777'; cx.fillRect(0,0,cs,cs);
    const ix=Math.max(0,sx), iy=Math.max(0,sy), iX=Math.min(W,sx+side), iY=Math.min(H,sy+side), f=cs/side;
    cx.drawImage(big,ix,iy,iX-ix,iY-iy,(ix-sx)*f,(iy-sy)*f,(iX-ix)*f,(iY-iy)*f);
    const r=await faceapi.detectSingleFace(cv,one).withFaceLandmarks().withFaceDescriptor();
    if(!r) continue;                                   // không xác nhận lại được: bỏ (thường là nhận nhầm)
    out.push({d:r.descriptor, b:[c.x/W,c.y/H,c.w/W,c.h/H].map(v=>Math.round(v*1000)), q:Math.round(Math.min(c.w,c.h))});
  }
  return out;
}

/* ---------------- hiển thị ---------------- */
function renderBrand(){
  const i=S.info||{}, logos=(i.logos||[]).slice(0,2).filter(Boolean);
  setFavicon((i.logos||[])[2] || (i.logos||[])[0] || null);
  const mk=(host,withSep)=>{
    host.textContent='';
    logos.forEach((id,k)=>{
      if(k && withSep){ const s=document.createElement('span'); s.className='sep'; host.appendChild(s); }
      const img=document.createElement('img'); img.src=fileUrl('l/'+id+'.png'); img.alt=k?'Logo thương hiệu':'Logo công ty'; host.appendChild(img);
    });
  };
  const b=$('#brand');
  if(logos.length) mk(b,true);
  else { b.textContent=''; if(i.brand){ const t=document.createElement('span'); t.className='txt'; t.textContent=i.brand; b.appendChild(t); } }
  mk($('#footLogos'),false);
  $('#footLogos').classList.toggle('hidden',!logos.length);
  $('#footBrand').textContent = i.brand || i.title || 'Album ảnh';
}
let favId;
async function setFavicon(id){
  if(id===favId) return; favId=id;
  const link=$('#favicon'); if(!id){ link.href='data:,'; return; }
  try{
    const bmp=await createImageBitmap(await (await fetch('/api/file/l/'+id+'.png')).blob());
    const c=document.createElement('canvas'); c.width=c.height=64;
    const k=Math.min(64/bmp.width,64/bmp.height), w=bmp.width*k, hh=bmp.height*k;
    c.getContext('2d').drawImage(bmp,(64-w)/2,(64-hh)/2,w,hh);
    if(favId===id){ link.type='image/png'; link.href=c.toDataURL('image/png'); }
  }catch(e){}
}
function renderInfo(){
  const i=S.info||{};
  $('#title').textContent = i.title ? 'Album '+i.title : (S.canEdit ? 'Album chưa đặt tên' : 'Album ảnh');
  $('#heroSub').textContent = [i.eyebrow, i.date, i.place].filter(Boolean).join(' · ');
  document.title = (i.title ? i.title+' · ' : '') + 'Album ảnh';
  const cover = (i.cover && S.photos.some(p=>p.id===i.cover)) ? i.cover : S.photos[0]?.id;
  $('#hero').classList.toggle('nocover', !cover);
  $('#heroBg').style.backgroundImage = cover ? `url("${fileUrl('p/'+cover+'.jpg')}")` : '';
  renderBrand();
}
function personCounts(){
  const m=new Map();
  for(const p of S.photos){ if(!p.g) continue; for(const id of new Set(p.g)) if(id) m.set(id,(m.get(id)||0)+1); }
  return m;
}
function renderPeople(){
  const counts=personCounts();
  const list=S.people.filter(x=>(counts.get(x.id)||0)>=1);
  $('#peopleStat').classList.toggle('hidden',!list.length); $('#nPeople').textContent=list.length;
  $('#peopleSub').textContent=list.length
    ? `AI đã nhận diện sẵn ${list.length} người trong album. Chạm vào khuôn mặt của bạn để xem ảnh của mình, hoặc tìm bằng ảnh selfie.`
    : 'Tải 1 ảnh selfie để AI lọc ra những ảnh có bạn.';
  const host=$('#faces'); host.textContent='';
  for(const x of list){
    const b=document.createElement('button'); b.className='face'+(S.person===x.id?' on':'');
    const n=counts.get(x.id)||0; b.setAttribute('aria-label',`Xem ${n} ảnh của người này`);
    const av=document.createElement('span'); av.className='av';
    const img=document.createElement('img'); img.loading='lazy'; img.alt=''; img.src=fileUrl(x.av); av.appendChild(img);
    const sm=document.createElement('small'); sm.textContent=n+' ảnh';
    b.append(av,sm); b.onclick=()=>pickPerson(x.id); host.appendChild(b);
  }
}
function openPeople(){ renderPeople(); $('#peopleModal').classList.remove('hidden'); }
const onAct=(name,fn)=>document.querySelectorAll(`[data-act=${name}]`).forEach(b=>b.addEventListener('click',fn));
onAct('people',openPeople); $('#peopleStat').onclick=openPeople;
$('#selfieBtn').onclick=()=>{ $('#peopleModal').classList.add('hidden'); openFace(); };
function toGrid(){ $('#bar').scrollIntoView({behavior:'smooth'}); }
function pickPerson(id){
  S.person=id; S.selfie=null; S.selfieUrl=null; S.matches.clear(); saveSelfie();
  $('#peopleModal').classList.add('hidden'); showChip(); renderGrid(); toGrid();
}
const hasFilter = () => !!(S.person || S.selfie?.length);
function categories(){
  const m=new Map(); for(const p of S.photos) if(p.c) m.set(p.c,(m.get(p.c)||0)+1);
  return [...m.keys()].sort((a,b)=>a.localeCompare(b,'vi',{numeric:true}));
}
function renderChips(){
  const cats=categories(), host=$('#chips');
  if(S.cat && !cats.includes(S.cat)) S.cat=null;
  $('#chipsrow').classList.toggle('nocats',!cats.length); host.textContent=''; if(!cats.length) return;
  const mk=(label,val)=>{ const b=document.createElement('button'); b.className='chipbtn'+(S.cat===val?' on':''); b.textContent=label; b.title=label;
    b.onclick=()=>{ S.cat=val; renderChips(); renderGrid(); }; host.appendChild(b); };
  mk('Tất cả',null); cats.forEach(c=>mk(c,c));
}
function currentList(){
  let list=S.photos;
  if(S.cat) list=list.filter(p=>p.c===S.cat);
  if(S.person) list=list.filter(p=>p.g?.includes(S.person));
  else if(S.selfie?.length) list=list.filter(p=>S.matches.has(p.id));
  list=[...list];
  if(S.sort==='new') list.sort((a,b)=>byTime(b,a));
  else if(S.sort==='name') list.sort((a,b)=>(a.name||'').localeCompare(b.name||'','vi',{numeric:true}));
  else if(S.selfie && !S.person && S.sort==='match') list.sort((a,b)=>S.matches.get(a.id)-S.matches.get(b.id));
  else list.sort(byTime);
  return list;
}
function tile(p, list, idx){
  const d=document.createElement('div'); d.className='tile'; d.tabIndex=0; d.setAttribute('role','button'); d.setAttribute('aria-label','Xem ảnh');
  const img=document.createElement('img'); img.loading='lazy'; img.decoding='async'; img.alt='';
  img.src=fileUrl('t/'+p.id+'.jpg');
  if(p.w&&p.h){ img.width=p.w; img.height=p.h; img.style.aspectRatio=p.w+'/'+p.h; }
  d.appendChild(img);
  if(S.selfie && !S.person && S.matches.has(p.id)){
    const b=document.createElement('span'); b.className='badge';
    const dd=S.matches.get(p.id); b.textContent= dd<0.40?'Rất giống':dd<0.48?'Giống':'Có thể là bạn';
    if(dd>=0.6) b.title='AI đoán theo nhóm khuôn mặt đã gom';
    d.appendChild(b);
  }
  const dl=document.createElement('button'); dl.className='dl'; dl.innerHTML=ICON_DL; dl.setAttribute('aria-label','Tải ảnh');
  dl.onclick=e=>{ e.stopPropagation(); downloadOne(p); };
  d.appendChild(dl);
  d.onclick=()=>openLB(list,idx);
  d.onkeydown=e=>{ if(e.key==='Enter'&&e.target===d) openLB(list,idx); };
  return d;
}
let gridList=[];
function renderGrid(){
  gridList=currentList(); const list=gridList; renderSort();
  $('#nAll').textContent=S.photos.length.toLocaleString('vi-VN');
  $('#nMine').textContent=list.length;
  $('#grid').textContent=''; S.shown=0; renderMore();
  const empty=$('#empty');
  if(list.length || $('#loadNote').dataset.loading){ empty.classList.add('hidden'); return; }
  empty.classList.remove('hidden'); empty.textContent='';
  const h=document.createElement('h3'), p=document.createElement('p'); empty.append(h,p);
  const btn=(label,cls,fn)=>{ const b=document.createElement('button'); b.className='btn '+cls; b.textContent=label; b.onclick=fn; empty.appendChild(b); };
  if(hasFilter()){ h.textContent='Chưa tìm thấy ảnh nào có bạn'; p.textContent=S.cat?'Không có ảnh của bạn trong mục này. Thử chọn "Tất cả".':'Thử một ảnh selfie khác rõ mặt hơn, hoặc nới độ khớp rộng hơn.'; btn('Tìm lại','primary',openPeople); }
  else if(S.canEdit){ h.textContent='Album đang trống'; p.textContent='Thêm ảnh sự kiện, AI sẽ tự quét và gom nhóm khuôn mặt.'; btn('Thêm ảnh','primary',openAdmin); }
  else { h.textContent='Album chưa có ảnh'; p.textContent='Ảnh sự kiện sẽ xuất hiện ở đây khi ban tổ chức tải lên.'; }
}
function renderMore(){
  const list=gridList; if(S.shown>=list.length) return;
  const frag=document.createDocumentFragment();
  const end=Math.min(list.length, S.shown+PAGE);
  for(let i=S.shown;i<end;i++) frag.appendChild(tile(list[i],list,i));
  S.shown=end; $('#grid').appendChild(frag);
}
new IntersectionObserver(es=>{ if(es.some(e=>e.isIntersecting)) renderMore(); },{rootMargin:'1200px'}).observe($('#sentinel'));
function renderStats(){
  $('#sPhotos').textContent=S.photos.length.toLocaleString('vi-VN');
  $('#sFaces').textContent=S.photos.reduce((s,p)=>s+(p.f?.length||0),0).toLocaleString('vi-VN');
  $('#sPeople').textContent=S.people.length.toLocaleString('vi-VN');
  $('#sSize').textContent=(S.photos.reduce((s,p)=>s+(p.bytes||0),0)/1073741824).toFixed(2)+' GB';
}
function renderAll(){ renderInfo(); renderPeople(); renderChips(); renderGrid(); renderStats(); }

/* ---------------- thanh công cụ ---------------- */
$('#viewAllBtn').onclick=toGrid;
new IntersectionObserver(es=>{ const away=es[0].intersectionRatio>0.35; $('#dock').classList.toggle('away',away); if(away) $('#sortMenu').classList.add('hidden'); },{threshold:[0,0.35,1]}).observe($('#hero'));
const SORT_NAME={time:'Cũ trước',new:'Mới trước',name:'Tên ảnh',match:'Giống nhất'};
function renderSort(){ document.querySelectorAll('.sortlbl').forEach(e=>e.textContent=SORT_NAME[S.sort]||''); }
onAct('sort',e=>{
  e.stopPropagation(); const m=$('#sortMenu'), r=e.currentTarget.getBoundingClientRect(), wasHidden=m.classList.contains('hidden');
  m.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.sort===S.sort));
  m.classList.toggle('hidden',!wasHidden); if(!wasHidden) return;
  if(e.currentTarget.closest('.dock')){ m.style.top=''; m.style.right=''; m.style.left='50%'; m.style.bottom=(innerHeight-r.top+8)+'px'; m.style.transform='translateX(-50%)'; }
  else { m.style.bottom=''; m.style.left=''; m.style.transform=''; m.style.top=(r.bottom+6)+'px'; m.style.right=Math.max(8,innerWidth-r.right)+'px'; }
});
document.querySelectorAll('#sortMenu button').forEach(b=>b.onclick=()=>{ S.sort=b.dataset.sort; $('#sortMenu').classList.add('hidden'); renderGrid(); });
document.addEventListener('click',()=>$('#sortMenu').classList.add('hidden'));
window.addEventListener('scroll',()=>$('#sortMenu').classList.add('hidden'),{passive:true});
const setLayout=on=>{ document.body.classList.toggle('squares',on); document.querySelectorAll('[data-act=layout]').forEach(b=>b.classList.toggle('on',on)); };
onAct('layout',()=>{ const on=!document.body.classList.contains('squares'); setLayout(on); try{ localStorage.setItem('album.squares',on?'1':''); }catch(e){} });
try{ if(localStorage.getItem('album.squares')) setLayout(true); }catch(e){}
onAct('share',async()=>{
  const url=location.origin+location.pathname, title=S.info.title?'Album '+S.info.title:'Album ảnh';
  try{ if(navigator.share){ await navigator.share({title,url}); return; } }catch(e){ if(e.name==='AbortError') return; }
  try{ await navigator.clipboard.writeText(url); toast('Đã sao chép link album'); }catch(e){ toast(url,8000); }
});

/* ---------------- so khớp selfie ---------------- */
function recompute(){
  S.matches.clear(); if(!S.selfie?.length) return;
  const strong=new Map(), total=new Map();           // theo nhóm người: số mặt khớp chắc / tổng số mặt
  for(const p of S.photos){
    if(!p._f?.length) continue;
    let best=9;
    p._f.forEach((f,i)=>{
      let d=9; for(const sv of S.selfie){ const x=dist(sv,f); if(x<d) d=x; }
      if(d<best) best=d;
      const g=p.g?.[i]; if(g){ total.set(g,(total.get(g)||0)+1); if(d<=Math.min(S.threshold,0.45)) strong.set(g,(strong.get(g)||0)+1); }
    });
    if(best<=S.threshold) S.matches.set(p.id,best);
  }
  // Nếu selfie khớp chắc với một nhóm người đã gom, lấy thêm các ảnh còn lại của nhóm đó (góc nghiêng, mặt nhỏ…)
  const mine=new Set(); for(const [g,n] of strong) if(n>=2 && n>=total.get(g)*0.3) mine.add(g);
  if(mine.size) for(const p of S.photos) if(!S.matches.has(p.id) && p.g?.some(g=>mine.has(g))) S.matches.set(p.id,0.6);
}
const thName = v => v<0.47?'Chặt':v>0.56?'Rộng':'Cân bằng';
$('#th').oninput=e=>{
  S.threshold=+e.target.value; $('#thLabel').textContent=thName(S.threshold);
  recompute(); $('#thCount').textContent=S.matches.size+' ảnh'; renderGrid(); showChip(); saveSelfie();
  $('#showMine').classList.toggle('hidden',!S.matches.size);
};
function saveSelfie(){
  try{
    if(S.selfie?.length) localStorage.setItem('album.selfie',JSON.stringify({ds:S.selfie.map(d=>Array.from(d)),t:S.threshold,u:S.selfieUrl}));
    else localStorage.removeItem('album.selfie');
  }catch(e){}
}
function restoreSelfie(){
  try{
    const v=JSON.parse(localStorage.getItem('album.selfie')||'null');
    const ds=(v?.ds||(v?.d?[v.d]:[])).filter(d=>d?.length===128);
    if(ds.length){ S.selfie=ds.map(d=>Float32Array.from(d)); S.threshold=v.t||0.52; S.selfieUrl=v.u||null; $('#th').value=S.threshold; }
  }catch(e){}
}
function showChip(){
  const chip=$('#selChip'); chip.classList.toggle('hidden',!hasFilter()); if(!hasFilter()) return;
  if(S.person){ const x=S.people.find(x=>x.id===S.person); $('#selChipImg').src=x?fileUrl(x.av):''; $('#selChipTxt').textContent='Ảnh của người này'; }
  else { $('#selChipImg').src=S.selfieUrl||''; $('#selChipTxt').textContent='Ảnh khớp với selfie của bạn'; }
}
$('#clearSel').onclick=()=>{ S.person=null; S.selfie=null; S.selfieUrl=null; S.matches.clear(); if(S.sort==='match') S.sort='time'; saveSelfie(); showChip(); renderPeople(); renderGrid(); };

/* ---------------- tìm bằng selfie ---------------- */
function openFace(){
  S.addMode=false;
  $('#faceModal').classList.remove('hidden');
  $('#faceStep1').classList.remove('hidden'); $('#faceStep2').classList.add('hidden');
  loadModels().catch(()=>{});
}
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{ const m=b.closest('.modal'); if(m.id==='adminModal'&&S.busy){ toast('Đang xử lý ảnh, bấm Dừng trước khi đóng.'); return; } m.classList.add('hidden'); });
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m && m.id!=='confirm' && !(m.id==='adminModal'&&S.busy)) m.classList.add('hidden'); }));
function wireDrop(el,input,handler){
  input.onchange=()=>{ if(input.files.length) handler([...input.files]); input.value=''; };
  el.addEventListener('dragover',e=>{e.preventDefault(); el.classList.add('over');});
  el.addEventListener('dragleave',()=>el.classList.remove('over'));
  el.addEventListener('drop',e=>{e.preventDefault(); el.classList.remove('over'); const f=[...e.dataTransfer.files].filter(f=>f.type.startsWith('image/')); if(f.length) handler(f);});
}
wireDrop($('#selfieDrop'),$('#selfieInput'),files=>runSelfie(files[0]));
$('#retrySelfie').onclick=()=>{ S.addMode=false; $('#faceStep1').classList.remove('hidden'); $('#faceStep2').classList.add('hidden'); };
$('#addSelfie').onclick=()=>{ S.addMode=true; $('#faceStep1').classList.remove('hidden'); $('#faceStep2').classList.add('hidden'); };
$('#showMine').onclick=()=>{ $('#faceModal').classList.add('hidden'); renderGrid(); toGrid(); };

async function runSelfie(file){
  $('#faceStep1').classList.add('hidden');
  const s2=$('#faceStep2'); s2.classList.remove('hidden','done');
  $('#scanActions').classList.add('hidden'); $('#sliderWrap').classList.add('hidden');
  const msg=$('#scanMsg'); msg.textContent='Đang đọc ảnh…';
  const say=(main,sub)=>{ msg.textContent=main; if(sub){ const s=document.createElement('small'); s.textContent=sub; msg.appendChild(s); } };
  try{
    const bmp=await fileToBitmap(file);
    $('#selfiePreview').src=toCanvas(bmp,200).toDataURL('image/jpeg',.8);
    await loadModels(t=>msg.textContent=t);
    msg.textContent='Đang nhận diện khuôn mặt…';
    const c=toCanvas(bmp,1024);
    const dets=await detectAll(c,0.4);
    if(!dets.length){
      s2.classList.add('done');
      say('Không thấy khuôn mặt nào trong ảnh','Hãy dùng ảnh chụp thẳng, đủ sáng, mặt chiếm phần lớn khung hình.');
      $('#scanActions').classList.remove('hidden'); $('#showMine').classList.add('hidden'); return;
    }
    dets.sort((a,b)=>b.detection.box.area-a.detection.box.area);
    const best=dets[0], bx=best.detection.box, pad=bx.width*.5;
    const fc=document.createElement('canvas'); fc.width=fc.height=200;
    fc.getContext('2d').drawImage(c,Math.max(0,bx.x-pad),Math.max(0,bx.y-pad),bx.width+pad*2,bx.height+pad*2,0,0,200,200);
    S.selfieUrl=fc.toDataURL('image/jpeg',.8); $('#selfiePreview').src=S.selfieUrl;
    if(S.addMode && S.selfie?.length && S.selfie.length<MAX_SELFIES) S.selfie=[...S.selfie,best.descriptor]; else S.selfie=[best.descriptor];
    S.addMode=false; S.person=null; S.sort='match';
    msg.textContent='Đang so khớp với '+S.photos.length.toLocaleString('vi-VN')+' ảnh…';
    await new Promise(r=>setTimeout(r,300));
    recompute(); saveSelfie(); showChip(); renderPeople(); s2.classList.add('done');
    const n=S.matches.size;
    if(n){ msg.textContent='Tìm thấy '; const em=document.createElement('em'); em.textContent=n+' ảnh'; msg.append(em,' có bạn');
      const s=document.createElement('small'); s.textContent=(S.selfie.length>1?`Đang dùng ${S.selfie.length} ảnh selfie. `:'')+(dets.length>1?'Ảnh có nhiều người, AI chọn khuôn mặt lớn nhất. ':'')+'Thiếu ảnh? Thêm selfie góc khác hoặc kéo thanh bên dưới.'; msg.appendChild(s); }
    else say('Chưa tìm thấy ảnh nào khớp','Thử nới độ khớp rộng hơn hoặc dùng ảnh selfie khác.');
    $('#scanActions').classList.remove('hidden'); $('#showMine').classList.toggle('hidden',!n); $('#addSelfie').classList.toggle('hidden',S.selfie.length>=MAX_SELFIES);
    $('#sliderWrap').classList.remove('hidden'); $('#thLabel').textContent=thName(S.threshold); $('#thCount').textContent=n+' ảnh';
    renderGrid();
  }catch(e){
    console.error(e); s2.classList.add('done');
    say('Không chạy được AI trên trình duyệt này','Hãy thử Chrome hoặc Safari bản mới, hoặc dùng máy tính.');
    $('#scanActions').classList.remove('hidden'); $('#showMine').classList.add('hidden');
  }
}

/* ---------------- tải ảnh về ---------------- */
const fname = p => ((p.name||p.id).replace(/\.[^.]+$/,'').replace(/[^\w\-]+/g,'_').slice(0,80) || p.id) + '.jpg';
async function fetchPhoto(p){ const r=await fetch('/api/file/p/'+p.id+'.jpg'); if(!r.ok) throw new Error('HTTP '+r.status); return await r.blob(); }
function saveBlob(blob, name){
  const u=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=u; a.download=name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),4000);
}
async function downloadOne(p){
  try{ saveBlob(await fetchPhoto(p), fname(p)); }
  catch(e){ toast('Không tải được ảnh: '+e.message); }
}
let zipping=false;
const zipLabel=t=>document.querySelectorAll('.ziplbl').forEach(e=>e.textContent=t);
onAct('zip',async()=>{
  if(zipping) return;
  const list=currentList(); if(!list.length) return;
  if(list.length>ZIP_MAX){ toast(`Đang có ${list.length.toLocaleString('vi-VN')} ảnh, quá nhiều để tải một lần. Hãy bấm "Tìm người" để lọc ảnh của bạn rồi tải.`,6000); return; }
  if(!await ask('Tải ảnh về máy?',`Tải ${list.length} ảnh đang hiển thị thành 1 file .zip.`,'Tải về')) return;
  if(!window.JSZip){ toast('Không tải được thư viện nén zip.'); return; }
  zipping=true;
  try{
    const zip=new JSZip(); let i=0;
    for(const p of list){ i++; zipLabel(`${i}/${list.length}`); zip.file(String(i).padStart(3,'0')+'_'+fname(p), await fetchPhoto(p)); }
    zipLabel('Đang nén');
    saveBlob(await zip.generateAsync({type:'blob'}), ((S.info.title||'album').replace(/[^\w\-]+/g,'_'))+(hasFilter()?'_anh-cua-toi':'')+'.zip');
  }catch(e){ toast('Không tạo được file zip: '+e.message); }
  zipping=false; zipLabel('Tải ảnh');
});

/* ---------------- xem ảnh toàn màn hình ---------------- */
function openLB(list,idx){ S.lbList=list; S.lbIdx=idx; $('#lb').classList.remove('hidden'); document.body.style.overflow='hidden'; showLB(); }
function closeLB(){ $('#lb').classList.add('hidden'); document.body.style.overflow=''; }
function showLB(){
  const p=S.lbList[S.lbIdx]; if(!p){ closeLB(); return; }
  const img=$('#lbImg'); img.src=fileUrl('t/'+p.id+'.jpg');
  const full=new Image(); full.src=fileUrl('p/'+p.id+'.jpg'); full.onload=()=>{ if(S.lbList[S.lbIdx]===p) img.src=full.src; };
  $('#lbCount').textContent=(S.lbIdx+1)+' / '+S.lbList.length;
  $('#lbCover').classList.toggle('hidden',!S.canEdit); $('#lbDelete').classList.toggle('hidden',!S.canEdit);
}
const step=d=>{ S.lbIdx=(S.lbIdx+d+S.lbList.length)%S.lbList.length; showLB(); };
$('#lbPrev').onclick=()=>step(-1); $('#lbNext').onclick=()=>step(1); $('#lbClose').onclick=closeLB;
$('#lbDownload').onclick=()=>downloadOne(S.lbList[S.lbIdx]);
document.addEventListener('keydown',e=>{
  if(!$('#lb').classList.contains('hidden')){ if(e.key==='Escape') closeLB(); if(e.key==='ArrowLeft') step(-1); if(e.key==='ArrowRight') step(1); return; }
  if(e.key==='Escape') document.querySelectorAll('.modal:not(.hidden)').forEach(m=>{ if(m.id!=='confirm' && !(m.id==='adminModal'&&S.busy)) m.classList.add('hidden'); });
});
let tx=null; $('#lb').addEventListener('touchstart',e=>tx=e.touches[0].clientX,{passive:true});
$('#lb').addEventListener('touchend',e=>{ if(tx==null) return; const dx=e.changedTouches[0].clientX-tx; if(Math.abs(dx)>50) step(dx<0?1:-1); tx=null; });
$('#lbCover').onclick=async()=>{
  const p=S.lbList[S.lbIdx]; const old=S.info.cover; S.info={...S.info,cover:p.id};
  try{ await saveIndex(); renderInfo(); toast('Đã đặt làm ảnh bìa'); }catch(e){ S.info.cover=old; toast('Lỗi: '+e.message); }
};
$('#lbDelete').onclick=async()=>{
  const p=S.lbList[S.lbIdx];
  if(!await ask('Xoá ảnh này?','Ảnh sẽ bị xoá vĩnh viễn khỏi album, khách không thấy nữa.','Xoá')) return;
  try{
    S.photos=S.photos.filter(x=>x.id!==p.id);
    if(S.info.cover===p.id) delete S.info.cover;
    await saveIndex();
    for(const k of ['p/'+p.id+'.jpg','t/'+p.id+'.jpg']) try{ await api('/api/file/'+k,{method:'DELETE'}); }catch(e){}
    const at=S.lbList.indexOf(p); if(at>=0) S.lbList.splice(at,1); if(S.lbIdx>=S.lbList.length) S.lbIdx=0;
    recompute(); renderAll(); showLB(); toast('Đã xoá ảnh');
  }catch(e){ toast('Không xoá được: '+e.message); }
};

/* ---------------- đăng nhập quản trị ---------------- */
function setAdmin(on){
  S.canEdit=on;
  $('#adminBtn').classList.toggle('hidden',!on);
  $('#loginLink').classList.toggle('hidden',on); $('#logoutLink').classList.toggle('hidden',!on);
  renderAll();
}
$('#loginLink').onclick=()=>{ $('#loginModal').classList.remove('hidden'); $('#pw').value=''; $('#loginLog').textContent=''; setTimeout(()=>$('#pw').focus(),50); };
$('#logoutLink').onclick=()=>{ S.pw=null; try{ sessionStorage.removeItem('album.pw'); }catch(e){} setAdmin(false); };
$('#loginForm').onsubmit=async e=>{
  e.preventDefault();
  const pw=$('#pw').value; if(!pw) return;
  $('#loginLog').textContent='Đang kiểm tra…';
  if(await tryLogin(pw)){ $('#loginModal').classList.add('hidden'); toast('Đã đăng nhập quản trị'); }
  else $('#loginLog').textContent='Sai mật khẩu';
};
async function tryLogin(pw){
  const prev=S.pw; S.pw=pw;
  try{ await api('/api/auth',{method:'POST'}); try{ sessionStorage.setItem('album.pw',pw); }catch(e){} setAdmin(true); return true; }
  catch(e){ S.pw=prev; return false; }
}

/* ---------------- quản lý album ---------------- */
function openAdmin(){
  const i=S.info||{};
  $('#fTitle').value=i.title||''; $('#fDate').value=i.date||''; $('#fPlace').value=i.place||'';
  $('#fEyebrow').value=i.eyebrow||''; $('#fBrand').value=i.brand||'';
  $('#driveHint').classList.toggle('hidden',S.hasDrive);
  renderStats(); renderLogoSlots(); $('#adminModal').classList.remove('hidden');
}
$('#adminBtn').onclick=openAdmin;
$('#saveInfo').onclick=async()=>{
  const old=S.info;
  S.info={...S.info,title:$('#fTitle').value.trim(),date:$('#fDate').value.trim(),place:$('#fPlace').value.trim(),eyebrow:$('#fEyebrow').value.trim(),brand:$('#fBrand').value.trim()};
  $('#infoLog').textContent='Đang lưu…';
  try{ await saveIndex(); $('#infoLog').textContent='Đã lưu'; renderInfo(); }
  catch(e){ S.info=old; $('#infoLog').textContent='Lỗi: '+e.message; }
};

/* logo */
const LOGO_HINT=['Logo 1 (VD: LB Global)','Logo 2 (VD: DERMAXILIC)','Biểu tượng tab'];
function renderLogoSlots(){
  const logos=S.info.logos||[];
  [0,1,2].forEach(k=>{
    const pv=$('#logoPv'+k); pv.textContent='';
    if(logos[k]){ const img=document.createElement('img'); img.src=fileUrl('l/'+logos[k]+'.png'); img.alt=''; pv.appendChild(img); }
    else pv.textContent=LOGO_HINT[k];
  });
}
async function setLogo(k, id){
  const logos=[...(S.info.logos||[])]; while(logos.length<3) logos.push(null);
  const old=logos[k]; logos[k]=id;
  const prev=S.info; S.info={...S.info,logos};
  try{ await saveIndex(); }catch(e){ S.info=prev; throw e; }
  if(old) api('/api/file/l/'+old+'.png',{method:'DELETE'}).catch(()=>{});
  renderBrand(); renderLogoSlots();
}
document.querySelectorAll('[data-logo]').forEach(inp=>inp.onchange=async()=>{
  const f=inp.files[0], k=+inp.dataset.logo; inp.value=''; if(!f) return;
  try{
    const bmp=await fileToBitmap(f);
    const blob=await canvasBlob(toCanvas(bmp,800),undefined,'image/png');
    const id=newId();
    await api('/api/file/l/'+id+'.png',{method:'PUT',headers:{'content-type':'image/png'},body:blob});
    await setLogo(k,id); toast('Đã cập nhật logo');
  }catch(e){ toast('Không tải được logo: '+e.message); }
});
document.querySelectorAll('[data-logo-del]').forEach(b=>b.onclick=async()=>{
  const k=+b.dataset.logoDel; if(!(S.info.logos||[])[k]) return;
  try{ await setLogo(k,null); toast('Đã gỡ logo'); }catch(e){ toast('Lỗi: '+e.message); }
});

/* thêm ảnh: từ máy tính hoặc Google Drive */
wireDrop($('#photoDrop'),$('#photoInput'),files=>ingest(fromFiles(files)));
$('#folderInput').onchange=e=>{ const f=[...e.target.files]; e.target.value=''; if(f.length) ingest(fromFiles(f)); };
$('#stopUpload').onclick=()=>{ S.stop=true; $('#upLog').textContent='Đang dừng sau ảnh hiện tại…'; };
window.addEventListener('beforeunload',e=>{ if(S.busy){ e.preventDefault(); e.returnValue=''; } });
const fromFiles = files => files.filter(f=>f.type.startsWith('image/')).map(f=>{ const parts=(f.webkitRelativePath||'').split('/');
  return {name:f.name,size:f.size,taken:f.lastModified||0,cat:parts.length>2?parts[1]:'',blob:async()=>f}; });

$('#driveBtn').onclick=async()=>{
  if(S.busy){ toast('Đang xử lý, chờ xong lượt này.'); return; }
  if(!S.hasDrive){ toast('Chưa đặt GOOGLE_API_KEY trên Cloudflare.'); return; }
  const v=$('#driveUrl').value.trim();
  const m=v.match(/folders\/([A-Za-z0-9_-]{10,})/) || v.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || v.match(/^([A-Za-z0-9_-]{20,})$/);
  if(!m){ toast('Hãy dán link thư mục Google Drive.'); return; }
  const log=$('#upLog'); const btn=$('#driveBtn'); btn.disabled=true;
  try{
    const queue=[{id:m[1],cat:''}], seen=new Set([m[1]]), files=[];
    while(queue.length){
      const {id:folder,cat}=queue.shift(); let token=null;
      do{
        log.textContent=`Đang đọc danh sách ảnh trên Drive… (${files.length})`;
        const d=await (await api('/api/drive/list?folder='+folder+(token?'&pageToken='+encodeURIComponent(token):''))).json();
        for(const f of d.files) files.push({...f,cat});
        for(const sub of d.folders) if(!seen.has(sub.id)){ seen.add(sub.id); queue.push({id:sub.id,cat:cat||sub.name}); }
        token=d.next;
      }while(token);
    }
    if(!files.length){ log.textContent='Không thấy ảnh nào. Kiểm tra thư mục đã để "Bất kỳ ai có đường liên kết" chưa.'; return; }
    btn.disabled=false; const orig=$('#origChk').checked;
    await ingest(files.map(f=>({name:f.name,size:+f.size||0,taken:Date.parse(f.modifiedTime)||0,cat:f.cat,
      blob:async()=>await (await api('/api/drive/img?id='+f.id+(orig?'&orig=1':''))).blob()})));
  }catch(e){ log.textContent='Không đọc được Drive: '+e.message; }
  finally{ btn.disabled=false; }
};

async function ingest(sources){
  if(S.busy){ toast('Đang xử lý, chờ xong lượt này.'); return; }
  if(!S.canEdit){ toast('Hãy đăng nhập quản trị trước.'); return; }
  const log=$('#upLog'), bar=$('#upBar');
  try{ await loadIndex(); }catch(e){ toast('Không đọc được album: '+e.message); return; }  // lấy bản mới nhất trước khi thêm
  const existing=new Set(S.photos.map(p=>p.name+'|'+p.osize));
  const todo=sources.filter(s=>!existing.has(s.name+'|'+s.size));
  const skipped=sources.length-todo.length;
  if(!todo.length){ log.textContent=`Tất cả ${sources.length} ảnh này đã có trong album.`; return; }
  S.busy=true; S.stop=false; $('#stopUpload').classList.remove('hidden'); bar.style.width='0';
  let done=0, faces=0, fails=0, pending=0, lastErr=''; const t0=Date.now(), deep=$('#deepChk').checked;
  try{ await loadModels(t=>log.textContent=t); }
  catch(e){ log.textContent='Không tải được mô hình AI: '+e.message; S.busy=false; $('#stopUpload').classList.add('hidden'); return; }
  const blobs=[]; const getBlob=i=>{ if(i>=todo.length) return null; if(!blobs[i]){ blobs[i]=todo[i].blob(); blobs[i].catch(()=>{}); } return blobs[i]; };
  for(let i=0;i<todo.length;i++){
    if(S.stop) break;
    const src=todo[i];
    try{
      const bp=getBlob(i); getBlob(i+1); getBlob(i+2);          // tải trước 2 ảnh kế tiếp
      const blob=await bp; blobs[i]=null;
      const bmp=await fileToBitmap(blob);
      const res=await scanFaces(bmp,deep);
      const bigC=toCanvas(bmp,2048), big=await canvasBlob(bigC,.86);
      const thC=toCanvas(bmp,720), th=await canvasBlob(thC,.8);
      bmp.close?.();
      const id=newId();
      await api('/api/file/p/'+id+'.jpg',{method:'PUT',headers:{'content-type':'image/jpeg'},body:big});
      await api('/api/file/t/'+id+'.jpg',{method:'PUT',headers:{'content-type':'image/jpeg'},body:th});
      const rec={ id, name:src.name, osize:src.size, w:thC.width, h:thC.height, bytes:big.size+th.size,
        at:Date.now(), taken:src.taken||0,
        f:res.map(r=>encodeFace(r.d)), b:res.map(r=>r.b), q:res.map(r=>r.q), g:res.map(()=>0), v:deep?2:1 };
      if(src.cat) rec.c=src.cat;
      rec._f=rec.f.map(decodeFace);
      S.photos.push(rec); faces+=res.length; pending++;
      if(pending>=SAVE_EVERY){ await saveIndex(); pending=0; }
    }catch(e){
      console.error(src.name,e); fails++; lastErr=e.message;
      if(e.status===401){ toast('Phiên quản trị hết hạn, đăng nhập lại.'); break; }
    }
    done++;
    const eta=Math.round((Date.now()-t0)/done*(todo.length-done)/1000);
    bar.style.width=(done/todo.length*100)+'%';
    log.textContent=`Đã xử lý ${done}/${todo.length} ảnh · ${faces} khuôn mặt${fails?` · ${fails} lỗi`:''}${done<todo.length?` · còn khoảng ${eta>90?Math.round(eta/60)+' phút':eta+' giây'}`:''}`;
    if(done%25===0){ S.photos.sort(byTime); renderAll(); }
  }
  try{ if(pending) await saveIndex(); }catch(e){ toast('Lưu danh sách ảnh bị lỗi: '+e.message); }
  S.photos.sort(byTime);
  const summary=`${done-fails} ảnh mới, ${faces} khuôn mặt${skipped?`, bỏ qua ${skipped} ảnh đã có`:''}${fails?`, ${fails} ảnh lỗi (${lastErr})`:''}`;
  try{ if(done-fails>0) await clusterFaces(t=>log.textContent=t); }catch(e){ console.error(e); toast('Gom nhóm khuôn mặt bị lỗi: '+e.message); }
  S.busy=false; $('#stopUpload').classList.add('hidden');
  recompute(); renderAll();
  log.textContent=`Xong: ${summary}. Đã gom được ${S.people.length} người.`;
  toast('Thêm ảnh xong');
}

/* ---------------- gom nhóm khuôn mặt ---------------- */
async function clusterFaces(onMsg){
  onMsg?.('Đang gom nhóm khuôn mặt…');
  const faces=[];
  for(const p of S.photos){
    p.g=new Array(p._f.length).fill(0);
    p._f.forEach((d,i)=>{ const b=p.b?.[i]; faces.push({p,i,d,a:b?b[2]*b[3]:0,q:p.q?.[i]??99}); });
  }
  faces.sort((x,y)=>(y.q-x.q)||(y.a-x.a));           // mặt to, rõ làm hạt giống trước
  const C=[];                                        // {sum,c,n,m:[face]}
  const add=(cl,f)=>{ cl.n++; for(let k=0;k<128;k++){ cl.sum[k]+=f.d[k]; cl.c[k]=cl.sum[k]/cl.n; } cl.m.push(f); };
  for(let n=0;n<faces.length;n++){
    const f=faces[n]; let best=null, bd=CLUSTER_T;
    for(const cl of C){ const d=dist(f.d,cl.c); if(d<bd){ bd=d; best=cl; } }
    if(!best){
      if(f.q<SEED_FACE) continue;                    // mặt quá nhỏ: không lập nhóm mới, lát nữa gán sau
      best={sum:new Float32Array(128),c:new Float32Array(128),n:0,m:[]}; C.push(best);
    }
    else if(f.q<SEED_FACE){ if(bd<0.42) best.m.push(f); continue; }   // mặt nhỏ: chỉ gán khi rất giống, không làm lệch tâm nhóm
    add(best,f);
    if(n%400===0){ onMsg?.(`Đang gom nhóm khuôn mặt… ${n}/${faces.length}`); await tick(); }
  }
  for(let pass=0;pass<3;pass++){                     // gộp các nhóm quá giống nhau
    let merged=false;
    for(let i=0;i<C.length;i++){
      if(!C[i]) continue;
      for(let j=i+1;j<C.length;j++){
        if(!C[j]) continue;
        if(dist(C[i].c,C[j].c)<MERGE_T){ for(const f of C[j].m) add(C[i],f); C[j]=null; merged=true; }
      }
      if(i%50===0) await tick();
    }
    if(!merged) break;
  }
  const groups=C.filter(Boolean).map(cl=>({cl,photos:new Set(cl.m.map(f=>f.p.id)).size}))
    .filter(x=>x.photos>=MIN_PHOTOS || x.cl.m.some(f=>f.q>=SOLO_FACE))   // người chỉ có 1 ảnh vẫn hiện nếu mặt to, rõ
    .sort((a,b)=>b.photos-a.photos).slice(0,MAX_PEOPLE);
  const oldAv=new Set(S.people.map(x=>x.av));
  const people=[];
  for(let k=0;k<groups.length;k++){
    const {cl}=groups[k], id=k+1;
    for(const f of cl.m) f.p.g[f.i]=id;
    const rep=cl.m.reduce((a,b)=>(b.q*1e6+b.a)>(a.q*1e6+a.a)?b:a);
    const av=`f/${rep.p.id}-${rep.i}.jpg`;
    if(!oldAv.has(av)){
      onMsg?.(`Đang tạo ảnh đại diện ${k+1}/${groups.length}…`);
      try{ await makeAvatar(rep,av); }catch(e){ console.warn('avatar',e); }
    }
    people.push({id,av});
  }
  const keep=new Set(people.map(x=>x.av));
  S.people=people;
  await saveIndex();
  for(const av of oldAv) if(!keep.has(av)) api('/api/file/'+av,{method:'DELETE'}).catch(()=>{});
  if(S.person && !people.some(x=>x.id===S.person)) S.person=null;
}
async function makeAvatar(face, key){
  const blob=await (await fetch('/api/file/p/'+face.p.id+'.jpg')).blob();
  const bmp=await createImageBitmap(blob);
  const b=face.p.b[face.i].map(v=>v/1000);
  const w=b[2]*bmp.width, h=b[3]*bmp.height, cx=b[0]*bmp.width+w/2, cy=b[1]*bmp.height+h/2;
  const side=Math.max(w,h)*1.7;
  const c=document.createElement('canvas'); c.width=c.height=160;
  const ctx=c.getContext('2d'); ctx.fillStyle='#fdeef3'; ctx.fillRect(0,0,160,160);
  ctx.drawImage(bmp,cx-side/2,cy-side/2-h*0.05,side,side,0,0,160,160);
  bmp.close?.();
  await api('/api/file/'+key,{method:'PUT',headers:{'content-type':'image/jpeg'},body:await canvasBlob(c,.85)});
}
$('#clusterBtn').onclick=async()=>{
  if(S.busy){ toast('Đang xử lý, chờ xong lượt này.'); return; }
  const log=$('#clusterLog'); S.busy=true; $('#clusterBtn').disabled=true;
  try{ await loadIndex(); await clusterFaces(t=>log.textContent=t); log.textContent=`Đã gom được ${S.people.length} người.`; }
  catch(e){ log.textContent='Lỗi: '+e.message; }
  S.busy=false; $('#clusterBtn').disabled=false; renderAll();
};

$('#stopRescan').onclick=()=>{ S.stop=true; };
$('#rescanBtn').onclick=async()=>{
  if(S.busy){ toast('Đang xử lý, chờ xong lượt này.'); return; }
  const log=$('#clusterLog');
  try{ await loadIndex(); }catch(e){ log.textContent='Lỗi: '+e.message; return; }
  const todo=S.photos.filter(p=>p.v!==2);
  if(!todo.length){ log.textContent='Tất cả ảnh đã được quét kỹ rồi.'; return; }
  if(!await ask('Quét lại khuôn mặt?',`Quét kỹ lại ${todo.length} ảnh đã có để bắt thêm mặt nhỏ. Mất khoảng 3–5 giây mỗi ảnh, cần giữ tab mở. Dừng giữa chừng thì lần sau chạy tiếp.`,'Bắt đầu')) return;
  S.busy=true; S.stop=false; $('#stopRescan').classList.remove('hidden'); $('#rescanBtn').disabled=true;
  let done=0, pending=0, fails=0; const t0=Date.now();
  try{
    await loadModels(t=>log.textContent=t);
    for(const p of todo){
      if(S.stop) break;
      try{
        const bmp=await createImageBitmap(await (await fetch('/api/file/p/'+p.id+'.jpg')).blob());
        const res=await scanFaces(bmp,true); bmp.close?.();
        p.f=res.map(r=>encodeFace(r.d)); p._f=p.f.map(decodeFace); p.b=res.map(r=>r.b); p.q=res.map(r=>r.q); p.g=res.map(()=>0); p.v=2;
        if(++pending>=SAVE_EVERY){ await saveIndex(); pending=0; }
      }catch(e){ console.error(p.id,e); fails++; if(e.status===401) break; }
      done++; const eta=Math.round((Date.now()-t0)/done*(todo.length-done)/1000);
      log.textContent=`Đã quét lại ${done}/${todo.length} ảnh${fails?` · ${fails} lỗi`:''} · còn khoảng ${eta>90?Math.round(eta/60)+' phút':eta+' giây'}`;
    }
    if(pending) await saveIndex();
    await clusterFaces(t=>log.textContent=t);
    log.textContent=`Đã quét lại ${done-fails} ảnh, gom được ${S.people.length} người.`;
  }catch(e){ log.textContent='Lỗi: '+e.message; }
  S.busy=false; $('#stopRescan').classList.add('hidden'); $('#rescanBtn').disabled=false; recompute(); renderAll();
};

$('#purgeBtn').onclick=async()=>{
  if(S.busy){ toast('Đang xử lý, chờ xong lượt này.'); return; }
  const log=$('#purgeLog');
  try{ await loadIndex(); }catch(e){ log.textContent='Lỗi: '+e.message; return; }
  const n=S.photos.length;
  if(!await ask('Xoá hết ảnh trong album?',`Toàn bộ ${n.toLocaleString('vi-VN')} ảnh cùng dữ liệu khuôn mặt sẽ bị xoá vĩnh viễn, không khôi phục được. Logo được giữ lại.`,'Xoá hết')) return;
  if(!await ask('Bạn chắc chắn chứ?','Khách đang xem album sẽ không còn thấy ảnh nào. Bấm "Xoá vĩnh viễn" để tiếp tục.','Xoá vĩnh viễn')) return;
  S.busy=true; $('#purgeBtn').disabled=true;
  try{
    log.textContent='Đang xoá danh sách ảnh…';
    S.photos=[]; S.people=[]; S.person=null; S.cat=null; S.matches.clear();
    S.info={logos:S.info.logos||[], brand:S.info.brand||''};
    await saveIndex(); renderAll(); showChip();
    let total=0;
    for(;;){
      const d=await (await api('/api/purge',{method:'POST'})).json();
      total+=d.deleted; log.textContent=`Đang xoá file ảnh… ${total.toLocaleString('vi-VN')} file`;
      if(d.done) break;
    }
    log.textContent=`Đã xoá xong ${n.toLocaleString('vi-VN')} ảnh. Album đang trống, hãy đặt tên sự kiện mới và thêm ảnh.`;
    $('#fTitle').value=''; $('#fDate').value=''; $('#fPlace').value=''; $('#fEyebrow').value=''; $('#upLog').textContent=''; $('#upBar').style.width='0';
    toast('Đã xoá hết ảnh');
  }catch(e){ log.textContent='Bị lỗi giữa chừng: '+e.message+'. Bấm lại nút để xoá tiếp.'; }
  S.busy=false; $('#purgeBtn').disabled=false; renderAll();
};

/* ---------------- khởi động ---------------- */
(async()=>{
  restoreSelfie();
  const note=$('#loadNote'); note.dataset.loading='1'; renderAll();
  try{
    const cfg=await (await fetch('/api/config')).json();
    S.publicUrl=cfg.publicUrl||''; S.hasDrive=!!cfg.hasDrive;
    await loadIndex();
    delete note.dataset.loading; note.textContent='';
  }catch(e){
    delete note.dataset.loading; note.textContent='Không tải được album: '+e.message;
  }
  let pw=null; try{ pw=sessionStorage.getItem('album.pw'); }catch(e){}
  if(pw) await tryLogin(pw);
  recompute(); showChip(); renderAll();
})();
