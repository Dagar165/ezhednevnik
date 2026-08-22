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

var CACHE = 'ezhednevnik-v7';
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

/* Обновление кэша перенесено в саму страницу (index.html, блок «свежая версия»).
   Причина: fetch() внутри сервис-воркера по навигационному запросу оказался
   ненадёжным — кэш молча не обновлялся неделю, и человек сидел на старой
   версии, ничего об этом не зная. Страница делает то же самое проще и
   проверяемо: спрашивает свежий html фоном, кладёт его в этот же кэш и, если
   он отличается, показывает полосу «Приехала новая версия».
   Здесь остаётся одно: отдать из кэша мгновенно. */

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                             // запись данных не трогаем
  if (new URL(req.url).origin !== self.location.origin) return; // чужие домены (Firestore/Auth) — мимо

  var isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isHTML) {
    // Из кэша мгновенно — в метро это разница между рабочим приложением и
    // белым экраном. Сети здесь не ждём вообще.
    e.respondWith(
      caches.match(req)
        .then(function (cached) { return cached || caches.match('./index.html'); })
        .then(function (have) {
          if (have) return have;
          return fetch(req).then(function (res) {          // самый первый заход
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
            return res;
          });
        })
    );
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
