const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/tiff']);

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Limits must be positive integers');
  return number;
}

function createApp(options = {}) {
  const app = express();
  const ocrUrl = (options.ocrUrl ?? process.env.OCR_SERVICE_URL ?? 'http://127.0.0.1:8001').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxFileSize = positiveInteger(options.maxFileSize ?? process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
  const timeoutMs = positiveInteger(options.timeoutMs ?? process.env.OCR_TIMEOUT_MS, 180000);
  const maxConcurrent = positiveInteger(options.maxConcurrent ?? process.env.MAX_CONCURRENT_UPLOADS, 2);
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim());
  let activeUploads = 0;

  app.disable('x-powered-by');
  app.use(cors({ origin: origins, methods: ['GET', 'POST'] }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', async (_req, res) => {
    try {
      const response = await fetchImpl(`${ocrUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      res.status(response.ok ? 200 : 503).json({ ...data, max_upload_bytes: Math.min(maxFileSize, data.max_upload_bytes || maxFileSize) });
    } catch {
      res.status(503).json({ status: 'unavailable', error: 'OCR service is unavailable.' });
    }
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSize, files: 1, fields: 0, parts: 2 },
    fileFilter: (_req, file, cb) => {
      // The OCR service independently decodes and verifies the content.
      if (!MIME_TYPES.has(file.mimetype)) {
        const error = new Error('Use a PDF, PNG, JPEG, WebP, or TIFF file.');
        error.status = 415;
        return cb(error);
      }
      cb(null, true);
    },
  });

  app.post('/api/upload', (req, res, next) => {
    if (activeUploads >= maxConcurrent) {
      res.set('Retry-After', '5');
      return res.status(429).json({ error: 'The service is busy. Please try again shortly.' });
    }
    activeUploads++;
    let released = false;
    const release = () => {
      if (!released) { activeUploads--; released = true; }
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  }, upload.single('file'), async (req, res) => {
    if (!req.file?.size) return res.status(400).json({ error: 'Upload a non-empty file.' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => controller.abort();
    res.once('close', onClose);
    try {
      const form = new FormData();
      form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
      const response = await fetchImpl(`${ocrUrl}/process`, {
        method: 'POST', body: form, signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        const allowed = [400, 413, 415, 422, 429, 502, 503, 504];
        const status = allowed.includes(response.status) ? response.status : 502;
        return res.status(status).json({ error: typeof data.detail === 'string' ? data.detail : 'The OCR service could not process this document.' });
      }
      if (typeof data.text !== 'string' || !Number.isInteger(data.pages) || data.pages < 1 || !Array.isArray(data.page_results)) {
        return res.status(502).json({ error: 'The OCR service returned an invalid response.' });
      }
      res.json({ success: true, data, filename: req.file.originalname });
    } catch (error) {
      if (res.destroyed) return;
      const timedOut = controller.signal.aborted || error.name === 'TimeoutError';
      res.status(timedOut ? 504 : 503).json({ error: timedOut
        ? 'Processing took too long. Try a smaller document.'
        : 'OCR service is unavailable. Please try again shortly.' });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      req.file.buffer = null;
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error:
        error.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${Math.floor(maxFileSize / 1024 / 1024)} MB limit.` : 'Upload exactly one file using the file field.',
      });
    }
    res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Unable to process the upload.' });
  });
  return app;
}

if (require.main === module) {
  const port = positiveInteger(process.env.PORT, 3001);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createApp().listen(port, host, () => console.log(`API running on http://${host}:${port}`));
  server.requestTimeout = 200000;
}

module.exports = { createApp };
