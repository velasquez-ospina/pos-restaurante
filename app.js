/**
 * app.js — POS Restaurante
 *
 * Estructura:
 *  1.  Configuración
 *  2.  Estado de la aplicación
 *  3.  Inicialización
 *  4.  app       — navegación entre pantallas
 *  5.  auth      — seguridad / token
 *  6.  api       — comunicación con Google Apps Script
 *  7.  cola      — sincronización offline
 *  8.  pos       — vista de pedidos (platos + bebidas)
 *  9.  autocomplete — campo "Para Dónde"
 * 10.  admin     — vista de configuración
 * 11.  ui        — utilidades de interfaz
 */

// ─────────────────────────────────────────────
// 1. CONFIGURACIÓN
// ─────────────────────────────────────────────
const CONFIG = {
    SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbz9a27PaRJZaYPyKL_2NrOTQTYw65xB7xGfiKSLcC9lVzwxjLUv2S08-3KsX-Cfk_Q/exec',
    TOAST_DURATION_MS:        2000,
    SYNC_INTERVAL_MS:         10_000,
    SECURITY_CLICK_THRESHOLD: 5,
    SECURITY_CLICK_WINDOW_MS: 3000,
    LOCAL_STORAGE_KEYS: {
        TOKEN: 'pos_token_seguridad',
        COLA:  'pos_cola_pedidos',
    },
};

// ─────────────────────────────────────────────
// 2. ESTADO DE LA APLICACIÓN
// ─────────────────────────────────────────────
const state = {
    // Auth
    posToken:            localStorage.getItem(CONFIG.LOCAL_STORAGE_KEYS.TOKEN),
    securityClickCount:  0,
    securityClickTimer:  null,

    // Navegación
    currentView:         'home',    // 'home' | 'pos' | 'admin'
    tipoServicio:        null,      // 'Desayuno' | 'Almuerzo'  (elegido en home)
    origenAdmin:         'home',    // 'home' | 'pos'

    // Pedido
    tipoActual:          'Salón',   // 'Salón' | 'Domicilio'
    cantidadesPlatos:    {},
    cantidadesBebidas:   {},

    // Catálogos (cargados del backend)
    catalogoPlatos:      [],        // [{nombre, precio}]  (Catalogo_Menus)
    catalogoBebidas:     [],        // [{nombre}]  — sin precio  (Catalogo_Bebidas)

    // Selección del día (filtrados por tipoServicio)
    menuPlatosHoy:       [],        // nombres de platos activos hoy
    menuBebidasHoy:      [],        // nombres de bebidas activas hoy

    // Clientes para autocomplete
    listaClientes:       [],

    // Historial de pedidos
    historialPedidos:    [],

    // Domicilio
    domicilioPara:       '',
    domicilioQuien:      '',

    // Cola offline
    colaPedidos:         JSON.parse(localStorage.getItem(CONFIG.LOCAL_STORAGE_KEYS.COLA)) || [],
    sincronizando:       false,
};

// ─────────────────────────────────────────────
// 3. INICIALIZACIÓN
// ─────────────────────────────────────────────
window.addEventListener('load', () => {
    auth.verificarSeguridad();
    domicilioAutocomplete.init();
});

window.addEventListener('online', () => cola.procesar());
setInterval(() => cola.procesar(), CONFIG.SYNC_INTERVAL_MS);

