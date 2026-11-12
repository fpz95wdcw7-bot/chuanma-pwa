const CACHE = 'chuanma-v1';
const ASSETS = [
  './', './setup/', './play/', './review/', './vision-test/', './manifest.webmanifest',
  './assets/styles.css', './assets/app.js', './assets/icon.svg',
  './assets/vision-tiles-atlas.webp',
  './assets/icon-180.png', './assets/icon-192.png', './assets/icon-512.png',
  './assets/core/constants.js', './assets/core/EventStore.js',
  './assets/core/RulesEngine.js', './assets/core/HandAnalysis.js', './assets/core/DecisionEngine.js',
  './assets/core/GameStateEngine.js', './assets/services/CameraService.js',
  './assets/services/VisionService.js', './assets/services/SpeechService.js',
  './assets/services/AudioService.js',
];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && new URL(event.request.url).origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
