/* Сервис-воркер ежедневника.
   Задача: приложение должно открываться и работать без интернета.
   - При установке кэшируем «оболочку» приложения (html, иконки, библиотеки).
   - HTML отдаём по схеме «сеть, а если её нет — кэш»: так в онлайне приходят обновления,
     а в офлайне всё равно открывается последняя сохранённая версия.
   - Остальное (иконки, Sortable, Firebase SDK) отдаём из кэша мгновенно. */

var CACHE = 'ezhednevnik-v2';
var ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './vendor/Sortable.min.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg'
];
// Firebase SDK с CDN — кэшируем отдельно (best-effort), чтобы синхронизация работала офлайн.
var EXTRA = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Свои файлы — обязательны (атомарно). Firebase — по возможности, ошибки не валят установку.
      return c.addAll(ASSETS).then(function () {
        return Promise.all(EXTRA.map(function (u) {
          return c.add(new Request(u, { mode: 'cors' })).catch(function () {});
        }));
      });
    }).then(function () { return self.skipWaiting(); })
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
  if (req.method !== 'GET') return;                 // запись данных не трогаем
  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  var isFirebaseSdk = url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0;

  // Запросы данных к Firestore/Auth НЕ кэшируем — их офлайн-режим Firebase делает сам.
  if (!sameOrigin && !isFirebaseSdk) return;

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

  // Статика и Firebase SDK: сначала кэш, потом сеть (и докладываем в кэш).
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
