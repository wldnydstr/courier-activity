const API_URL = "https://script.google.com/macros/s/AKfycbw8XCphf76_VVMSIRDpuVACAppuk5NlxKxQL91hD03nTOIooU0wrM21Wmltbuhay6y9/exec";

let state = { user:null, activity:null, locations:[] };
const $ = id => document.getElementById(id);
const msg = (id,text="") => { if($(id)) $(id).textContent=text; };

async function api(action,payload={}){
  const res=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action,...payload})});
  const data=await res.json();
  if(!data.ok) throw new Error(data.message||"Ada yang belum beres. Coba lagi, ya.");
  return data;
}

function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    if(!file)return resolve(null);
    const reader=new FileReader();
    reader.onload=()=>resolve({name:file.name,mimeType:file.type,data:reader.result.split(",")[1]});
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}

function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}

function setView(view){
  ["courierView","dashboardView","reportView","usersView"].forEach(id=>$(id).classList.add("hidden"));
  $(view).classList.remove("hidden");
  ["navActivity","navDashboard","navReport","navUsers"].forEach(id=>$(id).classList.remove("active"));
  const nav={courierView:"navActivity",dashboardView:"navDashboard",reportView:"navReport",usersView:"navUsers"}[view];
  if(nav)$(nav).classList.add("active");
}

