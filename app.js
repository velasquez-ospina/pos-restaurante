

const CONFIG = {
    SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyNAJcM-FVx43MjXYufdiXsCxwGckMqlEr0Tc3SGAvGpu8IDiITq_zdV2LyNcZAGbO3/exec',
    TOAST_DURATION_MS: 2000,
    SYNC_INTERVAL_MS: 10_000,
    FETCH_TIMEOUT_MS: 10_000,
    SECURITY_CLICK_THRESHOLD: 5,
    SECURITY_CLICK_WINDOW_MS: 3000,
    LOCAL_STORAGE_KEYS: {
        TOKEN: 'pos_token_seguridad',
        COLA: 'pos_cola_pedidos',
    },
};

const _state = {

    posToken: localStorage.getItem(CONFIG.LOCAL_STORAGE_KEYS.TOKEN),
    securityClickCount: 0,
    securityClickTimer: null,

    currentView: 'home',
    tipoServicio: null,
    origenAdmin: 'home',

    tipoActual: 'Salón',
    cantidadesPlatos: {},
    cantidadesBebidas: {},

    catalogoPlatos: [],
    catalogoBebidas: [],

    menuPlatosHoy: [],
    menuBebidasHoy: [],

    listaClientes: [],

    historialPedidos: [],

    domicilioPara: '',
    domicilioQuien: '',

    colaPedidos: JSON.parse(localStorage.getItem(CONFIG.LOCAL_STORAGE_KEYS.COLA)) || [],
    sincronizando: false,
};

const stateListeners = [];
const state = new Proxy(_state, {
    set(target, prop, value) {
        target[prop] = value;
        stateListeners.forEach(listener => listener(prop, value, target));
        return true;
    }
});

const onStateChange = (propName, callback) => {
    stateListeners.push((prop, val, fullState) => {
        if (prop === propName) callback(val, fullState);
    });
};

window.addEventListener('load', () => {
    auth.verificarSeguridad();
    domicilioAutocomplete.init();
});

window.addEventListener('online', () => cola.procesar());
setInterval(() => cola.procesar(), CONFIG.SYNC_INTERVAL_MS);

const app = {

    async iniciarServicio(tipoServicio) {
        state.tipoServicio = tipoServicio;
        await api.obtenerDatosBackend();

    },

    async irAAdmin(tipoServicio) {
        state.tipoServicio = tipoServicio;
        state.currentView = 'admin';
        state.origenAdmin = 'home';
        await api.obtenerDatosBackend();
    },

    volverAInicio() {
        state.tipoServicio = null;
        state.currentView = 'home';
        state.tipoActual = 'Salón';

        document.getElementById('home-view').style.display = 'flex';
        document.getElementById('app-header').style.display = 'none';
        document.getElementById('pos-view').style.display = 'none';
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('admin-view').style.display = 'none';
    },

    _abrirPOS() {
        state.currentView = 'pos';
        document.getElementById('home-view').style.display = 'none';
        document.getElementById('app-header').style.display = 'flex';
        document.getElementById('pos-view').style.display = 'flex';
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('admin-view').style.display = 'none';

        document.getElementById('btn-historial').style.display = 'inline-block';

        document.getElementById('btn-toggle').style.display = 'none';

        const badge = state.tipoServicio === 'Desayuno'
            ? `<span class="badge-servicio badge-desayuno">️ Desayuno</span>`
            : `<span class="badge-servicio badge-almuerzo">️ Almuerzo</span>`;
        document.getElementById('header-title').innerHTML = `Registro de Pedidos ${badge}`;
    },

    _abrirAdmin() {
        state.currentView = 'admin';
        document.getElementById('home-view').style.display = 'none';
        document.getElementById('app-header').style.display = 'flex';
        document.getElementById('pos-view').style.display = 'none';
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('admin-view').style.display = 'flex';

        document.getElementById('btn-historial').style.display = 'none';

        const btnToggle = document.getElementById('btn-toggle');
        if (state.origenAdmin === 'pos') {
            btnToggle.style.display = 'block';
            btnToggle.innerText = 'Volver a Ventas';
        } else {

            btnToggle.style.display = 'none';
        }

        const badge = state.tipoServicio === 'Desayuno'
            ? `<span class="badge-servicio badge-desayuno">️ Desayuno</span>`
            : `<span class="badge-servicio badge-almuerzo">️ Almuerzo</span>`;
        document.getElementById('header-title').innerHTML = `Configuración ${badge}`;
    },
};

