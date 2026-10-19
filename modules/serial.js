const { SerialPort } = require('serialport')
const { ReadlineParser } = require('@serialport/parser-readline')
const fs = require('fs')
const config = require('../config.json')
const { state, DAB_CHANNELS, AUDIO_MODES, getScanResultsCompact } = require('./state')
const { broadcast, setSerialPort: setWsPort } = require('./websocket')
const { setSerialPort: setScannerPort } = require('./scanner')
const { initRds, rdsParseString, rdsClear } = require('./rds')
const { getLastState, saveLastState } = require('./laststate')
const { info, warn, error } = require('./logger')

let port = null
let slideshowChunks = []
let collectingBase64 = false
let _awaitingTune = false   // tussen >>> TUNE=X en *TUNE=X — $L= in dit venster negeren

function getServiceType(id) {
  const svc = state.servicesList.find(s => s.id === String(id))
  return svc ? svc.type : null
}

function resetMuxState() {
  state.ensemble     = null
  state.ensembleName = null
  state.ecc          = null
  state.dabTime      = null
  state.servicesList = []
  state.serviceInfo  = {}
  state.serviceType  = null
  state.dynamicLabel = null
  state.dlPlus       = {}
  state.slideshow    = null
  slideshowChunks    = []
  collectingBase64   = false
  state._cachedServicesList = null
  broadcast({ type: 'muxReset' })
  broadcast({ type: 'image', data: fs.readFileSync('./public/images/default.jpg').toString('base64') })
}

function resetFmState() {
  state.fmPI = null
  state.fmPS = null
  state.fmRT = null
  state.fmAF = []
  rdsClear()
}

