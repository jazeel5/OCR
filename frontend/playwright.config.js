import { defineConfig } from '@playwright/test';
import process from 'node:process';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:15173',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: '../ocr-service/venv/bin/python -m uvicorn main:app --app-dir ../ocr-service --host 127.0.0.1 --port 18001',
      url: 'http://127.0.0.1:18001/health',
      env: { OCR_PROVIDER: 'tesseract' },
      timeout: 30000,
    },
    {
      command: 'node ../backend/server.js',
      url: 'http://127.0.0.1:13001/api/health',
      env: { PORT: '13001', OCR_SERVICE_URL: 'http://127.0.0.1:18001', CORS_ORIGINS: 'http://127.0.0.1:15173' },
      timeout: 30000,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 15173 --strictPort',
      url: 'http://127.0.0.1:15173',
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:13001' },
      timeout: 30000,
    },
  ],
});
