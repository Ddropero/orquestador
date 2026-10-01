/*
 * /vivo — la página del QR.
 *
 * Reglas que no se negocian aquí:
 *  - Todo texto recibido se pinta con textContent; nada se interpreta como HTML.
 *  - Una referencia fabricada solo aparece junto a su veredicto y con la etiqueta de
 *    ejercicio docente. Antes del veredicto se ve el número de la referencia y los
 *    pasos de su búsqueda, sin la cita y sin el texto de las consultas. El DOI
 *    inventado no viene en los datos de la página: de él solo se dice "el DOI citado".
 *  - La página lee la sala por el WebSocket (o por sondeo) y envía una sola cosa: el
 *    voto del público, por fetch a POST /api/sala/voto. Por el WebSocket, que es de
 *    solo lectura, no sale nada salvo el "ping" que lo mantiene vivo. Votar no llama
 *    a Claude ni a PubMed.
 *  - El voto es anónimo: un código al azar guardado en el celular evita que se cuente
 *    dos veces. Mientras la votación está abierta no se muestran porcentajes, para no
 *    influir en quien todavía no ha votado; ni siquiera llegan a la página: la sala
 *    solo manda cuántos votos van, y el desglose al cerrar.
 *  - Cada voto tiene plazo: con la red colgada (portal cautivo, Wi-Fi saturado) los
 *    botones vuelven a funcionar y la persona sabe que tiene que repetirlo.
 *  - Cada zona se repinta solo cuando cambian sus eventos: los totales de la votación
 *    llegan cada segundo y reconstruir los botones a esa cadencia perdería toques y
 *    el foco del teclado.
 */
