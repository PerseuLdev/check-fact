"""Resolve a public YouTube URL. Media addresses stay inside the backend."""
import json
import sys
from yt_dlp import YoutubeDL

class Quiet:
    def debug(self, *_): pass
    def warning(self, *_): pass
    def error(self, *_): pass

try:
    with YoutubeDL({
        'quiet': True, 'no_warnings': True, 'logger': Quiet(),
        'noplaylist': True, 'skip_download': True,
        'format': 'bestaudio[protocol=https]/bestaudio',
        'js_runtimes': {'node': {}}, 'socket_timeout': 20,
    }) as ydl:
        info = ydl.extract_info(sys.argv[1], download=False)
        print(json.dumps({
            'id': info['id'], 'title': info.get('title'),
            'channel': info.get('channel'), 'duration': info.get('duration'),
            'isLive': bool(info.get('is_live')), 'uploadDate': info.get('upload_date'),
            'mediaUrl': info['url'], 'headers': info.get('http_headers', {}),
        }, ensure_ascii=True), flush=True)
except Exception:
    print(json.dumps({'error': 'Não foi possível ler o áudio desta URL. A plataforma pode estar bloqueando o acesso ou exigindo autenticação.'}, ensure_ascii=True))
    sys.exit(1)
