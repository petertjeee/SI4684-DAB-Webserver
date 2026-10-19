// rds-native.js — decodor RDS nativ in JavaScript, fara dependente native.
//
// Logica de decodare este portata din RDSExpert de Lucas Gallone
// (https://github.com/LucasGallone/RDSExpert), licenta GPL-3.0.
// Acest fisier ramane sub GPL-3.0; pastrati atribuirea de mai sus.
//
// Acopera: PI (cu confirmare), PS, RT A/B, AF (metoda A), TP, TA, MS, PTY,
// DI, ECC (1A), CT (4A), PTYN (10A), RT+ (ODA 4BD7).

'use strict'

// ── Tabel caractere RDS G2 (EBU Latin, 0x80-0xFF) — portat din RDSExpert ────
const RDS_G2_MAP = {
  0x80:'á',0x81:'à',0x82:'é',0x83:'è',0x84:'í',0x85:'ì',0x86:'ó',0x87:'ò',
  0x88:'ú',0x89:'ù',0x8A:'Ñ',0x8B:'Ç',0x8C:'Ş',0x8D:'ß',0x8E:'¡',0x8F:'Ĳ',
  0x90:'â',0x91:'ä',0x92:'ê',0x93:'ë',0x94:'î',0x95:'ï',0x96:'ô',0x97:'ö',
  0x98:'û',0x99:'ü',0x9A:'ñ',0x9B:'ç',0x9C:'ş',0x9D:'ğ',0x9E:'ı',0x9F:'ĳ',
  0xA0:'ª',0xA1:'α',0xA2:'©',0xA3:'‰',0xA4:'Ğ',0xA5:'ě',0xA6:'Ň',0xA7:'ő',
  0xA8:'π',0xA9:'€',0xAA:'£',0xAB:'$',0xAC:'←',0xAD:'↑',0xAE:'→',0xAF:'↓',
  0xB0:'⁰',0xB1:'¹',0xB2:'²',0xB3:'³',0xB4:'±',0xB5:'İ',0xB6:'ń',0xB7:'ű',
  0xB8:'μ',0xB9:'¿',0xBA:'÷',0xBB:'°',0xBC:'¼',0xBD:'½',0xBE:'¾',0xBF:'§',
  0xC0:'Á',0xC1:'À',0xC2:'É',0xC3:'È',0xC4:'Í',0xC5:'Ì',0xC6:'Ó',0xC7:'Ò',
  0xC8:'Ú',0xC9:'Ù',0xCA:'Ř',0xCB:'Č',0xCC:'Š',0xCD:'Ž',0xCE:'Đ',0xCF:'Ŀ',
  0xD0:'Â',0xD1:'Ä',0xD2:'Ê',0xD3:'Ë',0xD4:'Î',0xD5:'Ï',0xD6:'Ô',0xD7:'Ö',
  0xD8:'Û',0xD9:'Ü',0xDA:'ř',0xDB:'č',0xDC:'š',0xDD:'ž',0xDE:'đ',0xDF:'ŀ',
  0xE0:'Ã',0xE1:'Å',0xE2:'Æ',0xE3:'Œ',0xE4:'ŷ',0xE5:'Ý',0xE6:'Õ',0xE7:'Ø',
  0xE8:'Þ',0xE9:'Ŋ',0xEA:'Ŕ',0xEB:'Ć',0xEC:'Ś',0xED:'Ź',0xEE:'Ŧ',0xEF:'ð',
  0xF0:'ã',0xF1:'å',0xF2:'æ',0xF3:'œ',0xF4:'ŵ',0xF5:'ý',0xF6:'õ',0xF7:'ø',
  0xF8:'þ',0xF9:'ŋ',0xFA:'ŕ',0xFB:'ć',0xFC:'ś',0xFD:'ź',0xFE:'ŧ',0xFF:' '
}

