"""Long-lived local transcription worker. Only short PCM blocks cross stdin."""
import os
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
import base64
import json
import sys
import time

def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

try:
    import numpy as np
    from faster_whisper import WhisperModel
    model_name = os.environ.get('LOCAL_ASR_MODEL', 'small')
    started = time.perf_counter()
    model = WhisperModel(model_name, device='cpu', compute_type='int8', cpu_threads=min(4, max(1, (os.cpu_count() or 2) // 2)), num_workers=1)
    emit({'type': 'ready', 'model': model_name, 'device': 'cpu', 'loadSeconds': round(time.perf_counter()-started, 3)})
except Exception:
    emit({'type': 'startup_error', 'error': 'Não foi possível carregar a transcrição local. Verifique faster-whisper e os arquivos do modelo.'})
    sys.exit(1)

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        raw = base64.b64decode(request['audio'], validate=True)
        if len(raw) > 16 * 32000 or len(raw) % 2:
            raise ValueError('invalid block')
        audio = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
        started = time.perf_counter()
        segments, info = model.transcribe(audio, language='pt', task='transcribe', beam_size=5,
            condition_on_previous_text=False, vad_filter=True, vad_parameters={'min_silence_duration_ms': 350},
            no_speech_threshold=0.6, temperature=(0.0, 0.2, 0.4, 0.6))
        text = ' '.join(s.text.strip() for s in segments).strip()
        emit({'type': 'transcript', 'id': request['id'], 'text': text, 'audioSeconds': len(audio)/16000,
              'processingSeconds': round(time.perf_counter()-started, 3)})
    except Exception:
        emit({'type': 'error', 'id': request.get('id') if isinstance(request, dict) else None,
              'error': 'Não foi possível transcrever este bloco de áudio localmente.'})
