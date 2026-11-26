
const CONFIG = {
    TOAST_DURATION_MS: 2000,
    SYNC_INTERVAL_MS: 10_000,
    COCINA_REFRESH_MS: 15_000,
    DOMINIO_USUARIOS: 'megadelicias.local',
    LOCAL_STORAGE_KEYS: {
        COLA: 'pos_cola_pedidos',
        PERFIL: 'pos_perfil',
    },
};

const ROLES = {
    admin: { nombre: 'Administrador', servicio: true, configurar: true, cocina: true },
    mesero: { nombre: 'Mesero', servicio: true, configurar: false, cocina: false },
    cocina: { nombre: 'Cocina', servicio: false, configurar: false, cocina: true },
};

const ESTADOS_PEDIDO = ['Pendiente', 'En preparación', 'Listo'];

const VISTAS = ['login-view', 'home-view', 'pos-view', 'historial-view', 'cocina-view', 'admin-view'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const esUUID = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');

const nuevoUUID = () => crypto.randomUUID
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

const puede = (permiso) => !!(state.perfil && ROLES[state.perfil.rol]?.[permiso]);

const _state = {

    perfil: null,

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
    domicilioAutocomplete.init();
    auth.init();
});

window.addEventListener('online', () => cola.procesar());
setInterval(() => cola.procesar(), CONFIG.SYNC_INTERVAL_MS);

const app = {

    _mostrarVista(...visibles) {
        VISTAS.forEach(id => {
            document.getElementById(id).style.display = visibles.includes(id) ? 'flex' : 'none';
        });
        document.getElementById('app-header').style.display =
            visibles.some(v => v !== 'login-view' && v !== 'home-view') ? 'flex' : 'none';
    },

    mostrarInicio() {
        const rol = ROLES[state.perfil.rol];
        document.getElementById('user-info').innerText = `${state.perfil.nombre} · ${rol.nombre}`;
        document.getElementById('home-buttons-servicio').style.display = rol.servicio ? 'flex' : 'none';
        document.getElementById('home-buttons-cocina').style.display = rol.cocina ? 'flex' : 'none';
        document.getElementById('home-config-links').style.display = rol.configurar ? 'flex' : 'none';
        app._mostrarVista('home-view');
    },

    async iniciarServicio(tipoServicio) {
        if (!puede('servicio')) return;
        state.tipoServicio = tipoServicio;
        await api.obtenerDatosBackend();

    },

    async irAAdmin(tipoServicio) {
        if (!puede('configurar')) return;
        state.tipoServicio = tipoServicio;
        state.currentView = 'admin';
        state.origenAdmin = 'home';
        await api.obtenerDatosBackend();
    },

    volverAInicio() {
        state.tipoServicio = null;
        state.currentView = 'home';
        state.tipoActual = 'Salón';
        cocina.detener();
        historial.reset();
        app.mostrarInicio();
    },

    _abrirPOS() {
        state.currentView = 'pos';
        app._mostrarVista('pos-view');

        document.getElementById('btn-historial').style.display = 'inline-block';

        document.getElementById('btn-toggle').style.display = 'none';

        const badge = state.tipoServicio === 'Desayuno'
            ? `<span class="badge-servicio badge-desayuno">Desayuno</span>`
            : `<span class="badge-servicio badge-almuerzo">Almuerzo</span>`;
        document.getElementById('header-title').innerHTML = `Registro de Pedidos ${badge}`;
    },

    _abrirAdmin() {
        state.currentView = 'admin';
        app._mostrarVista('admin-view');

        document.getElementById('btn-historial').style.display = 'none';

        const btnToggle = document.getElementById('btn-toggle');
        if (state.origenAdmin === 'pos') {
            btnToggle.style.display = 'block';
            btnToggle.innerText = 'Volver a Ventas';
        } else {

            btnToggle.style.display = 'none';
        }

        const badge = state.tipoServicio === 'Desayuno'
            ? `<span class="badge-servicio badge-desayuno">Desayuno</span>`
            : `<span class="badge-servicio badge-almuerzo">Almuerzo</span>`;
        document.getElementById('header-title').innerHTML = `Configuración ${badge}`;
    },
};

