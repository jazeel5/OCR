import io
import multiprocessing
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont
import pypdfium2 as pdfium

import main


def text_pdf(text='Hello native PDF', drawing_commands=''):
    stream = f'BT /F1 24 Tf 50 200 Td ({text}) Tj ET\n{drawing_commands}'.encode()
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    result = b'%PDF-1.4\n'
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
    xref = len(result)
    result += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets)
    return result + f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode()


def scan_image():
    image = Image.new('RGB', (1400, 500), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=50)
    draw.text((70, 80), 'INVOICE 12345', font=font, fill='black')
    draw.text((70, 180), 'Total amount 250.00', font=font, fill='black')
    return image


def image_bytes(image=None, format='PNG', **options):
    output = io.BytesIO()
    (image or scan_image()).save(output, format=format, **options)
    return output.getvalue()


def process(contents, mime):
    return main.process_bytes(contents, mime, time.monotonic() + 40)


@pytest.fixture(autouse=True)
def local_provider(monkeypatch):
    monkeypatch.setattr(main, 'PROVIDER', 'tesseract')


def test_decimal_confidence_and_layout():
    data = {'text': ['Hello', 'world', 'Next', 'Paragraph', ''], 'conf': ['96.7', '90.2', '80.0', '75.5', '-1'],
            'block_num': [1, 1, 1, 2, 2], 'par_num': [1, 1, 1, 1, 1], 'line_num': [1, 1, 2, 1, 1]}
    text, confidence, count = main.parse_tesseract(data)
    assert text == 'Hello world\nNext\n\nParagraph'
    assert 75 < confidence < 97
    assert count == 4


def test_native_pdf_skips_ocr(monkeypatch):
    monkeypatch.setattr(main, 'recognize', Mock(side_effect=AssertionError('Native text must not be OCRed')))
    result = process(text_pdf(), 'application/pdf')
    assert result['text'] == 'Hello native PDF'
    assert result['confidence'] is None
    assert result['page_results'][0]['engine'] == 'pdf-text'


def test_real_image_ocr_preserves_lines():
    result = process(image_bytes(), 'image/png')
    assert '12345' in result['text']
    assert '250.00' in result['text']
    assert '\n' in result['text']
    assert result['confidence'] > 75


def test_real_mixed_pdf():
    with pdfium.PdfDocument.new() as combined, pdfium.PdfDocument(text_pdf()) as native, pdfium.PdfDocument(image_bytes(format='PDF')) as scanned:
        combined.import_pages(native)
        combined.import_pages(scanned)
        output = io.BytesIO()
        combined.save(output)
    result = process(output.getvalue(), 'application/pdf')
    assert result['pages'] == 2
    assert [p['engine'] for p in result['page_results']] == ['pdf-text', 'tesseract']
    assert '250.00' in result['page_results'][1]['text']


def test_multi_frame_tiff(monkeypatch):
    monkeypatch.setattr(main, 'recognize', lambda image, page, deadline: main.PageResult(page=page, text=f'Page {page}', engine='tesseract'))
    result = process(image_bytes(format='TIFF', save_all=True, append_images=[scan_image()]), 'image/tiff')
    assert result['pages'] == 2
    assert result['text'] == 'Page 1\n\nPage 2'


@pytest.mark.parametrize('contents,mime,status', [(b'', 'image/png', 400), (b'html', 'text/html', 415),
    (b'not pdf', 'application/pdf', 415), (b'%PDF-1.4 corrupt', 'application/pdf', 422),
    (b'not image', 'image/png', 422)])
def test_invalid_documents(contents, mime, status):
    with pytest.raises(main.DocumentError) as error:
        process(contents, mime)
    assert error.value.status == status


def test_content_type_mismatch():
    with pytest.raises(main.DocumentError) as error:
        process(image_bytes(), 'image/jpeg')
    assert error.value.status == 415


def test_limits(monkeypatch):
    monkeypatch.setattr(main, 'MAX_UPLOAD_BYTES', 5)
    with pytest.raises(main.DocumentError) as error:
        process(b'123456', 'image/png')
    assert error.value.status == 413
    monkeypatch.setattr(main, 'MAX_IMAGE_PIXELS', 10)
    with pytest.raises(main.DocumentError) as error:
        main.validate_dimensions(100, 100)
    assert error.value.status == 413


