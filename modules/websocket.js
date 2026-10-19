const { WebSocketServer } = require('ws')
const geoip = require('geoip-lite')
const fs = require('fs')
const { state, getScanResultsCompact } = require('./state')
const { audioEmitter } = require('./audio')
const { info, warn } = require('./logger')
const { saveLastState, getLastState } = require('./laststate')

let wssData = null
let wssAudio = null
let connectionCount = 0
let port = null
let fmSeekDirection = 0
let pendingModeRestore = null

function setSerialPort(p) {
  port = p
}

function cancelPendingModeRestore() {
  if (pendingModeRestore) { clearTimeout(pendingModeRestore); pendingModeRestore = null }
}

function stopFmSeek(reason, notify = true) {
  fmSeekDirection = 0
  state.fmSeeking = false
  if (reason === 'done' && state.fmFreq) saveLastState({ fmFreq: state.fmFreq })
  if (notify) broadcast({ type: 'fmSeekStatus', active: false, reason: reason || 'stopped', freq: state.fmFreq || null })
}

function startFmSeek(direction) {
  if (!port) return
  direction = direction < 0 ? -1 : 1
  if (fmSeekDirection === direction) { stopFmSeek('toggle'); return }
  fmSeekDirection = direction
  state.fmSeeking = true
  broadcast({ type: 'fmSeekStatus', active: true, direction, freq: state.fmFreq || null })
  port.write(direction > 0 ? 'SEEKUP=1\n' : 'SEEKDOWN=1\n')
}

function broadcastFmClear() {
  for (const t of ['fmPI','fmPS','fmRT','fmAF','fmTP','fmTA','fmMS','fmPTY','fmPTYN','fmECC','fmDI'])
    broadcast({ type: t, data: null })
}

function broadcast(msg) {
  const str = JSON.stringify(msg)
  wssData.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(str) } catch(e) {}
    }
  })
}