// ─────────────────────────────────────────────
// 4. APP — NAVEGACIÓN ENTRE PANTALLAS
// ─────────────────────────────────────────────
const app = {
    /** Usuario elige Desayuno o Almuerzo en la pantalla de inicio → va al POS */
    async iniciarServicio(tipoServicio) {
        state.tipoServicio = tipoServicio;
        await api.obtenerDatosBackend();
        // mostrarPOS se llama desde obtenerDatosBackend al terminar
    },

    /** Desde inicio va directo a Admin para configurar un tipo de servicio */
    async irAAdmin(tipoServicio) {
        state.tipoServicio = tipoServicio;
        state.currentView  = 'admin';   // señal para que obtenerDatosBackend abra Admin
        state.origenAdmin  = 'home';
        await api.obtenerDatosBackend();
    },

    /** Volver a la pantalla de inicio */
    volverAInicio() {
        state.tipoServicio  = null;
        state.currentView   = 'home';
        state.tipoActual    = 'Salón';

        document.getElementById('home-view').style.display      = 'flex';
        document.getElementById('app-header').style.display     = 'none';
        document.getElementById('pos-view').style.display       = 'none';
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('admin-view').style.display     = 'none';
    },

    /** Muestra header + POS, oculta el resto */
    _abrirPOS() {
        state.currentView = 'pos';
        document.getElementById('home-view').style.display      = 'none';
        document.getElementById('app-header').style.display     = 'flex';
        document.getElementById('pos-view').style.display       = 'flex';
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('admin-view').style.display     = 'none';

        // Mostrar botón historial, ocultar config
        document.getElementById('btn-historial').style.display  = 'inline-block';

        // El botón de configurar menú siempre está oculto en el POS
        // La configuración solo se accede desde la pantalla de inicio
        document.getElementById('btn-toggle').style.display = 'none';

        // Badge de servicio en el título
        const badge = state.tipoServicio === 'Desayuno'
            ? `<span class="badge-servicio badge-desayuno">☀️ Desayuno</span>`
            : `<span class="badge-servicio badge-almuerzo">🍽️ Almuerzo</span>`;
        document.getElementById('header-title').innerHTML = `Registro de Pedidos ${badge}`;
    },

    /** Muestra header + Admin, oculta el resto */
    _abrirAdmin() {
        state.currentView = 'admin';
        document.getElementById('home-view').style.display      = 'none';
        document.getElementById('app-header').style.display     = 'flex';
        document.getElementById('pos-view').style.display       = 'none';
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('admin-view').style.display     = 'flex';

        // Ocultar botón historial en Admin
        document.getElementById('btn-historial').style.display  = 'none';

        // En admin el botón sirve para volver al POS (solo aplica si venimos desde POS de Desayuno)
        const btnToggle = document.getElementById('btn-toggle');
        if (state.origenAdmin === 'pos') {
            btnToggle.style.display = 'block';
            btnToggle.innerText = 'Volver a Ventas';
        } else {
            // Vinimos desde la pantalla de inicio → no hay POS al que volver
            btnToggle.style.display = 'none';
        }

        const badge = state.tipoServicio === 'Desayuno'
            ? `<span class="badge-servicio badge-desayuno">☀️ Desayuno</span>`
            : `<span class="badge-servicio badge-almuerzo">🍽️ Almuerzo</span>`;
        document.getElementById('header-title').innerHTML = `Configuración ${badge}`;
    },
};

// ─────────────────────────────────────────────
// 5. AUTH — SEGURIDAD / TOKEN
// ─────────────────────────────────────────────
const auth = {
    verificarSeguridad() {
        if (!state.posToken) {
            const clave = prompt('Seguridad: Ingresa la clave de autorización para este dispositivo:');
            if (clave) {
                state.posToken = clave;
                localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.TOKEN, clave);
            } else {
                alert('No podrás operar el sistema sin la clave de seguridad. Recarga la página.');
            }
        }
    },

    /** Clic 5 veces en el título dentro de 3 s → resetea clave */
    resetearClave() {
        state.securityClickCount++;
        if (state.securityClickCount === 1) {
            state.securityClickTimer = setTimeout(() => {
                state.securityClickCount = 0;
            }, CONFIG.SECURITY_CLICK_WINDOW_MS);
        }
        if (state.securityClickCount >= CONFIG.SECURITY_CLICK_THRESHOLD) {
            clearTimeout(state.securityClickTimer);
            localStorage.removeItem(CONFIG.LOCAL_STORAGE_KEYS.TOKEN);
            state.posToken = null;
            state.securityClickCount = 0;
            alert('Clave de seguridad eliminada del dispositivo.');
            auth.verificarSeguridad();
        }
    },
};

