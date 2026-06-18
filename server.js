const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Alamat Database Supabase milikmu
const connectionString = "postgresql://postgres:cdaaptnia26@db.xdmkxpnfewqnzaheklzg.supabase.co:6543/postgres";

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1, // Membatasi jumlah koneksi agar tidak merusak kuota gratisan Supabase
    idleTimeoutMillis: 2000, // Memutus koneksi otomatis jika idle agar Vercel tidak hang
    connectionTimeoutMillis: 5000 // Batas maksimal menunggu respon database (5 detik)
});

// Otomatis Membuat Tabel & Data Awal di Supabase saat aplikasi menyala
async function inisialisasiDatabase() {
    try {
        // 1. Tabel Absensi
        await pool.query(`CREATE TABLE IF NOT EXISTS absensi (
            id SERIAL PRIMARY KEY,
            nama TEXT,
            waktu TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            tipe TEXT,
            lokasi TEXT,
            jarak TEXT,
            foto TEXT, 
            status_waktu TEXT
        )`);

        // 2. Tabel Karyawan
        await pool.query(`CREATE TABLE IF NOT EXISTS karyawan (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            pertanyaan TEXT,
            jawaban TEXT
        )`);

        // 3. Tabel Pengaturan Kantor
        await pool.query(`CREATE TABLE IF NOT EXISTS pengaturan (
            id INTEGER PRIMARY KEY,
            lat REAL,
            lon REAL,
            radius INTEGER,
            jam_masuk TEXT,
            jam_pulang TEXT,
            password_admin TEXT
        )`);

        // ISI DATA DEFAULT: Jika data pengaturan (admin) belum ada, buat otomatis!
        const cekConfig = await pool.query("SELECT id FROM pengaturan WHERE id = 1");
        if (cekConfig.rowCount === 0) {
            await pool.query(`INSERT INTO pengaturan (id, lat, lon, radius, jam_masuk, jam_pulang, password_admin) 
                              VALUES (1, -6.175392, 106.827153, 100, '08:00', '17:00', 'admin123')`);
            console.log("Data Admin default berhasil dimasukkan!");
        }
        console.log("Database Supabase Berhasil Diinisialisasi!");
    } catch (err) {
        console.error("Gagal koneksi ke Supabase:", err.message);
    }
}
inisialisasiDatabase();

