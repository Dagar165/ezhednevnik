/* Сервис-воркер ежедневника.
   Задача: приложение должно открываться мгновенно и работать без интернета.

   Главная правка 22.08.2026 (аудит № 2, «метро»).
   Было: html сначала запрашивался из сети и только при ОШИБКЕ брался из кэша.
   Под землёй связь формально есть, но не отвечает — запрос висел десятками
   секунд, и всё это время человек смотрел на белый экран, хотя рабочая копия
   лежала в кэше рядом.
   Стало: html отдаётся из кэша СРАЗУ, а сеть проверяется фоном и обновляет
   кэш к следующему запуску. Если фоном приехала другая версия — приложение
   получает сообщение и говорит об этом вслух.

   - Иконки, Sortable и Firebase SDK — из кэша мгновенно (они не меняются).
   - Запросы к Firestore/Auth не трогаем: их офлайн-режим Firebase делает сам. */

var CACHE = 'ezhednevnik-v6';
var ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './vendor/Sortable.min.js',
  './vendor/firebase-app-compat.js',
  './vendor/firebase-auth-compat.js',
  './vendor/firebase-firestore-compat.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function tellClients(msg) {
  return self.clients.matchAll({ includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { try { c.postMessage(msg); } catch (e) {} });
  });
}

/* Сходить в сеть, положить свежее в кэш и сказать, изменилось ли оно.
   ВАЖНО: `cached` сюда передают уже отдельной копией (clone), снятой ДО того,
   как ответ ушёл странице. Иначе браузер успевает вычитать тело на отрисовку,
   и любое обращение к нему здесь падает — а вместе с ним молча пропадает и
   сообщение «приехала новая версия». Ровно так и было 23.08.2026. */
function refresh(req, cached) {
  return fetch(req).then(function (res) {
    if (!res || !res.ok) return null;
    return caches.open(CACHE).then(function (c) {
      // Кладём под тем адресом, который просили, и заодно под './index.html':
      // приложение открывают и как '/', и как '/index.html', и обе записи
      // должны быть свежими, иначе одна из дверей ведёт во вчерашний день.
      return Promise.all([c.put(req, res.clone()), c.put('./index.html', res.clone())]);
    }).then(function () {
      if (!cached) return null;
      return Promise.all([cached.text(), res.clone().text()]).then(function (t) {
        if (t[0] !== t[1]) tellClients({ type: 'ez-new-version' });
        return null;
      });
    });
  }).catch(function () { return null; });   // нет связи — это нормально, работаем из кэша
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                             // запись данных не трогаем
  if (new URL(req.url).origin !== self.location.origin) return; // чужие домены (Firestore/Auth) — мимо

  var isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isHTML) {
    // respondWith и waitUntil зовём СИНХРОННО, обе от одной работы: если позвать
    // waitUntil изнутри .then(), Safari считает событие уже закрытым и фоновое
    // обновление просто не запускается.
    var work = caches.match(req)
      .then(function (cached) { return cached || caches.match('./index.html'); })
      .then(function (have) {
        if (have) {
          // Отдаём мгновенно, сеть догоняет фоном — метро больше не держит экран.
          // Копию для сравнения снимаем здесь, пока тело ответа цело.
          var forCompare = null;
          try { forCompare = have.clone(); } catch (err) {}
          return { res: have, compare: forCompare, again: true };
        }
        // Кэша ещё нет (самый первый заход) — только тогда ждём сеть.
        return fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return { res: res, compare: null, again: false };
        });
      });
    e.respondWith(work.then(function (r) { return r.res; }));
    e.waitUntil(work.then(function (r) { return r.again ? refresh(req, r.compare) : null; })
                    .catch(function () { return null; }));
    return;
  }

  // Статика: сначала кэш, потом сеть (и докладываем в кэш).
  e.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        // Адреса с хвостом (?что-нибудь=…) в кэш не кладём: они одноразовые,
        // а место занимают навсегда.
        if (res && res.ok && new URL(req.url).search === '') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
