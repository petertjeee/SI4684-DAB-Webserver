// ================= WEBSOCKET =================
let socket = null
let wsReconnectTimer = null

function wsConnect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${proto}//${location.host}/data-ws`
  socket = new WebSocket(wsUrl)
  socket.onopen = () => {
    console.log('WS connected')
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
  }
  socket.onmessage = (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch(e) { return }
    try { handleMessage(msg) } catch(e) { console.error("handleMessage error:", e) }
  }
  socket.onclose = () => {
    console.warn('WS closed, reconnecting in 2s...')
    wsReconnectTimer = setTimeout(wsConnect, 2000)
  }
  socket.onerror = () => {
    socket.close()
  }
}

function wsSend(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg))
  }
}

wsConnect()

let activeService = 0

// ===== AUDIO =====
const audio = new Audio()
audio.preload = 'none'
document.body.appendChild(audio)

function connectAudioWs() {
  setupVu()
  lufsReset()
  updateVolume(document.getElementById('pcVolSlider').value)
  audio.src = '/stream'
  audio.play().catch(e => console.log('audio play:', e))
}

// ===== VU METERS =====
let vuCtx = null, vuAnL = null, vuAnR = null
const vuBufL = new Float32Array(512), vuBufR = new Float32Array(512)
let vuCorr = 0

function setupVu() {
  if (vuCtx) { if (vuCtx.state === 'suspended') vuCtx.resume(); return }
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  try {
    try { vuCtx = new AC({ sampleRate: 48000 }) } catch (e) { vuCtx = new AC() }
    const src = vuCtx.createMediaElementSource(audio)
    vuGain = vuCtx.createGain()
    vuGain.gain.value = parseInt(document.getElementById('pcVolValue').textContent, 10) / 100
    src.connect(vuGain)
    vuGain.connect(vuCtx.destination)
    audio.volume = 1
    if (!isMobileUi()) {
      const split = vuCtx.createChannelSplitter(2)
      src.connect(split)
      vuAnL = vuCtx.createAnalyser(); vuAnR = vuCtx.createAnalyser()
      vuAnL.fftSize = vuAnR.fftSize = 512
      split.connect(vuAnL, 0); split.connect(vuAnR, 1)
    }
  } catch (e) { console.log('VU setup:', e) }
}

/* PPM-style peak meters, ballistics adapted from audio-monitor:
   non-linear scale (top 20 dB gets 60%), 24 dB/s release,
   700 ms peak-hold then 12 dB/s decay, OVL at -0.1 dB */
const VU_SCALE = [-60, -40, -30, -18, -9, -3]
const vuPct = d => {
  d = Math.max(-60, Math.min(0, d))
  return d >= -20 ? 40 + (d + 20) * 3 : d + 60
}
const VU_REL = 24, VU_PKREL = 12, VU_PKHOLD = 700
const VU_CLIP = -0.1, VU_CLIPHOLD = 1500
const vuSt = { rms: [-120, -120], pk: [-120, -120], pkHold: [0, 0], ovl: [0, 0] }
let vuEls = null, vuCorrMark = null, vuGain = null
const isMobileUi = () => window.matchMedia('(max-width: 900px)').matches

function initVuDom() {
  const scale = document.getElementById('vuScale')
  if (!scale) return
  scale.innerHTML = [...VU_SCALE, 0].map(d =>
    `<span style="top:${100 - vuPct(d)}%">${d}</span>`).join('')
  vuEls = [0, 1].map(i => {
    const m = document.getElementById('vuM' + i)
    m.innerHTML = '<div class="vfill"></div><div class="vpk"></div>' +
      VU_SCALE.map(d => `<div class="vtick" style="bottom:${vuPct(d)}%"></div>`).join('')
    return {
      fill: m.querySelector('.vfill'), pk: m.querySelector('.vpk'),
      ovl: document.getElementById('vuOvl' + i),
      val: document.getElementById('vuV' + i)
    }
  })
  vuCorrMark = document.getElementById('vuCorrMark')
  const lufsBox = document.getElementById('lufsBox')
  const meters = document.querySelector('.vu-meters')
  const lscale = document.getElementById('lufsScale')
  lscale.innerHTML = [...LUFS_SCALE, 0].map(d =>
    `<span style="top:${100 - lufsPct(d)}%">${d}</span>`).join('')
  const lm = document.getElementById('lufsMeter')
  lm.innerHTML = '<div class="vfill"></div><div class="vpk"></div>' +
    LUFS_SCALE.map(d => `<div class="vtick" style="bottom:${lufsPct(d)}%"></div>`).join('')
  lufsMeterEls = {
    fill: lm.querySelector('.vfill'), pk: lm.querySelector('.vpk'),
    val: document.getElementById('lufsMeterVal')
  }
  document.querySelectorAll('.vu-mode-opt').forEach(el => {
    el.onclick = () => {
      vuMode = el.dataset.mode
      document.querySelectorAll('.vu-mode-opt').forEach(o => o.classList.toggle('active', o === el))
      meters.style.display = vuMode === 'ppm' ? '' : 'none'
      lufsBox.style.display = vuMode === 'ppm' ? 'none' : ''
      document.getElementById('lufsResetBtn').style.display = vuMode === 'lufs' ? '' : 'none'
    }
  })
  document.getElementById('lufsResetBtn').onclick = lufsReset
}

