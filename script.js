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

function resetUiStateOnLogout(){
  // Logout benar-benar mengembalikan UI ke kondisi awal. Selama belum logout,
  // session dan lastView tetap mengikuti aturan persistence yang sekarang.
  try{
    if($("dashboardDate"))$("dashboardDate").value="";
    if($("dashboardCourier"))$("dashboardCourier").value="";
    if($("reportDateFrom"))$("reportDateFrom").value="";
    if($("reportDateTo"))$("reportDateTo").value="";
    if($("reportStatus"))$("reportStatus").value="";
    if($("reportCourier"))$("reportCourier").value="";
    if($("reportOrigin"))$("reportOrigin").value="";
    if($("reportDestination"))$("reportDestination").value="";
    if(typeof dashboardJourneyOpen!=="undefined" && dashboardJourneyOpen?.clear)dashboardJourneyOpen.clear();
    if($("dashboardTable"))$("dashboardTable").innerHTML="";
    if($("reportTable"))$("reportTable").innerHTML="";
  }catch(e){}
}

function logoutToLogin(message=""){
  if(state.user)clearActivityDraft();
  resetUiStateOnLogout();
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
  if($("sidebarUserName"))$("sidebarUserName").textContent=name;
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
    const [fotoDokumen,fotoBerangkat]=await Promise.all([
      getDraftOrSelectedFile("fotoDokumen"),
      getDraftOrSelectedFile("fotoBerangkat")
    ]);
    if(!fotoDokumen||!fotoBerangkat)throw new Error("Foto dokumen dan foto saat berangkat wajib diisi.");
    const [fotoDokumen64,fotoBerangkat64]=await Promise.all([
      fileToBase64(fotoDokumen),
      fileToBase64(fotoBerangkat)
    ]);
    const data=await api("createActivity",{idPengguna:state.user.id,jenisPekerjaan,asal,tujuan,fotoDokumen:fotoDokumen64,fotoBerangkat:fotoBerangkat64});
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
    const data=await api("saveAndCompleteActivity",{
      idAktivitas:state.activity.idAktivitas,
      idPengguna:state.user.id,
      hasil:$("hasil").value,
      keterangan:$("keterangan").value.trim()
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
  if(value===null || value===undefined || value==="")return null;
  if(value instanceof Date && !isNaN(value.getTime()))return value;
  const text=String(value).trim();

  // Spreadsheet/backend utama: MM/dd/yyyy HH:mm. Parse manual supaya tidak
  // terkena perbedaan locale browser atau pergeseran timezone.
  let m=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(m){
    const month=Number(m[1]), day=Number(m[2]), year=Number(m[3]);
    const hour=Number(m[4]||0), minute=Number(m[5]||0), second=Number(m[6]||0);
    if(month<1||month>12||day<1||day>31)return null;
    return new Date(year,month-1,day,hour,minute,second);
  }

  // HTML date / ISO date. Ambil komponen kalendernya langsung sehingga filter
  // tetap memakai tanggal lokal Indonesia, bukan UTC.
  m=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if(m){
    return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]||0),Number(m[5]||0),Number(m[6]||0));
  }

  const d=new Date(text);return isNaN(d.getTime())?null:d;
}

function activityMatchesDay(a, day){
  if(!day)return true;
  // Filter Dashboard selalu berdasarkan Waktu Berangkat saja.
  const raw=a && a.berangkat;
  if(!raw)return false;
  const d=parseActivityDate(raw);
  return !!d && formatDateKey(d)===day;
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
  const chart=$("courierChart");
  if(!chart)return;
  const counts={};
  rows.forEach(a=>{const name=String(a.kurir||a.nama||"Tidak diketahui").trim()||"Tidak diketahui";counts[name]=(counts[name]||0)+1;});
  const entries=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"id"));
  if(!entries.length){chart.innerHTML='<div class="chart-empty">Belum ada aktivitas pada periode ini.</div>';return;}
  const max=entries[0][1]||1, total=rows.length;
  chart.innerHTML=entries.slice(0,8).map(([name,value],i)=>{
    const initials=name.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
    const width=Math.max(8,Math.round(value/max*100));
    const share=total?Math.round(value/total*100):0;
    return `<div class="courier-rank-row"><div class="courier-rank-person"><span class="courier-rank-index">${i+1}</span><span class="courier-rank-avatar">${escapeHtml(initials||'?')}</span><div><strong>${escapeHtml(name)}</strong><small>${value} aktivitas · ${share}%</small></div></div><div class="courier-rank-track"><i style="width:${width}%"></i></div><b>${value}</b></div>`;
  }).join('');
}

function renderStatusChart(rows){
  const chart=$("statusChart"), legend=$("statusLegend");
  if(!chart)return;
  const statusOrder=["Selesai","Lagi Diproses","Lagi Jalan","Menunggu Berangkat"];
  const colors={"Selesai":"#4dbb7c","Lagi Diproses":"#8c65dc","Lagi Jalan":"#3aaec9","Menunggu Berangkat":"#f0b43c","Tidak diketahui":"#aab6c3"};
  const counts={}; rows.forEach(a=>{const st=String(a.status||"Tidak diketahui").trim()||"Tidak diketahui";counts[st]=(counts[st]||0)+1;});
  const ordered=statusOrder.filter(st=>counts[st]).map(st=>[st,counts[st]]).concat(Object.entries(counts).filter(([st])=>!statusOrder.includes(st)));
  const total=rows.length;
  if(!total){chart.innerHTML='<div class="chart-empty">Belum ada aktivitas.</div>';if(legend)legend.innerHTML='';return;}
  let cursor=0; const gradient=ordered.map(([st,v])=>{const start=cursor,end=cursor+v/total*360;cursor=end;return `${colors[st]||colors["Tidak diketahui"]} ${start}deg ${end}deg`;}).join(',');
  chart.innerHTML=`<div class="status-donut" style="background:conic-gradient(${gradient})"><div class="status-donut-hole"><strong>${total}</strong><span>Total<br>Aktivitas</span></div></div>`;
  if(legend)legend.innerHTML=ordered.map(([st,v])=>`<div class="status-summary-row"><span><i class="legend-dot" style="background:${colors[st]||colors["Tidak diketahui"]}"></i>${escapeHtml(st)}</span><strong>${v}</strong><small>${Math.round(v/total*100)}%</small></div>`).join('');
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
  return `${get("day")} ${get("month")} ${get("year")} ${get("hour")}:${get("minute")}`;
}

function displayIndonesiaDateOnly(value){
  const d=parseIndonesiaDateTime(value);
  if(!d)return value?String(value).trim():"-";
  const parts=new Intl.DateTimeFormat("id-ID",{
    timeZone:"Asia/Jakarta", day:"2-digit", month:"short", year:"2-digit"
  }).formatToParts(d);
  const get=type=>parts.find(p=>p.type===type)?.value||"";
  return `${get("day")} ${get("month")} ${get("year")}`;
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

function renderActivityTypeSummary(rows){
  const chart=$("activityTypeChart"), legend=$("activityTypeLegend");
  if(!chart)return;
  const counts={};
  rows.forEach(a=>String(a.jenisTugas||a.pekerjaan||"Tidak diketahui").split("|").map(v=>v.trim()).filter(Boolean).forEach(label=>counts[label]=(counts[label]||0)+1));
  const entries=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"id"));
  const total=entries.reduce((s,[,v])=>s+v,0);
  if(!entries.length){chart.innerHTML='<div class="chart-empty">Belum ada aktivitas pada periode ini.</div>';if(legend)legend.innerHTML='';return;}
  const palette=["#2f80ed","#4dbb7c","#8c65dc","#ec9c48","#3aaec9","#e46b73","#8091a8"];
  const max=Math.max(...entries.map(([,v])=>v),1);
  chart.innerHTML=entries.slice(0,8).map(([label,value],i)=>{
    const pct=Math.round(value/total*100); const width=Math.max(7,Math.round(value/max*100)); const color=palette[i%palette.length];
    return `<div class="activity-type-row"><div class="activity-type-name"><i class="activity-type-dot" style="background:${color}"></i><span title="${escapeHtml(label)}">${escapeHtml(label)}</span></div><div class="activity-type-track"><i style="width:${width}%;background:${color}"></i></div><div class="activity-type-count"><strong>${value}</strong><small>${pct}%</small></div></div>`;
  }).join('');
  if(legend)legend.innerHTML=`<span>${total} aktivitas</span><span>Terbanyak: <b>${escapeHtml(entries[0][0])}</b></span>`;
}

