const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');

// --- KONFIGURASI SCRIPT ---

// 1. Daftar package yang akan di-spam.
const SPAM_PACKAGES = ["zakkixd"];

// 2. Jumlah worker paralel. Secara default, disesuaikan dengan jumlah core CPU Anda untuk performa maksimal.
// Ubah jika perlu, namun disarankan untuk tidak melebihi jumlah core CPU x 2.
const MAX_CONCURRENT_WORKERS = os.cpus().length;

// 3. Pengaturan Lanjutan
const NPM_INSTALL_TIMEOUT_MS = 60 * 1000;      // Timeout 60 detik per instalasi.
const DELAY_BETWEEN_CYCLES_MS = 250;           // Jeda singkat antar siklus untuk mengurangi beban I/O.
const STATS_UPDATE_INTERVAL_MS = 1000;         // Statistik diperbarui setiap 1 detik.

// --- GLOBAL STATE ---
let globalSuccessCount = 0;
let globalFailureCount = 0;
let activeWorkers = 0;
let scriptStartTime;
let running = true;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;

// --- FUNGSI INTI ---

/**
 * Menjalankan perintah 'npm install' dalam sebuah "sandbox" direktori yang terisolasi.
 * @param {string} pkg - Nama package npm.
 * @param {string} tempDir - Direktori temporer unik untuk instalasi ini.
 * @returns {Promise<void>}
 */
function npmInstallInSandbox(pkg, tempDir) {
    return new Promise((resolve, reject) => {
        // Argumen npm yang dioptimalkan untuk memaksa unduhan baru dari jaringan
        const args = [
            'install', pkg,
            '--no-save',          // Jangan simpan ke package.json
            '--no-package-lock',  // Jangan buat package-lock.json
            '--no-audit',         // Lewati audit keamanan untuk kecepatan
            '--no-fund',          // Lewati pesan funding
            '--force',            // Paksa fetch ulang package dari registry
            '--prefer-online',    // Pastikan selalu cek registry, bukan cache
            '--loglevel', 'error' // Hanya tampilkan error dari npm, bukan log biasa
        ];

        const child = spawn('npm', args, {
            cwd: tempDir, // Ini adalah kunci: jalankan perintah di dalam folder sandbox
            timeout: NPM_INSTALL_TIMEOUT_MS,
            shell: os.platform() === 'win32'
        });

        // Kumpulkan output error jika ada
        let errorOutput = '';
        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.on('error', (err) => reject(new Error(`Gagal spawn 'npm': ${err.message}`)));

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                // Memberikan pesan error yang lebih informatif
                const reason = errorOutput.split('\n')[0] || `Exit code ${code}`;
                reject(new Error(reason));
            }
        });
    });
}

/**
 * Fungsi utama untuk setiap worker. Siklusnya: buat sandbox -> install -> hapus sandbox.
 * @param {string} workerId - ID unik worker.
 */
async function worker(workerId) {
    activeWorkers++;
    while (running) {
        const pkg = SPAM_PACKAGES[Math.floor(Math.random() * SPAM_PACKAGES.length)];
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `npm-spam-${workerId}-`));

        try {
            await npmInstallInSandbox(pkg, tempDir);
            globalSuccessCount++;
        } catch (error) {
            globalFailureCount++;
            // Kegagalan tidak di-log di sini untuk menjaga UI tetap bersih.
            // Bisa diaktifkan untuk debugging: console.error(`\n[${workerId}] Gagal: ${error.message}`);
        } finally {
            // Selalu pastikan sandbox dihapus setelah selesai
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CYCLES_MS));
    }
    activeWorkers--;
}

// --- FUNGSI UI & PEMBANTU ---

/**
 * Menampilkan UI statistik real-time yang bersih pada satu baris.
 */
function showRealtimeStats() {
    if (!running) return;

    const elapsedTimeSeconds = (Date.now() - scriptStartTime) / 1000;
    const downloadsPerMinute = (globalSuccessCount / (elapsedTimeSeconds || 1)) * 60;
    const totalRuns = globalSuccessCount + globalFailureCount;
    const accuracy = totalRuns > 0 ? (globalSuccessCount / totalRuns * 100) : 100;

    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    const spinner = `\x1b[36m${spinnerFrames[spinnerIndex]}\x1b[0m`;

    const runtime = `\x1b[90m${Math.floor(elapsedTimeSeconds / 60)}m ${Math.floor(elapsedTimeSeconds % 60)}s\x1b[0m`;
    const statsLine =
        `${spinner} ` +
        `Workers: \x1b[33m${activeWorkers}/${MAX_CONCURRENT_WORKERS}\x1b[0m | ` +
        `Sukses: \x1b[32m${globalSuccessCount}\x1b[0m | ` +
        `Gagal: \x1b[31m${globalFailureCount}\x1b[0m | ` +
        `Akurasi: \x1b[1m${accuracy.toFixed(1)}%\x1b[0m | ` +
        `Rate: \x1b[35m${downloadsPerMinute.toFixed(2)} DPM\x1b[0m | ` +
        `Runtime: ${runtime}`;

    process.stdout.write('\r\x1b[K' + statsLine); // \r\x1b[K -> kembali ke awal baris dan hapus sisa baris
}

