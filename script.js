const API_URL = "https://script.google.com/macros/s/AKfycbzsVUudEB169aaXav19C7tNPTL6RpPNqQv5E_o6Bn368zbAgetT4L2N7ZZwjA4WTTcv/exec";

let state = { user:null, activity:null, locations:[], dashboardActivities:[] };
let sessionExpiryTimer = null;
const SESSION_LIMIT = 60 * 60 * 1000;
const SESSION_KEY = "aktivitasKurirSession";
const $ = id => document.getElementById(id);

// V69 — tampilan Dashboard/Report dan filter Report diperbarui tanpa mengubah alur sesi.
// Sesi dibuat sederhana seperti aplikasi Transport Schedule yang sudah terbukti stabil.
// LocalStorage tidak hilang saat tab/browser ditutup. Sesi hanya dihapus saat logout
// manual atau umur sesi sudah mencapai 1 jam.
function readSession(){
  try{
    const raw=localStorage.getItem(SESSION_KEY);
    if(!raw)return null;
    const saved=JSON.parse(raw);
    if(!saved || !saved.user || !saved.loginAt)return null;
    if(!Number.isFinite(Number(saved.loginAt)))return null;
    return saved;
  }catch(e){return null;}
}

function writeSession(saved){
  try{localStorage.setItem(SESSION_KEY,JSON.stringify(saved));}catch(e){}
}

function removeStoredSession(){
  try{localStorage.removeItem(SESSION_KEY);}catch(e){}
}

const msg = (id,text="") => { if($(id)) $(id).textContent=text; };

async function api(action,payload={}){
  const res=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action,...payload})});
  const raw=await res.json();

  // Kompatibel dengan respons API yang memakai {ok:true,...} maupun {success:true,...}.
  if(raw && (raw.ok===false || raw.success===false)){
    throw new Error(raw.message||raw.error||"Ada yang belum beres. Coba lagi, ya.");
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

function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}

function clearSession(){
  if(sessionExpiryTimer){clearTimeout(sessionExpiryTimer);sessionExpiryTimer=null;}
  removeStoredSession();
  state={user:null,activity:null,locations:[],dashboardActivities:[]};
}

function logoutToLogin(message=""){
  clearSession();
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("loginForm").reset();
  resetCourierCards();
  $("resultForm").reset();
  $("userForm").reset();
  msg("loginMsg",message);
}

function scheduleSessionExpiry(loginAt){
  if(sessionExpiryTimer)clearTimeout(sessionExpiryTimer);
  const remaining=Number(loginAt)+SESSION_LIMIT-Date.now();
  if(remaining<=0){logoutToLogin("Sesi kamu udah lebih dari 1 jam. Silakan masuk lagi, ya.");return;}
  sessionExpiryTimer=setTimeout(()=>logoutToLogin("Sesi kamu udah lebih dari 1 jam. Silakan masuk lagi, ya."),remaining);
}

function checkSessionExpiry(){
  const saved=readSession();
  if(!saved)return true;
  if(Date.now()-Number(saved.loginAt)>=SESSION_LIMIT){
    logoutToLogin("Sesi kamu udah lebih dari 1 jam. Silakan masuk lagi, ya.");
    return false;
  }
  scheduleSessionExpiry(saved.loginAt);
  return true;
}

function setView(view){
  ["courierView","dashboardView","reportView","usersView"].forEach(id=>$(id).classList.add("hidden"));
  $(view).classList.remove("hidden");
  ["navActivity","navDashboard","navReport","navUsers"].forEach(id=>$(id).classList.remove("active"));
  const nav={courierView:"navActivity",dashboardView:"navDashboard",reportView:"navReport",usersView:"navUsers"}[view];
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
  $("navActivity").classList.toggle("hidden",role!=="Kurir");
  $("navDashboard").classList.toggle("hidden",role!=="Admin"&&role!=="Super User");
  $("navReport").classList.toggle("hidden",role!=="Admin"&&role!=="Super User");
  $("navUsers").classList.toggle("hidden",role!=="Super User");
  $("navActivity").onclick=()=>setView("courierView");
  $("navDashboard").onclick=async()=>{setView("dashboardView");setDashboardDefaultDay();await loadDashboard();requestAnimationFrame(syncDashboardFreeze);};
  $("navReport").onclick=async()=>{setView("reportView");renderReport([]);await loadReportOptions();};
  $("navUsers").onclick=async()=>{setView("usersView");await loadUsers();};
}

