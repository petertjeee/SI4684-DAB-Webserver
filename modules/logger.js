const colors = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m'
}

function getTimestamp() {
  const now = new Date()
  const pad = n => n.toString().padStart(2, '0')
  return `[${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}]`
}

function info(msg)  { console.log(`${getTimestamp()} ${colors.green}[INFO]${colors.reset} ${msg}`) }
function warn(msg)  { console.log(`${getTimestamp()} ${colors.yellow}[WARN]${colors.reset} ${msg}`) }
function error(msg) { console.log(`${getTimestamp()} ${colors.red}[ERROR]${colors.reset} ${msg}`) }

module.exports = { info, warn, error, getTimestamp, colors }
