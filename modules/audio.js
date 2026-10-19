const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const config = require('../config.json')
const { info, warn, error } = require('./logger')

const audioEmitter = new EventEmitter()
audioEmitter.setMaxListeners(50)

let audioRunning = false

// Resolve the ALSA card that shares a USB serial number with the configured
// serial port, so audio always follows the same physical tuner regardless
// of enumeration order (ttyACM0/1, card DAB/DAB_1 can swap per boot).
function usbSerialOfDevice(sysfsDeviceLink) {
  try {
    const parent = path.dirname(fs.realpathSync(sysfsDeviceLink))
    return fs.readFileSync(`${parent}/serial`, 'utf8').trim()
  } catch (e) {
    return null
  }
}

function resolveAudioDevice() {
  if (process.platform !== 'linux' || !config.serial?.port || !config.audio?.device) {
    return config.audio?.device
  }
  try {
    const tty = path.basename(fs.realpathSync(config.serial.port))
    const tunerSerial = usbSerialOfDevice(`/sys/class/tty/${tty}/device`)
    if (!tunerSerial) return config.audio.device

    for (const card of fs.readdirSync('/sys/class/sound')) {
      if (!/^card\d+$/.test(card)) continue
      if (usbSerialOfDevice(`/sys/class/sound/${card}/device`) !== tunerSerial) continue
      const id = fs.readFileSync(`/sys/class/sound/${card}/id`, 'utf8').trim()
      const prefix = config.audio.device.match(/^\w+:/)?.[0] || 'plughw:'
      const resolved = `${prefix}${id}`
      if (resolved !== config.audio.device) {
        info(`Audio device resolved to '${resolved}' (tuner USB serial ${tunerSerial})`)
      }
      return resolved
    }
    warn(`No ALSA card found matching tuner USB serial ${tunerSerial}, using '${config.audio.device}'`)
  } catch (e) {
    warn(`Audio device resolution failed: ${e.message}`)
  }
  return config.audio.device
}

function startAudio() {
  if (!config.audio.device) {
    warn('Audio device not configured, skipping. Use /setup to configure.')
    return
  }
  const audioDevice = resolveAudioDevice()
  if (audioRunning) return
  audioRunning = true

  let arecord = null
  let ffmpeg = null

  if (process.platform === 'win32') {
    ffmpeg = spawn('ffmpeg', [
      '-fflags', '+nobuffer+flush_packets',
      '-flags', 'low_delay',
      '-rtbufsize', '32',
      '-probesize', '32',
      '-f', 'dshow',
      '-audio_buffer_size', '200',
      '-i', `audio=${audioDevice}`,
      '-acodec', 'libmp3lame',
      '-b:a', config.audio.bitrate,
      '-ac', String(config.audio.channels),
      '-reservoir', '0',
      '-f', 'mp3',
      '-write_xing', '0',
      '-id3v2_version', '0',
      '-fflags', '+nobuffer',
      '-flush_packets', '1',
      'pipe:1'
    ])

    ffmpeg.stdout.on('data', chunk => audioEmitter.emit('chunk', chunk))
    ffmpeg.stderr.on('data', () => {})

    function cleanup(reason) {
      if (!audioRunning) return
      audioRunning = false
      warn(`Audio oprit (${reason}), repornim in 2s...`)
      try { ffmpeg.kill('SIGKILL') } catch(e) {}
      setTimeout(startAudio, 2000)
    }

    ffmpeg.on('close', () => cleanup('ffmpeg closed'))
    ffmpeg.on('error', e => cleanup(`ffmpeg error: ${e.message}`))

  } else {
    arecord = spawn('arecord', [
      '-D', audioDevice,
      '-f', 'S16_LE',
      '-r', String(config.audio.sampleRate),
      '-c', String(config.audio.channels),
      '--buffer-time=1000000',
      '--period-time=20000',
      '-t', 'raw'
    ])

    ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'warning',
      '-thread_queue_size', '512',
      '-f', 's16le',
      '-ar', String(config.audio.sampleRate),
      '-ac', String(config.audio.channels),
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame',
      '-b:a', config.audio.bitrate,
      '-ac', String(config.audio.channels),
      '-reservoir', '0',
      '-f', 'mp3',
      '-write_xing', '0',
      '-id3v2_version', '0',
      '-flush_packets', '1',
      'pipe:1'
    ])

    arecord.stdout.pipe(ffmpeg.stdin)
    arecord.stderr.on('data', d => warn(`arecord: ${d.toString().trim()}`))
    ffmpeg.stdout.on('data', chunk => audioEmitter.emit('chunk', chunk))
    ffmpeg.stderr.on('data', d => warn(`ffmpeg: ${d.toString().trim()}`))

    function cleanup(reason) {
      if (!audioRunning) return
      audioRunning = false
      warn(`Audio oprit (${reason}), repornim in 2s...`)
      try { arecord.kill('SIGKILL') } catch(e) {}
      try { ffmpeg.kill('SIGKILL') } catch(e) {}
      setTimeout(startAudio, 2000)
    }

    arecord.on('close', () => cleanup('arecord closed'))
    ffmpeg.on('close', () => cleanup('ffmpeg closed'))
    arecord.on('error', e => cleanup(`arecord error: ${e.message}`))
    ffmpeg.on('error', e => cleanup(`ffmpeg error: ${e.message}`))
  }
}

module.exports = { audioEmitter, startAudio }
