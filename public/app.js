// FindImageAI – logic trang album (chạy trên Cloudflare Worker + R2)
const $ = s => document.querySelector(s);
const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
const PAGE = 120;          // số ảnh hiển thị mỗi lần cuộn
const Q_SCALE = 300;       // lượng tử hoá vector khuôn mặt về Int8
const SAVE_EVERY = 10;     // lưu chỉ mục sau mỗi N ảnh khi tải lên

/* ---------------- state ---------------- */
const S = {
  publicUrl:'', pw:null, canEdit:false,
  info:{}, photos:[], tab:'all', shown:0,
  selfie:null, selfieUrl:null, threshold:0.52, matches:new Map(),
  lbList:[], lbIdx:0, uploading:false, stop:false,
};
const fileUrl = key => key ? (S.publicUrl ? S.publicUrl + '/' + key : '/api/file/' + key) : '';

/* ---------------- API ---------------- */
async function api(path, opts={}){
  const headers = {...(opts.headers||{})};
  if(S.pw) headers.authorization = 'Bearer ' + S.pw;
  const r = await fetch(path, {...opts, headers});
  if(!r.ok){
    let msg = r.status + '';
    try{ msg = (await r.json()).error || msg; }catch(e){}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return r;
}
async function loadIndex(){
  const r = await api('/api/index?t=' + Date.now());
  const d = await r.json();
  S.info = d.info || {};
  S.photos = (d.photos || []).map(p => ({...p, _f: (p.f||[]).map(decodeFace)}));
  S.photos.sort((a,b)=>(a.taken||a.at||0)-(b.taken||b.at||0));
}
async function saveIndex(){
  const out = { v:1, updatedAt: Date.now(), info: S.info,
    photos: S.photos.map(({_f, ...rest}) => rest) };
  await api('/api/index', {method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify(out)});
}

/* ---------------- face vector encode ---------------- */
function encodeFace(desc){
  const q = new Int8Array(128);
  for(let i=0;i<128;i++) q[i] = Math.max(-127, Math.min(127, Math.round(desc[i]*Q_SCALE)));
  let s=''; const u = new Uint8Array(q.buffer); for(const b of u) s += String.fromCharCode(b);
  return btoa(s);
}
function decodeFace(b64){
  const s = atob(b64); const q = new Int8Array(128);
  for(let i=0;i<128;i++){ const c = s.charCodeAt(i); q[i] = c>127 ? c-256 : c; }
  const f = new Float32Array(128); for(let i=0;i<128;i++) f[i] = q[i]/Q_SCALE;
  return f;
}
function dist(a,b){ let s=0; for(let i=0;i<128;i++){ const d=a[i]-b[i]; s+=d*d; } return Math.sqrt(s); }
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,10);

/* ---------------- toast / confirm ---------------- */
let toastT;
function toast(msg, ms=3200){ const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add('hidden'),ms); }
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
      onMsg?.('Đang tải mô hình AI (lần đầu ~12 MB)…');
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
const canvasBlob=(c,q=.85)=>new Promise(r=>c.toBlob(r,'image/jpeg',q));
async function detectAll(canvas, minConf=0.45){
  const opts=new faceapi.SsdMobilenetv1Options({minConfidence:minConf, maxResults:60});
  return await faceapi.detectAllFaces(canvas,opts).withFaceLandmarks().withFaceDescriptors();
}