// ─────────────────────────────────────────────
// 6. API — COMUNICACIÓN CON GOOGLE APPS SCRIPT
// ─────────────────────────────────────────────
const api = {
    async hacerPeticion(payload) {
        payload.token = state.posToken;
        const response = await fetch(CONFIG.SCRIPT_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    },

    async obtenerDatosBackend() {
        ui.mostrarCarga(true, 'Obteniendo datos del día...');
        try {
            const respuesta = await api.hacerPeticion({
                action:        'obtener_datos',
                tipo_servicio: state.tipoServicio,   // <-- backend filtra por esto
            });

            if (respuesta.status === 'success') {
                state.catalogoPlatos   = respuesta.catalogo      || [];
                state.catalogoBebidas  = respuesta.catalogoBebidas || [];
                state.menuPlatosHoy    = respuesta.menuDia       || [];
                state.menuBebidasHoy   = respuesta.menuBebidasDia || [];
                state.listaClientes    = respuesta.clientes      || [];

                // Si veníamos de "iniciarServicio" abrimos POS; si de "irAAdmin" abrimos Admin
                if (state.currentView === 'admin') {
                    admin.renderizar();
                } else {
                    pos.renderizar();
                    pos.renderizarBebidas();
                    app._abrirPOS();
                }
            } else {
                alert('Error del servidor: ' + respuesta.message);
            }
        } catch (error) {
            alert('Fallo de conexión. Revisa el internet de la tablet.');
            console.error(error);
        } finally {
            ui.mostrarCarga(false);
        }
    },

    async guardarMenuDia(platosSeleccionados, bebidasSeleccionadas) {
        return api.hacerPeticion({
            action:         'guardar_menu_dia',
            tipo_servicio:  state.tipoServicio,
            menus:          platosSeleccionados,
            bebidas:        bebidasSeleccionadas,
        });
    },
};

// ─────────────────────────────────────────────
// 7. COLA OFFLINE
// ─────────────────────────────────────────────
const cola = {
    guardar(payload) {
        const pedidoLocal = { idLocal: Date.now().toString(), payload };
        state.colaPedidos.push(pedidoLocal);
        localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.COLA, JSON.stringify(state.colaPedidos));
        cola.procesar();
    },

    async procesar() {
        if (!navigator.onLine || state.colaPedidos.length === 0 || state.sincronizando) return;
        state.sincronizando = true;
        const pendientes = [...state.colaPedidos];

        for (const pedido of pendientes) {
            try {
                const respuesta = await api.hacerPeticion(pedido.payload);
                if (respuesta.status === 'success') {
                    state.colaPedidos = state.colaPedidos.filter(p => p.idLocal !== pedido.idLocal);
                    localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.COLA, JSON.stringify(state.colaPedidos));
                    console.log('Pedido sincronizado:', pedido.idLocal);
                } else {
                    console.error('Error al sincronizar:', respuesta.message);
                    break;
                }
            } catch {
                console.warn('Conexión inestable. Sincronización pausada.');
                break;
            }
        }
        state.sincronizando = false;
    },
};