// ── Etichete RT+ (content types, standard RDS Forum) ─────────────────────────
const RT_PLUS_LABELS = {
  1:'Item: Title',2:'Item: Album',3:'Item: Track Number',4:'Item: Artist',
  5:'Item: Composition',6:'Item: Movement',7:'Item: Conductor',8:'Item: Composer',
  9:'Item: Band',10:'Item: Comment',11:'Item: Genre',12:'Info: News',
  13:'Info: News (local)',14:'Info: Stockmarket',15:'Info: Sport',16:'Info: Lottery',
  17:'Info: Horoscope',18:'Info: Daily Diversion',19:'Info: Health',20:'Info: Event',
  21:'Info: Scene',22:'Info: Cinema',23:'Info: TV',24:'Info: Date & Time',
  25:'Info: Weather',26:'Info: Traffic',27:'Info: Alarm',28:'Info: Advertisement',
  29:'Info: URL',30:'Info: Other',31:'Stationname: Short',32:'Stationname: Long',
  33:'Programme: Now',34:'Programme: Next',35:'Programme: Part',36:'Programme: Host',
  37:'Programme: Editorial Staff',38:'Programme: Frequency',39:'Homepage',
  40:'Sub-channel',41:'Phone: Hotline',42:'Phone: Studio',43:'Phone: Other',
  44:'SMS: Studio',45:'SMS: Other',46:'Email: Hotline',47:'Email: Studio',
  48:'MMS: Other',49:'Chat',50:'Chat: Centre',51:'Vote: Question',52:'Vote: Centre',
  59:'Place',60:'Appointment',61:'Identifier',62:'Purchase',63:'Get Data'
}

// ── Mod RBDS (America de Nord): unele encodere trimit punctuatie tipografica pe
// coduri care in tabela EBU-Latin inseamna altceva (ex. 0xB4 = '±' in EBU, dar
// '´'/apostrof in Windows-1252 folosit de statiile RBDS). Cand suntem pe RBDS,
// suprascriem caracterele care difera real si apar in practica pe RadioText.
let _rbdsMode = false
function setRdsRegion(region) { _rbdsMode = (region === 'rbds') }

// override-uri RBDS: cod -> caracter (mapare Windows-1252 pt zona de punctuatie)
const RBDS_OVERRIDE = {
  0x91: '\u2018', // ' left single quote
  0x92: '\u2019', // ' right single quote (apostrof tipografic)
  0x93: '\u201C', // " left double quote
  0x94: '\u201D', // " right double quote
  0x96: '\u2013', // – en dash
  0x97: '\u2014', // — em dash
  0xB4: '\u2019', // ´ -> apostrof (cazul GEMINI: "Won´t" -> "Won't")
  0x85: '\u2026', // … ellipsis
}

// ── Decodare octet RDS (portat: decodeRdsByte) ───────────────────────────────
let win1252 = null
try { win1252 = new TextDecoder('windows-1252') } catch (e) { win1252 = null }

function decodeRdsByte(b) {
  if (_rbdsMode && RBDS_OVERRIDE[b]) return RBDS_OVERRIDE[b]
  if (RDS_G2_MAP[b]) return RDS_G2_MAP[b]
  if (b <= 0x7F) return String.fromCharCode(b)
  if (win1252) return win1252.decode(new Uint8Array([b]))
  return String.fromCharCode(b) // fallback latin1
}

// ── Render buffer hibrid UTF-8 / G2 (portat: renderRdsBuffer) ────────────────
function renderBuffer(chars, isRt, isPs) {
  const bytes = Uint8Array.from(chars, c => (c ? c.charCodeAt(0) : 0x20))
  const hasHigh = bytes.some(b => b > 127)
  if (hasHigh) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return isRt ? decoded : decoded.replace(isPs ? /[\x00-\x1F]/g : /\0/g, isPs ? '-' : ' ')
    } catch (e) { /* nu e UTF-8 valid — cadem pe G2 */ }
  }
  let out = ''
  for (const b of bytes) {
    if (b === 0) { out += isRt ? '\0' : (isPs ? '-' : ' '); continue }
    if (b < 0x20 && b !== 0x0D) { out += isPs ? '-' : ' '; continue }
    out += b === 0x0D ? '\r' : decodeRdsByte(b)
  }
  return out
}

// ── Decodorul propriu-zis ─────────────────────────────────────────────────────
class RdsDecoder {
  // emit(tip, valoare) — apelat la fiecare schimbare
  constructor(emit) {
    this.emit = emit || (() => {})
    this.reset()
  }

