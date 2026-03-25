const { WebSocketServer } = require('ws')
const geoip = require('geoip-lite')
const fs = require('fs')
const { state, getScanResultsCompact } = require('./state')
const { audioEmitter } = require('./audio')
const { info, warn } = require('./logger')

let wssData = null
let wssAudio = null
let connectionCount = 0
let port = null

function setSerialPort(p) {
  port = p
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
        info(`setService: ${msg.id} from (${ip})`)
        port.write(`SERVICE=${msg.id}\n`)
        const ch = parseInt(state.tune)
        broadcast({ type: 'activeService', ch, id: String(msg.id) })
      }

      if (msg.type === 'setTune') {
        info(`setTune: ${msg.channel} from (${ip})`)
        const ch = parseInt(msg.channel)
        if (isNaN(ch) || ch < 0 || ch > 37) {
          ws.send(JSON.stringify({ type: 'tuneError', data: 'Canal invalid (0-37)' }))
          return
        }
        const { resetMuxState } = require('./serial')
        resetMuxState()
        port.write(`TUNE=${ch}\n`)
        state.tune = String(ch)
        broadcast({ type: 'tune', data: state.tune })
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

module.exports = { initWebSocket, broadcast, setSerialPort }
