# OCR Nexus

A React interface, Express upload API, and FastAPI OCR service for extracting and reviewing text from PDFs and images. The default configuration runs locally with Tesseract. Google Cloud Vision document OCR is available through server-side configuration.

## Windows desktop installation

Download **`OCR-Nexus-Setup-<version>-x64.exe`** from your public repository's **Releases** page for Windows 10/11 on Intel/AMD 64-bit PCs. Copy it to the PC, run the setup wizard, and open **OCR Nexus** from the desktop or Start menu. Local builds appear in `release/`. The installer includes the application, Python 3.14.9, Tesseract 5.5.3, OCR libraries, and English/Kannada language data. No separate development tools or services are needed. Local extraction works offline.

Review and edit the document text and table cells, then export TXT, CSV, or JSON. The default language is English. To enable Kannada too, open **File → OCR settings folder**, set `TESSERACT_LANG=eng+kan` in `settings.env`, and restart. Google Cloud Vision remains optional: use `OCR_PROVIDER=google` and your own `GOOGLE_APPLICATION_CREDENTIALS` in that settings file. Cloud processing requires internet and a configured Google Cloud project; credentials are never included in the installer.

This is an unsigned personal build, so Windows may show an unknown-publisher or SmartScreen prompt. A SHA-256 checksum and `INSTALL-WINDOWS.txt` are included beside the installer. The initial installer was built on macOS; desktop UI and OCR integration checks passed there. A real Windows installation has not yet been tested. Windows ARM and 32-bit systems are not the target of this build.

The desktop app starts its own services on available loopback ports, authenticates their requests with a fresh private token, and closes OCR child processes on exit. Settings and startup diagnostics (`desktop.log`) are stored in the user data folder, normally `%APPDATA%/OCR Nexus`. Uninstall through Windows Settings → Apps. Exported documents and settings are retained.

### Automatic updates from GitHub

1. Push this project, including `.github/workflows/windows-installer.yml`, to a **public GitHub repository's default branch** (usually `main`). GitHub Actions must be enabled.
2. Wait for **Actions → Windows updates** to finish. It builds and tests the Windows app, verifies the installer hashes, then publishes a GitHub Release containing the EXE, blockmap, checksum, and `latest.yml`.
3. Install that first GitHub release manually. **The earlier 2.1.0 EXE cannot update itself:** it predates the updater. Installing the new release over it keeps settings and exported documents.
4. Future pushes to the default branch automatically publish new numbered releases after the checks pass. No manual version bump, Git tag, personal access token, or repository URL in the source code is needed.

The app checks five seconds after opening and every **15 minutes** while running. You can also use **Help → Check for updates**. It offers **Download update / Later**, shows download progress in the Help menu and Windows taskbar, and then offers **Restart and install / Later**. Export unsaved text and table edits before restarting. Choosing Later never installs silently on exit. Offline/background failures stay quiet; manual checks and requested download failures show a useful message. Local OCR continues to work without internet.

GitHub supplies the update repository automatically at build time. The workflow uses its temporary `GITHUB_TOKEN` only in the release publishing job; no GitHub credentials are packaged in the app. A release stays in draft until all files are uploaded, so installed apps do not see incomplete releases. Failed builds do not publish updates. Feature branches are not released; rapid pushes may replace queued builds so the newest pending commit is built next. Re-running an older workflow does not replace a newer published update.

The committed desktop version is a base such as `2.2.0`. CI uses the workflow run number as the patch version (`2.2.1`, `2.2.2`, …), updating the package and lock only in its checkout. Keep the base patch at zero; raise the minor or major number deliberately for a new series. Keep the same workflow and application ID to preserve version ordering and Windows installation identity. Settings in `%APPDATA%/OCR Nexus` remain outside the installation directory.

For a local installer connected to an existing repository, set `OCR_UPDATE_REPOSITORY=YOUR-USERNAME/YOUR-REPOSITORY` before `npm run desktop:build` (PowerShell: `$env:OCR_UPDATE_REPOSITORY = 'YOUR-USERNAME/YOUR-REPOSITORY'`). A local build without this setting has automatic updates disabled. Local builds never publish; GitHub Actions handles publication. Do not commit generated installers, `node_modules`, credentials, or `latest.yml`; the provided `.gitignore` excludes build output.