function setupNav(role){
  $("nav").classList.remove("hidden");
  $("navActivity").classList.toggle("hidden",role!=="Kurir");
  $("navDashboard").classList.toggle("hidden",role!=="Admin"&&role!=="Super User");
  $("navReport").classList.toggle("hidden",role!=="Admin"&&role!=="Super User");
  $("navUsers").classList.toggle("hidden",role!=="Super User");
  $("navActivity").onclick=()=>setView("courierView");
  $("navDashboard").onclick=async()=>{setView("dashboardView");await loadDashboard();};
  $("navReport").onclick=async()=>{setView("reportView");await loadReportOptions();await loadReport();};
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

function checkStart(){
  const ready=!!($('jenisPekerjaan').value&&state.locations.includes($('asalSearch').value.trim())&&state.locations.includes($('tujuanSearch').value.trim())&&$('fotoDokumen').files[0]&&$('fotoBerangkat').files[0]);
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
  $("activeInfo").innerHTML=`<div class="info-item"><span>Pekerjaan</span><strong>${escapeHtml(activity.jenisPekerjaan)}</strong></div><div class="info-item"><span>Rute</span><strong>${escapeHtml(activity.asal)} → ${escapeHtml(activity.tujuan)}</strong></div><div class="info-item"><span>Berangkat</span><strong>${escapeHtml(activity.waktuBerangkat||"-")}</strong></div><div class="info-item"><span>Status</span><strong>${escapeHtml(activity.status)}</strong></div>`;
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

async function handleLogin(e){
  e.preventDefault();msg("loginMsg","Lagi ngecek...");
  try{
    const data=await api("login",{idPengguna:$("loginId").value.trim(),pin:$("loginPin").value.trim()});
    state.user=data.user;
    $("loginView").classList.add("hidden");$("appView").classList.remove("hidden");
    $("welcomeName").textContent=data.user.nama;$("roleLabel").textContent=data.user.peran;setupNav(data.user.peran);
    if(data.user.peran==="Kurir"){await loadLocations();setView("courierView");}
    else{setView("dashboardView");await loadDashboard();}
  }catch(err){msg("loginMsg",err.message)}
}

async function handleCreateActivity(e){
  e.preventDefault();if($("startBtn").disabled)return;
  $("startBtn").disabled=true;msg("activityMsg","Lagi nyimpen aktivitas...");
  try{
    const asal=$("asalSearch").value.trim(), tujuan=$("tujuanSearch").value.trim(), pekerjaan=$("jenisPekerjaan").value;
    const data=await api("createActivity",{user:state.user,jenisPekerjaan:pekerjaan,asal,tujuan,fotoDokumen:await fileToBase64($("fotoDokumen").files[0])});
    const departure=await api("confirmDeparture",{idAktivitas:data.idAktivitas,fotoBerangkat:await fileToBase64($("fotoBerangkat").files[0])});
    state.activity={idAktivitas:data.idAktivitas,status:departure.status,jenisPekerjaan:pekerjaan,asal,tujuan,waktuBerangkat:departure.waktuBerangkat};
    $("activityForm").classList.add("hidden");$("activityCard").classList.add("hidden");$("activeCard").classList.remove("hidden");showActivityInfo(state.activity);msg("activityMsg","");
  }catch(err){msg("activityMsg",err.message);checkStart();}
}

async function handleArrival(){
  const input=document.createElement("input");input.type="file";input.accept="image/*";input.style.display="none";document.body.appendChild(input);input.click();
  input.onchange=async()=>{
    if(!input.files[0]){input.remove();return;}
    $("arrivalBtn").disabled=true;msg("arrivalMsg","Lagi nyimpen foto pas sampai...");
    try{
      const data=await api("confirmArrival",{idAktivitas:state.activity.idAktivitas,fotoDatang:await fileToBase64(input.files[0])});
      state.activity.status=data.status;state.activity.waktuDatang=data.waktuDatang;showActiveState(state.activity);msg("arrivalMsg","");
    }catch(err){msg("arrivalMsg",err.message);$("arrivalBtn").disabled=false;}
    input.remove();
  };
}

async function handleSaveResult(e){
  e.preventDefault();
  if(!$("hasil").value){msg("resultMsg","Pilih hasil pekerjaannya dulu, ya.");return;}
  $("saveResultBtn").disabled=true;msg("resultMsg","Lagi nyimpen hasil...");
  try{await api("saveResult",{idAktivitas:state.activity.idAktivitas,hasil:$("hasil").value,keterangan:$("keterangan").value.trim()});$("saveResultBtn").classList.add("hidden");$("completeBtn").classList.remove("hidden");msg("resultMsg","Hasilnya udah tersimpan. Tinggal selesain tugas.");}
  catch(err){msg("resultMsg",err.message);$("saveResultBtn").disabled=false;}
}

async function handleComplete(){
  $("completeBtn").disabled=true;msg("resultMsg","Lagi nyelesaiin tugas...");
  try{const data=await api("completeActivity",{idAktivitas:state.activity.idAktivitas});state.activity.status=data.status;state.activity.waktuSelsai=data.waktuSelsai;resetCourierCards();msg("activityMsg","Tugas selesai. Kamu bisa bikin aktivitas baru sekarang.");}
  catch(err){msg("resultMsg",err.message);$("completeBtn").disabled=false;}
}

function statusClass(status){return `<span class="status-pill">${escapeHtml(status)}</span>`;}

function renderDashboard(data){
  const stats=data.stats||{};
  $("statTotal").textContent=stats.total||0;$("statPending").textContent=stats.menungguBerangkat||0;$("statDriving").textContent=stats.lagiJalan||0;$("statProgress").textContent=stats.lagiDiproses||0;$("statDone").textContent=stats.selesai||0;
  const rows=data.activities||[];
  $("dashboardTable").innerHTML=rows.map(a=>`<tr><td>${statusClass(a.status)}</td><td>${escapeHtml(a.nama)}</td><td>${escapeHtml(a.jenisPekerjaan)}</td><td>${escapeHtml(a.asal)} → ${escapeHtml(a.tujuan)}</td><td>${escapeHtml(a.waktuBerangkat||"-")}</td><td>${escapeHtml(a.waktuDatang||"-")}</td><td>${escapeHtml(a.waktuSelsai||"-")}</td><td>${escapeHtml(a.hasil||"-")}</td><td>${escapeHtml(a.keterangan||"-")}</td></tr>`).join("");
  $("dashboardEmpty").classList.toggle("hidden",rows.length>0);
}

async function loadDashboard(){
  msg("dashboardMsg","Lagi ambil data aktivitas...");
  try{const data=await api("getDashboard",{user:state.user});renderDashboard(data);msg("dashboardMsg","");}
  catch(err){msg("dashboardMsg",err.message);}
}


function populateReportOptions(data){
  const couriers = data.couriers || [];
  const origins = data.origins || [];
  const destinations = data.destinations || [];

  $("reportCourier").innerHTML = '<option value="">Semua kurir</option>' +
    couriers.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");

  $("reportOrigin").innerHTML = '<option value="">Semua asal</option>' +
    origins.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");

  $("reportDestination").innerHTML = '<option value="">Semua tujuan</option>' +
    destinations.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");
}

async function loadReportOptions(){
  try{
    const data = await api("getReportOptions",{user:state.user});
    populateReportOptions(data);
  }catch(err){
    msg("reportMsg",err.message);
  }
}

function renderReport(rows){
  $("reportTable").innerHTML = rows.map(a=>`<tr>
    <td>${escapeHtml(a.idAktivitas)}</td>
    <td>${statusClass(a.status)}</td>
    <td>${escapeHtml(a.nama)}</td>
    <td>${escapeHtml(a.jenisPekerjaan)}</td>
    <td>${escapeHtml(a.asal)}</td>
    <td>${escapeHtml(a.tujuan)}</td>
    <td>${escapeHtml(a.waktuBerangkat||"-")}</td>
    <td>${escapeHtml(a.waktuDatang||"-")}</td>
    <td>${escapeHtml(a.waktuSelsai||"-")}</td>
    <td>${escapeHtml(a.hasil||"-")}</td>
    <td>${escapeHtml(a.keterangan||"-")}</td>
  </tr>`).join("");
  $("reportEmpty").classList.toggle("hidden",rows.length>0);
  $("reportCount").textContent = `${rows.length} aktivitas`;
}

async function loadReport(){
  msg("reportMsg","Lagi ambil data report...");
  try{
    const data = await api("getReport",{
      user:state.user,
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
  msg("userMsg","Lagi ambil daftar pengguna...");
  try{
    const data=await api("getUsers",{user:state.user});
    const list=$("usersList");
    list.innerHTML=(data.users||[]).map(u=>`<div class="user-row"><div class="user-main"><strong>${escapeHtml(u.nama)}</strong><div class="user-meta">${escapeHtml(u.idPengguna)} · ${escapeHtml(u.peran)} · ${u.status?"Aktif":"Nggak aktif"}</div></div><div class="user-actions"><button class="ghost status-user" data-id="${escapeHtml(u.idPengguna)}" data-status="${u.status}">${u.status?"Nonaktifkan":"Aktifkan"}</button><button class="danger delete-user" data-id="${escapeHtml(u.idPengguna)}">Hapus</button></div></div>`).join("")||"<div class='empty'>Belum ada pengguna.</div>";
    list.querySelectorAll(".status-user").forEach(btn=>btn.onclick=async()=>{btn.disabled=true;try{await api("updateUserStatus",{user:state.user,idPengguna:btn.dataset.id,status:btn.dataset.status!=="true"});await loadUsers();}catch(err){msg("userMsg",err.message);btn.disabled=false;}});
    list.querySelectorAll(".delete-user").forEach(btn=>btn.onclick=async()=>{if(!confirm("Yakin mau hapus pengguna ini?"))return;btn.disabled=true;try{await api("deleteUser",{user:state.user,idPengguna:btn.dataset.id});await loadUsers();}catch(err){msg("userMsg",err.message);btn.disabled=false;}});
    msg("userMsg","");
  }catch(err){msg("userMsg",err.message)}
}

async function handleCreateUser(e){
  e.preventDefault();msg("userMsg","Lagi nambahin pengguna...");
  try{await api("createUser",{user:state.user,idPengguna:$("userId").value.trim(),nama:$("userName").value.trim(),pin:$("userPin").value.trim(),peran:$("userRole").value});$("userForm").reset();msg("userMsg","Pengguna berhasil ditambahkan.");await loadUsers();}
  catch(err){msg("userMsg",err.message)}
}

$("loginForm").addEventListener("submit",handleLogin);
$("logoutBtn").addEventListener("click",()=>{state={user:null,activity:null,locations:[]};$("appView").classList.add("hidden");$("loginView").classList.remove("hidden");$("loginForm").reset();resetCourierCards();$("resultForm").reset();$("userForm").reset();msg("loginMsg","");});
setupCombo("asalSearch","asalList");setupCombo("tujuanSearch","tujuanList");
["jenisPekerjaan","asalSearch","tujuanSearch","fotoDokumen","fotoBerangkat"].forEach(id=>$(id).addEventListener("input",checkStart));
$("activityForm").addEventListener("submit",handleCreateActivity);
$("arrivalBtn").addEventListener("click",handleArrival);
$("resultForm").addEventListener("submit",handleSaveResult);
$("completeBtn").addEventListener("click",handleComplete);
$("refreshDashboardBtn").addEventListener("click",loadDashboard);
$("refreshReportBtn").addEventListener("click",async()=>{await loadReportOptions();await loadReport();});
$("applyReportBtn").addEventListener("click",loadReport);
$("resetReportBtn").addEventListener("click",resetReportFilters);
$("userForm").addEventListener("submit",handleCreateUser);
$("refreshUsersBtn").addEventListener("click",loadUsers);
