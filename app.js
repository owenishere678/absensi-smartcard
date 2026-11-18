/**
 * SMART ATTENDANCE SYSTEM - FRONTEND CONTROLLER
 * Terintegrasi dengan Google Apps Script Web App API
 */

// ⚠️ WAJIB ISI DENGAN URL WEB APP APPS SCRIPT ANDA (BERAKHIRAN /exec)
const API_URL = "https://script.google.com/macros/s/AKfycbxEnsLseo3I3WQ51J8QdcJnN5EixhQdR5nINufAbib0etPJ7qMoXbFRobwG0_Jq0jGqVw/exec";

const STATE = {
  currentMethod: "RFID",
  isProcessing: false,
  qrScannerInstance: null,
  isCameraRunning: false,
  nfcReaderActive: false,
  selectedManualStudent: null,
  modalTimer: null,
  adminCredentials: null,
  adminRawHistory: [],
  offlineQueue: JSON.parse(localStorage.getItem("smart_attendance_queue") || "[]")
};

const DEFAULT_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="190" viewBox="0 0 150 190">
    <rect width="150" height="190" fill="#e2e8f0"/>
    <circle cx="75" cy="68" r="32" fill="#94a3b8"/>
    <path d="M25 170 C25 130, 125 130, 125 170" fill="#94a3b8"/>
  </svg>`
);

/* ==================== INISIALISASI APLIKASI ==================== */
document.addEventListener("DOMContentLoaded", () => {
  startLiveClock();
  setupHardwareInputs();
  checkNfcSupport();
  updateOfflineBanner();
  checkDatabaseConnection();

  // Sinkronisasi status database & ringkasan setiap 45 detik
  setInterval(checkDatabaseConnection, 45000);
});

/* ==================== JAM REAL-TIME ASIA/JAKARTA ==================== */
function startLiveClock() {
  const updateClock = () => {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(now);

    const timeStr = new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now).replace(/\./g, ":");

    document.getElementById("liveDate").textContent = dateStr;
    document.getElementById("liveClock").textContent = `${timeStr} WIB`;
  };

  updateClock();
  setInterval(updateClock, 1000);
}

/* ==================== KONEKSI & RINGKASAN GOOGLE SHEETS ==================== */
async function checkDatabaseConnection() {
  const dot = document.getElementById("dbDot");
  const text = document.getElementById("dbStatusText");

  if (!API_URL || API_URL.includes("TEMPEL_URL")) {
    dot.className = "dot offline";
    text.textContent = "URL Google Apps Script belum dikonfigurasi di app.js";
    return;
  }

  try {
    const res = await fetch(`${API_URL}?action=ping`, { method: "GET", redirect: "follow" });
    const data = await res.json();

    if (data.status === "ok") {
      dot.className = "dot online";
      text.textContent = "Terhubung ke Google Sheets (DATABASE SISWA & RIWAYAT)";
      if (data.summary) renderTopStats(data.summary);
      if (STATE.offlineQueue.length > 0) flushOfflineQueue();
    } else {
      throw new Error("Respon tidak valid");
    }
  } catch (err) {
    dot.className = "dot offline";
    text.textContent = "KONEKSI DATABASE TERGANGGU, SILAKAN COBA KEMBALI";
  }
}

function renderTopStats(summary) {
  document.getElementById("statPresentCount").textContent = summary.presentOnTime ?? 0;
  document.getElementById("statLateCount").textContent = summary.lateToday ?? 0;
  document.getElementById("statTotalCount").textContent = summary.totalAttended ?? 0;
}

/* ==================== PERPINDAHAN 4 METODE ABSENSI ==================== */
function selectMethod(method) {
  STATE.currentMethod = method;

  // Matikan kamera QR jika berpindah keluar dari tab QR CODE
  if (method !== "QR CODE" && STATE.isCameraRunning) {
    stopQrCamera();
  }

  // Update tombol aktif
  document.querySelectorAll(".method-btn").forEach(btn => btn.classList.remove("active"));
  document.querySelectorAll(".method-panel").forEach(panel => panel.classList.remove("active"));

  if (method === "RFID") {
    document.getElementById("tab-rfid").classList.add("active");
    document.getElementById("panel-rfid").classList.add("active");
    setTimeout(() => document.getElementById("rfidInput").focus(), 100);
  } else if (method === "QR CODE") {
    document.getElementById("tab-qr").classList.add("active");
    document.getElementById("panel-qr").classList.add("active");
    setTimeout(() => document.getElementById("qrHardwareInput").focus(), 100);
  } else if (method === "NFC") {
    document.getElementById("tab-nfc").classList.add("active");
    document.getElementById("panel-nfc").classList.add("active");
  } else if (method === "MANUAL") {
    document.getElementById("tab-manual").classList.add("active");
    document.getElementById("panel-manual").classList.add("active");
    document.getElementById("manualPreviewCard").classList.add("hidden");
    STATE.selectedManualStudent = null;
    setTimeout(() => document.getElementById("manualNisInput").focus(), 100);
  }
}

/* ==================== 1. RFID (KEYBOARD EMULATION & WEB SERIAL) ==================== */
function setupHardwareInputs() {
  const rfidInput = document.getElementById("rfidInput");
  rfidInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = rfidInput.value.trim();
      rfidInput.value = "";
      if (val) submitAttendance(val, "RFID");
    }
  });

  const qrInput = document.getElementById("qrHardwareInput");
  qrInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = qrInput.value.trim();
      qrInput.value = "";
      if (val) submitAttendance(val, "QR CODE");
    }
  });
}

async function connectWebSerial() {
  const statusEl = document.getElementById("serialStatus");
  if (!("serial" in navigator)) {
    alert("Browser ini tidak mendukung Web Serial API. Gunakan Google Chrome / Microsoft Edge di desktop, atau gunakan RFID Reader mode USB Keyboard.");
    return;
  }

  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    statusEl.textContent = "✅ RFID Reader Serial Terhubung!";

    const textDecoder = new TextDecoderStream();
    port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();

    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buffer += value;
        if (buffer.includes("\n") || buffer.includes("\r")) {
          const uid = buffer.trim();
          buffer = "";
          if (uid && STATE.currentMethod === "RFID") {
            submitAttendance(uid, "RFID");
          }
        }
      }
    }
  } catch (err) {
    statusEl.textContent = "⚠️ Koneksi Serial dibatalkan atau gagal.";
  }
}

/* ==================== 2. QR CODE (KAMERA LAPTOP/HP) ==================== */
function startQrCamera() {
  const container = document.getElementById("qrReaderContainer");
  const btnStart = document.getElementById("btnStartCamera");
  const btnStop = document.getElementById("btnStopCamera");

  if (typeof Html5Qrcode === "undefined") {
    alert("Library kamera QR gagal dimuat. Pastikan koneksi internet aktif.");
    return;
  }

  container.classList.remove("hidden");
  btnStart.classList.add("hidden");
  btnStop.classList.remove("hidden");

  STATE.qrScannerInstance = new Html5Qrcode("qrReaderContainer");
  STATE.qrScannerInstance.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      if (!STATE.isProcessing && decodedText) {
        submitAttendance(decodedText.trim(), "QR CODE");
      }
    },
    () => {} // Abaikan frame yang belum terbaca
  ).then(() => {
    STATE.isCameraRunning = true;
  }).catch((err) => {
    alert("Tidak dapat mengakses kamera: " + err);
    stopQrCamera();
  });
}

function stopQrCamera() {
  const container = document.getElementById("qrReaderContainer");
  const btnStart = document.getElementById("btnStartCamera");
  const btnStop = document.getElementById("btnStopCamera");

  if (STATE.qrScannerInstance && STATE.isCameraRunning) {
    STATE.qrScannerInstance.stop().then(() => {
      STATE.qrScannerInstance.clear();
      STATE.isCameraRunning = false;
    }).catch(() => {});
  }
  container.classList.add("hidden");
  btnStart.classList.remove("hidden");
  btnStop.classList.add("hidden");
}

/* ==================== 3. NFC SMARTPHONE (WEB NFC API) ==================== */
function checkNfcSupport() {
  const alertBox = document.getElementById("nfcSupportAlert");
  const btnStartNfc = document.getElementById("btnStartNfc");

  if (!("NDEFReader" in window)) {
    alertBox.classList.remove("hidden");
    alertBox.textContent = "ℹ️ Perangkat atau browser ini tidak mendukung Web NFC API. Fitur NFC hanya dapat digunakan pada smartphone Android dengan sensor NFC menggunakan Google Chrome.";
    btnStartNfc.disabled = true;
    btnStartNfc.style.opacity = "0.5";
  }
}

async function startNfcReader() {
  if (!("NDEFReader" in window)) {
    alert("Browser/perangkat ini tidak mendukung Web NFC.");
    return;
  }

  try {
    const ndef = new NDEFReader();
    await ndef.scan();
    STATE.nfcReaderActive = true;
    document.getElementById("nfcListeningIndicator").classList.remove("hidden");

    ndef.addEventListener("reading", ({ serialNumber }) => {
      if (!STATE.isProcessing && serialNumber) {
        const cleanUid = serialNumber.replace(/:/g, "").toUpperCase();
        submitAttendance(cleanUid, "NFC");
      }
    });
  } catch (err) {
    alert("Gagal memulai NFC: " + err.message + ". Pastikan NFC di pengaturan HP aktif.");
  }
}

/* ==================== 4. INPUT NIS MANUAL ==================== */
async function searchStudentByNis(e) {
  e.preventDefault();
  const nis = document.getElementById("manualNisInput").value.trim();
  if (!nis || STATE.isProcessing) return;

  STATE.isProcessing = true;
  try {
    const url = `${API_URL}?action=findStudent&query=${encodeURIComponent(nis)}&method=MANUAL`;
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    const data = await res.json();

    if (data.status === "success" && data.student) {
      STATE.selectedManualStudent = data.student;
      document.getElementById("previewPhoto").src = data.student.foto || DEFAULT_AVATAR;
      document.getElementById("previewName").textContent = data.student.nama;
      document.getElementById("previewNis").textContent = data.student.nis;
      document.getElementById("manualPreviewCard").classList.remove("hidden");
    } else {
      document.getElementById("manualPreviewCard").classList.add("hidden");
      showResultOverlay({
        type: "error",
        banner: "TIDAK TERDAFTAR",
        message: "IDENTITAS TIDAK DITEMUKAN",
        nama: `NIS: ${nis}`,
        nis: nis,
        metode: "MANUAL",
        tanggal: "-",
        jam: "-"
      });
    }
  } catch (err) {
    showResultOverlay({
      type: "error",
      banner: "GANGGUAN JARINGAN",
      message: "KONEKSI DATABASE TERGANGGU, SILAKAN COBA KEMBALI",
      nama: "-",
      nis: nis,
      metode: "MANUAL",
      tanggal: "-",
      jam: "-"
    });
  } finally {
    STATE.isProcessing = false;
  }
}

function confirmManualAttendance() {
  if (!STATE.selectedManualStudent) return;
  const nis = STATE.selectedManualStudent.nis;
  document.getElementById("manualPreviewCard").classList.add("hidden");
  document.getElementById("manualNisInput").value = "";
  STATE.selectedManualStudent = null;
  submitAttendance(nis, "MANUAL");
}

/* ==================== PENGIRIMAN ABSENSI & PENANGANAN HASIL ==================== */
async function submitAttendance(query, method) {
  if (!query || STATE.isProcessing) return;
  STATE.isProcessing = true;

  try {
    const url = `${API_URL}?action=recordAttendance&query=${encodeURIComponent(query)}&method=${encodeURIComponent(method)}`;
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    const data = await res.json();

    if (data.summary) renderTopStats(data.summary);

    if (data.status === "success") {
      const isLate = data.attendanceStatus === "TERLAMBAT";
      showResultOverlay({
        type: isLate ? "terlambat" : "hadir",
        banner: data.attendanceStatus,
        message: data.message,
        foto: data.student.foto,
        nama: data.student.nama,
        nis: data.student.nis,
        metode: data.metode,
        tanggal: data.tanggal,
        jam: data.jam
      });
    } else if (data.status === "duplicate") {
      showResultOverlay({
        type: "terlambat",
        banner: "ABSENSI GANDA DICEGAH",
        message: data.message,
        foto: data.student.foto,
        nama: data.student.nama,
        nis: data.student.nis,
        metode: method,
        tanggal: data.tanggal,
        jam: data.previousTime,
        extraNote: `Anda sudah tercatat ${data.previousStatus} pada pukul ${data.previousTime} WIB.`
      });
    } else if (data.status === "not_found") {
      showResultOverlay({
        type: "error",
        banner: "TIDAK DIKENALI",
        message: "IDENTITAS TIDAK DITEMUKAN",
        nama: `Kode: ${query}`,
        nis: "-",
        metode: method,
        tanggal: "-",
        jam: "-"
      });
    } else {
      throw new Error(data.message || "Server Error");
    }

  } catch (err) {
    // Simpan ke antrean lokal agar data tidak hilang saat koneksi terputus
    enqueueOfflineAttendance(query, method);
    showResultOverlay({
      type: "error",
      banner: "KONEKSI TERGANGGU",
      message: "KONEKSI DATABASE TERGANGGU, SILAKAN COBA KEMBALI",
      nama: `Kode: ${query} (Tersimpan di antrean lokal)`,
      nis: "-",
      metode: method,
      tanggal: "-",
      jam: "-"
    });
  } finally {
    setTimeout(() => {
      STATE.isProcessing = false;
    }, 1500);
  }
}

function showResultOverlay(info) {
  const modal = document.getElementById("resultModal");
  const banner = document.getElementById("resultStatusBanner");
  const extraNote = document.getElementById("resultExtraNote");
  const progress = document.getElementById("countdownProgress");

  banner.className = `result-banner ${info.type}`;
  banner.textContent = info.banner;

  document.getElementById("resultPhoto").src = info.foto || DEFAULT_AVATAR;
  document.getElementById("resultMessage").textContent = info.message;
  document.getElementById("resultStudentName").textContent = info.nama;
  document.getElementById("resultNis").textContent = info.nis;
  document.getElementById("resultMethod").textContent = info.metode;
  document.getElementById("resultDate").textContent = info.tanggal;
  document.getElementById("resultTime").textContent = info.jam;

  if (info.extraNote) {
    extraNote.textContent = info.extraNote;
    extraNote.classList.remove("hidden");
  } else {
    extraNote.classList.add("hidden");
  }

  modal.classList.remove("hidden");

  // Reset & jalankan animasi auto-close 4 detik
  progress.style.transition = "none";
  progress.style.width = "100%";
  setTimeout(() => {
    progress.style.transition = "width 4s linear";
    progress.style.width = "0%";
  }, 50);

  clearTimeout(STATE.modalTimer);
  STATE.modalTimer = setTimeout(closeResultModal, 4100);
}

function closeResultModal() {
  clearTimeout(STATE.modalTimer);
  document.getElementById("resultModal").classList.add("hidden");

  // Kembalikan fokus kursor ke input metode yang sedang aktif
  if (STATE.currentMethod === "RFID") {
    document.getElementById("rfidInput").focus();
  } else if (STATE.currentMethod === "QR CODE") {
    document.getElementById("qrHardwareInput").focus();
  } else if (STATE.currentMethod === "MANUAL") {
    document.getElementById("manualNisInput").focus();
  }
}

/* ==================== ANTREAN OFFLINE (ANTI KEHILANGAN DATA) ==================== */
function enqueueOfflineAttendance(query, method) {
  STATE.offlineQueue.push({ query, method, savedAt: new Date().toISOString() });
  localStorage.setItem("smart_attendance_queue", JSON.stringify(STATE.offlineQueue));
  updateOfflineBanner();
}

function updateOfflineBanner() {
  const banner = document.getElementById("offlineQueueBanner");
  const count = document.getElementById("offlineCount");
  if (STATE.offlineQueue.length > 0) {
    count.textContent = STATE.offlineQueue.length;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

async function flushOfflineQueue() {
  if (STATE.offlineQueue.length === 0) return;
  const remaining = [];

  for (const item of STATE.offlineQueue) {
    try {
      const url = `${API_URL}?action=recordAttendance&query=${encodeURIComponent(item.query)}&method=${encodeURIComponent(item.method)}`;
      const res = await fetch(url, { method: "GET", redirect: "follow" });
      const data = await res.json();
      if (!data.status) remaining.push(item);
    } catch (e) {
      remaining.push(item);
    }
  }

  STATE.offlineQueue = remaining;
  localStorage.setItem("smart_attendance_queue", JSON.stringify(remaining));
  updateOfflineBanner();
  checkDatabaseConnection();
}

/* ==================== DASHBOARD ADMIN ==================== */
function openAdminView() {
  if (STATE.isCameraRunning) stopQrCamera();
  document.getElementById("kioskView").classList.add("hidden");
  document.getElementById("adminView").classList.remove("hidden");

  if (STATE.adminCredentials) {
    document.getElementById("adminLoginBox").classList.add("hidden");
    document.getElementById("adminDashboardContent").classList.remove("hidden");
    refreshAdminData();
  } else {
    document.getElementById("adminLoginBox").classList.remove("hidden");
    document.getElementById("adminDashboardContent").classList.add("hidden");
  }
}

function closeAdminView() {
  document.getElementById("adminView").classList.add("hidden");
  document.getElementById("kioskView").classList.remove("hidden");
  selectMethod(STATE.currentMethod);
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const username = document.getElementById("adminUser").value.trim();
  const password = document.getElementById("adminPass").value.trim();
  const errBox = document.getElementById("adminLoginError");

  errBox.classList.add("hidden");

  try {
    const url = `${API_URL}?action=adminLogin&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    const data = await res.json();

    if (data.status === "success") {
      STATE.adminCredentials = { username, password };
      document.getElementById("adminLoginBox").classList.add("hidden");
      document.getElementById("adminDashboardContent").classList.remove("hidden");
      refreshAdminData();
    } else {
      errBox.textContent = data.message || "Login gagal.";
      errBox.classList.remove("hidden");
    }
  } catch (err) {
    errBox.textContent = "Koneksi database terganggu saat login.";
    errBox.classList.remove("hidden");
  }
}