// ─────────────────────────────────────────────
// 8. POS — VISTA DE PEDIDOS
// ─────────────────────────────────────────────
const pos = {
    // ── Renderizar grilla de PLATOS ──────────
    renderizar() {
        const old = document.getElementById('menus-container');
        const container = old.cloneNode(false);
        old.parentNode.replaceChild(container, old);
        state.cantidadesPlatos = {};

        const platosDeHoy = state.catalogoPlatos.filter(p =>
            state.menuPlatosHoy.includes(p.nombre)
        );

        if (platosDeHoy.length === 0) {
            container.innerHTML = `
                <div style="grid-column:1/-1;text-align:center;padding:20px;font-size:1.1rem;color:#6b8fa3;">
                    No hay platos configurados para hoy.
                </div>`;
            pos.calcularTotal();
            return;
        }

        platosDeHoy.forEach((plato, index) => {
            state.cantidadesPlatos[plato.nombre] = 0;
            const elementId = `qty-plato-${index}`;
            const card = pos._crearCard(plato, elementId);
            container.appendChild(card);
        });

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-qty');
            if (!btn) return;
            pos._actualizarCantidad(state.cantidadesPlatos, btn.dataset.nombre,
                parseInt(btn.dataset.cambio, 10), btn.dataset.target);
        });

        pos.calcularTotal();
    },

    // ── Renderizar grilla de BEBIDAS ─────────
    renderizarBebidas() {
        const old = document.getElementById('bebidas-container');
        const container = old.cloneNode(false);
        old.parentNode.replaceChild(container, old);
        state.cantidadesBebidas = {};

        const bebidasDeHoy = state.catalogoBebidas.filter(b =>
            state.menuBebidasHoy.includes(b.nombre)
        );

        if (bebidasDeHoy.length === 0) {
            container.innerHTML = `
                <div style="grid-column:1/-1;text-align:center;padding:20px;font-size:1.1rem;color:#6b8fa3;">
                    No hay bebidas configuradas para hoy.
                </div>`;
            pos.calcularTotal();
            return;
        }

        bebidasDeHoy.forEach((bebida, index) => {
            state.cantidadesBebidas[bebida.nombre] = 0;
            const elementId = `qty-bebida-${index}`;
            const card = pos._crearCard(bebida, elementId);
            container.appendChild(card);
        });

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-qty');
            if (!btn) return;
            pos._actualizarCantidad(state.cantidadesBebidas, btn.dataset.nombre,
                parseInt(btn.dataset.cambio, 10), btn.dataset.target);
        });

        pos.calcularTotal();
    },

    // ── Helper: crea un card de ítem ─────────
    _crearCard(item, elementId) {
        const precioBadge = (item.precio != null && item.precio > 0)
            ? `<div class="menu-price">$${item.precio.toLocaleString('es-CO')}</div>`
            : '';
        const card = document.createElement('div');
        card.className = 'menu-card';
        card.innerHTML = `
            <div class="menu-info">
                <div class="menu-name">${item.nombre}</div>
                ${precioBadge}
            </div>
            <div class="controls">
                <button class="btn-qty" data-nombre="${item.nombre}" data-cambio="-1" data-target="${elementId}">-</button>
                <div class="qty-display" id="${elementId}">0</div>
                <button class="btn-qty" data-nombre="${item.nombre}" data-cambio="1"  data-target="${elementId}">+</button>
            </div>`;
        return card;
    },

    // ── Helper: actualiza cantidad en un mapa ─
    _actualizarCantidad(mapaQty, nombre, cambio, elementId) {
        let nueva = (mapaQty[nombre] || 0) + cambio;
        if (nueva < 0) nueva = 0;
        mapaQty[nombre] = nueva;
        document.getElementById(elementId).innerText = nueva;
        pos.calcularTotal();
    },

    // ── Calcular total combinado ──────────────
    calcularTotal() {
        let total = 0;

        for (const [nombre, qty] of Object.entries(state.cantidadesPlatos)) {
            if (qty > 0) {
                const info = state.catalogoPlatos.find(p => p.nombre === nombre);
                total += qty * (info?.precio ?? 0);
            }
        }
        // Bebidas no tienen precio — no suman al total monetario

        document.getElementById('order-total').innerText = '$' + total.toLocaleString('es-CO');
    },

    // ── Salón / Domicilio ─────────────────────
    selectTipo(tipo) {
        state.tipoActual = tipo;
        document.getElementById('btn-salon').classList.toggle('active',      tipo === 'Salón');
        document.getElementById('btn-domicilio').classList.toggle('active',  tipo === 'Domicilio');
        document.getElementById('btn-para-llevar').classList.toggle('active',tipo === 'Para Llevar');

        // Panel de domicilio solo visible cuando el tipo es Domicilio
        const panel = document.getElementById('domicilio-fields');
        if (panel) panel.style.display = tipo === 'Domicilio' ? 'flex' : 'none';

        if (tipo !== 'Domicilio') {
            state.domicilioPara  = '';
            state.domicilioQuien = '';
            const inputPara  = document.getElementById('domicilio-para');
            const inputQuien = document.getElementById('domicilio-quien');
            if (inputPara)  inputPara.value  = '';
            if (inputQuien) inputQuien.value = '';
            domicilioAutocomplete.limpiarSugerencias();
        }
    },

    // ── Registrar pedido ──────────────────────
    registrarPedido() {
        // Construir carrito de platos
        const carritoPlatos = Object.entries(state.cantidadesPlatos)
            .filter(([, qty]) => qty > 0)
            .map(([nombre, qty]) => {
                const info = state.catalogoPlatos.find(p => p.nombre === nombre);
                return { item: nombre, qty, precio: info?.precio ?? 0, categoria: 'Plato' };
            });

        // Construir carrito de bebidas
        const carritoBebidas = Object.entries(state.cantidadesBebidas)
            .filter(([, qty]) => qty > 0)
            .map(([nombre, qty]) => {
                const info = state.catalogoBebidas.find(b => b.nombre === nombre);
                return { item: nombre, qty, categoria: 'Bebida' };
            });

        const carritoFinal = [...carritoPlatos, ...carritoBebidas];

        if (carritoFinal.length === 0) {
            alert('Debes agregar al menos un plato o bebida para registrar el pedido.');
            return;
        }

        if (state.tipoActual === 'Domicilio') {
            const para  = document.getElementById('domicilio-para')?.value.trim();
            const quien = document.getElementById('domicilio-quien')?.value.trim();
            if (!para)  { alert('Por favor indica el local destino (¿Para Dónde?).'); return; }
            if (!quien) { alert('Por favor indica quién recibe el pedido (¿Para Quién?).'); return; }
            state.domicilioPara  = para;
            state.domicilioQuien = quien;
        }

        const payload = {
            action:        'registrar_pedido',
            tipo_servicio: state.tipoServicio,
            tipo:          state.tipoActual,
            carrito:       carritoFinal,
            ...(state.tipoActual === 'Domicilio' && {
                domicilio_para:  state.domicilioPara,
                domicilio_quien: state.domicilioQuien,
            }),
        };

        ui.mostrarToast('Pedido registrado ✓');

        const tipoTras = state.tipoActual;
        pos.renderizar();
        pos.renderizarBebidas();

        if (tipoTras === 'Domicilio') {
            pos.selectTipo('Domicilio');
            state.domicilioPara  = '';
            state.domicilioQuien = '';
            const inputPara  = document.getElementById('domicilio-para');
            const inputQuien = document.getElementById('domicilio-quien');
            if (inputPara)  inputPara.value  = '';
            if (inputQuien) inputQuien.value = '';
            domicilioAutocomplete.limpiarSugerencias();
        } else {
            pos.selectTipo('Salón');
        }

        cola.guardar(payload);
    },
};