function vuPeakDb(buf) {
  let m = 0
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a }
  return 20 * Math.log10(m + 1e-9)
}

/* EBU R128 loudness — K-weighting (48 kHz coefficients), momentary 400 ms,
   short-term 3 s, integrated with -70/-10 LU gating */
const K_SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] }
const K_HP = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] }
const kState = [{ s1: [0, 0], s2: [0, 0] }, { s1: [0, 0], s2: [0, 0] }]
let vuMode = 'ppm'
const lufsFrames = []
const lufsBlocks = []
let lufsLastBlock = 0
let vuLufs = null, lufsMeterEls = null, lufsSm = -120
const LUFS_SCALE = [-50, -40, -30, -23, -10]
const lufsPct = d => (Math.max(-50, Math.min(0, d)) + 50) / 50 * 100

function kBiquad(co, st, x) {
  const y = co.b[0] * x + st[0]
  st[0] = co.b[1] * x - co.a[1] * y + st[1]
  st[1] = co.b[2] * x - co.a[2] * y
  return y
}

function lufsReset() {
  lufsFrames.length = 0; lufsBlocks.length = 0
  lufsLastBlock = 0; lufsSm = -120
}

function lufsMetering(now) {
  let e = 0
  for (let i = 0; i < vuBufL.length; i++) {
    const l = kBiquad(K_HP, kState[0].s2, kBiquad(K_SHELF, kState[0].s1, vuBufL[i]))
    const r = kBiquad(K_HP, kState[1].s2, kBiquad(K_SHELF, kState[1].s1, vuBufR[i]))
    e += l * l + r * r
  }
  lufsFrames.push({ t: now, e: e / vuBufL.length })
  while (lufsFrames.length && lufsFrames[0].t < now - 3100) lufsFrames.shift()
  // R128 integrated: 400 ms blocks with 75% overlap -> push every 100 ms
  if (now - lufsLastBlock >= 100) {
    lufsBlocks.push(lufsWindow(now, 400))
    if (lufsBlocks.length > 3600) lufsBlocks.shift()
    lufsLastBlock = now
  }
}

function lufsWindow(now, ms) {
  let s = 0, n = 0
  for (let i = lufsFrames.length - 1; i >= 0 && lufsFrames[i].t > now - ms; i--) {
    s += lufsFrames[i].e; n++
  }
  return n ? s / n : 0
}

function lufsIntegrated() {
  const toL = e => e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity
  const g1 = lufsBlocks.filter(e => toL(e) > -70)
  if (!g1.length) return -Infinity
  const rel = toL(g1.reduce((a, b) => a + b, 0) / g1.length) - 10
  const g2 = g1.filter(e => toL(e) > rel)
  if (!g2.length) return -Infinity
  return toL(g2.reduce((a, b) => a + b, 0) / g2.length)
}

function updateLufsDom(now, dt) {
  if (!vuLufs) {
    vuLufs = { M: document.getElementById('lufsM'), S: document.getElementById('lufsS'), I: document.getElementById('lufsI') }
  }
  const toL = e => e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity
  const fmt = v => Number.isFinite(v) ? v.toFixed(1) : '-∞'
  const m = toL(lufsWindow(now, 400)), s = toL(lufsWindow(now, 3000)), i = lufsIntegrated()
  vuLufs.M.textContent = fmt(m)
  vuLufs.S.textContent = fmt(s)
  vuLufs.I.textContent = fmt(i)
  if (lufsMeterEls) {
    lufsSm = Number.isFinite(m) ? Math.max(m, lufsSm - 20 * dt) : Math.max(-60, lufsSm - 20 * dt)
    lufsMeterEls.fill.style.height = (100 - lufsPct(lufsSm)) + '%'
    lufsMeterEls.pk.style.bottom = lufsPct(Number.isFinite(i) ? i : -50) + '%'
    lufsMeterEls.val.textContent = fmt(m)
  }
}

let vuLast = performance.now()
function vuLoop(now) {
  const dt = Math.min(0.1, (now - vuLast) / 1000)
  vuLast = now
  const tP = [-120, -120]
  if (isPlaying && vuAnL) {
    vuAnL.getFloatTimeDomainData(vuBufL)
    vuAnR.getFloatTimeDomainData(vuBufR)
    tP[0] = vuPeakDb(vuBufL); tP[1] = vuPeakDb(vuBufR)
    let lr = 0, ll = 0, rr = 0
    for (let i = 0; i < vuBufL.length; i++) {
      lr += vuBufL[i] * vuBufR[i]; ll += vuBufL[i] * vuBufL[i]; rr += vuBufR[i] * vuBufR[i]
    }
    const c = ll * rr > 1e-12 ? lr / Math.sqrt(ll * rr) : 0
    vuCorr += (Math.max(-1, Math.min(1, c)) - vuCorr) * 0.15
    lufsMetering(now)
  } else {
    vuCorr *= 0.98
  }
  if (vuEls) {
    for (let i = 0; i < 2; i++) {
      vuSt.rms[i] = Math.max(tP[i], vuSt.rms[i] - VU_REL * dt)
      if (tP[i] >= vuSt.pk[i]) { vuSt.pk[i] = tP[i]; vuSt.pkHold[i] = now + VU_PKHOLD }
      else if (now > vuSt.pkHold[i]) vuSt.pk[i] = Math.max(vuSt.pk[i] - VU_PKREL * dt, vuSt.rms[i])
      if (tP[i] >= VU_CLIP) vuSt.ovl[i] = now + VU_CLIPHOLD
      const e = vuEls[i]
      e.ovl.classList.toggle('on', now < vuSt.ovl[i])
      e.fill.style.height = (100 - vuPct(vuSt.rms[i])) + '%'
      e.pk.style.bottom = vuPct(vuSt.pk[i]) + '%'
      e.val.textContent = vuSt.pk[i] <= -60 ? '-∞' : vuSt.pk[i].toFixed(1)
    }
    if (vuCorrMark) {
      vuCorrMark.style.left = ((vuCorr + 1) / 2 * 100) + '%'
      vuCorrMark.classList.toggle('neg', vuCorr < 0)
    }
  }
  if (vuMode === 'lufs') updateLufsDom(now, dt)
  requestAnimationFrame(vuLoop)
}
requestAnimationFrame(() => { initVuDom(); vuLast = performance.now(); vuLoop(vuLast) })