(function(){
  "use strict";

  var DATOS = JSON.parse(document.getElementById("datos-vivo").textContent);
  var REFS = {};
  DATOS.referencias.forEach(function(r){ REFS[r.n] = r; });
  var PASOS = Array.isArray(DATOS.pasos) ? DATOS.pasos : [];
  // Resultados que la sala abre y compara por cada búsqueda (los primeros de PubMed).
  var ABIERTOS = typeof DATOS.resultadosAbiertos === "number" ? DATOS.resultadosAbiertos : 20;
  // La diapositiva que presenta los siete pasos va justo antes de la del paso 01.
  var DIAPO_MAPA = PASOS.length ? PASOS[0].diapositiva - 1 : null;

  var VIAS = ["título", "DOI", "autor"];
  var CLAVE_VIA = { "título": "titulo", "DOI": "doi", "autor": "autor" };

  var SONDEO_MS = 5000;
  var PING_MS = 25000;
  var AVISO_COPIA_MS = 3000;
  // El mismo plazo que usa el panel del presentador para sus peticiones.
  var PLAZO_VOTO_MS = 8000;
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
  /** Cambia el texto solo si es distinto: un lector de pantalla no repite lo que no cambió. */
  function texto(nodo, t){ if (nodo.textContent !== t) nodo.textContent = t; }
  function marcar(nodo, clase, si){ if (si) nodo.classList.add(clase); else nodo.classList.remove(clase); }
  function enlaceExterno(a){ a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }
  function pmidValido(p){ return typeof p === "string" && /^\d{1,9}$/.test(p); }
  function cifra(x){ return typeof x === "number" && isFinite(x) && x >= 0 ? x : null; }
  function plural(n, uno, varios){ return n + " " + (n === 1 ? uno : varios); }
  function numeroPaso(p){ return (p.paso < 10 ? "0" : "") + p.paso; }
  var NOMBRE_VIA = { titulo: "título", doi: "DOI", autor: "autor" };
  function nombreVia(via){ return NOMBRE_VIA[via] || via; }

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

  /* ---------- almacenamiento del celular ---------- */

  // localStorage puede no existir o lanzar (modo privado, cuota, bloqueo). Todo va
  // envuelto: si falla, el votante y sus votos viven en memoria mientras dure la página.
  function leerLocal(clave){
    try { return window.localStorage.getItem(clave); } catch (e) { return null; }
  }
  function guardarLocal(clave, valor){
    try { window.localStorage.setItem(clave, valor); } catch (e) { /* queda en memoria */ }
  }

  /** Código al azar en base64url (24 caracteres). No identifica a nadie: solo evita contar dos veces un voto. */
  function codigoAlAzar(){
    var bytes = new Uint8Array(18);
    var c = window.crypto || window.msCrypto;
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    // Sin crypto (navegadores muy viejos) basta con que no se repita entre celulares.
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var bin = "";
    for (var k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  var VOTANTE = (function(){
    var guardado = leerLocal("charla-votante");
    if (guardado && /^[A-Za-z0-9_-]{16,64}$/.test(guardado)) return guardado;
    var nuevo = codigoAlAzar();
    guardarLocal("charla-votante", nuevo);
    return nuevo;
  })();

  // Los votos propios, solo de la ronda en curso: {ronda, votos: {n: true|false}}.
  var misVotosRonda = null;
  function misVotos(ronda){
    if (!misVotosRonda || misVotosRonda.ronda !== ronda) {
      var votos = {};
      try {
        var g = JSON.parse(leerLocal("charla-votos") || "null");
        if (g && g.ronda === ronda && g.votos && typeof g.votos === "object") {
          Object.keys(REFS).forEach(function(n){ if (typeof g.votos[n] === "boolean") votos[n] = g.votos[n]; });
        }
      } catch (e) { /* un valor corrupto se ignora */ }
      misVotosRonda = { ronda: ronda, votos: votos };
    }
    return misVotosRonda.votos;
  }
  function guardarVoto(ronda, n, existe){
    misVotos(ronda)[n] = existe;
    guardarLocal("charla-votos", JSON.stringify(misVotosRonda));
  }

  /* ---------- estado ---------- */

  function valido(e){ return e && typeof e === "object" && typeof e.seq === "number" && typeof e.tipo === "string"; }

  // De estos tipos solo importa el último, igual que en compactar() del servidor: así
  // el celular no acumula un evento de totales por segundo durante la votación.
  var UNICOS = { diapositiva: true, claude_texto: true, pubmed_buscando: true, evidentia_embudo: true, votacion: true, votos: true, chat_texto: true, chat_fuentes: true };

  /** Suma un evento al estado sin pintar. Devuelve true si cambió algo. */
  function incorporar(e){
    if (!valido(e)) return false;
    for (var k = 0; k < eventos.length; k++) {
      if (eventos[k].seq === e.seq) return false;
      // Un sondeo puede traer una foto anterior a lo que ya llegó por el socket.
      if (UNICOS[e.tipo] && eventos[k].tipo === e.tipo && eventos[k].seq > e.seq) return false;
    }
    if (UNICOS[e.tipo]) eventos = eventos.filter(function(x){ return x.tipo !== e.tipo; });
    eventos.push(e);
    return true;
  }
  function ordenar(){ eventos.sort(function(a, b){ return a.seq - b.seq; }); }

  function agregar(e){
    if (!incorporar(e)) return;
    ordenar();
    pintar();
  }

  function mayorSeq(lista){
    var m = -1;
    lista.forEach(function(e){ if (valido(e) && e.seq > m) m = e.seq; });
    return m;
  }

  function reemplazar(lista){
    lista = Array.isArray(lista) ? lista : [];
    // Una foto más vieja que lo que ya se ve (la del sondeo puede venir de la caché de
    // 1 s del servidor) solo suma: si reemplazara, la diapositiva podría volver atrás.
    // Tras un reinicio la sala sigue numerando hacia arriba, así que una foto nueva
    // siempre gana; la foto vacía del reinicio (código 4000) sí borra.
    if (lista.length > 0 && eventos.length > 0 && mayorSeq(lista) < mayorSeq(eventos)) {
      lista.forEach(incorporar);
      ordenar();
      pintar();
      return;
    }
    eventos = [];
    lista.forEach(incorporar);
    ordenar();
    pintar();
  }

  function ultimo(tipo){
    for (var k = eventos.length - 1; k >= 0; k--) if (eventos[k].tipo === tipo) return eventos[k];
    return null;
  }

  /** Eventos de un tema a partir de su último inicio. Una demo repetida reemplaza a la anterior. */
  function desdeUltimoInicio(tema, tipos){
    var inicio = -1;
    for (var k = eventos.length - 1; k >= 0; k--) {
      if (eventos[k].tipo === "demo_inicio" && eventos[k].tema === tema) { inicio = k; break; }
    }
    return eventos.slice(inicio + 1).filter(function(e){ return tipos.indexOf(e.tipo) >= 0; });
  }

  /** La verificación en PubMed: consultas por referencia y vía, veredictos y la búsqueda en curso. */
  function estadoVerificacion(){
    var est = { evs: [], consultas: {}, veredictos: {}, buscando: null, ensayo: {} };
    est.evs = desdeUltimoInicio("verificacion", ["pubmed_buscando", "pubmed_consulta", "pubmed_veredicto"]);
    est.evs.forEach(function(e){
      if (!REFS[e.ref]) return;
      if (e.ensayo) est.ensayo[e.ref] = true;
      if (e.tipo === "pubmed_buscando") {
        est.buscando = e;
      } else if (e.tipo === "pubmed_consulta") {
        est.consultas[e.ref] = est.consultas[e.ref] || {};
        est.consultas[e.ref][e.via] = e;
      } else {
        est.veredictos[e.ref] = e;
      }
    });
    return est;
  }

  /** ¿La sala está consultando ahora mismo esta vía de esta referencia? */
  function buscandoAhora(est, n, via){
    var b = est.buscando;
    if (!b || b.ref !== n || b.via !== via || est.veredictos[n]) return false;
    var c = est.consultas[n] && est.consultas[n][via];
    return !(c && c.seq > b.seq);
  }

  // Firma de lo que pintó cada zona la última vez: los seq identifican el contenido.
  var firmas = {};
  function cambio(zona, firma){
    if (firmas[zona] === firma) return false;
    firmas[zona] = firma;
    return true;
  }
  function seqs(lista){ return lista.map(function(e){ return e.seq; }).join(","); }

  /* ---------- pintura ---------- */

  function pintar(){
    var est = estadoVerificacion();
    pintarDiapositiva();
    pintarAhora(est);
    pintarVotacion(est);
    pintarResumen(est);
    pintarReferencias(est);
    pintarChat();
    pintarEvidentia();
    pintarPasos();
    pintarAvisos();
    pintarLinea();
  }

  function pasoDeDiapositiva(n){
    for (var k = 0; k < PASOS.length; k++) if (PASOS[k].diapositiva === n) return PASOS[k];
    return null;
  }
  function pasosDeDiapositiva(n){
    return PASOS.filter(function(p){ return p.diapositiva === n; });
  }

  function pintarDiapositiva(){
    var d = ultimo("diapositiva");
    var caja = $("diapo-paso");
    if (!d) {
      texto($("diapo-n"), "–");
      texto($("diapo-total"), "");
      texto($("diapo-titulo"), "La charla todavía no ha empezado.");
      caja.hidden = true;
      return;
    }
    texto($("diapo-n"), String(d.n));
    texto($("diapo-total"), "de " + DATOS.totalDiapositivas);
    texto($("diapo-titulo"), d.titulo);
    // Atajo al mapa cuando la diapositiva es uno de los siete pasos o su presentación.
    var paso = pasoDeDiapositiva(d.n);
    var enlace = $("diapo-paso-enlace");
    var destino = paso ? "#paso-" + paso.paso : d.n === DIAPO_MAPA ? "#pasos" : null;
    caja.hidden = !destino;
    if (!destino) return;
    if (enlace.getAttribute("href") !== destino) enlace.setAttribute("href", destino);
    var enPantalla = pasosDeDiapositiva(d.n);
    var cuales = enPantalla.length > 1
      ? "los pasos " + numeroPaso(enPantalla[0]) + " a " + numeroPaso(enPantalla[enPantalla.length - 1]) + " en el mapa y copiar sus prompts"
      : paso ? "el paso " + numeroPaso(paso) + " en el mapa y copiar su prompt" : "el mapa de los siete pasos";
    texto(enlace, "Ver " + cuales);
  }

  /* ---------- «Ahora»: qué pasa en la tarima ---------- */

  var TIPOS_AHORA = {
    diapositiva: true, demo_inicio: true, claude_texto: true, pubmed_buscando: true, pubmed_consulta: true,
    pubmed_veredicto: true, evidentia_etapa: true, evidentia_embudo: true, chat_paso: true, chat_fuentes: true, chat_texto: true
  };

  /** Una línea sobre lo que ocurre en la tarima, o null si no hay nada en marcha. */
  function textoAhora(est){
    var v = ultimo("votacion");
    if (v && v.estado === "abierta") return { texto: "Votación abierta: vote en cada referencia.", voto: true };
    var e = null;
    for (var k = eventos.length - 1; k >= 0; k--) if (TIPOS_AHORA[eventos[k].tipo]) { e = eventos[k]; break; }
    if (!e) return null;
    var ensayo = e.ensayo ? " (respuesta del ensayo)" : "";
    switch (e.tipo) {
      case "diapositiva":
        return null;
      case "demo_inicio":
        if (e.tema === "resumen") return { texto: "El modelo responde sin buscar. Mire la pantalla." };
        if (e.tema === "verificacion") return { texto: "PubMed empieza a verificar las cinco." };
        if (e.tema === "chat") return { texto: "El mismo chat, ahora con PubMed: buscando." };
        if (e.tema === "evidentia") return { texto: "Evidentia empieza a trabajar la pregunta." };
        return null;
      case "claude_texto":
        return { texto: "El modelo responde sin buscar" + ensayo + ". Mire la pantalla." };
      case "pubmed_buscando":
      case "pubmed_consulta":
        return { texto: "PubMed verifica la referencia " + e.ref + (e.via ? " por " + nombreVia(e.via) : "") + ensayo + "." };
      case "pubmed_veredicto": {
        var faltan = 0;
        Object.keys(REFS).forEach(function(n){ if (!est.veredictos[n]) faltan++; });
        if (faltan === 0) return { texto: "PubMed ya verificó las cinco. Compare con su voto." };
        return { texto: "PubMed: la referencia " + e.ref + (e.existe ? " existe" : " no existe") + ensayo + ". Faltan " + faltan + "." };
      }
      case "chat_paso":
        return { texto: "Chat con PubMed · " + textoPasoChat(e) + (e.estado === "en curso" ? "…" : " · " + e.estado) + ensayo };
      case "chat_fuentes":
        return { texto: "El modelo ya tiene los resúmenes de PubMed y va a responder" + ensayo + "." };
      case "chat_texto":
        return { texto: "El modelo responde solo con los resúmenes de PubMed" + ensayo + "." };
      case "evidentia_etapa":
        return { texto: "Evidentia · " + e.etapa + (e.estado === "en curso" ? "…" : " · " + e.estado) };
      case "evidentia_embudo":
        return { texto: "Evidentia terminó: el embudo en cifras está más abajo" + ensayo + "." };
    }
    return null;
  }

  function pintarAhora(est){
    var a = textoAhora(est);
    var nodo = $("ahora");
    nodo.hidden = !a;
    if (!a) return;
    texto(nodo, a.texto);
    marcar(nodo, "ahora-voto", !!a.voto);
  }

  /* ---------- votación ---------- */

  var voto = { ronda: null, estado: null, nodos: {}, enviando: {}, mensaje: "" };

  var MENSAJES_VOTO = {
    400: "No se pudo registrar su voto. Recargue la página e inténtelo de nuevo.",
    403: "No se pudo registrar su voto desde esta página. Recárguela e inténtelo de nuevo.",
    409: "La votación ya está cerrada: ese voto no se contó.",
    413: "No se pudo registrar su voto. Recargue la página e inténtelo de nuevo.",
    429: "Hay muchos votos al mismo tiempo. Espere unos segundos e inténtelo de nuevo.",
    503: "La votación alcanzó el máximo de participantes: ese voto no se contó."
  };

  /** Los botones se construyen una vez por ronda; después solo se actualizan en su sitio. */
  function construirVotacion(ronda){
    voto.ronda = ronda;
    voto.estado = null;
    voto.nodos = {};
    voto.enviando = {};
    voto.mensaje = "";
    var lista = $("votos-lista");
    vaciar(lista);
    DATOS.referencias.forEach(function(r){
      var n = r.n;
      var li = el("li", "voto");
      li.setAttribute("data-ref", String(n));
      // Solo el número: las citas se leen en la pantalla del auditorio.
      var pregunta = el("p", "voto-pregunta", "Referencia " + n + ": ¿existe?");
      pregunta.id = "voto-pregunta-" + n;
      var botones = el("div", "voto-botones");
      botones.setAttribute("role", "group");
      botones.setAttribute("aria-labelledby", pregunta.id);
      var si = el("button", "voto-si", "Sí");
      var no = el("button", "voto-no", "No");
      [si, no].forEach(function(b){
        b.type = "button";
        b.setAttribute("data-ref", String(n));
        b.setAttribute("aria-pressed", "false");
        botones.appendChild(b);
      });
      si.addEventListener("click", function(){ votar(n, true); });
      no.addEventListener("click", function(){ votar(n, false); });
      var propio = el("p", "voto-propio");
      var resultado = el("div", "voto-resultado");
      resultado.hidden = true;
      var barra = el("div", "barra");
      barra.setAttribute("aria-hidden", "true");
      var relleno = el("span", "relleno");
      barra.appendChild(relleno);
      var cifraVoto = el("p", "voto-cifra");
      resultado.appendChild(barra);
      resultado.appendChild(cifraVoto);
      li.appendChild(pregunta);
      li.appendChild(botones);
      li.appendChild(propio);
      li.appendChild(resultado);
      lista.appendChild(li);
      voto.nodos[n] = { li: li, si: si, no: no, botones: botones, propio: propio, resultado: resultado, relleno: relleno, cifra: cifraVoto };
    });
  }

  function pintarVotacion(est){
    var seccion = $("votacion");
    var v = ultimo("votacion");
    if (!v) {
      seccion.hidden = true;
      if (voto.ronda !== null) { voto.ronda = null; vaciar($("votos-lista")); }
      return;
    }
    seccion.hidden = false;
    if (voto.ronda !== v.ronda) construirVotacion(v.ronda);
    var abierta = v.estado === "abierta";
    // Al cerrarse, un aviso de la votación abierta ya no aplica.
    if (voto.estado === "abierta" && !abierta) voto.mensaje = "";
    voto.estado = v.estado;
    marcar(seccion, "abierta", abierta);
    texto($("votacion-estado"), abierta
      ? "Votación abierta. Lea las referencias en la pantalla del auditorio: aquí solo van sus números. Puede cambiar su voto mientras siga abierta."
      : "Votación cerrada. Así votó el público:");

    // Abierta: la sala manda solo `total`. Cerrada: `conteos`, el desglose por referencia.
    var conteos = {};
    var total = 0;
    var t = ultimo("votos");
    if (t && t.ronda === v.ronda) {
      if (Array.isArray(t.conteos)) {
        t.conteos.forEach(function(c){
          if (!voto.nodos[c.ref] || cifra(c.si) === null || cifra(c.no) === null) return;
          conteos[c.ref] = c;
          total += c.si + c.no;
        });
      } else if (cifra(t.total) !== null) {
        total = t.total;
      }
    }
    var mios = misVotos(v.ronda);

    DATOS.referencias.forEach(function(r){
      var n = r.n;
      var x = voto.nodos[n];
      var mio = mios[n];
      var ver = est.veredictos[n];
      x.botones.hidden = !abierta;
      x.si.setAttribute("aria-pressed", mio === true ? "true" : "false");
      x.no.setAttribute("aria-pressed", mio === false ? "true" : "false");
      x.si.disabled = x.no.disabled = !!voto.enviando[n];
      marcar(x.li, "votada", mio !== undefined);
      var propio;
      if (mio === undefined) {
        propio = abierta ? "Todavía no ha votado." : "No votó en esta referencia.";
      } else {
        propio = "Su voto: " + (mio ? "sí existe" : "no existe");
        if (!abierta && ver) propio += ver.existe === mio ? " · acertó" : " · no acertó";
      }
      texto(x.propio, propio);

      // Los porcentajes no existen en la página mientras la votación sigue abierta.
      x.resultado.hidden = abierta;
      marcar(x.li, "existe", !abierta && !!ver && ver.existe);
      marcar(x.li, "no-existe", !abierta && !!ver && !ver.existe);
      if (abierta) {
        x.relleno.style.width = "0%";
        texto(x.cifra, "");
        return;
      }
      var c = conteos[n] || { si: 0, no: 0 };
      var votos = c.si + c.no;
      var pct = votos ? Math.round(c.si * 100 / votos) : 0;
      x.relleno.style.width = pct + "%";
      var frase = votos === 0
        ? "Sin votos"
        : (ver ? "El " + pct + " % creyó que existía" : "El " + pct + " % cree que existe") + " (" + plural(votos, "voto", "votos") + ")";
      frase += " · PubMed: " + (ver ? (ver.existe ? "existe" : "no existe") : "por verificar");
      texto(x.cifra, frase);
    });

    texto($("votacion-participacion"), total === 0
      ? "Participación: todavía no hay votos."
      : "Participación: " + plural(total, "voto", "votos") + " en total.");
    pintarAcierto(abierta, mios, est);
    texto($("votacion-mensaje"), voto.mensaje);
  }

  /** Cerrada la votación y con los cinco veredictos: «Usted acertó 3 de 5». */
  function pintarAcierto(abierta, mios, est){
    var nodo = $("votacion-acierto");
    var votadas = 0, aciertos = 0, verificadas = 0;
    Object.keys(REFS).forEach(function(n){
      if (est.veredictos[n]) verificadas++;
      if (mios[n] === undefined) return;
      votadas++;
      if (est.veredictos[n] && est.veredictos[n].existe === mios[n]) aciertos++;
    });
    var total = Object.keys(REFS).length;
    var mostrar = !abierta && votadas > 0;
    nodo.hidden = !mostrar;
    if (!mostrar) return;
    if (verificadas < total) {
      texto(nodo, "PubMed sigue verificando: su acierto aparece aquí al final.");
      return;
    }
    var t = "Usted acertó " + aciertos + " de " + votadas + ".";
    if (votadas < total) t += " Votó " + votadas + " de las " + total + ".";
    else if (aciertos === total) t += " Las cinco.";
    texto(nodo, t);
  }

  function votar(n, existe){
    var v = ultimo("votacion");
    if (!v || v.estado !== "abierta" || voto.enviando[n]) return;
    var ronda = v.ronda;
    if (misVotos(ronda)[n] === existe) {
      voto.mensaje = "Su voto de la referencia " + n + " ya estaba registrado.";
      pintar();
      return;
    }
    voto.enviando[n] = true;
    voto.mensaje = "Enviando su voto…";
    pintar();
    var hecho = false;
    var plazo = null;
    var terminar = function(mensaje){
      // Una sola vez: lo que llegue después del plazo ya no cambia nada.
      if (hecho) return;
      hecho = true;
      clearTimeout(plazo);
      // Si entretanto se abrió otra ronda, el aviso ya no corresponde.
      if (voto.ronda !== ronda) return;
      voto.enviando[n] = false;
      voto.mensaje = mensaje;
      pintar();
    };
    // AbortController no existe en navegadores viejos: ahí el plazo igual libera los
    // botones, y la respuesta tardía se ignora. Repetir el voto no cuenta dos veces.
    var controlador = null;
    try { controlador = typeof AbortController === "function" ? new AbortController() : null; } catch (e) { controlador = null; }
    plazo = setTimeout(function(){
      if (controlador) { try { controlador.abort(); } catch (e) { /* ya terminó */ } }
      terminar("No se pudo confirmar su voto: la conexión no respondió. Inténtelo de nuevo.");
    }, PLAZO_VOTO_MS);
    var opciones = {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ votante: VOTANTE, ronda: ronda, ref: n, existe: existe })
    };
    if (controlador) opciones.signal = controlador.signal;
    var fallo = function(){ terminar("No se pudo enviar su voto: revise la conexión e inténtelo de nuevo."); };
    var envio;
    try { envio = fetch("/api/sala/voto", opciones); } catch (e) { fallo(); return; }
    envio.then(function(r){
      if (hecho) return;
      if (r.ok) {
        if (voto.ronda === ronda) guardarVoto(ronda, n, existe);
        terminar("Voto registrado: referencia " + n + ", " + (existe ? "sí existe" : "no existe") + ".");
        return;
      }
      // Cerrada o de otra ronda: el estado de la sala trae la votación que vale.
      if (r.status === 409) sondear();
      terminar(MENSAJES_VOTO[r.status] || "No se pudo registrar su voto. Inténtelo de nuevo en unos segundos.");
    }, fallo);
  }

  /* ---------- resumen del modelo frente a PubMed ---------- */

  /** Los textos que nombran la referencia resumida salen de los datos, no del HTML: si cambia, no mienten. */
  function textosResumen(){
    var n = DATOS.refResumen;
    texto($("resumen-sello"), "Texto generado por IA sin verificar y sin buscar en ninguna base de datos · Ejercicio docente: se le pidió el resumen de la referencia " + n + " de la lista · No es evidencia clínica");
    texto($("resumen-veredicto"), "La referencia " + n + " no existe. Con cautela o sin ella, el modelo no lo podía saber sin buscar: lo decidió PubMed.");
  }

  function textoBusquedaCorto(c){
    var t = "Por " + c.via + ": " + plural(c.resultados, "resultado", "resultados");
    if (c.resultados > 0) t += c.coincide ? ", coincide" : c.resultados === 1 ? ", no es este artículo" : ", ninguno es este artículo";
    return t;
  }

  function pintarResumen(est){
    var textos = desdeUltimoInicio("resumen", ["claude_texto"]);
    var ultimoTexto = textos[textos.length - 1];
    var seccion = $("resumen");
    if (!ultimoTexto) { seccion.hidden = true; return; }
    seccion.hidden = false;
    texto($("resumen-texto"), ultimoTexto.texto_parcial);
    $("resumen-ensayo").hidden = !ultimoTexto.ensayo;

    var n = DATOS.refResumen;
    var v = est.veredictos[n] || null;
    var consultas = est.consultas[n] || {};
    var firma = v ? v.seq + "|" + VIAS.map(function(via){ return consultas[via] ? consultas[via].seq : "-"; }).join(",") : "-";
    if (!cambio("comparacion", firma)) return;

    // Con el texto del modelo Y el veredicto de su referencia, lado a lado.
    var comparar = !!v;
    marcar(seccion, "lado-a-lado", comparar);
    texto($("resumen-titulo"), comparar ? "El modelo frente a PubMed" : "Lo que respondió el modelo, sin buscar");
    $("col-modelo-titulo").hidden = !comparar;
    $("col-pubmed").hidden = !comparar;
    $("resumen-veredicto").hidden = !(v && v.existe === false);
    var titular = $("resumen-titular");
    titular.hidden = !comparar;
    var detalle = $("pubmed-detalle");
    vaciar(detalle);
    if (!comparar) return;

    marcar(titular, "falso", !v.existe);
    texto(titular, v.existe
      ? "El artículo existe: compare el resumen del modelo con el original antes de darlo por bueno."
      : "El modelo, sin buscar, no podía saber si este artículo existe. PubMed sí: no existe.");
    // Solo el número: la cita (y su etiqueta si es fabricada) está en la lista de referencias.
    detalle.appendChild(el("p", "col-ref", "Referencia " + n + ", la que se le pidió al modelo"));
    if (v.existe && pmidValido(v.pmid)) {
      var s = el("p", "veredicto si", "Existe en PubMed · PMID ");
      var a = enlaceExterno(el("a", null, v.pmid));
      a.href = "https://pubmed.ncbi.nlm.nih.gov/" + v.pmid + "/";
      s.appendChild(a);
      detalle.appendChild(s);
    } else {
      detalle.appendChild(el("p", "veredicto no", "No existe en PubMed: ninguna búsqueda encontró este artículo."));
    }
    var hechas = VIAS.filter(function(via){ return consultas[via]; });
    if (hechas.length) {
      var ul = el("ul", "busquedas");
      hechas.forEach(function(via){ ul.appendChild(el("li", null, textoBusquedaCorto(consultas[via]))); });
      detalle.appendChild(ul);
    }
    if (v.ensayo || est.ensayo[n]) detalle.appendChild(el("p", "ensayo", etiquetaEnsayo()));
    var ir = el("a", "ir-consultas", "Ver las consultas exactas en la lista de referencias");
    ir.href = "#ref-" + n;
    detalle.appendChild(el("p", null)).appendChild(ir);
  }

  /* ---------- referencias: la tubería de verificación ---------- */

  function textoResultado(c){
    var t = plural(c.resultados, "resultado", "resultados");
    if (c.resultados === 0) return t + " · no hubo nada que abrir";
    var abiertos = Math.min(c.resultados, ABIERTOS);
    return t + " · abrió " + abiertos + " y comparó su DOI y su título con la cita: " +
      (c.coincide ? "coincide" : abiertos === 1 ? "no es este artículo" : "ninguno es este artículo");
  }

  /** La consulta exacta, para que el médico la repita. Solo se llama con el veredicto ya dado. */
  function consultaExacta(r, via){
    var q = r.consultas ? r.consultas[CLAVE_VIA[via]] : null;
    var caja = el("span", "consulta");
    caja.appendChild(el("span", "consulta-rotulo", "Consulta: "));
    if (typeof q !== "string" || !q) {
      // El DOI de una fabricada no está en la página: solo se dice que se buscó.
      if (via !== "DOI") return null;
      caja.appendChild(el("span", "consulta-texto sin-texto", "el DOI citado"));
      return caja;
    }
    caja.appendChild(el("code", "consulta-texto", q));
    var a = enlaceExterno(el("a", "repetir", "Repetir esta búsqueda en PubMed"));
    a.href = "https://pubmed.ncbi.nlm.nih.gov/?term=" + encodeURIComponent(q);
    caja.appendChild(a);
    return caja;
  }

  /** Título → DOI → autor, cada paso pendiente, buscando ahora, hecho o innecesario. */
  function tuberia(r, est, conVeredicto){
    var v = est.veredictos[r.n];
    var consultas = est.consultas[r.n] || {};
    var ol = el("ol", "tuberia");
    var coincidioPor = null;
    VIAS.forEach(function(via){
      var c = consultas[via];
      var li = el("li", "tramo");
      li.setAttribute("data-via", CLAVE_VIA[via]);
      li.appendChild(el("span", "tramo-via", "Por " + via));
      if (c) {
        li.className += " hecho" + (c.coincide ? " coincide" : "");
        li.appendChild(el("span", "tramo-estado", textoResultado(c)));
        if (conVeredicto) {
          var q = consultaExacta(r, via);
          if (q) li.appendChild(q);
        }
        if (c.coincide) coincidioPor = via;
      } else if (coincidioPor) {
        li.className += " omitido";
        li.appendChild(el("span", "tramo-estado", "No hizo falta: ya coincidió por " + coincidioPor));
      } else if (buscandoAhora(est, r.n, via)) {
        li.className += " buscando";
        li.appendChild(el("span", "tramo-estado", "Buscando ahora…"));
      } else if (conVeredicto && v) {
        // Un veredicto sin registro de esta búsqueda (respaldo incompleto): no se inventa.
        return;
      } else {
        li.className += " pendiente";
        li.appendChild(el("span", "tramo-estado", "Pendiente"));
      }
      ol.appendChild(li);
    });
    return ol;
  }

  function itemReferencia(r, est){
    var v = est.veredictos[r.n];
    var consultas = est.consultas[r.n] || {};
    var li = el("li");
    li.id = "ref-" + r.n;
    li.appendChild(el("span", "ref-num", "Referencia " + r.n));

    if (!v) {
      // Antes del veredicto: solo el número y el recorrido, nunca la cita ni las consultas.
      var activa = Object.keys(consultas).length > 0 || (est.buscando && est.buscando.ref === r.n);
      li.className = activa ? "verificando" : "espera";
      li.appendChild(el("span", "pendiente", activa ? "Verificando en PubMed…" : "En espera"));
      if (activa) {
        li.appendChild(tuberia(r, est, false));
        if (est.ensayo[r.n]) li.appendChild(el("span", "ensayo", etiquetaEnsayo()));
      }
      return li;
    }

    li.className = v.existe ? "si" : "no";
    // La referencia fabricada va en forma corta y siempre con su etiqueta: nada que
    // se pueda copiar y pegar como si fuera una cita real.
    li.appendChild(el("span", "cita", r.fabricada ? r.corta : r.cita));
    if (v.existe && pmidValido(v.pmid)) {
      var s = el("span", "veredicto", "Existe en PubMed · PMID ");
      var a = enlaceExterno(el("a", null, v.pmid));
      a.href = "https://pubmed.ncbi.nlm.nih.gov/" + v.pmid + "/";
      s.appendChild(a);
      li.appendChild(s);
    } else {
      li.appendChild(el("span", "veredicto", "No existe: ningún resultado de PubMed por título, DOI ni autor es este artículo."));
    }
    if (r.fabricada) li.appendChild(el("span", "fabricada", "Ejercicio docente: referencia fabricada a propósito. No la cite."));
    if (v.ensayo || est.ensayo[r.n]) li.appendChild(el("span", "ensayo", etiquetaEnsayo()));
    li.appendChild(el("span", "tuberia-titulo", "Cómo se buscó en PubMed"));
    li.appendChild(tuberia(r, est, true));
    return li;
  }

  function pintarReferencias(est){
    if (!cambio("referencias", seqs(est.evs))) return;
    var seccion = $("referencias");
    var lista = $("refs");
    vaciar(lista);
    if (est.evs.length === 0) { seccion.hidden = true; return; }
    seccion.hidden = false;
    DATOS.referencias.forEach(function(r){ lista.appendChild(itemReferencia(r, est)); });
  }

  /* ---------- Evidentia: etapas y embudo ---------- */

  var CLASES_ESTADO = { "completada": "completada", "en curso": "en-curso", "falló": "fallo", "sin terminar": "sin-terminar" };

  /** Escalones del embudo, solo con las cifras que trae el evento. */
  function escalonesEmbudo(e){
    var s = [];
    var pm = cifra(e.pubmed);
    var ep = cifra(e.europepmc);
    if (pm !== null || ep !== null) {
      var origen = [];
      if (pm !== null) origen.push("PubMed " + pm);
      if (ep !== null) origen.push("Europe PMC " + ep);
      s.push({ clave: "encontradas", nombre: "Referencias encontradas", corto: "encontradas", valor: (pm || 0) + (ep || 0), detalle: origen.join(" · ") });
    }
    var unicas = cifra(e.unicas);
    if (unicas !== null) s.push({ clave: "unicas", nombre: "Únicas, sin duplicados", corto: "únicas", valor: unicas, detalle: "" });
    var comprobadas = cifra(e.comprobadas);
    var retractadas = cifra(e.retractadas);
    var textoRetractadas = retractadas === null ? "" : retractadas === 0 ? "Ninguna retractada" : plural(retractadas, "retractada", "retractadas");
    if (comprobadas !== null) {
      s.push({ clave: "comprobadas", nombre: "Comprobadas contra retractaciones", corto: "comprobadas", valor: comprobadas, detalle: textoRetractadas });
    } else if (retractadas !== null) {
      s.push({ clave: "retractadas", nombre: "Retractadas", corto: "retractadas", valor: retractadas, detalle: "" });
    }
    var afirmaciones = cifra(e.afirmaciones);
    var escaladas = cifra(e.escaladas);
    if (afirmaciones !== null) {
      s.push({
        clave: "afirmaciones",
        nombre: "Afirmaciones con cita literal",
        corto: "afirmaciones con cita literal",
        valor: afirmaciones,
        detalle: escaladas === null ? "" : escaladas === 0 ? "Ninguna espera revisión humana" : escaladas + (escaladas === 1 ? " espera" : " esperan") + " revisión humana"
      });
    } else if (escaladas !== null) {
      s.push({ clave: "escaladas", nombre: "Esperan revisión humana", corto: "esperan revisión humana", valor: escaladas, detalle: "" });
    }
    return s;
  }

  function pintarEmbudo(e, fallo){
    var lista = $("embudo");
    var espera = $("embudo-espera");
    var ensayo = $("embudo-ensayo");
    vaciar(lista);
    if (!e) {
      lista.hidden = true;
      ensayo.hidden = true;
      espera.hidden = false;
      texto(espera, fallo ? "Evidentia no terminó: no hay cifras que mostrar." : "Las cifras aparecen aquí cuando Evidentia termine.");
      return;
    }
    espera.hidden = true;
    lista.hidden = false;
    ensayo.hidden = !e.ensayo;
    if (e.ensayo) texto(ensayo, DATOS.fechaEnsayoEvidentia ? "Cifras del ensayo del " + fechaLarga(DATOS.fechaEnsayoEvidentia) : "Cifras del ensayo");
    var escalones = escalonesEmbudo(e);
    var maximo = 1;
    escalones.forEach(function(s){ if (s.valor > maximo) maximo = s.valor; });
    escalones.forEach(function(s){
      var li = el("li", "escalon");
      li.setAttribute("data-escalon", s.clave);
      var cab = el("p", "escalon-cab");
      cab.appendChild(el("span", "escalon-nombre", s.nombre));
      cab.appendChild(el("b", "escalon-cifra", String(s.valor)));
      li.appendChild(cab);
      var barra = el("div", "barra");
      barra.setAttribute("aria-hidden", "true");
      var relleno = el("span", "relleno");
      // Proporcional al escalón mayor; una cifra pequeña pero no nula se sigue viendo.
      relleno.style.width = (s.valor === 0 ? 0 : Math.max(2, Math.round(s.valor * 100 / maximo))) + "%";
      barra.appendChild(relleno);
      li.appendChild(barra);
      if (s.detalle) li.appendChild(el("p", "escalon-detalle", s.detalle));
      lista.appendChild(li);
    });
  }

  function pintarEvidentia(){
    var evs = desdeUltimoInicio("evidentia", ["evidentia_etapa", "evidentia_embudo"]);
    if (!cambio("evidentia", seqs(evs))) return;
    var lista = $("etapas");
    vaciar(lista);
    if (evs.length === 0) { $("evidentia").hidden = true; return; }
    $("evidentia").hidden = false;
    var orden = [];
    var ultima = {};
    var embudo = null;
    evs.forEach(function(e){
      if (e.tipo === "evidentia_embudo") { embudo = e; return; }
      if (!ultima[e.etapa]) orden.push(e.etapa);
      ultima[e.etapa] = e;
    });
    var fallo = false;
    orden.forEach(function(nombre){
      var e = ultima[nombre];
      if (e.estado === "falló" || e.estado === "sin terminar") fallo = true;
      var li = el("li", null, e.etapa);
      li.appendChild(el("span", "estado " + (CLASES_ESTADO[e.estado] || ""), e.estado));
      if (e.detalle) li.appendChild(el("span", "detalle", e.detalle));
      lista.appendChild(li);
    });
    pintarEmbudo(embudo, fallo);
  }

  /* ---------- el mismo chat, con PubMed ---------- */

  var CHAT = DATOS.chat || {};
  var PASOS_CHAT = ["busqueda", "lectura", "respuesta"];
  function textoPasoChat(e){
    var n = cifra(e.cifra);
    if (e.paso === "busqueda") {
      return e.estado === "completada" && n !== null
        ? "Búsqueda en PubMed: " + plural(n, "resultado", "resultados")
        : "Búsqueda en PubMed con la consulta fija";
    }
    if (e.paso === "lectura") {
      return e.estado === "completada" && n !== null
        ? "Lectura: " + plural(n, "resumen", "resúmenes") + ", lo único que puede usar el modelo"
        : "Lectura de los resúmenes";
    }
    if (e.estado === "completada" && n !== null) {
      return "Respuesta: cita " + plural(n, "artículo", "artículos") + " de la búsqueda";
    }
    return e.estado === "falló" ? "Respuesta: no hubo, ni en vivo ni del ensayo" : "Respuesta del modelo";
  }

  /** El texto del modelo con cada «[PMID n]» de una fuente leída convertido en enlace. Nada se interpreta como HTML. */
  function pintarTextoConCitas(nodo, t, pmids){
    vaciar(nodo);
    var patron = /\[PMID (\d{1,9})\]/g;
    var desde = 0;
    var m;
    while ((m = patron.exec(t))) {
      if (pmids.indexOf(m[1]) < 0) continue;
      nodo.appendChild(document.createTextNode(t.slice(desde, m.index) + "["));
      var a = enlaceExterno(el("a", null, "PMID " + m[1]));
      a.href = "https://pubmed.ncbi.nlm.nih.gov/" + m[1] + "/";
      nodo.appendChild(a);
      nodo.appendChild(document.createTextNode("]"));
      desde = m.index + m[0].length;
    }
    nodo.appendChild(document.createTextNode(t.slice(desde)));
  }

  function pintarChat(){
    var hayInicio = eventos.some(function(e){ return e.tipo === "demo_inicio" && e.tema === "chat"; });
    var evs = hayInicio ? desdeUltimoInicio("chat", ["chat_paso", "chat_fuentes", "chat_texto"]) : [];
    if (!cambio("chat", (hayInicio ? "1|" : "0|") + seqs(evs))) return;
    var seccion = $("chat");
    if (!hayInicio) { seccion.hidden = true; return; }
    seccion.hidden = false;
    texto($("chat-pregunta"), CHAT.pregunta ? "«" + CHAT.pregunta + "»" : "");
    texto($("chat-consulta"), CHAT.consulta || "");

    var pasos = {};
    var fuentes = null;
    var respuesta = null;
    var ensayo = false;
    evs.forEach(function(e){
      if (e.ensayo) ensayo = true;
      if (e.tipo === "chat_paso") pasos[e.paso] = e;
      else if (e.tipo === "chat_fuentes") fuentes = e;
      else respuesta = e;
    });

    var lista = $("chat-pasos");
    vaciar(lista);
    PASOS_CHAT.forEach(function(p){
      var e = pasos[p];
      if (!e) return;
      var li = el("li", null, textoPasoChat(e));
      li.appendChild(el("span", "estado " + (CLASES_ESTADO[e.estado] || ""), e.estado));
      if (e.ensayo) li.appendChild(el("span", "detalle", "Resultado del ensayo"));
      lista.appendChild(li);
    });

    var pmids = [];
    var ol = $("chat-fuentes");
    vaciar(ol);
    (fuentes && Array.isArray(fuentes.fuentes) ? fuentes.fuentes : []).forEach(function(f){
      if (!f || !pmidValido(f.pmid)) return;
      pmids.push(f.pmid);
      var li = el("li", "si");
      li.appendChild(el("span", "cita", f.titulo));
      li.appendChild(el("span", "revista", f.revista + (typeof f.anio === "number" ? " · " + f.anio : "")));
      var a = enlaceExterno(el("a", null, "Abrir en PubMed · PMID " + f.pmid));
      a.href = "https://pubmed.ncbi.nlm.nih.gov/" + f.pmid + "/";
      li.appendChild(a);
      ol.appendChild(li);
    });
    $("chat-fuentes-titulo").hidden = pmids.length === 0;

    $("chat-respuesta").hidden = !respuesta;
    if (respuesta) pintarTextoConCitas($("chat-texto"), respuesta.texto_parcial, pmids);
    var sello = $("chat-ensayo");
    sello.hidden = !ensayo;
    texto(sello, DATOS.fechaEnsayoChat ? "Respuesta de ensayo · grabada el " + fechaLarga(DATOS.fechaEnsayoChat) : "Respuesta de ensayo");
  }

  /* ---------- el mapa de los siete pasos ---------- */

  var pasosNodos = [];
  var diapoDelMapa;
  var pasoAbiertoSolo = null;

  function copiarPrompt(textoPrompt, nodo, avisar){
    function seleccionar(){
      try {
        var rango = document.createRange();
        rango.selectNodeContents(nodo);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(rango);
        return true;
      } catch (e) {
        return false;
      }
    }
    // Sin portapapeles (http, navegador viejo o permiso negado): se selecciona el texto
    // para que el menú del teléfono lo copie.
    function respaldo(){
      var copiado = false;
      if (seleccionar()) {
        try { copiado = document.execCommand("copy"); } catch (e) { copiado = false; }
      }
      avisar(copiado ? "Prompt copiado." : "Prompt seleccionado: cópielo con el menú del teléfono.");
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(textoPrompt).then(function(){ avisar("Prompt copiado."); }, respaldo);
        return;
      }
    } catch (e) { /* al respaldo */ }
    respaldo();
  }

  /** Se construye una vez: details/summary abre y cierra sin JS y el repintado no pisa lo que abrió la persona. */
  function construirPasos(){
    var mapa = $("mapa-pasos");
    PASOS.forEach(function(p){
      var d = el("details", "paso");
      d.id = "paso-" + p.paso;
      var s = el("summary");
      s.appendChild(el("span", "paso-num", numeroPaso(p)));
      var cab = el("span", "paso-cab");
      cab.appendChild(el("span", "paso-etiqueta", p.etiqueta));
      cab.appendChild(el("span", "paso-titulo", p.titulo));
      s.appendChild(cab);
      var marca = el("span", "paso-marca");
      s.appendChild(marca);
      d.appendChild(s);

      var cuerpo = el("div", "paso-cuerpo");
      cuerpo.appendChild(el("p", "rotulo", "La IA propone"));
      cuerpo.appendChild(el("p", "paso-texto", p.propone));
      cuerpo.appendChild(el("p", "rotulo rotulo-usted", "Usted verifica"));
      cuerpo.appendChild(el("p", "paso-texto", p.verifica));
      if (Array.isArray(p.herramientas) && p.herramientas.length) {
        cuerpo.appendChild(el("p", "rotulo", "Herramientas"));
        var ul = el("ul", "herramientas");
        p.herramientas.forEach(function(h){ ul.appendChild(el("li", null, h)); });
        cuerpo.appendChild(ul);
      }
      cuerpo.appendChild(el("p", "rotulo", "Prompt para copiar"));
      var prompt = el("p", "prompt-texto", p.prompt);
      prompt.id = "prompt-" + p.paso;
      cuerpo.appendChild(prompt);
      var fila = el("div", "copiar-fila");
      var boton = el("button", "copiar", "Copiar el prompt");
      boton.type = "button";
      var aviso = el("span", "copiado");
      aviso.setAttribute("role", "status");
      aviso.setAttribute("aria-live", "polite");
      var temporizador = null;
      var avisar = function(t){
        aviso.textContent = t;
        clearTimeout(temporizador);
        temporizador = setTimeout(function(){ aviso.textContent = ""; }, AVISO_COPIA_MS);
      };
      boton.addEventListener("click", function(){ copiarPrompt(p.prompt, prompt, avisar); });
      fila.appendChild(boton);
      fila.appendChild(aviso);
      cuerpo.appendChild(fila);
      d.appendChild(cuerpo);
      mapa.appendChild(d);
      pasosNodos.push({ paso: p, details: d, marca: marca });
    });
  }

  /**
   * El mapa aparece cuando la charla llega a él: antes, sus herramientas no tienen
   * contexto y lo primero que ve quien escanea el QR es el ejercicio. Resalta y abre
   * el paso en pantalla; marca como vistos los anteriores. Solo actúa al cambiar de
   * diapositiva.
   */
  function pintarPasos(){
    var d = ultimo("diapositiva");
    var n = d ? d.n : null;
    if (n === diapoDelMapa) return;
    diapoDelMapa = n;
    var visible = n !== null && DIAPO_MAPA !== null && n >= DIAPO_MAPA;
    $("pasos").hidden = !visible;
    $("kit-prompts").hidden = !visible;
    marcar($("pasos"), "resaltado", n !== null && n === DIAPO_MAPA);
    var actual = null;
    pasosNodos.forEach(function(x){
      var esActual = n !== null && x.paso.diapositiva === n;
      var visto = n !== null && x.paso.diapositiva < n;
      marcar(x.details, "actual", esActual);
      marcar(x.details, "visto", visto);
      texto(x.marca, esActual ? "En pantalla" : visto ? "Visto" : "");
      if (esActual) actual = x;
    });
    // Se cierra solo el paso que abrió la página; lo que abrió la persona se queda abierto.
    if (pasoAbiertoSolo && pasoAbiertoSolo !== actual) pasoAbiertoSolo.details.open = false;
    pasoAbiertoSolo = null;
    if (actual && !actual.details.open) {
      actual.details.open = true;
      pasoAbiertoSolo = actual;
    }
  }

  /* ---------- avisos y línea de tiempo ---------- */

  function pintarAvisos(){
    var avisos = eventos.filter(function(e){ return e.tipo === "aviso"; }).slice(-3).reverse();
    if (!cambio("avisos", seqs(avisos))) return;
    $("avisos").hidden = avisos.length === 0;
    var lista = $("lista-avisos");
    vaciar(lista);
    avisos.forEach(function(a){ lista.appendChild(el("li", null, a.texto)); });
  }

  var TEMAS = {
    resumen: "Se le pide a Claude el resumen de la referencia " + DATOS.refResumen + " sin buscar en ninguna base de datos",
    verificacion: "Verificación de las cinco referencias en PubMed",
    evidentia: "Evidentia busca y verifica la pregunta de la miel",
    chat: "el mismo chat, ahora con PubMed"
  };

  function lineaDe(e){
    switch (e.tipo) {
      case "demo_inicio": return "Empieza: " + (TEMAS[e.tema] || "demostración");
      case "pubmed_buscando":
        return "PubMed · referencia " + e.ref + " · buscando por " + e.via + "…" + (e.ensayo ? " (ensayo)" : "");
      case "pubmed_consulta":
        return "PubMed · referencia " + e.ref + " · por " + e.via + ": " + e.resultados +
          (e.resultados === 1 ? " resultado" : " resultados") +
          (e.resultados > 0 ? (e.coincide ? ", coincide con la cita" : ", ninguno es el artículo citado") : "") +
          (e.ensayo ? " (ensayo)" : "");
      case "pubmed_veredicto":
        return "PubMed · referencia " + e.ref + ": " + (e.existe ? "existe" : "no existe") + (e.ensayo ? " (ensayo)" : "");
      case "evidentia_etapa": return "Evidentia · " + e.etapa + ": " + e.estado;
      case "evidentia_embudo":
        return "Evidentia · el embudo: " + escalonesEmbudo(e).map(function(s){ return s.valor + " " + s.corto; }).join(" → ") +
          (e.ensayo ? " (ensayo)" : "");
      case "votacion": return e.estado === "abierta" ? "Se abre la votación del público" : "Se cierra la votación del público";
      case "chat_paso": return "Chat con PubMed · " + textoPasoChat(e) + ": " + e.estado + (e.ensayo ? " (ensayo)" : "");
      case "aviso": return "Mensaje del ponente: " + e.texto;
      default: return null;
    }
  }

  function pintarLinea(){
    var lineas = [];
    eventos.forEach(function(e){
      var t = lineaDe(e);
      if (t) lineas.push({ seq: e.seq, ts: e.ts, texto: t });
    });
    lineas = lineas.slice(-40).reverse();
    if (!cambio("linea", seqs(lineas))) return;
    var lista = $("linea-eventos");
    vaciar(lista);
    $("linea-vacia").hidden = lineas.length > 0;
    lineas.forEach(function(l){
      var li = el("li");
      li.appendChild(el("time", null, hora(l.ts)));
      li.appendChild(document.createTextNode(l.texto));
      lista.appendChild(li);
    });
  }

  /** El kit en texto plano, para el correo o el portapapeles: nada que no esté ya en esta página. */
  function textoKit(){
    var k = DATOS.kit || {};
    var lineas = ["Del caso clínico al PubMed · kit para llevar", "La IA propone, usted verifica.", ""];
    lineas.push("PROMPTS PARA CADA PASO");
    PASOS.forEach(function(p){
      lineas.push("");
      lineas.push("Paso " + numeroPaso(p) + " · " + p.etiqueta + ": " + p.titulo);
      lineas.push(p.prompt);
    });
    lineas.push("");
    lineas.push("CUATRO LÍNEAS ROJAS");
    (k.lineasRojas || []).forEach(function(l){ lineas.push("- " + l.titulo + ". " + l.texto); });
    lineas.push("");
    lineas.push("GUÍAS DE REPORTE");
    (k.guias || []).forEach(function(g){ lineas.push("- " + g.nombre + ": " + g.url); });
    lineas.push("");
    lineas.push("Esta página: " + location.origin + "/vivo");
    return lineas.join("\n");
  }

  function pintarKit(){
    var k = DATOS.kit || {};
    var enviar = $("kit-enviar");
    var copiar = $("kit-copiar");
    var aviso = $("kit-copiado");
    if (enviar && copiar && aviso) {
      var cuerpo = textoKit();
      enviar.href = "mailto:?subject=" + encodeURIComponent("Kit: del caso clínico al PubMed") + "&body=" + encodeURIComponent(cuerpo);
      var temporizador = null;
      var avisar = function(t){
        aviso.textContent = t.replace("Prompt", "Kit");
        clearTimeout(temporizador);
        temporizador = setTimeout(function(){ aviso.textContent = ""; }, AVISO_COPIA_MS);
      };
      copiar.addEventListener("click", function(){ copiarPrompt(cuerpo, $("kit-prompts"), avisar); });
    }
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
      var a = enlaceExterno(el("a", null, x.nombre));
      if (/^https:\/\//.test(x.url)) a.href = x.url;
      li.appendChild(a);
      g.appendChild(li);
    });
  }

  /* ---------- conexión: WebSocket con sondeo de respaldo ---------- */

  function estadoConexion(t, clase){
    var c = $("conexion");
    c.textContent = t;
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
  textosResumen();
  construirPasos();
  pintar();
  // Las dos cosas a la vez: el sondeo trae el estado en el primer segundo aunque el
  // WebSocket tarde o esté bloqueado en la red del hotel.
  sondear();
  conectar();
})();
