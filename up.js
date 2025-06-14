const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- KONFIGURASI SCRIPT (WAJIB DISESUAIKAN) ---

// 1. Daftar package yang akan di-spam.
const SPAM_PACKAGES = ["zakkixd", "zakkimailer", "zakki-ai", "zakkisecurity"];

// 2. Jumlah worker/thread paralel MAKSIMAL yang berjalan bersamaan.
// Sesuaikan dengan kekuatan CPU dan network Anda. Jangan terlalu tinggi.
const MAX_CONCURRENT_WORKERS = 9999;

// 3. Konfigurasi Proxy (SANGAT DIREKOMENDASIKAN)
// Untuk menghindari blokir IP, gunakan proxy. Format: 'http://user:pass@host:port' atau 'http://host:port'
// Dapatkan proxy dari penyedia proxy gratis atau berbayar.
const PROXIES = [
    // Contoh:
    // 'http://proxy.example.com:8080',
    // 'http://user1:password123@192.168.1.1:8888',
    // Jika daftar ini kosong, script akan berjalan tanpa proxy (menggunakan IP Anda sendiri, tidak direkomendasikan).
];

// 4. Pengaturan Lanjutan
const NPM_INSTALL_TIMEOUT_MS = 90 * 1000;      // Timeout untuk setiap 'npm install' (90 detik).
const MIN_DELAY_AFTER_INSTALL_MS = 500;        // Jeda minimal setelah instalasi berhasil (ms).
const MAX_DELAY_AFTER_INSTALL_MS = 1500;       // Jeda maksimal setelah instalasi berhasil (ms).
const STATS_UPDATE_INTERVAL_MS = 5000;         // Seberapa sering statistik diperbarui (ms).

// --- GLOBAL STATE ---
let globalSuccessCount = 0;
let globalFailureCount = 0;
let activeWorkers = 0;
let proxyIndex = 0;
let scriptStartTime = Date.now();
let running = true;

// --- FUNGSI UTILITAS ---

/**
 * Menghasilkan jeda acak dalam rentang waktu tertentu.
 * @param {number} min - Milidetik minimal.
 * @param {number} max - Milidetik maksimal.
 */
function randomSleep(min, max) {
    const duration = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, duration));
}

/**
 * Mengambil proxy berikutnya dari daftar secara bergiliran (round-robin).
 * @returns {string|null} URL proxy atau null jika tidak ada.
 */
function getNextProxy() {
    if (PROXIES.length === 0) {
        return null;
    }
    const proxy = PROXIES[proxyIndex];
    proxyIndex = (proxyIndex + 1) % PROXIES.length;
    return proxy;
}

/**
 * Menjalankan perintah 'npm install' di dalam direktori kerja yang terisolasi.
 * @param {string} pkg - Nama package npm.
 * @param {string} workerId - ID unik untuk worker.
 * @param {string} tempDir - Direktori temporer untuk instalasi.
 * @returns {Promise<void>}
 */
function npmInstall(pkg, workerId, tempDir) {
    return new Promise((resolve, reject) => {
        const proxy = getNextProxy();
        const args = [
            'install',
            pkg,
            '--no-save',          // Jangan simpan ke package.json
            '--no-package-lock',  // Jangan buat package-lock.json
            '--no-audit',         // Lewati audit keamanan
            '--no-fund',          // Lewati pesan funding
            '--prefer-online',    // Pastikan selalu cek registry
        ];

        if (proxy) {
            args.push(`--proxy=${proxy}`, `--https-proxy=${proxy}`);
        }

        const child = spawn('npm', args, {
            cwd: tempDir, // Jalankan perintah di dalam folder temporer
            timeout: NPM_INSTALL_TIMEOUT_MS,
            shell: true // Gunakan shell untuk parsing argumen yang lebih baik
        });

        // Uncomment untuk debug output dari npm
        // child.stdout.on('data', (data) => console.log(`[${workerId}] STDOUT: ${data.toString().trim()}`));
        // child.stderr.on('data', (data) => console.error(`[${workerId}] STDERR: ${data.toString().trim()}`));

        child.on('error', (err) => {
            reject(new Error(`Gagal spawn 'npm': ${err.message}`));
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`'npm install ${pkg}' keluar dengan kode ${code}. Proxy: ${proxy || 'none'}`));
            }
        });
    });
}


/**
 * Fungsi utama untuk setiap worker.
 * @param {string} workerId - ID unik worker.
 */
