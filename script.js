const API_URL = "https://script.google.com/macros/s/AKfycbzsVUudEB169aaXav19C7tNPTL6RpPNqQv5E_o6Bn368zbAgetT4L2N7ZZwjA4WTTcv/exec";

let state = { user:null, activity:null, locations:[], dashboardActivities:[], courierTasks:{pendingDeparture:null,confirmations:[],history:[]} };
let sessionExpiryTimer = null;
// Sesi tidak memiliki batas waktu. Session tetap aktif sampai user logout manual.
const SESSION_LIMIT = null;
const SESSION_KEY = "aktivitasKurirSession";
const SESSION_FALLBACK_KEY = "aktivitasKurirSessionTab";
const $ = id => document.getElementById(id);

// V69 — tampilan Dashboard/Report dan filter Report diperbarui tanpa mengubah alur sesi.
// Sesi dibuat sederhana seperti aplikasi Transport Schedule yang sudah terbukti stabil.
// LocalStorage tidak hilang saat tab/browser ditutup. Sesi hanya dihapus saat logout manual.
function parseStoredSession(raw){
  try{
    if(!raw)return null;
    const saved=JSON.parse(raw);
    if(!saved || !saved.user || !saved.loginAt)return null;
    if(!Number.isFinite(Number(saved.loginAt)))return null;
    return saved;
  }catch(e){return null;}
}

function readSession(){
  // localStorage keeps the login across normal reloads; sessionStorage is a
  // same-tab fallback so an Incognito tab can still restore after refresh if
  // persistent storage is restricted by the browser.
  try{
    const saved=parseStoredSession(localStorage.getItem(SESSION_KEY));
    if(saved)return saved;
  }catch(e){}
  try{
    return parseStoredSession(sessionStorage.getItem(SESSION_FALLBACK_KEY));
  }catch(e){return null;}
}

function writeSession(saved){
  const raw=JSON.stringify(saved);
  try{localStorage.setItem(SESSION_KEY,raw);}catch(e){}
  try{sessionStorage.setItem(SESSION_FALLBACK_KEY,raw);}catch(e){}
}

function removeStoredSession(){
  try{localStorage.removeItem(SESSION_KEY);}catch(e){}
  try{sessionStorage.removeItem(SESSION_FALLBACK_KEY);}catch(e){}
}

const msg = (id,text="") => { if($(id)) $(id).textContent=text; };

async function api(action,payload={}){
  const res=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action,...payload})});
  const raw=await res.json();

  // Kompatibel dengan respons API yang memakai {ok:true,...} maupun {success:true,...}.
  if(raw && (raw.ok===false || raw.success===false)){
    throw new Error(raw.message||raw.error||"Terjadi kendala. Coba lagi.");
  }

  // Beberapa versi Web API membungkus payload di dalam properti "data".
  // Buka satu lapis wrapper supaya frontend tetap membaca format yang sama.
  if(raw && raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)){
    return Object.assign({},raw,raw.data);
  }

  return raw;
}

function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    if(!file)return resolve(null);
    const reader=new FileReader();
    reader.onload=()=>resolve({name:file.name,mimeType:file.type,base64:reader.result.split(",")[1]});
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}

// V8 — draft form disimpan terpisah dari session login.
// Teks disimpan di localStorage; foto disimpan di IndexedDB agar tidak bergantung
// pada quota localStorage dan tetap tersedia setelah refresh di tab Incognito yang sama.
const ACTIVITY_DRAFT_PREFIX = "aktivitasKurirDraft:";
const ACTIVITY_DRAFT_DB = "aktivitasKurirDraftDB";
const ACTIVITY_DRAFT_STORE = "files";

function activityDraftKey(){
  return `${ACTIVITY_DRAFT_PREFIX}${state.user?.id||"guest"}`;
}

function readActivityDraft(){
  try{
    const raw=localStorage.getItem(activityDraftKey());
    if(!raw)return null;
    const draft=JSON.parse(raw);
    return draft&&typeof draft==="object"?draft:null;
  }catch(e){return null;}
}

function writeActivityDraft(patch={}){
  try{
    const current=readActivityDraft()||{};
    localStorage.setItem(activityDraftKey(),JSON.stringify({...current,...patch,updatedAt:Date.now()}));
  }catch(e){}
}

function clearActivityDraft(){
  try{localStorage.removeItem(activityDraftKey());}catch(e){}
  if(!window.indexedDB)return;
  const request=indexedDB.open(ACTIVITY_DRAFT_DB,1);
  request.onupgradeneeded=()=>{
    if(!request.result.objectStoreNames.contains(ACTIVITY_DRAFT_STORE))request.result.createObjectStore(ACTIVITY_DRAFT_STORE);
  };
  request.onsuccess=()=>{
    try{
      const db=request.result;
      const tx=db.transaction(ACTIVITY_DRAFT_STORE,"readwrite");
      tx.objectStore(ACTIVITY_DRAFT_STORE).delete(activityDraftKey());
      tx.oncomplete=()=>db.close();
    }catch(e){}
  };
}

function saveDraftFile(inputId){
  const input=$(inputId);
  const file=input?.files?.[0];
  if(!file)return;
  if(!window.indexedDB)return;
  const request=indexedDB.open(ACTIVITY_DRAFT_DB,1);
  request.onupgradeneeded=()=>{
    if(!request.result.objectStoreNames.contains(ACTIVITY_DRAFT_STORE))request.result.createObjectStore(ACTIVITY_DRAFT_STORE);
  };
  request.onsuccess=()=>{
    try{
      const db=request.result;
      const tx=db.transaction(ACTIVITY_DRAFT_STORE,"readwrite");
      tx.objectStore(ACTIVITY_DRAFT_STORE).put({blob:file,name:file.name,type:file.type,lastModified:file.lastModified},`${activityDraftKey()}:${inputId}`);
      tx.oncomplete=()=>db.close();
    }catch(e){}
  };
  const labelId=inputId==="fotoDokumen"?"fotoDokumenDraft":"fotoBerangkatDraft";
  if($(labelId))$(labelId).textContent=`Foto tersimpan sementara: ${file.name}`;
  writeActivityDraft({[`${inputId}Name`]:file.name});
}

function loadDraftFile(inputId){
  return new Promise(resolve=>{
    if(!window.indexedDB)return resolve(null);
    const request=indexedDB.open(ACTIVITY_DRAFT_DB,1);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(ACTIVITY_DRAFT_STORE))request.result.createObjectStore(ACTIVITY_DRAFT_STORE);
    };
    request.onerror=()=>resolve(null);
    request.onsuccess=()=>{
      try{
        const db=request.result;
        const tx=db.transaction(ACTIVITY_DRAFT_STORE,"readonly");
        const get=tx.objectStore(ACTIVITY_DRAFT_STORE).get(`${activityDraftKey()}:${inputId}`);
        get.onsuccess=()=>{
          const value=get.result||null;
          db.close();
          resolve(value);
        };
        get.onerror=()=>{db.close();resolve(null);};
      }catch(e){resolve(null);}
    };
  });
}