function initSerial() {
  if (!config.serial.port) {
    warn('Serial port not configured, skipping. Use /setup to configure.')
    return null
  }
  port = new SerialPort({
    path: config.serial.port,
    baudRate: config.serial.baudRate
  })

  setScannerPort(port)
  setWsPort(port)

  initRds()

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))

  port.on('open', () => {
    info(`Port Serial ${port.path} opened`)
    port.write('ENABLE=0\n')
    setTimeout(() => {
      port.write('ENABLE=1\n')
      state.enabled = true
      info('SI468X Receiver enabled')

      // Boot-sequentie uit lastState: MODE eerst (firmware-upload ~1s),
      // dan de rest op 200ms afstand, TUNE met extra pauze.
      const ls = getLastState()
      const dabOn = config.dab?.enabled !== false
      const fmOn  = config.fm?.enabled !== false
      let bootMode = ls.mode === 'fm' ? 'fm' : 'dab'
      if (!dabOn && !fmOn) bootMode = 'dab'
      else if (bootMode === 'fm' && !fmOn) bootMode = 'dab'
      else if (bootMode === 'dab' && !dabOn) bootMode = 'fm'
      state.mode = bootMode

      const seq = [`MODE=${bootMode}`]
      if (bootMode === 'fm') {
        seq.push('DEBUG=1')
        seq.push(`DEEMPH=${ls.deemph || 50}`)
        const seekCfg = config.fm?.seek
        if (seekCfg?.rssiThreshold !== undefined) seq.push(`FMSEEKRSSI=${seekCfg.rssiThreshold}`)
        if (seekCfg?.snrThreshold  !== undefined) seq.push(`FMSEEKSNR=${seekCfg.snrThreshold}`)
        if (ls.fmFreq) seq.push(`TUNE=${ls.fmFreq}`)
      } else {
        seq.push('DEBUG=1')
        if (ls.dabTune !== null && ls.dabTune !== undefined) seq.push(`TUNE=${ls.dabTune}`)
      }

      let t = 0
      seq.forEach((cmd, i) => {
        if (i === 0) t = 0
        else if (cmd.startsWith('TUNE=')) t += 1200
        else t += 200
        setTimeout(() => port.write(cmd + '\n'), t)
      })

      if (config.scan?.autoScanOnStart && bootMode === 'dab') {
        setTimeout(() => {
          const { startScan } = require('./scanner')
          startScan(null)
        }, t + 3000)
      }
    }, 300)
  })

  port.on('error', err => error(`Serial error: ${err.message}`))
  port.on('close', () => warn(`Port Serial ${port.path} closed`))

  parser.on('data', raw => {
    const line = raw.trim()
    if (!line) return

    if (collectingBase64) {
      if (line.startsWith('$') || line.startsWith('*')) {
        collectingBase64 = false
        const buf = slideshowChunks.join('')
        slideshowChunks = []
        setImmediate(() => {
          state.slideshow = buf
          if (buf) broadcast({ type: 'image', data: buf })
        })
      } else {
        slideshowChunks.push(line)
        return
      }
    }

    if (line.startsWith('$M=SLIDESHOW=1,BASE64=')) {
      const buf = line.slice(22).trim()
      state.slideshow = buf
      state.slideshowMime = 'image/jpeg'
      if (buf) broadcast({ type: 'image', data: buf, mime: 'image/jpeg' })
      return
    }

    if (line.startsWith('$M=SLIDESHOW=2,BASE64=')) {
      const buf = line.slice(22).trim()
      state.slideshow = buf
      state.slideshowMime = 'image/png'
      if (buf) broadcast({ type: 'image', data: buf, mime: 'image/png' })
      return
    }

    if (line.startsWith('$M=SLIDESHOW=0') || line.startsWith('$M=SLIDESHOW=3')) {
      state.slideshow = ''
      state.slideshowMime = ''
      return
    }

    if (line.startsWith('*SERVICE=')) {
      state.service     = line.slice(9).trim()
      state.serviceType = getServiceType(state.service)
      saveLastState({ dabService: state.service })
      state.slideshow   = null
      state.dlPlus      = {}
      state.dynamicLabel = null
      broadcast({ type: 'service', id: state.service, serviceType: state.serviceType })
      broadcast({ type: 'image', data: fs.readFileSync('./public/images/default.jpg').toString('base64') })
      return
    }

    if (line.startsWith('*MODE=')) {
      const mode = line.slice(6).trim().toLowerCase()
      state.mode = mode
      if (mode === 'fm') resetFmState()
      saveLastState({ mode })
      broadcast({ type: 'mode', data: mode })
      return
    }

    if (line.startsWith('*BANDSCAN=')) {
      const body = line.slice(10)
      const ci = body.indexOf(':')
      if (ci > 0) {
        const head = body.slice(0, ci).split(',').map(Number)
        const rssi = body.slice(ci + 1).split(',').map(Number)
        if (head.length === 3 && rssi.length > 1) {
          state.fmBandscan = { start: head[0], stop: head[1], step: head[2], rssi, ts: Date.now() }
          broadcast({ type: 'fmBandscan', data: state.fmBandscan })
          info(`FM bandscan: ${rssi.length} points (${head[0]}-${head[1]} kHz)`)
        }
      }
      return
    }

    if (line.startsWith('*SEEKFAIL=')) {
      broadcast({ type: 'fmSeekStatus', active: false, reason: 'no-station', freq: state.fmFreq || null })
      const { stopFmSeek } = require('./websocket')
      if (typeof stopFmSeek === 'function') stopFmSeek('no-station', false)
      return
    }

    if (line.startsWith('$P=')) {
      // PI komt separaat — RDS-decoder haalt hem uit $R=
      return
    }

    if (line.startsWith('$R=')) {
      rdsParseString(line.slice(3).trim())
      return
    }

    if (line.startsWith('*TUNE=')) {
      const newTune = line.slice(6).trim()
      _awaitingTune = false
      if (state.mode === 'fm') {
        state.fmFreq = parseInt(newTune)
        state.fmFreqTs = Date.now()
        rdsClear()
        broadcast({ type: 'fmFreq', data: state.fmFreq })
        broadcast({ type: 'fmRdsClear' })
        const { stopFmSeek } = require('./websocket')
        if (typeof stopFmSeek === 'function') stopFmSeek('done', true)
      } else {
        if (state.tune !== newTune) {
          state.tune = newTune
          resetMuxState()
        }
        saveLastState({ dabTune: state.tune })
        broadcast({ type: 'tune', data: state.tune })
      }
      return
    }

    if (line.startsWith('$M=')) return

    if (line.startsWith('$L=')) {
      if (_awaitingTune) return   // verouderde mux-lijst tussen TUNE en ack — negeren
      const content = line.slice(3)
      const [headerPart, servicesPartRaw] = content.split(';SERVICES=')
      const headerParts = headerPart.split(',')
      const ensembleField = headerParts.find(x => x.startsWith('ENSEMBLE='))
      if (ensembleField) state.ensemble = ensembleField.slice(9).trim()
      const eccField = headerParts.find(x => x.startsWith('ECC='))
      state.ecc = eccField ? eccField.slice(4).trim() : null
      const ensembleIndex = headerParts.indexOf(ensembleField)
      if (ensembleIndex !== -1 && headerParts[ensembleIndex + 1]) {
        const cand = headerParts[ensembleIndex + 1].trim()
        if (!cand.includes('=')) state.ensembleName = cand
      }
      if (servicesPartRaw) {
        state.servicesList = servicesPartRaw.split(';').map(s => {
          const parts = s.split(',')
          const rawName = parts.slice(2).join(',').trim()
          const barIdx = rawName.indexOf('|')
          return {
            id:    parts[0]?.trim(),
            type:  parts[1]?.trim(),
            name:  (barIdx >= 0 ? rawName.slice(0, barIdx) : rawName).trim(),
            short: barIdx >= 0 ? rawName.slice(barIdx + 1).trim() : null
          }
        }).filter(s => s.id !== undefined && s.name)
      }
      if (state.service && !state.serviceType) {
        state.serviceType = getServiceType(state.service)
      }
      broadcast({ type: 'ensembleInfo', ensemble: state.ensemble, ensembleName: state.ensembleName, ecc: state.ecc })
      broadcast({ type: 'servicesList', data: state.servicesList })

      const ch = parseInt(state.tune)
      if (!isNaN(ch)) {
        if (state.scanResults[ch] && state.ensemble &&
            state.scanResults[ch].ensembleId &&
            state.scanResults[ch].ensembleId !== state.ensemble) {
          state.scanResults[ch] = null
        }
        if (!state.scanResults[ch]) {
          state.scanResults[ch] = {
            ch,
            name:       DAB_CHANNELS[ch].name,
            freq:       DAB_CHANNELS[ch].freq,
            signal:     parseFloat(state.signal?.SIGNAL) || 0,
            lock:       true,
            ensemble:   state.ensembleName,
            ensembleId: state.ensemble,
            ecc:        state.ecc,
            services:   []
          }
        }
        const newServices = state.servicesList
          .map(s => ({ id: s.id, name: s.name, short: s.short, type: s.type }))
        if (newServices.length > 0) {
          if (newServices.length >= (state.scanResults[ch].services?.length || 0)) {
            state.scanResults[ch].ensemble   = state.ensembleName
            state.scanResults[ch].ensembleId = state.ensemble
            state.scanResults[ch].ecc        = state.ecc
            state.scanResults[ch].lock       = true
            state.scanResults[ch].services   = newServices
            broadcast({ type: 'scanResultsUpdated', data: getScanResultsCompact() })
          }
        }
      }
      return
    }

    if (line.startsWith('$I=')) {
      const obj = {}
      line.slice(3).split(';').forEach(p => {
        const idx = p.indexOf('=')
        if (idx === -1) return
        obj[p.slice(0, idx).trim()] = p.slice(idx + 1).trim()
      })
      obj.TYPE = state.serviceType
      state.serviceInfo = obj
      broadcast({ type: 'serviceInfo', data: obj })
      return
    }

    if (line.startsWith('$D=')) {
      let text = line.slice(3)
      if (text.startsWith('RT=')) text = text.slice(3)
      state.dynamicLabel = text.trim()
      broadcast({ type: 'dynamicLabel', data: state.dynamicLabel })
      return
    }

    if (line.startsWith('$S=')) {
      const obj = {}
      line.slice(3).split(',').forEach(p => {
        const idx = p.indexOf('=')
        if (idx === -1) return
        obj[p.slice(0, idx).trim()] = p.slice(idx + 1).trim()
      })
      if (state.mode === 'fm') {
        if (obj.SIGNAL !== undefined) state.fmSignal = obj.SIGNAL
        if (obj.SNR    !== undefined) state.fmSNR    = obj.SNR
        if (obj.PILOT  !== undefined) state.fmPilot  = obj.PILOT === '1'
        if (obj.BLEND  !== undefined) state.fmBlend  = parseInt(obj.BLEND)
        if (obj.MULT   !== undefined) state.fmMult   = parseInt(obj.MULT)
        broadcast({ type: 'fmSignal', data: obj })
        const { updateBandscanPoint } = require('./scanner')
        if (updateBandscanPoint) updateBandscanPoint(parseFloat(obj.SIGNAL))
        return
      }
      state.signal = obj
      broadcast({ type: 'signal', data: obj })

      const ch = parseInt(state.tune)
      if (!isNaN(ch) && state.scanResults[ch]) {
        state.scanResults[ch].signal = parseFloat(obj.SIGNAL) || 0
        state.scanResults[ch].lock   = obj.LOCK === '1'
        state.scanResults[ch].cnr    = parseFloat(obj.CNR) || 0
        state.scanResults[ch].snr    = parseFloat(obj.SNR) || 0
        state.scanResults[ch].fic    = parseFloat(obj.FIC) || 0
        broadcast({ type: 'scanUpdate', ch, signal: state.scanResults[ch].signal, lock: obj.LOCK === '1' })
      }
      return
    }

    if (line.startsWith('$DBG')) {
      const obj = {}
      line.slice(4).trim().split(/\s+/).forEach(p => {
        const idx = p.indexOf('=')
        if (idx === -1) return
        obj[p.slice(0, idx).trim()] = p.slice(idx + 1).trim()
      })
      state.debug = obj
      broadcast({ type: 'debug', data: obj })

      const ch = parseInt(state.tune)
      if (!isNaN(ch) && state.scanResults[ch] && state.scanResults[ch].lock) {
        state.scanResults[ch].fiberr = parseInt(obj.FIBERR) || 0
      }
      return
    }

    if (line.startsWith('$DP=')) {
      const obj = {}
      line.slice(4).split('|').forEach(p => {
        const idx = p.indexOf('=')
        if (idx === -1) return
        obj[p.slice(0, idx).trim()] = p.slice(idx + 1).trim()
      })
      state.dlPlus = { ...state.dlPlus, ...obj }
      broadcast({ type: 'dlPlus', data: state.dlPlus })
      return
    }

    if (line.startsWith('$TIME=')) {
      state.dabTime = line.slice(6).trim()
      broadcast({ type: 'dabTime', data: state.dabTime })
      return
    }
  })

  return port
}

function setAwaitingTune(val) { _awaitingTune = val }

module.exports = { initSerial, resetMuxState, resetFmState, setAwaitingTune }
