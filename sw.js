// Service worker: solo para que la app abra sin internet. Los libros no pasan por aquí (se leen
// del almacenamiento del navegador dentro de la página).
//  - Archivos de la app: primero la red (así llegan las versiones nuevas); sin internet o si la red
//    tarda más de 2.5 s, la copia.
//  - Motor de Ruffle (.wasm, con huella en el nombre): primero la copia.
// Al publicar una versión nueva, cambia VERSION para borrar las copias viejas.
"use strict";
var VERSION = "librospb-web-0.2.1";
var NUCLEO = [
  "./", "index.html", "visor.html", "manifest.webmanifest",
  "js/zip.js", "js/metadatos.js", "js/almacen.js", "js/escritor.js", "js/parches.js", "js/parches-datos.js", "js/puente-web.js",
  "ruffle/ruffle.js", "ruffle/ruffle_web_bg.DCLRGRZR.wasm",
  "iconos/icono-192.png", "iconos/icono-512.png", "iconos/apple-touch-icon.png"
];

var redLenta = 0;   // cuándo fue la última vez que la red no respondió a tiempo

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(NUCLEO); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/\.wasm$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) {
        if (res.ok) { var copia = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copia); }); }
        return res;
      });
    }));
    return;
  }
  // Archivos de la app: la versión de la red si llega pronto; si la red no responde en 2.5 s (wifi
  // lento de la escuela) o no hay internet, la copia guardada. La descarga sigue por detrás y la
  // versión nueva queda lista para la próxima vez.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (copia) {
    var red = fetch(req).then(function (res) {
      if (res.ok && res.type === "basic") { var c = res.clone(); caches.open(VERSION).then(function (k) { k.put(req, c); }); }
      return res.ok || !copia ? res : copia;
    });
    if (!copia) {
      return red.catch(function () { return req.mode === "navigate" ? caches.match("index.html") : Response.error(); });
    }
    // Si hace poco la red ya fue lenta, la copia de inmediato (si no, las esperas se suman: página,
    // scripts, visor...)
    if (Date.now() - redLenta < 60000) return copia;
    var espera = new Promise(function (ok) { setTimeout(function () { redLenta = Date.now(); ok(copia); }, 2500); });
    return Promise.race([red.catch(function () { redLenta = Date.now(); return copia; }), espera]);
  }));
});