// Menerima input JSON & URL-Encoded lebih besar karena Base64 memakan memori teks
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Fungsi Hitung Jarak GPS
function hitungJarak(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI/180; const phi2 = lat2 * Math.PI/180;
    const dPhi = (lat2-lat1) * Math.PI/180; const dLon = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(dPhi/2) * Math.sin(dPhi/2) + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

// --- ROUTES ---

app.get('/', async (req, res) => { 
    try {
        // Memastikan tabel terbuat tepat saat halaman utama dibuka di internet
        await inisialisasiDatabase(); 
        res.render('login', { error: null, success: req.query.success || null }); 
    } catch (err) {
        res.render('login', { error: "Gagal menghubungkan database cloud, coba muat ulang halaman.", success: null });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const userClean = username.toLowerCase().trim();

    // Membuka koneksi khusus untuk proses login ini saja
    const client = await pool.connect();

    try {
        if (userClean === 'admin') {
            const config = await client.query("SELECT password_admin FROM pengaturan WHERE id = 1");
            if (config.rowCount > 0 && password === config.rows[0].password_admin) {
                return res.redirect('/admin');
            } else {
                return res.render('login', { error: 'Password Admin salah!', success: null });
            }
        } else {
            const result = await client.query("SELECT * FROM karyawan WHERE username = $1 AND password = $2", [userClean, password]);
            if (result.rowCount > 0) { 
                res.redirect('/absen?user=' + userClean); 
            } else { 
                res.render('login', { error: 'Username atau Password salah!', success: null }); 
            }
        }
    } catch (err) { 
        console.error(err);
        res.status(500).send("Error server login"); 
    } finally {
        // WAJIB VERCEL: Tutup dan kembalikan koneksi ke pool agar server tidak hang/timeout
        client.release();
    }
});
app.get('/register', (req, res) => { res.render('register', { error: null }); });

app.post('/register', async (req, res) => {
    const { username, password, pertanyaan, jawaban } = req.body;
    const userClean = username.toLowerCase().trim();
    if (userClean === 'admin') return res.render('register', { error: 'Tidak boleh menggunakan nama admin!' });
    
    try {
        await pool.query("INSERT INTO karyawan (username, password, pertanyaan, jawaban) VALUES ($1, $2, $3, $4)",
            [userClean, password, pertanyaan, jawaban.toLowerCase().trim()]);
        res.redirect('/?success=Akun berhasil dibuat! Silakan login.');
    } catch (err) {
        res.render('register', { error: 'Username sudah terdaftar! Pilih nama lain.' });
    }
});

app.get('/lupa-password', (req, res) => { res.render('lupa-password', { step: 1, username: null, pertanyaan: null, error: null }); });

app.post('/lupa-password/cek-user', async (req, res) => {
    const { username } = req.body;
    try {
        const result = await pool.query("SELECT * FROM karyawan WHERE username = $1", [username.toLowerCase().trim()]);
        if (result.rowCount === 0) return res.render('lupa-password', { step: 1, username: null, pertanyaan: null, error: 'Username tidak ditemukan!' });
        res.render('lupa-password', { step: 2, username: result.rows[0].username, pertanyaan: result.rows[0].pertanyaan, error: null });
    } catch (err) { res.status(500).send("Error server"); }
});

app.post('/lupa-password/reset', async (req, res) => {
    const { username, jawaban, password_baru } = req.body;
    try {
        const result = await pool.query("SELECT * FROM karyawan WHERE username = $1", [username]);
        if (result.rows[0].jawaban !== jawaban.toLowerCase().trim()) {
            return res.render('lupa-password', { step: 2, username: username, pertanyaan: result.rows[0].pertanyaan, error: 'Jawaban salah! Gagal mereset password.' });
        }
        await pool.query("UPDATE karyawan SET password = $1 WHERE username = $2", [password_baru, username]);
        res.redirect('/?success=Password berhasil diganti! Silakan login dengan password baru.');
    } catch (err) { res.status(500).send("Error server"); }
});

app.get('/absen', (req, res) => {
    res.render('absen', { user: req.query.user || 'Karyawan', error: req.query.error || null, success: req.query.success || null });
});

// PROSES ABSEN VERSI BARU (TANPA REPOT MULTER)
app.post('/absen', async (req, res) => {
    const { nama, tipe, lat, lon, fotoBase64 } = req.body;

    if (!lat || !lon) return res.redirect(`/absen?user=${nama}&error=GPS wajib aktif!`);
    if (!fotoBase64) return res.redirect(`/absen?user=${nama}&error=Foto selfie wajib diambil!`);

    try {
        const cekQuery = `SELECT id FROM absensi WHERE nama = $1 AND tipe = $2 AND waktu::date = CURRENT_DATE`;
        const cekAbsen = await pool.query(cekQuery, [nama, tipe]);
        if (cekAbsen.rowCount > 0) return res.redirect(`/absen?user=${nama}&error=Gagal! Kamu sudah melakukan Absen ${tipe} hari ini.`);

        const configResult = await pool.query("SELECT * FROM pengaturan WHERE id = 1");
        const config = configResult.rows[0];

        const jarakMeter = hitungJarak(parseFloat(lat), parseFloat(lon), config.lat, config.lon);
        if (jarakMeter > config.radius) return res.redirect(`/absen?user=${nama}&error=Gagal! Jarakmu ${Math.round(jarakMeter)}m (Maksimal ${config.radius}m)`);

        const sekarang = new Date();
        const jamSekarangString = sekarang.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace('.', ':');
        let statusWaktu = 'Tepat Waktu';

        if (tipe === 'Masuk' && jamSekarangString > config.jam_masuk) statusWaktu = 'Terlambat';
        else if (tipe === 'Pulang' && jamSekarangString < config.jam_pulang) statusWaktu = 'Pulang Cepat';

        // Langsung simpan string Base64 ke kolom foto
        await pool.query("INSERT INTO absensi (nama, tipe, lokasi, jarak, foto, status_waktu) VALUES ($1, $2, $3, $4, $5, $6)", 
            [nama, tipe, `${lat},${lon}`, `${Math.round(jarakMeter)} meter`, fotoBase64, statusWaktu]);
        
        res.redirect(`/absen?user=${nama}&success=Absen ${tipe} Berhasil (${statusWaktu})!`);
    } catch (err) { res.status(500).send("Error server absensi"); }
});

app.get('/admin', async (req, res) => {
    const error = req.query.error || null;
    const success = req.query.success || null;

    try {
        const absensiResult = await pool.query("SELECT id, nama, tipe, to_char(waktu AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') as waktu_lokal, lokasi, jarak, foto, status_waktu FROM absensi ORDER BY waktu DESC");
        const karyawanResult = await pool.query("SELECT * FROM karyawan ORDER BY username ASC");
        const configResult = await pool.query("SELECT * FROM pengaturan WHERE id = 1");

        res.render('admin', { 
            riwayat: absensiResult.rows, 
            karyawan: karyawanResult.rows, 
            config: configResult.rows[0], 
            error, success 
        });
    } catch (err) { res.status(500).send("Error memuat dashboard admin"); }
});

app.post('/admin/karyawan/tambah', async (req, res) => {
    const { username, password } = req.body;
    try {
        await pool.query("INSERT INTO karyawan (username, password, pertanyaan, jawaban) VALUES ($1, $2, 'Dibuat oleh Admin', 'admin')", [username.toLowerCase(), password]);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Gagal menambah karyawan"); }
});

app.get('/admin/karyawan/hapus/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM karyawan WHERE id = $1", [req.params.id]);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Gagal menghapus"); }
});

app.post('/admin/karyawan/edit', async (req, res) => {
    const { id, username, password } = req.body;
    try {
        await pool.query("UPDATE karyawan SET username = $1, password = $2 WHERE id = $3", [username.toLowerCase(), password, id]);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Gagal mengedit"); }
});

app.post('/admin/pengaturan', async (req, res) => {
    const { lat, lon, radius, jam_masuk, jam_pulang } = req.body;
    try {
        await pool.query("UPDATE pengaturan SET lat = $1, lon = $2, radius = $3, jam_masuk = $4, jam_pulang = $5 WHERE id = 1", 
            [lat, lon, radius, jam_masuk, jam_pulang]);
        res.redirect('/admin?success=Aturan lokasi dan jam kerja berhasil diperbarui!');
    } catch (err) { res.status(500).send("Gagal memperbarui aturan"); }
});

app.post('/admin/ganti-password-admin', async (req, res) => {
    const { password_lama, password_baru } = req.body;
    try {
        const config = await pool.query("SELECT password_admin FROM pengaturan WHERE id = 1");
        if (password_lama !== config.rows[0].password_admin) {
            return res.redirect('/admin?error=Gagal ganti password! Password lama yang kamu masukkan salah.');
        }
        await pool.query("UPDATE pengaturan SET password_admin = $1 WHERE id = 1", [password_baru]);
        res.redirect('/admin?success=Password admin berhasil diperbarui!');
    } catch (err) { res.status(500).send("Error ganti password"); }
});

app.get('/admin/download', async (req, res) => {
    try {
        const query = `SELECT id, nama, tipe, to_char(waktu AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') as tgl, to_char(waktu AT TIME ZONE 'Asia/Jakarta', 'HH24:MI:SS') as jam, jarak, status_waktu FROM absensi ORDER BY nama ASC, waktu ASC`;
        const result = await pool.query(query);
        const header = ["ID", "Nama Karyawan", "Tipe Absen", "Tanggal Absen", "Jam Absen", "Jarak", "Keterangan Waktu"];
        let csvContent = header.join(';') + '\n';
        result.rows.forEach(row => { csvContent += [row.id, row.nama.toUpperCase(), row.tipe, row.tgl, row.jam, row.jarak, row.status_waktu].join(';') + '\n'; });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename=Laporan_Absensi.csv');
        res.send(Buffer.from('\ufeff' + csvContent, 'utf-8'));
    } catch (err) { res.status(500).send("Gagal mengunduh rekap"); }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));