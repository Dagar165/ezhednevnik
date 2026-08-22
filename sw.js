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

/* Сходить в сеть, положить свежее в кэш и сказать, изменилось ли оно. */
function refresh(req, cached) {
  return fetch(req).then(function (res) {
    if (!res || !res.ok) return null;
    var copy = res.clone();
    return caches.open(CACHE).then(function (c) { return c.put(req, copy); })
      .then(function () {
        if (!cached) return null;
        return Promise.all([cached.clone().text(), res.clone().text()]).then(function (t) {
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
    e.respondWith(
      caches.match(req).then(function (cached) {
        if (!cached) cached = null;
        return caches.match('./index.html').then(function (fallback) {
          var have = cached || fallback;
          if (have) {
            // Отдаём мгновенно, сеть догоняет фоном — метро больше не держит экран.
            e.waitUntil(refresh(req, have));
            return have;
          }
          // Кэша ещё нет (самый первый заход) — только тогда ждём сеть.
          return fetch(req).then(function (res) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
            return res;
          });
        });
      })
    );
    return;
  }

  // Статика: сначала кэш, потом сеть (и докладываем в кэш).
  e.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      });
    })
  );
});