async function restoreActivityDraft(){
  if(!state.user||state.user.peran!=="Kurir")return;
  if(state.activity)return;
  const draft=readActivityDraft();
  if(!draft)return;

  if(draft.jenisTugas!==undefined){
    const selected=Array.isArray(draft.jenisTugas)?draft.jenisTugas:String(draft.jenisTugas||"").split("|").map(v=>v.trim()).filter(Boolean);
    document.querySelectorAll('#jenisTugasGroup input[name="jenisTugas"]').forEach(cb=>cb.checked=selected.includes(cb.value));
  }
  if(draft.asal!==undefined)$('asalSearch').value=draft.asal||"";
  if(draft.tujuan!==undefined)$('tujuanSearch').value=draft.tujuan||"";

  const dok=await loadDraftFile("fotoDokumen");
  const ber=await loadDraftFile("fotoBerangkat");
  if(dok?.name&&$("fotoDokumenDraft"))$("fotoDokumenDraft").textContent=`Foto dokumen tersimpan sementara: ${dok.name}`;
  if(ber?.name&&$("fotoBerangkatDraft"))$("fotoBerangkatDraft").textContent=`Foto saat berangkat tersimpan sementara: ${ber.name}`;
  checkStart();
}

async function getDraftOrSelectedFile(inputId){
  const selected=$(inputId)?.files?.[0];
  if(selected)return selected;
  const saved=await loadDraftFile(inputId);
  if(!saved?.blob)return null;
  return new File([saved.blob],saved.name||"foto.jpg",{type:saved.type||saved.blob.type||"image/jpeg",lastModified:saved.lastModified||Date.now()});
}

function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}

function clearSession(){
  if(sessionExpiryTimer){clearTimeout(sessionExpiryTimer);sessionExpiryTimer=null;}
  removeStoredSession();
  state={user:null,activity:null,locations:[],dashboardActivities:[],courierTasks:{pendingDeparture:null,confirmations:[],history:[]}};
}

function logoutToLogin(message=""){
  if(state.user)clearActivityDraft();
  clearSession();
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("loginForm").reset();
  if($("activityForm"))$("activityForm").reset();
  if($("userForm"))$("userForm").reset();
  msg("loginMsg",message);
}

function scheduleSessionExpiry(loginAt){
  if(sessionExpiryTimer)clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer=null;
}

function checkSessionExpiry(){
  const saved=readSession();
  if(!saved)return true;
  scheduleSessionExpiry(saved.loginAt);
  return true;
}

function setView(view){
  ["courierView","confirmationView","historyView","dashboardView","reportView","usersView"].forEach(id=>$(id).classList.add("hidden"));
  $(view).classList.remove("hidden");
  ["navActivity","navConfirm","navHistory","navDashboard","navReport","navUsers"].forEach(id=>$(id).classList.remove("active"));
  const nav={courierView:"navActivity",confirmationView:"navConfirm",historyView:"navHistory",dashboardView:"navDashboard",reportView:"navReport",usersView:"navUsers"}[view];
  if(nav)$(nav).classList.add("active");
  if(state.user){
    try{
      const saved=readSession();
      if(saved){saved.lastView=view;writeSession(saved);}
    }catch(e){}
  }
}

function setupNav(role){
  $("nav").classList.remove("hidden");
  const isCourier=role==="Kurir";
  $("navActivity").classList.toggle("hidden",!isCourier);
  $("navConfirm").classList.toggle("hidden",!isCourier);
  $("navHistory").classList.toggle("hidden",!isCourier);
  $("navDashboard").classList.toggle("hidden",role!=="Admin"&&role!=="Super User");
  $("navReport").classList.toggle("hidden",role!=="Admin"&&role!=="Super User");
  $("navUsers").classList.toggle("hidden",role!=="Super User");
  $("navActivity").onclick=async()=>{setView("courierView");await loadCourierTasks();await restoreActivityDraft();};
  $("navConfirm").onclick=async()=>{setView("confirmationView");await loadCourierTasks();};
  $("navHistory").onclick=async()=>{setView("historyView");await loadCourierTasks();};
  $("navDashboard").onclick=async()=>{setView("dashboardView");setDashboardDefaultDay();await loadDashboard();requestAnimationFrame(syncDashboardFreeze);};
  $("navReport").onclick=async()=>{setView("reportView");renderReport([]);await loadReportOptions();await loadReport();};
  $("navUsers").onclick=async()=>{setView("usersView");await loadUsers();};
}

function setupCombo(inputId,listId){
  const input=$(inputId),list=$(listId);
  const render=()=>{
    const q=input.value.trim().toLowerCase();
    const items=state.locations.filter(x=>x.toLowerCase().includes(q));
    list.innerHTML=items.length?items.map(x=>`<div class="combo-option" data-value="${escapeHtml(x)}">${escapeHtml(x)}</div>`).join(""):"<div class='combo-empty'>Lokasi tidak ditemukan.</div>";
    list.classList.remove("hidden");
    list.querySelectorAll(".combo-option").forEach(el=>el.onclick=()=>{input.value=el.dataset.value;list.classList.add("hidden");checkStart();});
  };
  input.addEventListener("focus",render);input.addEventListener("input",render);
  

document.addEventListener("click",e=>{if(!list.contains(e.target)&&e.target!==input)list.classList.add("hidden");});
}

async function loadLocations(){const data=await api("getLocations");state.locations=data.locations||[];}

async function loadCourierTasks(){
  try{
    const data=await api("getCourierTasks",{idPengguna:state.user.id});
    state.courierTasks={
      pendingDeparture:data.pendingDeparture||null,
      confirmations:Array.isArray(data.confirmations)?data.confirmations:[],
      history:Array.isArray(data.history)?data.history:[]
    };
    renderPendingDeparture();
    renderConfirmations();
    renderHistory();
    updateCourierNavBadges();
    return state.courierTasks;
  }catch(err){
    msg("activityMsg",err.message);
    return state.courierTasks;
  }
}

function updateCourierNavBadges(){
  const count=(state.courierTasks.confirmations||[]).length;
  const nav=$("navConfirm");
  if(nav)nav.textContent=count?`Konfirmasi Tugas (${count})`:"Konfirmasi Tugas";
}

function courierInfoHtml(a,includeStatus=true){
  const status=includeStatus?`<div class="info-item"><span>Status</span><strong>${escapeHtml(a.status||"-")}</strong></div>`:"";
  return `<div class="info-item"><span>Trip</span><strong>${escapeHtml(a.trip||"-")}</strong></div>
  <div class="info-item"><span>Jenis Tugas</span><strong>${escapeHtml(a.jenisTugas||a.pekerjaan||"-")}</strong></div>
  <div class="info-item"><span>Rute</span><strong>${escapeHtml((a.asal||"-")+" → "+(a.tujuan||"-"))}</strong></div>
  <div class="info-item"><span>Berangkat</span><strong>${escapeHtml(displayIndonesiaDateTime(a.waktuBerangkat))}</strong></div>
  <div class="info-item"><span>Datang</span><strong>${escapeHtml(displayIndonesiaDateTime(a.waktuDatang))}</strong></div>${status}`;
}

