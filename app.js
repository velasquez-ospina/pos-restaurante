/**
 * app.js — Lógica del POS de Restaurante
 *
 * Estructura:
 *  1. Configuración
 *  2. Estado de la aplicación
 *  3. Inicialización
 *  4. Seguridad / Auth
 *  5. Comunicación con el backend (Google Apps Script)
 *  6. Cola offline
 *  7. Vistas — POS
 *  8. Autocomplete de locales (domicilio)
 *  9. Vistas — Admin
 * 10. Utilidades de UI
 */

// ─────────────────────────────────────────────
// 1. CONFIGURACIÓN
// ─────────────────────────────────────────────
const CONFIG = {
    SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyyGaUIsw6OF5tfuwoNuqkZvIa-OKN2iTybZfQjBQHLvmREgspGNYcfJtMYnjVb0zPJ/exec',
    TOAST_DURATION_MS: 2000,
    SYNC_INTERVAL_MS: 10_000,
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
    posToken:            localStorage.getItem(CONFIG.LOCAL_STORAGE_KEYS.TOKEN),
    tipoActual:          'Salón',
    catalogoMaestro:     [],
    menuDelDiaNombres:   [],
    cantidadesPedido:    {},
    currentView:         'pos',
    colaPedidos:         JSON.parse(localStorage.getItem(CONFIG.LOCAL_STORAGE_KEYS.COLA)) || [],
    sincronizando:       false,
    securityClickCount:  0,
    securityClickTimer:  null,
    // Datos de domicilio
    listaClientes:   [],   // locales cargados desde la Sheet 'Clientes'
    domicilioPara:   '',   // local destino  ("Para Dónde?")
    domicilioQuien:  '',   // receptor       ("Para Quién?")
};

// ─────────────────────────────────────────────
// 3. INICIALIZACIÓN
// ─────────────────────────────────────────────
window.addEventListener('load', () => {
    auth.verificarSeguridad();
    if (state.posToken) api.obtenerDatosBackend();
    domicilioAutocomplete.init();
});

window.addEventListener('online', () => cola.procesar());
setInterval(() => cola.procesar(), CONFIG.SYNC_INTERVAL_MS);

