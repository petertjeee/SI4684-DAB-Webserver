const { info, warn } = require('./logger')

// ================= HTTP AUDIO STREAM =================

module.exports = function registerStream(app, audioEmitter) {
  app.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-store',
      'X-Content-Duration': '0',
      'icy-br': '128',
      'icy-metaint': '0',
      'icy-name': 'DAB+ PMC Timisoara',
      'Access-Control-Allow-Origin': '*',
    });

    info(`[STREAM] Client conectat: ${req.ip}`);

    const onChunk = chunk => {
      try { res.write(chunk) } catch(e) {}
    };

    audioEmitter.on('chunk', onChunk);

    req.on('close', () => {
      audioEmitter.off('chunk', onChunk);
      warn(`[STREAM] Client deconectat: ${req.ip}`);
    });
  });
};