// ─────────────────────────────────────────────
// 9. AUTOCOMPLETE — "Para Dónde"
// ─────────────────────────────────────────────
const domicilioAutocomplete = {
    init() {
        const input = document.getElementById('domicilio-para');
        const lista = document.getElementById('domicilio-sugerencias');
        if (!input || !lista) return;

        input.addEventListener('input', () => {
            const query = input.value.trim().toLowerCase();
            lista.innerHTML = '';
            if (!query) return;

            const coincidencias = state.listaClientes.filter(c =>
                c.toLowerCase().includes(query)
            );
            if (coincidencias.length === 0) return;

            coincidencias.forEach(cliente => {
                const item = document.createElement('div');
                item.className   = 'autocomplete-item';
                item.textContent = cliente;
                item.addEventListener('mousedown', () => {
                    input.value  = cliente;
                    lista.innerHTML = '';
                });
                lista.appendChild(item);
            });
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !lista.contains(e.target)) {
                lista.innerHTML = '';
            }
        });
    },

    limpiarSugerencias() {
        const lista = document.getElementById('domicilio-sugerencias');
        if (lista) lista.innerHTML = '';
    },
};

// ─────────────────────────────────────────────
// 10. ADMIN — CONFIGURACIÓN DEL MENÚ DEL DÍA
// ─────────────────────────────────────────────
const admin = {
    _tabActual: 'platos',

    renderizar() {
        admin._renderizarPlatos();
        admin._renderizarBebidas();
        app._abrirAdmin();
        admin.selectTab('platos');
    },

    _renderizarPlatos() {
        const container = document.getElementById('admin-list-container');
        container.innerHTML = '';
        state.catalogoPlatos.forEach((plato, index) => {
            const checked = state.menuPlatosHoy.includes(plato.nombre) ? 'checked' : '';
            const item = document.createElement('div');
            item.className = 'admin-item';
            item.innerHTML = `
                <input type="checkbox" class="admin-plato-check" id="chk-p-${index}"
                       value="${plato.nombre}" ${checked}>
                <label for="chk-p-${index}">${plato.nombre}</label>`;
            container.appendChild(item);
        });
    },

    _renderizarBebidas() {
        const container = document.getElementById('admin-bebidas-container');
        container.innerHTML = '';
        state.catalogoBebidas.forEach((bebida, index) => {
            const checked = state.menuBebidasHoy.includes(bebida.nombre) ? 'checked' : '';
            const item = document.createElement('div');
            item.className = 'admin-item';
            item.innerHTML = `
                <input type="checkbox" class="admin-bebida-check" id="chk-b-${index}"
                       value="${bebida.nombre}" ${checked}>
                <label for="chk-b-${index}">${bebida.nombre}</label>`;
            container.appendChild(item);
        });
    },

    selectTab(tab) {
        admin._tabActual = tab;
        document.getElementById('tab-platos').classList.toggle('active',  tab === 'platos');
        document.getElementById('tab-bebidas').classList.toggle('active', tab === 'bebidas');
        document.getElementById('admin-platos-content').style.display  = tab === 'platos'  ? 'flex' : 'none';
        document.getElementById('admin-bebidas-content').style.display = tab === 'bebidas' ? 'flex' : 'none';
    },

    async guardarMenuDia() {
        const platosSeleccionados  = Array.from(document.querySelectorAll('.admin-plato-check:checked')).map(cb => cb.value);
        const bebidasSeleccionadas = Array.from(document.querySelectorAll('.admin-bebida-check:checked')).map(cb => cb.value);

        ui.mostrarCarga(true, 'Guardando menú del día...');
        try {
            const respuesta = await api.guardarMenuDia(platosSeleccionados, bebidasSeleccionadas);
            if (respuesta.status === 'success') {
                state.menuPlatosHoy  = platosSeleccionados;
                state.menuBebidasHoy = bebidasSeleccionadas;
                ui.mostrarToast('Menú actualizado ✓');
                pos.renderizar();
                pos.renderizarBebidas();
                ui.toggleView();
            } else {
                alert('Error al guardar: ' + respuesta.message);
            }
        } catch (error) {
            alert('Fallo de conexión al guardar el menú.');
            console.error(error);
        } finally {
            ui.mostrarCarga(false);
        }
    },
};

