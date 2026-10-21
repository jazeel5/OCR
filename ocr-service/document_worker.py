"""One document per process, using standard pipes on embedded Windows Python."""
import json
import logging
import sys
import time

from main import DocumentError, DOCUMENT_TIMEOUT, MAX_UPLOAD_BYTES, process_bytes


def run():
    try:
        contents = sys.stdin.buffer.read(MAX_UPLOAD_BYTES + 1)
        result = process_bytes(contents, sys.argv[1], time.monotonic() + DOCUMENT_TIMEOUT)
        response = [200, result]
    except DocumentError as exc:
        response = [exc.status, str(exc)]
    except Exception:
        logging.exception('Document worker failed')
        response = [500, 'Unable to process this document.']
    sys.stdout.buffer.write(json.dumps(response, ensure_ascii=False).encode('utf-8'))
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    run()
