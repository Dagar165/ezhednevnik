# -*- coding: utf-8 -*-
"""
Локальный стенд для проверки ежедневника без Vercel и без квоты Gemini.

Запуск:   python tools/stend.py        (из корня репозитория)
Открыть:  http://127.0.0.1:8000/index.html

Отдаёт приложение как обычный сайт и подменяет /api/note. Режим переключается
на ходу, прямо из браузера:

    fetch('/_mode?m=ok')     - расшифровка «удалась»
    fetch('/_mode?m=fail')   - сервер отвечает отказом 502 с причиной
    fetch('/_mode?m=lag')    - ответ приходит через 8 секунд
    fetch('/_mode?m=dead')   - сервер не отвечает вовсе (70 с)
    fetch('/_hits')          - сколько раз дёрнули функцию

Микрофон подменяется в консоли браузера, см. ПЕРЕДАЧА_НА_АУДИТ_2_УДОБСТВО.md,
раздел «Как проверять, не выкладывая на телефон».
"""

import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODE = {"m": "ok"}
HITS = {"n": 0}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/_mode":
            MODE["m"] = (parse_qs(u.query).get("m") or ["ok"])[0]
            return self._json(200, {"mode": MODE["m"], "hits": HITS["n"]})
        if u.path == "/_hits":
            return self._json(200, {"hits": HITS["n"], "mode": MODE["m"]})
        if u.path == "/api/note":
            return self._json(200, {"ok": True, "models": ["стенд"], "key": True})
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/api/note":
            return self._json(404, {"error": "нет такого"})
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        HITS["n"] += 1
        sys.stderr.write("POST /api/note %d КБ, режим=%s, всего=%d\n"
                         % (len(body) // 1024, MODE["m"], HITS["n"]))
        sys.stderr.flush()

        if MODE["m"] == "fail":
            return self._json(502, {"error": "нейросеть не ответила",
                                    "detail": "стенд: так выглядит отказ"})
        if MODE["m"] == "lag":
            time.sleep(8)
        if MODE["m"] == "dead":
            time.sleep(70)
        return self._json(200, {
            "text": "Позвонить Келеку про 3D-модели",
            "zone": "freelance", "date": None, "understood": True, "note": "",
            "transcript": "Так, надо позвонить Келеку насчёт 3D-моделей, он там ждёт.",
            "elapsed": 1.2,
        })


if __name__ == "__main__":
    print("Стенд на http://127.0.0.1:8000/index.html  (Ctrl+C - стоп)")
    ThreadingHTTPServer(("127.0.0.1", 8000), H).serve_forever()
