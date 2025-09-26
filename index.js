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

// Fungsi bersihkan angka
function cleanNumber(str) {
  return parseInt(String(str).replace(/[^\d]/g, '')) || 0
}

// 🔹 Fungsi ringkas deskripsi dari OCR
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
  return ocrText.slice(0, 30) // default: potong 30 karakter biar singkat
}

// Tambah data ke sheet
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

// Hitung saldo terkini
async function hitungSaldo() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!G4'
  })
  const values = res.data.values || []
  return values[0] ? cleanNumber(values[0][0]) : 0
}

// Ambil nilai investasi dari G7
async function hitungInvestasi() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!G7'
  })
  const values = res.data.values || []
  return values[0] ? cleanNumber(values[0][0]) : 0
}

// Laporan mingguan/bulanan
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
    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text

    // ---- Catat manual ----
    if (text?.startsWith('catat')) {
      const [_, jumlah, tipe, ...deskripsi] = text.split(' ')
      let kategori = tipe
      let jenis = 'Pengeluaran'

      if (tipe.toLowerCase().includes('masuk')) {
        jenis = 'Pemasukan'
        kategori = 'Pemasukan'
      } else if (tipe.toLowerCase().includes('invest')) {
        jenis = 'Pengeluaran'
        kategori = 'Investasi'
      }

      await tambahKeSheet(kategori, deskripsi.join(' '), jumlah, jenis)
      const saldo = await hitungSaldo()
      await sock.sendMessage(from, {
        text: `✅ Data tersimpan!\nSaldo terkini: Rp${saldo}`
      })
      return
    }

    // ================== UPDATE HARGA BUYBACK ==================
async function updateGoldBuyback(sock, from) {
  // Sheet1 = sheet utama, HargaBuyback = sheet data harga
  const buybackRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'HargaBuyback!A:B'  // asumsi kolom A = Denominasi, B = Galeri 24
  })

  const rows = buybackRes.data.values || []
  let harga = null

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === '1 Gr') {
      harga = rows[i][1]
      break
    }
  }

  if (harga) {
    // Masukkan harga ke H9 di Sheet1
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!H9',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[harga]] }
    })

    // Kirim feedback ke WA
    await sock.sendMessage(from, {
      text: `✅ Harga buyback Galeri 24 (1gr) sudah diupdate: Rp${harga}`
    })
  } else {
    await sock.sendMessage(from, {
      text: `⚠️ Tidak ditemukan harga "1 Gr" di sheet HargaBuyback`
    })
  }
}


    // ---- Update Saldo ----
    if (/update saldo/i.test(text)) {
      const saldo = await hitungSaldo()
      const investasi = await hitungInvestasi()

      await sock.sendMessage(from, {
        text: `🔄 Update Saldo:\nSaldo Terkini: Rp${saldo}\nNilai Investasi: Rp${investasi}`
      })
      return
    }

    // ---- Laporan ----
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
`📊 Laporan ${mode}
Pemasukan: Rp${totalMasuk}
Pengeluaran: Rp${totalKeluar}
Saldo akhir: Rp${saldo}`
      })

      lastReport[mode] = todayKey
      return
    }

    // ---- Foto struk ----
    if (msg.message.imageMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console })
      fs.writeFileSync('struk.jpg', buffer)

      const { data: { text: ocrText } } =
        await Tesseract.recognize(buffer, 'eng+ind', { logger: m => console.log(m) })
      console.log('Hasil OCR:', ocrText)

      const totalRegex = /(Total|TOTAL|Jumlah)\s*[.:]?\s*Rp?\s*([0-9.,]+)/i
      let match = ocrText.match(totalRegex)
      let jumlah = match ? match[2] : null
      if (!jumlah) {
        const angka = [...ocrText.matchAll(/(\d{1,3}([.,]\d{3})+)/g)]
        jumlah = angka.length ? angka[angka.length - 1][1] : '0'
      }

      // 🔹 Deteksi apakah struk ini Gaji
      let kategori = 'Belanja'
      let tipe = 'Pengeluaran'
      if (ocrText.toLowerCase().includes('gaji') || ocrText.toLowerCase().includes('salary')) {
        kategori = 'Gaji'
        tipe = 'Pemasukan'
      }

      await tambahKeSheet(kategori, ringkasDeskripsi(ocrText), jumlah, tipe)
      const saldo = await hitungSaldo()
      await sock.sendMessage(from, {
        text: `✅ Struk dibaca.\nKategori: ${kategori}\nTotal: Rp${cleanNumber(jumlah)}\nSaldo sekarang: Rp${saldo}`
      })
    }
  })
}

startBot()