// keep the Web Audio graph running on iOS (suspend on backgrounding/gesture loss)
audio.addEventListener('playing', () => { if (vuCtx?.state === 'suspended') vuCtx.resume() })
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && vuCtx?.state === 'suspended') vuCtx.resume()
})

// ===== SIGNAL GRAPH =====
const canvas = document.getElementById('signalCanvas')
const ctx = canvas.getContext('2d')
const signalHistory = []
const MAX_POINTS = 200
function resizeCanvas() {
  canvas.width = canvas.offsetWidth
  canvas.height = 70
}
resizeCanvas()
window.addEventListener('resize', resizeCanvas)

function drawGraph() {
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)

  if (signalHistory.length < 2) return

  const min = 0, max = 80
  const pts = signalHistory.slice(-MAX_POINTS)

  ctx.beginPath()
  ctx.moveTo(0, H)
  pts.forEach((v, i) => {
    const x = (i / (pts.length - 1)) * W
    const y = H - ((v - min) / (max - min)) * H
    i === 0 ? ctx.lineTo(x, y) : ctx.lineTo(x, y)
  })
  ctx.lineTo(W, H)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, 'rgba(88,219,171,0.25)')
  grad.addColorStop(1, 'rgba(88,219,171,0)')
  ctx.fillStyle = grad
  ctx.fill()

  ctx.beginPath()
  pts.forEach((v, i) => {
    const x = (i / (pts.length - 1)) * W
    const y = H - ((v - min) / (max - min)) * H
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  })
  ctx.strokeStyle = '#58dbab'
  ctx.lineWidth = 1.5
  ctx.stroke()
}

setInterval(drawGraph, 200)