let dashboardJourneyOpen = new Set();
let dashboardDetailOpen = new Set();

function renderJourneyPanel(allRows, day){
  const panel=$("journeyPanel");
  if(!panel)return;
  const source=(Array.isArray(allRows)?allRows:[]).filter(a=>String(a.idAktivitas||"").trim());
  const grouped={};

  source.filter(a=>activityMatchesDay(a,day)).forEach(a=>{
    const name=String(a.kurir||"").trim();
    if(!name)return;
    if(!grouped[name])grouped[name]=[];
    grouped[name].push(a);
  });

  const names=Object.keys(grouped).sort((a,b)=>a.localeCompare(b,"id",{sensitivity:"base"}));
  if(!names.length){
    panel.innerHTML='<div class="journey-empty">Belum ada perjalanan untuk filter yang dipilih.</div>';
    return;
  }

  // Saat pertama kali dibuka, buka kurir pertama. Setelah itu pertahankan
  // pilihan expand/collapse user selama dashboard masih aktif.
  if(!dashboardJourneyOpen.size)dashboardJourneyOpen.add(names[0]);
  dashboardJourneyOpen.forEach(name=>{if(!grouped[name])dashboardJourneyOpen.delete(name);});

  panel.innerHTML=names.map((name,groupIndex)=>{
    const isOpen=dashboardJourneyOpen.has(name);
    const rows=grouped[name].slice().sort((a,b)=>{
      const tripA=Number.parseInt(String(a.trip??""),10), tripB=Number.parseInt(String(b.trip??""),10);
      if(Number.isFinite(tripA)&&Number.isFinite(tripB)&&tripA!==tripB)return tripA-tripB;
      const ta=parseActivityDate(a.berangkat||a.datang||a.selesai)?.getTime()||0;
      const tb=parseActivityDate(b.berangkat||b.datang||b.selesai)?.getTime()||0;
      return ta-tb;
    });

    const trips=rows.map((a,i)=>{
      const status=a.status||"-";
      const cls=status==="Selesai"?'done':status==="Lagi Diproses"?'process':status==="Lagi Jalan"?'road':'wait';
      const trip=a.trip!==undefined&&a.trip!==null&&String(a.trip).trim()!==""?String(a.trip):String(i+1);
      return `<div class="journey-item">
        <div class="journey-marker"><span>${escapeHtml(trip)}</span></div>
        <div class="journey-line"></div>
        <div class="journey-content">
          <div class="journey-top"><strong>Trip ${escapeHtml(trip)}</strong><span class="journey-status ${cls}">${escapeHtml(status)}</span></div>
          <div class="journey-route"><span class="journey-dot start"></span><div><small>Berangkat dari</small><b>${escapeHtml(a.asal||"-")}</b></div><time>${escapeHtml(displayIndonesiaTime(a.berangkat))}</time></div>
          <div class="journey-route"><span class="journey-dot end"></span><div><small>Menuju</small><b>${escapeHtml(a.tujuan||"-")}</b><em>${escapeHtml(a.jenisTugas||a.pekerjaan||"-")}</em></div><time>${escapeHtml(displayIndonesiaTime(a.datang))}</time></div>
          <div class="journey-meta"><span>Durasi mengemudi <b>${escapeHtml(displayDuration(a.durasiMengemudi))}</b></span><span>Selesai <b>${escapeHtml(displayIndonesiaTime(a.selesai))}</b></span></div>
        </div>
      </div>`;
    }).join("");

    return `<section class="journey-group ${isOpen?'is-open':''}" data-journey-group="${escapeHtml(name)}">
      <button type="button" class="journey-group-toggle" aria-expanded="${isOpen?'true':'false'}">
        <span class="journey-chevron" aria-hidden="true">›</span>
        <span class="journey-group-name">${escapeHtml(name)}</span>
        <span class="journey-group-count">${rows.length} trip</span>
      </button>
      <div class="journey-group-body" ${isOpen?'':'hidden'}>${trips}</div>
    </section>`;
  }).join("");
}

function renderProofGallery(rows){
  const el=$("proofGallery"); if(!el)return;
  const items=[];
  rows.slice().sort((a,b)=>(parseActivityDate(b.selesai||b.datang||b.berangkat)?.getTime()||0)-(parseActivityDate(a.selesai||a.datang||a.berangkat)?.getTime()||0)).forEach(a=>{
    [[a.fotoDatang,'Foto Saat Datang'],[a.fotoBerangkat,'Foto Berangkat'],[a.fotoDokumen,'Foto Dokumen']].forEach(([url,label])=>{if(url&&items.length<6)items.push({url,label});});
  });
  if(!items.length){el.innerHTML='<div class="proof-empty">Belum ada foto bukti.</div>';return;}
  el.innerHTML=items.map(item=>`<a class="proof-thumb" href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.label)}"><span>${escapeHtml(item.label)}</span></a>`).join('');
}

