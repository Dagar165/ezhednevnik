# -*- coding: utf-8 -*-
"""
/api/note - расшифровка голосовой заметки для ежедневника.

Вход:  POST, тело - WAV (16 кГц, моно, 16 бит), Content-Type: audio/wav
       ?today=2026-08-21&zones=<urlencoded JSON [{"id":"ddt","name":"ДДТ"},...]>
Выход: JSON {text, zone, date, understood, note, transcript}
Проверка живости: GET ?ping=1 -> {ok, models, key, budget} (нейросеть не дёргается).

Ключ Gemini берётся из переменной окружения GEMINI_API_KEY на Vercel.
В коде ключей нет и быть не должно: репозиторий публичный.

Главное правило этого файла: уложиться в отведённое Vercel время САМИМ.
Если функцию убивает платформа, клиент получает пустоту без причины, и
разбираться потом не с чем. Поэтому здесь есть общий бюджет времени и
подробный лог в stdout (Vercel -> Logs).
"""

import base64
import fnmatch
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"

# Имена моделей не зашиты намертво - переименование у Google не должно ломать кнопку.
# ВНИМАНИЕ: "...-latest" - скользящий псевдоним. Google может перевести его на
# модель с включённым «думанием» (thinking), и тогда ответ начинает приходить
# в два-три раза дольше, а иногда обрывается на MAX_TOKENS. Настоящее имя
# модели пишется в лог полем modelVersion - смотри его, прежде чем гадать.
MODELS = [m.strip() for m in os.environ.get(
    "GEMINI_MODELS", "gemini-flash-latest,gemini-2.0-flash").split(",") if m.strip()]

MAX_BYTES = 4_200_000          # предел тела запроса у Vercel - 4.5 МБ, берём с запасом

# Бюджет времени. В vercel.json maxDuration=60; платформа убивает функцию молча,
# поэтому сдаёмся сами на 50-й секунде и объясняем причину.
BUDGET_SEC = float(os.environ.get("NOTE_BUDGET_SEC", "50"))
ATTEMPT_SEC = float(os.environ.get("NOTE_ATTEMPT_SEC", "24"))
MIN_ATTEMPT_SEC = 6.0

WEEKDAYS = ["понедельник", "вторник", "среда", "четверг",
            "пятница", "суббота", "воскресенье"]