The current build remains unsigned. Updates use HTTPS and verify the installer hash in release metadata; Windows may still display a publisher warning. A code-signing certificate can be added later. See [electron-updater's update workflow](https://www.electron.build/v26/docs/features/auto-update/) and [GitHub Actions push triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore).

### Rebuild the Windows installer

On a build computer, install Node.js 22.12+, Python 3.14, and (on Windows) 7-Zip. macOS builds fetch a pinned 7-Zip tool automatically. Internet is required during the build. From the project root:

```sh
npm ci --prefix frontend
npm ci --prefix desktop
npm run desktop:build
```

`PYTHON` can select the build Python executable. The script otherwise prefers the project's virtual environment, then `python` on Windows or `python3` on macOS. If a macOS Python installation lacks trusted CA certificates, install `certifi` into that build environment. The app installer itself needs no internet access.

The build validates SHA-256 hashes in `desktop/windows-assets.json` and `desktop/windows-wheels.lock.json`, vendors native Windows wheels, and creates an NSIS installer in `release/`. The build never executes the downloaded Python/Tesseract/Microsoft Windows installers on the host. Only selected service files and the built frontend are packaged; `.env` files, user documents, and development virtual environments are excluded. `desktop/THIRD-PARTY-NOTICES.txt` lists bundled software.

For desktop development, complete the Quick start below, install desktop dependencies, then run `npm run desktop:dev`. `npm run desktop:test` checks private service startup, real photo/table extraction, cleanup, update consent/failure behavior, version numbering, and release validation. `npm --prefix desktop run test:electron` checks the real desktop window, editing, CSV/TXT export, clipboard, PDF preview, and the NSIS update downloader's rejection of corrupted payloads. It never executes a test installer. The **Windows updates** workflow also runs the smoke test against the packaged app on Windows before publishing. Local macOS checks do not verify a Windows installation or upgrade; those still need testing on a Windows PC.

If **Windows updates** fails, the commit and push still succeeded. Open the failed step to see the error. The desktop test waits up to 200 seconds for the upload response, covering the application's 150-second OCR deadline and 180-second API timeout, and reports HTTP errors directly. The run's **windows-test-diagnostics** artifact contains the desktop log and a screenshot; failures also include the screen text and test error. Processing logs record timing and status without document text. Desktop OCR defaults to one OpenMP thread per worker to avoid CPU contention while retaining the bundled recognition models. After fixing the code, commit and push the changes to start a new run; re-running an old job uses its old code.

## Quick start

Requirements: Node.js 22.12+ (or a newer supported release), Python 3.11+, and Tesseract 5 with the required language data. The current environment was tested with Node 22 and Python 3.14.

On macOS, install Tesseract if needed:

```sh
brew install tesseract
```

On Debian/Ubuntu:

```sh
sudo apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd
```

From the project root:

```sh
npm ci --prefix backend
npm ci --prefix frontend
python3 -m venv ocr-service/venv
ocr-service/venv/bin/python -m pip install --upgrade pip
ocr-service/venv/bin/python -m pip install -r ocr-service/requirements-dev.txt -c ocr-service/requirements.lock.txt
npm run dev
```

Open **http://127.0.0.1:5173**. Ctrl+C stops all three services. The launcher is intended for local development. Set `OCR_PYTHON` to an absolute Python executable path to use a different virtual environment.

The services can also run separately in three terminals:

```sh
# Terminal 1, from the project root
ocr-service/venv/bin/python ocr-service/main.py

# Terminal 2
npm --prefix backend start

# Terminal 3
npm --prefix frontend run dev
```

Default ports are frontend `5173`, API `3001`, and OCR `8001`. Defaults work without `.env` files. Copy a service's `.env.example` to `.env` when customizing it. Restart the affected services after changing configuration. Do not overwrite an existing `.env` file.

`ocr-service/requirements.lock.txt` records the tested runtime versions. For a runtime-only installation, use `python -m pip install -r ocr-service/requirements.lock.txt` in your virtual environment. Update and audit the lockfile when upgrading dependencies.

## Extraction strategy

| Document | Processing |
| --- | --- |
| PDF page with usable text, no raster images, and no vector paths to inspect for tables | Direct PDFium text extraction, without an OCR call |
| Text PDF containing vector paths, with table extraction enabled | Keep native text; render the page and OCR its tables |
| Scanned PDF, or a page containing both text and raster images | Render one page at a time, then use the configured OCR provider |
| PNG, JPEG, WebP | Decode, validate dimensions, correct EXIF orientation, flatten transparency, conservatively correct page perspective/skew, then OCR |
| Multi-page TIFF | Process every frame, preserving page order |

PDF pages render at up to 300 DPI, reduced when necessary to respect the pixel limit. Local OCR uses automatic page segmentation, grayscale/contrast preprocessing, confident orientation correction when OSD data is installed, and sparse-text detection when the first pass finds nothing. Detected lines and paragraphs are retained. PDFium replaces the old Poppler dependency.

Choose `tesseract` for local processing of printed documents. Choose `google` to evaluate Google's document OCR on handwriting, multilingual scans, or documents where local results are insufficient. No single engine is guaranteed to be best for every input; benchmark representative documents against corrected text before choosing an accuracy target. This project extracts text, page metadata, and ruled-table cells. It does not infer semantic fields such as letter number or subject. See [Google document OCR](https://docs.cloud.google.com/vision/docs/fulltext-annotations) and [Tesseract image-quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html).

Pages with raster images are intentionally OCRed even if a small text layer exists, avoiding a result that contains only a page number or header. This conservative rule may also OCR digital PDFs containing a logo. Text-only PDFs with broken font mappings may still require manual correction.

Confidence is an engine estimate, not an accuracy score. Direct PDF extraction returns `null` confidence. Overall confidence averages OCR page confidence weighted by word count, excluding direct extraction and blank pages. The interface flags low-confidence and empty pages and allows editing, copying, and TXT/JSON downloads, plus CSV downloads for individual tables. JSON marks manual edits; confidence continues to describe the original extraction.

## Photographed letters and table rows

The photo pipeline targets documents such as official letters with dense print, reference lists, and bordered specification tables. `PHOTO_PREPROCESSING=true` enables conservative perspective correction when a large bright sheet is clearly separated from a darker surface, small-angle deskew, and illumination normalization for local OCR. Local OCR enlarges smaller inputs up to twice their original size to aid recognition; this cannot recover detail lost in a compressed or blurry photo. No automatic crop is applied when a suitable page boundary is not found. The original preview remains unchanged.

`EXTRACT_TABLES=true` detects enclosed cells from horizontal/vertical ruling lines and maps OCR words to cells by their positions. It works with either Tesseract or Google Vision and preserves rectangular row/column spans when those boundaries are detectable. Local table recognition removes detected rules and makes one additional OCR pass per table; Google uses word positions from its existing OCR response, with no additional cloud table call.

The review screen displays editable tables below each page's text. Text and table cells are independent editable representations: TXT/copy uses the text editor; each table's CSV uses its cell editors; JSON includes both. Merged values appear in the first cell in CSV, with covered cells empty. JSON retains `row`, `column`, `row_span`, and `column_span` (zero-based indices). CSV values that could be interpreted as spreadsheet formulas are prefixed with an apostrophe. Cell `box` coordinates refer to the corrected/resized OCR image, not the original upload, and should not be used directly as an original-image overlay.

This is conservative ruled-table detection, not general table understanding. Borderless, badly broken, curved, or ambiguous grids may produce no table. Empty cells remain empty; values are not inferred. Table headers and letterhead grids are retained as recognized, without guessing which rows are data. Review merged cells, handwritten dates/numbers, stamps, and tiny print against the original. Tesseract's `eng` model handles English print; additional Kannada body text requires installed `kan` language data and `TESSERACT_LANG=eng+kan`, or evaluation with Google OCR's language detection. For a letter like the supplied example, prefer the original PDF or a sharp full-resolution scan over a compressed chat photo.

Tests include synthetic clean and photographed letters with shadows, perspective, merged table cells, and both native/scanned PDFs. The specific chat attachment was not available as a local file and has not been benchmarked. Google Form Parser is not used as a shortcut for merged tables because its documented table support excludes spanning cells; see [Form Parser limitations](https://docs.cloud.google.com/document-ai/docs/form-parser).

## Enable Google Cloud Vision

1. Set up a Google Cloud project with billing and enable the Cloud Vision API following [Google's setup guide](https://docs.cloud.google.com/vision/docs/setup).
2. Configure Application Default Credentials on the machine running the Python service. For local development, with the Google Cloud CLI installed:

   ```sh
   gcloud auth application-default login
   gcloud auth application-default set-quota-project YOUR_PROJECT_ID
   ```

3. Create `ocr-service/.env` from its example and set:

   ```dotenv
   OCR_PROVIDER=google
   # Optional: leave empty for automatic language detection.
   GOOGLE_LANGUAGE_HINTS=
   ```

4. Restart the Python service and refresh the browser. The interface should show **Google Cloud Vision** and disclose that scans are sent to Google.

In deployment, use the runtime's service identity or another supported ADC mechanism. If using a service-account JSON file, set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path in the Python environment. Keep the file outside the repository and never put credentials into a `VITE_` variable. See [Google authentication guidance](https://docs.cloud.google.com/vision/docs/authentication).

Google mode uses `document_text_detection` on individual page images with the official Python SDK. It needs no Cloud Storage bucket. Pages that only need direct text extraction remain local. Scanned pages and text PDF pages rendered to inspect tables go to Google and may incur per-page charges. There is no silent provider fallback or automatic retry that might duplicate charges. Cancelling a browser request does not guarantee cancellation of a Google operation already sent. The health endpoint checks credential availability, not billing, quotas, or live permissions. Those are checked when an OCR call runs.

The Google adapter is covered by mocked SDK success/error tests. Live Google OCR has not been verified in this workspace because project credentials were not configured as part of this task.

## Configuration and limits

See [backend/.env.example](backend/.env.example), [ocr-service/.env.example](ocr-service/.env.example), and [frontend/.env.example](frontend/.env.example).

- Default maximum file size: 10 MiB. Configure both services consistently; the UI reports the smaller limit.
- Maximum pages or image frames: 20. Maximum decoded image size: 25 million pixels.
- Two concurrent uploads/documents per service process; extra requests receive a retryable error.
- Python document deadline: 150 seconds, enforced by terminating its isolated worker. Individual OCR calls are capped at 35 seconds. API timeout: 180 seconds; browser timeout: 190 seconds.
- Local language configuration uses Tesseract codes, such as `eng+hin`; install matching language packs. Google language hints use Google's language codes and are independent of Tesseract.
- Accepted MIME types: `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `image/tiff`. The service independently decodes and checks actual content. SVG, HTML, and unsupported images are rejected.
- TIFF preview depends on browser support; the review screen provides a link to open the original file. PDF preview uses the browser's PDF viewer.

The API holds bounded uploads in memory. Python's multipart parser may temporarily spool larger uploads to disk; those handles are closed after processing or parsing failure. Results are not stored in a database. Object URLs are released when leaving the review screen. Google provider retention is governed by the configured Google service.

## API

`GET /api/health` reports OCR readiness, provider, processing location, upload size, and page limit. It returns `503` if the OCR service or selected local provider configuration is unavailable.

`POST /api/upload` accepts one multipart field named `file`:

```sh
curl -F 'file=@frontend/tests/fixtures/invoice.png' http://127.0.0.1:3001/api/upload
```

Successful response:

```json
{
  "success": true,
  "filename": "invoice.png",
  "data": {
    "text": "INVOICE 12345\nTotal amount 250.00",
    "confidence": 96.0,
    "pages": 1,
    "provider": "tesseract",
    "page_results": [
      { "page": 1, "text": "INVOICE 12345\nTotal amount 250.00", "confidence": 96.0, "engine": "tesseract", "word_count": 5 }
    ],
    "warnings": []
  }
}
```

The confidence value above is illustrative. Errors return `{ "error": "..." }` with `400`, `413`, `415`, `422`, `429`, `502`, `503`, or `504` as appropriate. The internal Python endpoints are `/health` and `/process` and use FastAPI's `detail` error field.

## Verification

```sh
npm --prefix backend test
ocr-service/venv/bin/python -m pytest -c ocr-service/pytest.ini ocr-service/tests
npm run lint
npm run build

# Install Playwright Chromium once, then run browser tests:
cd frontend
npx playwright install chromium
npm test
```

If Google Chrome is already installed, `PLAYWRIGHT_CHANNEL=chrome npm test` avoids downloading Chromium. From the root, `PLAYWRIGHT_CHANNEL=chrome npm test` runs backend, Python, and browser tests together. Browser tests start isolated local services on ports 15173, 13001, and 18001 and include actual image/PDF extraction through all three services. The bundled fixtures are synthetic documents, not customer data.

## Build and deployment

`npm run build` generates `frontend/dist`. `npm --prefix frontend run preview` previews it locally with the API proxy. Vite dev/preview both proxy `/api` to `http://127.0.0.1:3001`.

For deployment, serve `frontend/dist` from a web server and proxy `/api` to the backend, with a request size limit just above the configured upload limit and a proxy timeout above 180 seconds. Alternatively, build with `VITE_API_BASE_URL=https://your-api-origin` and configure `CORS_ORIGINS` accordingly. The Python service should remain internal. Services bind to loopback by default; configure `HOST` for your deployment topology. The root launcher is not a production process supervisor.

This application has no user accounts or persistent document storage. Add authentication and per-user quotas before exposing paid OCR to untrusted public clients. In a scaled deployment, concurrency limits are per process; use deployment resource limits and a job queue for larger workloads.