/**
 * Melakukan pemeriksaan pra-jalan untuk memastikan lingkungan siap.
 * @returns {Promise<boolean>}
 */
async function preflightChecks() {
    console.log("\x1b[34m[INFO] Melakukan pemeriksaan pra-jalan...\x1b[0m");
    // 1. Cek ketersediaan NPM
    try {
        await new Promise((resolve, reject) => {
            spawn('npm', ['-v']).on('close', resolve).on('error', reject);
        });
        console.log("\x1b[32m ✓ NPM terdeteksi.\x1b[0m");
    } catch (error) {
        console.error("\x1b[31m ✗ ERROR: Perintah 'npm' tidak ditemukan. Pastikan Node.js terinstall.\x1b[0m");
        return false;
    }

    // 2. Cek koneksi internet ke registry NPM
    try {
        await dns.promises.lookup('registry.npmjs.org');
        console.log("\x1b[32m ✓ Koneksi internet ke registry NPM berhasil.\x1b[0m");
    } catch (error) {
        console.error("\x1b[31m ✗ ERROR: Tidak dapat terhubung ke registry.npmjs.org. Periksa koneksi internet Anda.\x1b[0m");
        return false;
    }

    return true;
}

/**
 * Fungsi utama untuk memulai semua worker.
 */
async function main() {
    console.clear();
    const title = " ZAKKI-STORE AI v4.0 - MODE AGRESIF (ISOLASI TOTAL) ";
    const border = "═".repeat(title.length);
    console.log(`\x1b[1;36m╔${border}╗\x1b[0m`);
    console.log(`\x1b[1;36m║${title}║\x1b[0m`);
    console.log(`\x1b[1;36m╚${border}╚\x1b[0m\n`);

    if (!(await preflightChecks())) {
        process.exit(1);
    }
    
    console.log(`\n\x1b[37mTarget Packages: \x1b[35m${SPAM_PACKAGES.join(', ')}\x1b[0m`);
    console.log(`\x1b[37mMode: \x1b[1;31mTANPA PROXY\x1b[0m`);
    console.log(`\x1b[37mWorkers: \x1b[33m${MAX_CONCURRENT_WORKERS} (berdasarkan jumlah core CPU)\x1b[0m`);
    
    console.log(`\n\x1b[1;91m[PERINGATAN KERAS] Anda menjalankan script ini tanpa proksi.`);
    console.log(`\x1b[91mIP Address Anda akan digunakan secara langsung dan berisiko sangat tinggi`);
    console.log(`\x1b[91muntuk diblokir sementara atau permanen oleh NPM.\n`);
    
    await new Promise(resolve => setTimeout(resolve, 5000)); // Beri waktu untuk membaca peringatan

    scriptStartTime = Date.now();
    const statsInterval = setInterval(showRealtimeStats, STATS_UPDATE_INTERVAL_MS / 4);

    process.on('SIGINT', () => {
        if (!running) return;
        running = false;
        clearInterval(statsInterval);
        console.log(`\n\n\x1b[33m[PROSES BERHENTI] Menunggu semua worker menyelesaikan siklus terakhir... Mohon tunggu.\x1b[0m`);
    });
    
    const workerPromises = [];
    for (let i = 1; i <= MAX_CONCURRENT_WORKERS; i++) {
        workerPromises.push(worker(`W${i}`));
    }
    
    await Promise.all(workerPromises);
    
    // Tampilkan statistik final
    showRealtimeStats();
    
    const totalTime = ((Date.now() - scriptStartTime) / 1000).toFixed(2);
    console.log(`\n\n\x1b[1;36m╔═════════════════════ HASIL AKHIR ═════════════════════╗\x1b[0m`);
    console.log(`\x1b[1;36m║\x1b[0m Total Runtime      : \x1b[33m${totalTime} detik\x1b[0m`);
    console.log(`\x1b[1;36m║\x1b[0m Instalasi Sukses   : \x1b[32m${globalSuccessCount}\x1b[0m`);
    console.log(`\x1b[1;36m║\x1b[0m Instalasi Gagal    : \x1b[31m${globalFailureCount}\x1b[0m`);
    console.log(`\x1b[1;36m║\x1b[0m Akurasi Final      : \x1b[1m${((globalSuccessCount / (globalSuccessCount + globalFailureCount || 1)) * 100).toFixed(2)}%\x1b[0m`);
    console.log(`\x1b[1;36m╚══════════════════════════════════════════════════════╝\x1b[0m`);
    
    process.exit(0);
}

main().catch(err => {
    console.error("\n\x1b[91m[ERROR KRITIS] Script berhenti karena kesalahan fatal:", err, "\x1b[0m");
    process.exit(1);
});
