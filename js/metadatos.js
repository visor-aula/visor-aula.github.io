// Identifica un libro a partir de su zip: título, nivel, color del marco, portada e ícono.
// Versión web de src/mx/libro/pb/Metadatos.java (mismas reglas, así el id coincide con el de
// Android: es el "dominio" interno del libro y la llave de sus sesiones).
(function (global) {
  "use strict";

  var NIVEL = /(?:^|[^a-z0-9])(starter|pre-?a1|a1\+?|a2\+?|b1\+?|b2\+?|c1\+?|c2)(?![a-z0-9])/i;
  var PALABRAS_PORTADA = ["cover", "portada", "caratula", "carátula", "front"];
  var PALABRAS_ICONO = /(?:^|[^a-z])(app|icono|icon|logo)(?![a-z])/i;

  function limpiar(s) { return s == null ? null : String(s).replace(/\s+/g, " ").trim(); }
  function vacio(s) { return s == null || String(s).trim() === ""; }
  function esImagen(n) { return /\.(png|jpe?g|webp)$/i.test(n); }
  function sinExt(n) { var p = n.lastIndexOf("."); return p < 0 ? n : n.slice(0, p); }
  function tienePalabra(n) { var l = n.toLowerCase(); return PALABRAS_PORTADA.some(function (p) { return l.indexOf(p) >= 0; }); }

  function nivel(s) {
    if (!s) return null;
    var m = NIVEL.exec(s);
    if (!m) return null;
    return m[1].toLowerCase() === "starter" ? "Starter" : m[1].toUpperCase();
  }

  function slug(s) {
    var r = String(s).toLowerCase().replace(/\+/g, "plus").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (r.length > 50) r = r.slice(0, 50).replace(/-+$/, "");
    return r || "libro";
  }

  function atributo(xml, nombre) {
    var m = new RegExp("(?:^|[^A-Za-z0-9_])" + nombre + "\\s*=\\s*\"([^\"]*)\"").exec(xml);
    return m ? m[1] : null;
  }

  async function texto(z, ruta) {
    var en = z.buscarAbsoluta(ruta);
    if (!en || en.tamReal > 4 * 1024 * 1024) return null;
    try { return new TextDecoder("latin1").decode(await z.leerTodo(en)); } catch (e) { return null; }
  }

  function buscarIcono(z, raiz) {
    for (var i = 0; i < z.entradas.length; i++) {
      var n = z.entradas[i].nombre;
      if (!esImagen(n) || n.indexOf(raiz) !== 0 || n.indexOf("/", raiz.length) >= 0) continue;
      if (PALABRAS_ICONO.test(sinExt(n.slice(raiz.length)))) return n;
    }
    return null;
  }

  function buscarPortada(z, raiz) {
    var conPalabra = null, conPalabraRaizZip = null, cualquiera = null;
    for (var i = 0; i < z.entradas.length; i++) {
      var n = z.entradas[i].nombre;
      if (!esImagen(n)) continue;
      if (n.indexOf(raiz) === 0 && n.indexOf("/", raiz.length) < 0) {
        var corto = n.slice(raiz.length);
        if (tienePalabra(corto)) { if (!conPalabra) conPalabra = n; }
        else if (!cualquiera && !PALABRAS_ICONO.test(sinExt(corto))) cualquiera = n;
      } else if (n.indexOf("/") < 0 && tienePalabra(n)) {
        if (!conPalabraRaizZip) conPalabraRaizZip = n;
      }
    }
    return conPalabra || conPalabraRaizZip || cualquiera;
  }

  async function leer(z, nombreArchivo) {
    var m = { titulo: null, nivel: null, etiqueta: null, codigo: null, id: null, color: null, portadaEntrada: null, iconoEntrada: null };
    var raiz = z.raiz || "";
    var config = await texto(z, raiz + "recursos/config00.xml");
    if (config) {
      m.titulo = limpiar(atributo(config, "nombreProducto"));
      m.codigo = limpiar(atributo(config, "codigoProducto"));
      var marco = atributo(config, "colorMarco");
      if (marco && /^[0-9a-f]{6}$/i.test(marco.trim())) m.color = "#" + marco.trim().toLowerCase();
    }
    if (vacio(m.titulo)) {
      var js = await texto(z, raiz + "recursos/config_flash.js");
      var t = js && /document\.title\s*=\s*['"]([^'"]*)['"]/.exec(js);
      if (t) m.titulo = limpiar(t[1]);
    }
    var carpeta = raiz.replace(/\/$/, "");
    carpeta = carpeta.slice(carpeta.lastIndexOf("/") + 1);
    var base = String(nombreArchivo || "").replace(/\.zip$/i, "");
    if (vacio(m.titulo)) m.titulo = limpiar(carpeta.replace(/\s*digital\s*book\s*$/i, ""));
    if (vacio(m.titulo)) m.titulo = limpiar(base);
    if (vacio(m.titulo)) m.titulo = "Libro";

    m.nivel = nivel(m.titulo) || nivel(carpeta) || nivel(base);
    var tt = m.titulo;
    if (m.nivel && /^personal best/i.test(tt)) {
      m.etiqueta = "PB " + m.nivel;
    } else if (m.nivel) {
      var ini = tt.replace(m.nivel, "").trim().split(/\s+/).filter(function (p) { return /^\p{L}/u.test(p); })
        .map(function (p) { return p[0].toUpperCase(); }).join("");
      m.etiqueta = (ini && ini.length <= 4 ? ini + " " : "") + m.nivel;
    } else {
      m.etiqueta = tt.length > 14 ? tt.slice(0, 13).trim() + "…" : tt;
    }
    m.id = slug(!vacio(m.codigo) ? m.codigo : m.titulo);
    m.portadaEntrada = buscarPortada(z, raiz);
    m.iconoEntrada = buscarIcono(z, raiz);
    if (m.iconoEntrada && m.iconoEntrada === m.portadaEntrada) m.portadaEntrada = null;
    return m;
  }

  global.Metadatos = { leer: leer, slug: slug, nivel: nivel };
})(typeof self !== "undefined" ? self : this);
