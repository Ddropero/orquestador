(function(){
  "use strict";

  /* ---------- diapositivas (igual que la versión base) ---------- */
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  var notesBox = document.getElementById("notes");
  var count = document.getElementById("count");
  var i = 0;

  function show(n){
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach(function(s, k){ s.classList.toggle("active", k === i); });
    count.textContent = (i + 1) + " / " + slides.length;
    // Las notas son texto fijo escrito por el ponente en la plantilla, nunca datos de fuera.
    notesBox.innerHTML = slides[i].getAttribute("data-notes") || "";
    if (location.hash !== "#" + (i + 1)) history.replaceState(null, "", "#" + (i + 1));
    slides[i].scrollTop = 0;
    avisarDiapositiva(i + 1);
  }
  document.getElementById("prev").onclick = function(){ show(i - 1); };
  document.getElementById("next").onclick = function(){ show(i + 1); };
  document.getElementById("toggle-notes").onclick = function(){ notesBox.classList.toggle("show"); };
  document.getElementById("toggle-controles").onclick = function(){ alternarControles(); };
  document.getElementById("cerrar-controles").onclick = function(){ alternarControles(false); };
  document.addEventListener("keydown", function(e){
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { show(i + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { show(i - 1); }
    else if (e.key.toLowerCase() === "n") { notesBox.classList.toggle("show"); }
    else if (e.key.toLowerCase() === "c") { alternarControles(); }
  });

  /* ---------- datos embebidos en la construcción ---------- */
  var DATOS = JSON.parse(document.getElementById("datos-presentador").textContent);
  var REFS = DATOS.referencias;
  var RESPALDOS = DATOS.respaldos;
  // Abierta desde el disco (la copia descargada): no hay servidor al que preguntar.
  var SIN_SERVIDOR = location.protocol === "file:";
  var MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

  function fechaLarga(iso){
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!m) return iso || "";
    return Number(m[3]) + " de " + MESES[Number(m[2]) - 1] + " de " + m[1];
  }
  function etiquetaEnsayoPubmed(){
    return RESPALDOS.pubmed ? "Resultado del ensayo del " + fechaLarga(RESPALDOS.pubmed.fecha) : "Resultado del ensayo";
  }
  function nada(){}

  function api(ruta, o){
    o = o || {};
    return fetch(ruta, {
      method: o.method || "GET",
      headers: o.cuerpo !== undefined ? { "content-type": "application/json" } : {},
      body: o.cuerpo !== undefined ? JSON.stringify(o.cuerpo) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      // Sin plazo, una red caída sin avisar (portal cautivo, DNS mudo) deja las
      // peticiones colgadas minutos y el punto de conexión en verde.
      signal: o.signal || AbortSignal.timeout(8000)
    });
  }

  function leerNdjson(res, alMensaje){
    var lector = res.body.getReader();
    var dec = new TextDecoder();
    var resto = "";
    function procesar(linea){
      if (!linea.trim()) return;
      var m = null;
      try { m = JSON.parse(linea); } catch (e) { return; }
      alMensaje(m);
    }
    function paso(){
      return lector.read().then(function(r){
        if (r.done) { procesar(resto); return; }
        resto += dec.decode(r.value, { stream: true });
        var lineas = resto.split("\n");
        resto = lineas.pop();
        lineas.forEach(procesar);
        return paso();
      });
    }
    return paso();
  }

  /* ---------- estado de la conexión (punto en la barra) ---------- */
  var punto = document.getElementById("estado-red");
  function marcarRed(estado){
    punto.className = "punto " + estado;
    punto.title = estado === "ok" ? "Conectado: las demos van en vivo."
      : estado === "sesion" ? "La sesión venció: las demos usarán los resultados del ensayo."
      : "Sin conexión con el servidor: las demos usarán los resultados del ensayo.";
  }

  /* ---------- la diapositiva actual, para /vivo ---------- */
  var temporizadorDiapositiva = null;
  var ultimaAvisada = 0;
  function avisarDiapositiva(n){
    if (SIN_SERVIDOR) return;
    clearTimeout(temporizadorDiapositiva);
    temporizadorDiapositiva = setTimeout(function(){
      if (n === ultimaAvisada) return;
      api("/api/sala/diapositiva", { method: "POST", cuerpo: { n: n } }).then(function(r){
        if (r.ok) { ultimaAvisada = n; marcarRed("ok"); }
        else marcarRed(r.status === 401 ? "sesion" : "error");
      }).catch(function(){ marcarRed("error"); });
    }, 300);
  }

  /* ---------- demo 1: la lista ---------- */
  var list = document.getElementById("refs");
  REFS.forEach(function(r, k){
    var li = document.createElement("li");
    var t = document.createElement("span");
    var num = document.createElement("span");
    num.className = "num";
    num.textContent = (k + 1) + ".";
    t.appendChild(num);
    t.appendChild(document.createTextNode(" "));
    li.appendChild(t);
    li.appendChild(document.createTextNode(r.cita + " "));
    var a = document.createElement("a");
    a.href = "https://doi.org/" + r.doi;
    a.target = "_blank"; a.rel = "noopener";
    a.textContent = "doi:" + r.doi;
    li.appendChild(a);
    var v = document.createElement("span");
    v.className = "verdict wait"; v.id = "v" + k;
    li.appendChild(v);
    list.appendChild(li);
  });

  var status = document.getElementById("demo-status");
  var btnSample = document.getElementById("btn-sample");
  var btnVerify = document.getElementById("btn-verify");
  var btnRespaldoClaude = document.getElementById("btn-respaldo-claude");
  var btnRespaldoPubmed = document.getElementById("btn-respaldo-pubmed");
  var sampleWrap = document.getElementById("sample-wrap");
  var sampleOut = document.getElementById("sample-out");
  var sampleLabel = document.getElementById("sample-label");
  btnSample.disabled = false;
  btnVerify.disabled = false;

  /* ---------- demo 1a: Claude sin búsqueda ---------- */
  var PLAZO_CLAUDE_MS = 25000;
  var AVISO_ESPERA_MS = 8000;

  function mostrarRespaldoClaude(motivo, texto, fecha){
    var r = RESPALDOS.claude;
    texto = texto || (r && r.texto);
    fecha = fecha || (r && r.fecha);
    sampleWrap.hidden = false;
    if (!texto) {
      sampleLabel.textContent = "Sin respuesta";
      sampleOut.textContent = motivo + " No hay respuesta de ensayo grabada.";
      return;
    }
    sampleLabel.textContent = "Respuesta de ensayo · grabada el " + fechaLarga(fecha) + " · sin verificar";
    sampleOut.textContent = texto;
    status.textContent = motivo;
  }

  btnSample.onclick = function(){
    btnSample.disabled = true;
    sampleWrap.hidden = false;
    sampleLabel.textContent = "Respuesta del modelo · sin verificar";
    sampleOut.textContent = "Pensando…";
    var terminado = false;
    var recibioTexto = false;
    var controlador = new AbortController();
    var inicio = Date.now();
    var reloj = setInterval(function(){
      var s = Math.round((Date.now() - inicio) / 1000);
      if (!recibioTexto) sampleOut.textContent = "Pensando… " + s + " s";
      if (Date.now() - inicio >= AVISO_ESPERA_MS) btnRespaldoClaude.hidden = false;
    }, 1000);
    var plazo = setTimeout(function(){ usarRespaldo("Claude tardó más de 25 segundos: se muestra la respuesta del ensayo."); }, PLAZO_CLAUDE_MS);

    function cerrar(){
      terminado = true;
      clearInterval(reloj);
      clearTimeout(plazo);
      btnRespaldoClaude.hidden = true;
      btnSample.disabled = false;
    }
    function usarRespaldo(motivo){
      if (terminado) return;
      cerrar();
      controlador.abort();
      mostrarRespaldoClaude(motivo);
      if (!SIN_SERVIDOR) api("/api/sala/respaldo", { method: "POST", cuerpo: { tipo: "claude" } }).catch(nada);
    }
    btnRespaldoClaude.onclick = function(){ usarRespaldo("Se muestra la respuesta del ensayo."); };

    if (SIN_SERVIDOR) { usarRespaldo("Sin conexión: se muestra la respuesta del ensayo."); return; }

    api("/api/claude/resumen", { method: "POST", cuerpo: {}, signal: controlador.signal }).then(function(res){
      if (!res.ok) {
        marcarRed(res.status === 401 ? "sesion" : "ok");
        return res.json().catch(function(){ return {}; }).then(function(b){
          // 409: el servidor sigue con una consulta anterior que aquí ya se dio por
          // perdida. Se muestra el ensayo y se le pide al servidor que corte la suya.
          usarRespaldo((res.status === 409 ? (b.mensaje || "Ya hay una consulta en curso.") : (b.error || "El servidor no respondió.")) + " Se muestra la respuesta del ensayo.");
        });
      }
      marcarRed("ok");
      return leerNdjson(res, function(m){
        if (terminado) return;
        if (m.t === "texto") { recibioTexto = true; sampleOut.textContent = m.texto; }
        else if (m.t === "fin") { sampleOut.textContent = m.texto; cerrar(); status.textContent = "Respuesta en vivo de " + DATOS.modelo + "."; }
        else if (m.t === "respaldo") { cerrar(); mostrarRespaldoClaude(m.motivo, m.texto, m.fecha); }
        else if (m.t === "error") { cerrar(); sampleLabel.textContent = "Sin respuesta"; sampleOut.textContent = m.mensaje; }
      }).then(function(){ if (!terminado) usarRespaldo("La respuesta se cortó: se muestra la del ensayo."); });
    }).catch(function(){
      if (!terminado) { marcarRed("error"); usarRespaldo("Sin conexión con el servidor: se muestra la respuesta del ensayo."); }
    });
  };

  /* ---------- demo 1b: verificación en PubMed ---------- */
  var PLAZO_SILENCIO_PUBMED_MS = 15000;
  var VIA_TEXTO = { "título": "título", "DOI": "DOI", "autor": "autor" };

  function celda(ref){ return document.getElementById("v" + (ref - 1)); }

  function textoConsultas(consultas){
    return consultas.map(function(c){
      var t = VIA_TEXTO[c.via] + ": " + c.resultados + (c.resultados === 1 ? " resultado" : " resultados");
      if (c.resultados > 0 && !c.coincide) t += ", ninguno es este artículo";
      return t;
    }).join(" · ");
  }

  function pintarVeredicto(ref, existe, pmid, consultas, ensayo){
    var c = celda(ref);
    if (!c) return;
    c.textContent = "";
    if (existe) {
      var via = "";
      consultas.forEach(function(q){ if (q.coincide) via = VIA_TEXTO[q.via]; });
      c.className = "verdict ok";
      c.appendChild(document.createTextNode("Aparece en PubMed por " + (via || "búsqueda") + " · PMID "));
      var a = document.createElement("a");
      a.href = "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/";
      a.target = "_blank"; a.rel = "noopener";
      a.textContent = pmid;
      c.appendChild(a);
    } else {
      c.className = "verdict no";
      var engano = consultas.some(function(q){ return q.resultados > 0 && !q.coincide; });
      c.textContent = engano
        ? "No existe. PubMed devolvió artículos, pero ninguno es este (" + textoConsultas(consultas) + ")."
        : "Sin resultados por título, DOI ni autor.";
    }
    if (ensayo) {
      var e = document.createElement("span");
      e.className = "ensayo";
      e.textContent = " · " + etiquetaEnsayoPubmed();
      c.appendChild(e);
    }
  }

  function pintarRespaldoPubmed(ref){
    var r = RESPALDOS.pubmed && RESPALDOS.pubmed.referencias.filter(function(x){ return x.ref === ref; })[0];
    if (!r) {
      var c = celda(ref);
      if (c) { c.className = "verdict wait"; c.textContent = "Sin respaldo del ensayo para esta referencia."; }
      return;
    }
    pintarVeredicto(ref, r.existe, r.pmid, r.consultas, true);
  }

  btnVerify.onclick = function(){
    btnVerify.disabled = true;
    var consultas = {};
    var conVeredicto = {};
    REFS.forEach(function(r){
      consultas[r.n] = [];
      var c = celda(r.n);
      c.className = "verdict wait";
      c.textContent = "Buscando en PubMed…";
    });
    var terminado = false;
    var controlador = new AbortController();
    var vigia = null;
    var inicio = Date.now();
    var aviso = setInterval(function(){ if (Date.now() - inicio >= AVISO_ESPERA_MS) btnRespaldoPubmed.hidden = false; }, 1000);

    function rearmar(){
      clearTimeout(vigia);
      vigia = setTimeout(function(){ usarRespaldo("PubMed no respondió en 15 segundos: se muestran los resultados del ensayo."); }, PLAZO_SILENCIO_PUBMED_MS);
    }
    function cerrar(){
      terminado = true;
      clearTimeout(vigia);
      clearInterval(aviso);
      btnRespaldoPubmed.hidden = true;
      btnVerify.disabled = false;
      // Con los veredictos a la vista, el panel apaga «Abrir la votación».
      releerTrasVerificar();
    }
    function usarRespaldo(motivo){
      if (terminado) return;
      cerrar();
      controlador.abort();
      REFS.forEach(function(r){ if (!conVeredicto[r.n]) pintarRespaldoPubmed(r.n); });
      status.textContent = motivo;
      if (!SIN_SERVIDOR) api("/api/sala/respaldo", { method: "POST", cuerpo: { tipo: "pubmed" } }).then(releerTrasVerificar).catch(nada);
    }
    btnRespaldoPubmed.onclick = function(){ usarRespaldo("Se muestran los resultados del ensayo."); };

    if (SIN_SERVIDOR) { usarRespaldo("Sin conexión: se muestran los resultados del ensayo."); return; }

    rearmar();
    status.textContent = "Verificando en PubMed…";
    api("/api/pubmed/verificar", { method: "POST", cuerpo: {}, signal: controlador.signal }).then(function(res){
      if (!res.ok) {
        marcarRed(res.status === 401 ? "sesion" : "ok");
        return res.json().catch(function(){ return {}; }).then(function(b){
          usarRespaldo((res.status === 409 ? (b.mensaje || "Ya hay una verificación en curso.") : (b.error || "El servidor no respondió.")) + " Se muestran los resultados del ensayo.");
        });
      }
      marcarRed("ok");
      var primerMensaje = true;
      return leerNdjson(res, function(m){
        if (terminado) return;
        rearmar();
        // La sala cierra la votación antes de la primera consulta: con el primer
        // mensaje ya se pueden leer sus totales finales.
        if (primerMensaje) { primerMensaje = false; releerVotacionSiAbierta(); }
        if (m.t === "evento" && m.evento) {
          var e = m.evento;
          if (e.tipo === "pubmed_buscando") {
            // La consulta que va a salir. Solo cambia el texto de la celda, que ya
            // decía «Buscando…»: la diapositiva se ve igual.
            var b = celda(e.ref);
            var via = VIA_TEXTO[e.via];
            if (b && via && consultas[e.ref] && !conVeredicto[e.ref]) {
              var previas = consultas[e.ref].filter(function(q){ return q.via !== e.via; });
              b.className = "verdict wait";
              b.textContent = previas.length
                ? "Buscando… " + textoConsultas(previas) + " · ahora por " + via + "…"
                : "Buscando por " + via + "…";
            }
          } else if (e.tipo === "pubmed_consulta") {
            var lista = consultas[e.ref].filter(function(q){ return q.via !== e.via; });
            lista.push(e);
            consultas[e.ref] = lista;
            var c = celda(e.ref);
            if (c && !conVeredicto[e.ref]) { c.className = "verdict wait"; c.textContent = "Buscando… " + textoConsultas(lista); }
          } else if (e.tipo === "pubmed_veredicto") {
            conVeredicto[e.ref] = true;
            pintarVeredicto(e.ref, e.existe, e.pmid, consultas[e.ref], e.ensayo);
          }
        } else if (m.t === "aviso") {
          status.textContent = m.mensaje + " Se usan los resultados del ensayo.";
        } else if (m.t === "sin_respaldo") {
          var s = celda(m.ref);
          if (s) { s.className = "verdict wait"; s.textContent = "PubMed no respondió y no hay respaldo del ensayo."; }
        } else if (m.t === "fin") {
          cerrar();
          status.textContent = m.ensayo ? "Terminado con resultados del ensayo del " + fechaLarga(m.fecha) + "." : "Verificación en vivo terminada.";
        }
      }).then(function(){ if (!terminado) usarRespaldo("La verificación se cortó: se muestran los resultados del ensayo."); });
    }).catch(function(){
      if (!terminado) { marcarRed("error"); usarRespaldo("Sin conexión con el servidor: se muestran los resultados del ensayo."); }
    });
  };

  /* ---------- panel de controles ---------- */
  var panel = document.getElementById("controles");
  function alternarControles(forzar){
    var mostrar = typeof forzar === "boolean" ? forzar : panel.hidden;
    panel.hidden = !mostrar;
    if (mostrar) refrescarEstado();
  }

  var listaEstado = document.getElementById("c-estado");
  var evEstado = document.getElementById("c-evidentia-estado");
  var evVivo = document.getElementById("c-evidentia-vivo");
  var evEnsayo = document.getElementById("c-evidentia-ensayo");
  if (DATOS.evidentiaEnsayo) {
    evEnsayo.href = DATOS.evidentiaEnsayo.enlace;
    evEnsayo.textContent = "Abrir el resultado del ensayo (" + fechaLarga(DATOS.evidentiaEnsayo.fecha) + ")";
    evEnsayo.hidden = false;
  }

  function filaEstado(texto, clase){
    var li = document.createElement("li");
    li.textContent = texto;
    if (clase) li.className = clase;
    listaEstado.appendChild(li);
  }

  var ESTADOS_EVIDENTIA = { queued: "en cola", running: "en marcha", waiting: "en espera", "recién lanzada": "recién lanzada", "ya estaba en curso": "ya estaba en curso" };
  function mostrarEvidentia(ev){
    if (!ev) return;
    evVivo.href = ev.enlace;
    evVivo.hidden = false;
    evEstado.textContent = ev.terminado
      ? (ev.resultado === "completo" ? "Evidentia terminó." : "Evidentia no terminó: abra el resultado del ensayo o, sin red, el PDF guardado en el escritorio.")
      : "Evidentia está trabajando (" + (ESTADOS_EVIDENTIA[ev.estado] || "en marcha") + ").";
  }

  function refrescarEstado(){
    if (SIN_SERVIDOR) {
      listaEstado.textContent = "";
      filaEstado("Copia sin red: las demos muestran los resultados del ensayo.", "alerta");
      return Promise.resolve();
    }
    var turno = ++turnoVotacion;
    return api("/api/presentador/estado").then(function(r){
      if (r.status === 401) { marcarRed("sesion"); throw new Error("sesion"); }
      if (!r.ok) throw new Error("estado");
      return r.json();
    }).then(function(d){
      marcarRed("ok");
      estadoVotacionLeido(turno, d);
      listaEstado.textContent = "";
      var vence = d.sesion && d.sesion.vence ? new Date(d.sesion.vence) : null;
      if (vence) {
        var horas = Math.round((vence.getTime() - Date.now()) / 3600000);
        filaEstado("Sesión: vence en " + horas + " h" + (horas < 6 ? ". Vuelva a entrar antes de la charla." : "."), horas < 6 ? "alerta" : "");
      }
      filaEstado("Clave de Anthropic: " + (d.configuracion.claveAnthropic ? "configurada" : "FALTA"), d.configuracion.claveAnthropic ? "" : "alerta");
      filaEstado("Token del presentador: " + (d.configuracion.tokenSeguro ? "largo suficiente" : "DEMASIADO CORTO"), d.configuracion.tokenSeguro ? "" : "alerta");
      filaEstado("Clave de NCBI: " + (d.configuracion.claveNcbi ? "sí (10 pet./s)" : "no (3 pet./s)"));
      filaEstado("Consultas a Claude hoy: " + d.claudeHoy + " de " + d.limiteClaudeDiario + " · costo registrado: US$ " + d.costos.usd.toFixed(4) + " en " + d.costos.llamadas + " llamadas");
      filaEstado("Público conectado: " + d.conexiones);
      filaEstado("Respaldo de Claude: " + (d.respaldos.claude ? fechaLarga(d.respaldos.claude) : "NO GRABADO"), d.respaldos.claude ? "" : "alerta");
      filaEstado("Respaldo de PubMed: " + (d.respaldos.pubmed ? fechaLarga(d.respaldos.pubmed) : "NO GRABADO"), d.respaldos.pubmed ? "" : "alerta");
      filaEstado("Respaldo de Evidentia: " + (d.respaldos.evidentia ? "grabado" : "NO GRABADO"), d.respaldos.evidentia ? "" : "alerta");
      filaEstado("Evidentia (/health): " + d.evidentiaSalud, d.evidentiaSalud === "ok" ? "" : "alerta");
      mostrarEvidentia(d.evidentia);
    }).catch(function(e){
      if (String(e && e.message) !== "sesion") marcarRed("error");
      estadoVotacionLeido(turno, null, String(e && e.message));
      listaEstado.textContent = "";
      filaEstado(String(e && e.message) === "sesion"
        ? "La sesión venció. Abra /presentador en otra pestaña y vuelva a entrar; esta sigue funcionando con los respaldos."
        : "Sin conexión con el servidor: las demos usarán los resultados del ensayo.", "alerta");
    });
  }

  document.getElementById("c-evidentia").onclick = function(){
    var b = this;
    if (SIN_SERVIDOR) { evEstado.textContent = "Sin conexión: abra el PDF del ensayo guardado en el escritorio."; return; }
    b.disabled = true;
    evEstado.textContent = "Enviando la pregunta…";
    api("/api/evidentia/lanzar", { method: "POST", cuerpo: {} }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){ return { r: r, d: d }; });
    }).then(function(x){
      if (x.r.ok || x.r.status === 409) {
        mostrarEvidentia({ enlace: x.d.enlace, terminado: false, estado: x.r.ok ? "recién lanzada" : "ya estaba en curso" });
      } else {
        evEstado.textContent = "No se pudo lanzar (" + (x.d.mensaje || x.d.error || x.r.status) + "). Use el resultado del ensayo.";
      }
    }).catch(function(){
      evEstado.textContent = "Sin conexión: abra el PDF del ensayo guardado en el escritorio.";
    }).then(function(){ b.disabled = false; });
  };

  /* ---------- votación del público ---------- */
  // El público vota en /vivo; aquí solo se abre, se cierra y se leen los totales,
  // que llegan con el resto del estado del panel (GET /api/presentador/estado).
  var votAbrir = document.getElementById("c-votacion-abrir");
  var votCerrar = document.getElementById("c-votacion-cerrar");
  var votEstado = document.getElementById("c-votacion-estado");
  var votDisponible = false;   // el último estado llegó: hay servidor y sesión
  var votEnviando = false;
  var ultimaVotacion = null;   // la última votación pintada, para saber si seguía abierta
  // Un aviso sobre la votación («ya estaba abierta», «no se pudo cerrar»). Se pinta
  // encima mientras la votación siga igual (mismo estado y ronda); si cambia, sobra.
  var notaVotacion = null;
  // Cada lectura del estado y cada envío toman un turno; solo la lectura del turno
  // vigente pinta la votación. Así una lectura lenta que salió antes de abrir no
  // vuelve a poner «Sin votación todavía» encima de la votación recién abierta.
  var turnoVotacion = 0;
  var SESION_VOTACION = "La sesión venció: vuelva a entrar en /presentador para abrir o cerrar la votación.";
  var SIN_RED_VOTACION = "Sin conexión con el servidor: no se puede abrir ni cerrar la votación. El panel lo comprueba de nuevo cada 20 s; si hace falta, pida que voten a mano alzada.";
  var VEREDICTOS_VOTACION = "El público ya ve la verificación en PubMed: para votar otra vez, reinicie la sala.";
  // El público ya ve los veredictos: el servidor no abre otra votación (409) y aquí
  // el botón se apaga. Llega con el estado del panel.
  var verificacionVisible = false;
  // Cuándo vio este panel abierta la ronda en curso: si nadie vota en 20 s, lo más
  // probable es que el Wi-Fi del público falle aunque el del portátil funcione.
  var abiertaDesde = { ronda: null, ts: 0 };
  var PLAZO_SIN_VOTOS_MS = 20000;
  var REFRESCO_ABIERTA_MS = 5000;

  function botonesVotacion(){
    votAbrir.disabled = votEnviando || !votDisponible || verificacionVisible;
    votCerrar.disabled = votEnviando || !votDisponible;
  }

  function lineasVotacion(lineas){
    votEstado.textContent = "";
    lineas.forEach(function(t, k){
      if (k > 0) votEstado.appendChild(document.createElement("br"));
      votEstado.appendChild(document.createTextNode(t));
    });
  }

  function plural(n, uno, varios){ return n + " " + (n === 1 ? uno : varios); }
  function claveVotacion(v){ return v ? v.estado + ":" + v.ronda : "ninguna"; }

  function mostrarVotacion(v){
    ultimaVotacion = v && v.estado ? v : null;
    if (notaVotacion && notaVotacion.clave !== claveVotacion(ultimaVotacion)) notaVotacion = null;
    var lineas = notaVotacion ? [notaVotacion.texto] : [];
    if (!ultimaVotacion) {
      lineas.push("Sin votación todavía.");
      if (verificacionVisible) lineas.push(VEREDICTOS_VOTACION);
      lineasVotacion(lineas);
      return;
    }
    var abierta = v.estado === "abierta";
    if (abierta && abiertaDesde.ronda !== v.ronda) abiertaDesde = { ronda: v.ronda, ts: Date.now() };
    lineas.push(abierta ? "Abierta · ronda " + v.ronda : "Cerrada · ronda " + v.ronda + " · totales finales");
    if (Array.isArray(v.conteos)) {
      var total = 0;
      v.conteos.forEach(function(c){
        var si = Number(c.si) || 0, no = Number(c.no) || 0;
        total += si + no;
        lineas.push(c.ref + ": " + si + " sí · " + no + " no");
      });
      lineas.push("Total: " + plural(total, "voto", "votos") +
        (typeof v.votantes === "number" ? " de " + plural(v.votantes, "votante", "votantes") : ""));
      // El mismo patrón que Claude y PubMed: si no llega nada, el panel lo dice solo.
      var espera = Date.now() - abiertaDesde.ts;
      if (abierta && total === 0 && espera >= PLAZO_SIN_VOTOS_MS) {
        lineas.push("Nadie ha votado en " + Math.round(espera / 1000) + " s. Si el Wi-Fi de la sala falla, pida el voto a mano alzada (¿cuántas de las cinco existen?) y cierre la votación.");
      }
    }
    if (!abierta && verificacionVisible) lineas.push(VEREDICTOS_VOTACION);
    lineasVotacion(lineas);
  }

  /** Lo que devolvió GET /api/presentador/estado, o `null` si falló; `motivo` dice por qué. */
  function estadoVotacionLeido(turno, d, motivo){
    if (turno !== turnoVotacion || votEnviando) return;
    if (d) {
      votDisponible = true;
      verificacionVisible = d.verificacionALaVista === true;
      mostrarVotacion(d.votacion);
    } else {
      votDisponible = false;
      notaVotacion = null;
      lineasVotacion([motivo === "sesion" ? SESION_VOTACION : SIN_RED_VOTACION]);
    }
    botonesVotacion();
  }

  // Verificar en PubMed cierra la votación en el servidor. Si aquí seguía abierta,
  // se vuelve a leer el estado para tener ya los totales finales.
  function releerVotacionSiAbierta(){
    if (!SIN_SERVIDOR && ultimaVotacion && ultimaVotacion.estado === "abierta") refrescarEstado();
  }
  // Al terminar la verificación (en vivo o con el ensayo): totales finales y el
  // botón de abrir apagado, porque el público ya ve los veredictos.
  function releerTrasVerificar(){
    if (!SIN_SERVIDOR) refrescarEstado();
  }

  function enviarVotacion(abrir){
    if (SIN_SERVIDOR || votEnviando) return;
    votEnviando = true;
    turnoVotacion++;
    notaVotacion = null;
    botonesVotacion();
    lineasVotacion([abrir ? "Abriendo la votación…" : "Cerrando la votación…"]);
    api("/api/sala/votacion", { method: "POST", cuerpo: { abrir: abrir } }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){ return { r: r, d: d }; });
    }).then(function(x){
      votEnviando = false;
      if (x.r.status === 401) {
        marcarRed("sesion");
        votDisponible = false;
        lineasVotacion([SESION_VOTACION]);
      } else if (x.r.ok) {
        marcarRed("ok");
        votDisponible = true;
        var v = x.d.estado ? { estado: x.d.estado, ronda: x.d.ronda } : null;
        // Un segundo clic en «Abrir» no borra los votos: el servidor sigue con la misma ronda.
        if (abrir && x.d.repetida) {
          notaVotacion = { clave: claveVotacion(v), texto: "Ya estaba abierta: sigue la ronda " + x.d.ronda + " con sus votos. Para empezar de cero, ciérrela y vuelva a abrirla." };
        }
        // Lo que ya se sabe, mientras llegan los totales: si la votación no cambió,
        // la que ya estaba pintada, con sus números.
        mostrarVotacion(claveVotacion(v) === claveVotacion(ultimaVotacion) ? ultimaVotacion : v);
      } else {
        notaVotacion = {
          clave: claveVotacion(ultimaVotacion),
          texto: "No se pudo " + (abrir ? "abrir" : "cerrar") + " la votación. " + (x.d.mensaje || x.d.error || "HTTP " + x.r.status)
        };
        mostrarVotacion(ultimaVotacion);
      }
      botonesVotacion();
      refrescarEstado();
    }).catch(function(){
      // Sin respuesta: se vuelve a leer el estado, que decide si los botones siguen.
      votEnviando = false;
      marcarRed("error");
      lineasVotacion(["Sin conexión con el servidor: no se sabe si la votación se " + (abrir ? "abrió" : "cerró") + ". Comprobando…"]);
      botonesVotacion();
      refrescarEstado();
    });
  }

  votAbrir.onclick = function(){ enviarVotacion(true); };
  votCerrar.onclick = function(){ enviarVotacion(false); };
  if (SIN_SERVIDOR) lineasVotacion(["Copia sin red: la votación necesita el servidor. Si hace falta, pida que voten a mano alzada."]);
  else lineasVotacion(["Comprobando la conexión…"]);
  botonesVotacion();

  document.getElementById("c-aviso").onsubmit = function(ev){
    ev.preventDefault();
    var campo = document.getElementById("c-aviso-texto");
    var texto = campo.value.trim();
    if (!texto || SIN_SERVIDOR) return;
    api("/api/sala/aviso", { method: "POST", cuerpo: { texto: texto } }).then(function(r){
      document.getElementById("c-aviso-estado").textContent = r.ok ? "Enviado." : "No se pudo enviar.";
      if (r.ok) campo.value = "";
    }).catch(function(){ document.getElementById("c-aviso-estado").textContent = "Sin conexión."; });
  };

  document.getElementById("c-reiniciar").onclick = function(){
    if (SIN_SERVIDOR) return;
    if (!confirm("¿Reiniciar la sala? El público verá la página vacía y las demos volverán a empezar.")) return;
    api("/api/sala/reiniciar", { method: "POST", cuerpo: {} }).then(function(r){
      document.getElementById("c-aviso-estado").textContent = r.ok ? "Sala reiniciada." : "No se pudo reiniciar.";
      ultimaAvisada = 0;
      avisarDiapositiva(i + 1);
      // Reiniciar cierra la votación y borra sus votos.
      refrescarEstado();
    }).catch(nada);
  };

  /* ---------- arranque ---------- */
  var start = parseInt((location.hash || "").replace("#", ""), 10);
  show(isNaN(start) ? 0 : start - 1);

  if (SIN_SERVIDOR) {
    marcarRed("error");
    status.textContent = "Copia sin red: los botones muestran los resultados del ensayo.";
  } else {
    status.textContent = "Comprobando la conexión…";
    refrescarEstado().then(function(){
      var ok = punto.className.indexOf(" ok") >= 0;
      status.textContent = ok
        ? "Claude y PubMed disponibles. Si algo falla, aparecen los resultados del ensayo."
        : "Sin conexión: los botones mostrarán los resultados del ensayo.";
    });
    setInterval(function(){ refrescarEstado(); }, 20000);
    // Con la votación abierta y el panel a la vista, los totales cada 5 s: así el aviso
    // de que nadie vota aparece a tiempo.
    setInterval(function(){
      if (!panel.hidden && !votEnviando && ultimaVotacion && ultimaVotacion.estado === "abierta") refrescarEstado();
    }, REFRESCO_ABIERTA_MS);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw-presentador.js", { scope: "/presentador" }).catch(nada);
    }
  }
})();