async function worker(workerId) {
    activeWorkers++;
    console.log(`\x1b[90m[${workerId}] Worker dimulai...\x1b[0m`);

    while (running) {
        const pkg = SPAM_PACKAGES[Math.floor(Math.random() * SPAM_PACKAGES.length)]; // Ambil package acak
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `npm-spam-${workerId.split('-')[1]}-`));
        const proxyInfo = PROXIES.length > 0 ? `via proxy [${proxyIndex}]` : 'tanpa proxy';

        try {
            // console.log(`\x1b[34m[${workerId}] Menginstall \x1b[35m${pkg}\x1b[34m di \x1b[37m${tempDir}\x1b[34m ${proxyInfo}...\x1b[0m`);
            await npmInstall(pkg, workerId, tempDir);
            globalSuccessCount++;
            console.log(`\x1b[32m[${workerId}] BERHASIL install \x1b[35m${pkg}\x1b[32m ${proxyInfo}\x1b[0m`);
            await randomSleep(MIN_DELAY_AFTER_INSTALL_MS, MAX_DELAY_AFTER_INSTALL_MS);
        } catch (e) {
            globalFailureCount++;
            console.log(`\x1b[31m[${workerId}] GAGAL install \x1b[35m${pkg}\x1b[31m: ${e.message}\x1b[0m`);
            // Beri jeda lebih lama jika gagal, mungkin karena masalah jaringan atau proxy
            await randomSleep(2000, 4000);
        } finally {
            // Cleanup: Hapus folder temporer dengan isinya
            try {
                await fs.promises.rm(tempDir, { recursive: true, force: true });
            } catch (cleanupErr) {
                console.log(`\x1b[91m[${workerId}] Peringatan: Gagal menghapus folder temporer ${tempDir}: ${cleanupErr.message}\x1b[0m`);
            }
        }
    }

    activeWorkers--;
    console.log(`\x1b[90m[${workerId}] Worker berhenti.\x1b[0m`);
}

/**
 * Menampilkan statistik secara periodik.
 */
function showStats() {
    if (!running) return;

    const elapsedTimeSeconds = (Date.now() - scriptStartTime) / 1000;
    const downloadsPerMinute = (globalSuccessCount / (elapsedTimeSeconds || 1)) * 60;

    const statsLine =
        `\x1b[1m\x1b[36m[STATUS]\x1b[0m ` +
        `Sukses: \x1b[32m${globalSuccessCount}\x1b[0m | ` +
        `Gagal: \x1b[31m${globalFailureCount}\x1b[0m | ` +
        `Worker Aktif: \x1b[33m${activeWorkers}\x1b[0m | ` +
        `Rate: \x1b[35m${downloadsPerMinute.toFixed(2)} unduhan/menit\x1b[0m | ` +
        `Runtime: \x1b[90m${Math.floor(elapsedTimeSeconds / 60)}m ${Math.floor(elapsedTimeSeconds % 60)}s\x1b[0m`;

    process.stdout.write(statsLine + '\r');
}

/**
 * Fungsi utama untuk memulai semua worker.
 */
async function main() {
    console.clear();
    console.log(`\x1b[36m=========================================================\x1b[0m`);
    console.log(`\x1b[32m           Selamat Datang di ZakkiStore-Ai v2.0\x1b[0m`);
    console.log(`\x1b[32m           Script Spam Download NPM Tercanggih\x1b[0m`);
    console.log(`\x1b[33m         (Gunakan dengan bijak dan tanggung jawab)\x1b[0m`);
    console.log(`\x1b[36m=========================================================\x1b[0m`);
    console.log(`\x1b[37mTarget Packages: \x1b[35m${SPAM_PACKAGES.join(', ')}\x1b[0m`);
    console.log(`\x1b[37mMax Concurrent Workers: \x1b[33m${MAX_CONCURRENT_WORKERS}\x1b[0m`);
    console.log(`\x1b[37mMode Proxy: \x1b[32m${PROXIES.length > 0 ? `AKTIF (${PROXIES.length} proxy)` : 'NON-AKTIF'}\x1b[0m\n`);

    if (PROXIES.length === 0) {
        console.log(`\x1b[91m[PERINGATAN] Anda tidak menggunakan proxy. IP address Anda akan terekspos langsung ke NPM dan berisiko tinggi untuk diblokir. Lanjutkan dengan risiko Anda sendiri.\n\x1b[0m`);
    }

    // Menangani sinyal Ctrl+C untuk penghentian yang rapi
    process.on('SIGINT', () => {
        if (!running) return; // Mencegah multiple trigger
        console.log(`\n\n\x1b[33m[INFO] Sinyal Ctrl+C terdeteksi. Menghentikan semua worker... Mohon tunggu.\x1b[0m`);
        running = false;
        // Beri waktu bagi worker untuk menyelesaikan siklus terakhirnya
        setTimeout(() => {
            console.log(`\x1b[32m[INFO] Semua proses telah dihentikan.\x1b[0m`);
            process.exit(0);
        }, 5000);
    });

    const workerPromises = [];
    for (let i = 1; i <= MAX_CONCURRENT_WORKERS; i++) {
        workerPromises.push(worker(`Worker-${i}`));
        await randomSleep(50, 150); // Delay peluncuran worker agar tidak membanjiri sistem
    }

    const statsInterval = setInterval(showStats, STATS_UPDATE_INTERVAL_MS);

    await Promise.all(workerPromises);

    clearInterval(statsInterval);
    console.log(`\n\x1b[36m=========================================================\x1b[0m`);
    console.log(`\x1b[32m[SELESAI] Total instalasi sukses: ${globalSuccessCount}\x1b[0m`);
    console.log(`\x1b[32mTerima kasih telah menggunakan layanan kami.\x1b[0m`);
    console.log(`\x1b[36m=========================================================\x1b[0m`);
}

main().catch(err => {
    console.error("\n\x1b[91m[ERROR KRITIS] Terjadi kesalahan yang tidak terduga:", err, "\x1b[0m");
    process.exit(1);
});