/* ---------------- render ---------------- */
function renderInfo(){
  const i=S.info||{};
  $('#title').textContent = i.title || (S.canEdit ? 'Album chưa đặt tên' : 'Album ảnh');
  $('#eyebrow').textContent = i.eyebrow || 'Album ảnh sự kiện';
  $('#brandName').textContent = i.brand || 'ALBUM';
  $('#footBrand').textContent = i.brand || 'Album ảnh';
  document.title = (i.title ? i.title+' · ' : '') + 'Album ảnh';
  const setMeta=(id,v)=>{ const el=$(id); el.classList.toggle('hidden',!v); el.querySelector('b').textContent=v||''; };
  setMeta('#mDate', i.date); setMeta('#mPlace', i.place);
  const cover = i.cover || S.photos[0]?.id;
  $('#hero').classList.toggle('nocover', !cover);
  $('#heroBg').style.backgroundImage = cover ? `url("${fileUrl('p/'+cover+'.jpg')}")` : '';
  $('#mCount b').textContent = S.photos.length.toLocaleString('vi-VN')+' ảnh';
}
function currentList(){
  if(S.tab==='mine' && S.selfie)
    return S.photos.filter(p=>S.matches.has(p.id)).sort((a,b)=>S.matches.get(a.id)-S.matches.get(b.id));
  return S.photos;
}
function tile(p, list, idx){
  const d=document.createElement('div'); d.className='tile';
  const img=document.createElement('img'); img.loading='lazy'; img.decoding='async'; img.alt='';
  img.src=fileUrl('t/'+p.id+'.jpg');
  if(p.w&&p.h){ img.width=p.w; img.height=p.h; img.style.aspectRatio=p.w+'/'+p.h; }
  d.appendChild(img);
  if(S.tab==='mine' && S.matches.has(p.id)){
    const b=document.createElement('span'); b.className='badge';
    const dd=S.matches.get(p.id); b.textContent= dd<0.40?'Rất giống':dd<0.48?'Giống':'Có thể là bạn';
    d.appendChild(b);
  }
  const dl=document.createElement('button'); dl.className='dl'; dl.innerHTML=ICON_DL; dl.title='Tải ảnh';
  dl.onclick=e=>{ e.stopPropagation(); downloadOne(p); };
  d.appendChild(dl);
  d.onclick=()=>openLB(list,idx);
  return d;
}
function renderGrid(){
  const list=currentList();
  $('#nAll').textContent=S.photos.length.toLocaleString('vi-VN');
  $('#nMine').textContent=S.selfie ? S.matches.size : '–';
  $('#zipBtn').classList.toggle('hidden', !(S.tab==='mine' && S.selfie && S.matches.size));
  $('#grid').textContent=''; S.shown=0; renderMore();
  const empty=$('#empty');
  if(list.length || $('#loadNote').dataset.loading){ empty.classList.add('hidden'); return; }
  empty.classList.remove('hidden'); empty.textContent='';
  const h=document.createElement('h3'), p=document.createElement('p'); empty.append(h,p);
  const btn=(label,cls,fn)=>{ const b=document.createElement('button'); b.className='btn '+cls; b.textContent=label; b.onclick=fn; empty.appendChild(b); };
  if(S.tab==='mine' && !S.selfie){ h.textContent='Bạn chưa tìm ảnh'; p.textContent='Tải 1 ảnh selfie để AI lọc ra những ảnh có bạn.'; btn('Tìm ảnh bằng khuôn mặt','primary',openFace); }
  else if(S.tab==='mine'){ h.textContent='Chưa tìm thấy ảnh nào có bạn'; p.textContent='Thử một ảnh selfie khác rõ mặt hơn, hoặc nới độ khớp rộng hơn.'; btn('Thử lại','',openFace); }
  else if(S.canEdit){ h.textContent='Album đang trống'; p.textContent='Tải ảnh sự kiện lên, AI sẽ tự quét khuôn mặt để khách tìm ảnh của mình.'; btn('Tải ảnh lên','primary',openAdmin); }
  else { h.textContent='Album chưa có ảnh'; p.textContent='Ảnh sự kiện sẽ xuất hiện ở đây khi ban tổ chức tải lên.'; }
}
function renderMore(){
  const list=currentList(); if(S.shown>=list.length) return;
  const frag=document.createDocumentFragment();
  const end=Math.min(list.length, S.shown+PAGE);
  for(let i=S.shown;i<end;i++) frag.appendChild(tile(list[i],list,i));
  S.shown=end; $('#grid').appendChild(frag);
}
new IntersectionObserver(es=>{ if(es.some(e=>e.isIntersecting)) renderMore(); },{rootMargin:'1200px'}).observe($('#sentinel'));
function renderStats(){
  $('#sPhotos').textContent=S.photos.length.toLocaleString('vi-VN');
  $('#sFaces').textContent=S.photos.reduce((s,p)=>s+(p.f?.length||0),0).toLocaleString('vi-VN');
  $('#sSize').textContent=(S.photos.reduce((s,p)=>s+(p.bytes||0),0)/1073741824).toFixed(2)+' GB';
}
function renderAll(){ renderInfo(); renderGrid(); renderStats(); }

/* ---------------- tabs ---------------- */
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  if(t.dataset.tab==='mine' && !S.selfie){ openFace(); return; }
  setTab(t.dataset.tab);
});
function setTab(tab){
  S.tab=tab;
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x.dataset.tab===tab));
  renderGrid();
}
$('#viewAllBtn').onclick=()=>{ setTab('all'); $('#bar').scrollIntoView({behavior:'smooth'}); };

