"""Assemble Windows x64 OCR dependencies without executing Windows installers.

Uses hash-pinned upstream archives and wheels. Run with Python 3.14 on macOS or
Windows; Windows build hosts need 7-Zip (included on GitHub's Windows runners).
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import shutil
import ssl
import struct
import subprocess
import sys
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / 'desktop'
CACHE = DESKTOP / '.cache'
OUTPUT = DESKTOP / 'vendor/windows-x64'
try:
    import certifi
    TLS = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    TLS = ssl.create_default_context()


def download(item, directory=CACHE):
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / item['file']
    if not target.exists():
        print(f"Downloading {item['file']}", flush=True)
        partial = target.with_suffix(target.suffix + '.partial')
        with urllib.request.urlopen(item['url'], timeout=120, context=TLS) as source, partial.open('wb') as dest:
            shutil.copyfileobj(source, dest)
        partial.replace(target)
    with target.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != item['sha256']:
        raise RuntimeError(f'Checksum mismatch: {target}. Remove it and retry; do not bypass verification.')
    return target


def seven_zip():
    if sys.platform == 'darwin':
        archive = download({'file': '7z2605-mac.tar.xz',
            'url': 'https://github.com/ip7z/7zip/releases/download/26.05/7z2605-mac.tar.xz',
            'sha256': '12ef6830317743cfd3f0ab1724bde43fcc270d8b6d8564f8c12c2a2b7f993570'})
        location = CACHE / '7zip'
        with tarfile.open(archive) as source:
            source.extractall(location, filter='data')
        return str(location / '7zz')
    for candidate in [os.getenv('SEVEN_ZIP'), shutil.which('7z'), shutil.which('7zz'),
                      r'C:\Program Files\7-Zip\7z.exe']:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError('Install 7-Zip on the build computer, or set SEVEN_ZIP to its 7z executable.')


def extract(tool, archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    subprocess.run([tool, 'x', '-y', f'-o{destination}', str(archive)], check=True, stdout=subprocess.DEVNULL)


def safe_extract_zip(archive, destination, wheel=False):
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            parts = PurePosixPath(item.filename).parts
            if not parts or item.is_dir():
                continue
            if '..' in parts or PurePosixPath(item.filename).is_absolute() or '\\' in item.filename:
                raise ValueError(f'Unsafe archive entry: {item.filename}')
            if wheel and parts[0].endswith('.data'):
                if parts[1] not in {'purelib', 'platlib'}:
                    continue  # Console entry points are not used by the application.
                parts = parts[2:]
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as src, target.open('wb') as dst:
                shutil.copyfileobj(src, dst)


def vendor_msvc(tool, source, python_dir):
    # WiX Burn embeds a bootstrap cabinet and a payload cabinet. Identify both
    # via the CAB header, rather than executing the downloaded redistributable.
    data = source.read_bytes()
    cabinets = []
    offset = 0
    while (offset := data.find(b'MSCF\x00\x00\x00\x00', offset)) >= 0:
        size = struct.unpack_from('<I', data, offset + 8)[0]
        if 36 <= size <= len(data) - offset:
            cabinet = CACHE / f'vc-{offset}.cab'
            cabinet.write_bytes(data[offset:offset + size])
            cabinets.append(cabinet)
        offset += 8
    if len(cabinets) != 2:
        raise RuntimeError('Unexpected Microsoft redistributable layout')
    bootstrap, payload, dlls = [CACHE / name for name in ['vc-bootstrap', 'vc-files', 'vc-dlls']]
    extract(tool, cabinets[0], bootstrap)
    extract(tool, cabinets[1], payload)
    manifest = ET.fromstring((bootstrap / '0').read_bytes())
    files = {entry.get('FilePath'): entry.get('SourcePath') for entry in manifest.iter() if entry.get('SourcePath')}
    minimum = files[r'packages\vcRuntimeMinimum_amd64\cab1.cab']
    extract(tool, payload / minimum, dlls)
    for dll in dlls.glob('*.dll_amd64'):
        # Keep the newer runtime already supplied by Python, if present.
        target = python_dir / dll.name.removesuffix('_amd64')
        if not target.exists():
            shutil.copy2(dll, target)
    shutil.copy2(bootstrap / files['license.rtf'], python_dir / 'MICROSOFT-VC-LICENSE.rtf')


def main():
    assets = json.loads((DESKTOP / 'windows-assets.json').read_text())
    wheels = json.loads((DESKTOP / 'windows-wheels.lock.json').read_text())
    # Refuse a stale platform lock when common runtime dependencies change.
    required = {line.strip().lower().replace('_', '-') for line in
                (ROOT / 'ocr-service/requirements.lock.txt').read_text().splitlines()
                if line.strip() and not line.startswith('#')}
    locked = {f"{item['name']}=={item['version']}" for item in wheels}
    if required | {'colorama==0.4.6'} != locked:
        raise RuntimeError('Refresh windows-wheels.lock.json for the changed Python dependencies.')
    sources = {item['file']: download(item) for item in assets}
    wheel_paths = [download(item, CACHE / 'wheels') for item in wheels]
    tool = seven_zip()
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    python_dir = OUTPUT / 'python'
    safe_extract_zip(sources['python-3.14.9-embed-amd64.zip'], python_dir)
    packages = python_dir / 'Lib/site-packages'
    for wheel in wheel_paths:
        safe_extract_zip(wheel, packages, wheel=True)
    (python_dir / 'python314._pth').write_text(
        'python314.zip\n.\nLib/site-packages\n../ocr-service\nimport site\n', encoding='utf-8')
    # _pth isolation is inherited by multiprocessing; both the app and native
    # libraries remain independent of PATH and any user-installed Python.
    vendor_msvc(tool, sources['vc_redist.x64.exe'], python_dir)
    extracted = CACHE / 'tesseract-extracted'
    extract(tool, sources['tesseract-ocr-w64-setup-5.5.3.20260724.exe'], extracted)
    tesseract = OUTPUT / 'tesseract'
    tesseract.mkdir()
    for filename in ['tesseract.exe', *[p.name for p in extracted.glob('*.dll')]]:
        shutil.copy2(extracted / filename, tesseract / filename)
    for directory in ['doc', 'tessdata/configs', 'tessdata/tessconfigs']:
        shutil.copytree(extracted / directory, tesseract / directory)
    for lang in ['eng', 'kan', 'osd']:
        shutil.copy2(sources[f'{lang}.traineddata'], tesseract / f'tessdata/{lang}.traineddata')
    (OUTPUT / 'runtime-manifest.json').write_text(json.dumps({'platform': 'windows-x64',
        'python': '3.14.9', 'tesseract': '5.5.3.20260724', 'assets': assets, 'wheels': wheels}, indent=2) + '\n')
    print(f'Windows OCR runtime ready: {OUTPUT}', flush=True)


if __name__ == '__main__':
    main()