const auth = {
    async verificarSeguridad() {
        if (!state.posToken) {
            const clave = await ui.prompt('Seguridad', 'Ingresa la clave de autorización para este dispositivo:', 'password');
            if (clave) {
                state.posToken = clave;
                localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.TOKEN, clave);
            } else {
                await ui.alert('Acceso Denegado', 'No podrás operar el sistema sin la clave de seguridad. Recarga la página.');
            }
        }
    },

    async resetearClave() {
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
            await ui.alert('Seguridad', 'Clave de seguridad eliminada del dispositivo.');
            auth.verificarSeguridad();
        }
    },
};

const api = {
    async hacerPeticion(payload) {
        payload.token = state.posToken;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(CONFIG.SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                console.warn('Network timeout, fetch aborted');
            }
            throw error;
        }
    },

    async obtenerDatosBackend() {
        ui.mostrarCarga(true, 'Obteniendo datos del día...');
        try {
            const respuesta = await api.hacerPeticion({
                action: 'obtener_datos',
                tipo_servicio: state.tipoServicio,
            });

            if (respuesta.status === 'success') {
                state.catalogoPlatos = respuesta.catalogo || [];
                state.catalogoBebidas = respuesta.catalogoBebidas || [];
                state.menuPlatosHoy = respuesta.menuDia || [];
                state.menuBebidasHoy = respuesta.menuBebidasDia || [];
                state.listaClientes = respuesta.clientes || [];

                if (state.currentView === 'admin') {
                    admin.renderizar();
                } else {
                    pos.renderizar();
                    pos.renderizarBebidas();
                    app._abrirPOS();
                }
            } else {
                await ui.alert('Error del servidor', respuesta.message);
                if (respuesta.message === "Acceso denegado.") {
                    localStorage.removeItem(CONFIG.LOCAL_STORAGE_KEYS.TOKEN);
                    state.posToken = null;
                    await auth.verificarSeguridad();
                }
            }
        } catch (error) {
            ui.alert('Problema de Red', 'Fallo de conexión. Revisa el internet de la tablet.');
            console.error(error);
        } finally {
            ui.mostrarCarga(false);
        }
    },

    async guardarMenuDia(platosSeleccionados, bebidasSeleccionadas) {
        return api.hacerPeticion({
            action: 'guardar_menu_dia',
            tipo_servicio: state.tipoServicio,
            menus: platosSeleccionados,
            bebidas: bebidasSeleccionadas,
        });
    },
};

const cola = {
    guardar(payload) {
        const pedidoLocal = { idLocal: Date.now().toString(), payload };
        state.colaPedidos.push(pedidoLocal);
        localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.COLA, JSON.stringify(state.colaPedidos));
        cola.procesar();
    },

    retryDelay: 2000,
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
                    cola.retryDelay = 2000;
                } else {
                    console.error('Error al sincronizar:', respuesta.message);
                    break;
                }
            } catch {
                console.warn('Conexión inestable. Sincronización pausada.');

                cola.retryDelay = Math.min(cola.retryDelay * 2, 60000);
                setTimeout(() => cola.procesar(), cola.retryDelay);
                break;
            }
        }
        state.sincronizando = false;
    },
};