  reset() {
    this.currentPi   = null
    this.piCandidate = null
    this.piCounter   = 0

    this.psBuffer = new Array(8).fill('\0')
    this.psMask   = new Array(8).fill(false)
    this.lastPs   = ''

    this.rtBuffer = [new Array(64).fill('\0'), new Array(64).fill('\0')]
    this.rtFlag   = null
    this.lastRt   = ''

    this.afG3s     = new Set()
    this.lastAfKey = ''

    this.ptynBuffer = new Array(8).fill('\0')
    this.lastPtyn   = ''

    this.lpsBuffer = new Array(32).fill('\0')
    this.lastLps   = ''

    // eRT (enhanced RadioText, UTF-8, ODA 6552)
    this.ertBuffer    = new Array(128).fill('\0')
    this.ertMask      = new Array(32).fill(false)
    this.ertOdaGroup  = null
    this.ertLastAbFlag = null
    this.lastErt      = ''
    // eRT+ (ODA 4BD8)
    this.ertPlusOdaGroup   = null
    this.ertPlusTags       = new Map()
    this.ertPlusItemRunning = false
    this.ertPlusItemToggle  = false

    this.lastTp = null; this.lastTa = null; this.lastMs = null; this.lastPty = null
    this.lastEcc = null
    this.di = { dynamicPty: null, compressed: null, artificialHead: null, stereo: null }

    this.rtPlusOdaGroup = null
    this.rtPlusTags = new Map()
    this.rtPlusItemRunning = false
    this.rtPlusItemToggle  = false
  }

  // payload: 16 hex (blocurile A-D) + optional 2 hex BLE (A=bitii 7-6 ... D=1-0)
  parseString(payload) {
    if (typeof payload !== 'string') return
    const s = payload.trim()
    if (s.length < 16 || !/^[0-9A-Fa-f]+$/.test(s.slice(0, 16))) return
    const ble = s.length >= 18 ? parseInt(s.slice(16, 18), 16) : 0
    const blk = []
    for (let i = 0; i < 4; i++) {
      const err = (ble >> (6 - i * 2)) & 0x03
      blk.push(err === 3 ? NaN : parseInt(s.slice(i * 4, i * 4 + 4), 16))
    }
    this.parseGroup(blk[0], blk[1], blk[2], blk[3])
  }

  parseGroup(g1, g2, g3, g4) {
    if (isNaN(g1) || isNaN(g2)) return

    // ── PI cu confirmare (portat) ──
    const piHex = g1.toString(16).toUpperCase().padStart(4, '0')
    if (piHex === this.piCandidate) this.piCounter++
    else { this.piCandidate = piHex; this.piCounter = 1 }
    if (this.piCounter >= 4 || (this.currentPi === null && this.piCounter >= 1)) {
      if (this.piCandidate !== this.currentPi) {
        this.currentPi = this.piCandidate
        // PI nou = statie noua: curatam tot ce e dependent de statie
        this.psBuffer.fill('\0'); this.psMask.fill(false); this.lastPs = ''
        this.rtBuffer[0].fill('\0'); this.rtBuffer[1].fill('\0'); this.lastRt = ''
        this.afG3s.clear(); this.lastAfKey = ''
        this.ptynBuffer.fill('\0'); this.lastPtyn = ''
        this.lpsBuffer.fill('\0'); this.lastLps = ''
        this.ertBuffer.fill('\0'); this.ertMask.fill(false); this.lastErt = ''
        this.ertOdaGroup = null; this.ertLastAbFlag = null
        this.ertPlusOdaGroup = null; this.ertPlusTags.clear()
        this.rtPlusOdaGroup = null; this.rtPlusTags.clear()
        this.emit('pi', this.currentPi)
        this.emit('af', [])
      }
    }

    const groupTypeVal = (g2 >> 11) & 0x1F
    const tp  = (g2 >> 10) & 0x01
    const pty = (g2 >> 5) & 0x1F
    if (tp  !== this.lastTp)  { this.lastTp  = tp;  this.emit('tp',  tp) }
    if (pty !== this.lastPty) { this.lastPty = pty; this.emit('pty', pty) }

    if (groupTypeVal === 0 || groupTypeVal === 1) this._group0(g2, g3, g4, groupTypeVal === 0)
    else if (groupTypeVal === 2 && !isNaN(g3)) this._group1A(g2, g3, g4)            // 1A
    else if (groupTypeVal === 4 || groupTypeVal === 5) this._group2(g2, g3, g4, groupTypeVal === 4) // 2A/2B
    else if (groupTypeVal === 6 && !isNaN(g3) && !isNaN(g4)) this._group3A(g2, g3, g4) // 3A
    else if (groupTypeVal === 8 && !isNaN(g3) && !isNaN(g4)) this._group4A(g2, g3, g4) // 4A
    else if (groupTypeVal === 20) this._group10A(g2, g3, g4)                        // 10A
    else if (groupTypeVal === 30) this._group15A(g2, g3, g4)                        // 15A Long PS
    else if (this.ertOdaGroup !== null && groupTypeVal === this.ertOdaGroup) {
      this._ert(g2, g3, g4)                                                        // eRT
    }
    else if (this.ertPlusOdaGroup !== null && groupTypeVal === this.ertPlusOdaGroup && (groupTypeVal & 1) === 0) {
      this._ertPlus(g2, g3, g4)                                                    // eRT+
    }
    else if (this.rtPlusOdaGroup !== null && groupTypeVal === this.rtPlusOdaGroup && (groupTypeVal & 1) === 0) {
      this._rtPlus(g2, g3, g4)
    }
  }

