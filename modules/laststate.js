const fs   = require('fs')
const path = require('path')

const CFG_PATH = path.join(__dirname, '../config.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) } catch(e) { return {} }
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)) } catch(e) {}
}

function getLastState() {
  const cfg = loadConfig()
  return cfg.lastState || { mode: 'dab', dabTune: null, dabService: null, fmFreq: 100700 }
}

function saveLastState(patch) {
  const cfg = loadConfig()
  cfg.lastState = Object.assign(getLastState(), patch)
  saveConfig(cfg)
}

module.exports = { getLastState, saveLastState }
