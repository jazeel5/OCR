"""Bounded document extraction with local Tesseract or Google document OCR."""
from __future__ import annotations

import io
import logging
import math
import multiprocessing
import os
import signal
import subprocess
from pathlib import Path
import threading
import time
import warnings
from functools import lru_cache
from contextlib import closing

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from PIL import Image, ImageOps, UnidentifiedImageError
import pypdfium2 as pdfium
import pytesseract
import cv2
import numpy as np
from document_layout import correct_photo, normalize_lighting, detect_tables, fill_tables
from starlette.concurrency import run_in_threadpool
from starlette.formparsers import MultiPartException

load_dotenv(Path(__file__).with_name('.env'))
if os.getenv('TESSERACT_CMD'):
    pytesseract.pytesseract.tesseract_cmd = os.environ['TESSERACT_CMD']
logger = logging.getLogger(__name__)


def positive_int(name, default):
    value = int(os.getenv(name, default))
    if value <= 0:
        raise ValueError(f'{name} must be positive')
    return value


PROVIDER = os.getenv('OCR_PROVIDER', 'tesseract').lower()
if PROVIDER not in {'tesseract', 'google'}:
    raise ValueError('OCR_PROVIDER must be tesseract or google')
MAX_UPLOAD_BYTES = positive_int('MAX_UPLOAD_BYTES', 10 * 1024 * 1024)
MAX_PAGES = positive_int('MAX_PAGES', 20)
MAX_IMAGE_PIXELS = positive_int('MAX_IMAGE_PIXELS', 25_000_000)
DOCUMENT_TIMEOUT = positive_int('DOCUMENT_TIMEOUT_SECONDS', 150)
PAGE_TIMEOUT = positive_int('PAGE_TIMEOUT_SECONDS', 35)
TESSERACT_LANG = os.getenv('TESSERACT_LANG', 'eng')
GOOGLE_LANGUAGE_HINTS = [s.strip() for s in os.getenv('GOOGLE_LANGUAGE_HINTS', '').split(',') if s.strip()]
PHOTO_PREPROCESSING = os.getenv('PHOTO_PREPROCESSING', 'true').lower() == 'true'
EXTRACT_TABLES = os.getenv('EXTRACT_TABLES', 'true').lower() == 'true'
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
# Native PDF parsing is isolated in a process, also avoiding PDFium thread-safety issues.
PROCESS_SLOTS = threading.BoundedSemaphore(positive_int('MAX_CONCURRENT_DOCUMENTS', 2))
MIME_TYPES = {'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/tiff'}
IMAGE_MIMES = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp', 'TIFF': 'image/tiff'}
app = FastAPI(title='OCR Nexus', version='2.0.0')