// ─────────────────────────────────────────────
// 11. HISTORIAL DE PEDIDOS
// ─────────────────────────────────────────────
const historial = {
    _visible: false,

    /** Alterna entre mostrar Historial y volver al POS */
    toggle() {
        historial._visible = !historial._visible;
        const btnH = document.getElementById('btn-historial');

        if (historial._visible) {
            document.getElementById('pos-view').style.display       = 'none';
            document.getElementById('historial-view').style.display = 'flex';
            btnH.classList.add('active');
            historial.cargar();
        } else {
            document.getElementById('historial-view').style.display = 'none';
            document.getElementById('pos-view').style.display       = 'flex';
            btnH.classList.remove('active');
        }
    },

    /** Pide los últimos 5 pedidos al backend y los renderiza */
    async cargar() {
        const container = document.getElementById('historial-container');
        container.innerHTML = '<div class="historial-empty">Cargando...</div>';
        try {
            const respuesta = await api.hacerPeticion({
                action:        'obtener_historial',
                tipo_servicio: state.tipoServicio,
            });
            if (respuesta.status === 'success') {
                state.historialPedidos = respuesta.pedidos || [];
                historial.renderizar();
            } else {
                container.innerHTML = '<div class="historial-empty">Error al cargar el historial.</div>';
            }
        } catch {
            container.innerHTML = '<div class="historial-empty">Sin conexión. No se pudo cargar el historial.</div>';
        }
    },

    /** Renderiza las tarjetas de historial */
    renderizar() {
        const container = document.getElementById('historial-container');
        container.innerHTML = '';

        if (state.historialPedidos.length === 0) {
            container.innerHTML = '<div class="historial-empty">No hay pedidos registrados aún.</div>';
            return;
        }

        state.historialPedidos.forEach(pedido => {
            const card = document.createElement('div');
            card.className = 'historial-card';

            // Hora formateada
            const fecha = new Date(pedido.fecha);
            const hora  = isNaN(fecha) ? pedido.fecha : fecha.toLocaleTimeString('es-CO', {
                hour: '2-digit', minute: '2-digit'
            });

            // Badge de tipo con clase CSS segura
            const tipoSlug = pedido.tipo.toLowerCase().replace(/ /g, '-');
            const tipoBadge = `<span class="historial-tipo historial-tipo-${tipoSlug}">${pedido.tipo}</span>`;

            // Lista de ítems (sin precio para bebidas, con precio para platos)
            const itemsHTML = pedido.items.map(it => {
                const precioStr = it.precio > 0
                    ? `<span class="historial-item-precio">$${it.precio.toLocaleString('es-CO')}</span>`
                    : '';
                return `<div class="historial-item">
                    <span class="historial-item-qty">${it.qty}×</span>
                    <span class="historial-item-nombre">${it.nombre}</span>
                    ${precioStr}
                </div>`;
            }).join('');

            // Total (solo si > 0, es decir si hay platos)
            const totalStr = pedido.total > 0
                ? `<div class="historial-total">Total: $${pedido.total.toLocaleString('es-CO')}</div>`
                : '';

            card.innerHTML = `
                <div class="historial-card-header">
                    <div class="historial-id-hora">
                        <span class="historial-id">${pedido.idPedido}</span>
                        <span class="historial-hora">${hora}</span>
                    </div>
                    ${tipoBadge}
                </div>
                <div class="historial-items">${itemsHTML}</div>
                ${totalStr}`;

            container.appendChild(card);
        });
    },

    /** Resetea el estado visible al volver al POS desde otra pantalla */
    reset() {
        historial._visible = false;
        document.getElementById('btn-historial').classList.remove('active');
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('pos-view').style.display       = 'flex';
    },
};

// ─────────────────────────────────────────────
// 12. UI — UTILIDADES DE INTERFAZ
// ─────────────────────────────────────────────
const ui = {
    toggleView() {
        if (state.currentView === 'pos') {
            state.origenAdmin = 'pos';
            admin.renderizar(); // también llama a app._abrirAdmin()
        } else {
            historial.reset();
            app._abrirPOS();
        }
    },

    mostrarToast(mensaje) {
        const toast = document.getElementById('toast');
        toast.innerText = mensaje;
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, CONFIG.TOAST_DURATION_MS);
    },

    mostrarCarga(mostrar, texto = 'Procesando...') {
        const overlay = document.getElementById('loading-overlay');
        overlay.innerText = texto;
        overlay.style.display = mostrar ? 'flex' : 'none';
    },
};