// ===== PLAYER UI =====
let isPlaying = false
const pcControls = document.getElementById('pcControls')
function togglePlay() {
  isPlaying = !isPlaying
  if (isPlaying) {
    pcControls.classList.add('pc-playing-state')
    const isAppleiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
    if (isAppleiOS && 'audioSession' in navigator) {
      navigator.audioSession.type = "playback"
    }
    connectAudioWs()
  } else {
    pcControls.classList.remove('pc-playing-state')
    const isAppleiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
    if (isAppleiOS && 'audioSession' in navigator) {
      navigator.audioSession.type = "none"
    }
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
}

function updateVolume(val) {
  document.getElementById('pcVolValue').textContent = val
  document.getElementById('pcVolSlider').style.setProperty('--vol', val + '%')
  const v = Math.max(0, Math.min(1, val / 100))
  if (vuGain) vuGain.gain.setTargetAtTime(v, vuCtx.currentTime, 0.03)
  else audio.volume = v
}

updateVolume(100)

let isMuted = false
function toggleMute() {
  isMuted = !isMuted
  audio.muted = isMuted
  if (vuGain) {
    const v = isMuted ? 0 : parseInt(document.getElementById('pcVolValue').textContent, 10) / 100
    vuGain.gain.setTargetAtTime(v, vuCtx.currentTime, 0.03)
  }
  document.getElementById('pcVolIcon').style.color = isMuted ? '#e53935' : ''
}

// ===== TUNE =====
function populateTuneDropdown(currentTune) {
  const sel = document.getElementById('tuneSelect')
  sel.innerHTML = ''
  DAB_CHANNELS.forEach(c => {
    const opt = document.createElement('option')
    opt.value = String(c.ch)
    opt.text = `${c.name} \u2014 ${c.freq} MHz`
    sel.appendChild(opt)
  })
  if (currentTune !== null && currentTune !== undefined) {
    sel.value = String(currentTune)
  }
}

function changeTune() {
  const ch = document.getElementById('tuneSelect').value
  if (!ch) return
  wsSend({ type: 'setTune', channel: ch })
}

// ===== RADIO TEXT =====
function setRadioText(text) {
  const el = document.getElementById('pcRtText')
  text = text.replace(/^[\s\-\ufffd]+/, '').trim()

  function makeLine(str, color) {
    const span = document.createElement('span')
    span.className = 'rt-line'
    span.style.color = color || ''
    span.textContent = str
    el.appendChild(span)
    if (span.scrollWidth > el.clientWidth) {
      span.className = 'rt-line scrolling'
      span.textContent = str + '\u00a0\u00a0\u00a0\u00a0\u00a0' + str
    }
  }

  el.innerHTML = ''
  const parts = text.split(' - ')
  if (parts.length >= 2) {
    const artist = parts[0].trim()
    const track = parts.slice(1).join(' - ').trim()
    if (artist && track) {
      makeLine(artist, '#e6edf3')
      makeLine(track, '')
      return
    }
  }
  makeLine(text, '')
}

function setAudioType(type) {
  const el = document.getElementById('pcAudioType')
  if (el) el.textContent = SERVICE_MODES[type] || 'DAB+'
}

// ===== DL+ / ENSEMBLE META =====
let ensembleEcc = null
let ensembleDabTime = null

function updateEnsembleMeta() {
  const parts = []
  if (ensembleEcc) parts.push('ECC ' + ensembleEcc)
  if (ensembleDabTime) {
    const t = String(ensembleDabTime).replace('T', ' ').replace('Z', ' UTC').trim()
    parts.push(t)
  }
  const el = document.getElementById('ensembleMeta')
  if (el) el.textContent = parts.join(' \u00b7 ')
}

const DLPLUS_ORDER = [
  'STATIONNAME.LONG', 'PROGRAMME.NOW', 'PROGRAMME.NEXT', 'PROGRAMME.LATER',
  'ARTIST', 'TITLE', 'ITEM.COMPOSITION', 'ITEM.GENRE', 'ALBUM', 'BAND',
  'PLACENAME', 'INFO.NEWS', 'INFO.NEWS.LOCAL', 'INFO.SPORT', 'INFO.WEATHER',
  'INFO.TRAFFIC', 'INFO.ALARM', 'INFO.ADVERTISEMENT', 'INFO.URL', 'INFO.OTHER',
  'PHONE.STUDIO', 'SMS.STUDIO', 'EMAIL.STUDIO', 'CHAT', 'VOTE', 'DESCRIPTOR', 'PURCHASE'
]

const DLPLUS_LABELS = {
  'STATIONNAME.LONG': 'Station', 'STATIONNAME.SHORT': 'Station',
  'PROGRAMME.NOW': 'Nu', 'PROGRAMME.NEXT': 'Straks', 'PROGRAMME.LATER': 'Later',
  'ARTIST': 'Artiest', 'TITLE': 'Titel', 'ITEM.COMPOSITION': 'Compositie',
  'ITEM.GENRE': 'Genre', 'ALBUM': 'Album', 'BAND': 'Band',
  'PLACENAME': 'Plaats', 'INFO.NEWS': 'Nieuws', 'INFO.NEWS.LOCAL': 'Nieuws lokaal',
  'INFO.SPORT': 'Sport', 'INFO.WEATHER': 'Weer', 'INFO.TRAFFIC': 'Verkeer',
  'INFO.ALARM': 'Alarm', 'INFO.ADVERTISEMENT': 'Reclame', 'INFO.URL': 'URL',
  'INFO.OTHER': 'Info', 'PHONE.STUDIO': 'Studio', 'SMS.STUDIO': 'SMS',
  'EMAIL.STUDIO': 'E-mail', 'CHAT': 'Chat', 'VOTE': 'Stemmen',
  'DESCRIPTOR': 'Omschrijving', 'PURCHASE': 'Aankoop'
}

const DLPLUS_MAIN = ['ARTIST', 'TITLE', 'ALBUM', 'ITEM.GENRE', 'ITEM.COMPOSITION']

function updateDlPlus(obj) {
  const el = document.getElementById('dlPlusText')
  if (!el) return
  obj = obj || {}
  const line = (k, val) =>
    `<div class="dlplus-line"><span class="dlplus-label">${DLPLUS_LABELS[k] || k}</span>${String(val || '—').replace(/</g, '&lt;')}</div>`
  const ord = k => { const i = DLPLUS_ORDER.indexOf(k); return i === -1 ? 999 : i }
  const extraKeys = Object.keys(obj)
    .filter(k => k !== 'IR' && k !== 'IT' && !DLPLUS_MAIN.includes(k) && obj[k])
    .sort((a, b) => ord(a) - ord(b))
  el.innerHTML = DLPLUS_MAIN.map(k => line(k, obj[k])).join('') +
    extraKeys.map(k => line(k, obj[k])).join('')
}

function updateDebug(data) {
  const rssi = parseFloat(data.RSSI)
  if (!isNaN(rssi)) {
    setBar('rssi', normalize(rssi, 0, 70))
    document.getElementById('rssiVal').textContent = rssi.toFixed(0)
  }
  const fib = parseInt(data.FIBERR)
  if (!isNaN(fib)) {
    document.getElementById('fiberrVal').textContent = String(fib)
  }
  if (data.SNR !== undefined) {
    const snr = parseFloat(data.SNR)
    if (!isNaN(snr) && snr < 100) {
      setBar('snr', normalize(snr, 0, 25))
      document.getElementById('snrVal').textContent = snr.toFixed(0)
    }
  }
}

function getStationName(id) {
  const opt = document.getElementById('services').querySelector(`option[value="${id}"]`)
  return opt ? opt.text : id
}

// ===== HELPER: marcare item activ in lista =====
function markActiveServiceInList() {
  const currentCh = parseInt(document.getElementById('tuneSelect').value)
  document.querySelectorAll('.svc-scan-item').forEach(el => {
    el.classList.toggle('active', el.dataset.ch == currentCh && el.dataset.svcId == activeService)
  })
}

// ===== MESSAGE HANDLER =====
const servicesDropdown = document.getElementById('services')
const img = document.getElementById('slideshow')

function handleMessage(msg) {
  switch(msg.type) {

    case 'fullState':
      populateTuneDropdown(msg.tune !== null && msg.tune !== undefined ? String(msg.tune) : null)
      if (msg.tune) updateTuneDisplay(msg.tune)
      if (msg.servicesList?.length) populateServices(msg.servicesList, msg.service)
      if (msg.service) {
        servicesDropdown.value = String(msg.service)
        document.getElementById('pcStationTitle').textContent = getStationName(msg.service)
      }
      if (msg.serviceType) setAudioType(msg.serviceType)
      if (msg.ensemble || msg.ensembleName) updateEnsemble(msg.ensemble, msg.ensembleName, msg.ecc)
      if (msg.dynamicLabel) setRadioText(msg.dynamicLabel)
      if (msg.dlPlus) updateDlPlus(msg.dlPlus)
      if (msg.dabTime) { ensembleDabTime = msg.dabTime; updateEnsembleMeta() }
      if (msg.debug) updateDebug(msg.debug)
      if (msg.signal) updateSignal(msg.signal)
      if (msg.slideshow) img.src = 'data:image/jpeg;base64,' + msg.slideshow
      if (msg.serviceInfo) renderServiceInfo(msg.serviceInfo)
      if (msg.scanResults?.length) {
        scanResults = msg.scanResults
        drawScanChart(scanResults)
        updateScanChannels(scanResults)
        renderServicesScanList(scanResults)
        markActiveServiceInList()
      }
      if (msg.scanning) {
        document.getElementById('scanOverlay').classList.add('active')
      }
      if (msg.scanStatus) {
        document.getElementById('scanStatus').textContent = msg.scanStatus
      }
      if (msg.slideshow) img.src = `data:${msg.slideshowMime};base64,` + msg.slideshow
      break

    case 'servicesList':
      populateServices(msg.data, null)
      break

    case 'service':
      activeService = String(msg.id)
      lufsReset()
      updateDlPlus({})
      document.getElementById('pcRtText').textContent = 'No data'
      servicesDropdown.value = String(msg.id)
      setTimeout(() => {
        document.getElementById('pcStationTitle').textContent = getStationName(msg.id)
      }, 500)
      if (msg.serviceType) setAudioType(msg.serviceType)
      markActiveServiceInList()
      break

    case 'tune':
      lufsReset()
      const sel = document.getElementById('tuneSelect')
      if (sel) sel.value = String(msg.data)
      updateTuneDisplay(msg.data)
      break

    case 'tuneError':
      alert(msg.data)
      break

    case 'ensembleInfo':
      updateEnsemble(msg.ensemble, msg.ensembleName, msg.ecc)
      break

    case 'debug':
      updateDebug(msg.data)
      break

    case 'dlPlus':
      updateDlPlus(msg.data)
      break

    case 'dabTime':
      ensembleDabTime = msg.data
      updateEnsembleMeta()
      break

    case 'dynamicLabel':
      setRadioText(msg.data)
      break

    case 'signal':
      updateSignal(msg.data)
      const tuneEl = document.getElementById('tuneSelect')
      if (tuneEl && scanResults.length > 0) {
        const ch = parseInt(tuneEl.value)
        if (!isNaN(ch) && scanResults[ch]) {
          scanResults[ch].signal = parseFloat(msg.data.SIGNAL) || 0
          drawScanChart(scanResults)
        }
      }
      break

    case 'scanUpdate':
      if (scanResults[msg.ch]) {
        scanResults[msg.ch].signal = msg.signal
        scanResults[msg.ch].lock   = msg.lock
        drawScanChart(scanResults)
      }
      break

    case 'scanResultsUpdated':
      if (scanRunning) return
      const prevJson = JSON.stringify(scanResults.filter(r => r && r.services?.length > 0).map(r => r.services.map(s => s.id).join(',')))
      scanResults = msg.data
      const newJson = JSON.stringify(scanResults.filter(r => r && r.services?.length > 0).map(r => r.services.map(s => s.id).join(',')))
      drawScanChart(scanResults)
      if (prevJson !== newJson) {
        renderServicesScanList(scanResults)
        markActiveServiceInList()
      } else {
        markActiveServiceInList()
      }
      break

    case 'image':
      img.src = `data:${msg.mime};base64,` + msg.data
      break

    case 'serviceInfo':
      renderServiceInfo(msg.data)
      if (msg.data.TYPE) setAudioType(msg.data.TYPE)
      break

    case 'muxReset':
      document.getElementById('pcStationTitle').textContent = '-'
      document.getElementById('pcEnsembleName').textContent = '-'
      document.getElementById('pcRtText').textContent = 'No data'
      document.getElementById('pcAudioType').textContent = 'DAB+'
      document.getElementById('ensemble').textContent = '-'
      document.getElementById('ensembleId').textContent = '-'
      ensembleEcc = null
      ensembleDabTime = null
      updateEnsembleMeta()
      updateDlPlus({})
      document.getElementById('headerEnsemble').textContent = '-'
      servicesDropdown.innerHTML = ''
      document.getElementById('serviceInfo').innerHTML = ''
      break

    case 'scanStart':
      scanRunning = true
      scanResults = []
      drawScanChart([])
      document.getElementById('scanBtn').textContent = 'Stop'
      document.getElementById('scanOverlay').classList.add('active')
      const status = document.getElementById('scanStatus')
      status.textContent = 'Scanning...'
      status.className = 'scan-status scanning'
      break

    case 'scanProgress':
      if (!scanResults[msg.ch]) scanResults[msg.ch] = msg.result
      else scanResults[msg.ch] = msg.result
      const compact = []
      for (let i = 0; i < 38; i++) {
        compact[i] = scanResults[i] || { ch: i, name: '', signal: 0, lock: false, services: [] }
      }
      drawScanChart(compact)
      document.getElementById('scanStatus').textContent = `${msg.result.name} \u00b7 ${msg.ch + 1}/38`
      document.getElementById('scanOverlaySub').textContent = `${msg.result.name} \u00b7 ${msg.ch + 1}/38`
      updateScanChannels(compact)
      break

    case 'scanComplete':
      scanRunning = false
      scanResults = msg.data
      drawScanChart(scanResults)
      updateScanChannels(scanResults)
      renderServicesScanList(scanResults)
      markActiveServiceInList()
      document.getElementById('scanBtn').textContent = 'Scan'
      document.getElementById('scanOverlay').classList.remove('active')
      const found = scanResults.filter(r => r && r.services && r.services.length > 0).length
      const st = document.getElementById('scanStatus')
      st.textContent = `Done \u00b7 ${found} found`
      st.className = 'scan-status'
      break

    case 'scanError':
      document.getElementById('scanStatus').textContent = msg.data
      scanRunning = false
      break

    case 'activeService':
      activeService = String(msg.id)
      lufsReset()
      updateDlPlus({})
      document.getElementById('pcRtText').textContent = 'No data'
      document.querySelectorAll('.svc-scan-item').forEach(el => {
        el.classList.toggle('active', el.dataset.ch == msg.ch && el.dataset.svcId == msg.id)
      })
      break

    case 'connectionCount':
      const el = document.getElementById('connectionCount')
      if (el) el.textContent = msg.count + (msg.count === 1 ? ' User Online' : ' Users Online')
      break
  }
}

// ===== HELPERS =====
function updateTuneDisplay(tune) {
  const ch = getChannelByIndex(tune)
  document.getElementById('tuneChannel').textContent = ch ? ch.name : `CH ${tune}`
  document.getElementById('tuneFreq').innerHTML = ch ? `${ch.freq}<span>MHz</span>` : `\u2014<span>MHz</span>`
  document.getElementById('headerTune').textContent = ch ? `${ch.name} \u00b7 ${ch.freq} MHz` : `CH ${tune}`
}

function updateEnsemble(ensemble, ensembleName, ecc) {
  document.getElementById('ensemble').textContent = ensembleName || '-'
  document.getElementById('ensembleId').textContent = ensemble || '-'
  if (ecc !== undefined) { ensembleEcc = ecc; updateEnsembleMeta() }
  document.getElementById('headerEnsemble').textContent = ensembleName || '-'
  document.getElementById('pcEnsembleName').textContent = (ensembleName || '\u2014') + ' \u00b7 ' + (ensemble || '\u2014')
}

function populateServices(list, currentService) {
  const audioOnly = list.filter(s => AUDIO_MODES.includes(s.type))
  const newIds = audioOnly.map(s => String(s.id)).join(',')
  const oldIds = Array.from(servicesDropdown.options).map(o => o.value).join(',')

  if (newIds !== oldIds) {
    servicesDropdown.innerHTML = ''
    audioOnly.forEach(s => {
      const opt = document.createElement('option')
      opt.value = String(s.id)
      opt.text = s.name
      servicesDropdown.appendChild(opt)
    })
  }

  const toSelect = (currentService !== null && currentService !== undefined)
    ? String(currentService)
    : String(activeService)
  servicesDropdown.value = toSelect
  activeService = toSelect
}

function changeService() {
  activeService = servicesDropdown.value
  wsSend({ type: 'setService', id: servicesDropdown.value })
}

function updateSignal(data) {
  const sig = parseFloat(data.SIGNAL)
  if (!isNaN(sig)) {
    signalHistory.push(sig)
    if (signalHistory.length > MAX_POINTS * 2) signalHistory.splice(0, MAX_POINTS)
    document.getElementById('signalBig').innerHTML = sig.toFixed(1) + '<span class="text-medium">dB&#181;V</span>'
    const g = document.getElementById('signalGraphVal')
    if (g) g.textContent = sig.toFixed(1) + ' dB\u00b5V'
  }

  setBar('cnr', normalize(data.CNR,  0, 100))
  setBar('fic', normalize(data.FIC,  0, 100))

  const cnr = parseFloat(data.CNR)
  const fic = parseFloat(data.FIC)
  if (!isNaN(cnr)) document.getElementById('cnrVal').textContent = cnr.toFixed(1)
  if (!isNaN(fic)) document.getElementById('ficVal').textContent = fic.toFixed(0) + '%'

  if (data.SNR !== undefined) {
    const snr = parseFloat(data.SNR)
    if (!isNaN(snr)) {
      setBar('snr', normalize(snr, 0, 25))
      document.getElementById('snrVal').textContent = snr.toFixed(0)
    }
  }

  const lockEl    = document.getElementById('lock')
  const lockLabel = document.getElementById('lockLabel')
  const isLocked  = data.LOCK === '1' || data.LOCK === 1
  if (lockEl)    lockEl.classList.toggle('locked', isLocked)
  if (lockLabel) lockLabel.textContent = isLocked ? 'Locked' : 'No Lock'
}

function setBar(id, value) {
  const el = document.getElementById(id)
  if (el) el.style.width = value + '%'
}

function normalize(val, min, max) {
  val = parseFloat(val)
  if (isNaN(val)) return 0
  return Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100))
}

