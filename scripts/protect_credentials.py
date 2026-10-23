"""Windows user-scoped DPAPI; secrets travel over stdin/stdout, never argv."""
import ctypes
from ctypes import wintypes
import sys

class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_byte))]

try:
    raw = sys.stdin.buffer.read()
    buf = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    target = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if sys.argv[1] == 'protect':
        ok = crypt.CryptProtectData(ctypes.byref(source), 'Verifica ChatGPT', None, None, None, 1, ctypes.byref(target))
    else:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target))
    if not ok:
        raise RuntimeError('DPAPI failed')
    try:
        sys.stdout.buffer.write(ctypes.string_at(target.data, target.size))
    finally:
        kernel.LocalFree(target.data)
except Exception:
    sys.stderr.write('Não foi possível proteger ou abrir a conexão salva no Windows.')
    sys.exit(1)