function renderPendingDeparture(){
  const a=state.courierTasks.pendingDeparture;
  const card=$("pendingDepartureCard");
  const form=$("activityCard");
  if(!a){card.classList.add("hidden");form.classList.remove("hidden");return;}
  card.classList.remove("hidden");form.classList.add("hidden");
  $("pendingDepartureInfo").innerHTML=courierInfoHtml(a,false);
  $("pendingDepartureMsg").textContent="";
  const ready=!!(a.fotoDokumen&&a.fotoBerangkat);
  $("pendingDepartureBtn").disabled=!ready;
  if(!ready) $("pendingDepartureMsg").textContent="Tugas belum lengkap karena foto dokumen atau foto berangkat belum tersedia.";
}

function renderConfirmations(){
  const rows=state.courierTasks.confirmations||[];
  const list=$("confirmationList");
  if(!list)return;
  $("confirmationEmpty").classList.toggle("hidden",rows.length>0);
  list.innerHTML=rows.map(a=>{
    const arrivalNeeded=a.status==="Lagi Jalan";
    const safeId=escapeHtml(a.idAktivitas||"");
    if(arrivalNeeded){
      return `<div class="card courier-task-card">
        <div class="section-title-row"><div><div class="section-title">${escapeHtml(a.jenisTugas||a.pekerjaan||"Tugas")}</div><div class="muted small">${safeId}</div></div><span class="badge">${escapeHtml(a.status||"")}</span></div>
        <div class="info-grid">${courierInfoHtml(a)}</div>
        <div class="confirm-action">
          <div class="muted small"><strong>Langkah 2 dari 3:</strong> konfirmasi kedatangan dengan mengunggah foto saat tiba.</div>
          <label>Foto Saat Datang <span class="required-mark">*</span>
            <input class="task-arrival-photo" data-id="${safeId}" type="file" accept="image/*" capture="environment" required>
          </label>
          <button class="primary confirm-arrival-task" data-id="${safeId}" type="button" disabled>Konfirmasi Datang</button>
          <p class="message" id="confirmMsg-${safeId}"></p>
        </div>
      </div>`;
    }
    const resultReady=!!a.hasil;
    const noteReady=!!String(a.keterangan||"").trim();
    const completeReady=resultReady&&noteReady;
    return `<div class="card courier-task-card">
      <div class="section-title-row"><div><div class="section-title">${escapeHtml(a.jenisTugas||a.pekerjaan||"Tugas")}</div><div class="muted small">${safeId}</div></div><span class="badge">${escapeHtml(a.status||"")}</span></div>
      <div class="info-grid">${courierInfoHtml(a)}</div>
      <div class="confirm-action">
        <div class="muted small"><strong>Langkah 3 dari 3:</strong> lengkapi hasil tugas sebelum menutup tugas.</div>
        <label>Hasil <span class="required-mark">*</span><select class="task-result" data-id="${safeId}" required><option value="">Pilih hasil tugas</option><option ${a.hasil==="Berhasil"?"selected":""}>Berhasil</option><option ${a.hasil==="Sebagian Berhasil"?"selected":""}>Sebagian Berhasil</option><option ${a.hasil==="Tidak Berhasil"?"selected":""}>Tidak Berhasil</option></select></label>
        <label>Keterangan <span class="required-mark">*</span><textarea class="task-note" data-id="${safeId}" rows="3" placeholder="Tulis keterangan hasil tugas..." required>${escapeHtml(a.keterangan||"")}</textarea></label>
        <button class="primary complete-task" data-id="${safeId}" type="button" ${completeReady?"":"disabled"}>Konfirmasi Selesai</button>
        <p class="message" id="confirmMsg-${safeId}"></p>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".task-arrival-photo").forEach(input=>{
    input.addEventListener("change",()=>{
      const btn=list.querySelector(`.confirm-arrival-task[data-id="${CSS.escape(input.dataset.id)}"]`);
      if(btn)btn.disabled=!input.files[0];
    });
  });
  list.querySelectorAll(".confirm-arrival-task").forEach(btn=>btn.onclick=()=>handleCourierArrival(btn.dataset.id,btn));

  list.querySelectorAll(".task-result, .task-note").forEach(el=>el.addEventListener("input",()=>{
    const id=el.dataset.id;
    const result=list.querySelector(`.task-result[data-id="${CSS.escape(id)}"]`)?.value.trim()||"";
    const note=list.querySelector(`.task-note[data-id="${CSS.escape(id)}"]`)?.value.trim()||"";
    const btn=list.querySelector(`.complete-task[data-id="${CSS.escape(id)}"]`);
    if(btn)btn.disabled=!(result&&note);
  }));
  list.querySelectorAll(".complete-task").forEach(btn=>btn.onclick=()=>handleCourierComplete(btn.dataset.id,btn));
}

function renderHistory(){
  const rows=state.courierTasks.history||[];
  const list=$("historyList");
  if(!list)return;
  $("historyEmpty").classList.toggle("hidden",rows.length>0);
  list.innerHTML=rows.map(a=>`<div class="card courier-task-card history-task-card"><div class="section-title-row"><div><div class="section-title">${escapeHtml(a.jenisTugas||a.pekerjaan||"Tugas")}</div><div class="muted small">${escapeHtml(a.idAktivitas||"")}</div></div><span class="badge">Selesai</span></div><div class="info-grid">${courierInfoHtml(a)}<div class="info-item"><span>Hasil</span><strong>${escapeHtml(a.hasil||"-")}</strong></div><div class="info-item"><span>Waktu Selesai</span><strong>${escapeHtml(displayIndonesiaDateTime(a.waktuSelsai))}</strong></div><div class="info-item"><span>Keterangan</span><strong>${escapeHtml(a.keterangan||"-")}</strong></div></div></div>`).join("");
}

async function handlePendingDeparture(){
  const a=state.courierTasks.pendingDeparture;
  if(!a)return;
  const btn=$("pendingDepartureBtn");btn.disabled=true;msg("pendingDepartureMsg","Mencatat keberangkatan...");
  try{
    const data=await api("confirmDeparture",{idAktivitas:a.idAktivitas,idPengguna:state.user.id});
    msg("pendingDepartureMsg","");
    await loadCourierTasks();
    setView("confirmationView");
  }catch(err){msg("pendingDepartureMsg",err.message);btn.disabled=false;}
}

async function handleCourierArrival(id,btn){
  const input=document.querySelector(`.task-arrival-photo[data-id="${CSS.escape(id)}"]`);
  if(!input?.files[0]){msg(`confirmMsg-${id}`,"Foto saat datang wajib diunggah terlebih dahulu.");return;}

  // Setelah konfirmasi 2/3 dikirim, sembunyikan card 2/3 terlebih dahulu.
  // Card 3/3 baru dibuat ulang setelah backend mengonfirmasi status "Lagi Diproses".
  const card=btn.closest('.courier-task-card');
  btn.disabled=true;
  msg(`confirmMsg-${id}`,"Menyimpan foto saat tiba...");
  if(card) card.classList.add('hidden');

  try{
    await api("confirmArrival",{idAktivitas:id,idPengguna:state.user.id,fotoDatang:await fileToBase64(input.files[0])});
    await loadCourierTasks();
    setView("confirmationView");
  }catch(err){
    if(card) card.classList.remove('hidden');
    msg(`confirmMsg-${id}`,err.message);
    btn.disabled=false;
  }
}

async function handleCourierComplete(id,btn){
  const resultEl=document.querySelector(`.task-result[data-id="${CSS.escape(id)}"]`);
  const noteEl=document.querySelector(`.task-note[data-id="${CSS.escape(id)}"]`);
  const hasil=resultEl?.value||"";
  if(!hasil){msg(`confirmMsg-${id}`,"Pilih hasil tugas tugas terlebih dahulu.");return;}
  btn.disabled=true;msg(`confirmMsg-${id}`,"Menyelesaikan tugas...");
  try{
    await api("completeTask",{idAktivitas:id,idPengguna:state.user.id,hasil,keterangan:noteEl?.value.trim()||""});
    await loadCourierTasks();
    setView("confirmationView");
  }catch(err){msg(`confirmMsg-${id}`,err.message);btn.disabled=false;}
}

function getSelectedJenisTugas(){
  return Array.from(document.querySelectorAll('#jenisTugasGroup input[name="jenisTugas"]:checked')).map(cb=>cb.value);
}

async function checkStart(){
  const dokumenFile=$('fotoDokumen').files[0] || await loadDraftFile("fotoDokumen");
  const berangkatFile=$('fotoBerangkat').files[0] || await loadDraftFile("fotoBerangkat");
  const ready=!!(getSelectedJenisTugas().length&&state.locations.includes($('asalSearch').value.trim())&&state.locations.includes($('tujuanSearch').value.trim())&&dokumenFile&&berangkatFile);
  $('startBtn').disabled=!ready;
}

function resetCourierCards(clearDraft=false){
  $("activityCard").classList.remove("hidden");
  $("activeCard").classList.add("hidden");
  $("resultCard").classList.add("hidden");
  $("activityForm").reset();
  $("startBtn").disabled=true;
  if($("fotoDokumenDraft"))$("fotoDokumenDraft").textContent="";
  if($("fotoBerangkatDraft"))$("fotoBerangkatDraft").textContent="";
  if(clearDraft)clearActivityDraft();
  msg("activityMsg","");msg("arrivalMsg","");msg("resultMsg","");
  state.activity=null;
}

function showActivityInfo(activity){
  $("activeInfo").innerHTML=`<div class="info-item"><span>Tipe Tugas</span><strong>${escapeHtml(activity.jenisTugas)}</strong></div><div class="info-item"><span>Rute</span><strong>${escapeHtml(activity.asal)} → ${escapeHtml(activity.tujuan)}</strong></div><div class="info-item"><span>Berangkat</span><strong>${escapeHtml(displayIndonesiaDateTime(activity.waktuBerangkat))}</strong></div><div class="info-item"><span>Status</span><strong>${escapeHtml(activity.status)}</strong></div>`;
  $("activeStatus").textContent=activity.status;
}

function showActiveState(activity){
  state.activity=activity;
  $("activityCard").classList.toggle("hidden",activity.status!=="Selesai");
  $("activeCard").classList.toggle("hidden",activity.status!=="Lagi Jalan");
  $("resultCard").classList.toggle("hidden",activity.status!=="Lagi Diproses");
  if(activity.status==="Lagi Jalan")showActivityInfo(activity);
  if(activity.status==="Lagi Diproses"){
    showActivityInfo(activity);
    $("activeCard").classList.add("hidden");
    $("resultCard").classList.remove("hidden");
    $("resultStatus").textContent=activity.status;
    $("arrivalTime").textContent=`Sampai: ${displayIndonesiaDateTime(activity.waktuDatang)}`;
  }
}

function setWelcome(name){
  const hour = new Date().getHours();
  let greeting = "Selamat malam";
  let emoji = "🌙";
  if(hour >= 5 && hour < 11){ greeting = "Selamat pagi"; emoji = "☀️"; }
  else if(hour >= 11 && hour < 15){ greeting = "Selamat siang"; emoji = "🌤️"; }
  else if(hour >= 15 && hour < 18){ greeting = "Selamat sore"; emoji = "🌤️"; }
  $("welcomeName").innerHTML = `<span class="greeting-text">${escapeHtml(greeting)} ${emoji}</span><span class="welcome-user">${escapeHtml(name)}</span>`;
}

async function restoreSession(){
  const saved=readSession();
  if(!saved)return false;


  state.user=saved.user;
  scheduleSessionExpiry(saved.loginAt);
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  setWelcome(state.user.nama);
  setupNav(state.user.peran);

  const lastView=saved.lastView || (state.user.peran==="Kurir"?"courierView":"dashboardView");

  // Error API tidak menghapus sesi. User tetap masuk dan bisa lanjut lagi.
  try{
    if(state.user.peran==="Kurir"){
      await loadLocations();
      if(lastView==="confirmationView"){setView("confirmationView");await loadCourierTasks();}
      else if(lastView==="historyView"){setView("historyView");await loadCourierTasks();}
      else{setView("courierView");await loadCourierTasks();await restoreActivityDraft();}
    }else if(lastView==="reportView"){
      setView("reportView");
      renderReport([]);
      await loadReportOptions();
    }else if(lastView==="usersView" && state.user.peran==="Super User"){
      setView("usersView");
      await loadUsers();
    }else{
      setView("dashboardView");
      await loadDashboard();
    }
  }catch(err){
    if(state.user.peran==="Kurir")setView("courierView");
    else if(lastView==="reportView")setView("reportView");
    else if(lastView==="usersView" && state.user.peran==="Super User")setView("usersView");
    else setView("dashboardView");
  }
  return true;
}

async function handleLogin(e){
  e.preventDefault();msg("loginMsg","Memeriksa akun...");
  try{
    const data=await api("login",{id:$("loginId").value.trim(),pin:$("loginPin").value.trim()});

    // Normalisasi respons login agar tetap kompatibel dengan Web API yang
    // mengembalikan user langsung maupun di dalam data/user.
    const rawUser=data.user || data;
    const user={
      id:rawUser.id ?? rawUser.idPengguna ?? rawUser["ID Pengguna"],
      nama:rawUser.nama ?? rawUser.name ?? rawUser["Nama"],
      peran:rawUser.peran ?? rawUser.role ?? rawUser["Peran"]
    };

    if(!user.id || !user.nama || !user.peran){
      throw new Error("Data akun belum lengkap. Coba lagi.");
    }

    state.user=user;
    const loginAt=Date.now(); writeSession({user,loginAt,lastView:user.peran==="Kurir"?"courierView":"dashboardView"}); scheduleSessionExpiry(loginAt);
    $("loginView").classList.add("hidden");$("appView").classList.remove("hidden");
    setWelcome(user.nama);setupNav(user.peran);
    if(user.peran==="Kurir"){await loadLocations();setView("courierView");await loadCourierTasks();await restoreActivityDraft();}
    else{setView("dashboardView");await loadDashboard();}
  }catch(err){msg("loginMsg",err.message)}
}

async function handleCreateActivity(e){
  e.preventDefault();if($("startBtn").disabled)return;
  $("startBtn").disabled=true;msg("activityMsg","Membuat tugas...");
  try{
    const asal=$("asalSearch").value.trim(), tujuan=$("tujuanSearch").value.trim();
    const jenisTugas=getSelectedJenisTugas();
    if(!jenisTugas.length)throw new Error("Pilih minimal satu jenis tugas.");
    const jenisPekerjaan=jenisTugas.join(" | ");
    const fotoDokumen=await getDraftOrSelectedFile("fotoDokumen");
    const fotoBerangkat=await getDraftOrSelectedFile("fotoBerangkat");
    if(!fotoDokumen||!fotoBerangkat)throw new Error("Foto dokumen dan foto saat berangkat wajib diisi.");
    const data=await api("createActivity",{idPengguna:state.user.id,jenisPekerjaan,asal,tujuan,fotoDokumen:await fileToBase64(fotoDokumen),fotoBerangkat:await fileToBase64(fotoBerangkat)});
    clearActivityDraft();
    $("activityForm").reset();
    msg("activityMsg",`Tugas berhasil dibuat: ${data.jenisTugas||jenisTugas.join(" | ")}. Konfirmasi keberangkatan saat kamu siap jalan.`);
    await loadCourierTasks();
  }catch(err){msg("activityMsg",err.message);checkStart();}
}

async function handleArrival(){
  const input=document.createElement("input");input.type="file";input.accept="image/*";input.style.display="none";document.body.appendChild(input);input.click();
  input.onchange=async()=>{
    if(!input.files[0]){input.remove();return;}
    $("arrivalBtn").disabled=true;msg("arrivalMsg","Menyimpan foto saat tiba...");
    try{
      const data=await api("confirmArrival",{idAktivitas:state.activity.idAktivitas,idPengguna:state.user.id,fotoDatang:await fileToBase64(input.files[0])});
      state.activity.status="Lagi Diproses";
      state.activity.waktuDatang=data.waktuDatang||"-";
      $("activityCard").classList.add("hidden");
      $("activeCard").classList.add("hidden");
      $("resultCard").classList.remove("hidden");
      $("resultStatus").textContent="Lagi Diproses";
      $("arrivalTime").textContent=`Sampai: ${displayIndonesiaDateTime(state.activity.waktuDatang)}`;
      $("hasil").value="";
      $("keterangan").value="";
      $("saveResultBtn").classList.remove("hidden");
      $("saveResultBtn").disabled=false;
      $("completeBtn").classList.add("hidden");
      msg("arrivalMsg","");
      msg("resultMsg","");
    }catch(err){msg("arrivalMsg",err.message);$("arrivalBtn").disabled=false;}
    input.remove();
  };
}

async function handleSaveResult(e){
  e.preventDefault();
  if(!$("hasil").value){msg("resultMsg","Pilih hasil tugas tugas terlebih dahulu.");return;}
  $("saveResultBtn").disabled=true;
  msg("resultMsg","Menyelesaikan tugas...");
  try{
    await api("saveResult",{
      idAktivitas:state.activity.idAktivitas,
      idPengguna:state.user.id,
      hasil:$("hasil").value,
      keterangan:$("keterangan").value.trim()
    });
    const data=await api("completeActivity",{
      idAktivitas:state.activity.idAktivitas,
      idPengguna:state.user.id
    });
    state.activity.status="Selesai";
    state.activity.waktuSelsai=data.waktuSelsai||"-";
    resetCourierCards(true);
    $("activityCard").classList.remove("hidden");
    $("activeCard").classList.add("hidden");
    $("resultCard").classList.add("hidden");
    $("startBtn").disabled=true;
    $("activityMsg").textContent="Tugas selesai. Kamu bisa membuat tugas baru.";
    window.scrollTo({top:0,behavior:"smooth"});
  }catch(err){
    msg("resultMsg",err.message);
    $("saveResultBtn").disabled=false;
  }
}

async function handleComplete(){
  $("completeBtn").disabled=true;msg("resultMsg","Menyelesaikan tugas...");
  try{const data=await api("completeActivity",{idAktivitas:state.activity.idAktivitas,idPengguna:state.user.id});state.activity.status="Selesai";
      state.activity.waktuSelsai=data.waktuSelsai||"-";
      resetCourierCards();
      $("activityCard").classList.remove("hidden");
      $("activeCard").classList.add("hidden");
      $("resultCard").classList.add("hidden");
      $("startBtn").disabled=true;
      $("activityMsg").textContent="Tugas selesai. Kamu bisa membuat tugas baru.";
      window.scrollTo({top:0,behavior:"smooth"});}
  catch(err){msg("resultMsg",err.message);$("completeBtn").disabled=false;}
}

function statusClass(status){return `<span class="status-pill">${escapeHtml(status)}</span>`;}

function formatDateKey(date){
  const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,"0"),d=String(date.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}

function parseActivityDate(value){
  if(!value)return null;
  const m=String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(m)return new Date(Number(m[3]),Number(m[2])-1,Number(m[1]),Number(m[4]||0),Number(m[5]||0),Number(m[6]||0));
  const d=new Date(value);return isNaN(d.getTime())?null:d;
}

function activityMatchesDay(a, day){
  if(!day)return true;
  return [a.berangkat,a.datang,a.selesai].some(v=>{const d=parseActivityDate(v);return d&&formatDateKey(d)===day;});
}

function populateDashboardCouriers(rows){
  const names=[...new Set(rows.map(a=>String(a.kurir||"").trim()).filter(Boolean))].sort();
  const current=$("dashboardCourier").value;
  $("dashboardCourier").innerHTML='<option value="">Semua kurir</option>'+names.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");
  if(names.includes(current))$("dashboardCourier").value=current;
}


function renderCategoryLegend(elementId, entries, palette){
  const legend=$(elementId);
  if(!legend)return;
  legend.innerHTML=entries.map(([label],i)=>{
    const color=palette[i % palette.length];
    return `<span><i class="legend-line" style="background:${color}"></i>${escapeHtml(label)}</span>`;
  }).join("");
}

function renderCategoryBarChart(elementId, legendId, rows, key, emptyText, palette){
  const chart=$(elementId), legend=$(legendId);
  if(!chart)return;
  if(!rows.length){
    chart.innerHTML=`<div class="category-chart-empty">${escapeHtml(emptyText)}</div>`;
    if(legend)legend.innerHTML='<span><i class="legend-line legend-empty"></i>Belum ada data</span>';
    return;
  }
  const counts={};
  rows.forEach(a=>{
    const label=String(a[key]||"Tidak diketahui").trim()||"Tidak diketahui";
    counts[label]=(counts[label]||0)+1;
  });
  const entries=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const max=Math.max(...entries.map(([,v])=>v),1);
  chart.innerHTML=entries.map(([label,value],i)=>{
    const color=palette[i%palette.length];
    const width=Math.max(4,Math.round(value/max*100));
    return `<div class="category-chart-row">
      <div class="category-chart-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
      <div class="category-chart-track"><div class="category-chart-bar" style="width:${width}%;background:${color}"></div></div>
      <div class="category-chart-value">${value}</div>
    </div>`;
  }).join("");
  renderCategoryLegend(legendId,entries,palette);
}

function renderCourierChart(rows){
  const palette=["#2563EB","#F97316","#16A34A","#9333EA","#DC2626","#0891B2","#CA8A04","#DB2777"];
  renderCategoryBarChart("courierChart","courierLegend",rows,"kurir","Belum ada aktivitas.",palette);
}

function renderStatusChart(rows){
  const statusOrder=["Menunggu Berangkat","Lagi Jalan","Lagi Diproses","Selesai"];
  const paletteByStatus={
    "Menunggu Berangkat":"#2563EB",
    "Lagi Jalan":"#F97316",
    "Lagi Diproses":"#9333EA",
    "Selesai":"#16A34A"
  };
  const chart=$("statusChart"), legend=$("statusLegend");
  if(!chart)return;
  if(!rows.length){
    chart.innerHTML='<div class="category-chart-empty">Belum ada aktivitas.</div>';
    if(legend)legend.innerHTML='<span><i class="legend-line legend-empty"></i>Belum ada data</span>';
    return;
  }
  const counts={};
  rows.forEach(a=>{
    const status=String(a.status||"Tidak diketahui").trim()||"Tidak diketahui";
    counts[status]=(counts[status]||0)+1;
  });
  const ordered=[];
  statusOrder.forEach(s=>{if(counts[s])ordered.push([s,counts[s]]);});
  Object.entries(counts).filter(([s])=>!statusOrder.includes(s)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).forEach(x=>ordered.push(x));
  const max=Math.max(...ordered.map(([,v])=>v),1);
  chart.innerHTML=ordered.map(([label,value])=>{
    const color=paletteByStatus[label]||"#64748B";
    const width=Math.max(4,Math.round(value/max*100));
    return `<div class="category-chart-row">
      <div class="category-chart-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
      <div class="category-chart-track"><div class="category-chart-bar" style="width:${width}%;background:${color}"></div></div>
      <div class="category-chart-value">${value}</div>
    </div>`;
  }).join("");
  if(legend)legend.innerHTML=ordered.map(([label])=>{
    const color=paletteByStatus[label]||"#64748B";
    return `<span><i class="legend-line" style="background:${color}"></i>${escapeHtml(label)}</span>`;
  }).join("");
}

function renderActivityChart(rows){
  const chart=$("activityChart");
  if(!chart)return;
  if(!rows.length){chart.innerHTML='<div class="chart-empty">Belum ada aktivitas.</div>';return;}

  const days={};
  rows.forEach(a=>{
    const d=parseActivityDate(a.berangkat||a.datang||a.selesai);
    const key=d?formatDateKey(d):"__nodate";
    if(!days[key])days[key]={total:0,done:0};
    days[key].total++;
    if(String(a.status||"").trim()==="Selesai")days[key].done++;
  });

  const entries=Object.entries(days).sort((a,b)=>{
    if(a[0]==="__nodate")return 1;if(b[0]==="__nodate")return -1;return a[0].localeCompare(b[0]);
  }).slice(-10);
  const max=Math.max(...entries.map(([,v])=>v.total),1);
  const colors={total:"#2563EB",done:"#16A34A",active:"#F97316"};

  chart.innerHTML=entries.map(([key,v])=>{
    const d=key==="__nodate"?null:new Date(key+"T00:00:00");
    const label=d?d.toLocaleDateString("id-ID",{day:"2-digit",month:"short"}):"Tanpa tanggal";
    const active=v.total-v.done;
    const totalH=Math.max(12,Math.round(v.total/max*155));
    const doneH=Math.max(v.done?10:0,Math.round(v.done/max*155));
    const activeH=Math.max(active?10:0,Math.round(active/max*155));
    return `<div class="chart-col">
      <div class="chart-value">${v.total}</div>
      <div class="chart-bars">
        <div class="chart-series"><div class="chart-bar total" style="height:${totalH}px;background:${colors.total}"></div><span>Total</span></div>
        <div class="chart-series"><div class="chart-bar done" style="height:${doneH}px;background:${colors.done}"></div><span>Selesai</span></div>
        <div class="chart-series"><div class="chart-bar active" style="height:${activeH}px;background:${colors.active}"></div><span>Belum</span></div>
      </div>
      <div class="chart-label">${escapeHtml(label)}</div>
      <div class="chart-active">${active} belum selesai</div>
    </div>`;
  }).join("");
}

function parseIndonesiaDateTime(value){
  if(!value)return null;
  if(value instanceof Date && !isNaN(value.getTime()))return value;
  const text=String(value).trim();

  // Spreadsheet/backend format utama: US MM/DD/YYYY HH:mm.
  let m=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(m){
    const first=Number(m[1]);
    const second=Number(m[2]);
    const year=Number(m[3]);
    const hour=Number(m[4]||0);
    const minute=Number(m[5]||0);
    const secondPart=Number(m[6]||0);

    // Data lama yang memakai DD/MM tetap bisa dibaca jika salah satu bagian > 12.
    // Untuk format baru yang ambigu (keduanya <= 12), gunakan format US.
    const month=first>12 ? second : first;
    const day=first>12 ? first : second;
    const d=new Date(year,month-1,day,hour,minute,secondPart);
    return isNaN(d.getTime())?null:d;
  }

  // ISO timestamps: respect the supplied timezone when present.
  const iso=new Date(text);
  return isNaN(iso.getTime())?null:iso;
}

function displayIndonesiaDateTime(value){
  const d=parseIndonesiaDateTime(value);
  if(!d)return value?String(value).trim():"-";
  const parts=new Intl.DateTimeFormat("id-ID",{
    timeZone:"Asia/Jakarta", day:"2-digit", month:"short", year:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  }).formatToParts(d);
  const get=type=>parts.find(p=>p.type===type)?.value||"";
  return `${get("day")} ${get("month")} ${get("year")} - ${get("hour")}:${get("minute")}`;
}

function displayIndonesiaTime(value){
  const d=parseIndonesiaDateTime(value);
  if(!d)return value?String(value).trim():"-";
  return new Intl.DateTimeFormat("id-ID",{timeZone:"Asia/Jakarta",hour:"2-digit",minute:"2-digit",hour12:false}).format(d).replace(/\./g,":");
}

function displayTimeOnly(value){
  return displayIndonesiaTime(value);
}

function displayDuration(value){
  if(value===null || value===undefined || value==="") return "-";
  const text=String(value).trim();
  if(!text) return "-";

  // Google Sheets kadang mengembalikan durasi sebagai ISO 1899-12-xx.
  let m=text.match(/T(\d{1,3}):(\d{2})(?::(\d{2}))?/);
  if(m) return `${String(m[1]).padStart(2,"0")}:${m[2]}`;

  // Durasi biasa: HH:MM:SS atau HH:MM.
  m=text.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if(m) return `${String(m[1]).padStart(2,"0")}:${m[2]}`;

  // Jika API mengembalikan angka serial waktu Google Sheets.
  if(typeof value === "number" && Number.isFinite(value)){
    const totalMinutes=Math.max(0,Math.round(value*24*60));
    const hours=Math.floor(totalMinutes/60);
    const minutes=totalMinutes%60;
    return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}`;
  }

  return text;
}

function renderDashboard(data){
  requestAnimationFrame(syncDashboardFreeze);
  const allRows=data.activities||[];
  populateDashboardCouriers(allRows);
  const day=$("dashboardDate").value, courier=$("dashboardCourier").value;
  const rows=allRows.filter(a=>(!courier||a.kurir===courier)&&activityMatchesDay(a,day));
  const stats={total:rows.length,menungguBerangkat:rows.filter(a=>a.status==="Menunggu Berangkat").length,lagiJalan:rows.filter(a=>a.status==="Lagi Jalan").length,lagiDiproses:rows.filter(a=>a.status==="Lagi Diproses").length,selesai:rows.filter(a=>a.status==="Selesai").length};
  $("statTotal").textContent = stats.total || 0;$("statJalan").textContent=stats.lagiJalan;$("statProses").textContent=stats.lagiDiproses;$("statSelesai").textContent=stats.selesai;
  renderActivityChart(rows);
  renderCourierChart(rows);
  renderStatusChart(rows);
  $("chartSubtitle").textContent="Aktivitas sesuai dengan filter yang dipilih.";
  const photoLink=(url)=>url?`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Lihat Foto</a>`:"-";
  $("dashboardTable").innerHTML=rows.map(a=>`<tr>
    <td>${escapeHtml(a.kurir||"-")}</td>
    <td>${escapeHtml(a.trip||"-")}</td>
    <td>${escapeHtml(a.jenisTugas||a.pekerjaan||"-")}</td>
    <td>${escapeHtml(a.tujuan||"-")}</td>
    <td>${photoLink(a.fotoDokumen)}</td>
    <td>${photoLink(a.fotoBerangkat)}</td>
    <td>${escapeHtml(displayTimeOnly(a.berangkat))}</td>
    <td>${photoLink(a.fotoDatang)}</td>
    <td>${escapeHtml(displayTimeOnly(a.datang))}</td>
    <td>${escapeHtml(displayTimeOnly(a.selesai))}</td>
    <td>${escapeHtml(displayDuration(a.durasiMengemudi))}</td>
    <td>${escapeHtml(displayDuration(a.durasiTugas))}</td>
  </tr>`).join("");
  $("dashboardEmpty").classList.toggle("hidden",rows.length>0);
}

async function loadDashboard(){
  msg("dashboardMsg","Memuat data aktivitas...");
  try{setDashboardDefaultDay();const data=await api("getDashboard",{idPengguna:state.user.id});state.dashboardActivities=data.activities||[];renderDashboard(data);msg("dashboardMsg","");}
  catch(err){msg("dashboardMsg",err.message);}
}

function applyDashboardFilters(){renderDashboard({activities:state.dashboardActivities||[]});}
function todayKey(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function setDashboardDefaultDay(){$("dashboardDate").value="";}
function resetDashboardFilters(){$("dashboardDate").value="";$("dashboardCourier").value="";applyDashboardFilters();}


function populateReportOptions(data){
  const couriers = data.couriers || [];
  const origins = data.origins || [];
  const destinations = data.destinations || [];

  fillReportSelect("reportCourier", data.couriers, "Semua kurir");

  fillReportSelect("reportOrigin", data.origins, "Semua asal");

  fillReportSelect("reportDestination", data.destinations, "Semua tujuan");
}


function fillReportSelect(id, values, firstLabel){
  const el = $(id);
  if(!el) return;
  const current = el.value;
  el.innerHTML = `<option value="">${escapeHtml(firstLabel)}</option>` +
    (values || []).map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if(current && (values || []).includes(current)) el.value = current;
}

async function loadReportOptions(){
  try{
    // Mengikuti pola request dari script referensi yang terbukti masih bisa mengambil data.
    const [data,loc] = await Promise.all([
      api("getReportOptions",{idPengguna:state.user.id}),
      api("getLocations")
    ]);
    const dashboardCouriers=[...new Set((state.dashboardActivities||[]).map(a=>String(a.kurir||"").trim()).filter(Boolean))].sort();
    populateReportOptions({
      couriers:(data.couriers&&data.couriers.length)?data.couriers:dashboardCouriers,
      origins:(data.origins&&data.origins.length)?data.origins:(loc.locations||[]),
      destinations:(data.destinations&&data.destinations.length)?data.destinations:(loc.locations||[])
    });
  }catch(err){msg("reportMsg",err.message);}
}

let currentReportRows=[];

function displayReportTime(value){
  return displayIndonesiaDateTime(value);
}

function renderReport(rows){
  currentReportRows=Array.isArray(rows)?rows:[];
  const photoLink=(url)=>url?`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Lihat Foto</a>`:"-";
  $("reportTable").innerHTML = currentReportRows.map(a=>`<tr>
    <td>${escapeHtml(a.idAktivitas||"")}</td>
    <td>${statusClass(a.status)}</td>
    <td>${escapeHtml(a.idPengguna||"")}</td>
    <td>${escapeHtml(a.nama||a.kurir||"")}</td>
    <td>${escapeHtml(a.trip||"")}</td>
    <td>${escapeHtml(a.jenisTugas||a.pekerjaan||"")}</td>
    <td>${escapeHtml(a.asal||"")}</td>
    <td>${escapeHtml(a.tujuan||"")}</td>
    <td>${photoLink(a.fotoDokumen)}</td>
    <td>${photoLink(a.fotoBerangkat)}</td>
    <td>${escapeHtml(displayReportTime(a.berangkat))}</td>
    <td>${escapeHtml(displayReportTime(a.datang))}</td>
    <td>${photoLink(a.fotoDatang)}</td>
    <td>${escapeHtml(a.hasil||"-")}</td>
    <td>${escapeHtml(a.keterangan||"-")}</td>
    <td>${escapeHtml(displayReportTime(a.selesai))}</td>
    <td>${escapeHtml(displayDuration(a.durasiMengemudi))}</td>
    <td>${escapeHtml(displayDuration(a.durasiTugas))}</td>
  </tr>`).join("");
  $("reportEmpty").classList.toggle("hidden",currentReportRows.length>0);
  $("reportCount").textContent = `${currentReportRows.length} aktivitas`;
}

function exportReportExcel(){
  if(!currentReportRows.length){
    msg("reportMsg","Belum ada data untuk diekspor.");
    return;
  }
  if(typeof XLSX==="undefined"){
    msg("reportMsg","Fitur Excel belum siap. Muat ulang halaman lalu coba lagi.");
    return;
  }

  const exportRows=currentReportRows.map(a=>({
    "ID Aktivitas":a.idAktivitas||"",
    "Status":a.status||"",
    "ID Pengguna":a.idPengguna||"",
    "Nama":a.nama||a.kurir||"",
    "Trip":a.trip||"",
    "Jenis Tugas":a.jenisTugas||a.pekerjaan||"",
    "Asal":a.asal||"",
    "Tujuan":a.tujuan||"",
    "Foto Dokumen":a.fotoDokumen||"",
    "Foto Saat Berangkat":a.fotoBerangkat||"",
    "Waktu Berangkat":displayReportTime(a.berangkat),
    "Waktu Datang":displayReportTime(a.datang),
    "Foto Saat Datang":a.fotoDatang||"",
    "Hasil":a.hasil||"",
    "Keterangan":a.keterangan||"",
    "Waktu Selesai":displayReportTime(a.selesai),
    "Durasi Mengemudi":displayDuration(a.durasiMengemudi),
    "Durasi Tugas":displayDuration(a.durasiTugas)
  }));

  const ws=XLSX.utils.json_to_sheet(exportRows);

  // Semua kolom memakai lebar default Excel yang diminta: 8.11.
  ws["!cols"]=Array.from({length:17},()=>({wch:8.11}));

  // Foto dibuat sebagai hyperlink yang bisa diklik langsung dari Excel.
  const photoColumns=["Foto Dokumen","Foto Saat Berangkat","Foto Saat Datang"];
  photoColumns.forEach(col=>{
    const colIndex=Object.keys(exportRows[0]).indexOf(col);
    exportRows.forEach((row,rowIndex)=>{
      const url=String(row[col]||"").trim();
      if(!url)return;
      const cellRef=XLSX.utils.encode_cell({r:rowIndex+1,c:colIndex});
      if(!ws[cellRef])ws[cellRef]={t:"s",v:url};
      ws[cellRef].l={Target:url,Tooltip:"Buka foto"};
      ws[cellRef].v="Buka Foto";
      ws[cellRef].t="s";
    });
  });

  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,"Aktivitas");

  const stamp=new Date();
  const y=stamp.getFullYear();
  const m=String(stamp.getMonth()+1).padStart(2,"0");
  const d=String(stamp.getDate()).padStart(2,"0");
  XLSX.writeFile(wb,`gamamed_${d}-${m}-${String(y).slice(-2)}.xlsx`);
  msg("reportMsg","File Excel siap.");
}

async function loadReport(){
  msg("reportMsg","Memuat data laporan...");
  try{
    const data = await api("getReport",{
      idPengguna:state.user.id,
      tanggalDari:$("reportDateFrom").value,
      tanggalSampai:$("reportDateTo").value,
      status:$("reportStatus").value,
      kurir:$("reportCourier").value,
      asal:$("reportOrigin").value,
      tujuan:$("reportDestination").value
    });
    renderReport(data.activities||[]);
    msg("reportMsg","");
  }catch(err){
    msg("reportMsg",err.message);
    renderReport([]);
  }
}

function resetReportFilters(){
  $("reportDateFrom").value="";
  $("reportDateTo").value="";
  $("reportStatus").value="";
  $("reportCourier").value="";
  $("reportOrigin").value="";
  $("reportDestination").value="";
  loadReport();
}

async function loadUsers(){
  msg("userMsg","Memuat daftar pengguna...");
  try{
    const data=await api("getUsers",{idPengguna:state.user.id});
    const list=$("usersList");
    list.innerHTML=(data.users||[]).map(u=>`<div class="user-row"><div class="user-main"><strong>${escapeHtml(u.nama)}</strong><div class="user-meta">${escapeHtml(u.idPengguna)} · ${escapeHtml(u.peran)} · ${u.status?"Aktif":"Nonaktif"}</div></div><div class="user-actions"><button class="ghost status-user" data-id="${escapeHtml(u.idPengguna)}" data-status="${u.status}">${u.status?"Nonaktifkan":"Aktifkan"}</button><button class="danger delete-user" data-id="${escapeHtml(u.idPengguna)}">Hapus</button></div></div>`).join("")||"<div class='empty'>Belum ada pengguna.</div>";
    list.querySelectorAll(".status-user").forEach(btn=>btn.onclick=async()=>{btn.disabled=true;try{await api("updateUserStatus",{idPengguna:state.user.id,id:btn.dataset.id,status:btn.dataset.status!=="true"});await loadUsers();}catch(err){msg("userMsg",err.message);btn.disabled=false;}});
    list.querySelectorAll(".delete-user").forEach(btn=>btn.onclick=async()=>{if(!confirm("Yakin ingin menghapus pengguna ini?"))return;btn.disabled=true;try{await api("deleteUser",{idPengguna:state.user.id,id:btn.dataset.id});await loadUsers();}catch(err){msg("userMsg",err.message);btn.disabled=false;}});
    msg("userMsg","");
  }catch(err){msg("userMsg",err.message)}
}

async function handleCreateUser(e){
  e.preventDefault();msg("userMsg","Menambahkan pengguna...");
  try{await api("createUser",{idPengguna:state.user.id,id:$("userId").value.trim(),nama:$("userName").value.trim(),pin:$("userPin").value.trim(),peran:$("userRole").value});$("userForm").reset();msg("userMsg","Pengguna berhasil ditambahkan.");await loadUsers();}
  catch(err){msg("userMsg",err.message)}
}

$("loginForm").addEventListener("submit",handleLogin);
$("logoutBtn").addEventListener("click",()=>logoutToLogin(""));
setupCombo("asalSearch","asalList");setupCombo("tujuanSearch","tujuanList");
["asalSearch","tujuanSearch"].forEach(id=>$(id).addEventListener("input",()=>{
  writeActivityDraft({[id]:$(id).value});
  checkStart();
}));
document.querySelectorAll('#jenisTugasGroup input[name="jenisTugas"]').forEach(cb=>cb.addEventListener("change",()=>{
  const selected=getSelectedJenisTugas();
  writeActivityDraft({jenisTugas:selected.join("|")});
  checkStart();
}));
$("fotoDokumen").addEventListener("change",()=>{saveDraftFile("fotoDokumen");checkStart();});
$("fotoBerangkat").addEventListener("change",()=>{saveDraftFile("fotoBerangkat");checkStart();});
$("activityForm").addEventListener("submit",handleCreateActivity);
$("pendingDepartureBtn").addEventListener("click",handlePendingDeparture);
$("applyDashboardFilterBtn").addEventListener("click",applyDashboardFilters);
$("resetDashboardFilterBtn").addEventListener("click",resetDashboardFilters);
$("refreshReportBtn").addEventListener("click",async()=>{await loadReportOptions();msg("reportMsg","");});
$("exportReportBtn").addEventListener("click",exportReportExcel);
$("applyReportBtn").addEventListener("click",loadReport);
$("resetReportBtn").addEventListener("click",resetReportFilters);
$("userForm").addEventListener("submit",handleCreateUser);
$("refreshUsersBtn").addEventListener("click",loadUsers);

function syncDashboardFreeze(){
  const freeze = $("dashboardStickyTop");
  const spacer = $("dashboardStickySpacer");
  if(!freeze || !spacer) return;
  const h = freeze.getBoundingClientRect().height;
  spacer.style.height = `${Math.ceil(h)}px`;
}

window.addEventListener("resize", syncDashboardFreeze);
window.addEventListener("load", syncDashboardFreeze);

document.addEventListener("visibilitychange",()=>{if(!document.hidden) checkSessionExpiry();});
restoreSession();
