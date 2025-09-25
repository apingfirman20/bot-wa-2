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
    range: 'Sheet1!A:E'
  })
  const rows = res.data.values || []
  let saldo = 0

  for (let i = 1; i < rows.length; i++) {
    const [,, , jml, tipe] = rows[i]
    const num = cleanNumber(jml)
    if (tipe === 'Pemasukan') saldo += num
    else if (tipe === 'Pengeluaran') saldo -= num
  }
  return saldo
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
      const kategori = tipe
      const jenis = tipe.toLowerCase().includes('masuk') ? 'Pemasukan' : 'Pengeluaran'
      await tambahKeSheet(kategori, deskripsi.join(' '), jumlah, jenis)

      const saldo = await hitungSaldo()
      await sock.sendMessage(from, {
        text: `✅ Data tersimpan!\nSaldo terkini: Rp${saldo}`
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

      // 🔹 Gunakan ringkasDeskripsi
      await tambahKeSheet('Belanja', ringkasDeskripsi(ocrText), jumlah, 'Pengeluaran')
      const saldo = await hitungSaldo()
      await sock.sendMessage(from, {
        text: `✅ Struk dibaca.\nTotal: Rp${cleanNumber(jumlah)}\nSaldo sekarang: Rp${saldo}`
      })
    }
  })
}

startBot()
