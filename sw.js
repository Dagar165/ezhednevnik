/* Сервис-воркер ежедневника.
   Задача: приложение должно открываться и работать без интернета.
   - При установке кэшируем «оболочку» приложения (html, иконки, библиотеки, Firebase SDK).
   - HTML отдаём по схеме «сеть, а если её нет — кэш»: в онлайне приходят обновления,
     в офлайне открывается последняя сохранённая версия.
   - Остальное (иконки, Sortable, Firebase SDK) отдаём из кэша мгновенно.
   - Запросы данных к Firestore/Auth НЕ кэшируем — их офлайн-режим Firebase делает сам. */

var CACHE = 'ezhednevnik-v5';
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

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // запись данных не трогаем
  if (new URL(req.url).origin !== self.location.origin) return; // чужие домены (Firestore/Auth) — мимо

  var isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isHTML) {
    // Сеть в приоритете (чтобы приходили обновления), офлайн — из кэша.
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (r) { return r || caches.match('./index.html'); });
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
