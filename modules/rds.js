// rds.js — strat de integrare RDS, foloseste decodorul nativ JS (rds-native.js)
// in locul librdsparser/koffi. Contract de mesaje identic cu versiunea veche,
// plus extra: fmPTYN, fmECC, fmRTPlus, fmCT, fmDI.

const { state } = require('./state')
const { broadcast } = require('./websocket')
const { info } = require('./logger')
const { RdsDecoder, setRdsRegion } = require('./rds-native')
const fs = require('fs')
const path = require('path')

let decoder = null

function initRds() {
  // seteaza regiunea RDS/RBDS din config (afecteaza decodarea caracterelor)
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'))
    setRdsRegion(cfg.rds?.region || 'rds')
  } catch (e) { setRdsRegion('rds') }
  decoder = new RdsDecoder((type, value) => {
    switch (type) {
      case 'pi':
        state.fmPI = value
        broadcast({ type: 'fmPI', data: value })
        break
      case 'ps':
        state.fmPS = value
        broadcast({ type: 'fmPS', data: value })
        break
      case 'rt':
        state.fmRT = value
        broadcast({ type: 'fmRT', data: value })
        break
      case 'af':
        state.fmAF = value
        broadcast({ type: 'fmAF', data: value })
        break
      case 'tp':
        state.fmTP = value
        broadcast({ type: 'fmTP', data: value })
        break
      case 'ta':
        state.fmTA = value
        broadcast({ type: 'fmTA', data: value })
        break
      case 'ms':
        state.fmMS = value // 0=speech, 1=music
        broadcast({ type: 'fmMS', data: value })
        break
      case 'pty':
        state.fmPTY = value
        broadcast({ type: 'fmPTY', data: value })
        break
      // ── extra fata de librdsparser ──
      case 'ptyn':
        state.fmPTYN = value
        broadcast({ type: 'fmPTYN', data: value })
        break
      case 'lps':
        state.fmLPS = value
        broadcast({ type: 'fmLPS', data: value })
        break
      case 'ert':
        state.fmERT = value
        broadcast({ type: 'fmERT', data: value })
        break
      case 'ertplus':
        state.fmERTPlus = value
        broadcast({ type: 'fmERTPlus', data: value })
        break
      case 'ecc':
        state.fmECC = value
        broadcast({ type: 'fmECC', data: value })
        break
      case 'rtplus':
        state.fmRTPlus = value
        broadcast({ type: 'fmRTPlus', data: value })
        break
      case 'ct':
        broadcast({ type: 'fmCT', data: value })
        break
      case 'di':
        state.fmDI = value
        broadcast({ type: 'fmDI', data: value })
        break
    }
  })
  info('RDS parser initialized (native JS decoder, port RDSExpert)')
}

function rdsParseString(str) {
  if (decoder) decoder.parseString(str)
}

function rdsClear() {
  if (decoder) decoder.reset()
  state.fmPI   = null
  state.fmPS   = null
  state.fmRT   = null
  state.fmAF   = []
  state.fmTP   = null
  state.fmTA   = false
  state.fmMS   = null
  state.fmPTY  = null
  state.fmPTYN = null
  state.fmLPS  = null
  state.fmERT  = null
  state.fmERTPlus = null
  state.fmECC  = null
  state.fmRTPlus = null
  state.fmDI   = null
}

module.exports = { initRds, rdsParseString, rdsClear }
