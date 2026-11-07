// Correcciones al libro, solo en memoria (los archivos del zip no se tocan).
// Versión web de src/mx/libro/pb/Parches.java: inserta las rutinas AS2 ya ensambladas
// (js/parches-datos.js, generado desde Parches.java con herramientas/parches_web.py) antes del
// primer cuadro de browser.swf y de VIDEO.swf.
(function (global) {
  "use strict";

  function deHex(s) {
    var b = new Uint8Array(s.length / 2);
    for (var i = 0; i < b.length; i++) b[i] = parseInt(s.substr(2 * i, 2), 16);
    return b;
  }
  var D = global.PARCHES_DATOS || {};
  var VIDEO = deHex(D.VIDEO || ""), LIBRO = deHex(D.LIBRO || ""), MEMORIA = deHex(D.MEMORIA || ""), BARRAS = deHex(D.BARRAS || "");

  async function inflar(bytes) {
    // CWS: después de los 8 bytes de cabecera viene un flujo zlib ("deflate" en DecompressionStream)
    var flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    var lector = flujo.getReader(), partes = [], total = 0;
    try {
      for (;;) {
        var r = await lector.read();
        if (r.done) break;
        partes.push(r.value); total += r.value.length;
      }
    } catch (e) {
      // Algunos SWF traen basura después del flujo; lo ya leído sirve
      if (!total) throw e;
    }
    var out = new Uint8Array(total), p = 0;
    partes.forEach(function (x) { out.set(x, p); p += x.length; });
    return out;
  }

  /** Devuelve el SWF con la rutina insertada antes del primer cuadro. Si algo falla, el original. */
  async function insertar(swf, parche) {
    try {
      swf = new Uint8Array(swf);
      if (swf.length < 9 || !parche.length) return swf;
      var firma = String.fromCharCode(swf[0], swf[1], swf[2]), cuerpo;
      if (firma === "CWS") cuerpo = await inflar(swf.subarray(8));
      else if (firma === "FWS") cuerpo = swf.subarray(8);
      else return swf;
      var nbits = cuerpo[0] >> 3;
      var pos = ((5 + 4 * nbits + 7) >> 3) + 4, hallado = false;
      while (pos + 2 <= cuerpo.length) {
        var h = cuerpo[pos] | (cuerpo[pos + 1] << 8), codigo = h >> 6, lon = h & 0x3f, cab = 2;
        if (lon === 0x3f) {
          lon = (cuerpo[pos + 2] | (cuerpo[pos + 3] << 8) | (cuerpo[pos + 4] << 16) | (cuerpo[pos + 5] << 24)) >>> 0;
          cab = 6;
        }
        if (codigo === 1 || codigo === 0) { hallado = true; break; }   // primer ShowFrame
        pos += cab + lon;
      }
      if (!hallado) return swf;
      var total = 8 + cuerpo.length + parche.length;
      var nuevo = new Uint8Array(total);
      nuevo[0] = 0x46; nuevo[1] = 0x57; nuevo[2] = 0x53; nuevo[3] = swf[3];   // "FWS" + versión
      new DataView(nuevo.buffer).setUint32(4, total, true);
      nuevo.set(cuerpo.subarray(0, pos), 8);
      nuevo.set(parche, 8 + pos);
      nuevo.set(cuerpo.subarray(pos), 8 + pos + parche.length);
      return nuevo;
    } catch (e) {
      console.warn("[libro] no se pudo parchar el SWF", e);
      return new Uint8Array(swf);
    }
  }

  function unir(listas) {
    var n = 0; listas.forEach(function (x) { n += x.length; });
    var r = new Uint8Array(n), p = 0;
    listas.forEach(function (x) { r.set(x, p); p += x.length; });
    return r;
  }

  // ---------- Fuentes más ligeras en recursos04.swf y pag.swf ----------
  // Por cada página el libro carga pag.swf (2 fuentes de 1076 glifos para sus campos de texto) y 3
  // veces recursos04.swf (clips cargaIMG, cargaNotas y fondoPaint.punteros de pag.swf), y Ruffle
  // nunca suelta un SWF cargado. recursos04.swf trae 11 fuentes de 1076
  // glifos (latín extendido, vietnamita, símbolos): medido en el banco, son ~85 % de la memoria que
  // crece al hojear (~70 de ~80 MB por vuelta de página). Aquí cada fuente se queda solo con los
  // glifos que el libro puede necesitar y se renumeran los de sus textos fijos (que se ven igual):
  //  - los que usan los textos fijos del archivo ("WB p.", "Teaching notes", "Video part 1"...),
  //  - español e inglés (Latin-1 y los extras de Windows-1252), puntuación (U+2010-205E), € y ™,
  //  - en las fuentes fonéticas (IPA, Doulos, Charis), el alfabeto fonético: ŋ, U+0250-036F
  //    (IPA, modificadores como ˈ ː, diacríticos), θ β χ y U+1D00-1DBF.
  // Las 4 Verdana y las 4 IPA solo las usa el editor de notas del libro (un campo de texto cada una).
  var EXTRA_1252 = [0x152, 0x153, 0x160, 0x161, 0x178, 0x17D, 0x17E, 0x192, 0x2C6, 0x2DC];
  function codigoUtil(cod, fonetica) {
    if (cod <= 0xFF) return true;
    if (cod >= 0x2010 && cod <= 0x205E) return true;
    if (cod === 0x20AC || cod === 0x2122) return true;
    if (EXTRA_1252.indexOf(cod) >= 0) return true;
    if (fonetica && (cod === 0x14B || (cod >= 0x250 && cod <= 0x36F) || cod === 0x3B8 || cod === 0x3B2 || cod === 0x3C7 ||
      (cod >= 0x1D00 && cod <= 0x1DBF))) return true;
    return false;
  }

  function Bits(d, p) { this.d = d; this.p = p * 8; }
  Bits.prototype.u = function (n) { var v = 0; for (var i = 0; i < n; i++) { v = v * 2 + ((this.d[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; };
  Bits.prototype.alinear = function () { this.p = (this.p + 7) & ~7; return this.p >> 3; };
  function escribirBits(d, posBit, n, v) {
    for (var i = n - 1; i >= 0; i--, posBit++) {
      var bit = Math.floor(v / Math.pow(2, i)) & 1, k = 7 - (posBit & 7);
      d[posBit >> 3] = bit ? (d[posBit >> 3] | (1 << k)) : (d[posBit >> 3] & ~(1 << k));
    }
  }
  function saltarRect(b) { var n = b.u(5); b.p += 4 * n; return b.alinear(); }
  function saltarMatriz(b) {
    if (b.u(1)) { var n = b.u(5); b.p += 2 * n; }
    if (b.u(1)) { var m = b.u(5); b.p += 2 * m; }
    var k = b.u(5); b.p += 2 * k; return b.alinear();
  }

  function etiquetas(cuerpo) {
    var lista = [], nbits = cuerpo[0] >> 3, cabecera = ((5 + 4 * nbits + 7) >> 3) + 4, pos = cabecera;
    var dv = new DataView(cuerpo.buffer, cuerpo.byteOffset, cuerpo.byteLength);
    while (pos + 2 <= cuerpo.length) {
      var h = dv.getUint16(pos, true), codigo = h >> 6, lon = h & 0x3f, cab = 2;
      if (lon === 0x3f) { lon = dv.getUint32(pos + 2, true); cab = 6; }
      lista.push({ codigo: codigo, ini: pos, datos: pos + cab, fin: pos + cab + lon });
      pos += cab + lon;
      if (codigo === 0) break;
    }
    return { cabecera: cabecera, lista: lista };
  }

  // Glifos de los textos fijos (DefineText 11 / DefineText2 33): para cada uno, la fuente, el índice
  // y dónde está (en bits) para poder renumerarlo
  function glifosDeTextos(cuerpo, lista) {
    var uso = {}, sitios = [];
    lista.forEach(function (t) {
      if (t.codigo !== 11 && t.codigo !== 33) return;
      var b = new Bits(cuerpo, t.datos + 2);
      saltarRect(b);
      var q = saltarMatriz(b), gb = cuerpo[q], ab = cuerpo[q + 1], fuente = null;
      q += 2;
      while (q < t.fin && cuerpo[q] !== 0) {
        var f = cuerpo[q++];
        if (f & 8) { fuente = cuerpo[q] | (cuerpo[q + 1] << 8); q += 2; }
        if (f & 4) q += t.codigo === 33 ? 4 : 3;
        if (f & 1) q += 2;
        if (f & 2) q += 2;
        if (f & 8) q += 2;
        var n = cuerpo[q++], bb = new Bits(cuerpo, q);
        for (var i = 0; i < n; i++) {
          var pb = bb.p, g = bb.u(gb); bb.p += ab;
          (uso[fuente] = uso[fuente] || {})[g] = true;
          sitios.push({ etiqueta: t, fuente: fuente, bit: pb, bits: gb, glifo: g });
        }
        q = bb.alinear();
      }
    });
    return { uso: uso, sitios: sitios };
  }

  // DefineFont3 (75) solo con los glifos útiles. Devuelve { tag, mapa } o null si no conviene.
  function fuenteLigera(cuerpo, t, usados) {
    var dv = new DataView(cuerpo.buffer, cuerpo.byteOffset, cuerpo.byteLength), p = t.datos;
    var id = dv.getUint16(p, true), banderas = cuerpo[p + 2], nl = cuerpo[p + 4];
    var nombre = String.fromCharCode.apply(null, cuerpo.subarray(p + 5, p + 5 + nl)).replace(/\0.*$/, "");
    var fonetica = /ipa|doulos|charis/i.test(nombre);
    var q = p + 5 + nl, n = dv.getUint16(q, true);
    if (n < 64) return null;
    var anchas = !!(banderas & 8), anchosCod = !!(banderas & 4), conDiseno = !!(banderas & 0x80), w = anchas ? 4 : 2, wc = anchosCod ? 2 : 1;
    var base = q + 2;
    function off(i) { return anchas ? dv.getUint32(base + i * w, true) : dv.getUint16(base + i * w, true); }
    var codigos = base + off(n);
    function codigo(i) { return anchosCod ? dv.getUint16(codigos + 2 * i, true) : cuerpo[codigos + i]; }
    var usa = usados[id] || {}, quedan = [];
    for (var i = 0; i < n; i++) if (usa[i] || codigoUtil(codigo(i), fonetica)) quedan.push(i);
    if (quedan.length === n) return null;
    // Diseño: ascenso, descenso, interlineado, avances, rectángulos (tamaño variable) e interletrado
    var pd = codigos + n * wc, rects = [], kern = [], cabDiseno = null, avances = null;
    if (conDiseno) {
      cabDiseno = cuerpo.subarray(pd, pd + 6); avances = pd + 6;
      var pr = avances + 2 * n;
      for (var r = 0; r < n; r++) { var nb = cuerpo[pr] >> 3, lr = (5 + 4 * nb + 7) >> 3; rects.push(cuerpo.subarray(pr, pr + lr)); pr += lr; }
      var nk = dv.getUint16(pr, true), lk = anchosCod ? 6 : 4, pk = pr + 2, guardados = {};
      quedan.forEach(function (i) { guardados[codigo(i)] = true; });
      for (var k = 0; k < nk; k++, pk += lk) {
        var c1 = anchosCod ? dv.getUint16(pk, true) : cuerpo[pk], c2 = anchosCod ? dv.getUint16(pk + 2, true) : cuerpo[pk + 1];
        if (guardados[c1] && guardados[c2]) kern.push(cuerpo.subarray(pk, pk + lk));
      }
      if (pk !== t.fin) return null;   // formato inesperado: mejor no tocarla
    }
    var m = quedan.length, formas = [], total = 0, mapa = {};
    quedan.forEach(function (i, j) {
      mapa[i] = j;
      var f = cuerpo.subarray(base + off(i), i + 1 < n ? base + off(i + 1) : codigos);
      formas.push(f); total += f.length;
    });
    var anchasN = (m + 1) * 4 + total > 0xFFFF, wN = anchasN ? 4 : 2;
    var largoRects = 0; quedan.forEach(function (i) { largoRects += rects.length ? rects[i].length : 0; });
    var prefijo = cuerpo.subarray(p, q);   // id, banderas, idioma, nombre (sin el número de glifos)
    var lon = prefijo.length + 2 + (m + 1) * wN + total + m * wc +
      (conDiseno ? 6 + 2 * m + largoRects + 2 + kern.length * (anchosCod ? 6 : 4) : 0);
    var out = new Uint8Array(6 + lon), o = new DataView(out.buffer), x = 6;
    o.setUint16(0, (75 << 6) | 0x3f, true); o.setUint32(2, lon, true);
    out.set(prefijo, x); out[x + 2] = anchasN ? (banderas | 8) : (banderas & ~8); x += prefijo.length;
    o.setUint16(x, m, true); x += 2;
    var tabla = x, pos = (m + 1) * wN;
    formas.forEach(function (f, j) {
      if (anchasN) o.setUint32(tabla + j * wN, pos, true); else o.setUint16(tabla + j * wN, pos, true);
      out.set(f, tabla + pos); pos += f.length;
    });
    if (anchasN) o.setUint32(tabla + m * wN, pos, true); else o.setUint16(tabla + m * wN, pos, true);
    x = tabla + pos;
    quedan.forEach(function (i) { if (anchosCod) { o.setUint16(x, codigo(i), true); x += 2; } else out[x++] = codigo(i); });
    if (conDiseno) {
      out.set(cabDiseno, x); x += 6;
      quedan.forEach(function (i) { o.setInt16(x, dv.getInt16(avances + 2 * i, true), true); x += 2; });
      quedan.forEach(function (i) { out.set(rects[i], x); x += rects[i].length; });
      o.setUint16(x, kern.length, true); x += 2;
      kern.forEach(function (kr) { out.set(kr, x); x += kr.length; });
    }
    if (x !== out.length) return null;
    return { id: id, tag: out, mapa: mapa };
  }

  /** El SWF con fuentes más ligeras (y sin DefineFontAlignZones). Si algo falla, el original. */
  async function aligerarFuentes(swf) {
    try {
      swf = new Uint8Array(swf);
      var firma = String.fromCharCode(swf[0], swf[1], swf[2]), cuerpo;
      if (firma === "CWS") cuerpo = await inflar(swf.subarray(8));
      else if (firma === "FWS") cuerpo = swf.subarray(8);
      else return swf;
      cuerpo = new Uint8Array(cuerpo);   // copia: los textos fijos se renumeran aquí mismo
      var et = etiquetas(cuerpo), textos = glifosDeTextos(cuerpo, et.lista), nuevas = new Map(), mapas = {};
      et.lista.forEach(function (t) {
        if (t.codigo !== 75) return;
        var r = fuenteLigera(cuerpo, t, textos.uso);
        if (r) { nuevas.set(t, r.tag); mapas[r.id] = r.mapa; }
      });
      if (!nuevas.size) return swf;
      // Renumerar los glifos de los textos fijos (el índice nuevo siempre es menor: cabe en los mismos bits)
      for (var i = 0; i < textos.sitios.length; i++) {
        var s = textos.sitios[i], mp = mapas[s.fuente];
        if (!mp) continue;
        if (mp[s.glifo] === undefined) throw new Error("glifo sin lugar");
        escribirBits(cuerpo, s.bit, s.bits, mp[s.glifo]);
      }
      var partes = [cuerpo.subarray(0, et.cabecera)];
      et.lista.forEach(function (t) {
        if (t.codigo === 73) return;   // DefineFontAlignZones: solo afina el suavizado, y es por glifo
        partes.push(nuevas.get(t) || cuerpo.subarray(t.ini, t.fin));
      });
      var cuerpoN = unir(partes), out = new Uint8Array(8 + cuerpoN.length);
      out[0] = 0x46; out[1] = 0x57; out[2] = 0x53; out[3] = swf[3];
      new DataView(out.buffer).setUint32(4, out.length, true);
      out.set(cuerpoN, 8);
      return out;
    } catch (e) {
      console.warn("[libro] no se pudieron aligerar las fuentes", e);
      return new Uint8Array(swf);
    }
  }

  global.Parches = {
    esVideoSwf: function (ruta) { return /(^|\/)video\.swf$/i.test(ruta); },
    // SWF que el libro carga una y otra vez al hojear (y que Ruffle nunca suelta): fuentes más ligeras
    esAligerable: function (ruta) { return /(^|\/)recursos\/(recursos04|pag)\.swf$/i.test(ruta); },
    aligerarFuentes: aligerarFuentes,
    parchearVideo: function (swf) { return insertar(swf, VIDEO); },
    parchearLibro: function (swf) { return insertar(swf, unir([LIBRO, MEMORIA, BARRAS])); },
    insertar: insertar,
    disponibles: VIDEO.length > 0 && BARRAS.length > 0
  };
})(typeof self !== "undefined" ? self : this);