# Кто имеет право дёргать функцию. По умолчанию - только страницы владельца.
# Раньше сюда пускало любой *.github.io и любой *.vercel.app: чужая страница
# могла бесплатно жечь квоту Gemini, а кончившаяся квота выглядит для владельца
# как «нейросеть не ответила».
DEFAULT_ORIGINS = "dagar165.github.io,*ezhednevnik*.vercel.app,localhost:8000,127.0.0.1:8000"
ORIGIN_RULES = [r.strip().lower() for r in os.environ.get(
    "ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",") if r.strip()]

PROMPT = u"""Ты - секретарь занятого руководителя. На вход - его голосовая заметка.
Он говорит длинно, сбивчиво, с отступлениями и матом. Твоя работа - не пересказать, а ЗАПИСАТЬ.

Сегодня {today}, {weekday}.

Его сферы (id - name):
{zones}

Порядок работы жёсткий: СНАЧАЛА дословно запиши всё сказанное, и только потом
выводи остальные поля ИЗ ЗАПИСАННОГО, а не из памяти о звуке.

Верни СТРОГО JSON, поля именно в этом порядке:
  "transcript" - полная расшифровка речи как есть, без сокращений и приглаживания.
                 Русский язык. Имена и названия писать как слышится, не подменять
                 похожими словами.
  "text"       - суть одной строкой, до 90 символов, как задача в ежедневнике.
                 Без вводных, без "нужно", сразу действие. Мат убрать, смысл оставить.
  "zone"       - id сферы из списка выше, или null если из речи это не следует.
  "date"       - YYYY-MM-DD, если дата названа или выводится из "завтра", "в пятницу",
                 "15-го", "на следующей неделе". Иначе null. Прошедших дат не ставить.
  "understood" - true, если ты уверенно понял, ЧТО надо сделать. Иначе false.
  "note"       - если understood=false: чего не хватило, одной короткой фразой. Иначе "".

Правила:
- Не додумывай сферу и дату. Не уверен - null. Тихая ошибка хуже пустого поля.
- Если в заметке несколько дел - в text главное, остальные в конце transcript.
- Если речь неразборчива или это не задача - understood=false, text = короткое описание услышанного.
"""

# Схема ответа. С ней модель физически не может вернуть «почти JSON»,
# а propertyOrdering закрепляет порядок: сначала расшифровка, потом выводы из неё.
SCHEMA = {
    "type": "object",
    "properties": {
        "transcript": {"type": "string"},
        "text": {"type": "string"},
        "zone": {"type": "string", "nullable": True},
        "date": {"type": "string", "nullable": True},
        "understood": {"type": "boolean"},
        "note": {"type": "string"},
    },
    "required": ["transcript", "text", "understood", "note"],
    "propertyOrdering": ["transcript", "text", "zone", "date", "understood", "note"],
}

# Настройки запроса по убыванию желательности. Если модель ругается на поле
# (HTTP 400), пробуем следующий вариант, а не сдаёмся. Так переезд Google с
# thinkingBudget на thinkingLevel не превращается в «кнопка перестала работать».
# Лестница ровно из трёх ступеней, сверху вниз - от быстрого к безотказному.
# Модель, которая не умеет отвечать с выключенным думанием, молчит СКОЛЬКО
# УГОДНО раз подряд, поэтому пустой ответ - повод шагнуть вниз, а не повторить.
VARIANTS = [
    ("схема + думание выключено", {"responseSchema": SCHEMA,
                                   "thinkingConfig": {"thinkingBudget": 0}}),
    ("схема, думание своё", {"responseSchema": SCHEMA}),
    ("голый запрос", {}),
]

# Какой вариант сработал для какой модели - помним, пока живёт контейнер.
# Экономит два-три отказа 400 на каждом последующем запросе.
_GOOD_VARIANT = {}

# Коды, после которых имеет смысл повторить тот же запрос: перегрузка на
# стороне Google, а не наша ошибка. 429 сюда НЕ входит: кончившаяся квота
# за полторы секунды не появляется, разумнее сразу идти к другой модели.
RETRIABLE = (500, 502, 503, 504)


def log(*parts):
    """Строка в Vercel -> Logs. Без неё отказы неразличимы между собой."""
    try:
        sys.stdout.write("[note] " + " ".join(str(p) for p in parts) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _origin_ok(origin):
    """Правило сравнивается с host и с host:port, без схемы. Звёздочка разрешена."""
    if not origin:
        return False
    try:
        u = urllib.parse.urlparse(origin)
        host = (u.hostname or "").lower()
        if not host:
            return False
        cands = [host] + ([host + ":" + str(u.port)] if u.port else [])
    except Exception:
        return False
    return any(fnmatch.fnmatchcase(c, rule)
               for c in cands for rule in ORIGIN_RULES)


def _texts(cand):
    """Текст ответа. Части с thought=true - это размышления модели, не ответ.
    Раньше читалась только parts[0]; у думающей модели там лежит именно она,
    и хороший ответ объявлялся «не разобрался как JSON»."""
    parts = ((cand.get("content") or {}).get("parts")) or []
    out = []
    for p in parts:
        if p.get("thought"):
            continue
        t = p.get("text")
        if t:
            out.append(t)
    return "".join(out)


def _loads(txt):
    """JSON из ответа модели. Иногда приезжает в ```json ... ``` - снимаем."""
    s = (txt or "").strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else ""
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    s = s.strip()
    if not s:
        raise ValueError("пусто")
    return json.loads(s)


def _extract(raw):
    """Достаём JSON из ответа. Возвращаем (данные, причина отказа)."""
    fb = raw.get("promptFeedback") or {}
    if fb.get("blockReason"):
        return None, "запись отклонена фильтром (%s)" % fb["blockReason"]

    cands = raw.get("candidates") or []
    if not cands:
        return None, "модель не вернула ответ"

    cand = cands[0]
    txt = _texts(cand)
    if not txt:
        # MAX_TOKENS, SAFETY, RECITATION - ответа нет, но причина известна.
        return None, "ответ пустой (%s)" % cand.get("finishReason", "без причины")

    try:
        return _loads(txt), None
    except Exception:
        return None, "ответ не разобрался как JSON"


def _body(audio_b64, prompt, extra_cfg):
    cfg = {"responseMimeType": "application/json",
           "temperature": 0.2,
           "maxOutputTokens": 4096}
    cfg.update(extra_cfg)
    return json.dumps({
        "contents": [{
            "role": "user",
            "parts": [
                {"inline_data": {"mime_type": "audio/wav", "data": audio_b64}},
                {"text": prompt},
            ],
        }],
        "generationConfig": cfg,
    }).encode("utf-8")


def _call(key, model, body, timeout):
    """Один запрос к одной модели.
    Возвращаем (данные, причина, что_делать): 'retry' | 'variant' | 'model' | ''."""
    req = urllib.request.Request(
        ENDPOINT.format(model) + "?key=" + urllib.parse.quote(key),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        log("HTTP", e.code, model, "%.1fс" % (time.time() - t), detail.replace("\n", " "))
        if e.code == 400:
            return None, "%s: HTTP 400 %s" % (model, detail), "variant"
        if e.code == 429:
            return None, "%s: квота исчерпана (429)" % model, "model"
        return None, "%s: HTTP %s %s" % (model, e.code, detail), \
            "retry" if e.code in RETRIABLE else "model"
    except Exception as e:
        log("СЕТЬ", model, "%.1fс" % (time.time() - t), repr(e))
        return None, "%s: %s" % (model, e), "retry"

    took = time.time() - t
    usage = raw.get("usageMetadata") or {}
    log("ответ", model, "->", raw.get("modelVersion", "?"), "%.1fс" % took,
        "вход=%s выход=%s думание=%s" % (usage.get("promptTokenCount", "?"),
                                         usage.get("candidatesTokenCount", "?"),
                                         usage.get("thoughtsTokenCount", 0)),
        "finish=%s" % (((raw.get("candidates") or [{}])[0]).get("finishReason", "?")))

    data, why = _extract(raw)
    if data is not None:
        return data, None, ""
    if "фильтр" in why:
        return None, "%s: %s" % (model, why), "model"
    # Модель ответила, но не тем. Повторять ту же настройку смысла мало -
    # спускаемся на ступень ниже.
    return None, "%s: %s" % (model, why), "simplify"


def _ask_gemini(key, audio_b64, prompt, deadline):
    """Модели по очереди. Всё - в общий бюджет времени: лучше честный отказ
    на 50-й секунде, чем убитая платформой функция без ответа.

    Пустой ответ два раза подряд - повод упростить запрос, а не долбить ту же
    настройку. Модель, которая не умеет отвечать с выключенным думанием, будет
    молчать сколько угодно раз; следующий вариант её оживляет."""
    last = "нет доступных моделей"

    for model in MODELS:
        vi = _GOOD_VARIANT.get(model, 0)
        heavy = 0            # попытки, которые реально стоили времени (400 не в счёт)
        retried = False
        while vi < len(VARIANTS) and heavy < len(VARIANTS):
            left = deadline - time.time()
            if left < MIN_ATTEMPT_SEC:
                log("бюджет кончился, осталось %.1fс" % left)
                return None, last if heavy else "не успели за отведённое время"
            name, extra = VARIANTS[vi]
            body = _body(audio_b64, prompt, extra)
            timeout = max(MIN_ATTEMPT_SEC, min(ATTEMPT_SEC, left - 1.0))
            log("запрос", model, "[" + name + "]", "лимит %.0fс" % timeout,
                "тело %d КБ" % (len(body) // 1024))
            data, why, what = _call(key, model, body, timeout)
            if data is not None:
                _GOOD_VARIANT[model] = vi
                return data, None
            last = why

            if what == "variant":            # модель не поняла поле запроса (400)
                vi += 1                      # дёшево, за попытку не считаем
                continue
            heavy += 1
            if what == "simplify":           # ответила, но не тем - ступень ниже
                vi += 1
                retried = False
                continue
            if what == "retry" and not retried:
                retried = True               # перегрузка или сеть - один повтор
                continue
            break                            # 429, фильтр, повтор не помог

    return None, last


class handler(BaseHTTPRequestHandler):

    # BaseHTTPRequestHandler по умолчанию сыплет в stderr неразборчивым форматом.
    def log_message(self, fmt, *args):
        pass

    def _cors(self, origin):
        if _origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _reply(self, code, obj, origin):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self._cors(origin)
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        self.send_response(204)
        self._cors(origin)
        self.end_headers()

    def do_GET(self):
        """Проверка живости без траты квоты: /api/note?ping=1"""
        origin = self.headers.get("Origin", "")
        return self._reply(200, {
            "ok": True,
            "models": MODELS,
            "key": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
            "budget": BUDGET_SEC,
            "origins": ORIGIN_RULES,
        }, origin)

    def do_POST(self):
        t_start = time.time()
        deadline = t_start + BUDGET_SEC
        origin = self.headers.get("Origin", "")

        # Origin обязателен. Браузер шлёт его на POST всегда - и на свой домен тоже.
        # Его отсутствие означает не наш браузер, а чей-то скрипт.
        if not _origin_ok(origin):
            log("ОТКАЗ origin=%r" % origin)
            return self._reply(403, {"error": "чужой origin",
                                     "detail": "origin=%s" % (origin or "(пусто)")}, origin)

        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not key:
            log("ОТКАЗ нет GEMINI_API_KEY")
            return self._reply(500, {"error": "GEMINI_API_KEY не задан в настройках Vercel"}, origin)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self._reply(400, {"error": "пустая запись"}, origin)
        if length > MAX_BYTES:
            return self._reply(413, {"error": "запись длиннее двух минут - скажи короче"}, origin)

        # read(n) не обязан вернуть n байт за раз - дочитываем.
        audio, left = b"", length
        while left > 0:
            part = self.rfile.read(min(left, 65536))
            if not part:
                break
            audio += part
            left -= len(part)
        if len(audio) < length:
            log("ОТКАЗ тело оборвалось: %d из %d" % (len(audio), length))
            return self._reply(400, {"error": "запись не доехала целиком",
                                     "detail": "%d из %d байт" % (len(audio), length)}, origin)

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

        secs = len(audio) / 32000.0        # 16 кГц, моно, 16 бит
        log("старт", "%d КБ" % (len(audio) // 1024), "~%.0fс речи" % secs,
            "сегодня=%s" % d.isoformat(), "сфер=%d" % len(zone_ids))

        data, err = _ask_gemini(key, base64.b64encode(audio).decode("ascii"), prompt, deadline)
        took = round(time.time() - t_start, 1)
        if data is None:
            log("ПРОВАЛ", "%.1fс" % took, err)
            return self._reply(502, {"error": "нейросеть не ответила",
                                     "detail": err, "elapsed": took}, origin)

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

        transcript = (data.get("transcript") or "").strip()
        log("ГОТОВО", "%.1fс" % took, "сфера=%s дата=%s понял=%s букв=%d" % (
            zone, note_date, bool(data.get("understood")), len(transcript)))

        return self._reply(200, {
            "text": (data.get("text") or "").strip()[:200],
            "zone": zone,
            "date": note_date,
            "understood": bool(data.get("understood")),
            "note": (data.get("note") or "").strip()[:200],
            "transcript": transcript,
            "elapsed": took,
        }, origin)