function renderServiceInfo(info) {
  const container = document.getElementById('serviceInfo')
  container.innerHTML = ''

  Object.entries(info).forEach(([key, value]) => {
    if (key === "ID" || key === "TYPE") return

    let displayValue = value
    let extraClass = "svc-info-value"

    if (key === "AUDIO") {
      displayValue = AUDIO_MAP[value] || value
      const badgeClass = AUDIO_CLASS[value]
      if (badgeClass) {
        container.innerHTML += `
          <div class="svc-info-row">
            <div class="svc-info-label">${SERVICE_INFO_LABELS[key] || key}</div>
            <span class="${badgeClass}">${displayValue}</span>
          </div>`
        return
      }
    } else if (key === "PTY") {
      displayValue = getPtyLabel(value)
      const pc = getPtyClass(value)
      container.innerHTML += `
        <div class="svc-info-row">
          <div class="svc-info-label">${SERVICE_INFO_LABELS[key] || key}</div>
          <span class="${pc}">${displayValue}</span>
        </div>`
      return
    } else if (key === "PROTECTION") {
      displayValue = PROTECTION_MAP[value] || value
    } else if (key === "BITRATE") {
      displayValue = value + " kbps"
    } else if (key === "SAMPLERATE") {
      displayValue = value + " Hz"
    }

    container.innerHTML += `
  <div class="svc-info-row">
        <div class="svc-info-label">${SERVICE_INFO_LABELS[key] || key}</div>
        <div class="${extraClass}">${displayValue}</div>
      </div>`
  })
}