  // ── 0A/0B: PS, TA, MS, DI, AF ─────────────────────────────────────────────
  _group0(g2, g3, g4, isGroupA) {
    const ta = !!((g2 >> 4) & 0x01)
    const ms = (g2 >> 3) & 0x01
    const diBit = (g2 >> 2) & 0x01
    const address = g2 & 0x03

    if (ta !== this.lastTa) { this.lastTa = ta; this.emit('ta', ta) }
    if (ms !== this.lastMs) { this.lastMs = ms; this.emit('ms', ms) }

    const diKeys = ['dynamicPty', 'compressed', 'artificialHead', 'stereo']
    const k = diKeys[address]
    if (this.di[k] !== !!diBit) { this.di[k] = !!diBit; this.emit('di', { ...this.di }) }

    if (!isNaN(g4)) {
      const c1 = (g4 >> 8) & 0xFF, c2 = g4 & 0xFF
      if (c1 >= 0x20 && c2 >= 0x20) { // respinge caractere de control (portat)
        this.psBuffer[address * 2]     = String.fromCharCode(c1)
        this.psBuffer[address * 2 + 1] = String.fromCharCode(c2)
        this.psMask[address * 2] = true
        this.psMask[address * 2 + 1] = true
        // Construim PS folosind MASCA: pozitiile nesosite -> spatiu, cele sosite
        // -> caracterul real. Asa NU confundam o cratima reala din nume (ex.
        // "HRT-OS") cu markerul de segment lipsa. (Inainte inlocuiam toti '-' cu
        // spatiu, ceea ce strica numele cu cratima.)
        let ps
        const psBytes = Uint8Array.from(this.psBuffer, c => (c ? c.charCodeAt(0) : 0x20))
        if (psBytes.some(b => b > 127)) {
          // posibil UTF-8: incercam decodare, cu spatiu pt segmente nesosite
          try {
            ps = new TextDecoder('utf-8', { fatal: true }).decode(psBytes)
                   .split('').map((ch, i) => this.psMask[i] ? (ch.charCodeAt(0) >= 0x20 ? ch : ' ') : ' ').join('')
          } catch (e) { ps = null }
        }
        if (ps == null) {
          ps = ''
          for (let i = 0; i < 8; i++) {
            if (this.psMask[i]) {
              const cc = this.psBuffer[i] ? this.psBuffer[i].charCodeAt(0) : 0x20
              ps += (cc >= 0x20) ? decodeRdsByte(cc) : ' '
            } else {
              ps += ' '
            }
          }
        }
        if (ps !== this.lastPs) { this.lastPs = ps; this.emit('ps', ps) }
      }
    }

    if (isGroupA && !isNaN(g3)) this._afMethodA(g3)
  }