def test_pdf_page_limit(monkeypatch):
    monkeypatch.setattr(main, 'MAX_PAGES', 1)
    with pdfium.PdfDocument.new() as doc, pdfium.PdfDocument(text_pdf()) as native:
        doc.import_pages(native)
        doc.import_pages(native)
        output = io.BytesIO()
        doc.save(output)
    with pytest.raises(main.DocumentError) as error:
        process(output.getvalue(), 'application/pdf')
    assert error.value.status == 413


def test_blank_image():
    result = process(image_bytes(Image.new('RGB', (400, 400), 'white')), 'image/png')
    assert result['text'] == ''
    assert result['confidence'] is None
    assert result['warnings'] == ['No text was detected on page 1.']


def test_google_document_detection(monkeypatch):
    from google.cloud import vision
    monkeypatch.setattr(main, 'PROVIDER', 'google')
    response = vision.AnnotateImageResponse(full_text_annotation={'text': 'Hello\nworld', 'pages': [{
        'blocks': [{'paragraphs': [{'words': [{'confidence': 0.9, 'symbols': [{'text': 'H'}]}]}]}]}]})
    client = Mock()
    client.document_text_detection.return_value = response
    monkeypatch.setattr(main, 'google_client', lambda: client)
    result = process(image_bytes(), 'image/png')
    assert result['text'] == 'Hello\nworld'
    assert result['page_results'][0]['engine'] == 'google'
    assert result['confidence'] == 90
    request = client.document_text_detection.call_args.kwargs
    assert request['image'].content.startswith(b'\x89PNG')
    assert request['retry'] is None
    assert request['timeout'] <= main.PAGE_TIMEOUT


@pytest.mark.parametrize('exception,status', [('PermissionDenied', 503), ('ResourceExhausted', 429), ('DeadlineExceeded', 504), ('ServiceUnavailable', 502)])
def test_google_errors(monkeypatch, exception, status):
    from google.api_core import exceptions
    monkeypatch.setattr(main, 'PROVIDER', 'google')
    client = Mock()
    client.document_text_detection.side_effect = getattr(exceptions, exception)('private internal details')
    monkeypatch.setattr(main, 'google_client', lambda: client)
    with pytest.raises(main.DocumentError) as error:
        process(image_bytes(), 'image/png')
    assert error.value.status == status
    assert 'private' not in str(error.value)


def test_google_response_error(monkeypatch):
    monkeypatch.setattr(main, 'PROVIDER', 'google')
    client = Mock()
    client.document_text_detection.return_value = SimpleNamespace(error=SimpleNamespace(message='internal secret'))
    monkeypatch.setattr(main, 'google_client', lambda: client)
    with pytest.raises(main.DocumentError) as error:
        process(image_bytes(), 'image/png')
    assert error.value.status == 502


def test_api_real_worker_and_health():
    with TestClient(main.app) as client:
        assert client.get('/health').status_code == 200
        response = client.post('/process', files={'file': ('sample.pdf', text_pdf(), 'application/pdf')})
    assert response.status_code == 200, response.text
    assert response.json()['text'] == 'Hello native PDF'


def test_api_limits_and_busy(monkeypatch):
    with TestClient(main.app) as client:
        assert client.post('/process').status_code == 422
        assert client.post('/process', files={'file': ('blank.png', b'', 'image/png')}).status_code == 400
        monkeypatch.setattr(main, 'MAX_UPLOAD_BYTES', 5)
        assert client.post('/process', files={'file': ('large.png', b'123456', 'image/png')}).status_code == 413
        assert client.post('/process', content=b'x' * 70000, headers={'Content-Type': 'multipart/form-data; boundary=x'}).status_code == 413
        monkeypatch.setattr(main, 'PROCESS_SLOTS', SimpleNamespace(acquire=lambda **kwargs: False))
        assert client.post('/process', files={'file': ('a.png', b'123', 'image/png')}).status_code == 429


def test_chunked_upload_limit(monkeypatch):
    monkeypatch.setattr(main, 'MAX_UPLOAD_BYTES', 5)
    def body():
        yield b'--test\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'
        yield b'x' * 70000
        yield b'\r\n--test--\r\n'
    with TestClient(main.app) as client:
        response = client.post('/process', content=body(), headers={'Content-Type': 'multipart/form-data; boundary=test'})
    assert response.status_code == 413


def test_hard_timeout_cleans_up_process(monkeypatch):
    monkeypatch.setattr(main, 'DOCUMENT_TIMEOUT', 0.001)
    before = {p.pid for p in multiprocessing.active_children()}
    with pytest.raises(main.DocumentError) as error:
        main.run_isolated(text_pdf(), 'application/pdf')
    assert error.value.status == 504
    assert {p.pid for p in multiprocessing.active_children()} == before