// ===== SCANNER =====
let scanResults = []
let scanRunning = false
const scanCanvas = document.getElementById('scanCanvas')
const scanCtx = scanCanvas.getContext('2d')

function resizeScanCanvas() {
  scanCanvas.width = scanCanvas.offsetWidth
  scanCanvas.height = 80
  if (scanResults.length > 0) drawScanChart(scanResults)
}

resizeScanCanvas()
window.addEventListener('resize', resizeScanCanvas)

function toggleScan() {
  if (scanRunning) {
    wsSend({ type: 'stopScan' })
    scanRunning = false
    document.getElementById('scanBtn').textContent = 'Scan'
    document.getElementById('scanStatus').textContent = 'Stopped'
    document.getElementById('scanStatus').className = 'scan-status'
  } else {
    scanResults = []
    const sc = document.getElementById('scanChannels')
    if (sc) sc.innerHTML = ''
    drawScanChart([])
    wsSend({ type: 'startScan' })
  }
}

function drawScanChart(results) {
  const W = scanCanvas.width
  const H = scanCanvas.height
  scanCtx.clearRect(0, 0, W, H)

  if (!results || results.length === 0) return

  const barW = Math.floor(W / 38) - 1.47
  const maxSig = 80

  for (let i = 0; i < 38; i++) {
    const r = results[i]
    if (!r) continue
    const x = i * (barW + 2) + 1
    const sig = Math.max(0, r.signal || 0)
    const h = Math.max(2, (sig / maxSig) * (H - 16))
    const y = H - h

    let color
    if (!r.lock || sig < 3)  color = '#26332d'
    else if (sig < 10)        color = '#2e6e57'
    else if (sig < 20)        color = '#58dbab'
    else                      color = '#baffdf'

    const grad = scanCtx.createLinearGradient(0, y, 0, H)
    grad.addColorStop(0, color)
    grad.addColorStop(1, color + '44')
    scanCtx.fillStyle = grad
    scanCtx.fillRect(x, y, barW, h)
    scanCtx.fillStyle = (r.lock && sig > 3) ? color : '#ffffff'
    scanCtx.font = '11px "Roboto Mono", monospace'
    scanCtx.textAlign = 'center'
    if (r.name) scanCtx.fillText(r.name, x + barW / 2, y - 2)
  }
  scanCtx.strokeStyle = 'rgba(0,210,255,0.1)'
  scanCtx.lineWidth = 1
  scanCtx.beginPath()
  scanCtx.moveTo(0, H - 1)
  scanCtx.lineTo(W, H - 1)
  scanCtx.stroke()
}

