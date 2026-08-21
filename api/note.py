# -*- coding: utf-8 -*-
"""
/api/note - расшифровка голосовой заметки для ежедневника.

Вход:  POST, тело - WAV (16 кГц, моно, 16 бит), Content-Type: audio/wav
       ?today=2026-08-21&zones=<urlencoded JSON [{"id":"ddt","name":"ДДТ"},...]>
Выход: JSON {text, zone, date, understood, note, transcript}

Ключ Gemini берётся из переменной окружения GEMINI_API_KEY на Vercel.
В коде ключей нет и быть не должно: репозиторий публичный.
"""

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"

# Имена моделей не зашиты намертво - переименование у Google не должно ломать кнопку.
MODELS = [m.strip() for m in os.environ.get(
    "GEMINI_MODELS", "gemini-flash-latest,gemini-2.0-flash").split(",") if m.strip()]

MAX_BYTES = 4_200_000          # предел тела запроса у Vercel - 4.5 МБ, берём с запасом
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг",
            "пятница", "суббота", "воскресенье"]

ALLOWED_SUFFIXES = ("github.io", "vercel.app")
ALLOWED_EXACT = ("http://localhost:8000", "http://127.0.0.1:8000")

PROMPT = u"""Ты - секретарь занятого руководителя. На вход - его голосовая заметка.
Он говорит длинно, сбивчиво, с отступлениями и матом. Твоя работа - не пересказать, а ЗАПИСАТЬ.

Сегодня {today}, {weekday}.

Его сферы (id - name):
{zones}

Верни СТРОГО JSON с полями:
  "text"       - суть одной строкой, до 90 символов, как задача в ежедневнике.
                 Без вводных, без "нужно", сразу действие. Мат убрать, смысл оставить.
  "zone"       - id сферы из списка выше, или null если из речи это не следует.
  "date"       - YYYY-MM-DD, если дата названа или выводится из "завтра", "в пятницу",
                 "15-го", "на следующей неделе". Иначе null. Прошедших дат не ставить.
  "understood" - true, если ты уверенно понял, ЧТО надо сделать. Иначе false.
  "note"       - если understood=false: чего не хватило, одной короткой фразой. Иначе "".
  "transcript" - полная расшифровка речи как есть, без сокращений.

Правила:
- Не додумывай сферу и дату. Не уверен - null. Тихая ошибка хуже пустого поля.
- Если в заметке несколько дел - в text главное, остальные в конце transcript.
- Если речь неразборчива или это не задача - understood=false, text = короткое описание услышанного.
"""


def _origin_ok(origin):
    if not origin:
        return False
    if origin in ALLOWED_EXACT:
        return True
    try:
        host = urllib.parse.urlparse(origin).hostname or ""
    except Exception:
        return False
    return any(host == s or host.endswith("." + s) for s in ALLOWED_SUFFIXES)


def _ask_gemini(key, audio_b64, prompt):
    """Пробуем модели по очереди. Возвращаем (данные, ошибка)."""
    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"inline_data": {"mime_type": "audio/wav", "data": audio_b64}},
                {"text": prompt},
            ],
        }],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
    }
    body = json.dumps(payload).encode("utf-8")
    last = "нет доступных моделей"

    for model in MODELS:
        req = urllib.request.Request(
            ENDPOINT.format(model) + "?key=" + urllib.parse.quote(key),
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            last = "%s: HTTP %s %s" % (model, e.code, detail)
            continue          # 404 на переименованной модели - пробуем следующую
        except Exception as e:
            last = "%s: %s" % (model, e)
            continue

        try:
            text = raw["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text), None
        except Exception as e:
            last = "%s: не разобрал ответ (%s)" % (model, e)
            continue

    return None, last


class handler(BaseHTTPRequestHandler):

    def _cors(self, origin):
        if _origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _reply(self, code, obj, origin):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors(origin)
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        self.send_response(204)
        self._cors(origin)
        self.end_headers()

    def do_POST(self):
        origin = self.headers.get("Origin", "")
        if origin and not _origin_ok(origin):
            return self._reply(403, {"error": "чужой origin"}, origin)

        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not key:
            return self._reply(500, {"error": "GEMINI_API_KEY не задан в настройках Vercel"}, origin)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self._reply(400, {"error": "пустая запись"}, origin)
        if length > MAX_BYTES:
            return self._reply(413, {"error": "запись длиннее двух минут - скажи короче"}, origin)

        audio = self.rfile.read(length)

        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        today = (q.get("today") or [""])[0]
        try:
            d = datetime.strptime(today, "%Y-%m-%d").date()
        except ValueError:
            d = date.today()

        try:
            zones = json.loads((q.get("zones") or ["[]"])[0])
        except Exception:
            zones = []
        zone_ids = set(z.get("id") for z in zones if isinstance(z, dict))
        zones_txt = "\n".join(
            "  %s - %s" % (z.get("id", "?"), z.get("name", "?"))
            for z in zones if isinstance(z, dict)
        ) or "  (сферы не переданы)"

        prompt = PROMPT.format(today=d.isoformat(), weekday=WEEKDAYS[d.weekday()], zones=zones_txt)

        data, err = _ask_gemini(key, base64.b64encode(audio).decode("ascii"), prompt)
        if data is None:
            return self._reply(502, {"error": "нейросеть не ответила", "detail": err}, origin)

        zone = data.get("zone")
        if zone not in zone_ids:          # выдуманная сфера приравнивается к "не понял"
            zone = None

        note_date = data.get("date")
        if note_date:
            try:
                nd = datetime.strptime(str(note_date), "%Y-%m-%d").date()
                note_date = nd.isoformat() if nd >= d else None
            except ValueError:
                note_date = None

        return self._reply(200, {
            "text": (data.get("text") or "").strip()[:200],
            "zone": zone,
            "date": note_date,
            "understood": bool(data.get("understood")),
            "note": (data.get("note") or "").strip()[:200],
            "transcript": (data.get("transcript") or "").strip(),
        }, origin)