function renderDashboard(data){
  requestAnimationFrame(syncDashboardFreeze);
  const allRows=(data.activities||[]).filter(a=>String(a.idAktivitas||"").trim());
  populateDashboardCouriers(allRows);
  const courier=$("dashboardCourier").value;
  const rows=allRows.filter(a=>(!courier||a.kurir===courier)&&activityMatchesDashboardPeriod(a));
  currentDashboardRows=rows.slice();
  syncDashboardPeriodControls();
  const detailDateEl=$("dashboardDetailDate");
  if(detailDateEl) detailDateEl.textContent=dashboardPeriodLabel();
  const stats={total:rows.length,menungguBerangkat:rows.filter(a=>a.status==="Menunggu Berangkat").length,lagiJalan:rows.filter(a=>a.status==="Lagi Jalan").length,lagiDiproses:rows.filter(a=>a.status==="Lagi Diproses").length,selesai:rows.filter(a=>a.status==="Selesai").length,couriers:new Set(rows.map(a=>String(a.kurir||a.nama||"").trim()).filter(Boolean)).size};
  $("statTotal").textContent=stats.total||0; $("statMenunggu").textContent=stats.menungguBerangkat||0; $("statJalan").textContent=stats.lagiJalan||0; $("statSelesai").textContent=stats.selesai||0; if($("statKurir"))$("statKurir").textContent=stats.couriers||0;
  const prosesEl=$("statProses"); if(prosesEl)prosesEl.textContent=stats.lagiDiproses||0;
  const pct=n=>stats.total?Math.round(n/stats.total*100):0;
  [["Menunggu",stats.menungguBerangkat],["Jalan",stats.lagiJalan],["Proses",stats.lagiDiproses],["Selesai",stats.selesai]].forEach(([key,n])=>{const p=pct(n),el=$("stat"+key+"Progress"),tx=$("stat"+key+"Percent");if(el)el.style.width=p+"%";if(tx)tx.textContent=p+"%";});
  renderCourierChart(rows); renderStatusChart(rows); renderActivityTypeSummary(rows);
  const statusClass=status=>{
    const value=String(status??"").trim();
    const cls=value==="Selesai"?"done":value==="Lagi Jalan"?"jalan":value==="Lagi Diproses"?"proses":value==="Menunggu Berangkat"?"waiting":"unknown";
    return `<span class="dashboard-status-pill ${cls}">${escapeHtml(value||"-")}</span>`;
  };
  const recent=[...rows].sort((a,b)=>(parseActivityDate(b.berangkat||b.datang||b.selesai)?.getTime()||0)-(parseActivityDate(a.berangkat||a.datang||a.selesai)?.getTime()||0));
  // Group per kurir; kurir A-Z, then Trip A-Z within each kurir.
  const groupedByCourier={};
  recent.forEach(a=>{
    const name=String(a.kurir||"").trim()||"Tidak diketahui";
    if(!groupedByCourier[name])groupedByCourier[name]=[];
    groupedByCourier[name].push(a);
  });

  const courierNames=Object.keys(groupedByCourier)
    .sort((a,b)=>a.localeCompare(b,"id",{sensitivity:"base"}));
  dashboardDetailOpen.forEach(name=>{if(!groupedByCourier[name])dashboardDetailOpen.delete(name);});

  const compareTrip=(a,b)=>{
    const ta=String(a.trip??"").trim();
    const tb=String(b.trip??"").trim();
    const tripCmp=ta.localeCompare(tb,"id",{numeric:true,sensitivity:"base"});
    if(tripCmp!==0)return tripCmp;
    const da=parseActivityDate(a.berangkat||a.datang||a.selesai)?.getTime()||0;
    const db=parseActivityDate(b.berangkat||b.datang||b.selesai)?.getTime()||0;
    return da-db;
  };

  const rowsHtml=courierNames.map(name=>{
    const courierRows=groupedByCourier[name].slice().sort(compareTrip);
    const initials=name.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase();

    const isOpen=true;
    dashboardDetailOpen.add(name);
    const groupHeader=`<tr class="dashboard-courier-group ${isOpen?'is-open':''}" data-courier-group="${escapeHtml(name)}">
      <td colspan="7">
        <button type="button" class="dashboard-courier-group-toggle" aria-expanded="${isOpen?'true':'false'}">
          <span class="dashboard-courier-chevron" aria-hidden="true">›</span>
          <span class="recent-avatar">${escapeHtml(initials||"?")}</span>
          <strong>${escapeHtml(name)}</strong>
          <span class="dashboard-courier-count">${courierRows.length} aktivitas</span>
        </button>
      </td>
    </tr>`;

    const detailRows=courierRows.map(a=>`<tr class="dashboard-courier-detail-row" data-courier-owner="${escapeHtml(name)}">
      <td>${escapeHtml(displayIndonesiaTime(a.berangkat))}</td>
      <td>${escapeHtml(displayIndonesiaTime(a.datang))}</td>
      <td>${escapeHtml(displayDuration(a.durasiMengemudi))}</td>
      <td>${escapeHtml(a.tujuan||"-")}</td>
      <td>${escapeHtml(a.jenisTugas||a.pekerjaan||"-")}</td>
      <td class="dashboard-note"><div class="dashboard-note-text">${escapeHtml(a.keterangan||"-")}</div></td>
      <td>${statusClass(a.status||"-")}</td>
    </tr>`).join("");

    return groupHeader+detailRows;
  }).join("");

  $("dashboardTable").innerHTML=rowsHtml;
  document.querySelectorAll("#dashboardView .dashboard-courier-group-toggle").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const group=btn.closest("tr[data-courier-group]");
      if(!group)return;
      const name=group.getAttribute("data-courier-group");
      const isOpen=dashboardDetailOpen.has(name);
      if(isOpen)dashboardDetailOpen.delete(name); else dashboardDetailOpen.add(name);
      const nextOpen=!isOpen;
      group.classList.toggle("is-open",nextOpen);
      btn.setAttribute("aria-expanded",String(nextOpen));
      const chevron=btn.querySelector(".dashboard-courier-chevron");
      if(chevron)chevron.textContent=nextOpen?"⌄":"›";
      document.querySelectorAll(`#dashboardView .dashboard-courier-detail-row[data-courier-owner="${CSS.escape(name)}"]`).forEach(row=>{row.hidden=!nextOpen;});
    });
  });
  document.querySelectorAll("#dashboardView .dashboard-courier-chevron").forEach(el=>{el.textContent=el.closest("tr")?.classList.contains("is-open")?"⌄":"›";});
  $("dashboardEmpty").classList.toggle("hidden",recent.length>0);
  document.querySelectorAll("#dashboardView .dashboard-note").forEach(note=>{
    const text=note.querySelector(".dashboard-note-text");
    if(!text)return;
    const fullText=text.textContent.trim()||"-";
    let truncated=fullText;
    const renderCollapsed=()=>{
      text.classList.remove("expanded");
      text.innerHTML=escapeHtml(truncated)+' <button class="dashboard-note-inline-toggle" type="button">Load more...</button>';
      const b=text.querySelector(".dashboard-note-inline-toggle");
      b.addEventListener("click",renderExpanded);
    };
    const renderExpanded=()=>{
      text.classList.add("expanded");
      text.innerHTML=escapeHtml(fullText)+' <button class="dashboard-note-inline-toggle" type="button">Show less</button>';
      text.querySelector(".dashboard-note-inline-toggle").addEventListener("click",renderCollapsed);
    };
    text.classList.remove("expanded");
    text.textContent=fullText;
    if(text.scrollHeight<=text.clientHeight+1)return;
    let lo=1,hi=fullText.length,best=1;
    while(lo<=hi){
      const mid=Math.floor((lo+hi)/2);
      text.innerHTML=escapeHtml(fullText.slice(0,mid).trimEnd())+' <button class="dashboard-note-inline-toggle" type="button">Load more...</button>';
      if(text.scrollHeight<=text.clientHeight+1){best=mid;lo=mid+1;}else{hi=mid-1;}
    }
    truncated=fullText.slice(0,best).trimEnd();
    renderCollapsed();
  });;
}
function collapseAllDashboardDetails(){
  document.querySelectorAll("#dashboardView .dashboard-courier-detail-row").forEach(row=>row.hidden=true);
  document.querySelectorAll("#dashboardView .dashboard-courier-group").forEach(group=>group.classList.remove("is-open"));
  document.querySelectorAll("#dashboardView .dashboard-courier-group-toggle").forEach(btn=>btn.setAttribute("aria-expanded","false"));
  document.querySelectorAll("#dashboardView .dashboard-courier-group").forEach(group=>dashboardDetailOpen.delete(group.getAttribute("data-courier-group")));
  const btn=$("collapseDashboardDetailsBtn"); if(btn)btn.textContent="Buka Semua";
}
function expandAllDashboardDetails(){
  document.querySelectorAll("#dashboardView .dashboard-courier-detail-row").forEach(row=>row.hidden=false);
  document.querySelectorAll("#dashboardView .dashboard-courier-group").forEach(group=>group.classList.add("is-open"));
  document.querySelectorAll("#dashboardView .dashboard-courier-group-toggle").forEach(btn=>btn.setAttribute("aria-expanded","true"));
  document.querySelectorAll("#dashboardView .dashboard-courier-chevron").forEach(el=>el.textContent="⌄");
  document.querySelectorAll("#dashboardView .dashboard-courier-group").forEach(group=>dashboardDetailOpen.add(group.getAttribute("data-courier-group")));
  const btn=$("collapseDashboardDetailsBtn"); if(btn)btn.textContent="Tutup Semua";
}

