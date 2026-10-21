"""Conservative photo correction and ruled-table geometry, independent of OCR engine."""
from __future__ import annotations

import math
import cv2
import numpy as np
from PIL import Image


def _ordered_quad(points):
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    ordered = points[np.argsort(np.arctan2(points[:, 1] - points[:, 1].mean(), points[:, 0] - points[:, 0].mean()))]
    return np.roll(ordered, -np.argmin(ordered.sum(axis=1)), axis=0)


def correct_photo(image, pixel_limit):
    """Crop only a large, bright page against a darker surrounding surface."""
    rgb = np.asarray(image.convert('RGB'))
    height, width = rgb.shape[:2]
    scale = min(1, 1400 / max(height, width))
    small = cv2.resize(rgb, (max(1, round(width * scale)), max(1, round(height * scale))))
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, paper = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(paper, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    changes = []
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(contour)
        if not 0.55 * gray.size < area < 0.98 * gray.size:
            continue
        polygon = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(polygon) != 4 or not cv2.isContourConvex(polygon):
            continue
        quad = _ordered_quad(polygon)
        if (quad[:, 0].min() > gray.shape[1] * 0.22 or quad[:, 0].max() < gray.shape[1] * 0.78
                or quad[:, 1].min() > gray.shape[0] * 0.22 or quad[:, 1].max() < gray.shape[0] * 0.78):
            continue
        mask = np.zeros_like(gray)
        cv2.fillConvexPoly(mask, quad.astype(np.int32), 255)
        inside, outside = gray[mask > 0], gray[mask == 0]
        if not outside.size or np.median(inside) - np.median(outside) < 25:
            continue
        # Include a narrow margin around the detected boundary to protect edge text.
        quad = (quad + (quad - quad.mean(axis=0)) * 0.012) / scale
        top_left, top_right, bottom_right, bottom_left = quad
        out_w = max(np.linalg.norm(top_right - top_left), np.linalg.norm(bottom_right - bottom_left))
        out_h = max(np.linalg.norm(bottom_left - top_left), np.linalg.norm(bottom_right - top_right))
        bound = min(1, math.sqrt(pixel_limit / max(out_w * out_h, 1)))
        out_w, out_h = max(1, int(out_w * bound)), max(1, int(out_h * bound))
        transform = cv2.getPerspectiveTransform(quad, np.float32([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]]))
        rgb = cv2.warpPerspective(rgb, transform, (out_w, out_h), borderValue=(255, 255, 255))
        changes.append('page-perspective')
        break
    # Correct small skew using agreement among long text baselines/table rules.
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    factor = min(1, 1400 / max(gray.shape))
    sample = cv2.resize(gray, (max(1, int(gray.shape[1] * factor)), max(1, int(gray.shape[0] * factor))))
    lines = cv2.HoughLinesP(cv2.Canny(sample, 50, 150), 1, np.pi / 1800, 80,
                            minLineLength=max(80, sample.shape[1] // 5), maxLineGap=20)
    angles = []
    if lines is not None:
        for x1, y1, x2, y2 in lines[:, 0]:
            angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
            if abs(angle) <= 8:
                angles.append(angle)
    if len(angles) >= 4:
        angle = float(np.median(angles))
        if 0.4 <= abs(angle) <= 8 and np.median(np.abs(np.array(angles) - angle)) < 0.8:
            rotated = Image.fromarray(rgb).rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor='white')
            if rotated.width * rotated.height <= pixel_limit:
                rgb = np.asarray(rotated)
                changes.append('deskew')
    return Image.fromarray(rgb), changes


def normalize_lighting(image):
    """Normalize broad illumination variation without deleting grid lines or handwriting."""
    gray = np.asarray(image.convert('L'))
    scale = min(1, 1000 / max(gray.shape))
    small = cv2.resize(gray, (max(1, int(gray.shape[1] * scale)), max(1, int(gray.shape[0] * scale))))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
    background = cv2.morphologyEx(small, cv2.MORPH_CLOSE, kernel)
    background = cv2.GaussianBlur(background, (31, 31), 0)
    background = cv2.resize(background, (gray.shape[1], gray.shape[0]))
    normalized = cv2.divide(gray, np.maximum(background, 1), scale=255)
    return Image.fromarray(normalized)


def _cluster(values, tolerance):
    groups = []
    for value in sorted(values):
        if groups and value - np.mean(groups[-1]) <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [int(round(np.mean(group))) for group in groups]


def detect_tables(image):
    """Find enclosed ruled cells, including rectangular merged cells. Never infer missing text."""
    gray = np.asarray(image.convert('L'))
    height, width = gray.shape
    empty_mask = np.zeros_like(gray)
    if min(height, width) < 100:
        return [], empty_mask
    ink = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 15)
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(30, width // 35), 1)))
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(25, height // 60))))
    grid = cv2.bitwise_or(horizontal, vertical)
    grid = cv2.morphologyEx(grid, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(grid)
    tables = []
    accepted_mask = empty_mask.copy()
    for component in sorted(range(1, component_count), key=lambda index: stats[index, cv2.CC_STAT_TOP]):
        x, y, w, h = map(int, stats[component, :4])
        if w < width * 0.25 or h < 50 or w * h < width * height * 0.012:
            continue
        region = np.where(labels[y:y + h, x:x + w] == component, 255, 0).astype(np.uint8)
        contours, hierarchy = cv2.findContours(region, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        if hierarchy is None:
            continue
        for i, contour in enumerate(contours):
            parent = hierarchy[0][i][3]
            if parent < 0 or hierarchy[0][parent][3] >= 0:
                continue  # Only holes enclosed directly by the outer grid.
            cx, cy, cw, ch = cv2.boundingRect(contour)
            if cw < 12 or ch < 12 or cv2.contourArea(contour) / (cw * ch) < 0.75:
                continue
            boxes.append((x + cx, y + cy, x + cx + cw - 1, y + cy + ch - 1))
        if len(boxes) < 4 or len(boxes) > 500:
            continue
        tolerance = max(4, min(10, width // 250))
        xs = _cluster([value for box in boxes for value in (box[0], box[2])], tolerance)
        ys = _cluster([value for box in boxes for value in (box[1], box[3])], tolerance)
        if not 3 <= len(xs) <= 31 or not 3 <= len(ys) <= 101:
            continue
        cells, occupied = [], set()
        valid = True
        for left, top, right, bottom in sorted(boxes, key=lambda box: (box[1], box[0])):
            col, end_col = [min(range(len(xs)), key=lambda i: abs(xs[i] - value)) for value in (left, right)]
            row, end_row = [min(range(len(ys)), key=lambda i: abs(ys[i] - value)) for value in (top, bottom)]
            if row == end_row or col == end_col:
                valid = False
                break
            positions = {(r, c) for r in range(row, end_row) for c in range(col, end_col)}
            if occupied & positions:
                valid = False
                break
            occupied |= positions
            cells.append({'row': row, 'column': col, 'row_span': end_row - row, 'column_span': end_col - col,
                          'text': '', 'confidence': None, 'box': [left, top, right, bottom]})
        if not valid or len(occupied) != (len(xs) - 1) * (len(ys) - 1):
            continue  # Broken or ambiguous borders: don't invent a rectangular table.
        tables.append({'rows': len(ys) - 1, 'columns': len(xs) - 1, 'cells': cells, 'box': [x, y, x + w, y + h]})
        accepted_mask[y:y + h, x:x + w] = region
        if len(tables) >= 10:
            break
    return tables, accepted_mask


def fill_tables(tables, words):
    """Assign recognized word centres to cells; keep explicit empty cells and spans."""
    for table in tables:
        for cell in table['cells']:
            left, top, right, bottom = cell['box']
            selected = [word for word in words if left <= (word['box'][0] + word['box'][2]) / 2 <= right
                        and top <= (word['box'][1] + word['box'][3]) / 2 <= bottom]
            lines = []
            for word in sorted(selected, key=lambda word: (word['box'][1], word['box'][0])):
                center = (word['box'][1] + word['box'][3]) / 2
                height = max(1, word['box'][3] - word['box'][1])
                match = next((line for line in lines if abs(line['y'] - center) < max(line['height'], height) * 0.55), None)
                if match is None:
                    lines.append({'y': center, 'height': height, 'words': [word]})
                else:
                    match['words'].append(word)
            cell['text'] = '\n'.join(' '.join(word['text'] for word in sorted(line['words'], key=lambda word: word['box'][0]))
                                     for line in sorted(lines, key=lambda line: line['y']))
            scored = [word for word in selected if word.get('confidence') is not None]
            weight = sum(len(word['text']) for word in scored)
            cell['confidence'] = round(sum(word['confidence'] * len(word['text']) for word in scored) / weight, 2) if weight else None
    return tables