/* ---------------- so khớp ---------------- */
function recompute(){
  S.matches.clear(); if(!S.selfie) return;
  for(const p of S.photos){
    if(!p._f?.length) continue;
    let best=9; for(const f of p._f){ const d=dist(S.selfie,f); if(d<best) best=d; }
    if(best<=S.threshold) S.matches.set(p.id,best);
  }
}
const thName = v => v<0.47?'Chặt':v>0.56?'Rộng':'Cân bằng';
$('#th').oninput=e=>{
  S.threshold=+e.target.value; $('#thLabel').textContent=thName(S.threshold);
  recompute(); $('#thCount').textContent=S.matches.size+' ảnh'; renderGrid(); saveSelfie();
  $('#showMine').classList.toggle('hidden',!S.matches.size);
};
function saveSelfie(){
  try{
    if(S.selfie) localStorage.setItem('album.selfie',JSON.stringify({d:Array.from(S.selfie),t:S.threshold,u:S.selfieUrl}));
    else localStorage.removeItem('album.selfie');
  }catch(e){}
}
function restoreSelfie(){
  try{
    const v=JSON.parse(localStorage.getItem('album.selfie')||'null');
    if(v?.d?.length===128){ S.selfie=Float32Array.from(v.d); S.threshold=v.t||0.52; S.selfieUrl=v.u||null; $('#th').value=S.threshold; showChip(); }
  }catch(e){}
}
function showChip(){ $('#selfieChip').classList.toggle('hidden',!S.selfie); if(S.selfieUrl) $('#selfieChipImg').src=S.selfieUrl; }
$('#clearSelfie').onclick=()=>{ S.selfie=null; S.selfieUrl=null; S.matches.clear(); saveSelfie(); showChip(); setTab('all'); };

/* ---------------- tìm ảnh bằng khuôn mặt ---------------- */
function openFace(){
  $('#faceModal').classList.remove('hidden');
  $('#faceStep1').classList.remove('hidden'); $('#faceStep2').classList.add('hidden');
  loadModels().catch(()=>{});
}
$('#findBtnTop').onclick=openFace; $('#findBtnHero').onclick=openFace;
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('.modal').classList.add('hidden'));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m && m.id!=='confirm' && !(m.id==='adminModal'&&S.uploading)) m.classList.add('hidden'); }));
function wireDrop(el,input,handler){
  input.onchange=()=>{ if(input.files.length) handler([...input.files]); input.value=''; };
  el.addEventListener('dragover',e=>{e.preventDefault(); el.classList.add('over');});
  el.addEventListener('dragleave',()=>el.classList.remove('over'));
  el.addEventListener('drop',e=>{e.preventDefault(); el.classList.remove('over'); const f=[...e.dataTransfer.files].filter(f=>f.type.startsWith('image/')); if(f.length) handler(f);});
}
wireDrop($('#selfieDrop'),$('#selfieInput'),files=>runSelfie(files[0]));
$('#retrySelfie').onclick=()=>{ $('#faceStep1').classList.remove('hidden'); $('#faceStep2').classList.add('hidden'); };
$('#showMine').onclick=()=>{ $('#faceModal').classList.add('hidden'); setTab('mine'); $('#bar').scrollIntoView({behavior:'smooth'}); };

