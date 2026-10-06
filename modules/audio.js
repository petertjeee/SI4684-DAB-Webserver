const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const config = require('../config.json')
const { info, warn, error } = require('./logger')

const audioEmitter = new EventEmitter()
audioEmitter.setMaxListeners(50)

let audioRunning = false

function startAudio() {
  if (!config.audio.device) {
    warn('Audio device not configured, skipping. Use /setup to configure.')
    return
  }
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
      '-i', `audio=${config.audio.device}`,
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
      '-D', config.audio.device,
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