const auth = {
    async init() {
        supabaseClient.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT') setTimeout(() => auth._mostrarLogin(), 0);
        });

        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            await auth._cargarPerfil(session.user);
        } else {
            auth._mostrarLogin();
        }
    },

    _mostrarLogin() {
        state.perfil = null;
        cocina.detener();
        document.getElementById('login-clave').value = '';
        app._mostrarVista('login-view');
    },

    async login() {
        let usuario = document.getElementById('login-usuario').value.trim().toLowerCase();
        const clave = document.getElementById('login-clave').value;
        if (!usuario || !clave) return;
        if (!usuario.includes('@')) usuario = `${usuario}@${CONFIG.DOMINIO_USUARIOS}`;

        ui.mostrarCarga(true, 'Iniciando sesión...');
        try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email: usuario, password: clave });
            if (error) {
                const msg = error.message === 'Invalid login credentials'
                    ? 'Usuario o contraseña incorrectos.'
                    : 'No se pudo iniciar sesión. Verifica tu conexión a internet.';
                await ui.alert('Inicio de sesión', msg);
                return;
            }
            await auth._cargarPerfil(data.user);
        } finally {
            ui.mostrarCarga(false);
        }
    },

    async _cargarPerfil(user) {
        let perfil = null;
        const { data, error } = await supabaseClient
            .from('profiles').select('id, nombre, rol, activo').eq('id', user.id).maybeSingle();

        if (!error) {
            perfil = data;
            try { localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.PERFIL, JSON.stringify(perfil)); } catch (e) { }
        } else {
            // Sin conexion: usar el ultimo perfil conocido de este usuario
            try {
                const cache = JSON.parse(localStorage.getItem(CONFIG.LOCAL_STORAGE_KEYS.PERFIL));
                if (cache?.id === user.id) perfil = cache;
            } catch (e) { }
        }

        if (!perfil || !perfil.activo || !ROLES[perfil.rol]) {
            await ui.alert('Sin acceso', 'Tu usuario no tiene un rol asignado o está desactivado. Pide a un administrador que lo revise.');
            await supabaseClient.auth.signOut();
            return;
        }

        state.perfil = perfil;
        cola.procesar();
        if (perfil.rol === 'cocina') {
            cocina.abrir();
        } else {
            app.mostrarInicio();
        }
    },

    async logout() {
        if (state.colaPedidos.length > 0) {
            const ok = await ui.confirmar('Pedidos sin enviar',
                `Hay ${state.colaPedidos.length} pedido(s) que aún no se han enviado. Se enviarán cuando alguien inicie sesión en este dispositivo con internet. ¿Cerrar sesión de todas formas?`);
            if (!ok) return;
        }
        await supabaseClient.auth.signOut();
        try { localStorage.removeItem(CONFIG.LOCAL_STORAGE_KEYS.PERFIL); } catch (e) { }
        auth._mostrarLogin();
    },
};