function updateScanChannels(results) {
}

scanCanvas.addEventListener('click', e => {
  if (scanResults.length === 0) return
  const rect = scanCanvas.getBoundingClientRect()
  const xCSS = e.clientX - rect.left
  const W = scanCanvas.width
  const barW = Math.floor(W / 38) - 1.40
  const ch = Math.floor(xCSS * (W / rect.width) / (barW + 2))
  if (ch < 0 || ch > 37) return
  const block = document.querySelector(`.svc-scan-channel[data-ch="${ch}"]`)
  if (!block) return
  const toggle = block.querySelector('.svc-scan-channel-toggle')
  const list = block.querySelector('.svc-scan-services')
  if (!list.classList.contains('open')) {
    toggle.classList.add('open')
    list.classList.add('open')
    localStorage.setItem(`scan-ch-${ch}`, 'open')
  }
  block.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  block.classList.add('highlight')
  setTimeout(() => block.classList.remove('highlight'), 1600)
})

// redraw labels once webfonts are loaded (canvas uses Roboto Mono)
if (document.fonts?.ready) document.fonts.ready.then(() => drawScanChart(scanResults))

// ===== SERVICES SCAN LIST =====
function renderServicesScanList(results) {
  const container = document.getElementById('servicesScanList')
  if (!container) return
  container.innerHTML = ''
  const withServices = results.filter(r => r && r.services && r.services.length > 0)
  if (withServices.length === 0) {
    container.innerHTML = '<div style="font-size:10px; color:var(--text-dim); text-align:center; padding:20px 0;">No services found</div>'
    return
  }
  withServices.forEach(r => {
    const block = document.createElement('div')
    block.className = 'svc-scan-channel'
    block.dataset.ch = r.ch
    const isOpen = localStorage.getItem(`scan-ch-${r.ch}`) !== 'closed'
    const header = document.createElement('div')
    header.className = 'svc-scan-channel-header'
    const subParts = []
    if (r.ensemble)   subParts.push(r.ensemble + (r.ecc ? ` (ECC ${r.ecc})` : ''))
    if (r.signal)     subParts.push(`${r.signal.toFixed(1)} dB\u00b5V`)
    if (r.cnr)        subParts.push(`CNR ${r.cnr.toFixed(0)}`)
    if (r.snr !== undefined && r.snr !== 0) subParts.push(`SNR ${r.snr.toFixed(0)}`)
    if (r.fiberr)     subParts.push(`FIB err ${r.fiberr}`)
    header.innerHTML = `
      <div>
        <div class="svc-scan-channel-name">${r.name}</div>
        ${subParts.length ? `<div class="svc-scan-channel-sub">${subParts.join(' \u00b7 ')}</div>` : ''}
      </div>
      <span class="svc-scan-channel-toggle ${isOpen ? 'open' : ''}">&#9658;</span>
    `
    const servicesList = document.createElement('div')
    servicesList.className = 'svc-scan-services' + (isOpen ? ' open' : '')
    r.services.forEach(svc => {
      const item = document.createElement('div')
      item.className = 'svc-scan-item'
      const modeName = SERVICE_MODES[String(svc.type)] || ''
      item.innerHTML = `${svc.name}${modeName ? ` <span class="svc-type">${modeName}</span>` : ''}`
      item.title = svc.name + (modeName ? ` (${modeName})` : '')
      item.dataset.ch = r.ch
      item.dataset.svcId = svc.id
      item.onclick = () => tuneToService(r.ch, svc.id)
      servicesList.appendChild(item)
    })
    header.onclick = () => {
      const toggle = header.querySelector('.svc-scan-channel-toggle')
      toggle.classList.toggle('open')
      servicesList.classList.toggle('open')
      localStorage.setItem(`scan-ch-${r.ch}`, servicesList.classList.contains('open') ? 'open' : 'closed')
    }
    block.appendChild(header)
    block.appendChild(servicesList)
    container.appendChild(block)
  })
}