function logoutAdmin() {
  STATE.adminCredentials = null;
  document.getElementById("adminPass").value = "";
  closeAdminView();
}

async function refreshAdminData() {
  if (!STATE.adminCredentials) return;
  const { username, password } = STATE.adminCredentials;

  try {
    const url = `${API_URL}?action=getAdminDashboard&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    const data = await res.json();

    if (data.status === "success") {
      const s = data.summary;
      const total = s.totalStudents || 0;
      const attended = s.totalAttended || 0;
      const absent = Math.max(0, total - attended);
      const rate = total > 0 ? Math.round((attended / total) * 100) : 0;

      document.getElementById("kpiTotalStudents").textContent = total;
      document.getElementById("kpiPresentToday").textContent = s.presentOnTime || 0;
      document.getElementById("kpiLateToday").textContent = s.lateToday || 0;
      document.getElementById("kpiAbsentToday").textContent = absent;
      document.getElementById("kpiAttendanceRate").textContent = `${rate}%`;

      STATE.adminRawHistory = data.history || [];
      applyAdminFilters();
    }
  } catch (err) {
    alert("Gagal memuat data dashboard admin.");
  }
}

function applyAdminFilters() {
  const search = document.getElementById("filterSearch").value.trim().toLowerCase();
  const dateFilter = document.getElementById("filterDate").value;
  const methodFilter = document.getElementById("filterMethod").value;
  const statusFilter = document.getElementById("filterStatus").value;

  const filtered = STATE.adminRawHistory.filter(row => {
    const matchText = !search ||
      row.nama.toLowerCase().includes(search) ||
      row.nis.toLowerCase().includes(search);
    const matchDate = !dateFilter || row.tanggal === dateFilter;
    const matchMethod = !methodFilter || row.metode === methodFilter;
    const matchStatus = !statusFilter || row.status === statusFilter;
    return matchText && matchDate && matchMethod && matchStatus;
  });

  renderAdminTable(filtered);
}

function resetAdminFilters() {
  document.getElementById("filterSearch").value = "";
  document.getElementById("filterDate").value = "";
  document.getElementById("filterMethod").value = "";
  document.getElementById("filterStatus").value = "";
  applyAdminFilters();
}

function renderAdminTable(rows) {
  const tbody = document.getElementById("adminTableBody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:24px;">Tidak ada data absensi yang cocok.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const badgeClass = r.status === "TERLAMBAT" ? "badge-terlambat" : "badge-hadir";
    return `
      <tr>
        <td>${escapeHtml(r.tanggal)}</td>
        <td><strong>${escapeHtml(r.jam)}</strong></td>
        <td>${escapeHtml(r.nis)}</td>
        <td>${escapeHtml(r.nama)}</td>
        <td>${escapeHtml(r.metode)}</td>
        <td>${escapeHtml(r.kodeKartu)}</td>
        <td><span class="badge-status ${badgeClass}">${escapeHtml(r.status)}</span></td>
      </tr>
    `;
  }).join("");
}

function exportToCsv() {
  if (!STATE.adminRawHistory.length) {
    alert("Belum ada data untuk diekspor.");
    return;
  }

  const headers = ["Timestamp", "Tanggal", "Jam", "Nomor NIS", "Nama Siswa", "Metode Absensi", "Nomor RFID", "Nomor NFC", "Kode Kartu", "Status Kehadiran"];
  const csvRows = [headers.join(",")];

  STATE.adminRawHistory.forEach(r => {
    const line = [
      r.timestamp, r.tanggal, r.jam, r.nis, r.nama,
      r.metode, r.rfid, r.nfc, r.kodeKartu, r.status
    ].map(val => `"${String(val || "").replace(/"/g, '""')}"`);
    csvRows.push(line.join(","));
  });

  const blob = new Blob(["\uFEFF" + csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `Laporan_Absensi_Sekolah_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}