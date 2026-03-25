const express = require('express')
const http = require('http')
const fs = require('fs')
const config = require('./config.json')
const { registerSetup } = require('./modules/setup')
const registerStream = require('./modules/stream')
const { initWebSocket } = require('./modules/websocket')
const { initSerial } = require('./modules/serial')
const { startAudio } = require('./modules/audio')

const app = express()
const server = http.createServer(app)

// Redirect la first-run daca nu e setata parola
app.set('trust proxy', true)
app.use((req, res, next) => {
  if (req.path.startsWith('/setup')) return next()
  const cfg = (() => { try { return JSON.parse(fs.readFileSync('./config.json', 'utf8')) } catch(e) { return {} } })()
  if (!cfg.auth?.password) return res.redirect('/setup/first-run')
  next()
})

registerSetup(app)
app.use(express.static('public'))

initWebSocket(server)
initSerial()
startAudio()
registerStream(app, require('./modules/audio').audioEmitter)

server.listen(config.server.port, () => {
  console.log(`[INFO] Server running on http://localhost:${config.server.port}`)
})
