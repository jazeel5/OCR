"""Desktop-only service entry: private port, request token, and parent lifecycle."""
import hmac
import json
import logging
import multiprocessing
import os
import socket
import sys
import threading


def windows_job():
    """Keep Python, OCR workers and Tesseract in a kill-on-close Windows job."""
    if os.name != 'nt':
        return None
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [('per_process_time', ctypes.c_int64), ('per_job_time', ctypes.c_int64),
                    ('flags', wintypes.DWORD), ('min_working_set', ctypes.c_size_t),
                    ('max_working_set', ctypes.c_size_t), ('active_process_limit', wintypes.DWORD),
                    ('affinity', ctypes.c_size_t), ('priority_class', wintypes.DWORD),
                    ('scheduling_class', wintypes.DWORD)]

    class IOCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('basic', BasicLimits), ('io', IOCounters), ('process_memory', ctypes.c_size_t),
                    ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t),
                    ('peak_job', ctypes.c_size_t)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    handle = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    return handle  # Owned for this process's lifetime; Windows closes it on exit.


class PrivateService:
    def __init__(self, app, token):
        self.app = app
        self.token = token.encode('ascii')

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http':
            provided = dict(scope.get('headers', [])).get(b'x-ocr-token', b'')
            if not hmac.compare_digest(provided, self.token):
                from starlette.responses import JSONResponse
                return await JSONResponse({'detail': 'Unauthorized'}, status_code=401)(scope, receive, send)
        await self.app(scope, receive, send)


def run():
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')
    import uvicorn
    from main import app

    token = os.environ['OCR_DESKTOP_TOKEN']
    job_handle = windows_job()
    server = uvicorn.Server(uvicorn.Config(PrivateService(app, token), log_level='warning',
                                          access_log=False, timeout_graceful_shutdown=2))

    def watch_parent():
        sys.stdin.buffer.read()  # EOF when Electron exits, including an unexpected crash.
        if job_handle:
            os._exit(0)  # The Windows job also terminates every OCR child.
        server.should_exit = True

    threading.Thread(target=watch_parent, daemon=True).start()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(128)
        print(json.dumps({'event': 'listening', 'port': listener.getsockname()[1]}), flush=True)
        server.run(sockets=[listener])


if __name__ == '__main__':
    multiprocessing.freeze_support()
    run()
