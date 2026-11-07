// Copia un zip al almacenamiento privado del navegador (OPFS) con FileSystemSyncAccessHandle:
// escribe en su lugar, por trozos, sin archivo temporal. Solo existe dentro de un worker.
// Mensaje: { archivo: File, carpeta: "libros", nombre: "<id>.zip" }
"use strict";
var cancelado = false;
self.onmessage = async function (e) {
  var d = e.data || {};
  if (d.cancelar) { cancelado = true; return; }
  var ah = null;
  try {
    var raiz = await navigator.storage.getDirectory();
    var dir = await raiz.getDirectoryHandle(d.carpeta, { create: true });
    var fh = await dir.getFileHandle(d.nombre, { create: true });
    if (typeof fh.createSyncAccessHandle !== "function") throw new Error("sin createSyncAccessHandle");
    ah = await fh.createSyncAccessHandle();
    await ah.truncate(0);   // en Safari 15 estos métodos devolvían promesas; await sirve para ambos
    var archivo = d.archivo, TROZO = 8 * 1024 * 1024, pos = 0, ultimo = 0;
    while (pos < archivo.size) {
      if (cancelado) throw new Error("cancelado");
      var buf = new Uint8Array(await archivo.slice(pos, Math.min(archivo.size, pos + TROZO)).arrayBuffer());
      var hecho = 0;
      while (hecho < buf.length) {
        var n = await ah.write(buf.subarray(hecho), { at: pos + hecho });
        if (!(n > 0)) throw new Error("no se pudo escribir (¿sin espacio?)");
        hecho += n;
      }
      pos += buf.length;
      var ahora = Date.now();
      if (ahora - ultimo > 150 || pos >= archivo.size) { ultimo = ahora; self.postMessage({ progreso: pos }); }
    }
    await ah.flush();
    await ah.close();
    ah = null;
    self.postMessage({ listo: true });
  } catch (err) {
    try { if (ah) await ah.close(); } catch (x) { }
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
