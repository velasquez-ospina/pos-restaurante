function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var payload = JSON.parse(e.postData.contents);

    var CLAVE_SECRETA = "Mega6045a21";
    if (payload.token !== CLAVE_SECRETA) {
      return resp({ status: "error", message: "Acceso denegado." });
    }

    var action = payload.action;

    if (action === "obtener_datos") {
      var tipoServicio = payload.tipo_servicio;

      var hojaCatalogo = ss.getSheetByName("Catalogo_Menus");
      var catalogo = [];
      if (hojaCatalogo.getLastRow() > 1) {
        hojaCatalogo.getRange(2, 2, hojaCatalogo.getLastRow() - 1, 5).getValues()
          .forEach(function (r) {
            if (r[0] && r[4] === tipoServicio) {
              catalogo.push({ nombre: r[0], precio: r[2] || 0 });
            }
          });
      }

      var hojaBebidas = ss.getSheetByName("Catalogo_Bebidas");
      var catalogoBebidas = [];
      if (hojaBebidas && hojaBebidas.getLastRow() > 1) {
        hojaBebidas.getRange(2, 2, hojaBebidas.getLastRow() - 1, 2).getValues()
          .forEach(function (r) {
            if (r[0] && r[1] === tipoServicio) {
              catalogoBebidas.push({ nombre: r[0] });
            }
          });
      }

      var hojaMenuDia = ss.getSheetByName("Menu_Del_Dia");
      var menuDia = [], menuBebidasDia = [];
      if (hojaMenuDia.getLastRow() > 1) {
        hojaMenuDia.getRange(2, 1, hojaMenuDia.getLastRow() - 1, 3).getValues()
          .forEach(function (r) {
            if (r[0] && r[1] === tipoServicio) {
              if (r[2] === "Bebida") menuBebidasDia.push(r[0]);
              else menuDia.push(r[0]);
            }
          });
      }

      var hojaClientes = ss.getSheetByName("Clientes");
      var clientes = [];
      if (hojaClientes && hojaClientes.getLastRow() > 1) {
        clientes = hojaClientes.getRange(2, 1, hojaClientes.getLastRow() - 1, 1)
          .getValues().flat().filter(String);
      }

      return resp({
        status: "success",
        catalogo: catalogo,
        catalogoBebidas: catalogoBebidas,
        menuDia: menuDia,
        menuBebidasDia: menuBebidasDia,
        clientes: clientes
      });
    }

    else if (action === "guardar_menu_dia") {
      var lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        var hojaMenuDia = ss.getSheetByName("Menu_Del_Dia");
        var tipoServicio = payload.tipo_servicio;

        var filasMantener = [];
        if (hojaMenuDia.getLastRow() > 1) {
          filasMantener = hojaMenuDia.getRange(2, 1, hojaMenuDia.getLastRow() - 1, 3)
            .getValues().filter(function (r) { return r[1] !== tipoServicio; });
          hojaMenuDia.getRange(2, 1, hojaMenuDia.getLastRow(), 3).clearContent();
          if (filasMantener.length > 0)
            hojaMenuDia.getRange(2, 1, filasMantener.length, 3).setValues(filasMantener);
        }

        var nuevasFilas = [];
        (payload.menus || []).forEach(function (n) { nuevasFilas.push([n, tipoServicio, "Plato"]); });
        (payload.bebidas || []).forEach(function (n) { nuevasFilas.push([n, tipoServicio, "Bebida"]); });
        if (nuevasFilas.length > 0) {
          var inicio = (hojaMenuDia.getLastRow() || 1) + 1;
          hojaMenuDia.getRange(inicio, 1, nuevasFilas.length, 3).setValues(nuevasFilas);
        }
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }

      return resp({ status: "success" });
    }

    else if (action === "registrar_pedido") {
      var lock = LockService.getScriptLock();
      lock.waitLock(10000);
      var idPedido;
      try {
        var hojaVentas = ss.getSheetByName("Ventas_Detalle");
        var fecha = new Date();
        idPedido = "PED-" + fecha.getTime().toString().slice(-6);
        var tipo = payload.tipo;
        var tipoServicio = payload.tipo_servicio || "";
        var domPara = payload.domicilio_para || "";
        var domQuien = payload.domicilio_quien || "";

        var filas = payload.carrito.map(function (p) {
          var precio = p.precio || 0;
          var subtotal = p.qty * precio;
          var categoria = p.categoria || "Plato";
          return [fecha, idPedido, tipo, p.item, p.qty, precio, subtotal, domPara, domQuien, categoria];
        });

        hojaVentas.getRange(hojaVentas.getLastRow() + 1, 1, filas.length, 10).setValues(filas);
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }
      return resp({ status: "success", idPedido: idPedido });
    }

    else if (action === "obtener_historial") {
      var tipoServicio = payload.tipo_servicio;
      var hojaVentas = ss.getSheetByName("Ventas_Detalle");
      var pedidos = {};
      var orden = [];

      if (hojaVentas.getLastRow() > 1) {
        var filas = hojaVentas.getRange(2, 1, hojaVentas.getLastRow() - 1, 10).getValues();

        filas.forEach(function (r) {
          var fecha = r[0], id = r[1], tipo = r[2], item = r[3];
          var qty = r[4], precio = r[5], subtotal = r[6];
          var domPara = r[7], domQuien = r[8];

          if (!id || !item) return;

          if (!pedidos[id]) {
            pedidos[id] = {
              idPedido: id,
              fecha: fecha,
              tipo: tipo,
              domicilioPara: domPara || '',
              domicilioQuien: domQuien || '',
              items: [],
              total: 0
            };
            orden.push(id);
          }
          pedidos[id].items.push({ nombre: item, qty: qty, precio: precio || 0, categoria: r[9] || 'Plato' });
          pedidos[id].total += subtotal || 0;
        });
      }

      var ultimos5 = orden.slice(-5).reverse().map(function (id) { return pedidos[id]; });

      return resp({ status: "success", pedidos: ultimos5 });
    }

    else {
      return resp({ status: "error", message: "Acción desconocida." });
    }

  } catch (error) {
    return resp({ status: "error", message: error.message });
  }
}

function resp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}