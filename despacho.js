// =====================================================================
// Algoritmo de asignacion de domicilios
// ---------------------------------------------------------------------
// Heuristica por eventos (se recalcula cada vez que se refresca la vista):
//  1. Semilla: el pedido sin asignar que mas tiempo lleva esperando.
//  2. Domiciliario: el que pueda salir mas pronto con bandeja suficiente.
//  3. Se agregan al viaje pedidos cercanos mientras quepan en la bandeja,
//     no obliguen a esperar mucho en el local, no desvien mucho la ruta y
//     no hagan llegar tarde a alguien que iba a tiempo.
//  4. El orden de entrega se elige probando todas las permutaciones
//     (o vecino mas cercano + 2-opt si el viaje es muy grande).
//  5. Se repite hasta que no queden pedidos.
// Distancias: caminando por las calles con rutasCalles (rutas.js) si la red esta
// cargada; si no, linea recta x FACTOR_CALLES. Tiempos en milisegundos.
// =====================================================================

const DESPACHO_CFG = {
    VELOCIDAD_M_MIN: 75,      // caminando, con carga
    FACTOR_CALLES: 1.6,       // respaldo si no carga la red de calles: linea recta -> calle (medido: 1.4 a 1.9)
    MIN_POR_ENTREGA: 2,       // tiempo en cada parada
    PREP_MIN_DEFECTO: 12,     // si no hay datos del dia para estimar cocina
    META_MIN: 30,             // objetivo: entregar antes de 30 min desde el pedido
    MAX_ESPERA_MIN: 5,        // lo maximo que un viaje espera en el local por otro pedido
    MAX_DESVIO_MIN: 6,        // lo maximo que agregar un pedido retrasa a los demas / alarga la ruta
    TOLERANCIA_ALTERNATIVA_MIN: 3, // se agrega a un viaje aunque otro domiciliario llegue hasta 3 min antes
    DIST_DEFECTO_M: 550,      // distancia a pie supuesta si el cliente no tiene ubicacion
    CAPACIDAD: { grande: 10, mediana: 7 },
    ASIGNABLE_EN_MIN: 5,      // viajes que pueden salir en este margen se pueden asignar ya
    MAX_PERMUTAR: 7,          // hasta este numero de paradas se prueban todas las rutas
};

