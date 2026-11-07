// Almacenamiento de la versión web (lo que en Android hacen la carpeta elegida y SharedPreferences):
//  - Los zips de los libros se copian una vez al almacenamiento privado del navegador (OPFS:
//    navigator.storage.getDirectory(), carpeta "libros/<id>.zip"). Se leen por partes, como en Android.
//  - Datos de cada libro (título, color, portada reducida) y las sesiones que guarda el libro
//    (SharedObject de Ruffle) en IndexedDB. Las sesiones no tienen el límite de ~5 MB de localStorage.
//  - Ajustes y datos técnicos en localStorage (son pocos).
(function (global) {
  "use strict";

  var BD = "librospb", VERSION_BD = 1, CARPETA = "libros";
  var URL_ESCRITOR = new URL("escritor.js", (global.document && document.currentScript && document.currentScript.src) || location.href).href;
  var bdPromesa = null;

  function abrirBD() {
    if (bdPromesa) return bdPromesa;
    bdPromesa = new Promise(function (ok, mal) {
      var r = indexedDB.open(BD, VERSION_BD);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains("libros")) db.createObjectStore("libros", { keyPath: "id" });
        if (!db.objectStoreNames.contains("sesiones")) db.createObjectStore("sesiones", { keyPath: ["libro", "clave"] });
      };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { bdPromesa = null; mal(r.error); };
    });
    return bdPromesa;
  }

  function tx(almacen, modo, fn) {
    return abrirBD().then(function (db) {
      return new Promise(function (ok, mal) {
        var t = db.transaction(almacen, modo), s = t.objectStore(almacen), res;
        Promise.resolve(fn(s)).then(function (v) { res = v; });
        t.oncomplete = function () { ok(res); };
        t.onerror = t.onabort = function () { mal(t.error); };
      });
    });
  }
  function pedir(req) { return new Promise(function (ok, mal) { req.onsuccess = function () { ok(req.result); }; req.onerror = function () { mal(req.error); }; }); }

  // ---------- OPFS ----------
  var soporte = {
    opfs: !!(global.navigator && navigator.storage && navigator.storage.getDirectory),
    seguro: !!global.isSecureContext,
    escritura: ""   // "worker" (SyncAccessHandle), "writable" (createWritable) o "" (no se pudo)
  };

  async function carpeta() {
    var raiz = await navigator.storage.getDirectory();
    return raiz.getDirectoryHandle(CARPETA, { create: true });
  }

  /** Copia "archivo" a OPFS como "nombre". progreso(bytes) se llama mientras copia. */
  function copiar(archivo, nombre, progreso, cancelar) {
    return copiarConWorker(archivo, nombre, progreso, cancelar).then(function () { soporte.escritura = "worker"; }, function (e) {
      if (e && e.cancelado) throw e;
      console.warn("[almacen] worker sin SyncAccessHandle:", e && e.message);
      return copiarConWritable(archivo, nombre, progreso, cancelar).then(function () { soporte.escritura = "writable"; });
    });
  }

  // Preferido: escribe en su lugar, sin archivo temporal (createWritable de Chrome necesita el
  // doble de espacio mientras copia). En Safari es la forma con más soporte (iOS 16.4+).
  function copiarConWorker(archivo, nombre, progreso, cancelar) {
    return new Promise(function (ok, mal) {
      var w;
      try { w = new Worker(URL_ESCRITOR); }
      catch (e) { mal(e); return; }
      var hecho = false;
      if (cancelar) cancelar.al = function () { if (hecho) return; hecho = true; try { w.postMessage({ cancelar: true }); } catch (e) { } setTimeout(function () { w.terminate(); }, 500); mal({ cancelado: true }); };
      w.onmessage = function (e) {
        var d = e.data || {};
        if (d.progreso != null && progreso) progreso(d.progreso);
        if (d.listo) { hecho = true; w.terminate(); ok(); }
        if (d.error) { hecho = true; w.terminate(); mal(new Error(d.error)); }
      };
      w.onerror = function (e) { if (hecho) return; hecho = true; w.terminate(); mal(new Error(e.message || "error del worker")); };
      w.postMessage({ archivo: archivo, carpeta: CARPETA, nombre: nombre });
    });
  }

  async function copiarConWritable(archivo, nombre, progreso, cancelar) {
    var dir = await carpeta();
    var fh = await dir.getFileHandle(nombre, { create: true });
    if (!fh.createWritable) throw new Error("Este navegador no permite guardar libros. Usa «Abrir sin guardar».");
    var w = await fh.createWritable({ keepExistingData: false });
    var cancelado = false;
    if (cancelar) cancelar.al = function () { cancelado = true; };
    var TROZO = 8 * 1024 * 1024, pos = 0;
    try {
      while (pos < archivo.size) {
        if (cancelado) throw { cancelado: true };
        var buf = await archivo.slice(pos, Math.min(archivo.size, pos + TROZO)).arrayBuffer();
        await w.write(buf);
        pos += buf.byteLength;
        if (progreso) progreso(pos);
      }
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (x) { }
      throw e;
    }
  }

  async function archivoDe(id) {
    var dir = await carpeta();
    var fh = await dir.getFileHandle(id + ".zip");
    return fh.getFile();
  }

  async function borrarArchivo(nombre) {
    try { var dir = await carpeta(); await dir.removeEntry(nombre); } catch (e) { }
  }

  /** Quita zips que quedaron a medias (una importación interrumpida). */
  async function limpiar() {
    if (!soporte.opfs) return;
    try {
      var dir = await carpeta(), libros = await listarMeta(), ids = {};
      libros.forEach(function (l) { ids[l.id + ".zip"] = true; });
      var sobran = [];
      for await (var par of dir.entries()) { if (!ids[par[0]]) sobran.push(par[0]); }
      for (var i = 0; i < sobran.length; i++) await borrarArchivo(sobran[i]);
    } catch (e) { console.warn("[almacen] limpiar:", e); }
  }

  // ---------- Portadas ----------
  async function reducirImagen(blob, alto) {
    try {
      var img = await (global.createImageBitmap ? createImageBitmap(blob) : new Promise(function (ok, mal) {
        var i = new Image(); i.onload = function () { ok(i); }; i.onerror = mal; i.src = URL.createObjectURL(blob);
      }));
      var esc = Math.min(1, alto / img.height);
      var c = document.createElement("canvas");
      c.width = Math.round(img.width * esc); c.height = Math.round(img.height * esc);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      if (img.close) img.close();
      return await new Promise(function (ok) { c.toBlob(function (b) { ok(b || blob); }, "image/jpeg", 0.86); });
    } catch (e) { return blob; }
  }

  async function portadaDe(z, meta) {
    var ruta = meta.portadaEntrada || meta.iconoEntrada;
    var en = ruta && z.buscarAbsoluta(ruta);
    if (!en) return null;
    return reducirImagen(await z.blobDe(en, ZipLibro.tipo(en.nombre)), 640);
  }

  // ---------- Libros ----------
  function listarMeta() {
    return tx("libros", "readonly", function (s) { return pedir(s.getAll()); }).then(function (l) {
      return (l || []).sort(function (a, b) { return String(a.titulo).localeCompare(String(b.titulo), "es", { numeric: true }); });
    });
  }

  async function espacio() {
    var r = { usado: 0, cuota: 0, persistente: null };
    try { var e = await navigator.storage.estimate(); r.usado = e.usage || 0; r.cuota = e.quota || 0; } catch (e) { }
    try { r.persistente = await navigator.storage.persisted(); } catch (e) { }
    return r;
  }

  /** Revisa un zip (índice, que sea un libro, datos). No copia nada. */
  async function revisar(archivo) {
    var z = await ZipLibro.abrir(archivo);
    if (z.raiz === null) throw new Error("«" + archivo.name + "» no trae un libro (falta browser.swf).");
    var meta = await Metadatos.leer(z, archivo.name);
    return { z: z, meta: meta };
  }

  /**
   * Importa un zip: lo revisa, lo copia a OPFS y guarda sus datos.
   * opciones: progreso(bytes, total), cancelar (objeto; se le pone .al() para cancelar).
   */
  async function importar(archivo, opciones) {
    opciones = opciones || {};
    if (!soporte.opfs || !soporte.seguro) throw new Error("Este navegador no permite guardar libros aquí. Usa «Abrir sin guardar».");
    var r = await revisar(archivo), meta = r.meta;
    var esp = await espacio();
    var previo = (await listarMeta()).filter(function (l) { return l.id === meta.id; })[0];
    var libre = esp.cuota ? esp.cuota - esp.usado + (previo ? previo.tam : 0) : Infinity;
    if (libre < archivo.size + 64 * 1048576) {
      var gb = function (b) { return (b / 1073741824).toFixed(1).replace(".", ",") + " GB"; };
      throw new Error("No hay espacio: el libro pesa " + gb(archivo.size) + " y quedan " + gb(Math.max(0, libre)) + " disponibles para la app.");
    }
    try { await navigator.storage.persist(); } catch (e) { }
    if (previo) await tx("libros", "readwrite", function (s) { s.delete(meta.id); });
    await copiar(archivo, meta.id + ".zip", function (b) { if (opciones.progreso) opciones.progreso(b, archivo.size); }, opciones.cancelar)
      .catch(async function (e) { await borrarArchivo(meta.id + ".zip"); throw e; });
    // Comprobar que la copia quedó completa y legible
    var copia = await archivoDe(meta.id);
    if (copia.size !== archivo.size) { await borrarArchivo(meta.id + ".zip"); throw new Error("La copia quedó incompleta (" + copia.size + " de " + archivo.size + " bytes)."); }
    var z2 = await ZipLibro.abrir(copia);
    if (z2.entradas.length !== r.z.entradas.length) { await borrarArchivo(meta.id + ".zip"); throw new Error("La copia del libro no se puede leer."); }
    var portada = await portadaDe(z2, meta);
    var libro = {
      id: meta.id, titulo: meta.titulo, nivel: meta.nivel, etiqueta: meta.etiqueta, codigo: meta.codigo, color: meta.color,
      tam: archivo.size, nombreOriginal: archivo.name, importado: Date.now(), portada: portada, entradas: z2.entradas.length
    };
    await tx("libros", "readwrite", function (s) { s.put(libro); });
    return libro;
  }

  async function borrar(id) {
    await tx("libros", "readwrite", function (s) { s.delete(id); });
    await borrarArchivo(id + ".zip");
  }

  // ---------- Sesiones del libro (SharedObject de Ruffle) ----------
  function rango(id) { return IDBKeyRange.bound([id, ""], [id, "￿"]); }

  function sesiones(id) {
    return tx("sesiones", "readonly", function (s) { return pedir(s.getAll(rango(id))); }).then(function (filas) {
      var r = Object.create(null);
      (filas || []).forEach(function (f) { r[f.clave] = f.valor; });
      return r;
    });
  }

  // Se escriben en orden y sin perder la última: si llegan varias de la misma clave mientras una se
  // escribe, solo se guarda la más reciente.
  var pendientes = new Map(), escribiendo = false;
  function guardarSesion(id, clave, valor) {
    pendientes.set(id + "\u0000" + clave, { libro: id, clave: clave, valor: valor });
    if (!escribiendo) vaciar();
  }
  function vaciar() {
    if (!pendientes.size) { escribiendo = false; return; }
    escribiendo = true;
    var lote = Array.from(pendientes.values());
    pendientes.clear();
    tx("sesiones", "readwrite", function (s) {
      lote.forEach(function (f) { if (f.valor === null) s.delete([f.libro, f.clave]); else s.put(f); });
    }).catch(function (e) { console.error("[almacen] no se pudo guardar la sesión", e); }).then(vaciar);
  }

  async function exportarSesiones() {
    var filas = await tx("sesiones", "readonly", function (s) { return pedir(s.getAll()); });
    return new Blob([JSON.stringify({ app: "Libros PB", tipo: "sesiones", version: 1, fecha: new Date().toISOString(), filas: filas || [] })], { type: "application/json" });
  }

  async function importarSesiones(blob) {
    var d = JSON.parse(await blob.text());
    if (!d || d.tipo !== "sesiones" || !Array.isArray(d.filas)) throw new Error("Ese archivo no es un respaldo de sesiones de Libros PB.");
    await tx("sesiones", "readwrite", function (s) { d.filas.forEach(function (f) { if (f && f.libro && f.clave != null) s.put({ libro: f.libro, clave: f.clave, valor: f.valor }); }); });
    return d.filas.length;
  }

  // ---------- Ajustes y datos técnicos ----------
  function leerAjuste(k) { try { return localStorage.getItem("ajuste:" + k); } catch (e) { return null; } }
  function guardarAjuste(k, v) { try { localStorage.setItem("ajuste:" + k, String(v)); } catch (e) { } }
  function guardarDiagnostico(json) {
    try {
      var d = JSON.parse(json), lista = JSON.parse(localStorage.getItem("diagnosticos") || "[]");
      // El mismo libro reporta a los 30 s y al cerrar: se reemplaza el de la misma sesión
      lista = lista.filter(function (x) { return x.sesion !== d.sesion; });
      lista.unshift(d);
      localStorage.setItem("diagnosticos", JSON.stringify(lista.slice(0, 6)));
    } catch (e) { }
  }
  function diagnosticos() { try { return JSON.parse(localStorage.getItem("diagnosticos") || "[]"); } catch (e) { return []; } }

  global.Almacen = {
    soporte: soporte, listar: listarMeta, espacio: espacio, revisar: revisar, importar: importar, borrar: borrar,
    archivoDe: archivoDe, limpiar: limpiar, portadaDe: portadaDe,
    sesiones: sesiones, guardarSesion: guardarSesion, exportarSesiones: exportarSesiones, importarSesiones: importarSesiones,
    leerAjuste: leerAjuste, guardarAjuste: guardarAjuste, guardarDiagnostico: guardarDiagnostico, diagnosticos: diagnosticos
  };
})(typeof self !== "undefined" ? self : this);
