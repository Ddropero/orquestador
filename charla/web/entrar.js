(function(){
  "use strict";
  if (/[?&]error=1\b/.test(location.search)) document.getElementById("error").hidden = false;
  // Enlace de acceso rápido: /presentador#t=TOKEN. El fragmento nunca llega al
  // servidor ni a sus registros; se borra de la barra y del historial antes de enviar.
  var m = /^#t=(.+)$/.exec(location.hash);
  if (m) {
    var token = "";
    try { token = decodeURIComponent(m[1]); } catch (e) { token = ""; }
    history.replaceState(null, "", location.pathname);
    if (token) {
      document.getElementById("token").value = token;
      document.getElementById("formulario").submit();
    }
  }
})();
