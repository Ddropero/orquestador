/*
 * /vivo — la página del QR.
 *
 * Reglas que no se negocian aquí:
 *  - Todo texto recibido se pinta con textContent; nada se interpreta como HTML.
 *  - Una referencia fabricada solo aparece junto a su veredicto y con la etiqueta de
 *    ejercicio docente. Antes del veredicto se muestra "verificando…", sin la cita.
 *  - La página solo lee: no envía nada al servidor salvo el "ping" que mantiene viva
 *    la conexión.
 */
(function(){
  "use strict";

  var DATOS = JSON.parse(document.getElementById("datos-vivo").textContent);
  var REFS = {};
  DATOS.referencias.forEach(function(r){ REFS[r.n] = r; });

  var SONDEO_MS = 5000;
  var PING_MS = 25000;
  var eventos = [];
  var ws = null;
  var wsAbierto = false;
  var intentos = 0;
  var temporizadorSondeo = null;
  var temporizadorPing = null;
  var temporizadorReconexion = null;

  function $(id){ return document.getElementById(id); }
  function el(tag, clase, texto){
    var e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined && texto !== null) e.textContent = String(texto);
    return e;
  }
  function vaciar(nodo){ while (nodo.firstChild) nodo.removeChild(nodo.firstChild); }
  function pmidValido(p){ return typeof p === "string" && /^\d{1,9}$/.test(p); }

  var MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  function fechaLarga(iso){
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? Number(m[3]) + " de " + MESES[Number(m[2]) - 1] + " de " + m[1] : "";
  }
  function hora(ts){
    try {
      return new Date(ts).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (e) {
      return "";
    }
  }
  function etiquetaEnsayo(){
    return DATOS.fechaEnsayoPubmed ? "Resultado del ensayo del " + fechaLarga(DATOS.fechaEnsayoPubmed) : "Resultado del ensayo";
  }

  /* ---------- estado ---------- */

  function valido(e){ return e && typeof e === "object" && typeof e.seq === "number" && typeof e.tipo === "string"; }

  function agregar(e){
    if (!valido(e)) return;
    for (var k = 0; k < eventos.length; k++) if (eventos[k].seq === e.seq) return;
    eventos.push(e);
    eventos.sort(function(a, b){ return a.seq - b.seq; });
    pintar();
  }

  function reemplazar(lista){
    eventos = (Array.isArray(lista) ? lista : []).filter(valido).sort(function(a, b){ return a.seq - b.seq; });
    pintar();
  }

  /** Eventos de un tema a partir de su último inicio. Una demo repetida reemplaza a la anterior. */
  function desdeUltimoInicio(tema, tipos){
    var inicio = -1;
    for (var k = eventos.length - 1; k >= 0; k--) {
      if (eventos[k].tipo === "demo_inicio" && eventos[k].tema === tema) { inicio = k; break; }
    }
    return eventos.slice(inicio + 1).filter(function(e){ return tipos.indexOf(e.tipo) >= 0; });
  }

  /* ---------- pintura ---------- */

  function pintar(){
    pintarDiapositiva();
    var veredictos = pintarReferencias();
    pintarResumen(veredictos);
    pintarEvidentia();
    pintarAvisos();
    pintarLinea();
  }

  function pintarDiapositiva(){
    var d = null;
    eventos.forEach(function(e){ if (e.tipo === "diapositiva") d = e; });
    if (!d) {
      $("diapo-n").textContent = "–";
      $("diapo-total").textContent = "";
      $("diapo-titulo").textContent = "La charla todavía no ha empezado.";
      return;
    }
    $("diapo-n").textContent = String(d.n);
    $("diapo-total").textContent = "de " + DATOS.totalDiapositivas;
    $("diapo-titulo").textContent = d.titulo;
  }

  function pintarResumen(veredictos){
    var textos = desdeUltimoInicio("resumen", ["claude_texto"]);
    var ultimo = textos[textos.length - 1];
    if (!ultimo) { $("resumen").hidden = true; return; }
    $("resumen").hidden = false;
    $("resumen-texto").textContent = ultimo.texto_parcial;
    $("resumen-ensayo").hidden = !ultimo.ensayo;
    var v1 = veredictos[DATOS.refResumen];
    $("resumen-veredicto").hidden = !(v1 && v1.existe === false);
  }

  function textoConsultas(consultas){
    return consultas.map(function(c){
      var t = "Por " + c.via + ": " + c.resultados + (c.resultados === 1 ? " resultado" : " resultados");
      if (c.resultados > 0) t += c.coincide ? ", coincide" : ", ninguno es este artículo";
      return t;
    }).join(" · ");
  }

  /** Devuelve los veredictos por referencia para que el resumen sepa si la n.º 1 existe. */
  function pintarReferencias(){
    var evs = desdeUltimoInicio("verificacion", ["pubmed_consulta", "pubmed_veredicto"]);
    var seccion = $("referencias");
    var lista = $("refs");
    var consultas = {};
    var veredictos = {};
    evs.forEach(function(e){
      if (!REFS[e.ref]) return;
      if (e.tipo === "pubmed_consulta") {
        consultas[e.ref] = (consultas[e.ref] || []).filter(function(c){ return c.via !== e.via; });
        consultas[e.ref].push(e);
      } else {
        veredictos[e.ref] = e;
      }
    });
    if (evs.length === 0) { seccion.hidden = true; return veredictos; }
    seccion.hidden = false;
    vaciar(lista);

    DATOS.referencias.forEach(function(r){
      var v = veredictos[r.n];
      var li = el("li");
      if (!v) {
        li.appendChild(el("span", "pendiente", "Referencia " + r.n + ": verificando en PubMed…"));
        lista.appendChild(li);
        return;
      }
      li.className = v.existe ? "si" : "no";
      // La referencia fabricada va en forma corta y siempre con su etiqueta: nada que
      // se pueda copiar y pegar como si fuera una cita real.
      li.appendChild(el("span", "cita", r.fabricada ? r.corta : r.cita));
      if (v.existe && pmidValido(v.pmid)) {
        var s = el("span", "veredicto", "Existe en PubMed · PMID ");
        var a = el("a", null, v.pmid);
        a.href = "https://pubmed.ncbi.nlm.nih.gov/" + v.pmid + "/";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        s.appendChild(a);
        li.appendChild(s);
      } else {
        li.appendChild(el("span", "veredicto", "No existe: ningún resultado de PubMed por título, DOI ni autor es este artículo."));
      }
      if (consultas[r.n] && consultas[r.n].length) li.appendChild(el("span", "consultas", textoConsultas(consultas[r.n])));
      if (r.fabricada) li.appendChild(el("span", "fabricada", "Ejercicio docente: referencia fabricada a propósito. No la cite."));
      if (v.ensayo) li.appendChild(el("span", "ensayo", etiquetaEnsayo()));
      lista.appendChild(li);
    });
    return veredictos;
  }

  var CLASES_ESTADO = { "completada": "completada", "en curso": "en-curso", "falló": "fallo", "sin terminar": "sin-terminar" };

  function pintarEvidentia(){
    var evs = desdeUltimoInicio("evidentia", ["evidentia_etapa"]);
    if (evs.length === 0) { $("evidentia").hidden = true; return; }
    $("evidentia").hidden = false;
    var orden = [];
    var ultima = {};
    evs.forEach(function(e){
      if (!ultima[e.etapa]) orden.push(e.etapa);
      ultima[e.etapa] = e;
    });
    var lista = $("etapas");
    vaciar(lista);
    orden.forEach(function(nombre){
      var e = ultima[nombre];
      var li = el("li", null, e.etapa);
      li.appendChild(el("span", "estado " + (CLASES_ESTADO[e.estado] || ""), e.estado));
      if (e.detalle) li.appendChild(el("span", "detalle", e.detalle));
      lista.appendChild(li);
    });
  }

  function pintarAvisos(){
    var avisos = eventos.filter(function(e){ return e.tipo === "aviso"; }).slice(-3).reverse();
    $("avisos").hidden = avisos.length === 0;
    var lista = $("lista-avisos");
    vaciar(lista);
    avisos.forEach(function(a){ lista.appendChild(el("li", null, a.texto)); });
  }

  var TEMAS = {
    resumen: "Claude resume la referencia 1 sin buscar en ninguna base de datos",
    verificacion: "Verificación de las cinco referencias en PubMed",
    evidentia: "Evidentia busca y verifica la pregunta de la miel"
  };

  function lineaDe(e){
    switch (e.tipo) {
      case "demo_inicio": return "Empieza: " + (TEMAS[e.tema] || "demostración");
      case "pubmed_consulta":
        return "PubMed · referencia " + e.ref + " · por " + e.via + ": " + e.resultados +
          (e.resultados === 1 ? " resultado" : " resultados") +
          (e.resultados > 0 ? (e.coincide ? ", coincide con la cita" : ", ninguno es el artículo citado") : "") +
          (e.ensayo ? " (ensayo)" : "");
      case "pubmed_veredicto":
        return "PubMed · referencia " + e.ref + ": " + (e.existe ? "existe" : "no existe") + (e.ensayo ? " (ensayo)" : "");
      case "evidentia_etapa": return "Evidentia · " + e.etapa + ": " + e.estado;
      case "aviso": return "Mensaje del ponente: " + e.texto;
      default: return null;
    }
  }

  function pintarLinea(){
    var lista = $("linea-eventos");
    vaciar(lista);
    var lineas = [];
    eventos.forEach(function(e){
      var t = lineaDe(e);
      if (t) lineas.push({ ts: e.ts, texto: t });
    });
    lineas = lineas.slice(-40).reverse();
    $("linea-vacia").hidden = lineas.length > 0;
    lineas.forEach(function(l){
      var li = el("li");
      li.appendChild(el("time", null, hora(l.ts)));
      li.appendChild(document.createTextNode(l.texto));
      lista.appendChild(li);
    });
  }

  function pintarKit(){
    var k = DATOS.kit || {};
    var lr = $("lineas-rojas");
    (k.lineasRojas || []).forEach(function(l){
      var li = el("li");
      li.appendChild(el("b", null, l.titulo + ". "));
      li.appendChild(document.createTextNode(l.texto));
      lr.appendChild(li);
    });
    var g = $("guias");
    (k.guias || []).forEach(function(x){
      var li = el("li");
      var a = el("a", null, x.nombre);
      if (/^https:\/\//.test(x.url)) a.href = x.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.appendChild(a);
      g.appendChild(li);
    });
    if (k.prompts && k.prompts.length) {
      $("prompts-kit").hidden = false;
      k.prompts.forEach(function(p){ $("prompts").appendChild(el("li", null, p)); });
    }
  }

  /* ---------- conexión: WebSocket con sondeo de respaldo ---------- */

  function estadoConexion(texto, clase){
    var c = $("conexion");
    c.textContent = texto;
    c.className = "conexion " + clase;
  }

  function sondear(){
    return fetch("/api/sala/estado", { cache: "no-store", credentials: "omit" })
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(d){
        // Con el WebSocket abierto, el sondeo solo suma: reemplazar podría borrar un
        // evento que llegó por el socket después de la foto del sondeo.
        if (wsAbierto) { (Array.isArray(d.eventos) ? d.eventos : []).forEach(agregar); return; }
        reemplazar(d.eventos);
        estadoConexion("Actualizando cada 5 segundos", "sondeo");
      })
      .catch(function(){ if (!wsAbierto) estadoConexion("Sin conexión. Reintentando…", "caida"); });
  }

  function iniciarSondeo(){
    if (temporizadorSondeo) return;
    temporizadorSondeo = setInterval(sondear, SONDEO_MS);
  }
  function detenerSondeo(){
    clearInterval(temporizadorSondeo);
    temporizadorSondeo = null;
  }

  function conectar(){
    clearTimeout(temporizadorReconexion);
    if (!("WebSocket" in window)) { iniciarSondeo(); return; }
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      ws = new WebSocket(proto + "//" + location.host + "/api/sala/ws");
    } catch (e) {
      iniciarSondeo();
      programarReconexion();
      return;
    }
    ws.onopen = function(){
      wsAbierto = true;
      intentos = 0;
      detenerSondeo();
      estadoConexion("En vivo", "ok");
      clearInterval(temporizadorPing);
      temporizadorPing = setInterval(function(){ try { ws.send("ping"); } catch (e) {} }, PING_MS);
    };
    ws.onmessage = function(m){
      if (m.data === "pong") return;
      var e = null;
      try { e = JSON.parse(m.data); } catch (x) { return; }
      agregar(e);
    };
    ws.onclose = function(ev){
      wsAbierto = false;
      clearInterval(temporizadorPing);
      // 4000: el ponente reinició la sala. Se empieza de cero.
      if (ev && ev.code === 4000) reemplazar([]);
      estadoConexion("Reconectando…", "sondeo");
      sondear();
      iniciarSondeo();
      programarReconexion();
    };
    ws.onerror = function(){ /* onclose se encarga */ };
  }

  function programarReconexion(){
    intentos++;
    var espera = Math.min(60000, 1000 * Math.pow(2, Math.min(intentos, 6)));
    clearTimeout(temporizadorReconexion);
    temporizadorReconexion = setTimeout(conectar, espera);
  }

  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState === "visible") {
      sondear();
      if (!wsAbierto) conectar();
    }
  });

  pintarKit();
  pintar();
  // Las dos cosas a la vez: el sondeo trae el estado en el primer segundo aunque el
  // WebSocket tarde o esté bloqueado en la red del hotel.
  sondear();
  conectar();
})();
