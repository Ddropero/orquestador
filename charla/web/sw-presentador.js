/*
 * Service worker de /presentador: si el portátil se queda sin red y la pestaña se
 * recarga, la presentación vuelve a abrir desde la última copia buscada con red.
 *
 * Primero la red (con 6 s de plazo), para que un despliegue nuevo llegue siempre;
 * la copia solo se usa si la red falla. Solo se guarda la presentación, marcada
 * por el servidor con `x-charla-pagina: presentador`: nunca la página de entrada.
 */
var CACHE = "presentador-v1";

// Al instalarse guarda ya la página: si no, la primera visita del día no queda en
// caché y una recarga sin red no tendría nada que abrir.
self.addEventListener("install", function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(cache){
    return fetch("/presentador", { credentials: "include" }).then(function(res){
      if (res.ok && res.headers.get("x-charla-pagina") === "presentador") return cache.put("/presentador", res);
    }).catch(function(){});
  }));
});
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function(e){
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname !== "/presentador") return;
  e.respondWith((async function(){
    var cache = await caches.open(CACHE);
    try {
      var res = await fetch(e.request, { signal: AbortSignal.timeout(6000) });
      if (res.ok && res.headers.get("x-charla-pagina") === "presentador") {
        await cache.put("/presentador", res.clone());
      }
      return res;
    } catch (error) {
      var guardada = await cache.match("/presentador");
      return guardada || new Response(
        "<!doctype html><meta charset=utf-8><title>Sin conexión</title><p>Sin conexión y sin copia guardada. Abra la copia descargada (charla-presentador-sin-red.html).</p>",
        { status: 503, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
  })());
});
