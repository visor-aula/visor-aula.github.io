// Lee un libro empaquetado en .zip directo de un Blob/File, sin descomprimirlo ni copiarlo a memoria.
// Es la versión web de src/mx/libro/pb/ZipLibro.java: al abrir solo se lee el índice (al final del
// zip); cada archivo se lee después por posición (Blob.slice). Soporta zips sin compresión
// ("almacenar", lo recomendado) y con deflate, y zips de más de 4 GB (Zip64).
(function (global) {
  "use strict";

  var UTF8 = new TextDecoder("utf-8");
  var LATIN1 = new TextDecoder("latin1");

  function ZipLibro(blob, entradas) {
    this.blob = blob;
    this.tam = blob.size;
    this.entradas = entradas;
    this.porNombre = new Map();
    for (var i = 0; i < entradas.length; i++) {
      var clave = entradas[i].nombre.toLowerCase();
      if (!this.porNombre.has(clave)) this.porNombre.set(clave, entradas[i]);
    }
    this.raiz = buscarRaiz(entradas);
  }

  function u64(dv, p) {
    // Los tamaños caben en un Number (hasta 2^53)
    return dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
  }

  async function leer(blob, pos, lon) {
    return new DataView(await blob.slice(pos, pos + lon).arrayBuffer());
  }

  /** Lee el índice del zip. Lanza un Error con mensaje en español si no se puede. */
  ZipLibro.abrir = async function (blob) {
    var tam = blob.size;
    if (tam < 22) throw new Error("No es un zip");
    var cola = Math.min(tam, 65557);
    var fin = await leer(blob, tam - cola, cola);
    var pos = -1;
    for (var i = cola - 22; i >= 0; i--) {
      if (fin.getUint32(i, true) === 0x06054b50) { pos = i; break; }
    }
    if (pos < 0) throw new Error("No es un zip (no se encontró el índice)");
    var posEocd = tam - cola + pos;
    var total = fin.getUint16(pos + 10, true);
    var tamDir = fin.getUint32(pos + 12, true);
    var posDir = fin.getUint32(pos + 16, true);
    if (total === 0xffff || tamDir === 0xffffffff || posDir === 0xffffffff) {
      if (posEocd >= 20) {
        var loc = await leer(blob, posEocd - 20, 20);
        if (loc.getUint32(0, true) === 0x07064b50) {
          var z = await leer(blob, u64(loc, 8), 56);
          if (z.getUint32(0, true) !== 0x06064b50) throw new Error("Zip64 dañado");
          total = u64(z, 32);
          tamDir = u64(z, 40);
          posDir = u64(z, 48);
        }
      }
    }
    if (tamDir > 256 * 1024 * 1024 || posDir + tamDir > tam) throw new Error("Índice del zip inválido");

    var bytes = new Uint8Array(await blob.slice(posDir, posDir + tamDir).arrayBuffer());
    var dir = new DataView(bytes.buffer);
    var p = 0, lim = tamDir, entradas = [];
    while (p + 46 <= lim && dir.getUint32(p, true) === 0x02014b50) {
      var banderas = dir.getUint16(p + 8, true);
      var metodo = dir.getUint16(p + 10, true);
      var comp = dir.getUint32(p + 20, true);
      var real = dir.getUint32(p + 24, true);
      var lNombre = dir.getUint16(p + 28, true);
      var lExtra = dir.getUint16(p + 30, true);
      var lComent = dir.getUint16(p + 32, true);
      var posLocal = dir.getUint32(p + 42, true);
      var bn = bytes.subarray(p + 46, p + 46 + lNombre);
      var nombre = ((banderas & 0x800) ? UTF8 : LATIN1).decode(bn);

      var e = p + 46 + lNombre, eFin = e + lExtra;
      while (e + 4 <= eFin) {
        var id = dir.getUint16(e, true), lon = dir.getUint16(e + 2, true);
        if (id === 0x0001) {
          var q = e + 4;
          if (real === 0xffffffff && q + 8 <= e + 4 + lon) { real = u64(dir, q); q += 8; }
          if (comp === 0xffffffff && q + 8 <= e + 4 + lon) { comp = u64(dir, q); q += 8; }
          if (posLocal === 0xffffffff && q + 8 <= e + 4 + lon) { posLocal = u64(dir, q); }
        }
        e += 4 + lon;
      }
      p += 46 + lNombre + lExtra + lComent;

      nombre = nombre.replace(/\\/g, "/");
      if (/\/$/.test(nombre)) continue;                 // carpeta
      if (nombre.indexOf("__MACOSX/") === 0) continue;  // basura de macOS
      var corto = nombre.slice(nombre.lastIndexOf("/") + 1);
      if (corto.indexOf("._") === 0) continue;
      entradas.push({ nombre: nombre, metodo: metodo, tamComp: comp, tamReal: real, posLocal: posLocal, posDatos: -1 });
    }
    if (!entradas.length && total > 0) throw new Error("Índice del zip vacío o dañado");
    return new ZipLibro(blob, entradas);
  };

  function buscarRaiz(entradas) {
    var mejor = null;
    for (var i = 0; i < entradas.length; i++) {
      var n = entradas[i].nombre.toLowerCase();
      if (n === "browser.swf" || /\/browser\.swf$/.test(n)) {
        if (mejor === null || entradas[i].nombre.length < mejor.length) mejor = entradas[i].nombre;
      }
    }
    return mejor === null ? null : mejor.slice(0, mejor.length - "browser.swf".length);
  }

  /** Busca por ruta completa dentro del zip (sin distinguir mayúsculas). */
  ZipLibro.prototype.buscarAbsoluta = function (nombre) {
    return this.porNombre.get(String(nombre).replace(/\\/g, "/").toLowerCase()) || null;
  };

  /**
   * Busca una ruta relativa a la carpeta del libro. Si no existe, prueba quitando carpetas del
   * inicio: Ruffle a veces resuelve desde la carpeta del SWF que pide el archivo
   * (p. ej. "contenido/contenido/videos/0101.flv").
   */
  ZipLibro.prototype.buscar = function (rel) {
    var r = this.raiz || "";
    rel = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
    var en = this.buscarAbsoluta(r + rel);
    if (en) return en;
    var partes = rel.split("/");
    for (var i = 1; i < partes.length; i++) {
      en = this.buscarAbsoluta(r + partes.slice(i).join("/"));
      if (en) return en;
    }
    return null;
  };

  ZipLibro.prototype.posDatos = async function (en) {
    if (en.posDatos >= 0) return en.posDatos;
    var cab = await leer(this.blob, en.posLocal, 30);
    if (cab.getUint32(0, true) !== 0x04034b50) throw new Error("Zip dañado en " + en.nombre);
    en.posDatos = en.posLocal + 30 + cab.getUint16(26, true) + cab.getUint16(28, true);
    return en.posDatos;
  };

  /**
   * Contenido de una entrada como Blob. Sin compresión es un "pedazo" del zip: no se lee nada
   * hasta que alguien lo usa (así el video sale directo del archivo, con adelantar incluido).
   */
  ZipLibro.prototype.blobDe = async function (en, tipo) {
    var pos = await this.posDatos(en);
    var trozo = this.blob.slice(pos, pos + en.tamComp, en.metodo === 0 ? (tipo || "") : "");
    if (en.metodo === 0) return trozo;
    if (en.metodo === 8) {
      if (typeof DecompressionStream !== "function") throw new Error("Este navegador no descomprime zips; usa un zip sin compresión");
      var flujo = trozo.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      var b = await new Response(flujo).blob();
      return tipo ? b.slice(0, b.size, tipo) : b;
    }
    throw new Error("Compresión no soportada (" + en.metodo + ") en " + en.nombre);
  };

  ZipLibro.prototype.leerTodo = async function (en) {
    return (await this.blobDe(en)).arrayBuffer();
  };

  ZipLibro.tipo = function (nombre) {
    var n = String(nombre).toLowerCase(), p = n.lastIndexOf(".");
    var ext = p < 0 ? "" : n.slice(p + 1);
    return ({
      swf: "application/x-shockwave-flash", xml: "text/xml", jpg: "image/jpeg", jpeg: "image/jpeg",
      png: "image/png", webp: "image/webp", gif: "image/gif", mp3: "audio/mpeg", flv: "video/x-flv",
      mp4: "video/mp4", f4v: "video/mp4", html: "text/html", htm: "text/html", js: "application/javascript",
      css: "text/css", json: "application/json", txt: "text/plain", pdf: "application/pdf",
      svg: "image/svg+xml", woff2: "font/woff2"
    })[ext] || "application/octet-stream";
  };

  global.ZipLibro = ZipLibro;
})(typeof self !== "undefined" ? self : this);