const api = {
    async obtenerDatosBackend() {
        ui.mostrarCarga(true, 'Obteniendo datos de Supabase...');
        try {
            const [
                { data: _dishes, error: errDishes },
                { data: _sections, error: errSec },
                { data: _clients, error: errClients }
            ] = await Promise.all([
                supabaseClient.from('menu_dishes').select('*, menu_sections(*), dish_modifications(*)'),
                supabaseClient.from('menu_sections').select('*'),
                supabaseClient.from('clients').select('*')
            ]);

            if (errDishes) throw errDishes;
            if (errSec) throw errSec;
            if (errClients) throw errClients;

            state.catalogoPlatos = [];
            state.catalogoBebidas = [];
            state.menuPlatosHoy = [];
            state.menuBebidasHoy = [];
            state.listaClientes = _clients ? _clients.map(c => c.name) : [];

            if (_dishes) {
                _dishes.forEach(d => {
                    const sectionName = d.menu_sections?.name || '';
                    const isBebida = sectionName.toLowerCase() === 'bebidas';

                    const pList = [];
                    if (!d.dish_modifications || d.dish_modifications.length === 0) {
                        pList.push({ id: d.id, nombre: d.name, precio: Number(d.base_price), mods: [], base: d });
                    } else {
                        const mGroups = {};
                        d.dish_modifications.forEach(m => {
                            const cat = m.modification_category || 'General';
                            if (!mGroups[cat]) mGroups[cat] = [];
                            mGroups[cat].push(m);
                        });

                        let combos = [{ mods: [], price: 0, str: [] }];
                        Object.values(mGroups).forEach(group => {
                            const newCombos = [];
                            group.forEach(mod => {
                                combos.forEach(c => {
                                    newCombos.push({
                                        mods: [...c.mods, mod.name],
                                        price: c.price + Number(mod.price_adjustment),
                                        str: [...c.str, mod.name]
                                    });
                                });
                            });
                            combos = newCombos;
                        });

                        combos.forEach(c => {
                            pList.push({
                                id: d.id,
                                nombre: `${d.name} (${c.str.join(' + ')})`,
                                precio: Number(d.base_price) + c.price,
                                mods: c.mods,
                                base: d
                            });
                        });
                    }

                    const targetCat = isBebida ? state.catalogoBebidas : state.catalogoPlatos;
                    const targetHoy = isBebida ? state.menuBebidasHoy : state.menuPlatosHoy;

                    if (isBebida || sectionName.toLowerCase() === (state.tipoServicio || '').toLowerCase()) {
                        pList.forEach(v => targetCat.push(v));
                        if (d.is_available) pList.forEach(v => targetHoy.push(v.nombre));
                    }
                });
            }

            if (state.currentView === 'admin') {
                admin.renderizar();
            } else {
                pos.renderizar();
                pos.renderizarBebidas();
                app._abrirPOS();
            }
        } catch (error) {
            ui.alert('Error de Configuración', 'Fallo de conexión a Supabase. Verifica que el URL y KEY en supabase-client.js sean correctos.');
            console.error(error);
        } finally {
            ui.mostrarCarga(false);
        }
    },

    async guardarMenuDia(platosIds, bebidasIds) {
        const todosSeleccionados = new Set([...platosIds, ...bebidasIds]);
        const uniqueBases = new Map();

        state.catalogoPlatos.forEach(p => uniqueBases.set(p.base.id, p.base.id));
        state.catalogoBebidas.forEach(b => uniqueBases.set(b.base.id, b.base.id));

        const updates = Array.from(uniqueBases.values()).map(id => ({
            id: id,
            is_available: todosSeleccionados.has(id)
        }));

        try {
            await Promise.all(updates.map(u =>
                supabaseClient.from('menu_dishes')
                    .update({ is_available: u.is_available })
                    .eq('id', u.id)
            ));

            state.cantidadesPlatos = {};
            state.cantidadesBebidas = {};

            setTimeout(() => api.obtenerDatosBackend(), 100);
            return { status: 'success' };
        } catch (e) {
            console.error('Update failed', e);
            return { status: 'error', message: e.message };
        }
    },
};