const despachoAlgoritmo = {
    metros(a, b, cfg = DESPACHO_CFG) {
        if (!a || !b || a.lat == null || b.lat == null) return cfg.DIST_DEFECTO_M;
        const porCalle = typeof rutasCalles !== 'undefined' ? rutasCalles.metros(a, b) : null;
        return porCalle ?? distanciaMetros(a, b) * cfg.FACTOR_CALLES;
    },

    minutos(a, b, cfg = DESPACHO_CFG) {
        return despachoAlgoritmo.metros(a, b, cfg) / cfg.VELOCIDAD_M_MIN;
    },

    // Recorre las paradas en el orden dado.
    // inicio: { pos, ms } desde donde y cuando sale (por defecto el local a la hora de salida).
    simular(local, paradas, salidaMs, cfg = DESPACHO_CFG, inicio = null) {
        let t = inicio ? inicio.ms : salidaMs;
        let pos = inicio ? inicio.pos : local;
        const llegadas = {};
        let esperaTotal = 0, atrasoTotal = 0, atrasados = 0;

        for (const p of paradas) {
            t += despachoAlgoritmo.minutos(pos, p.pos, cfg) * 60000;
            llegadas[p.id] = t;
            const esperaMin = (t - p.creadoMs) / 60000;
            esperaTotal += esperaMin;
            if (esperaMin > cfg.META_MIN) {
                atrasoTotal += esperaMin - cfg.META_MIN;
                atrasados++;
            }
            t += cfg.MIN_POR_ENTREGA * 60000;
            pos = p.pos || pos;
        }
        const regresoMs = t + despachoAlgoritmo.minutos(pos, local, cfg) * 60000;
        // Prioridad: nadie tarde > poca espera de los clientes > volver pronto al local
        const costo = atrasoTotal * 10 + esperaTotal + (regresoMs - salidaMs) / 60000 * 0.3;
        return { paradas, llegadas, regresoMs, costo, atrasados };
    },

    _permutaciones(arr) {
        if (arr.length <= 1) return [arr.slice()];
        const out = [];
        arr.forEach((x, i) => {
            const resto = [...arr.slice(0, i), ...arr.slice(i + 1)];
            despachoAlgoritmo._permutaciones(resto).forEach(p => out.push([x, ...p]));
        });
        return out;
    },

    mejorRuta(local, paradas, salidaMs, cfg = DESPACHO_CFG) {
        const sim = (orden) => despachoAlgoritmo.simular(local, orden, salidaMs, cfg);

        if (paradas.length <= cfg.MAX_PERMUTAR) {
            let mejor = null;
            for (const orden of despachoAlgoritmo._permutaciones(paradas)) {
                const r = sim(orden);
                if (!mejor || r.costo < mejor.costo) mejor = r;
            }
            return mejor;
        }

        // Vecino mas cercano + mejoras 2-opt
        const pendientes = paradas.slice();
        const orden = [];
        let pos = local;
        while (pendientes.length) {
            pendientes.sort((a, b) => despachoAlgoritmo.minutos(pos, a.pos, cfg) - despachoAlgoritmo.minutos(pos, b.pos, cfg));
            const sig = pendientes.shift();
            orden.push(sig);
            pos = sig.pos || pos;
        }
        let mejor = sim(orden);
        let mejoro = true;
        while (mejoro) {
            mejoro = false;
            for (let i = 0; i < orden.length - 1; i++) {
                for (let j = i + 1; j < orden.length; j++) {
                    const cand = [...mejor.paradas.slice(0, i), ...mejor.paradas.slice(i, j + 1).reverse(), ...mejor.paradas.slice(j + 1)];
                    const r = sim(cand);
                    if (r.costo < mejor.costo - 1e-9) { mejor = r; mejoro = true; }
                }
            }
        }
        return mejor;
    },

    // Costo total de un plan: minutos de espera de cada cliente + penalidad fuerte por atraso
    _costoPlan(viajes, cfg) {
        let c = 0;
        for (const v of viajes) {
            for (const p of v.paradas) {
                const espera = (v.llegadas[p.id] - p.creadoMs) / 60000;
                c += espera + 10 * Math.max(0, espera - cfg.META_MIN);
            }
        }
        return c;
    },

    // Domiciliario que se libera primero (a igualdad, bandeja mas pequena) y sus
    // semillas posibles: [regla por defecto (mas antiguo listo), exclusivo de su bandeja].
    _elegir(est, cfg) {
        est.doms.sort((a, b) => a.libreMs - b.libreMs || a.capacidad - b.capacidad);
        for (const d of est.doms) {
            const caben = est.cola.filter(p => p.unidades <= d.capacidad);
            if (!caben.length) continue;
            const limiteEspera = d.libreMs + cfg.MAX_ESPERA_MIN * 60000;
            const listos = caben.filter(p => p.listoMs <= limiteEspera);
            const porDefecto = listos[0] || caben.reduce((a, b) => (b.listoMs < a.listoMs ? b : a));
            const exclusivo = listos.find(p => !est.doms.some(o => o !== d && o.capacidad >= p.unidades));
            const semillas = [porDefecto];
            if (exclusivo && exclusivo !== porDefecto) semillas.push(exclusivo);
            return { dom: d, semillas, avisos: [] };
        }
        // Solo quedan pedidos que no caben en ninguna bandeja: a la mas grande
        const semilla = est.cola[0];
        const dom = est.doms.reduce((a, b) => (b.capacidad > a.capacidad || (b.capacidad === a.capacidad && b.libreMs < a.libreMs) ? b : a));
        return { dom, semillas: [semilla], avisos: [`${semilla.nombre} tiene ${semilla.unidades} productos: no cabe en ninguna bandeja disponible`] };
    },

    // Arma un viaje desde una semilla agregando pedidos compatibles, y lo aplica al estado
    _armarViaje(est, dom, semilla, avisos, ahora, local, cfg) {
        const libreAntes = dom.libreMs;
        const viaje = [semilla];
        let carga = semilla.unidades;
        let salida = Math.max(dom.libreMs, semilla.listoMs, ahora);
        let ruta = despachoAlgoritmo.mejorRuta(local, viaje, salida, cfg);

        for (;;) {
            let mejor = null;
            for (const c of est.cola) {
                if (viaje.includes(c)) continue;
                if (carga + c.unidades > dom.capacidad) continue;
                const salida2 = Math.max(salida, c.listoMs);
                if ((salida2 - salida) / 60000 > cfg.MAX_ESPERA_MIN) continue;

                const ruta2 = despachoAlgoritmo.mejorRuta(local, [...viaje, c], salida2, cfg);
                let retrasoMax = 0, vuelveTarde = false;
                for (const p of viaje) {
                    const antes = ruta.llegadas[p.id], despues = ruta2.llegadas[p.id];
                    retrasoMax = Math.max(retrasoMax, (despues - antes) / 60000);
                    const limite = p.creadoMs + cfg.META_MIN * 60000;
                    if (antes <= limite && despues > limite) vuelveTarde = true;
                }
                if (vuelveTarde || retrasoMax > cfg.MAX_DESVIO_MIN) continue;

                // Desvio: minutos extra que camina el domiciliario por incluir este pedido
                const desvio = ((ruta2.regresoMs - salida2) - (ruta.regresoMs - salida)) / 60000 - cfg.MIN_POR_ENTREGA;
                if (desvio > cfg.MAX_DESVIO_MIN) continue;

                // Alternativa: que lo lleve otro domiciliario saliendo directo. Si asi
                // llegaria claramente antes, no se agrega a este viaje.
                const alternativa = Math.min(...est.doms.filter(d => d !== dom).map(d =>
                    Math.max(d.libreMs, c.listoMs, ahora) + despachoAlgoritmo.minutos(local, c.pos, cfg) * 60000));
                if (ruta2.llegadas[c.id] > alternativa + cfg.TOLERANCIA_ALTERNATIVA_MIN * 60000) continue;

                // Menor retraso para los demas; a igualdad, el pedido mas antiguo
                if (!mejor || retrasoMax < mejor.retrasoMax - 1e-9 ||
                    (Math.abs(retrasoMax - mejor.retrasoMax) < 1e-9 && c.creadoMs < mejor.c.creadoMs)) {
                    mejor = { c, ruta2, salida2, retrasoMax };
                }
            }
            if (!mejor) break;
            viaje.push(mejor.c);
            carga += mejor.c.unidades;
            salida = mejor.salida2;
            ruta = mejor.ruta2;
        }

        viaje.forEach(p => est.cola.splice(est.cola.indexOf(p), 1));
        const avisosViaje = [...avisos];
        if (ruta.atrasados > 0) avisosViaje.push(`${ruta.atrasados} pedido(s) llegarían después de ${cfg.META_MIN} min`);

        est.viajes.push({
            domiciliario: { id: dom.id, nombre: dom.nombre, capacidad: dom.capacidad },
            paradas: ruta.paradas,
            llegadas: ruta.llegadas,
            salidaMs: salida,
            regresoMs: ruta.regresoMs,
            carga,
            // Solo el primer viaje de cada domiciliario, y si puede salir pronto
            asignableAhora: dom.viajes === 0 && libreAntes <= ahora + cfg.ASIGNABLE_EN_MIN * 60000,
            avisos: avisosViaje,
        });
        dom.libreMs = ruta.regresoMs;
        dom.viajes++;
    },

    _clonar(est) {
        return { cola: est.cola.slice(), doms: est.doms.map(d => ({ ...d })), viajes: est.viajes.slice() };
    },

    // pedidos:        [{ id, nombre, creadoMs, listoMs, unidades, pos:{lat,lng}|null }]  (sin asignar)
    // domiciliarios:  [{ id, nombre, capacidad, libreMs }]                              (disponibles)
    // anticipar:      si hay dos semillas posibles, simula el resto del plan con cada una
    //                 y se queda con la que deja menos espera y menos atrasos en total
    planificar({ pedidos, domiciliarios, ahora, local, cfg = DESPACHO_CFG, anticipar = true }) {
        const est = {
            cola: pedidos.slice().sort((a, b) => a.creadoMs - b.creadoMs),
            doms: domiciliarios.map(d => ({ ...d, libreMs: Math.max(d.libreMs, ahora), viajes: 0 })),
            viajes: [],
        };

        if (est.doms.length === 0) {
            return { viajes: [], sinAsignar: est.cola.map(p => ({ pedido: p, motivo: 'No hay domiciliarios disponibles' })) };
        }

        while (est.cola.length) {
            const { dom, semillas, avisos } = despachoAlgoritmo._elegir(est, cfg);
            let semilla = semillas[0];

            if (anticipar && semillas.length > 1) {
                let mejorCosto = Infinity;
                for (const s of semillas) {
                    const prueba = despachoAlgoritmo._clonar(est);
                    const domPrueba = prueba.doms.find(d => d.id === dom.id);
                    despachoAlgoritmo._armarViaje(prueba, domPrueba, s, avisos, ahora, local, cfg);
                    // Completar el resto del plan con la regla por defecto
                    while (prueba.cola.length) {
                        const e = despachoAlgoritmo._elegir(prueba, cfg);
                        despachoAlgoritmo._armarViaje(prueba, e.dom, e.semillas[0], e.avisos, ahora, local, cfg);
                    }
                    const costo = despachoAlgoritmo._costoPlan(prueba.viajes, cfg);
                    if (costo < mejorCosto) { mejorCosto = costo; semilla = s; }
                }
            }

            despachoAlgoritmo._armarViaje(est, dom, semilla, avisos, ahora, local, cfg);
        }

        return { viajes: est.viajes, sinAsignar: [] };
    },
};