const pos = {

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

    _actualizarCantidad(mapaQty, nombre, cambio, elementId) {
        let nueva = (mapaQty[nombre] || 0) + cambio;
        if (nueva < 0) nueva = 0;
        mapaQty[nombre] = nueva;
        document.getElementById(elementId).innerText = nueva;
        pos.calcularTotal();
    },

    calcularTotal() {
        let total = 0;

        for (const [nombre, qty] of Object.entries(state.cantidadesPlatos)) {
            if (qty > 0) {
                const info = state.catalogoPlatos.find(p => p.nombre === nombre);
                total += qty * (info?.precio ?? 0);
            }
        }

        document.getElementById('order-total').innerText = '$' + total.toLocaleString('es-CO');
    },

    selectTipo(tipo) {
        state.tipoActual = tipo;
        document.getElementById('btn-salon').classList.toggle('active', tipo === 'Salón');
        document.getElementById('btn-domicilio').classList.toggle('active', tipo === 'Domicilio');
        document.getElementById('btn-para-llevar').classList.toggle('active', tipo === 'Para Llevar');

        const panel = document.getElementById('domicilio-fields');
        if (panel) panel.style.display = tipo === 'Domicilio' ? 'flex' : 'none';

        if (tipo !== 'Domicilio') {
            state.domicilioPara = '';
            state.domicilioQuien = '';
            const inputPara = document.getElementById('domicilio-para');
            const inputQuien = document.getElementById('domicilio-quien');
            if (inputPara) inputPara.value = '';
            if (inputQuien) inputQuien.value = '';
            domicilioAutocomplete.limpiarSugerencias();
        }
    },

    async registrarPedido() {

        const carritoPlatos = Object.entries(state.cantidadesPlatos)
            .filter(([, qty]) => qty > 0)
            .map(([nombre, qty]) => {
                const info = state.catalogoPlatos.find(p => p.nombre === nombre);
                return { item: nombre, qty, precio: info?.precio ?? 0, categoria: 'Plato' };
            });

        const carritoBebidas = Object.entries(state.cantidadesBebidas)
            .filter(([, qty]) => qty > 0)
            .map(([nombre, qty]) => {
                const info = state.catalogoBebidas.find(b => b.nombre === nombre);
                return { item: nombre, qty, categoria: 'Bebida' };
            });

        const carritoFinal = [...carritoPlatos, ...carritoBebidas];

        if (carritoFinal.length === 0) {
            await ui.alert('Carrito Vacío', 'Debes agregar al menos un plato o bebida para registrar el pedido.');
            return;
        }

        if (state.tipoActual === 'Domicilio') {
            const para = document.getElementById('domicilio-para')?.value.trim();
            const quien = document.getElementById('domicilio-quien')?.value.trim();
            if (!para) { await ui.alert('Faltan Datos', 'Por favor indica el local destino (¿Para Dónde?).'); return; }
            if (!quien) { await ui.alert('Faltan Datos', 'Por favor indica quién recibe el pedido (¿Para Quién?).'); return; }
            state.domicilioPara = para;
            state.domicilioQuien = quien;
        }

        const payload = {
            action: 'registrar_pedido',
            tipo_servicio: state.tipoServicio,
            tipo: state.tipoActual,
            carrito: carritoFinal,
            ...(state.tipoActual === 'Domicilio' && {
                domicilio_para: state.domicilioPara,
                domicilio_quien: state.domicilioQuien,
            }),
        };

        const currentId = "PED-OPT" + Date.now().toString().slice(-6);
        const pedidoOptimista = {
            idPedido: currentId,
            fecha: new Date().toISOString(),
            tipo: state.tipoActual,
            domicilioPara: state.domicilioPara || '',
            domicilioQuien: state.domicilioQuien || '',
            items: carritoFinal.map(c => ({ ...c, nombre: c.item })),
            total: carritoPlatos.reduce((acc, c) => acc + (c.qty * c.precio), 0)
        };
        state.historialPedidos = [pedidoOptimista, ...state.historialPedidos].slice(0, 5);
        if (historial._visible) {
            historial.renderizar();
        }

        ui.mostrarToast('Pedido registrado ');

        const tipoTras = state.tipoActual;
        pos.renderizar();
        pos.renderizarBebidas();

        if (tipoTras === 'Domicilio') {
            pos.selectTipo('Domicilio');
            state.domicilioPara = '';
            state.domicilioQuien = '';
            const inputPara = document.getElementById('domicilio-para');
            const inputQuien = document.getElementById('domicilio-quien');
            if (inputPara) inputPara.value = '';
            if (inputQuien) inputQuien.value = '';
            domicilioAutocomplete.limpiarSugerencias();
        } else {
            pos.selectTipo('Salón');
        }

        cola.guardar(payload);
    },
};

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
                item.className = 'autocomplete-item';
                item.textContent = cliente;
                item.addEventListener('mousedown', () => {
                    input.value = cliente;
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
        document.getElementById('tab-platos').classList.toggle('active', tab === 'platos');
        document.getElementById('tab-bebidas').classList.toggle('active', tab === 'bebidas');
        document.getElementById('admin-platos-content').style.display = tab === 'platos' ? 'flex' : 'none';
        document.getElementById('admin-bebidas-content').style.display = tab === 'bebidas' ? 'flex' : 'none';
    },

    async guardarMenuDia() {
        const platosSeleccionados = Array.from(document.querySelectorAll('.admin-plato-check:checked')).map(cb => cb.value);
        const bebidasSeleccionadas = Array.from(document.querySelectorAll('.admin-bebida-check:checked')).map(cb => cb.value);

        ui.mostrarCarga(true, 'Guardando menú del día...');
        try {
            const respuesta = await api.guardarMenuDia(platosSeleccionados, bebidasSeleccionadas);
            if (respuesta.status === 'success') {
                state.menuPlatosHoy = platosSeleccionados;
                state.menuBebidasHoy = bebidasSeleccionadas;
                ui.mostrarToast('Menú actualizado ');
                pos.renderizar();
                pos.renderizarBebidas();
                ui.toggleView();
            } else {
                ui.alert('Error al guardar', respuesta.message);
            }
        } catch (error) {
            ui.alert('Conexión', 'Fallo de conexión al guardar el menú.');
            console.error(error);
        } finally {
            ui.mostrarCarga(false);
        }
    },
};