const cola = {
    guardar(payload) {
        state.colaPedidos.push({ idLocal: nuevoUUID(), payload });
        cola._persistir();
        cola.procesar();
    },

    _persistir() {
        localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.COLA, JSON.stringify(state.colaPedidos));
    },

    retryDelay: 2000,
    async procesar() {
        if (!navigator.onLine || !state.perfil || state.colaPedidos.length === 0 || state.sincronizando) return;
        state.sincronizando = true;

        // Pedidos guardados con la version anterior no tenian UUID
        state.colaPedidos.forEach(p => { if (!esUUID(p.idLocal)) p.idLocal = nuevoUUID(); });
        cola._persistir();

        try {
            for (const pedido of [...state.colaPedidos]) {
                const p = pedido.payload;
                const { data: orderId, error } = await supabaseClient.rpc('registrar_pedido', {
                    p_client_id: pedido.idLocal,
                    p_tipo: p.tipo,
                    p_cliente: p.domicilio_quien || '',
                    p_destino: p.domicilio_para || '',
                    p_items: (p.carrito || []).map(c => ({
                        menu_dish_id: c.dish_id,
                        quantity: c.qty,
                        unit_price: c.precio,
                        modifications_selected: c.mods && c.mods.length > 0 ? c.mods.join(', ') : null,
                    })),
                });
                if (error) throw error;

                state.colaPedidos = state.colaPedidos.filter(q => q.idLocal !== pedido.idLocal);
                cola._persistir();
                console.log('Pedido insertado en Supabase:', orderId);
                cola.retryDelay = 2000;
            }
        } catch (e) {
            console.warn('Fallo Supabase. Reintentando luego.', e);
            cola.retryDelay = Math.min(cola.retryDelay * 2, 60000);
            setTimeout(() => cola.procesar(), cola.retryDelay);
        } finally {
            state.sincronizando = false;
        }
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

        const grupos = {
            'Huevos': { variantes: [], minPrecio: Infinity },
            'Calentados': { variantes: [], minPrecio: Infinity },
            'Otros': []
        };

        platosDeHoy.forEach((plato) => {
            state.cantidadesPlatos[plato.nombre] = 0;
            const nm = plato.nombre.toLowerCase();
            if (nm.startsWith('huevo')) {
                grupos['Huevos'].variantes.push(plato);
                if (plato.precio > 0 && plato.precio < grupos['Huevos'].minPrecio) grupos['Huevos'].minPrecio = plato.precio;
            } else if (nm.startsWith('calentado')) {
                grupos['Calentados'].variantes.push(plato);
                if (plato.precio > 0 && plato.precio < grupos['Calentados'].minPrecio) grupos['Calentados'].minPrecio = plato.precio;
            } else {
                grupos['Otros'].push(plato);
            }
        });

        if (grupos['Huevos'].variantes.length > 0) {
            if (grupos['Huevos'].minPrecio === Infinity) grupos['Huevos'].minPrecio = 0;
            container.appendChild(pos._crearParentCard('Huevos', grupos['Huevos']));
        }
        if (grupos['Calentados'].variantes.length > 0) {
            if (grupos['Calentados'].minPrecio === Infinity) grupos['Calentados'].minPrecio = 0;
            container.appendChild(pos._crearParentCard('Calentados', grupos['Calentados']));
        }

        grupos['Otros'].forEach((plato, index) => {
            const elementId = `qty-plato-${index}`;
            const card = pos._crearCard(plato, elementId);
            container.appendChild(card);
        });

        container.addEventListener('click', (e) => {
            const expandBtn = e.target.closest('.btn-expand-accordion');
            if (expandBtn) {
                const card = expandBtn.closest('.parent-card');
                card.classList.toggle('expanded');
                const content = card.querySelector('.accordion-content');
                if (card.classList.contains('expanded')) {
                    content.style.display = 'block';
                    expandBtn.querySelector('.expand-icon').innerText = '🔼 Ocultar';
                } else {
                    content.style.display = 'none';
                    expandBtn.querySelector('.expand-icon').innerText = '🔽 Opciones';
                }
                return;
            }

            const btn = e.target.closest('.btn-qty');
            if (!btn) return;
            pos._actualizarCantidad(state.cantidadesPlatos, btn.dataset.nombre,
                parseInt(btn.dataset.cambio, 10), btn.dataset.target);
        });

        pos.calcularTotal();
    },

    _extraerBase(nombre, tipo) {
        const n = nombre.toLowerCase();
        if (tipo === 'Huevos') {
            if (n.includes('ranchero')) return 'Rancheros';
            if (n.includes('cacerola')) return 'En Cacerola';
            if (n.includes('revuelto')) return 'Revueltos';
            if (n.includes('perico')) return 'Pericos';
            return 'Opciones';
        } else {
            if (n.includes('res')) return 'Res';
            if (n.includes('cerdo')) return 'Cerdo';
            if (n.includes('azadura')) return 'Azadura';
            if (n.includes('chicharron') || n.includes('chicharrón')) return 'Chicharrón';
            return 'Opciones';
        }
    },

    _extraerMod(nombre, tipo) {
        const n = nombre.toLowerCase();
        if (tipo === 'Huevos') {
            if (n.includes('sin aliño')) return 'Sin aliños';
            if (n.includes('aliño')) return 'Con aliños';
            return 'Normal';
        } else {
            if (n.includes('ca')) return '+ Huevos CA';
            if (n.includes('sa')) return '+ Huevos SA';
            return 'Solo';
        }
    },

    _crearParentCard(titulo, grupo) {
        const card = document.createElement('div');
        card.className = 'menu-card parent-card';
        card.dataset.grupo = titulo;

        const precioBadge = (grupo.minPrecio > 0)
            ? `<div class="menu-price">Desde $${grupo.minPrecio.toLocaleString('es-CO')}</div>`
            : '';

        const porBase = {};
        grupo.variantes.forEach(v => {
            const base = pos._extraerBase(v.nombre, titulo);
            if (!porBase[base]) porBase[base] = [];
            porBase[base].push(v);
        });

        let accordionHtml = '<div class="accordion-content" style="display:none; width: 100%;">';
        for (const [base, items] of Object.entries(porBase)) {
            accordionHtml += `<div class="accordion-base-title">${base}</div>`;
            items.forEach((item, i) => {
                const mod = pos._extraerMod(item.nombre, titulo);
                const safeId = `qty-acc-${titulo}-${base}-${i}`.replace(/\s+/g, '-');
                accordionHtml += `
                    <div class="accordion-variant">
                        <div class="accordion-variant-info">
                            <span class="acc-v-name">${mod}</span>
                            <span class="acc-v-price">$${(item.precio || 0).toLocaleString('es-CO')}</span>
                        </div>
                        <div class="controls acc-controls">
                            <button class="btn-qty" data-nombre="${item.nombre}" data-cambio="-1" data-target="${safeId}">-</button>
                            <div class="qty-display" id="${safeId}">0</div>
                            <button class="btn-qty" data-nombre="${item.nombre}" data-cambio="1"  data-target="${safeId}">+</button>
                        </div>
                    </div>`;
            });
        }
        accordionHtml += '</div>';

        card.innerHTML = `
            <div class="parent-badge" id="badge-${titulo}" style="display:none;">0</div>
            <div class="menu-info btn-expand-accordion" style="cursor:pointer; width:100%;">
                <div class="menu-name">${titulo}</div>
                ${precioBadge}
                <div class="expand-icon">🔽 Opciones</div>
            </div>
            ${accordionHtml}
        `;
        return card;
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

        const el = document.getElementById(elementId);
        if (el) el.innerText = nueva;

        pos.calcularTotal();

        ['Huevos', 'Calentados'].forEach(grupo => {
            const card = document.querySelector(`.parent-card[data-grupo="${grupo}"]`);
            if (card) {
                let total = 0;
                const displays = card.querySelectorAll('.accordion-content .qty-display');
                displays.forEach(d => total += parseInt(d.innerText, 10));
                const badge = card.querySelector('.parent-badge');
                if (total > 0) {
                    badge.style.display = 'flex';
                    badge.innerText = total;
                } else {
                    badge.style.display = 'none';
                }
            }
        });
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
                return { dish_id: info.id, item: nombre, mods: info.mods, qty, precio: info.precio, categoria: 'Plato' };
            });

        const carritoBebidas = Object.entries(state.cantidadesBebidas)
            .filter(([, qty]) => qty > 0)
            .map(([nombre, qty]) => {
                const info = state.catalogoBebidas.find(b => b.nombre === nombre);
                return { dish_id: info.id, item: nombre, mods: info.mods, qty, precio: info.precio, categoria: 'Bebida' };
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

        const totalAmount = carritoFinal.reduce((a, c) => a + (c.qty * c.precio), 0);

        const payload = {
            tipo: state.tipoActual,
            carrito: carritoFinal,
            total: totalAmount,
            domicilio_para: state.domicilioPara || null,
            domicilio_quien: state.domicilioQuien || null,
        };

        const currentId = "PENDIENTE";
        const pedidoOptimista = {
            idPedido: currentId,
            fecha: new Date().toISOString(),
            tipo: state.tipoActual,
            domicilioPara: state.domicilioPara || '',
            domicilioQuien: state.domicilioQuien || '',
            items: carritoFinal.map(c => ({ ...c, nombre: c.item })),
            total: totalAmount
        };
        state.historialPedidos = [pedidoOptimista, ...state.historialPedidos];
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

        const uniqueBases = new Map();
        state.catalogoPlatos.forEach(plato => {
            if (!uniqueBases.has(plato.base.id)) {
                uniqueBases.set(plato.base.id, plato.base);
            }
        });

        const sortedPlatos = Array.from(uniqueBases.values()).sort((a, b) => a.name.localeCompare(b.name, 'es-CO'));

        sortedPlatos.forEach((baseDish, index) => {
            const checked = baseDish.is_available ? 'checked' : '';
            const item = document.createElement('div');
            item.className = 'admin-item';
            item.innerHTML = `
                <input type="checkbox" class="admin-plato-check" id="chk-p-${index}"
                       value="${baseDish.id}" ${checked}>
                <label for="chk-p-${index}">${baseDish.name}</label>`;
            container.appendChild(item);
        });
    },

    _renderizarBebidas() {
        const container = document.getElementById('admin-bebidas-container');
        container.innerHTML = '';

        const uniqueBases = new Map();
        state.catalogoBebidas.forEach(bebida => {
            if (!uniqueBases.has(bebida.base.id)) {
                uniqueBases.set(bebida.base.id, bebida.base);
            }
        });

        const sortedBebidas = Array.from(uniqueBases.values()).sort((a, b) => a.name.localeCompare(b.name, 'es-CO'));

        sortedBebidas.forEach((baseDish, index) => {
            const checked = baseDish.is_available ? 'checked' : '';
            const item = document.createElement('div');
            item.className = 'admin-item';
            item.innerHTML = `
                <input type="checkbox" class="admin-bebida-check" id="chk-b-${index}"
                       value="${baseDish.id}" ${checked}>
                <label for="chk-b-${index}">${baseDish.name}</label>`;
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
                ui.mostrarToast('Menú actualizado correctamente');
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
            state.historialPedidos = await pedidosDelDia.obtener();
            historial.renderizar();
        } catch (e) {
            container.innerHTML = '<div class="historial-empty">Sin conexión a Supabase.</div>';
            console.error(e);
        }
    },

    renderizar() {
        const container = document.getElementById('historial-container');
        container.innerHTML = '';

        if (state.historialPedidos.length === 0) {
            container.innerHTML = '<div class="historial-empty">No hay pedidos registrados hoy.</div>';
            return;
        }

        state.historialPedidos.forEach(pedido => {
            container.appendChild(pedidosDelDia.crearTarjeta(pedido, { precios: true }));
        });
    },

    reset() {
        historial._visible = false;
        document.getElementById('btn-historial').classList.remove('active');
        document.getElementById('historial-view').style.display = 'none';
        document.getElementById('pos-view').style.display = 'flex';
    },
};

const pedidosDelDia = {
    async obtener() {
        const inicio = new Date();
        inicio.setHours(0, 0, 0, 0);

        const { data, error } = await supabaseClient
            .from('customer_orders')
            .select('*, profiles(nombre), order_line_items(*, menu_dishes(name, menu_sections(name)))')
            .gte('created_at', inicio.toISOString())
            .order('created_at', { ascending: false })
            .limit(300);

        if (error) throw error;

        return data.map(o => ({
            uuid: o.id,
            idPedido: o.id.split('-')[0].toUpperCase(),
            fecha: o.created_at,
            tipo: o.order_type,
            estado: o.order_status,
            mesero: o.profiles?.nombre || '',
            domicilioPara: o.delivery_destination || '',
            domicilioQuien: o.customer_name || '',
            items: o.order_line_items.map(li => ({
                nombre: li.menu_dishes ? li.menu_dishes.name : 'Item',
                qty: li.quantity,
                precio: Number(li.unit_price),
                categoria: (li.menu_dishes?.menu_sections?.name || '').toLowerCase() === 'bebidas' ? 'Bebida' : 'Plato',
                modificaciones: li.modifications_selected,
            })),
            total: Number(o.total_amount),
        }));
    },

    crearTarjeta(pedido, { precios = true, acciones = '' } = {}) {
        const card = document.createElement('div');
        card.className = 'historial-card';

        const fecha = new Date(pedido.fecha);
        const hora = isNaN(fecha) ? pedido.fecha : fecha.toLocaleTimeString('es-CO', {
            hour: '2-digit', minute: '2-digit'
        });

        const slug = (txt) => String(txt || '').toLowerCase().normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/ /g, '-');

        const tipoBadge = `<span class="historial-tipo historial-tipo-${slug(pedido.tipo)}">${esc(pedido.tipo)}</span>`;
        const estadoBadge = pedido.estado
            ? `<span class="pedido-estado pedido-estado-${slug(pedido.estado)}">${esc(pedido.estado)}</span>`
            : '';

        const platos = pedido.items.filter(it => it.categoria === 'Plato');
        const bebidas = pedido.items.filter(it => it.categoria === 'Bebida');

        const renderItems = (items) => items.map(it => {
            const precioStr = precios && it.precio > 0
                ? `<span class="historial-item-precio">$${it.precio.toLocaleString('es-CO')}</span>`
                : '';
            const modStr = it.modificaciones ? `<div style="font-size:0.8rem;color:#6b8fa3;margin-left:25px;">${esc(it.modificaciones)}</div>` : '';
            return `<div class="historial-item-wrapper" style="display:flex; flex-direction:column; gap:2px; margin-bottom:4px;">
                <div class="historial-item">
                    <span class="historial-item-qty">${esc(it.qty)}×</span>
                    <span class="historial-item-nombre">${esc(it.nombre)}</span>
                    ${precioStr}
                </div>
                ${modStr}
            </div>`;
        }).join('');

        const separador = (platos.length > 0 && bebidas.length > 0)
            ? '<div class="historial-items-divider"></div>'
            : '';

        const domicilioHTML = (pedido.tipo === 'Domicilio' && pedido.domicilioPara)
            ? `<div class="historial-domicilio">
                   <span><strong>${esc(pedido.domicilioPara)}</strong> — ${esc(pedido.domicilioQuien)}</span>
               </div>`
            : '';

        const meseroHTML = pedido.mesero
            ? `<div class="pedido-mesero">Registró: ${esc(pedido.mesero)}</div>`
            : '';

        const totalStr = precios && pedido.total > 0
            ? `<div class="historial-total">Total: $${pedido.total.toLocaleString('es-CO')}</div>`
            : '';

        card.innerHTML = `
            <div class="historial-card-header">
                <div class="historial-id-hora">
                    <span class="historial-id">${esc(pedido.idPedido)}</span>
                    <span class="historial-hora">${esc(hora)}</span>
                </div>
                <div class="pedido-badges">${estadoBadge}${tipoBadge}</div>
            </div>
            <div class="historial-items">${renderItems(platos) + separador + renderItems(bebidas)}</div>
            ${domicilioHTML}
            ${meseroHTML}
            ${totalStr}
            ${acciones}`;

        return card;
    },
};