class UploadBodyLimit:
    """Bound multipart input before it can fill Starlette's temporary files."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['path'] != '/process':
            return await self.app(scope, receive, send)
        limit = MAX_UPLOAD_BYTES + 65536  # Bounded multipart envelope overhead.
        headers = dict(scope.get('headers', []))
        try:
            length = int(headers.get(b'content-length', b'0'))
        except ValueError:
            return await JSONResponse({'detail': 'Invalid Content-Length.'}, status_code=400)(scope, receive, send)
        if length > limit:
            return await JSONResponse({'detail': 'The uploaded file is too large.'}, status_code=413)(scope, receive, send)
        received = 0
        exceeded = False

        async def limited_receive():
            nonlocal received, exceeded
            message = await receive()
            received += len(message.get('body', b''))
            if received > limit:
                exceeded = True
                # Starlette closes partially spooled files on this exception.
                raise MultiPartException('The uploaded file is too large.')
            return message

        async def limited_send(message):
            if exceeded and message['type'] == 'http.response.start':
                message['status'] = 413
            await send(message)

        await self.app(scope, limited_receive, limited_send)


app.add_middleware(UploadBodyLimit)


class TableCell(BaseModel):
    row: int = Field(ge=0)
    column: int = Field(ge=0)
    row_span: int = Field(default=1, ge=1)
    column_span: int = Field(default=1, ge=1)
    text: str
    confidence: float | None = Field(default=None, ge=0, le=100)
    box: list[int]


class TableResult(BaseModel):
    rows: int
    columns: int
    cells: list[TableCell]
    box: list[int]
    engine: str


class PageResult(BaseModel):
    page: int
    text: str
    confidence: float | None = Field(default=None, ge=0, le=100)
    engine: str
    word_count: int = 0
    tables: list[TableResult] = Field(default_factory=list)
    preprocessing: list[str] = Field(default_factory=list)
    review_notes: list[str] = Field(default_factory=list)


class OCRResponse(BaseModel):
    text: str
    confidence: float | None = Field(default=None, ge=0, le=100)
    pages: int
    provider: str
    page_results: list[PageResult]
    warnings: list[str]


class DocumentError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


@lru_cache(maxsize=1)
def tesseract_languages():
    return set(pytesseract.get_languages(config=''))


@lru_cache(maxsize=1)
def google_client():
    from google.cloud import vision
    return vision.ImageAnnotatorClient()


def check_provider():
    try:
        if PROVIDER == 'google':
            google_client()  # Checks ADC availability; does not make a billed OCR request.
        else:
            missing = set(TESSERACT_LANG.split('+')) - tesseract_languages()
            if missing:
                raise DocumentError(503, 'Required Tesseract language data is not installed: ' + ', '.join(sorted(missing)))
    except DocumentError:
        raise
    except Exception as exc:
        message = ('Google OCR is not configured. Set up Application Default Credentials.'
                   if PROVIDER == 'google' else 'Tesseract is unavailable. Install the Tesseract executable and language data.')
        raise DocumentError(503, message) from exc


@app.get('/health')
def health():
    body = {
        'status': 'ready', 'provider': PROVIDER,
        'processing_location': 'google-cloud' if PROVIDER == 'google' else 'local',
        'max_upload_bytes': MAX_UPLOAD_BYTES, 'max_pages': MAX_PAGES,
        'supported_types': sorted(MIME_TYPES),
        'table_extraction': EXTRACT_TABLES,
    }
    try:
        check_provider()
    except DocumentError as exc:
        return JSONResponse(status_code=503, content={**body, 'status': 'unavailable', 'error': str(exc)})
    return body


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise DocumentError(504, 'Processing took too long. Try fewer pages or a smaller image.')
    return min(PAGE_TIMEOUT, seconds)


def validate_dimensions(width, height):
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise DocumentError(413, f'Each image must contain at most {MAX_IMAGE_PIXELS:,} pixels.')


def prepare_image(image):
    validate_dimensions(*image.size)
    image = ImageOps.exif_transpose(image)
    rgba = image.convert('RGBA')
    background = Image.new('RGBA', rgba.size, 'white')
    return Image.alpha_composite(background, rgba).convert('RGB')


def parse_tesseract(data):
    """Keep detected lines/paragraphs and accept decimal confidence values."""
    paragraphs = []
    lines = []
    words = []
    previous_paragraph = previous_line = None
    confidence_total = weight = 0
    count = 0
    for i, token in enumerate(data['text']):
        token = token.strip()
        confidence = float(data['conf'][i])
        if not token or confidence < 0:
            continue
        paragraph = (data['block_num'][i], data['par_num'][i])
        line = (*paragraph, data['line_num'][i])
        if previous_line is not None and line != previous_line:
            lines.append(' '.join(words))
            words = []
        if previous_paragraph is not None and paragraph != previous_paragraph:
            paragraphs.append('\n'.join(lines))
            lines = []
        words.append(token)
        confidence_total += max(0, min(confidence, 100)) * len(token)
        weight += len(token)
        count += 1
        previous_line, previous_paragraph = line, paragraph
    if words:
        lines.append(' '.join(words))
    if lines:
        paragraphs.append('\n'.join(lines))
    return '\n\n'.join(paragraphs), round(confidence_total / weight, 2) if weight else None, count


def local_ocr(image, deadline):
    check_provider()
    gray = ImageOps.autocontrast(ImageOps.grayscale(image))
    # Correct confident quarter-turn orientation; EXIF was already applied.
    if 'osd' in tesseract_languages():
        try:
            orientation = pytesseract.image_to_osd(gray, output_type=pytesseract.Output.DICT, timeout=remaining(deadline))
            if orientation.get('orientation_conf', 0) >= 10 and orientation.get('rotate'):
                gray = gray.rotate(-orientation['rotate'], expand=True)
        except pytesseract.TesseractError:
            pass  # Sparse/blank pages often contain too few characters for OSD.
    scale = min(2, 2000 / max(gray.width, 1), math.sqrt(MAX_IMAGE_PIXELS / (gray.width * gray.height)))
    if scale > 1:
        gray = gray.resize((int(gray.width * scale), int(gray.height * scale)), Image.Resampling.LANCZOS)
    if PHOTO_PREPROCESSING:
        gray = normalize_lighting(gray)
    tables, rules = detect_tables(gray) if EXTRACT_TABLES else ([], None)
    # Remove only detected table rules from the local OCR input. Keep the original preview.
    if tables:
        cleaned = np.array(gray)
        cleaned[cv2.dilate(rules, np.ones((3, 3), np.uint8)) > 0] = 255
        gray = Image.fromarray(cleaned)
    data = pytesseract.image_to_data(gray, lang=TESSERACT_LANG, config='--oem 3 --psm 3',
                                    output_type=pytesseract.Output.DICT, timeout=remaining(deadline))
    text, confidence, count = parse_tesseract(data)
    if not text:
        # Automatic page segmentation can miss isolated labels or a single line.
        data = pytesseract.image_to_data(gray, lang=TESSERACT_LANG, config='--oem 3 --psm 11',
                                        output_type=pytesseract.Output.DICT, timeout=remaining(deadline))
        text, confidence, count = parse_tesseract(data)
    words = tesseract_words(data)
    # Treat the cropped table as a block so isolated serial numbers are retained.
    # Word coordinates recover its columns. One call per table, never per cell.
    for table in tables:
        left, top, right, bottom = table['box']
        table_data = pytesseract.image_to_data(gray.crop((left, top, right, bottom)), lang=TESSERACT_LANG,
                                              config='--oem 3 --psm 6', output_type=pytesseract.Output.DICT,
                                              timeout=remaining(deadline))
        table_words = tesseract_words(table_data, left, top)
        fill_tables([table], table_words if table_words else words)
    return text, confidence, count, tables


def tesseract_words(data, offset_x=0, offset_y=0):
    words = []
    for index, token in enumerate(data['text']):
        token = token.strip()
        confidence = float(data['conf'][index])
        if not token or confidence < 0:
            continue
        left, top = int(data['left'][index]) + offset_x, int(data['top'][index]) + offset_y
        words.append({'text': token, 'confidence': max(0, min(100, confidence)),
                      'box': [left, top, left + int(data['width'][index]), top + int(data['height'][index])]})
    return words


def google_ocr(image, deadline):
    from google.cloud import vision
    from google.api_core import exceptions as google_errors
    check_provider()
    output = io.BytesIO()
    image.save(output, format='PNG')
    if output.tell() > 18 * 1024 * 1024:
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=95)
    if output.tell() > 18 * 1024 * 1024:
        raise DocumentError(413, 'The image is too large for Google OCR. Reduce its dimensions.')
    try:
        response = google_client().document_text_detection(
            image=vision.Image(content=output.getvalue()),
            image_context=vision.ImageContext(language_hints=GOOGLE_LANGUAGE_HINTS),
            timeout=remaining(deadline), retry=None,
        )
    except google_errors.DeadlineExceeded as exc:
        raise DocumentError(504, 'Google OCR timed out. Please try again.') from exc
    except (google_errors.Unauthenticated, google_errors.PermissionDenied) as exc:
        raise DocumentError(503, 'Google OCR access failed. Check credentials, API access, and billing.') from exc
    except google_errors.ResourceExhausted as exc:
        raise DocumentError(429, 'Google OCR quota is exhausted. Please try again later.') from exc
    except google_errors.GoogleAPICallError as exc:
        raise DocumentError(502, 'Google OCR is temporarily unavailable.') from exc
    if response.error.message:
        raise DocumentError(502, 'Google OCR could not process this page.')
    annotation = response.full_text_annotation
    words = [word for page in annotation.pages for block in page.blocks for paragraph in block.paragraphs for word in paragraph.words]
    weight = sum(len(word.symbols) for word in words)
    confidence = round(sum(word.confidence * len(word.symbols) for word in words) / weight * 100, 2) if weight else None
    tables, _ = detect_tables(normalize_lighting(image)) if EXTRACT_TABLES else ([], None)
    positioned = []
    for word in words:
        vertices = word.bounding_box.vertices
        if len(vertices) < 4:
            continue
        positioned.append({'text': ''.join(symbol.text for symbol in word.symbols),
                           'confidence': max(0, min(100, word.confidence * 100)),
                           'box': [min(vertex.x for vertex in vertices), min(vertex.y for vertex in vertices),
                                   max(vertex.x for vertex in vertices), max(vertex.y for vertex in vertices)]})
    return annotation.text.strip(), confidence, len(words), fill_tables(tables, positioned)


def recognize(image, page_number, deadline):
    remaining(deadline)
    image = prepare_image(image)
    original_size = image.size
    preprocessing = []
    if PHOTO_PREPROCESSING:
        image, preprocessing = correct_photo(image, MAX_IMAGE_PIXELS)
    try:
        text, confidence, count, tables = google_ocr(image, deadline) if PROVIDER == 'google' else local_ocr(image, deadline)
    except pytesseract.TesseractNotFoundError as exc:
        raise DocumentError(503, 'Tesseract is not installed.') from exc
    except pytesseract.TesseractError as exc:
        raise DocumentError(422, 'Tesseract could not read this page. Check the image and language configuration.') from exc
    except RuntimeError as exc:
        raise DocumentError(504, 'OCR timed out. Try a smaller document.') from exc
    notes = []
    if tables:
        notes.append('Review table rows and merged cells against the original. Broken borders may prevent table detection.')
    if min(original_size) < 1500 and count > 100:
        notes.append('Small print may be unreliable at this resolution. Use the original scan or a higher-resolution photo.')
    if PROVIDER == 'tesseract':
        notes.append('Local OCR is intended for printed text. Check handwritten dates and reference numbers manually.')
        if PHOTO_PREPROCESSING:
            preprocessing.append('lighting-normalization')
    return PageResult(page=page_number, text=text, confidence=confidence, engine=PROVIDER, word_count=count,
                      tables=[{**table, 'engine': PROVIDER} for table in tables],
                      preprocessing=preprocessing, review_notes=notes)


def process_pdf(contents, deadline):
    try:
        document = pdfium.PdfDocument(contents)
    except pdfium.PdfiumError as exc:
        raise DocumentError(422, 'The PDF is corrupt or password-protected. Upload an unlocked PDF.') from exc
    results = []
    with document:
        if not 0 < len(document) <= MAX_PAGES:
            raise DocumentError(413, f'Upload a PDF with 1–{MAX_PAGES} pages.')
        for index in range(len(document)):
            remaining(deadline)
            with closing(document[index]) as page:
                with closing(page.get_textpage()) as text_page:
                    text = text_page.get_text_bounded().replace('\r\n', '\n').strip()
                # A page with both text and raster images may contain an unrecognized scan.
                # Render those pages rather than returning only the header or page number.
                has_images = any(page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE], max_depth=10))
                native_text = bool(text and not has_images and '\ufffd' not in text)
                has_rules = EXTRACT_TABLES and any(page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_PATH], max_depth=10))
                if native_text and not has_rules:
                    results.append(PageResult(page=index + 1, text=text, engine='pdf-text', word_count=len(text.split())))
                    continue
                width, height = page.get_size()
                scale = min(300 / 72, math.sqrt(MAX_IMAGE_PIXELS / max(width * height, 1)) * 0.99)
                if width <= 0 or height <= 0 or scale < 0.1:
                    raise DocumentError(413, 'The PDF page dimensions are too large.')
                with closing(page.render(scale=scale)) as bitmap:
                    result = recognize(bitmap.to_pil(), index + 1, deadline)
                    if native_text:
                        result.text, result.confidence, result.engine = text, None, 'pdf-text'
                        result.word_count = len(text.split())
                    results.append(result)
    return results


def process_bytes(contents, content_type, deadline):
    if not contents:
        raise DocumentError(400, 'Upload a non-empty file.')
    if len(contents) > MAX_UPLOAD_BYTES:
        raise DocumentError(413, 'The uploaded file is too large.')
    if content_type not in MIME_TYPES:
        raise DocumentError(415, 'Use a PDF, PNG, JPEG, WebP, or TIFF file.')
    if content_type == 'application/pdf':
        if not contents.startswith(b'%PDF-'):
            raise DocumentError(415, 'The uploaded content is not a PDF.')
        results = process_pdf(contents, deadline)
    else:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(contents)) as image:
                    if IMAGE_MIMES.get(image.format) != content_type:
                        raise DocumentError(415, 'File content does not match its image type.')
                    frames = getattr(image, 'n_frames', 1)
                    if frames > MAX_PAGES:
                        raise DocumentError(413, f'Upload an image with at most {MAX_PAGES} frames.')
                    results = []
                    for index in range(frames):
                        image.seek(index)
                        results.append(recognize(image, index + 1, deadline))
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise DocumentError(413, 'The image dimensions are too large.') from exc
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise DocumentError(422, 'The image is corrupt or cannot be decoded.') from exc
    scored = [page for page in results if page.confidence is not None and page.word_count]
    weight = sum(page.word_count for page in scored)
    confidence = round(sum(page.confidence * page.word_count for page in scored) / weight, 2) if weight else None
    notices = []
    for page in results:
        if not page.text:
            notices.append(f'No text was detected on page {page.page}.')
        elif page.confidence is not None and page.confidence < 75:
            notices.append(f'Page {page.page} has low OCR confidence. Review the extracted text carefully.')
    return OCRResponse(text='\n\n'.join(page.text for page in results), confidence=confidence,
                       pages=len(results), provider=PROVIDER, page_results=results, warnings=notices).model_dump()


def worker(connection, contents, content_type):
    if hasattr(os, 'setsid'):
        os.setsid()  # Include any Tesseract subprocess in timeout cleanup.
    try:
        result = process_bytes(contents, content_type, time.monotonic() + DOCUMENT_TIMEOUT)
        connection.send((200, result))
    except DocumentError as exc:
        connection.send((exc.status, str(exc)))
    except Exception:
        logger.exception('Document processing failed')
        connection.send((500, 'Unable to process this document.'))
    finally:
        connection.close()


def run_isolated(contents, content_type):
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    process = context.Process(target=worker, args=(send, contents, content_type), daemon=True)
    try:
        process.start()
        send.close()
        if not receive.poll(DOCUMENT_TIMEOUT):
            raise DocumentError(504, 'Processing took too long. Try fewer pages or a smaller image.')
        try:
            status, result = receive.recv()
        except EOFError as exc:
            raise DocumentError(422, 'The document could not be decoded.') from exc
        if status != 200:
            raise DocumentError(status, result)
        return result
    finally:
        receive.close()
        send.close()
        if process.pid is not None:
            process.join(timeout=0.2)
            if process.is_alive():
                if os.name == 'nt':
                    # Terminating only the worker would leave its OCR subprocess behind.
                    try:
                        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       timeout=5, check=False, creationflags=subprocess.CREATE_NO_WINDOW)
                    except (OSError, subprocess.TimeoutExpired):
                        logger.warning('Process-tree cleanup failed; terminating the worker directly.')
                if hasattr(os, 'killpg'):
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass  # Worker may not have created its process group yet.
                process.terminate()
                process.join(timeout=1)
            if process.is_alive():
                process.kill()
                process.join()
            process.close()


@app.post('/process', response_model=OCRResponse)
async def process_document(file: UploadFile = File(...)):
    if not PROCESS_SLOTS.acquire(blocking=False):
        await file.close()
        raise HTTPException(429, 'The OCR service is busy. Please try again shortly.')
    try:
        contents = await file.read(MAX_UPLOAD_BYTES + 1)
        if not file.filename or not contents:
            raise DocumentError(400, 'Upload a non-empty file.')
        if len(contents) > MAX_UPLOAD_BYTES:
            raise DocumentError(413, 'The uploaded file is too large.')
        if file.content_type not in MIME_TYPES:
            raise DocumentError(415, 'Use a PDF, PNG, JPEG, WebP, or TIFF file.')
        return await run_in_threadpool(run_isolated, contents, file.content_type)
    except DocumentError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    finally:
        await file.close()
        PROCESS_SLOTS.release()


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host=os.getenv('HOST', '127.0.0.1'), port=positive_int('PORT', 8001))
