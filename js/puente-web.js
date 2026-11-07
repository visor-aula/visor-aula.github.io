// Puente de la versión web: hace en el navegador lo que en Android hacen MainActivity y Servidor,
// para que visor.html funcione igual en los dos lados.
//  - window.Android: las mismas funciones que la app de Android le da al visor (datosLibro,
//    cerrarLibro, existe, ajustes, datos técnicos, guardar archivo...).
//  - window.fetch: las peticiones de Ruffle a http://<id>.libro.local/... se responden desde el zip
//    (con los parches de browser.swf y VIDEO.swf), sin red. La dirección empieza con "http:" aunque
//    la página sea https: VIDEO.swf revisa que _url contenga "http:".
//  - window.localStorage: las sesiones que guarda el libro (SharedObject) van a IndexedDB por medio
//    de la biblioteca, sin el límite de ~5 MB de Safari.
//  - Video MP4 directo del zip con una dirección blob: (Safari adelanta el video sin problemas).
// El visor corre dentro de un iframe de index.html; la biblioteca deja el libro listo en
// parent.LibrosWeb.libroAbierto antes de crear el iframe.
(function () {
  "use strict";
  if (window.Android) return;   // app de Android: no hace falta nada de esto

  var host = null;
  try { host = window.parent !== window ? window.parent.LibrosWeb : null; } catch (e) { host = null; }
  var libro = host && host.libroAbierto;
  if (!libro) {
    window.addEventListener("DOMContentLoaded", function () {
      document.body.innerHTML = location.protocol === "file:"
        ? '<p style="font:16px system-ui;padding:24px">Safari no deja abrir el libro desde un archivo (doble clic en index.html). En la Mac usa «Probar Libros PB web.command», que la abre en http://localhost:8642.</p>'
        : '<p style="font:16px system-ui;padding:24px">Abre los libros desde la biblioteca. <a href="./" target="_top">Ir a la biblioteca</a></p>';
    });
    window.Android = { datosLibro: function () { return "{}"; } };
    return;
  }

  var zip = new ZipLibro(libro.archivo, libro.entradas);
  var HOST_LIBRO = (libro.id + ".libro.local").toLowerCase();
  var BASE = "http://" + HOST_LIBRO + "/";
  window.LIBRO_BASE = BASE;
  var abrirOriginal = window.open.bind(window);
  var clicOriginal = HTMLAnchorElement.prototype.click;
  var fetchOriginal = window.fetch.bind(window);

  // ---------- Memoria de Ruffle (datos técnicos y medidor) ----------
  var wasm = { mem: null, pico: 0 };
  window.__wasmInfo = wasm;
  (function () {
    try {
      var ins = WebAssembly.instantiate, insS = WebAssembly.instantiateStreaming;
      var capturar = function (r) {
        try {
          var inst = r.instance || r;
          var m = inst.exports && Object.keys(inst.exports).map(function (k) { return inst.exports[k]; }).filter(function (x) { return x instanceof WebAssembly.Memory; })[0];
          if (m) { wasm.mem = m; window.__wasmMem = m; }
        } catch (e) { }
        return r;
      };
      WebAssembly.instantiate = function () { return ins.apply(this, arguments).then(capturar); };
      if (insS) WebAssembly.instantiateStreaming = function () { return insS.apply(this, arguments).then(capturar); };
    } catch (e) { }
  })();
  function wasmMB() {
    try { var b = wasm.mem ? wasm.mem.buffer.byteLength : 0; if (b > wasm.pico) wasm.pico = b; return Math.round(b / 1048576); } catch (e) { return 0; }
  }

  // ---------- Archivos del libro ----------
  var parchados = new Map();
  function respuesta(cuerpo, estado, cabeceras, url) {
    var r = new Response(cuerpo, { status: estado, statusText: estado === 200 ? "OK" : estado === 206 ? "Partial Content" : "Not Found", headers: cabeceras || {} });
    // Una respuesta hecha a mano no tiene dirección; Ruffle la usa como _url de cada SWF
    try { Object.defineProperty(r, "url", { value: url, configurable: true }); } catch (e) { }
    return r;
  }
  function noEncontrado(url) { return respuesta(null, 404, { "Content-Type": "text/plain" }, url); }

  function rutaDe(url) {
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== "http:" || u.hostname.toLowerCase() !== HOST_LIBRO) return null;
    var p = u.pathname || "/";
    try { p = decodeURIComponent(p); } catch (e) { }
    return p;
  }

  function rango(cab, total) {
    if (!cab || total <= 0) return null;
    var m = /^bytes=(\d*)-(\d*)$/i.exec(String(cab).trim());
    if (!m) return null;
    var ini, fin;
    if (m[1] === "") { ini = Math.max(0, total - parseInt(m[2], 10)); fin = total - 1; }
    else { ini = parseInt(m[1], 10); fin = m[2] === "" ? total - 1 : Math.min(total - 1, parseInt(m[2], 10)); }
    if (!(ini >= 0) || ini > fin || ini >= total) return null;
    return [ini, fin];
  }

  var cuenta = { peticiones: 0, bytes: 0, faltan: 0, faltantes: [] };
  window.__lecturas = cuenta;
  var registro = window.__registro = [];   // últimas lecturas (para revisar en el inspector)
  async function servir(ruta, url, cabRango) {
    var en = zip.buscar(ruta);
    if (!en) {
      cuenta.faltan++;
      if (cuenta.faltantes.length < 8 && cuenta.faltantes.indexOf(ruta) < 0) cuenta.faltantes.push(ruta);
      return noEncontrado(url);
    }
    var tipo = ZipLibro.tipo(en.nombre);
    // Si el video también viene en MP4, el visor usa ese: el FLV no se carga
    if (/\.flv$/i.test(en.nombre) && zip.buscarAbsoluta(en.nombre.slice(0, -4) + ".mp4")) return noEncontrado(url);
    var esLibro = en.nombre.toLowerCase() === ((zip.raiz || "") + "browser.swf").toLowerCase();
    var esR04 = Parches.esAligerable(en.nombre) && !window.__sinAligerar;
    if (esLibro || esR04 || Parches.esVideoSwf(en.nombre)) {
      var p = parchados.get(en.nombre);
      if (!p) {
        p = zip.leerTodo(en).then(function (b) {
          return esLibro ? Parches.parchearLibro(b) : esR04 ? Parches.aligerarFuentes(b) : Parches.parchearVideo(b);
        });
        parchados.set(en.nombre, p);
      }
      var bytes = await p;
      cuenta.peticiones++; cuenta.bytes += bytes.length;
      return respuesta(bytes, 200, { "Content-Type": tipo, "Content-Length": String(bytes.length) }, url);
    }
    var blob = await zip.blobDe(en, tipo);
    cuenta.peticiones++; cuenta.bytes += blob.size;
    registro.push([ruta, blob.size]); if (registro.length > 300) registro.shift();
    var r = rango(cabRango, blob.size);
    if (r) {
      return respuesta(blob.slice(r[0], r[1] + 1, tipo), 206, {
        "Content-Type": tipo, "Content-Length": String(r[1] - r[0] + 1),
        "Content-Range": "bytes " + r[0] + "-" + r[1] + "/" + blob.size, "Accept-Ranges": "bytes"
      }, url);
    }
    return respuesta(blob, 200, { "Content-Type": tipo, "Content-Length": String(blob.size), "Accept-Ranges": "bytes" }, url);
  }

  window.fetch = function (entrada, init) {
    var url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : (entrada && entrada.url) || String(entrada);
    var ruta = rutaDe(url);
    if (ruta === null) return fetchOriginal(entrada, init);
    var cab = null;
    try {
      if (init && init.headers) cab = new Headers(init.headers).get("Range");
      if (!cab && entrada && entrada.headers && entrada.headers.get) cab = entrada.headers.get("Range");
    } catch (e) { }
    return servir(ruta, url, cab).catch(function (e) {
      console.warn("[libro] error al leer " + ruta, e);
      return respuesta(String((e && e.message) || e), 500, { "Content-Type": "text/plain" }, url);
    });
  };

  // Video y otros archivos que van directo a un elemento de la página (no pasan por fetch)
  var urls = [];
  window.urlArchivo = function (ruta) {
    var en = zip.buscar(ruta);
    if (!en) return Promise.reject(new Error("no existe " + ruta));
    return zip.blobDe(en, ZipLibro.tipo(en.nombre)).then(function (b) { var u = URL.createObjectURL(b); urls.push(u); return u; });
  };
  window.soltarArchivos = function () { urls.splice(0).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { } }); };

  // ---------- Sesiones del libro (SharedObject) ----------
  // Ruffle guarda cada SharedObject como propiedad del almacenamiento (localStorage[clave] = datos),
  // no con setItem: por eso es un Proxy que se porta como el Storage del navegador. Las claves
  // quedan como "personalbestb2i-book.libro.local//<nombre>" (el libro usa la ruta "/"), igual que
  // en Android, donde cada libro tiene su dominio.
  var datosSO = libro.sesiones || Object.create(null);
  var tiene = function (k) { return Object.prototype.hasOwnProperty.call(datosSO, k); };
  var metodos = {
    getItem: function (k) { k = String(k); return tiene(k) ? datosSO[k] : null; },
    setItem: function (k, v) { k = String(k); v = String(v); datosSO[k] = v; host.guardarSesion(libro.id, k, v); },
    removeItem: function (k) { k = String(k); if (!tiene(k)) return; delete datosSO[k]; host.guardarSesion(libro.id, k, null); },
    key: function (i) { var ks = Object.keys(datosSO); return i >= 0 && i < ks.length ? ks[i] : null; },
    clear: function () { Object.keys(datosSO).forEach(function (k) { metodos.removeItem(k); }); }
  };
  var almacenSO = new Proxy(Object.create(null), {
    get: function (t, k) {
      if (typeof k !== "string") return undefined;
      if (k === "length") return Object.keys(datosSO).length;
      if (tiene(k)) return datosSO[k];
      return Object.prototype.hasOwnProperty.call(metodos, k) ? metodos[k] : undefined;
    },
    set: function (t, k, v) { if (typeof k === "string") metodos.setItem(k, v); return true; },
    deleteProperty: function (t, k) { if (typeof k === "string") metodos.removeItem(k); return true; },
    has: function (t, k) { return typeof k === "string" && (tiene(k) || Object.prototype.hasOwnProperty.call(metodos, k) || k === "length"); },
    ownKeys: function () { return Object.keys(datosSO); },
    getOwnPropertyDescriptor: function (t, k) {
      return typeof k === "string" && tiene(k) ? { value: datosSO[k], writable: true, enumerable: true, configurable: true } : undefined;
    }
  });
  var soPropio = false;
  try {
    Object.defineProperty(window, "localStorage", { configurable: true, enumerable: true, get: function () { return almacenSO; } });
    soPropio = window.localStorage === almacenSO;
  } catch (e) { soPropio = false; }

  // ---------- Lo que la app de Android le da al visor ----------
  function guardarArchivo(nombre, tipo, base64) {
    var bin = atob(base64), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    host.guardarArchivo(new Blob([b], { type: tipo || "application/octet-stream" }), nombre || "sesion");
  }

  var apertura = (host.aperturas = (host.aperturas || 0) + 1);
  window.Android = {
    datosLibro: function () {
      return JSON.stringify({
        id: libro.id, titulo: libro.titulo, etiqueta: libro.etiqueta, color: libro.color || null,
        portada: libro.portadaUrl || null, apertura: apertura, calentado: false, precarga: false
      });
    },
    cerrarLibro: function () { setTimeout(function () { host.cerrar(); }, 0); },
    abrirExterno: function (url) { try { abrirOriginal(url, "_blank", "noopener"); } catch (e) { } },
    existe: function (ruta) { return !!zip.buscar(ruta); },
    libroListo: function () { try { host.libroListo(); } catch (e) { } },
    avisosGL: function () { return ""; },
    precargaLista: function () { },
    leerAjuste: function (k) { return host.leerAjuste(k); },
    guardarAjuste: function (k, v) { host.guardarAjuste(k, v); },
    guardarDiagnostico: function (json) {
      try {
        var d = JSON.parse(json);
        var saf = /Version\/([\d.]+).*Safari/.exec(navigator.userAgent), chr = /(?:Chrome|CriOS)\/([\d.]+)/.exec(navigator.userAgent);
        d.navegador = saf && !chr ? "Safari " + saf[1] : chr ? "Chrome " + chr[1] : navigator.userAgent.slice(0, 60);
        d.plataforma = (navigator.platform || "") + (navigator.maxTouchPoints > 1 ? " táctil" : "") + (host.instalada() ? ", instalada" : ", navegador");
        d.ruffle_mb = wasmMB() + " (pico " + Math.round(wasm.pico / 1048576) + ")";
        d.origen = libro.origen;
        d.lecturas = cuenta.peticiones + " archivos, " + Math.round(cuenta.bytes / 1048576) + " MB" + (cuenta.faltan ? ", " + cuenta.faltan + " no encontrados (" + cuenta.faltantes.join(" ") + ")" : "");
        d.sesiones = soPropio ? "IndexedDB" : "localStorage del navegador";
        d.memoria = memoriaMB() + " MB de " + memoria.limite + " (" + memoria.equipo + (memoria.aprendido ? ", aprendido" : "") + ")";
        json = JSON.stringify(d);
      } catch (e) { }
      host.guardarDiagnostico(json);
    },
    guardarArchivo: guardarArchivo,
    pantallaCompleta: function (si) { try { host.pantallaCompleta(si); } catch (e) { } }
  };

  // ---------- Memoria (web 0.3) ----------
  // Ruffle nunca devuelve memoria (WebAssembly solo crece) y el libro no suelta páginas ni ejercicios:
  // en una sesión larga, Safari llega a recargar la app ("was using significant memory"). Se vigila
  // Ruffle + memoria gráfica estimada contra un límite por tipo de equipo (Safari no dice cuánta
  // memoria tiene el equipo); si Safari la recarga, la biblioteca aprende ese nivel (index.html).
  var memoria = host.memoria || { limite: 1800, equipo: "otro" };
  function memoriaMB() { return wasmMB() + (window.__memGPU ? Math.round(window.__memGPU.actual / 1048576) : 0); }
  window.__memoriaLibro = function () { return { mb: memoriaMB(), limite: memoria.limite, equipo: memoria.equipo }; };
  function vigilarMemoria() {
    var avisoMem = null, cerradoA = 0;
    setInterval(function () {
      var mb = memoriaMB();
      host.anotarMemoria(mb);
      if (mb < 0.8 * memoria.limite || avisoMem || mb < cerradoA + 150) return;
      avisoMem = document.createElement("div");
      avisoMem.id = "avisoMemoria";
      avisoMem.innerHTML = '<span>El libro ya usa mucha memoria. En una pausa, ciérralo y vuelve a abrirlo para que siga fluido.</span>' +
        '<button type="button" class="reabrir">Volver a abrir</button><button type="button" class="cerrar" aria-label="Cerrar aviso">×</button>';
      avisoMem.querySelector(".reabrir").addEventListener("click", function () { host.reabrir(); });
      avisoMem.querySelector(".cerrar").addEventListener("click", function () { cerradoA = memoriaMB(); avisoMem.remove(); avisoMem = null; });
      document.body.appendChild(avisoMem);
    }, 5000);
  }

  // ---------- Pantalla ----------
  // iPhone/iPad: que el sonido del libro (Web Audio) se oiga aunque el iPhone esté en silencio,
  // como un video (Safari 16.4+)
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { }

  // Si el iframe del libro no tiene el foco, el primer toque en un campo de texto no abre el teclado
  window.addEventListener("pointerdown", function () { if (!document.hasFocus()) { try { window.focus(); } catch (e) { } } }, true);

  // Safari hace zoom de la página con el pellizco aunque el viewport lo prohíba; el pellizco es del libro
  ["gesturestart", "gesturechange"].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false }); });

  window.addEventListener("DOMContentLoaded", function () {
    var estilo = document.createElement("style");
    estilo.textContent =
      "body{-webkit-touch-callout:none}" +
      "#contenedor{top:env(safe-area-inset-top);right:env(safe-area-inset-right);bottom:env(safe-area-inset-bottom);left:env(safe-area-inset-left)}" +
      "#girar{position:fixed;inset:0;z-index:30;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;background:rgba(20,18,15,.82);color:#fff;font:600 18px/1.35 system-ui,-apple-system,sans-serif;text-align:center}" +
      "#girar svg{width:64px;height:64px}#girar small{font-weight:400;font-size:14px;opacity:.75}" +
      "@media (orientation:portrait) and (pointer:coarse){#girar:not(.cerrado){display:flex}}" +
      "#avisoMemoria{position:fixed;z-index:26;left:50%;top:calc(8px + env(safe-area-inset-top));transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:min(92vw,640px);padding:8px 8px 8px 16px;border-radius:14px;background:rgba(28,24,20,.9);color:#fff;font:500 14px/1.35 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}" +
      "#avisoMemoria button{flex:none;border:0;border-radius:999px;font:600 13.5px system-ui,-apple-system,sans-serif;cursor:pointer}" +
      "#avisoMemoria .reabrir{padding:8px 14px;background:#fff;color:#1f1b16}#avisoMemoria .cerrar{width:32px;height:32px;background:transparent;color:#fff;font-size:20px}" +
      "#medidor{position:fixed;left:calc(4px + env(safe-area-inset-left));top:calc(4px + env(safe-area-inset-top));z-index:25;padding:3px 7px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font:600 11px/1.3 ui-monospace,Menlo,monospace;pointer-events:none;white-space:pre}";
    document.head.appendChild(estilo);
    var g = document.createElement("div");
    g.id = "girar";
    g.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="11" rx="2"/><path d="M8 3.5h3M18.5 4.5a6 6 0 0 1 2 3.5M20.5 8l.2-2.3M20.5 8l-2.1-.9"/></svg>' +
      "<div>Gira el dispositivo para ver el libro</div><small>(toca para seguir así)</small>";
    g.addEventListener("click", function () { g.classList.add("cerrado"); });
    document.body.appendChild(g);

    vigilarMemoria();

    if (host.leerAjuste("medidor") === "1") {
      var m = document.createElement("div");
      m.id = "medidor";
      document.body.appendChild(m);
      var pintar = function () {
        var gpu = window.__memGPU ? Math.round(window.__memGPU.actual / 1048576) : 0;
        var pico = window.__memGPU ? Math.round(window.__memGPU.pico / 1048576) : 0;
        m.textContent = "Ruffle " + wasmMB() + " MB (pico " + Math.round(wasm.pico / 1048576) + ")\nGráfica ≈" + gpu + " MB (pico " + pico + ")\n" + (window.__motor || "…") + " · " + cuenta.peticiones + " archivos\nLímite " + memoria.limite + " MB (" + memoria.equipo + (memoria.aprendido ? ", aprendido" : "") + ")";
      };
      pintar();
      setInterval(pintar, 1000);
    }
  });
})();