const cocina = {
    _timer: null,
    _pedidos: [],

    abrir() {
        if (!puede('cocina')) return;
        state.currentView = 'cocina';
        app._mostrarVista('cocina-view');
        document.getElementById('btn-historial').style.display = 'none';
        document.getElementById('btn-toggle').style.display = 'none';
        document.getElementById('header-title').innerText = 'Cocina · Pedidos de hoy';

        cocina.detener();
        cocina.cargar();
        cocina._timer = setInterval(() => cocina.cargar(true), CONFIG.COCINA_REFRESH_MS);
    },

    detener() {
        if (cocina._timer) clearInterval(cocina._timer);
        cocina._timer = null;
    },

    async cargar(silencioso = false) {
        const container = document.getElementById('cocina-container');
        if (!silencioso) container.innerHTML = '<div class="historial-empty">Cargando...</div>';
        try {
            cocina._pedidos = await pedidosDelDia.obtener();
            cocina.renderizar();
        } catch (e) {
            if (!silencioso) container.innerHTML = '<div class="historial-empty">Sin conexión a Supabase.</div>';
            console.error(e);
        }
    },

    renderizar() {
        const container = document.getElementById('cocina-container');
        container.innerHTML = '';

        // Activos del mas antiguo al mas nuevo; listos al final
        const activos = cocina._pedidos.filter(p => p.estado !== 'Listo').reverse();
        const listos = cocina._pedidos.filter(p => p.estado === 'Listo');

        if (activos.length === 0) {
            container.innerHTML = '<div class="historial-empty">No hay pedidos pendientes.</div>';
        }

        activos.forEach(p => {
            const siguiente = ESTADOS_PEDIDO[ESTADOS_PEDIDO.indexOf(p.estado) + 1];
            const etiqueta = siguiente === 'Listo' ? 'Marcar listo' : 'Empezar preparación';
            const acciones = siguiente
                ? `<button class="btn-estado" data-id="${esc(p.uuid)}" data-estado="${esc(siguiente)}">${etiqueta}</button>`
                : '';
            container.appendChild(pedidosDelDia.crearTarjeta(p, { precios: false, acciones }));
        });

        if (listos.length > 0) {
            const titulo = document.createElement('div');
            titulo.className = 'section-label';
            titulo.innerText = `Listos (${listos.length})`;
            container.appendChild(titulo);
            listos.forEach(p => {
                const card = pedidosDelDia.crearTarjeta(p, { precios: false });
                card.classList.add('pedido-listo');
                container.appendChild(card);
            });
        }

        container.querySelectorAll('.btn-estado').forEach(btn => {
            btn.addEventListener('click', () => cocina.cambiarEstado(btn.dataset.id, btn.dataset.estado, btn));
        });
    },

    async cambiarEstado(id, estado, btn) {
        btn.disabled = true;
        const { error } = await supabaseClient
            .from('customer_orders')
            .update({ order_status: estado, updated_at: new Date().toISOString() })
            .eq('id', id);
        if (error) {
            btn.disabled = false;
            ui.alert('Error', 'No se pudo actualizar el pedido. Verifica tu conexión.');
            console.error(error);
            return;
        }
        const pedido = cocina._pedidos.find(p => p.uuid === id);
        if (pedido) pedido.estado = estado;
        cocina.renderizar();
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

    async confirmar(titulo, mensaje) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modal-overlay');
            const btnCancel = document.getElementById('btn-modal-cancel');
            const btnConfirm = document.getElementById('btn-modal-confirm');

            document.getElementById('modal-title').innerText = titulo;
            document.getElementById('modal-message').innerText = mensaje || '';
            document.getElementById('modal-input').style.display = 'none';
            btnCancel.style.display = 'block';
            btnConfirm.innerText = 'Sí, continuar';
            overlay.style.display = 'flex';

            const close = (val) => {
                overlay.style.display = 'none';
                btnConfirm.onclick = null;
                btnCancel.onclick = null;
                resolve(val);
            };

            btnConfirm.onclick = () => close(true);
            btnCancel.onclick = () => close(false);
        });
    },
};