function tuneToService(ch, serviceId) {
  const currentCh = parseInt(document.getElementById('tuneSelect').value)
  if (currentCh === ch) {
    wsSend({ type: 'setService', id: serviceId })
  } else {
    wsSend({ type: 'setTune', channel: String(ch) })
    setTimeout(() => wsSend({ type: 'setService', id: serviceId }), 3000)
  }
  document.querySelectorAll('.svc-scan-item').forEach(el => {
    el.classList.toggle('active', el.dataset.ch == ch && el.dataset.svcId == serviceId)
  })
}

function expandSlideshow() {
  const src = document.getElementById('slideshow').src
  if (!src || src.endsWith('default.jpg')) return
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:pointer;'
  const img = document.createElement('img')
  img.src = src
  img.style.cssText = 'height: 240px;border-radius:8px;box-shadow:0 0 40px rgba(0,210,255,0.3);'
  overlay.appendChild(img)
  overlay.onclick = () => document.body.removeChild(overlay)
  document.body.appendChild(overlay)
}


window.addEventListener('pagehide', () => {
  if (socket) socket.close()
})

// init
populateTuneDropdown(null)
updateDlPlus({})


// layout debug (alleen met ?laydbg=1)
if (location.search.includes('laydbg')) setTimeout(() => {
  const r = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : 'x' }
  const css = getComputedStyle(document.querySelector('.vu-block'))
  document.title = 'UA:' + navigator.userAgent.split(') ').pop() +
    ' | panel=' + r('.station-panel') + ' split=' + r('.station-split') + ' vublock=' + r('.vu-block') +
    ' vumeters=' + r('.vu-meters') + ' rt=' + r('.rt-box') +
    ' | vupos=' + css.position + ' fs=' + css.flexDirection
}, 3000)
