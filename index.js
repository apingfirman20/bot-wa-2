import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import { google } from 'googleapis'
import Tesseract from 'tesseract.js'
import fs from 'fs'

// ================= GOOGLE SHEETS =================
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
})
const sheets = google.sheets({ version: 'v4', auth })
const SPREADSHEET_ID = '1tms7gb0fWSkkO3vEKc-MJ4xlmgUhw3BxqXipO2JVj90'

// 🔹 Format angka biar lebih rapi
function formatRupiah(num) {
  return `Rp${num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
}

// 🔹 Bersihkan angka string
function cleanNumber(str) {
  return parseInt(String(str).replace(/[^\d]/g, '')) || 0
}

// 🔹 Ringkas deskripsi dari OCR
function ringkasDeskripsi(ocrText) {
  const lower = ocrText.toLowerCase()
  if (lower.includes('tokopedia') || lower.includes('shopee') || lower.includes('lazada'))
    return 'Marketplace'
  if (lower.includes('alfamart') || lower.includes('indomaret'))
    return 'Belanja Minimarket'
  if (lower.includes('gopay') || lower.includes('ovo') || lower.includes('dana'))
    return 'Topup E-Wallet'
  if (lower.includes('grab') || lower.includes('gojek'))
    return 'Transportasi Online'
  if (lower.includes('gaji') || lower.includes('salary'))
    return 'Gaji'
  return ocrText.slice(0, 30)
}

// 🔹 Tambah data ke sheet
async function tambahKeSheet(kategori, deskripsi, jumlah, tipe) {
  const bersih = cleanNumber(jumlah)
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[new Date().toISOString(), kategori, deskripsi, bersih, tipe]]
    }
  })
}

// 🔹 Cache untuk saldo & investasi
let cacheSaldo = { value: null, time: 0 }
let cacheInvestasi = { value: null, time: 0 }
const CACHE_TTL = 30 * 1000 // 30 detik

async function hitungSaldo(force = false) {
  const now = Date.now()
  if (!force && cacheSaldo.value && now - cacheSaldo.time < CACHE_TTL) {
    return cacheSaldo.value
  }
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!G4'
  })
  const values = res.data.values || []
  const saldo = values[0] ? cleanNumber(values[0][0]) : 0
  cacheSaldo = { value: saldo, time: now }
  return saldo
}

async function hitungInvestasi(force = false) {
  const now = Date.now()
  if (!force && cacheInvestasi.value && now - cacheInvestasi.time < CACHE_TTL) {
    return cacheInvestasi.value
  }
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!G7'
  })
  const values = res.data.values || []
  const investasi = values[0] ? cleanNumber(values[0][0]) : 0
  cacheInvestasi = { value: investasi, time: now }
  return investasi
}

// 🔹 Laporan mingguan/bulanan
async function laporanPeriode(mode = 'minggu') {
  const now = new Date()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A:E'
  })
  const rows = res.data.values || []
  let totalMasuk = 0, totalKeluar = 0

  for (let i = 1; i < rows.length; i++) {
    const [tgl,, , jml, tipe] = rows[i]
    const num = cleanNumber(jml)
    const date = new Date(tgl)

    let masukPeriode = false
    if (mode === 'minggu') {
      masukPeriode = (now - date) <= 7 * 24 * 60 * 60 * 1000
    } else if (mode === 'bulan') {
      masukPeriode = date.getMonth() === now.getMonth() &&
                     date.getFullYear() === now.getFullYear()
    }

    if (masukPeriode) {
      if (tipe === 'Pemasukan') totalMasuk += num
      else if (tipe === 'Pengeluaran') totalKeluar += num
    }
  }
  return { totalMasuk, totalKeluar }
}

// ================= WHATSAPP BOT ===================
let lastReport = { minggu: null, bulan: null }

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const sock = makeWASocket({ auth: state })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', ({ qr, connection }) => {
    if (qr) console.log('🔑 Scan QR ini di WhatsApp:\n' + qr)
    if (connection === 'open') console.log('✅ Bot sudah terhubung ke WhatsApp')
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return
    if (msg.key.fromMe) return // ⛔ Jangan baca pesan bot sendiri

    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text

    // ================= HELP =================
    if (/^help$/i.test(text)) {
      await sock.sendMessage(from, {
        text:
`📌 *Panduan Penggunaan Bot Keuangan*
1. *catat* [jumlah] [tipe] [deskripsi]
   contoh: catat 50000 keluar makan siang
   contoh: catat 200000 masuk gaji
   contoh: catat 100000 invest emas

2. *update saldo*
   ➝ Menampilkan saldo & investasi terbaru

3. *laporan minggu*
   ➝ Rekap 7 hari terakhir

4. *laporan bulan*
   ➝ Rekap bulan ini

5. Kirim foto struk
   ➝ Bot akan membaca total otomatis`
      })
      return
    }

    // ================= CATAT MANUAL =================
    if (text?.startsWith('catat')) {
      const [_, jumlah, tipe, ...deskripsi] = text.split(' ')
      let kategori = tipe
      let jenis = 'Pengeluaran'

      if (tipe?.toLowerCase().includes('masuk')) {
        jenis = 'Pemasukan'
        kategori = 'Pemasukan'
      } else if (tipe?.toLowerCase().includes('invest')) {
        jenis = 'Pengeluaran'
        kategori = 'Investasi'
      }

      await tambahKeSheet(kategori, deskripsi.join(' '), jumlah, jenis)
      const saldo = await hitungSaldo(true)
      await sock.sendMessage(from, {
        text: `✅ Data tersimpan!\nSaldo terkini: ${formatRupiah(saldo)}`
      })
      return
    }

    // ================= UPDATE SALDO =================
    if (/update saldo/i.test(text)) {
      const saldo = await hitungSaldo()
      const investasi = await hitungInvestasi()

      await sock.sendMessage(from, {
        text: `🔄 *Update Saldo:*\nSaldo Terkini: ${formatRupiah(saldo)}\nNilai Investasi: ${formatRupiah(investasi)}`
      })
      return
    }

    // ================= LAPORAN =================
    if (/laporan/i.test(text)) {
      let mode = /minggu/i.test(text) ? 'minggu' : 'bulan'
      const todayKey = new Date().toISOString().slice(0, 10)

      if (lastReport[mode] === todayKey) {
        await sock.sendMessage(from, { text: `ℹ️ Laporan ${mode} sudah dikirim hari ini.` })
        return
      }

      const { totalMasuk, totalKeluar } = await laporanPeriode(mode)
      const saldo = await hitungSaldo()
      await sock.sendMessage(from, {
        text:
`📊 *Laporan ${mode}*
Pemasukan: ${formatRupiah(totalMasuk)}
Pengeluaran: ${formatRupiah(totalKeluar)}
Saldo akhir: ${formatRupiah(saldo)}`
      })

      lastReport[mode] = todayKey
      return
    }

 // ================= FOTO STRUK =================
if (msg.message.imageMessage) {
  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console })
  fs.writeFileSync('struk.jpg', buffer)

  const { data: { text: ocrText } } =
    await Tesseract.recognize(buffer, 'eng+ind', { logger: m => console.log(m) })
  console.log('Hasil OCR:', ocrText)

  let jumlah = null

  // 🔹 1. Cari baris dengan kata TOTAL BELANJA
  const match = ocrText.match(/TOTAL\s+BELANJA\s+([0-9.,]+)/i)
  if (match) {
    jumlah = match[1]
  } else {
    // 🔹 2. Fallback: ambil angka terbesar
    const angka = [...ocrText.matchAll(/(\d{1,3}(?:[.,]\d{3})+)/g)].map(m => cleanNumber(m[1]))
    if (angka.length) {
      jumlah = Math.max(...angka).toString()
    } else {
      jumlah = '0'
    }
  }

  // 🔹 Tentukan kategori & tipe
  let kategori = 'Belanja'
  let tipe = 'Pengeluaran'
  if (ocrText.toLowerCase().includes('gaji') || ocrText.toLowerCase().includes('salary')) {
    kategori = 'Gaji'
    tipe = 'Pemasukan'
  }

  // 🔹 Simpan ke sheet
  await tambahKeSheet(kategori, ringkasDeskripsi(ocrText), jumlah, tipe)
  const saldo = await hitungSaldo(true)

  await sock.sendMessage(from, {
    text: `✅ Struk dibaca.\nKategori: ${kategori}\nTotal: ${formatRupiah(cleanNumber(jumlah))}\nSaldo sekarang: ${formatRupiah(saldo)}`
  })
}

  })
}

startBot()