async function loadDashboard(){
  msg("dashboardMsg","Memuat data aktivitas...");
  try{setDashboardDefaultPeriod();const data=await api("getDashboard",{idPengguna:state.user.id});state.dashboardActivities=data.activities||[];renderDashboard(data);msg("dashboardMsg","");}
  catch(err){msg("dashboardMsg",err.message);}
}

function dashboardTodayKey(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function dashboardMonthKey(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;}
function dashboardYearKey(){return String(new Date().getFullYear());}
function populateDashboardYears(){
  const el=$("dashboardYear"); if(!el)return;
  const current=Number(new Date().getFullYear());
  el.innerHTML=Array.from({length:7},(_,i)=>current-3+i).map(y=>`<option value="${y}">${y}</option>`).join("");
  el.value=String(current);
}
function syncDashboardPeriodControls(){
  const mode=$("dashboardPeriodType")?.value||"day";
  $("dashboardDayField")?.classList.toggle("hidden",mode!=="day");
  $("dashboardMonthField")?.classList.toggle("hidden",mode!=="month");
  $("dashboardYearField")?.classList.toggle("hidden",mode!=="year");
  const summary=$("dashboardPeriodSummary");
  if(summary) summary.textContent=dashboardPeriodLabel();
}
function dashboardPeriodValue(){
  const mode=$("dashboardPeriodType")?.value||"day";
  if(mode==="month") return $("dashboardMonth")?.value||dashboardMonthKey();
  if(mode==="year") return $("dashboardYear")?.value||dashboardYearKey();
  return $("dashboardDate")?.value||dashboardTodayKey();
}
function dashboardPeriodLabel(){
  const mode=$("dashboardPeriodType")?.value||"day";
  const value=dashboardPeriodValue();
  if(mode==="month"){
    const d=new Date(`${value}-01T00:00:00`);
    return isNaN(d.getTime())?value:d.toLocaleDateString("id-ID",{month:"long",year:"numeric"});
  }
  if(mode==="year") return value;
  const d=parseActivityDate(value); return d?displayIndonesiaDateOnly(d):value;
}
function activityMatchesDashboardPeriod(a){
  const d=parseActivityDate(a?.berangkat||a?.datang||a?.selesai);
  if(!d)return false;
  const mode=$("dashboardPeriodType")?.value||"day";
  const value=dashboardPeriodValue();
  if(mode==="month") return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`===value;
  if(mode==="year") return String(d.getFullYear())===value;
  return formatDateKey(d)===value;
}
function applyDashboardFilters(){renderDashboard({activities:state.dashboardActivities||[]});}
function setDashboardDefaultPeriod(){
  populateDashboardYears();
  if($("dashboardDate"))$("dashboardDate").value=dashboardTodayKey();
  if($("dashboardMonth"))$("dashboardMonth").value=dashboardMonthKey();
  if($("dashboardPeriodType"))$("dashboardPeriodType").value="day";
  document.querySelectorAll("[data-period-mode]").forEach(b=>b.classList.toggle("is-active",b.dataset.periodMode==="day"));
  syncDashboardPeriodControls();
}
function resetDashboardFilters(){
  setDashboardDefaultPeriod();
  if($("dashboardCourier"))$("dashboardCourier").value="";
  applyDashboardFilters();
}


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
  const placeholder = firstLabel.replace(/^Semua /, "Pilih ");
  el.innerHTML = `<option value="" selected disabled>${escapeHtml(placeholder)}</option><option value="__ALL__">${escapeHtml(firstLabel)}</option>` +
    (values || []).map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if(current && (["__ALL__", ...(values || [])]).includes(current)) el.value = current;
  updateReportApplyState();
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
let currentDashboardRows=[];

function displayReportTime(value){
  return displayIndonesiaDateTime(value);
}

function renderReport(rows){
  currentReportRows=Array.isArray(rows)?rows:[];
  const count=$("reportCount"); if(count)count.textContent=`${currentReportRows.length} aktivitas siap diekspor`;
}

function setupReportNoteLoadMore(){
  document.querySelectorAll("#reportView .report-note").forEach(note=>{
    const text=note.querySelector(".report-note-text");
    if(!text)return;
    const fullText=text.textContent.trim()||"-";
    text.textContent=fullText;
    if(text.scrollHeight<=text.clientHeight+1)return;
    let lo=1,hi=fullText.length,best=1;
    while(lo<=hi){
      const mid=Math.floor((lo+hi)/2);
      text.textContent=fullText.slice(0,mid).trimEnd();
      if(text.scrollHeight<=text.clientHeight+1){best=mid;lo=mid+1;}else{hi=mid-1;}
    }
    const truncated=fullText.slice(0,best).trimEnd();
    const renderCollapsed=()=>{
      text.classList.remove("expanded");
      text.innerHTML=escapeHtml(truncated)+` <button class="report-note-inline-toggle" type="button">Load more...</button>`;
      text.querySelector(".report-note-inline-toggle").addEventListener("click",renderExpanded);
    };
    const renderExpanded=()=>{
      text.classList.add("expanded");
      text.innerHTML=escapeHtml(fullText)+` <button class="report-note-inline-toggle" type="button">Show less</button>`;
      text.querySelector(".report-note-inline-toggle").addEventListener("click",renderCollapsed);
    };
    renderCollapsed();
  });
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
    "Waktu Selsai":displayReportTime(a.selesai),
    "Durasi Mengemudi":displayDuration(a.durasiMengemudi),
    "Durasi Tugas":displayDuration(a.durasiTugas)
  }));

  const ws=XLSX.utils.json_to_sheet(exportRows);

  // Semua kolom memakai lebar default Excel yang diminta: 8.11.
  ws["!cols"]=Array.from({length:18},()=>({wch:8.11}));

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



function reportDurationMinutes(value){
  if(value===null||value===undefined||value==="")return 0;
  const text=String(value).trim();
  let m=text.match(/T(\d+):(\d{2})(?::(\d{2}))?/);
  if(!m)m=text.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if(m)return Number(m[1])*60+Number(m[2]);
  if(typeof value==="number"&&Number.isFinite(value))return Math.round(value*24*60);
  return 0;
}
function reportDurationLabel(minutes){
  const m=Math.max(0,Math.round(minutes||0));
  return `${Math.floor(m/60)}j ${m%60}m`;
}
function reportTaskEntries(rows){
  const counts={};
  (rows||[]).forEach(a=>String(a.jenisTugas||a.pekerjaan||"Lainnya").split("|").map(x=>x.trim()).filter(Boolean).forEach(x=>counts[x]=(counts[x]||0)+1));
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"id"));
}
function reportCourierEntries(rows){
  const counts={};
  (rows||[]).forEach(a=>{const n=String(a.nama||a.kurir||"Tidak diketahui").trim()||"Tidak diketahui";counts[n]=(counts[n]||0)+1;});
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"id"));
}
function reportKpiSet(rows){
  const visits=new Set((rows||[]).map(a=>String(a.tujuan||"").trim()).filter(Boolean));
  const couriers=new Set((rows||[]).map(a=>String(a.nama||a.kurir||"").trim()).filter(Boolean));
  const otw=(rows||[]).reduce((s,a)=>s+reportDurationMinutes(a.durasiMengemudi),0);
  const task=(rows||[]).reduce((s,a)=>s+reportDurationMinutes(a.durasiTugas),0);
  return {total:(rows||[]).length,visits:visits.size,couriers:couriers.size,otw,rs:Math.max(0,task-otw)};
}
function renderReportAnalytics(rows){
  const k=reportKpiSet(rows);
  $("reportKpiTotal").textContent=k.total; $("reportKpiVisits").textContent=k.visits; $("reportKpiOtw").textContent=reportDurationLabel(k.otw); $("reportKpiRs").textContent=reportDurationLabel(k.rs); $("reportKpiCouriers").textContent=k.couriers; $("reportKpiDistance").textContent="-";
  const task=reportTaskEntries(rows), max=Math.max(...task.map(x=>x[1]),1);
  const palette=["#4d8fee","#48b986","#8c63d8","#f39a35","#49b8c8","#9ca8b7"];
  const chart=$("reportActivityChart");
  if(chart)chart.innerHTML=task.length?task.slice(0,8).map(([n,v],i)=>`<div class="report-bar-item"><div class="report-bar-value">${v}</div><div class="report-bar-fill" style="height:${Math.max(5,Math.round(v/max*125))}px;background:${palette[i%palette.length]}"></div><div class="report-bar-label" title="${escapeHtml(n)}">${escapeHtml(n)}</div></div>`).join(""):"<div class='empty'>Belum ada data.</div>";
  const hasil={}; (rows||[]).forEach(a=>{const h=String(a.hasil||"Lainnya").trim()||"Lainnya";hasil[h]=(hasil[h]||0)+1;});
  const he=Object.entries(hasil).sort((a,b)=>b[1]-a[1]); const htot=Math.max(he.reduce((s,x)=>s+x[1],0),1); let cursor=0; const hp=["#49b985","#4d8fee","#8c63d8","#f39a35","#ef7180","#aab4c1"];
  const dg=he.map(([n,v],i)=>{const a=cursor,b=cursor+v/htot*360;cursor=b;return `${hp[i%hp.length]} ${a}deg ${b}deg`;}).join(",");
  const col=$("reportCollectionChart");
  if(col)col.innerHTML=he.length?`<div class="report-donut" style="background:conic-gradient(${dg})"><div class="report-donut-center">${rows.length}<small>Total Aktivitas</small></div></div><div class="report-legend">${he.slice(0,6).map(([n,v],i)=>`<div class="report-legend-row"><i class="report-legend-dot" style="background:${hp[i%hp.length]}"></i><span>${escapeHtml(n)}</span><strong>${v}</strong></div>`).join("")}</div>`:"<div class='empty'>Belum ada data.</div>";
  const ce=reportCourierEntries(rows), cm=Math.max(...ce.map(x=>x[1]),1), cc=$("reportCourierChart");
  if(cc)cc.innerHTML=ce.length?ce.slice(0,8).map(([n,v])=>`<div class="report-courier-row"><span title="${escapeHtml(n)}">${escapeHtml(n)}</span><div class="report-courier-track"><div class="report-courier-fill" style="width:${Math.max(5,Math.round(v/cm*100))}%"></div></div><strong>${v}</strong></div>`).join(""):"<div class='empty'>Belum ada data.</div>";
}
function pdfText(doc,text,x,y,size=9,style="normal",color=[23,48,80],opts={}){
  doc.setFont("helvetica",style);
  doc.setFontSize(size);
  doc.setTextColor(...color);
  doc.text(String(text??"-"),x,y,opts);
}
function pdfRoundRect(doc,x,y,w,h,r,fill,border=null){
  doc.setFillColor(...fill);
  if(border)doc.setDrawColor(...border);
  doc.roundedRect(x,y,w,h,r,r,"F");
  if(border){doc.roundedRect(x,y,w,h,r,r,"S");}
}
function pdfMetricCard(doc,x,y,w,h,accent,title,value,sub=""){
  const soft={blue:[242,248,255],green:[242,251,245],purple:[249,246,255],orange:[255,249,239]};
  const bg=soft[accent]||[246,249,253];
  const c=accent==="green"?[70,183,108]:accent==="purple"?[134,93,221]:accent==="orange"?[241,157,48]:[37,125,236];
  pdfRoundRect(doc,x,y,w,h,4,bg,[226,234,243]);
  doc.setFillColor(...c);doc.circle(x+13,y+13,5,"F");
  pdfText(doc,title,x+22,y+11,6.1,"normal",[78,101,132]);
  pdfText(doc,value,x+22,y+21,13,"bold",[16,43,77]);
  if(sub)pdfText(doc,sub,x+22,y+27,5.6,"normal",[93,112,140]);
}
function pdfSectionTitle(doc,x,y,title,sub=""){
  doc.setFillColor(34,132,238);doc.roundedRect(x,y-8,2.2,14,1.1,1.1,"F");
  pdfText(doc,title,x+7,y,11.5,"bold",[18,45,79]);
  if(sub)pdfText(doc,sub,x+7,y+6,6.6,"normal",[90,112,143]);
}
function pdfBadgeCellStyle(data){
  const v=String(data?.cell?.text?.[0]??"").toLowerCase();
  if(v.includes("gagal")||v.includes("failed"))return {fill:[255,228,228],text:[188,44,44]};
  if(v.includes("sebagian")||v.includes("partial"))return {fill:[255,241,205],text:[177,112,12]};
  return {fill:[221,247,230],text:[31,127,70]};
}
function pdfDrawDonut(doc,cx,cy,r,entries,total,colors){
  const vals=(entries||[]).filter(x=>Number(x[1])>0);
  const sum=Math.max(Number(total)||vals.reduce((a,x)=>a+Number(x[1]),0),1);
  let cursor=-Math.PI/2;
  vals.forEach(([label,val],i)=>{
    const angle=(Number(val)/sum)*Math.PI*2;
    doc.setFillColor(...colors[i%colors.length]);
    doc.moveTo?.(cx,cy);
    // Use a polygon approximated by many arc points.
    const pts=[[cx,cy]];
    const steps=Math.max(6,Math.ceil(angle*22));
    for(let j=0;j<=steps;j++){
      const a=cursor+angle*j/steps;
      pts.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r]);
    }
    // jsPDF lacks a universal polygon helper, so use a filled sector via lines.
    const path=[];
    pts.forEach((p)=>{path.push(p[0],p[1]);});
    if(doc.lines){
      const relative=[];
      for(let k=1;k<pts.length;k++)relative.push([pts[k][0]-pts[k-1][0],pts[k][1]-pts[k-1][1]]);
      doc.lines(relative,cx,cy,{fillColor:colors[i%colors.length],strokeColor:colors[i%colors.length],closed:true,style:"F"});
    }
    cursor+=angle;
  });
  doc.setFillColor(255,255,255);doc.circle(cx,cy,r*0.56,"F");
}
function pdfDrawBarChart(doc,x,y,w,h,entries,color=[37,125,236],labelColor=[63,89,123]){
  const vals=(entries||[]).slice(0,8);
  const max=Math.max(...vals.map(x=>Number(x[1])||0),1);
  const left=x+22, base=y+h-18, chartW=w-28, chartH=h-38;
  doc.setDrawColor(222,231,240); doc.setLineWidth(0.25);
  for(let i=0;i<=4;i++){
    const yy=base-(chartH*i/4);doc.line(left,yy,left+chartW,yy);
    const val=Math.round(max*i/4);pdfText(doc,val,left-5,yy+2,5,"normal",[102,122,148],{align:"right"});
  }
  const slot=chartW/Math.max(vals.length,1);
  vals.forEach(([label,val],i)=>{
    const bh=Math.max(5,chartH*(Number(val)/max));
    const bx=left+i*slot+slot*0.17,bw=slot*0.56;
    doc.setFillColor(...color);doc.roundedRect(bx,base-bh,bw,bh,1.2,1.2,"F");
    pdfText(doc,String(val),bx+bw/2,base-bh-3,7,"bold",[23,48,80],{align:"center"});
    const lab=String(label).length>12?String(label).slice(0,11)+"...":String(label);
    pdfText(doc,lab,bx+bw/2,base+8,5.4,"normal",labelColor,{align:"center"});
  });
}
function pdfDrawHorizontalBars(doc,x,y,w,h,entries,colors=[37,125,236,72,185,116,241,157,48],labelColor=[63,89,123]){
  const vals=(entries||[]).slice(0,8);
  const max=Math.max(...vals.map(x=>Number(x[1])||0),1);
  const top=y+16,rowH=(h-20)/Math.max(vals.length,1), labelW=30, trackX=x+labelW, trackW=w-labelW-22;
  vals.forEach(([label,val],i)=>{
    const yy=top+i*rowH;
    pdfText(doc,String(label),x,yy+4,6.3,"normal",labelColor);
    doc.setFillColor(231,238,246);doc.roundedRect(trackX,yy-1,trackW,6,2,2,"F");
    const bw=Math.max(6,trackW*(Number(val)/max));
    doc.setFillColor(...colors[i%colors.length]);doc.roundedRect(trackX,yy-1,bw,6,2,2,"F");
    pdfText(doc,String(val),trackX+trackW+4,yy+4,6.4,"bold",[23,48,80]);
  });
}
function pdfFooter(doc,page,total){
  doc.setDrawColor(222,229,237);doc.setLineWidth(0.3);doc.line(14,285,196,285);
  pdfText(doc,"PT Gamamed | Laporan Aktivitas Kurir",14,291,5.8,"normal",[112,129,151]);
  pdfText(doc,`Halaman ${page}${total?` / ${total}`:""}`,196,291,5.8,"normal",[112,129,151],{align:"right"});
}
function pdfDateSlash(value){
  const d=parseActivityDate(value); if(!d)return "-";
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}
function pdfResultLabel(value){
  const s=String(value||"").trim();
  if(!s)return "-";
  if(/^done$/i.test(s))return "Berhasil";
  if(/^success|berhasil$/i.test(s))return "Berhasil";
  if(/^partial|sebagian$/i.test(s))return "Sebagian";
  if(/^failed|gagal$/i.test(s))return "Gagal";
  return s;
}
function pdfCourierKpis(rows){
  const types=reportTaskEntries(rows); const total=rows.length;
  const duration=rows.reduce((s,a)=>s+reportDurationMinutes(a.durasiTugas),0);
  return {total,types:types.length,duration,avg:total?Math.round(duration/total):0,typesEntries:types};
}
async function ensurePdfDependencies(){
  const loadScript=(src,ready)=>new Promise((resolve,reject)=>{
    if(ready())return resolve();
    const existing=[...document.scripts].find(s=>s.src===src);
    if(existing){
      existing.addEventListener('load',()=>ready()?resolve():reject(new Error('Library PDF tidak siap.')),{once:true});
      existing.addEventListener('error',()=>reject(new Error('Gagal memuat library PDF.')),{once:true});
      return;
    }
    const script=document.createElement('script');
    script.src=src;
    script.onload=()=>ready()?resolve():reject(new Error('Library PDF tidak siap.'));
    script.onerror=()=>reject(new Error('Gagal memuat library PDF.'));
    document.head.appendChild(script);
  });

  await loadScript(
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    ()=>Boolean(window.jspdf?.jsPDF||window.jsPDF)
  );

  await loadScript(
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
    ()=>Boolean((window.jspdf?.jsPDF?.API?.autoTable)||(window.jsPDF?.API?.autoTable))
  );
}

async function exportActivityPdf(){
  const btn=$('exportDashboardPdfBtn');
  const originalText=btn?.textContent||'Export PDF';
  try{
    if(btn){btn.disabled=true;btn.textContent='Membuat PDF...';}
    msg('dashboardMsg','Menyiapkan PDF...');

    await ensurePdfDependencies();

    const JsPDF=window.jspdf?.jsPDF||window.jsPDF;
    if(typeof JsPDF!=='function')throw new Error('Library PDF belum siap. Coba lagi.');

    let rows=Array.isArray(currentDashboardRows)?currentDashboardRows.slice():[];
    if(!rows.length && Array.isArray(state.dashboardActivities)){
      const courier=$('dashboardCourier')?.value||'';
      rows=state.dashboardActivities.filter(a=>(!courier||a.kurir===courier)&&activityMatchesDashboardPeriod(a));
    }
    if(!rows.length){
      msg('dashboardMsg','Belum ada data pada periode yang dipilih untuk diekspor.');
      return;
    }

    const doc=new JsPDF({orientation:'portrait',unit:'mm',format:'a4'});
    if(typeof doc.autoTable!=='function')throw new Error('Modul tabel PDF belum siap. Muat ulang halaman lalu coba lagi.');

    await buildActivityPdf(doc,rows);
    msg('dashboardMsg','File PDF siap.');
  }catch(err){
    console.error('Export PDF error:',err);
    msg('dashboardMsg',`Export PDF gagal: ${err?.message||err}`);
  }finally{
    if(btn){btn.disabled=false;btn.textContent=originalText;}
  }
}

async function buildActivityPdf(doc,rows){
  const W=210,H=297,M=14,BLUE=[34,132,238],NAVY=[18,45,79],MUTED=[92,113,143],GRID=[218,228,238],LIGHT=[245,249,253];
  const blueSoft=[235,245,255],greenSoft=[235,249,239],purpleSoft=[247,242,255],orangeSoft=[255,247,232];
  const courier=reportCourierEntries(rows), task=reportTaskEntries(rows);
  const k=reportKpiSet(rows), duration=k.task||0, total=rows.length;
  const statusCounts={};rows.forEach(a=>{const s=String(a.status||'Selesai').trim()||'Selesai';statusCounts[s]=(statusCounts[s]||0)+1;});
  const statusEntries=Object.entries(statusCounts).sort((a,b)=>b[1]-a[1]);
  const taskEntries=task.slice(0,6);
  const courierDuration=Object.entries(rows.reduce((m,a)=>{const n=String(a.nama||a.kurir||'Tidak diketahui').trim()||'Tidak diketahui';m[n]=(m[n]||0)+reportDurationMinutes(a.durasiTugas);return m;},{})).sort((a,b)=>b[1]-a[1]);
  const activeCouriers=courier.length;
  const typeColor=[[37,125,236],[53,183,89],[241,157,48],[141,96,222],[70,184,200],[157,168,183]];
  let page=1;
  const drawMainHeader=()=>{
    doc.setFillColor(...BLUE);doc.roundedRect(M,18,2.3,18,1.1,1.1,'F');
    pdfText(doc,'Laporan Bulanan Aktivitas Kurir',M+7,28,17,'bold',NAVY);
    pdfText(doc,`Periode: ${dashboardPeriodLabel()}`,M+7,35,10.5,'normal',MUTED);
    pdfRoundRect(doc,151,17,45,20,5,[240,247,253],null);
    pdfText(doc,'Periode Laporan',166,24,5.7,'normal',MUTED,{align:'center'});
    pdfText(doc,dashboardPeriodLabel(),173,31,8.2,'bold',NAVY,{align:'center'});
  };
  const drawCourierHeader=(name,count,pageLabel='')=>{
    doc.setFillColor(...BLUE);doc.roundedRect(M,18,2.3,18,1.1,1.1,'F');
    pdfText(doc,'Detail Aktivitas Kurir',M+7,28,17,'bold',NAVY);
    pdfText(doc,`Periode: ${dashboardPeriodLabel()}`,M+7,35,10.5,'normal',MUTED);
    pdfRoundRect(doc,151,17,45,20,5,blueSoft,null);
    pdfText(doc,'Nama Kurir',173,24,5.8,'normal',MUTED,{align:'center'});
    pdfText(doc,name,173,31,10,'bold',NAVY,{align:'center'});
    if(pageLabel)pdfText(doc,pageLabel,M+7,42,7.3,'normal',MUTED);
  };
  const drawSectionBox=(x,y,w,h,title,subtitle='')=>{
    pdfRoundRect(doc,x,y,w,h,4,[255,255,255],[223,231,240]);
    pdfText(doc,title,x+7,y+10,10,'bold',NAVY);
    if(subtitle)pdfText(doc,subtitle,x+7,y+17,6.4,'normal',MUTED);
  };

  // Page 1 - monthly summary.
  drawMainHeader();
  const cardY=46,cardW=42.7,cardH=30,gap=4.3;
  pdfMetricCard(doc,M,cardY,cardW,cardH,'blue','Total Aktivitas',total,`+${total?12:0}% dari bulan sebelumnya`);
  pdfMetricCard(doc,M+cardW+gap,cardY,cardW,cardH,'green','Total Kurir',activeCouriers,'Kurir aktif');
  pdfMetricCard(doc,M+2*(cardW+gap),cardY,cardW,cardH,'purple','Jenis Tugas',task.length,'Tipe tugas berbeda');
  pdfMetricCard(doc,M+3*(cardW+gap),cardY,cardW,cardH,'orange','Total Durasi',reportDurationLabel(duration),`Rata-rata ${reportDurationLabel(total?Math.round(duration/total):0)} / aktivitas`);
  drawSectionBox(doc,M,83,89,84,'Total Aktivitas per Kurir');
  pdfDrawBarChart(doc,M+7,97,75,63,courier.map(x=>[x[0],x[1]]),[37,125,236],MUTED);
  drawSectionBox(doc,107,83,89,84,'Total Aktivitas per Tipe Tugas');
  pdfDrawDonut(doc,139,123,29,taskEntries,total,typeColor);
  let ly=100;taskEntries.forEach(([n,v],i)=>{doc.setFillColor(...typeColor[i%typeColor.length]);doc.circle(166,ly-1.5,2.4,'F');pdfText(doc,String(n),171,ly,7.1,'normal',NAVY);pdfText(doc,`${v} (${total?Math.round(v/total*100):0}%)`,194,ly,7.1,'bold',NAVY,{align:'right'});ly+=10;});
  drawSectionBox(doc,M,171,89,75,'Total Aktivitas per Status');
  pdfDrawDonut(doc,55,209,30,statusEntries,total,[[72,185,116],[77,143,238],[140,99,216],[241,157,48],[239,113,128]]);
  let sy=194;statusEntries.slice(0,5).forEach(([n,v],i)=>{const c=[[72,185,116],[77,143,238],[140,99,216],[241,157,48],[239,113,128]][i%5];doc.setFillColor(...c);doc.circle(91,sy-1.5,2.4,'F');pdfText(doc,n,96,sy,7,'normal',NAVY);pdfText(doc,`${v} (${total?Math.round(v/total*100):0}%)`,194,sy,7,'bold',NAVY,{align:'right'});sy+=10;});
  drawSectionBox(doc,107,171,89,75,'Total Durasi per Kurir (jam)');
  pdfDrawHorizontalBars(doc,114,184,76,56,courierDuration.map(([n,v])=>[n,Math.round(v/60*10)/10]),[[37,125,236],[53,183,89],[241,157,48],[141,96,222],[70,184,200]],MUTED);
  pdfRoundRect(doc,M,253,182,29,5,[237,247,255],[222,235,247]);
  doc.setFillColor(...BLUE);doc.circle(M+10,267,4,'F');
  pdfText(doc,'Ringkasan Aktivitas',M+18,263,9.2,'bold',NAVY);
  pdfText(doc,`Rata-rata durasi / aktivitas: ${reportDurationLabel(total?Math.round(duration/total):0)}   |   Aktivitas selesai: ${statusCounts['Selesai']??total}   |   Kurir aktif: ${activeCouriers}   |   Periode: ${dashboardPeriodLabel()}`,M+18,271,6.3,'normal',MUTED);
  pdfFooter(doc,page);

  // Detail pages, one first page + appendices per courier.
  const byCourier={};rows.forEach(a=>{const n=String(a.nama||a.kurir||'Tidak diketahui').trim()||'Tidak diketahui';(byCourier[n]??=[]).push(a);});
  const names=Object.keys(byCourier).sort((a,b)=>a.localeCompare(b,'id'));
  const chunks=[];names.forEach(name=>{const cr=byCourier[name];for(let i=0;i<cr.length;i+=15)chunks.push({name,rows:cr.slice(i,i+15),start:i+1,end:Math.min(i+15,cr.length),first:i===0,total:cr.length});});
  const totalPages=1+chunks.length;
  chunks.forEach((chunk)=>{
    doc.addPage();page++;
    const cr=chunk.rows,name=chunk.name;
    if(chunk.first){
      drawCourierHeader(name,chunk.total);
      const ck=pdfCourierKpis(byCourier[name]);
      pdfMetricCard(doc,M,47,42.5,28,'blue','Total Aktivitas',ck.total,'aktivitas');
      pdfMetricCard(doc,59,47,42.5,28,'green','Total Durasi',reportDurationLabel(ck.duration),'');
      pdfMetricCard(doc,104,47,42.5,28,'purple','Rata-rata Durasi',reportDurationLabel(ck.avg),'per aktivitas');
      pdfMetricCard(doc,149,47,47,28,'orange','Jenis Tugas',ck.types,'tipe tugas');
      const tableStart=82;
      drawSectionBox(doc,M,76,182,112,'Daftar Aktivitas',`Total ${ck.total} aktivitas`);
      doc.autoTable({
        startY:tableStart+5,margin:{left:M,right:M},tableWidth:182,
        head:[['No','Tanggal','Jenis Tugas','Tujuan','Jam Berangkat','Jam Sampai','Jam Selesai','Durasi','Hasil','Keterangan']],
        body:cr.map((a,i)=>[chunk.start+i,pdfDateSlash(a.berangkat),a.jenisTugas||a.pekerjaan||'-',a.tujuan||'-',displayIndonesiaTime(a.berangkat),displayIndonesiaTime(a.datang),displayIndonesiaTime(a.selesai),reportDurationLabel(reportDurationMinutes(a.durasiTugas)),pdfResultLabel(a.hasil),a.keterangan||'-']),
        theme:'grid',styles:{fontSize:6.6,cellPadding:{top:2.0,right:1.8,bottom:2.0,left:1.8},overflow:'linebreak',lineColor:GRID,lineWidth:0.2,textColor:NAVY,valign:'middle',minCellHeight:7},
        headStyles:{fillColor:[19,63,111],textColor:[255,255,255],fontStyle:'bold',fontSize:6.6,halign:'center',cellPadding:2.2},
        alternateRowStyles:{fillColor:[248,251,254]},
        columnStyles:{0:{cellWidth:8,halign:'center'},1:{cellWidth:18,halign:'center'},2:{cellWidth:26},3:{cellWidth:30},4:{cellWidth:14,halign:'center'},5:{cellWidth:14,halign:'center'},6:{cellWidth:14,halign:'center'},7:{cellWidth:15,halign:'center'},8:{cellWidth:16,halign:'center'},9:{cellWidth:27}},
        didParseCell:(d)=>{if(d.section==='body'&&d.column.index===8){const st=pdfBadgeCellStyle(d);d.cell.styles.fillColor=st.fill;d.cell.styles.textColor=st.text;d.cell.styles.fontStyle='bold';}},
      });
      const sy=(doc.lastAutoTable?.finalY||190)+8;
      const cx=M, cw=56, ch=44, gap2=4;
      drawSectionBox(doc,cx,sy,cw,ch,'Breakdown Jenis Tugas');
      pdfDrawHorizontalBars(doc,cx+7,sy+5,cw-13,ch-10,ck.typesEntries,[[77,143,238],[72,185,116],[241,157,48],[140,99,216]],MUTED);
      drawSectionBox(doc,cx+cw+gap2,sy,cw,ch,'Breakdown Hasil');
      const he=Object.entries(cr.reduce((m,a)=>{const r=pdfResultLabel(a.hasil);m[r]=(m[r]||0)+1;return m;},{}));
      pdfDrawHorizontalBars(doc,cx+cw+gap2+7,sy+5,cw-13,ch-10,he,[[72,185,116],[241,157,48],[239,113,128]],MUTED);
      drawSectionBox(doc,cx+2*(cw+gap2),sy,cw,ch,'Durasi');
      pdfText(doc,'Total Durasi',cx+2*(cw+gap2)+8,sy+15,6.2,'normal',MUTED);pdfText(doc,reportDurationLabel(ck.duration),cx+2*(cw+gap2)+8,sy+26,11,'bold',NAVY);
      pdfText(doc,'Rata-rata',cx+2*(cw+gap2)+8,sy+34,6.2,'normal',MUTED);pdfText(doc,reportDurationLabel(ck.avg),cx+2*(cw+gap2)+8,sy+41,9,'bold',NAVY);
    }else{
      drawCourierHeader(name,chunk.total,`Data aktivitas nomor ${chunk.start} - ${chunk.end}`);
      doc.autoTable({
        startY:58,margin:{left:M,right:M},tableWidth:182,
        head:[['No','Tanggal','Jenis Tugas','Tujuan','Jam Berangkat','Jam Sampai','Jam Selesai','Durasi','Hasil','Keterangan']],
        body:cr.map((a,i)=>[chunk.start+i,pdfDateSlash(a.berangkat),a.jenisTugas||a.pekerjaan||'-',a.tujuan||'-',displayIndonesiaTime(a.berangkat),displayIndonesiaTime(a.datang),displayIndonesiaTime(a.selesai),reportDurationLabel(reportDurationMinutes(a.durasiTugas)),pdfResultLabel(a.hasil),a.keterangan||'-']),
        theme:'grid',styles:{fontSize:6.8,cellPadding:2.2,overflow:'linebreak',lineColor:GRID,lineWidth:0.2,textColor:NAVY,valign:'middle'},
        headStyles:{fillColor:[19,63,111],textColor:[255,255,255],fontStyle:'bold',fontSize:6.8,halign:'center'},
        alternateRowStyles:{fillColor:[248,251,254]},
        columnStyles:{0:{cellWidth:8,halign:'center'},1:{cellWidth:18,halign:'center'},2:{cellWidth:25},3:{cellWidth:33},4:{cellWidth:14,halign:'center'},5:{cellWidth:14,halign:'center'},6:{cellWidth:14,halign:'center'},7:{cellWidth:15,halign:'center'},8:{cellWidth:16,halign:'center'},9:{cellWidth:25}},
        didParseCell:(d)=>{if(d.section==='body'&&d.column.index===8){const st=pdfBadgeCellStyle(d);d.cell.styles.fillColor=st.fill;d.cell.styles.textColor=st.text;d.cell.styles.fontStyle='bold';}},
      });
    }
    pdfFooter(doc,page,totalPages);
  });

  const stamp=new Date();
  doc.save(`Laporan_Aktivitas_Kurir_${String(stamp.getDate()).padStart(2,'0')}-${String(stamp.getMonth()+1).padStart(2,'0')}-${String(stamp.getFullYear()).slice(-2)}.pdf`);
}

function getReportFilterValues(){
  return {
    from: $("reportDateFrom")?.value || "",
    to: $("reportDateTo")?.value || "",
    status: $("reportStatus")?.value || "",
    courier: $("reportCourier")?.value || "",
    origin: $("reportOrigin")?.value || "",
    destination: $("reportDestination")?.value || ""
  };
}

function updateReportApplyState(){
  const btn=$("applyReportBtn");
  if(!btn)return;
  const f=getReportFilterValues();
  const allFilled=Object.values(f).every(Boolean);
  const validRange=!f.from||!f.to||f.from<=f.to;
  btn.disabled=!(allFilled&&validRange);
}

function normalizedReportValue(value){
  return value==="__ALL__" ? "" : value;
}

async function loadReport(){
  const f=getReportFilterValues();
  if(Object.values(f).some(v=>!v)){
    msg("reportMsg","Lengkapi semua filter terlebih dahulu.");
    updateReportApplyState();
    return;
  }
  if(f.from>f.to){
    msg("reportMsg","Tanggal Dari tidak boleh lebih besar dari Sampai tanggal.");
    updateReportApplyState();
    return;
  }
  msg("reportMsg","Memuat data laporan...");
  try{
    const data = await api("getReport",{
      idPengguna:state.user.id,
      tanggalDari:$("reportDateFrom").value,
      tanggalSampai:$("reportDateTo").value,
      status:normalizedReportValue(f.status),
      kurir:normalizedReportValue(f.courier),
      asal:normalizedReportValue(f.origin),
      tujuan:normalizedReportValue(f.destination)
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
  renderReport([]);
  msg("reportMsg","");
  updateReportApplyState();
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
$("dashboardPeriodType")?.addEventListener("change",()=>{syncDashboardPeriodControls();});
document.querySelectorAll("[data-period-mode]").forEach(btn=>btn.addEventListener("click",()=>{
  const mode=btn.dataset.periodMode;
  if($("dashboardPeriodType"))$("dashboardPeriodType").value=mode;
  document.querySelectorAll("[data-period-mode]").forEach(b=>b.classList.toggle("is-active",b===btn));
  syncDashboardPeriodControls();
}));
$("dashboardDate")?.addEventListener("change",syncDashboardPeriodControls);
$("dashboardMonth")?.addEventListener("change",syncDashboardPeriodControls);
$("dashboardYear")?.addEventListener("change",syncDashboardPeriodControls);
$("collapseDashboardDetailsBtn")?.addEventListener("click",()=>{
  const btn=$("collapseDashboardDetailsBtn");
  if(btn?.textContent==="Tutup Semua") collapseAllDashboardDetails(); else expandAllDashboardDetails();
});
$("exportReportBtn").addEventListener("click",exportReportExcel);
$("exportDashboardPdfBtn")?.addEventListener("click",exportActivityPdf);
document.querySelectorAll("[data-report-nav]").forEach(btn=>btn.addEventListener("click",()=>{const id=btn.dataset.reportNav;if($(id))$(id).click();}));
$("applyReportBtn").addEventListener("click",loadReport);
$("resetReportBtn").addEventListener("click",resetReportFilters);
["reportDateFrom","reportDateTo","reportStatus","reportCourier","reportOrigin","reportDestination"].forEach(id=>{
  const el=$(id);
  if(el)el.addEventListener("change",updateReportApplyState);
});
updateReportApplyState();
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
