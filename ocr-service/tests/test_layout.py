import io
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from google.cloud import vision
from unittest.mock import Mock

import main
from document_layout import correct_photo, detect_tables, fill_tables, normalize_lighting
from test_ocr import text_pdf


def letter_image():
    image = Image.new('RGB', (1200, 1700), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=25)
    draw.text((80, 80), 'POWER TRANSMISSION - SAMPLE LETTER', font=ImageFont.load_default(size=38), fill='black')
    for index, text in enumerate(['To: The Executive Engineer', 'Subject: Drawing adoption approval',
                                  'Reference: TEST/2026/12345', 'Please review the following materials and drawings.']):
        draw.text((80, 200 + index * 70), text, font=font, fill='black')
    xs, ys = [80, 180, 650, 850, 1120], [1000, 1070, 1140, 1280, 1420, 1560]
    draw.rectangle((xs[0], ys[0], xs[-1], ys[-1]), outline='black', width=3)
    for y in ys[1:-1]:
        draw.line((xs[0], y, xs[-2] if y == 1420 else xs[-1], y), fill='black', width=3)
    draw.line((180, 1000, 180, 1560), fill='black', width=3)
    for x in [650, 850]:
        draw.line((x, 1000, x, 1070), fill='black', width=3)
        draw.line((x, 1140, x, 1560), fill='black', width=3)
    for x, title in zip(xs, ['No.', 'Particulars', 'Drawing', 'Reference']):
        draw.text((x + 15, 1020), title, font=font, fill='black')
    draw.text((195, 1090), 'Cable specifications', font=font, fill='black')
    for y, number, name, code in [(1170, '1', 'Underground cable', 'GTP'), (1310, '2', 'Indoor termination', 'D-101'), (1450, '3', 'Outdoor termination', 'D-102')]:
        draw.text((95, y), number, font=font, fill='black')
        draw.text((195, y), name, font=font, fill='black')
        draw.text((665, y), code, font=font, fill='black')
    draw.text((865, 1170), 'Approved 2025', font=font, fill='black')
    draw.text((865, 1330), 'Letter 12345', font=font, fill='black')
    return image


def photo_image():
    image = np.asarray(letter_image())
    shadow = np.linspace(0.65, 1.0, image.shape[1])[None, :, None]
    image = (image * shadow).astype(np.uint8)
    matrix = cv2.getPerspectiveTransform(np.float32([[0, 0], [1199, 0], [1199, 1699], [0, 1699]]),
                                        np.float32([[120, 80], [1280, 30], [1320, 1790], [65, 1740]]))
    return Image.fromarray(cv2.warpPerspective(image, matrix, (1400, 1850), borderValue=(60, 40, 25)))


def test_detects_merged_columns_and_rows():
    tables, _ = detect_tables(letter_image())
    assert len(tables) == 1
    table = tables[0]
    assert (table['rows'], table['columns']) == (5, 4)
    assert any(cell['column_span'] == 3 and cell['row'] == 1 for cell in table['cells'])
    assert any(cell['row_span'] == 2 and cell['column'] == 3 for cell in table['cells'])


def test_photo_correction_retains_complete_table():
    corrected, changes = correct_photo(photo_image(), 25_000_000)
    assert 'page-perspective' in changes
    tables, _ = detect_tables(normalize_lighting(corrected))
    assert len(tables) == 1
    assert tables[0]['rows'] == 5
    assert tables[0]['columns'] == 4


def test_scan_is_not_cropped_and_blank_images_do_not_create_tables():
    image = letter_image()
    corrected, changes = correct_photo(image, 25_000_000)
    assert corrected.size == image.size
    assert 'page-perspective' not in changes
    tables, _ = detect_tables(Image.new('RGB', (1200, 1700), 'white'))
    assert tables == []