// ─────────────────────────────────────────────
// 4. SEGURIDAD / AUTH
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

    /** Clic 5 veces en el título ≤3 s → resetea la clave */
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
// 5. COMUNICACIÓN CON EL BACKEND
// ─────────────────────────────────────────────
const api = {
    async hacerPeticion(payload) {
        payload.token = state.posToken;
        const response = await fetch(CONFIG.SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    },

    async obtenerDatosBackend() {
        ui.mostrarCarga(true, 'Obteniendo datos del día...');
        try {
            const respuesta = await api.hacerPeticion({ action: 'obtener_datos' });
            if (respuesta.status === 'success') {
                state.catalogoMaestro   = respuesta.catalogo;
                state.menuDelDiaNombres = respuesta.menuDia;
                state.listaClientes     = respuesta.clientes || []; // <-- nuevo campo
                pos.renderizar();
                admin.renderizar();
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

    async guardarMenuDia(seleccionados) {
        return api.hacerPeticion({ action: 'guardar_menu_dia', menus: seleccionados });
    },
};

// ─────────────────────────────────────────────
// 6. COLA OFFLINE
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
                    console.error('Error del servidor al sincronizar:', respuesta.message);
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
// 7. VISTA — POS
// ─────────────────────────────────────────────
const pos = {
    renderizar() {
        const container = document.getElementById('menus-container');
        container.innerHTML = '';
        state.cantidadesPedido = {};

        const platosDeHoy = state.catalogoMaestro.filter(p =>
            state.menuDelDiaNombres.includes(p.nombre)
        );

        if (platosDeHoy.length === 0) {
            container.innerHTML = `
                <div style="grid-column:1/-1; text-align:center; margin-top:50px; font-size:1.2rem;">
                    No hay menús configurados para hoy. Usa el botón superior derecho para seleccionarlos.
                </div>`;
            pos.calcularTotal();
            return;
        }

        platosDeHoy.forEach((plato, index) => {
            const precioFormateado = plato.precio.toLocaleString('es-CO');
            state.cantidadesPedido[plato.nombre] = 0;
            const elementId = `qty-${index}`;

            const card = document.createElement('div');
            card.className = 'menu-card';
            card.innerHTML = `
                <div class="menu-info">
                    <div class="menu-name">${plato.nombre}</div>
                    <div class="menu-price">$${precioFormateado}</div>
                </div>
                <div class="controls">
                    <button class="btn-qty" data-nombre="${plato.nombre}" data-cambio="-1" data-target="${elementId}">-</button>
                    <div class="qty-display" id="${elementId}">0</div>
                    <button class="btn-qty" data-nombre="${plato.nombre}" data-cambio="1"  data-target="${elementId}">+</button>
                </div>`;
            container.appendChild(card);
        });

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-qty');
            if (!btn) return;
            pos.actualizarCantidad(
                btn.dataset.nombre,
                parseInt(btn.dataset.cambio, 10),
                btn.dataset.target
            );
        });

        pos.calcularTotal();
    },

    actualizarCantidad(nombrePlato, cambio, elementId) {
        let nueva = (state.cantidadesPedido[nombrePlato] || 0) + cambio;
        if (nueva < 0) nueva = 0;
        state.cantidadesPedido[nombrePlato] = nueva;
        document.getElementById(elementId).innerText = nueva;
        pos.calcularTotal();
    },

    calcularTotal() {
        let total = 0;
        for (const [nombre, qty] of Object.entries(state.cantidadesPedido)) {
            if (qty > 0) {
                const info = state.catalogoMaestro.find(p => p.nombre === nombre);
                total += qty * (info?.precio ?? 0);
            }
        }
        document.getElementById('order-total').innerText = '$' + total.toLocaleString('es-CO');
    },

    selectTipo(tipo) {
        state.tipoActual = tipo;
        document.getElementById('btn-salon').classList.toggle('active', tipo === 'Salón');
        document.getElementById('btn-domicilio').classList.toggle('active', tipo === 'Domicilio');

        // Mostrar / ocultar panel de domicilio
        const panel = document.getElementById('domicilio-fields');
        if (panel) panel.style.display = tipo === 'Domicilio' ? 'flex' : 'none';

        // Limpiar al volver a Salón
        if (tipo === 'Salón') {
            state.domicilioPara  = '';
            state.domicilioQuien = '';
            const inputPara  = document.getElementById('domicilio-para');
            const inputQuien = document.getElementById('domicilio-quien');
            if (inputPara)  inputPara.value  = '';
            if (inputQuien) inputQuien.value = '';
            domicilioAutocomplete.limpiarSugerencias();
        }
    },

    registrarPedido() {
        const carritoFinal = Object.entries(state.cantidadesPedido)
            .filter(([, qty]) => qty > 0)
            .map(([nombre, qty]) => {
                const info = state.catalogoMaestro.find(p => p.nombre === nombre);
                return { item: nombre, qty, precio: info?.precio ?? 0 };
            });

        if (carritoFinal.length === 0) {
            alert('Debes agregar al menos un platillo para registrar el pedido.');
            return;
        }

        // Validaciones adicionales para domicilio
        if (state.tipoActual === 'Domicilio') {
            const para  = document.getElementById('domicilio-para')?.value.trim();
            const quien = document.getElementById('domicilio-quien')?.value.trim();
            if (!para) {
                alert('Por favor indica el local destino (¿Para Dónde?).');
                return;
            }
            if (!quien) {
                alert('Por favor indica quién recibe el pedido (¿Para Quién?).');
                return;
            }
            state.domicilioPara  = para;
            state.domicilioQuien = quien;
        }

        const payload = {
            action: 'registrar_pedido',
            tipo:   state.tipoActual,
            carrito: carritoFinal,
            // Solo se adjuntan si el tipo es Domicilio
            ...(state.tipoActual === 'Domicilio' && {
                domicilio_para:  state.domicilioPara,
                domicilio_quien: state.domicilioQuien,
            }),
        };

        ui.mostrarToast('Pedido registrado');
        pos.renderizar();
        pos.selectTipo('Salón');
        cola.guardar(payload);
    },
};

// ─────────────────────────────────────────────
// 8. AUTOCOMPLETE DE LOCALES (DOMICILIO)
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
                item.className  = 'autocomplete-item';
                item.textContent = cliente;
                item.addEventListener('mousedown', () => { // mousedown antes del blur
                    input.value = cliente;
                    lista.innerHTML = '';
                });
                lista.appendChild(item);
            });
        });

        // Cerrar al hacer clic fuera
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
// 9. VISTA — ADMIN
// ─────────────────────────────────────────────
const admin = {
    renderizar() {
        const container = document.getElementById('admin-list-container');
        container.innerHTML = '';

        state.catalogoMaestro.forEach((plato, index) => {
            const checked = state.menuDelDiaNombres.includes(plato.nombre) ? 'checked' : '';
            const item = document.createElement('div');
            item.className = 'admin-item';
            item.innerHTML = `
                <input type="checkbox" class="admin-checkbox" id="chk-${index}" value="${plato.nombre}" ${checked}>
                <label for="chk-${index}">${plato.nombre}</label>`;
            container.appendChild(item);
        });
    },

    async guardarMenuDia() {
        const seleccionados = Array.from(
            document.querySelectorAll('.admin-checkbox:checked')
        ).map(cb => cb.value);

        ui.mostrarCarga(true, 'Guardando menú del día...');
        try {
            const respuesta = await api.guardarMenuDia(seleccionados);
            if (respuesta.status === 'success') {
                state.menuDelDiaNombres = seleccionados;
                ui.mostrarToast('Menú actualizado');
                pos.renderizar();
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
// 10. UTILIDADES DE UI
// ─────────────────────────────────────────────
const ui = {
    toggleView() {
        const isPOS = state.currentView === 'pos';
        document.getElementById('pos-view').style.display   = isPOS ? 'none'  : 'flex';
        document.getElementById('admin-view').style.display = isPOS ? 'flex'  : 'none';
        document.getElementById('btn-toggle').innerText     = isPOS ? 'Volver a Ventas' : 'Configurar Menú';
        state.currentView = isPOS ? 'admin' : 'pos';
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