function setupCombo(inputId,listId){
  const input=$(inputId),list=$(listId);
  const render=()=>{
    const q=input.value.trim().toLowerCase();
    const items=state.locations.filter(x=>x.toLowerCase().includes(q));
    list.innerHTML=items.length?items.map(x=>`<div class="combo-option" data-value="${escapeHtml(x)}">${escapeHtml(x)}</div>`).join(""):"<div class='combo-empty'>Lokasi nggak ditemukan.</div>";
    list.classList.remove("hidden");
    list.querySelectorAll(".combo-option").forEach(el=>el.onclick=()=>{input.value=el.dataset.value;list.classList.add("hidden");checkStart();});
  };
  input.addEventListener("focus",render);input.addEventListener("input",render);
  

document.addEventListener("click",e=>{if(!list.contains(e.target)&&e.target!==input)list.classList.add("hidden");});
}

async function loadLocations(){const data=await api("getLocations");state.locations=data.locations||[];}

async function loadActiveActivity(){
  try{
    const data=await api("getActiveActivity",{idPengguna:state.user.id});
    if(data.activity){
      state.activity=data.activity;
      showActiveState(state.activity);
      if(state.activity.status==="Lagi Diproses"){
        if(state.activity.hasil){$("hasil").value=state.activity.hasil;}
        if(state.activity.keterangan){$("keterangan").value=state.activity.keterangan;}
        if(state.activity.hasil){$("saveResultBtn").classList.add("hidden");$("completeBtn").classList.remove("hidden");}
      }
    }else{
      resetCourierCards();
    }
  }catch(err){
    msg("activityMsg",err.message);
  }
}

function checkStart(){
  const ready=!!($('jenisTugas').value&&state.locations.includes($('asalSearch').value.trim())&&state.locations.includes($('tujuanSearch').value.trim())&&$('fotoDokumen').files[0]&&$('fotoBerangkat').files[0]);
  $('startBtn').disabled=!ready;
}

function resetCourierCards(){
  $("activityCard").classList.remove("hidden");
  $("activeCard").classList.add("hidden");
  $("resultCard").classList.add("hidden");
  $("activityForm").reset();
  $("startBtn").disabled=true;
  msg("activityMsg","");msg("arrivalMsg","");msg("resultMsg","");
  state.activity=null;
}

function showActivityInfo(activity){
  $("activeInfo").innerHTML=`<div class="info-item"><span>Tipe Tugas</span><strong>${escapeHtml(activity.jenisTugas)}</strong></div><div class="info-item"><span>Rute</span><strong>${escapeHtml(activity.asal)} → ${escapeHtml(activity.tujuan)}</strong></div><div class="info-item"><span>Berangkat</span><strong>${escapeHtml(activity.waktuBerangkat||"-")}</strong></div><div class="info-item"><span>Status</span><strong>${escapeHtml(activity.status)}</strong></div>`;
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
    $("arrivalTime").textContent=`Sampai: ${activity.waktuDatang||"-"}`;
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

  if(Date.now()-Number(saved.loginAt)>=SESSION_LIMIT){
    removeStoredSession();
    return false;
  }

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
      if(lastView==="courierView"){
        setView("courierView");
        await loadActiveActivity();
      }else{
        setView("courierView");
        await loadActiveActivity();
      }
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
  e.preventDefault();msg("loginMsg","Lagi ngecek...");
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
      throw new Error("Data akun belum lengkap. Coba lagi, ya.");
    }

    state.user=user;
    const loginAt=Date.now(); writeSession({user,loginAt,lastView:user.peran==="Kurir"?"courierView":"dashboardView"}); scheduleSessionExpiry(loginAt);
    $("loginView").classList.add("hidden");$("appView").classList.remove("hidden");
    setWelcome(user.nama);setupNav(user.peran);
    if(user.peran==="Kurir"){await loadLocations();setView("courierView");}
    else{setView("dashboardView");await loadDashboard();}
  }catch(err){msg("loginMsg",err.message)}
}

