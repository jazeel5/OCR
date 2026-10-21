# OCR Nexus frontend

React 19, Vite, and Tailwind CSS 4. This interface uploads documents to the backend and provides previews, page-by-page editable extraction, confidence indicators, editable ruled tables, and TXT/CSV/JSON export.

See the [project README](../README.md) for installation, running all three services, OCR configuration, Google credentials, and deployment.

```sh
npm ci
npm run dev
npm run lint
npm run build
```

The development and preview servers proxy `/api` to `http://127.0.0.1:3001`. Set `VITE_API_BASE_URL` only if the API is hosted separately; never place service credentials in frontend environment variables.

Browser tests require the Python virtual environment and backend dependencies described in the project README:

```sh
npx playwright install chromium
npm test
# Or use an installed Google Chrome:
PLAYWRIGHT_CHANNEL=chrome npm test
```
