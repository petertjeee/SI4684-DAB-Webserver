const { state, DAB_CHANNELS, AUDIO_MODES, getScanResultsCompact } = require('./state')
const { broadcast } = require('./websocket')
const fs = require('fs')

let scanning = false
let serialPort = null

function setSerialPort(p) {
  serialPort = p
}

function stopScan() {
  scanning = false
}

// Live-update van het RSSI-punt op de huidige FM-frequentie in de bandscan
function updateBandscanPoint(rssi) {
  const bs = state.fmBandscan
  if (!bs || !Array.isArray(bs.rssi) || !state.fmFreq || !isFinite(rssi)) return
  if (state.fmSeeking) return
  if (Date.now() - (state.fmFreqTs || 0) < 1500) return
  const idx = (state.fmFreq - bs.start) / bs.step
  if (!Number.isInteger(idx) || idx < 0 || idx >= bs.rssi.length) return
  const val = Math.round(rssi)
  if (bs.rssi[idx] === val) return
  bs.rssi[idx] = val
  broadcast({ type: 'fmBandscanPoint', idx, rssi: val })
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForLock(maxMs) {
  return new Promise(async resolve => {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (state.signal?.LOCK === '1') return resolve(true)
      await sleepMs(100)
    }
    resolve(false)
  })
}

async function startScan(ws) {
  if (state.mode !== 'dab') {
    if (ws) ws.send(JSON.stringify({ type: 'scanError', data: 'DAB scan only in DAB mode' }))
    return
  }
  if (scanning) {
    if (ws) ws.send(JSON.stringify({ type: 'scanError', data: 'Scan already in progress' }))
    return
  }

  scanning = true
  state.scanning = true
  state.signal = {}

  try {
    const defaultImg = fs.readFileSync('./public/images/default.jpg')
    broadcast({ type: 'image', data: defaultImg.toString('base64') })
  } catch(e) {
    console.log('[SCANNER] Error loading default image:', e.message)
  }

  const originalTune = state.tune
  const results = []

  broadcast({ type: 'scanStart' })

  for (let ch = 0; ch <= 37; ch++) {
    if (!scanning) break

    serialPort.write(`TUNE=${ch}\n`)
    state.signal = {}
    const locked = await waitForLock(ch === 0 ? 2000 : 1200)
    if (locked) await sleepMs(1500)

    const sig  = parseFloat(state.signal?.SIGNAL) || 0
    const lock = state.signal?.LOCK === '1'

    const result = {
      ch,
      name:       DAB_CHANNELS[ch].name,
      freq:       DAB_CHANNELS[ch].freq,
      signal:     sig,
      lock,
      cnr:        lock ? (parseFloat(state.signal?.CNR) || 0) : 0,
      snr:        lock ? (parseFloat(state.signal?.SNR) || 0) : 0,
      fic:        lock ? (parseFloat(state.signal?.FIC) || 0) : 0,
      fiberr:     lock ? (parseInt(state.debug?.FIBERR) || 0) : 0,
      ensemble:   lock ? (state.ensembleName || null) : null,
      ensembleId: lock ? (state.ensemble || null) : null,
      ecc:        lock ? (state.ecc || null) : null,
      services:   lock ? state.servicesList
        .map(s => ({ id: s.id, name: s.name, short: s.short, type: s.type })) : []
    }
    results.push(result)
    broadcast({ type: 'scanProgress', ch, total: 37, result })
  }

  if (originalTune !== null) {
    serialPort.write(`TUNE=${originalTune}\n`)
    state.tune = String(originalTune)
    broadcast({ type: 'tune', data: state.tune })
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (!state.scanResults[i]) {
      state.scanResults[i] = r
    } else {
      state.scanResults[i].signal = r.signal
      if (r.services.length > 0) {
        state.scanResults[i].services   = r.services
        state.scanResults[i].lock       = true
        state.scanResults[i].ensemble   = r.ensemble
        state.scanResults[i].ensembleId = r.ensembleId
        state.scanResults[i].ecc        = r.ecc
        state.scanResults[i].cnr        = r.cnr
        state.scanResults[i].snr        = r.snr
        state.scanResults[i].fic        = r.fic
        state.scanResults[i].fiberr     = r.fiberr
      }
    }
  }

  scanning = false
  state.scanning = false
  const compact = getScanResultsCompact()
  const found = compact.filter(r => r && r.services && r.services.length > 0).length
  state.scanStatus = `Done · ${found} found`
  broadcast({ type: 'scanComplete', data: compact })
}

module.exports = { startScan, stopScan, setSerialPort, updateBandscanPoint }