function initWebSocket(server) {
  wssData  = new WebSocketServer({ noServer: true })
  wssAudio = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/data-ws') {
      wssData.handleUpgrade(request, socket, head, ws => {
        wssData.emit('connection', ws, request)
      })
    } else if (request.url === '/audio-ws') {
      wssAudio.handleUpgrade(request, socket, head, ws => {
        wssAudio.emit('connection', ws, request)
      })
    } else {
      socket.destroy()
    }
  })

  // Audio WS
  wssAudio.on('connection', ws => {
    const ip = ws._socket.remoteAddress
    info(`WS audio connected (${ip})`)

    ws.send(JSON.stringify({ type: 'fallback', data: 'mp3' }))

    const onChunk = chunk => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(chunk) } catch(e) {}
      }
    }

    audioEmitter.on('chunk', onChunk)

    ws.on('close', () => {
      audioEmitter.off('chunk', onChunk)
      warn(`WS audio disconnected (${ip})`)
    })
  })

  // Data WS
  wssData.on('connection', (ws, req) => {
    connectionCount++
    const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
    const ip = rawIp.replace('::ffff:', '').split(',')[0].trim()

    const geo = geoip.lookup(ip)
    let location = 'Unknown'
    if (geo) location = `${geo.city || 'Unknown city'}, ${geo.region || ''}, ${geo.country || ''}`
    info(`Web client connected (${ip === '::1' ? 'localhost' : ip}) [${connectionCount}] Location: ${location}`)

    broadcast({ type: 'connectionCount', count: connectionCount })

    const defaultImg = fs.readFileSync('./public/images/default.jpg').toString('base64')
    const fullState = {
      type: 'fullState',
      ...state,
      slideshow:   state.slideshow || defaultImg,
      scanResults: getScanResultsCompact()
    }

    if (!state.service) {
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(fullState))
      }, 2000)
    } else {
      ws.send(JSON.stringify(fullState))
    }

    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw) } catch(e) { return }

      if (msg.type === 'setService') {
        if (state.mode !== 'dab') return
        info(`setService: ${msg.id} from (${ip})`)
        port.write(`SERVICE=${msg.id}\n`)
        const ch = parseInt(state.tune)
        broadcast({ type: 'activeService', ch, id: String(msg.id) })
      }

      if (msg.type === 'setTune') {
        if (state.mode !== 'dab') return
        info(`setTune: ${msg.channel} from (${ip})`)
        const ch = parseInt(msg.channel)
        if (isNaN(ch) || ch < 0 || ch > 37) {
          ws.send(JSON.stringify({ type: 'tuneError', data: 'Canal invalid (0-37)' }))
          return
        }
        const { resetMuxState, setAwaitingTune } = require('./serial')
        cancelPendingModeRestore()
        setAwaitingTune(true)
        resetMuxState()
        port.write(`TUNE=${ch}\n`)
        state.tune = String(ch)
        broadcast({ type: 'tune', data: state.tune })
      }

      if (msg.type === 'setMode') {
        const mode = msg.mode === 'fm' ? 'fm' : 'dab'
        if (mode === state.mode) return
        info(`setMode: ${mode} from (${ip})`)
        cancelPendingModeRestore()
        stopFmSeek('mode-switch', false)
        const { stopScan } = require('./scanner')
        stopScan()
        const ls = getLastState()
        if (mode === 'fm') {
          saveLastState({ dabTune: state.tune, dabService: state.service })
          require('./serial').setPendingService(null)
          port.write('MODE=fm\n')
          const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
          const seekCfg = cfg.fm?.seek
          if (seekCfg?.rssiThreshold !== undefined) setTimeout(() => port.write(`FMSEEKRSSI=${seekCfg.rssiThreshold}\n`), 800)
          if (seekCfg?.snrThreshold  !== undefined) setTimeout(() => port.write(`FMSEEKSNR=${seekCfg.snrThreshold}\n`), 900)
          if (ls.fmFreq) pendingModeRestore = setTimeout(() => { pendingModeRestore = null; port.write(`TUNE=${ls.fmFreq}\n`) }, 1500)
        } else {
          if (state.fmFreq) saveLastState({ fmFreq: state.fmFreq })
          port.write('MODE=dab\n')
          const { resetMuxState, setAwaitingTune } = require('./serial')
          resetMuxState()
          state.service = null
          if (ls.dabTune !== null && ls.dabTune !== undefined) {
            pendingModeRestore = setTimeout(() => {
              pendingModeRestore = null
              setAwaitingTune(true)
              port.write(`TUNE=${ls.dabTune}\n`)
              if (ls.dabService !== null && ls.dabService !== undefined) {
                require('./serial').setPendingService(ls.dabService)
              }
            }, 2000)
          }
        }
        state.mode = mode
        saveLastState({ mode })
        const canRestore = mode === 'dab' ? ls.dabService != null : ls.fmFreq != null
        broadcast({ type: 'mode', data: mode, restoreService: canRestore })
      }

      if (msg.type === 'setFmFreq') {
        if (state.mode !== 'fm') return
        const freq = parseInt(msg.freq)
        if (isNaN(freq) || freq < 87500 || freq > 108000) return
        info(`setFmFreq: ${freq} from (${ip})`)
        cancelPendingModeRestore()
        stopFmSeek('tune', false)
        const { resetFmState } = require('./serial')
        resetFmState()
        state.fmFreq = freq
        port.write(`TUNE=${freq}\n`)
        saveLastState({ fmFreq: freq })
        broadcast({ type: 'fmFreq', data: freq })
        broadcastFmClear()
      }

      if (msg.type === 'fmSeek') {
        if (state.mode !== 'fm') return
        startFmSeek(msg.direction === 'down' ? -1 : 1)
      }

      if (msg.type === 'fmBandscan') {
        if (state.mode !== 'fm') return
        info(`fmBandscan from (${ip})`)
        port.write('BANDSCAN=1\n')
      }

      if (msg.type === 'setDeemph') {
        if (state.mode !== 'fm') return
        const v = parseInt(msg.value)
        if (v !== 0 && v !== 50 && v !== 75) return
        port.write(`DEEMPH=${v}\n`)
        state.deemph = v
        saveLastState({ deemph: v })
        broadcast({ type: 'deemph', data: v })
      }

      if (msg.type === 'toggleEnable') {
        state.enabled = !state.enabled
        port.write(`ENABLE=${state.enabled ? 1 : 0}\n`)
        broadcast({ type: 'enableState', data: state.enabled })
      }

      if (msg.type === 'startScan') {
        const { startScan } = require('./scanner')
        startScan(ws)
      }
      if (msg.type === 'stopScan') {
        const { stopScan } = require('./scanner')
        stopScan()
      }
    })

    ws.on('close', () => {
      connectionCount--
      broadcast({ type: 'connectionCount', count: connectionCount })
      warn(`Web client disconnected (${ip}) [${connectionCount}]`)
    })
  })
}

module.exports = { initWebSocket, broadcast, setSerialPort, stopFmSeek }