async function runSelfie(file){
  $('#faceStep1').classList.add('hidden');
  const s2=$('#faceStep2'); s2.classList.remove('hidden','done');
  $('#scanActions').classList.add('hidden'); $('#sliderWrap').classList.add('hidden');
  const msg=$('#scanMsg'); msg.textContent='Đang đọc ảnh…';
  try{
    const bmp=await fileToBitmap(file);
    $('#selfiePreview').src=toCanvas(bmp,200).toDataURL('image/jpeg',.8);
    await loadModels(t=>msg.textContent=t);
    msg.textContent='Đang nhận diện khuôn mặt…';
    const c=toCanvas(bmp,1024);
    const dets=await detectAll(c,0.4);
    if(!dets.length){
      s2.classList.add('done');
      msg.innerHTML='Không thấy khuôn mặt nào trong ảnh<small>Hãy dùng ảnh chụp thẳng, đủ sáng, mặt chiếm phần lớn khung hình.</small>';
      $('#scanActions').classList.remove('hidden'); $('#showMine').classList.add('hidden'); return;
    }
    dets.sort((a,b)=>b.detection.box.area-a.detection.box.area);
    const best=dets[0], bx=best.detection.box, pad=bx.width*.5;
    const fc=document.createElement('canvas'); fc.width=fc.height=200;
    fc.getContext('2d').drawImage(c,Math.max(0,bx.x-pad),Math.max(0,bx.y-pad),bx.width+pad*2,bx.height+pad*2,0,0,200,200);
    S.selfieUrl=fc.toDataURL('image/jpeg',.8); $('#selfiePreview').src=S.selfieUrl;
    S.selfie=best.descriptor;
    msg.textContent='Đang so khớp với '+S.photos.length.toLocaleString('vi-VN')+' ảnh…';
    await new Promise(r=>setTimeout(r,300));
    recompute(); saveSelfie(); showChip(); s2.classList.add('done');
    const n=S.matches.size;
    msg.innerHTML = n ? `Tìm thấy <span style="color:var(--accent)">${n}</span> ảnh có bạn 🎉<small>${dets.length>1?'Ảnh có nhiều người, AI chọn khuôn mặt lớn nhất. ':''}Kéo thanh bên dưới nếu thấy thiếu hoặc thừa ảnh.</small>`
                      : 'Chưa tìm thấy ảnh nào khớp<small>Thử nới độ khớp rộng hơn hoặc dùng ảnh selfie khác.</small>';
    $('#scanActions').classList.remove('hidden'); $('#showMine').classList.toggle('hidden',!n);
    $('#sliderWrap').classList.remove('hidden'); $('#thLabel').textContent=thName(S.threshold); $('#thCount').textContent=n+' ảnh';
    renderGrid();
  }catch(e){
    console.error(e); s2.classList.add('done');
    msg.innerHTML='Không chạy được AI trên trình duyệt này<small>Hãy thử Chrome/Safari bản mới, hoặc trên máy tính.</small>';
    $('#scanActions').classList.remove('hidden');
  }
}

/* ---------------- tải ảnh ---------------- */
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
$('#zipBtn').onclick=async()=>{
  const list=currentList(); if(!list.length) return;
  if(!window.JSZip){ toast('Không tải được thư viện nén zip.'); return; }
  const btn=$('#zipBtn'), lbl=btn.querySelector('.lbl'); btn.disabled=true;
  try{
    const zip=new JSZip(); let i=0;
    for(const p of list){ i++; lbl.textContent=`Đang gom ${i}/${list.length}…`; zip.file(String(i).padStart(3,'0')+'_'+fname(p), await fetchPhoto(p)); }
    lbl.textContent='Đang nén…';
    const blob=await zip.generateAsync({type:'blob'});
    saveBlob(blob, ((S.info.title||'album').replace(/[^\w\-]+/g,'_'))+'_anh-cua-toi.zip');
  }catch(e){ toast('Không tạo được file zip: '+e.message); }
  btn.disabled=false; lbl.textContent='Tải tất cả (.zip)';
};

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
document.addEventListener('keydown',e=>{ if($('#lb').classList.contains('hidden')) return; if(e.key==='Escape') closeLB(); if(e.key==='ArrowLeft') step(-1); if(e.key==='ArrowRight') step(1); });
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
    S.lbList.splice(S.lbIdx,1); if(S.lbIdx>=S.lbList.length) S.lbIdx=0;
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
  renderStats(); $('#adminModal').classList.remove('hidden');
}
$('#adminBtn').onclick=openAdmin;
$('#saveInfo').onclick=async()=>{
  const old=S.info;
  S.info={...S.info,title:$('#fTitle').value.trim(),date:$('#fDate').value.trim(),place:$('#fPlace').value.trim(),eyebrow:$('#fEyebrow').value.trim(),brand:$('#fBrand').value.trim()};
  $('#infoLog').textContent='Đang lưu…';
  try{ await saveIndex(); $('#infoLog').textContent='Đã lưu ✓'; renderInfo(); }
  catch(e){ S.info=old; $('#infoLog').textContent='Lỗi: '+e.message; }
};
wireDrop($('#photoDrop'),$('#photoInput'),uploadPhotos);
$('#folderInput').onchange=e=>{ const f=[...e.target.files].filter(f=>f.type.startsWith('image/')); e.target.value=''; if(f.length) uploadPhotos(f); };
$('#stopUpload').onclick=()=>{ S.stop=true; $('#upLog').textContent='Đang dừng sau ảnh hiện tại…'; };
window.addEventListener('beforeunload',e=>{ if(S.uploading){ e.preventDefault(); e.returnValue=''; } });