def test_cell_assignment_preserves_multiline_text_and_empty_cells():
    tables, _ = detect_tables(letter_image())
    words = [{'text': 'Outdoor', 'confidence': 90, 'box': [200, 1450, 300, 1475]},
             {'text': 'cable', 'confidence': 80, 'box': [200, 1485, 280, 1510]}]
    fill_tables(tables, words)
    cell = next(cell for cell in tables[0]['cells'] if cell['row'] == 4 and cell['column'] == 1)
    assert cell['text'] == 'Outdoor\ncable'
    assert 80 < cell['confidence'] < 90
    assert any(cell['text'] == '' and cell['confidence'] is None for cell in tables[0]['cells'])


def test_real_local_letter_table_and_photo(monkeypatch):
    monkeypatch.setattr(main, 'PROVIDER', 'tesseract')
    for image in [letter_image(), photo_image()]:
        output = io.BytesIO()
        image.save(output, format='PNG')
        result = main.process_bytes(output.getvalue(), 'image/png', time.monotonic() + 60)
        page = result['page_results'][0]
        assert len(page['tables']) == 1
        table = page['tables'][0]
        assert table['rows'] == 5
        texts = '\n'.join(cell['text'] for cell in table['cells'])
        assert 'Outdoor' in texts
        assert 'Indoor' in texts
        assert '12345' in texts
        serials = [cell['text'] for cell in sorted(table['cells'], key=lambda cell: cell['row'])
                   if cell['column'] == 0 and cell['row'] >= 2]
        assert serials == ['1', '2', '3']
        assert page['review_notes']


def test_google_words_map_into_merged_table(monkeypatch):
    monkeypatch.setattr(main, 'PROVIDER', 'google')
    response = vision.AnnotateImageResponse(full_text_annotation={'text': 'Outdoor', 'pages': [{
        'blocks': [{'paragraphs': [{'words': [{'confidence': 0.92,
            'symbols': [{'text': char} for char in 'Outdoor'],
            'bounding_box': {'vertices': [{'x': 200, 'y': 1450}, {'x': 300, 'y': 1450}, {'x': 300, 'y': 1475}, {'x': 200, 'y': 1475}]}}]}]}]}]})
    client = Mock()
    client.document_text_detection.return_value = response
    monkeypatch.setattr(main, 'google_client', lambda: client)
    page = main.recognize(letter_image(), 1, time.monotonic() + 30)
    table = page.tables[0]
    assert any(cell.row == 4 and cell.column == 1 and cell.text == 'Outdoor' for cell in table.cells)
    assert any(cell.column_span == 3 for cell in table.cells)


def test_table_extraction_can_be_disabled(monkeypatch):
    monkeypatch.setattr(main, 'EXTRACT_TABLES', False)
    monkeypatch.setattr(main, 'PROVIDER', 'tesseract')
    page = main.recognize(letter_image(), 1, time.monotonic() + 30)
    assert page.tables == []


def test_tables_in_native_and_scanned_pdfs(monkeypatch):
    monkeypatch.setattr(main, 'PROVIDER', 'tesseract')
    commands = '1 w 50 30 500 150 re S\n'
    commands += '\n'.join(f'{x} 30 m {x} 180 l S' for x in [150, 350])
    commands += '\n' + '\n'.join(f'50 {y} m 550 {y} l S' for y in [80, 130])
    commands += '\nBT /F1 18 Tf 170 145 Td (Materials) Tj ET'
    commands += '\nBT /F1 18 Tf 170 95 Td (Indoor cable) Tj ET'
    commands += '\nBT /F1 18 Tf 170 45 Td (Outdoor cable) Tj ET'
    result = main.process_bytes(text_pdf(drawing_commands=commands), 'application/pdf', time.monotonic() + 40)
    page = result['page_results'][0]
    assert page['engine'] == 'pdf-text'
    assert page['confidence'] is None
    assert 'Hello native PDF' in page['text']
    assert page['tables'][0]['rows'] == 3
    assert 'Outdoor' in '\n'.join(cell['text'] for cell in page['tables'][0]['cells'])
    scanned = io.BytesIO()
    letter_image().save(scanned, format='PDF', resolution=200)
    result = main.process_bytes(scanned.getvalue(), 'application/pdf', time.monotonic() + 40)
    assert result['page_results'][0]['tables'][0]['rows'] == 5