  // ── AF metoda A (portat, simplificat la lista de frecvente FM) ────────────
  _afMethodA(g3) {
    if (this.afG3s.has(g3)) return
    this.afG3s.add(g3)
    const decodeAf = c => (c >= 1 && c <= 204) ? (87.5 + c * 0.1).toFixed(1) : null
    const isHeader = v => v >= 224 && v <= 249
    const list = new Set()
    let lfMf = false
    for (const item of this.afG3s) {
      for (const b of [(item >> 8) & 0xFF, item & 0xFF]) {
        if (lfMf) { lfMf = false; continue }     // frecventa LF/MF — o sarim
        if (b === 250) { lfMf = true; continue } // urmeaza LF/MF
        if (isHeader(b)) continue                // header: numarul de AF-uri
        const f = decodeAf(b)
        if (f) list.add(f)
      }
    }
    const sorted = [...list].sort((a, b) => parseFloat(a) - parseFloat(b))
    const key = sorted.join(',')
    if (key !== this.lastAfKey) { this.lastAfKey = key; this.emit('af', sorted) }
  }

  // ── 1A: ECC (varianta 0) ──────────────────────────────────────────────────
  _group1A(g2, g3) {
    const variant = (g3 >> 12) & 0x07
    if (variant === 0) {
      const ecc = (g3 & 0xFF).toString(16).toUpperCase().padStart(2, '0')
      if (ecc !== this.lastEcc && ecc !== '00') { this.lastEcc = ecc; this.emit('ecc', ecc) }
    }
  }

  // ── 2A/2B: RadioText ──────────────────────────────────────────────────────
  _group2(g2, g3, g4, isGroupA) {
    const flag = (g2 >> 4) & 0x01
    const address = g2 & 0x0F
    if (this.rtFlag !== null && flag !== this.rtFlag) {
      this.rtBuffer[flag].fill('\0') // toggle A/B = text nou (portat)
    }
    this.rtFlag = flag
    const buf = this.rtBuffer[flag]
    const put = (idx, b) => { if (idx < 64 && (b >= 0x20 || b === 0x0D)) buf[idx] = String.fromCharCode(b) }
    if (isGroupA) {
      if (!isNaN(g3)) { put(address * 4,     (g3 >> 8) & 0xFF); put(address * 4 + 1, g3 & 0xFF) }
      if (!isNaN(g4)) { put(address * 4 + 2, (g4 >> 8) & 0xFF); put(address * 4 + 3, g4 & 0xFF) }
    } else {
      if (!isNaN(g4)) { put(address * 2,     (g4 >> 8) & 0xFF); put(address * 2 + 1, g4 & 0xFF) }
    }
    let rt = renderBuffer(buf, true, false)
    const cr = rt.indexOf('\r')
    if (cr !== -1) rt = rt.slice(0, cr)
    rt = rt.replace(/\0/g, ' ').trimEnd()
    if (rt && rt !== this.lastRt) {
      this.lastRt = rt
      this.emit('rt', rt)
      this._resolveRtPlus() // textul s-a schimbat — reactualizam tag-urile RT+
    }
  }

  // ── 3A: inregistrare ODA ──────────────────────────────────────────────────
  _group3A(g2, g3, g4) {
    const appGroup = g2 & 0x1F // grupul in care va sosi aplicatia
    if (g4 === 0x4BD7) {            // RT+
      this.rtPlusOdaGroup = appGroup
    } else if (g4 === 0x4BD8) {    // eRT+
      this.ertPlusOdaGroup = appGroup
    } else if (g4 === 0x6552) {    // eRT (enhanced RadioText)
      this.ertOdaGroup = appGroup
    }
  }