async function uploadPhotos(files){
  if(S.uploading){ toast('Đang tải lên, chờ xong lượt này.'); return; }
  if(!S.canEdit){ toast('Hãy đăng nhập quản trị trước.'); return; }
  files=files.filter(f=>f.type.startsWith('image/'));
  try{ await loadIndex(); }catch(e){ toast('Không đọc được album: '+e.message); return; }  // lấy bản mới nhất trước khi thêm
  const existing=new Set(S.photos.map(p=>p.name+'|'+p.osize));
  const todo=files.filter(f=>!existing.has(f.name+'|'+f.size));
  const skipped=files.length-todo.length;
  if(!todo.length){ toast('Các ảnh này đã có trong album.'); return; }
  S.uploading=true; S.stop=false; $('#stopUpload').classList.remove('hidden');
  const log=$('#upLog'), bar=$('#upBar');
  let done=0, faces=0, fails=0, pending=0; const t0=Date.now();
  try{ await loadModels(t=>log.textContent=t); }
  catch(e){ log.textContent='Không tải được mô hình AI: '+e.message; S.uploading=false; $('#stopUpload').classList.add('hidden'); return; }
  for(const f of todo){
    if(S.stop) break;
    try{
      const bmp=await fileToBitmap(f);
      const det=toCanvas(bmp,1600);
      const res=await detectAll(det,0.45);
      const bigC=toCanvas(bmp,2048), big=await canvasBlob(bigC,.86);
      const thC=toCanvas(bmp,720), th=await canvasBlob(thC,.8);
      bmp.close?.();
      const id=newId();
      await api('/api/file/p/'+id+'.jpg',{method:'PUT',headers:{'content-type':'image/jpeg'},body:big});
      await api('/api/file/t/'+id+'.jpg',{method:'PUT',headers:{'content-type':'image/jpeg'},body:th});
      const rec={ id, name:f.name, osize:f.size, w:thC.width, h:thC.height, bytes:big.size+th.size,
        at:Date.now(), taken:f.lastModified||0, f:res.map(r=>encodeFace(r.descriptor)) };
      rec._f=rec.f.map(decodeFace);
      S.photos.push(rec); faces+=res.length; pending++;
      if(pending>=SAVE_EVERY){ await saveIndex(); pending=0; }
    }catch(e){
      console.error(f.name,e); fails++;
      if(e.status===401){ toast('Phiên quản trị hết hạn, đăng nhập lại.'); break; }
    }
    done++;
    const eta=Math.round((Date.now()-t0)/done*(todo.length-done)/1000);
    bar.style.width=(done/todo.length*100)+'%';
    log.textContent=`Đã xử lý ${done}/${todo.length} ảnh · ${faces} khuôn mặt${fails?` · ${fails} lỗi`:''}${done<todo.length?` · còn ~${eta>60?Math.round(eta/60)+' phút':eta+' giây'}`:''}`;
    if(done%25===0){ S.photos.sort((a,b)=>(a.taken||a.at)-(b.taken||b.at)); recompute(); renderAll(); }
  }
  try{ if(pending) await saveIndex(); }catch(e){ toast('Lưu danh sách ảnh bị lỗi: '+e.message+'. Bấm tải lại lần nữa để thử lại.'); }
  S.uploading=false; $('#stopUpload').classList.add('hidden');
  S.photos.sort((a,b)=>(a.taken||a.at)-(b.taken||b.at)); recompute(); renderAll();
  log.textContent=`Xong: ${done-fails} ảnh mới, ${faces} khuôn mặt${skipped?`, bỏ qua ${skipped} ảnh trùng`:''}${fails?`, ${fails} ảnh lỗi`:''}.`;
  toast('Tải ảnh lên xong ✓');
}

/* ---------------- khởi động ---------------- */
(async()=>{
  restoreSelfie();
  const note=$('#loadNote'); note.dataset.loading='1'; renderAll();
  try{
    const cfg=await (await fetch('/api/config')).json();
    S.publicUrl=cfg.publicUrl||'';
    if(!cfg.hasPassword) $('#loginLink').title='Chưa đặt ADMIN_PASSWORD trên Cloudflare';
    await loadIndex();
    delete note.dataset.loading; note.textContent='';
  }catch(e){
    delete note.dataset.loading; note.textContent='Không tải được album: '+e.message;
  }
  let pw=null; try{ pw=sessionStorage.getItem('album.pw'); }catch(e){}
  if(pw) await tryLogin(pw);
  recompute(); renderAll();
})();