async function handleCreateActivity(e){
  e.preventDefault();if($("startBtn").disabled)return;
  $("startBtn").disabled=true;msg("activityMsg","Lagi nyimpen aktivitas...");
  try{
    const asal=$("asalSearch").value.trim(), tujuan=$("tujuanSearch").value.trim(), jenisTugas=$("jenisTugas").value;
    const data=await api("createActivity",{idPengguna:state.user.id,jenisTugas:jenisTugas,asal,tujuan,fotoDokumen:await fileToBase64($("fotoDokumen").files[0]),fotoBerangkat:await fileToBase64($("fotoBerangkat").files[0])});
    const departure=await api("confirmDeparture",{idAktivitas:data.idAktivitas,idPengguna:state.user.id});
    state.activity={idAktivitas:data.idAktivitas,status:departure.status,jenisTugas:jenisTugas,asal,tujuan,waktuBerangkat:departure.waktuBerangkat};
    $("activityForm").classList.add("hidden");$("activityCard").classList.add("hidden");$("activeCard").classList.remove("hidden");showActivityInfo(state.activity);msg("activityMsg","");
  }catch(err){msg("activityMsg",err.message);checkStart();}
}

async function handleArrival(){
  const input=document.createElement("input");input.type="file";input.accept="image/*";input.style.display="none";document.body.appendChild(input);input.click();
  input.onchange=async()=>{
    if(!input.files[0]){input.remove();return;}
    $("arrivalBtn").disabled=true;msg("arrivalMsg","Lagi nyimpen foto pas sampai...");
    try{
      const data=await api("confirmArrival",{idAktivitas:state.activity.idAktivitas,idPengguna:state.user.id,fotoDatang:await fileToBase64(input.files[0])});
      state.activity.status="Lagi Diproses";
      state.activity.waktuDatang=data.waktuDatang||"-";
      $("activityCard").classList.add("hidden");
      $("activeCard").classList.add("hidden");
      $("resultCard").classList.remove("hidden");
      $("resultStatus").textContent="Lagi Diproses";
      $("arrivalTime").textContent=`Sampai: ${state.activity.waktuDatang}`;
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
  if(!$("hasil").value){msg("resultMsg","Pilih hasil tugasnya dulu, ya.");return;}
  $("saveResultBtn").disabled=true;
  msg("resultMsg","Lagi nyelesaiin tugas...");
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
    resetCourierCards();
    $("activityCard").classList.remove("hidden");
    $("activeCard").classList.add("hidden");
    $("resultCard").classList.add("hidden");
    $("startBtn").disabled=true;
    $("activityMsg").textContent="Tugas selesai. Yuk bikin aktivitas baru.";
    window.scrollTo({top:0,behavior:"smooth"});
  }catch(err){
    msg("resultMsg",err.message);
    $("saveResultBtn").disabled=false;
  }
}

async function handleComplete(){
  $("completeBtn").disabled=true;msg("resultMsg","Lagi nyelesaiin tugas...");
  try{const data=await api("completeActivity",{idAktivitas:state.activity.idAktivitas,idPengguna:state.user.id});state.activity.status="Selesai";
      state.activity.waktuSelsai=data.waktuSelsai||"-";
      resetCourierCards();
      $("activityCard").classList.remove("hidden");
      $("activeCard").classList.add("hidden");
      $("resultCard").classList.add("hidden");
      $("startBtn").disabled=true;
      $("activityMsg").textContent="Tugas selesai. Yuk bikin aktivitas baru.";
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

function renderActivityChart(rows){
  const chart=$("activityChart");
  if(!rows.length){chart.innerHTML='<div class="chart-empty">Belum ada aktivitas buat ditampilin.</div>';return;}
  const days={};
  rows.forEach(a=>{
    const d=parseActivityDate(a.berangkat||a.datang||a.selesai); if(!d)return;
    const key=formatDateKey(d); if(!days[key])days[key]={total:0,done:0};
    days[key].total++; if(a.status==="Selesai")days[key].done++;
  });
  const entries=Object.entries(days).sort((a,b)=>a[0].localeCompare(b[0])).slice(-10);
  const max=Math.max(...entries.map(([,v])=>v.total),1);
  chart.innerHTML=entries.map(([key,v])=>{
    const d=new Date(key+"T00:00:00");
    const label=d.toLocaleDateString("id-ID",{day:"2-digit",month:"short"});
    const totalH=Math.max(10,Math.round(v.total/max*170));
    const doneH=Math.max(v.done?6:0,Math.round(v.done/max*170));
    const active=v.total-v.done;
    return `<div class="chart-col"><div class="chart-value">${v.total}</div><div class="chart-bars"><div class="chart-bar total" style="height:${totalH}px"><span class="chart-overlay done" style="height:${doneH}px"></span></div></div><div class="chart-label">${escapeHtml(label)}</div><div class="chart-active">${active} belum selesai</div></div>`;
  }).join("");
}

function displayTimeOnly(value){
  if(!value)return "-";
  const text=String(value).trim();
  const d=new Date(text);
  if(!isNaN(d.getTime()))return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  const m=text.match(/(?:T|\\s)(\\d{1,2}):(\\d{2})(?::\\d{2})?/);
  if(m)return `${String(m[1]).padStart(2,"0")}:${m[2]}`;
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
  $("chartSubtitle").textContent="Aktivitas sesuai filter yang dipilih.";
  const photoLink=(url)=>url?`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Lihat Foto</a>`:"-";
  $("dashboardTable").innerHTML=rows.map(a=>`<tr>
    <td>${escapeHtml(a.kurir||"-")}</td>
    <td>${escapeHtml(a.jenisTugas||"-")}</td>
    <td>${escapeHtml(a.tujuan||"-")}</td>
    <td>${photoLink(a.fotoDokumen)}</td>
    <td>${photoLink(a.fotoBerangkat)}</td>
    <td>${escapeHtml(displayTimeOnly(a.berangkat))}</td>
    <td>${photoLink(a.fotoDatang)}</td>
    <td>${escapeHtml(displayTimeOnly(a.datang))}</td>
    <td>${escapeHtml(displayTimeOnly(a.selesai))}</td>
    <td>${escapeHtml(a.durasiMengemudi||"-")}</td>
    <td>${escapeHtml(a.durasiTugas||"-")}</td>
  </tr>`).join("");
  $("dashboardEmpty").classList.toggle("hidden",rows.length>0);
}

async function loadDashboard(){
  msg("dashboardMsg","Lagi ambil data aktivitas...");
  try{setDashboardDefaultDay();const data=await api("getDashboard",{idPengguna:state.user.id});state.dashboardActivities=data.activities||[];renderDashboard(data);msg("dashboardMsg","");}
  catch(err){msg("dashboardMsg",err.message);}
}

function applyDashboardFilters(){renderDashboard({activities:state.dashboardActivities||[]});}
function todayKey(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function setDashboardDefaultDay(){if(!$("dashboardDate").value)$("dashboardDate").value=todayKey();}
function resetDashboardFilters(){$("dashboardDate").value=todayKey();$("dashboardCourier").value="";applyDashboardFilters();}


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
  if(!value)return "-";
  const text=String(value).trim();
  const d=new Date(text);
  if(!isNaN(d.getTime())){
    const dd=String(d.getDate()).padStart(2,"0");
    const mm=String(d.getMonth()+1).padStart(2,"0");
    const yyyy=d.getFullYear();
    const hh=String(d.getHours()).padStart(2,"0");
    const mi=String(d.getMinutes()).padStart(2,"0");
    const ss=String(d.getSeconds()).padStart(2,"0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
  }
  const m=text.match(/(\d{1,2})[\/:](\d{1,2})[\/:](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const year=String(m[3]).length===2?`20${m[3]}`:m[3];
    return `${String(m[1]).padStart(2,"0")}/${String(m[2]).padStart(2,"0")}/${year} ${String(m[4]).padStart(2,"0")}:${m[5]}:${m[6]||"00"}`;
  }
  return text;
}

function renderReport(rows){
  currentReportRows=Array.isArray(rows)?rows:[];
  const photoLink=(url)=>url?`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Lihat Foto</a>`:"-";
  $("reportTable").innerHTML = currentReportRows.map(a=>`<tr>
    <td>${escapeHtml(a.idAktivitas||"")}</td>
    <td>${statusClass(a.status)}</td>
    <td>${escapeHtml(a.idPengguna||"")}</td>
    <td>${escapeHtml(a.nama||a.kurir||"")}</td>
    <td>${escapeHtml(a.jenisTugas||"")}</td>
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
    <td>${escapeHtml(a.durasiMengemudi||"-")}</td>
    <td>${escapeHtml(a.durasiTugas||"-")}</td>
  </tr>`).join("");
  $("reportEmpty").classList.toggle("hidden",currentReportRows.length>0);
  $("reportCount").textContent = `${currentReportRows.length} aktivitas`;
}

function exportReportExcel(){
  if(!currentReportRows.length){
    msg("reportMsg","Belum ada data yang bisa diekspor.");
    return;
  }
  if(typeof XLSX==="undefined"){
    msg("reportMsg","Fitur Excel belum siap. Coba refresh halaman dulu, ya.");
    return;
  }

  const exportRows=currentReportRows.map(a=>({
    "ID Aktivitas":a.idAktivitas||"",
    "Status":a.status||"",
    "ID Pengguna":a.idPengguna||"",
    "Nama":a.nama||a.kurir||"",
    "Jenis Tugas":a.jenisTugas||"",
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
    "Durasi Mengemudi":a.durasiMengemudi||"",
    "Durasi Tugas":a.durasiTugas||""
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
  msg("reportMsg","File Excel udah siap.");
}

async function loadReport(){
  msg("reportMsg","Lagi ambil data report...");
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
  renderReport([]);
  msg("reportMsg","");
}

async function loadUsers(){
  msg("userMsg","Lagi ambil daftar pengguna...");
  try{
    const data=await api("getUsers",{idPengguna:state.user.id});
    const list=$("usersList");
    list.innerHTML=(data.users||[]).map(u=>`<div class="user-row"><div class="user-main"><strong>${escapeHtml(u.nama)}</strong><div class="user-meta">${escapeHtml(u.idPengguna)} · ${escapeHtml(u.peran)} · ${u.status?"Aktif":"Nggak aktif"}</div></div><div class="user-actions"><button class="ghost status-user" data-id="${escapeHtml(u.idPengguna)}" data-status="${u.status}">${u.status?"Nonaktifkan":"Aktifkan"}</button><button class="danger delete-user" data-id="${escapeHtml(u.idPengguna)}">Hapus</button></div></div>`).join("")||"<div class='empty'>Belum ada pengguna.</div>";
    list.querySelectorAll(".status-user").forEach(btn=>btn.onclick=async()=>{btn.disabled=true;try{await api("updateUserStatus",{idPengguna:state.user.id,id:btn.dataset.id,status:btn.dataset.status!=="true"});await loadUsers();}catch(err){msg("userMsg",err.message);btn.disabled=false;}});
    list.querySelectorAll(".delete-user").forEach(btn=>btn.onclick=async()=>{if(!confirm("Yakin mau hapus pengguna ini?"))return;btn.disabled=true;try{await api("deleteUser",{idPengguna:state.user.id,id:btn.dataset.id});await loadUsers();}catch(err){msg("userMsg",err.message);btn.disabled=false;}});
    msg("userMsg","");
  }catch(err){msg("userMsg",err.message)}
}

async function handleCreateUser(e){
  e.preventDefault();msg("userMsg","Lagi nambahin pengguna...");
  try{await api("createUser",{idPengguna:state.user.id,id:$("userId").value.trim(),nama:$("userName").value.trim(),pin:$("userPin").value.trim(),peran:$("userRole").value});$("userForm").reset();msg("userMsg","Pengguna berhasil ditambahkan.");await loadUsers();}
  catch(err){msg("userMsg",err.message)}
}

$("loginForm").addEventListener("submit",handleLogin);
$("logoutBtn").addEventListener("click",()=>logoutToLogin(""));
setupCombo("asalSearch","asalList");setupCombo("tujuanSearch","tujuanList");
["jenisTugas","asalSearch","tujuanSearch","fotoDokumen","fotoBerangkat"].forEach(id=>$(id).addEventListener("input",checkStart));
$("activityForm").addEventListener("submit",handleCreateActivity);
$("arrivalBtn").addEventListener("click",handleArrival);
$("resultForm").addEventListener("submit",handleSaveResult);
$("completeBtn").addEventListener("click",handleComplete);
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