  // ── 4A: Clock-Time ────────────────────────────────────────────────────────
  _group4A(g2, g3, g4) {
    const mjd = ((g2 & 0x03) << 15) | ((g3 >> 1) & 0x7FFF)
    if (mjd < 15079) return
    const hour = ((g3 & 0x01) << 4) | ((g4 >> 12) & 0x0F)
    const min  = (g4 >> 6) & 0x3F
    const offSign = (g4 >> 5) & 0x01
    const offset  = (g4 & 0x1F) * (offSign ? -0.5 : 0.5)
    if (hour > 23 || min > 59) return
    // MJD -> data calendaristica
    const jd = mjd + 2400000.5
    const z = Math.floor(jd + 0.5)
    const a = Math.floor((z - 1867216.25) / 36524.25)
    const aa = z + 1 + a - Math.floor(a / 4)
    const b = aa + 1524
    const c = Math.floor((b - 122.1) / 365.25)
    const d = Math.floor(365.25 * c)
    const e = Math.floor((b - d) / 30.6001)
    const day = b - d - Math.floor(30.6001 * e)
    const month = e < 14 ? e - 1 : e - 13
    const year = month > 2 ? c - 4716 : c - 4715
    this.emit('ct', {
      utc: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00Z`,
      offsetHours: offset
    })
  }

  // ── 10A: PTYN ─────────────────────────────────────────────────────────────
  _group10A(g2, g3, g4) {
    const seg = g2 & 0x01
    const put = (idx, b) => { if (b >= 0x20) this.ptynBuffer[idx] = String.fromCharCode(b) }
    if (!isNaN(g3)) { put(seg * 4,     (g3 >> 8) & 0xFF); put(seg * 4 + 1, g3 & 0xFF) }
    if (!isNaN(g4)) { put(seg * 4 + 2, (g4 >> 8) & 0xFF); put(seg * 4 + 3, g4 & 0xFF) }
    const ptyn = renderBuffer(this.ptynBuffer, false, false).trim()
    if (ptyn && ptyn !== this.lastPtyn) { this.lastPtyn = ptyn; this.emit('ptyn', ptyn) }
  }

  // ── 15A: Long PS (nume statie pana la 32 caractere, UTF-8) ────────────────
  _group15A(g2, g3, g4) {
    const idx = (g2 & 0x0F) * 4
    if (idx >= 32) return
    const put = (i, b) => { if (i < 32 && b >= 0x20) this.lpsBuffer[i] = String.fromCharCode(b) }
    if (!isNaN(g3)) { put(idx,     (g3 >> 8) & 0xFF); put(idx + 1, g3 & 0xFF) }
    if (!isNaN(g4)) { put(idx + 2, (g4 >> 8) & 0xFF); put(idx + 3, g4 & 0xFF) }
    const lps = renderBuffer(this.lpsBuffer, false, false).replace(/\0/g, ' ').trim()
    if (lps && lps !== this.lastLps) { this.lastLps = lps; this.emit('lps', lps) }
  }

  // ── eRT: enhanced RadioText (UTF-8, structura ca 2A) ──────────────────────
  _ert(g2, g3, g4) {
    if (isNaN(g3) || isNaN(g4)) return
    const abFlag = (g2 >> 4) & 0x01
    const address = g2 & 0x0F
    if (this.ertLastAbFlag !== null && this.ertLastAbFlag !== abFlag) {
      this.ertBuffer.fill('\0'); this.ertMask.fill(false)
    }
    this.ertLastAbFlag = abFlag
    if (address === 0 && this.ertBuffer.includes('\r')) {
      this.ertBuffer.fill('\0'); this.ertMask.fill(false)
    }
    const bytes = [(g3 >> 8) & 0xFF, g3 & 0xFF, (g4 >> 8) & 0xFF, g4 & 0xFF]
    const start = address * 4
    let endReached = false
    for (let i = 0; i < bytes.length; i++) {
      if (start + i < 128) this.ertBuffer[start + i] = String.fromCharCode(bytes[i])
      if (bytes[i] === 0x0D) { endReached = true; break }
    }
    this.ertMask[address] = true
    if (endReached || address >= 30) {
      let ert = renderBuffer(this.ertBuffer, true, false)
      const cr = ert.indexOf('\r')
      if (cr !== -1) ert = ert.slice(0, cr)
      ert = ert.replace(/\0/g, '').trim()
      if (ert && ert !== this.lastErt) {
        this.lastErt = ert
        this.emit('ert', ert)
        this._resolveErtPlus()
      }
    }
  }

  // ── eRT+: tag-uri pe eRT (ca RT+, dar rezolvate din textul eRT) ────────────
  _ertPlus(g2, g3, g4) {
    const g2Spare = g2 & 0x07
    this.ertPlusItemToggle  = !!((g2 >> 4) & 0x01)
    this.ertPlusItemRunning = !!((g2 >> 3) & 0x01)
    const processTag = (id, start, len) => {
      if (id === 0) return
      this.ertPlusTags.set(id, { contentType: id, start, length: len,
        label: RT_PLUS_LABELS[id] || `TAG ${id}`, text: '' })
    }
    if (!isNaN(g3)) {
      const t1 = (g2Spare << 3) | ((g3 >> 13) & 0x07)
      if (t1 !== 0 && ((g3 >> 7) & 0x3F) + ((g3 >> 1) & 0x3F) < 70) {
        processTag(t1, (g3 >> 7) & 0x3F, (g3 >> 1) & 0x3F)
      }
    }
    if (!isNaN(g4)) {
      const t2 = ((g3 & 0x01) << 5) | ((g4 >> 11) & 0x1F)
      if (t2 !== 0 && ((g4 >> 5) & 0x3F) + (g4 & 0x1F) < 70) {
        processTag(t2, (g4 >> 5) & 0x3F, g4 & 0x1F)
      }
    }
    this._resolveErtPlus()
  }

  _resolveErtPlus() {
    if (this.ertPlusTags.size === 0 || !this.lastErt) return
    let changed = false
    for (const tag of this.ertPlusTags.values()) {
      const text = this.lastErt.substr(tag.start, tag.length + 1).trim()
      if (text && text !== tag.text) { tag.text = text; changed = true }
    }
    if (changed) {
      const tags = [...this.ertPlusTags.values()].filter(t => t.text)
        .map(t => ({ type: t.contentType, label: t.label, text: t.text }))
      if (tags.length) {
        this.emit('ertplus', { tags, itemRunning: this.ertPlusItemRunning, itemToggle: this.ertPlusItemToggle })
      }
    }
  }

  // ── RT+ (grupul de aplicatie inregistrat prin 3A/4BD7) — portat ───────────
  _rtPlus(g2, g3, g4) {
    const g2Spare = g2 & 0x07
    this.rtPlusItemToggle  = !!((g2 >> 4) & 0x01)
    this.rtPlusItemRunning = !!((g2 >> 3) & 0x01)
    const processTag = (id, start, len) => {
      if (id === 0) return
      this.rtPlusTags.set(id, { contentType: id, start, length: len,
        label: RT_PLUS_LABELS[id] || `TAG ${id}`, text: '', ts: Date.now() })
    }
    if (!isNaN(g3)) {
      const t1 = (g2Spare << 3) | ((g3 >> 13) & 0x07)
      if (t1 !== 0 && ((g3 >> 7) & 0x3F) + ((g3 >> 1) & 0x3F) < 70) {
        processTag(t1, (g3 >> 7) & 0x3F, (g3 >> 1) & 0x3F)
      }
    }
    if (!isNaN(g4)) {
      const t2 = ((g3 & 0x01) << 5) | ((g4 >> 11) & 0x1F)
      if (t2 !== 0 && ((g4 >> 5) & 0x3F) + (g4 & 0x1F) < 70) {
        processTag(t2, (g4 >> 5) & 0x3F, g4 & 0x1F)
      }
    }
    this._resolveRtPlus()
  }

  _resolveRtPlus() {
    if (this.rtPlusTags.size === 0) return
    let changed = false
    for (const tag of this.rtPlusTags.values()) {
      const text = this.lastRt.substr(tag.start, tag.length + 1).trim()
      if (text && text !== tag.text) { tag.text = text; changed = true }
    }
    if (changed) {
      const tags = [...this.rtPlusTags.values()]
        .filter(t => t.text)
        .map(t => ({ type: t.contentType, label: t.label, text: t.text }))
      if (tags.length) {
        this.emit('rtplus', {
          tags,
          itemRunning: this.rtPlusItemRunning,
          itemToggle:  this.rtPlusItemToggle
        })
      }
    }
  }
}

module.exports = { RdsDecoder, setRdsRegion }
