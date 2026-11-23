import { MAX_WAV_BYTES, voiceError } from '../core/voice/wav.js';
import { readBody } from './control.js';
import { authorize } from './registry-router.js';

function reply(res, status, body) {
  res.writeHead(status, { 'Cache-Control': 'no-store',
    ...(body !== undefined && { 'Content-Type': 'application/json; charset=utf-8' }) });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readAudio(req, signal) {
  if (!/^audio\/wav(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) throw voiceError(415, 'invalid_audio');
  if (Number(req.headers['content-length']) > MAX_WAV_BYTES) throw voiceError(413, 'body_too_large');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    function cleanup() {
      req.off('data', data); req.off('end', end); req.off('close', abort); req.off('error', abort);
      signal.removeEventListener('abort', abort);
    }
    function data(chunk) {
      total += chunk.length;
      if (total > MAX_WAV_BYTES) { cleanup(); reject(voiceError(413, 'body_too_large')); }
      else chunks.push(chunk);
    }
    function end() { cleanup(); resolve(Buffer.concat(chunks, total)); }
    function abort() { cleanup(); reject(voiceError(400, 'request_aborted')); }
    req.on('data', data); req.once('end', end); req.once('close', abort); req.once('error', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function handleVoice(req, res, pathname, voice) {
  try {
    authorize(req);
    if (pathname === '/api/voice/status' && req.method === 'GET') return reply(res, 200, await voice.status());
    if (pathname === '/api/voice/settings' && req.method === 'POST') return reply(res, 200, await voice.setSettings(await readBody(req)));
    const model = /^\/api\/voice\/models\/([\w-]+)\/download$/.exec(pathname);
    if (model && req.method === 'POST') {
      voice.download(model[1]);
      return reply(res, 202);
    }
    if (model && req.method === 'DELETE') {
      await voice.remove(model[1]);
      return reply(res, 204);
    }
    if (pathname === '/api/voice/transcribe' && req.method === 'POST') {
      const params = new URL(req.url, 'http://127.0.0.1').searchParams;
      if (params.getAll('language').length > 1) throw voiceError(400, 'invalid_language');
      const request = new AbortController();
      const abort = () => request.abort();
      res.once('close', abort);
      try {
        const result = await voice.transcribe(signal => readAudio(req, signal), { language: params.get('language') ?? undefined, signal: request.signal });
        if (!res.destroyed) return reply(res, 200, result);
      } finally { res.off('close', abort); }
      return;
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error.status === 413) req.resume();
    if (!res.destroyed) return reply(res, error.status ?? 500, { error: error.status ? error.message : 'Voice operation failed' });
  }
}
