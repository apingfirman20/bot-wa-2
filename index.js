import makeWASocket, {  
  useMultiFileAuthState,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import { google } from 'googleapis'
import Tesseract from 'tesseract.js'
import fs from 'fs'

// ================= FIX LOGGING ISSUE =================
// Simple logger replacement to avoid dependency issues
const createSimpleLogger = (prefix) => ({
  info: (msg) => console.log(`[${prefix}] ℹ️ ${msg}`),
  error: (msg) => console.error(`[${prefix}] ❌ ${msg}`),
  warn: (msg) => console.warn(`[${prefix}] ⚠️ ${msg}`),
  debug: (msg) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[${prefix}] 🔍 ${msg}`)
    }
  },
  // Dummy child method to prevent errors
  child: () => createSimpleLogger(prefix)
})

// Global logger instance
const logger = createSimpleLogger('BOT')

// ================= CONFIGURASI & ANTI-SPAM =================
const DEBUG = process.env.NODE_ENV !== 'production'
const userCooldown = new Map()
const COOLDOWN_TIME = 3000

// Fixed logging functions
function logInfo(message) {
  logger.info(message)
}

function logError(message) {
  logger.error(message)
}

// Anti-spam protection
function checkCooldown(userId) {
  const now = Date.now()
  const lastRequest = userCooldown.get(userId)
  
  if (lastRequest && (now - lastRequest) < COOLDOWN_TIME) {
    return false
  }
  
  userCooldown.set(userId, now)
  return true
}

// Emoji helper
const emoji = {
  money: '💰', chart: '📊', success: '✅', error: '❌', warning: '⚠️',
  clock: '⏰', receipt: '🧾', bank: '🏦', shopping: '🛍️',
  transportation: '🚗', salary: '💵', investment: '📈'
}

// Fixed Tesseract logger
const tesseractLogger = {
  logger: m => {
    if (DEBUG) {
      console.log(`[TESSERACT] ${m.status || m}`)
    }
  }
}

// ================= GOOGLE SHEETS =================
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}')

// Validate credentials
if (!credentials.client_email || !credentials.private_key) {
  logger.error('Google credentials tidak valid!')
  process.exit(1)
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
})

const sheets = google.sheets({ version: 'v4', auth })
const SPREADSHEET_ID = '1tms7gb0fWSkkO3vEKc-MJ4xlmgUhw3BxqXipO2JVj90'

function cleanNumber(str) {
  if (!str) return 0
  return parseInt(String(str).replace(/[^\d]/g, '')) || 0
}

function formatRupiah(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR'
  }).format(amount)
}

function ringkasDeskripsi(ocrText) {
  if (!ocrText) return 'Tidak terdeteksi'
  
  const lower = ocrText.toLowerCase()
  const mappings = {
    'tokopedia|shopee|lazada': `${emoji.shopping} Marketplace`,
    'alfamart|indomaret': `${emoji.shopping} Minimarket`,
    'gopay|ovo|dana': `${emoji.money} E-Wallet`,
    'grab|gojek': `${emoji.transportation} Transportasi`,
    'gaji|salary': `${emoji.salary} Gaji`,
    'investasi|investment': `${emoji.investment} Investasi`
  }
  
  for (const [pattern, result] of Object.entries(mappings)) {
    if (new RegExp(pattern).test(lower)) return result
  }
  
  return ocrText.slice(0, 30) + '...'
}

async function tambahKeSheet(kategori, deskripsi, jumlah, tipe) {
  try {
    const bersih = cleanNumber(jumlah)
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[new Date().toISOString(), kategori, deskripsi, bersih, tipe]]
      }
    })
    logInfo(`Data tersimpan: ${kategori} - ${formatRupiah(bersih)}`)
    return true
  } catch (error) {
    logError(`Gagal update sheet: ${error.message}`)
    return false
  }
}

// ================= BOT IMPLEMENTATION =================
let lastReport = { minggu: null, bulan: null }

const messageTemplates = {
  welcome: () => 
    `👋 Halo! Saya asisten keuangan Anda. Berikut yang bisa saya bantu:\n\n` +
    `📝 *Catat Transaksi:*\n` +
    `• Ketik "catat [jumlah] [kategori] [deskripsi]"\n` +
    `• Contoh: "catat 50000 makan siang resto padang"\n\n` +
    `🧾 *Scan Struk:*\n` +
    `• Kirim foto struk untuk otomatis dicatat\n\n` +
    `📊 *Laporan:*\n` +
    `• "laporan minggu ini"\n` +
    `• "laporan bulan ini"\n\n` +
    `💰 *Cek Saldo:*\n` +
    `• "saldo sekarang"`,

  cooldown: (seconds) => 
    `${emoji.clock} Tunggu sebentar ya... Silakan coba lagi dalam ${seconds} detik`,

  recordSuccess: (amount, category, balance) =>
    `${emoji.success} *Transaksi Tercatat!*\n\n` +
    `📋 Kategori: ${category}\n` +
    `💳 Nominal: ${formatRupiah(amount)}\n` +
    `💰 Saldo terkini: ${formatRupiah(balance)}`,

  receiptProcessed: (amount, category, balance) =>
    `${emoji.receipt} *Struk Berhasil Diproses!*\n\n` +
    `🔍 Terdeteksi: ${category}\n` +
    `💰 Total: ${formatRupiah(amount)}\n` +
    `🏦 Saldo: ${formatRupiah(balance)}`,

  balanceInfo: (balance, investment) =>
    `${emoji.bank} *Info Keuangan Anda*\n\n` +
    `💵 Saldo Tunai: ${formatRupiah(balance)}\n` +
    `📈 Nilai Investasi: ${formatRupiah(investment)}\n` +
    `📊 Total Aset: ${formatRupiah(balance + investment)}`,

  reportSummary: (period, income, expense, balance) =>
    `${emoji.chart} *Laporan ${period}*\n\n` +
    `⬆️ Pemasukan: ${formatRupiah(income)}\n` +
    `⬇️ Pengeluaran: ${formatRupiah(expense)}\n` +
    `📊 Saldo Bersih: ${formatRupiah(income - expense)}\n` +
    `💎 Saldo Akhir: ${formatRupiah(balance)}`
}

async function startBot() {
  try {
    logInfo('Memulai bot WhatsApp...')
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    
    // Fixed Baileys configuration with safe logger
    const sock = makeWASocket({ 
      auth: state,
      logger: DEBUG ? {
        level: 'debug',
        // Simple logger methods without .child()
        debug: (msg) => console.log(`[BAILEYS] ${msg}`),
        info: (msg) => console.log(`[BAILEYS] ${msg}`),
        warn: (msg) => console.warn(`[BAILEYS] ${msg}`),
        error: (msg) => console.error(`[BAILEYS] ${msg}`)
      } : { level: 'silent' }
    })

    sock.ev.on('creds.update', saveCreds)
    
    sock.ev.on('connection.update', ({ connection, qr }) => {
      if (connection === 'open') {
        logInfo('Bot berhasil terhubung ke WhatsApp!')
      }
      if (qr) {
        console.log('\n🔐 *QR CODE UNTUK LOGIN*')
        console.log('Scan kode berikut di WhatsApp Linked Devices:')
        console.log(qr + '\n')
      }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const msg = messages[0]
        if (!msg.message) return
        
        const from = msg.key.remoteJid
        const user = from.split('@')[0]
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        // Anti-spam check
        if (!checkCooldown(user)) {
          await sock.sendMessage(from, { 
            text: messageTemplates.cooldown(COOLDOWN_TIME / 1000) 
          })
          return
        }

        logInfo(`Pesan dari ${user}: ${text.substring(0, 50)}`)

        // Help command
        if (/^(halo|hi|help|menu|bot|start)/i.test(text)) {
          await sock.sendMessage(from, { text: messageTemplates.welcome() })
          return
        }

        // Catat manual
        if (text.startsWith('catat')) {
          const parts = text.split(' ')
          if (parts.length < 3) {
            await sock.sendMessage(from, {
              text: `${emoji.warning} Format salah! Contoh:\n"catat 50000 makan lunch kantin"`
            })
            return
          }

          const jumlah = parts[1]
          const tipe = parts[2]
          const deskripsi = parts.slice(3).join(' ') || 'Transaksi manual'

          let kategori = tipe
          let jenis = 'Pengeluaran'

          if (/masuk|income|pemasukan/i.test(tipe)) {
            jenis = 'Pemasukan'
            kategori = 'Pemasukan'
          } else if (/invest|emas|saham/i.test(tipe)) {
            jenis = 'Pengeluaran'
            kategori = 'Investasi'
          }

          const success = await tambahKeSheet(kategori, deskripsi, jumlah, jenis)
          
          if (success) {
            const saldo = await hitungSaldo()
            await sock.sendMessage(from, {
              text: messageTemplates.recordSuccess(cleanNumber(jumlah), kategori, saldo)
            })
          } else {
            await sock.sendMessage(from, {
              text: `${emoji.error} Gagal menyimpan data. Coba lagi nanti.`
            })
          }
          return
        }

        // Cek saldo
        if (/^(saldo|balance|cek saldo)/i.test(text)) {
          const [saldo, investasi] = await Promise.all([
            hitungSaldo(),
            hitungInvestasi()
          ])

          await sock.sendMessage(from, {
            text: messageTemplates.balanceInfo(saldo, investasi)
          })
          return
        }

        // Laporan
        if (/laporan/i.test(text)) {
          const mode = /minggu|week|pekan/i.test(text) ? 'minggu' : 'bulan'
          const periodText = mode === 'minggu' ? 'minggu ini' : 'bulan ini'
          const todayKey = new Date().toISOString().slice(0, 10)

          if (lastReport[mode] === todayKey) {
            await sock.sendMessage(from, {
              text: `${emoji.clock} Laporan ${periodText} sudah dilihat hari ini. Coba lagi besok!`
            })
            return
          }

          const [{ totalMasuk, totalKeluar }, saldo] = await Promise.all([
            laporanPeriode(mode),
            hitungSaldo()
          ])

          await sock.sendMessage(from, {
            text: messageTemplates.reportSummary(periodText, totalMasuk, totalKeluar, saldo)
          })

          lastReport[mode] = todayKey
          return
        }

        // Scan struk
        if (msg.message.imageMessage) {
          await processReceiptImage(sock, from, msg)
          return
        }

        // Unknown command
        if (text.trim()) {
          await sock.sendMessage(from, {
            text: `🤔 Maaf, perintah tidak dikenali. Ketik "menu" untuk melihat panduan.`
          })
        }

      } catch (error) {
        logError(`Error processing message: ${error.message}`)
      }
    })

    logInfo('Bot WhatsApp berhasil diinisialisasi!')

  } catch (error) {
    logError(`Startup error: ${error.message}`)
    throw error
  }
}

// Helper function untuk proses struk
async function processReceiptImage(sock, from, msg) {
  try {
    await sock.sendMessage(from, {
      text: `${emoji.receipt} Sedang memindai struk Anda...`
    })

    const buffer = await downloadMediaMessage(msg, 'buffer', {})
    const { data: { text: ocrText } } = await Tesseract.recognize(
      buffer, 'eng+ind', tesseractLogger
    )

    logInfo(`OCR hasil: ${ocrText.substring(0, 100)}`)

    // Amount detection
    const amountPatterns = [
      /(?:total|jumlah|amount)[\s:]*rp?\.?\s*([0-9.,]+)/i,
      /rp?\.?\s*([0-9.,]+)(?:\s*(?:total|jumlah))/i,
    ]

    let amount = '0'
    for (const pattern of amountPatterns) {
      const match = ocrText.match(pattern)
      if (match) {
        amount = match[1] || match[0]
        break
      }
    }

    if (amount === '0') {
      const numbers = ocrText.match(/(\d{1,3}([.,]\d{3})+)/g) || []
      amount = numbers.length > 0 ? numbers[numbers.length - 1] : '0'
    }

    // Auto-category detection
    let kategori = 'Belanja'
    let tipe = 'Pengeluaran'
    
    if (/gaji|salary|payroll/i.test(ocrText)) {
      kategori = `${emoji.salary} Gaji`
      tipe = 'Pemasukan'
    } else if (/invest|emas|gold/i.test(ocrText)) {
      kategori = `${emoji.investment} Investasi`
    }

    const cleanAmount = cleanNumber(amount)
    const success = await tambahKeSheet(kategori, ringkasDeskripsi(ocrText), cleanAmount, tipe)
    
    if (success) {
      const saldo = await hitungSaldo()
      await sock.sendMessage(from, {
        text: messageTemplates.receiptProcessed(cleanAmount, kategori, saldo)
      })
    } else {
      await sock.sendMessage(from, {
        text: `${emoji.error} Gagal menyimpan struk. Silakan coba catat manual.`
      })
    }

  } catch (error) {
    logError(`Error proses struk: ${error.message}`)
    await sock.sendMessage(from, {
      text: `${emoji.error} Maaf, struk tidak bisa diproses. Coba foto lebih jelas atau catat manual.`
    })
  }
}

// ================= SUPPORTING FUNCTIONS =================
async function hitungSaldo() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!G4'
    })
    return res.data.values?.[0]?.[0] ? cleanNumber(res.data.values[0][0]) : 0
  } catch (error) {
    logError(`Error hitung saldo: ${error.message}`)
    return 0
  }
}

async function hitungInvestasi() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!G7'
    })
    return res.data.values?.[0]?.[0] ? cleanNumber(res.data.values[0][0]) : 0
  } catch (error) {
    logError(`Error hitung investasi: ${error.message}`)
    return 0
  }
}

async function laporanPeriode(mode = 'minggu') {
  try {
    const now = new Date()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:E'
    })
    
    const rows = res.data.values || []
    let totalMasuk = 0, totalKeluar = 0

    for (let i = 1; i < rows.length; i++) {
      const [tgl, , , jml, tipe] = rows[i]
      if (!tgl || !jml || !tipe) continue

      const num = cleanNumber(jml)
      const date = new Date(tgl)

      let masukPeriode = false
      if (mode === 'minggu') {
        masukPeriode = (now - date) <= 7 * 24 * 60 * 60 * 1000
      } else {
        masukPeriode = date.getMonth() === now.getMonth() && 
                       date.getFullYear() === now.getFullYear()
      }

      if (masukPeriode) {
        if (tipe === 'Pemasukan') totalMasuk += num
        else if (tipe === 'Pengeluaran') totalKeluar += num
      }
    }
    
    return { totalMasuk, totalKeluar }
  } catch (error) {
    logError(`Error laporan: ${error.message}`)
    return { totalMasuk: 0, totalKeluar: 0 }
  }
}

// ================= START BOT WITH ERROR HANDLING =================
process.on('uncaughtException', (error) => {
  logError(`Uncaught Exception: ${error.message}`)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  logError(`Unhandled Rejection at: ${promise}, reason: ${reason}`)
  process.exit(1)
})

// Start the bot
startBot().then(() => {
  logInfo('Bot berhasil dijalankan!')
}).catch(error => {
  logError(`Gagal memulai bot: ${error.message}`)
  process.exit(1)
})