const historial = {
    _visible: false,

    toggle() {
        historial._visible = !historial._visible;
        const btnH = document.getElementById('btn-historial');

        if (historial._visible) {
            document.getElementById('pos-view').style.display = 'none';
            document.getElementById('historial-view').style.display = 'flex';
            btnH.classList.add('active');
            historial.cargar();
        } else {
            document.getElementById('historial-view').style.display = 'none';
            document.getElementById('pos-view').style.display = 'flex';
            btnH.classList.remove('active');
        }
    },

    async cargar() {
        const container = document.getElementById('historial-container');
        container.innerHTML = '<div class="historial-empty">Cargando...</div>';
        try {
            const respuesta = await api.hacerPeticion({
                action: 'obtener_historial',
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

            const fecha = new Date(pedido.fecha);
            const hora = isNaN(fecha) ? pedido.fecha : fecha.toLocaleTimeString('es-CO', {
                hour: '2-digit', minute: '2-digit'
            });

            const tipoSlug = pedido.tipo.toLowerCase().replace(/ /g, '-');
            const tipoBadge = `<span class="historial-tipo historial-tipo-${tipoSlug}">${pedido.tipo}</span>`;

            const platos = pedido.items.filter(it => it.categoria === 'Plato');
            const bebidas = pedido.items.filter(it => it.categoria === 'Bebida');

            const renderItems = (items) => items.map(it => {
                const precioStr = it.precio > 0
                    ? `<span class="historial-item-precio">$${it.precio.toLocaleString('es-CO')}</span>`
                    : '';
                return `<div class="historial-item">
                    <span class="historial-item-qty">${it.qty}×</span>
                    <span class="historial-item-nombre">${it.nombre}</span>
                    ${precioStr}
                </div>`;
            }).join('');

            const separador = (platos.length > 0 && bebidas.length > 0)
                ? '<div class="historial-items-divider"></div>'
                : '';

            const itemsHTML = renderItems(platos) + separador + renderItems(bebidas);

            const domicilioHTML = (pedido.tipo === 'Domicilio' && pedido.domicilioPara)
                ? `<div class="historial-domicilio">
                       <span class="historial-domicilio-icon"></span>
                       <span><strong>${pedido.domicilioPara}</strong> — ${pedido.domicilioQuien}</span>
                   </div>`
                : '';

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
                ${domicilioHTML}
                ${totalStr}`;

            container.appendChild(card);
        });
    },

    reset() {
        historial._visible = false;
        document.getElementById('btn-historial').classList.remove('active');
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('pos-view').style.display = 'flex';
    },
};

const ui = {
    toggleView() {
        if (state.currentView === 'pos') {
            state.origenAdmin = 'pos';
            admin.renderizar();
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

    async prompt(titulo, mensaje, tipoInput = 'text') {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modal-overlay');
            const titleEl = document.getElementById('modal-title');
            const msgEl = document.getElementById('modal-message');
            const inputEl = document.getElementById('modal-input');
            const btnCancel = document.getElementById('btn-modal-cancel');
            const btnConfirm = document.getElementById('btn-modal-confirm');

            titleEl.innerText = titulo;
            msgEl.innerText = mensaje || '';
            inputEl.type = tipoInput;
            inputEl.value = '';
            inputEl.style.display = 'block';
            btnCancel.style.display = 'block';
            btnConfirm.innerText = 'Autorizar';
            overlay.style.display = 'flex';
            inputEl.focus();

            const close = (val) => {
                overlay.style.display = 'none';
                btnConfirm.onclick = null;
                btnCancel.onclick = null;
                resolve(val);
            };

            btnConfirm.onclick = () => close(inputEl.value);
            btnCancel.onclick = () => close(null);
        });
    },

    async alert(titulo, mensaje) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modal-overlay');
            const titleEl = document.getElementById('modal-title');
            const msgEl = document.getElementById('modal-message');
            const inputEl = document.getElementById('modal-input');
            const btnCancel = document.getElementById('btn-modal-cancel');
            const btnConfirm = document.getElementById('btn-modal-confirm');

            titleEl.innerText = titulo;
            msgEl.innerText = mensaje || '';
            inputEl.style.display = 'none';
            btnCancel.style.display = 'none';
            btnConfirm.innerText = 'Aceptar';
            overlay.style.display = 'flex';

            const close = () => {
                overlay.style.display = 'none';
                btnConfirm.onclick = null;
                resolve();
            };

            btnConfirm.onclick = close;
        });
    },
};
