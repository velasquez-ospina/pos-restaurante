
const CONFIG = {
    TOAST_DURATION_MS: 2000,
    SYNC_INTERVAL_MS: 10_000,
    COCINA_REFRESH_MS: 15_000,
    DESPACHO_REFRESH_MS: 20_000,
    DOMINIO_USUARIOS: 'megadelicias.local',
    // Cra. 60 #45A-21 (aproximado desde OpenStreetMap; ajustar si hace falta)
    LOCAL: { lat: 6.2490, lng: -75.5779 },
    LOCAL_STORAGE_KEYS: {
        COLA: 'pos_cola_pedidos',
        PERFIL: 'pos_perfil',
    },
};

const ROLES = {
    admin: { nombre: 'Administrador', servicio: true, configurar: true, cocina: true, domicilios: false, despacho: true },
    mesero: { nombre: 'Mesero', servicio: true, configurar: false, cocina: false, domicilios: false, despacho: false },
    cocina: { nombre: 'Cocina', servicio: false, configurar: false, cocina: true, domicilios: false, despacho: false },
    domiciliario: { nombre: 'Domiciliario', servicio: false, configurar: false, cocina: false, domicilios: true, despacho: false },
};

const ESTADOS_COCINA = ['Pendiente', 'En preparación', 'Listo'];

const VISTAS = ['login-view', 'home-view', 'pos-view', 'historial-view', 'cocina-view', 'domicilios-view', 'despacho-view', 'clientes-view', 'admin-view'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const esUUID = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');

const nuevoUUID = () => crypto.randomUUID
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

// Distancia en linea recta (metros)
const distanciaMetros = (a, b) => {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
};

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
        document.getElementById('home-buttons-domicilios').style.display = rol.domicilios ? 'flex' : 'none';
        document.getElementById('home-buttons-despacho').style.display = rol.despacho ? 'flex' : 'none';
        document.getElementById('home-subtitle').style.display = rol.servicio ? 'block' : 'none';
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
        domicilios.detener();
        despacho.detener();
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
        domicilios.detener();
        despacho.detener();
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
        } else if (perfil.rol === 'domiciliario') {
            domicilios.abrir();
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
            .select('*, creador:profiles!created_by(nombre), domiciliario:profiles!delivery_person_id(nombre), cliente:clients(id, name, lat, lng), order_line_items(*, menu_dishes(name, ocupa_bandeja, menu_sections(name)))')
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
            mesero: o.creador?.nombre || '',
            domiciliario: o.domiciliario?.nombre || '',
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
            // Datos para despacho de domicilios
            destino: o.delivery_destination || o.cliente?.name || 'Sin destino',
            deliveryPersonId: o.delivery_person_id,
            ordenRuta: o.orden_ruta,
            pos: o.cliente && o.cliente.lat != null ? { lat: o.cliente.lat, lng: o.cliente.lng } : null,
            creadoMs: Date.parse(o.created_at),
            listoMs: o.listo_at ? Date.parse(o.listo_at) : null,
            enCaminoMs: o.en_camino_at ? Date.parse(o.en_camino_at) : null,
            entregadoMs: o.entregado_at ? Date.parse(o.entregado_at) : null,
            unidades: o.order_line_items.reduce((n, li) =>
                n + (li.menu_dishes && li.menu_dishes.ocupa_bandeja === false ? 0 : li.quantity), 0),
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

        const meseroHTML = [
            pedido.mesero ? `Registró: ${esc(pedido.mesero)}` : '',
            pedido.domiciliario ? `Domiciliario: ${esc(pedido.domiciliario)}` : '',
        ].filter(Boolean).map(t => `<div class="pedido-mesero">${t}</div>`).join('');

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
        const activos = cocina._pedidos.filter(p => ['Pendiente', 'En preparación'].includes(p.estado)).reverse();
        const listos = cocina._pedidos.filter(p => !['Pendiente', 'En preparación'].includes(p.estado));

        if (activos.length === 0) {
            container.innerHTML = '<div class="historial-empty">No hay pedidos pendientes.</div>';
        }

        activos.forEach(p => {
            const siguiente = ESTADOS_COCINA[ESTADOS_COCINA.indexOf(p.estado) + 1];
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

const domicilios = {
    _timer: null,
    _estado: null,
    _pedidos: [],

    abrir() {
        if (!puede('domicilios')) return;
        state.currentView = 'domicilios';
        app._mostrarVista('domicilios-view');
        document.getElementById('btn-historial').style.display = 'none';
        document.getElementById('btn-toggle').style.display = 'none';
        document.getElementById('header-title').innerText = 'Mis domicilios';

        domicilios.detener();
        domicilios.cargar();
        domicilios._timer = setInterval(() => domicilios.cargar(true), CONFIG.COCINA_REFRESH_MS);
    },

    detener() {
        if (domicilios._timer) clearInterval(domicilios._timer);
        domicilios._timer = null;
    },

    async cargar(silencioso = false) {
        const container = document.getElementById('domicilios-container');
        if (!silencioso) container.innerHTML = '<div class="historial-empty">Cargando...</div>';
        try {
            // RLS solo devuelve los domicilios asignados a este usuario
            const [pedidos, { data: estado, error }] = await Promise.all([
                pedidosDelDia.obtener(),
                supabaseClient.from('domiciliarios_estado').select('disponible, bandeja')
                    .eq('profile_id', state.perfil.id).maybeSingle(),
            ]);
            if (error) throw error;
            domicilios._pedidos = pedidos;
            domicilios._estado = estado || { disponible: false, bandeja: null };
            domicilios.renderizar();
        } catch (e) {
            if (!silencioso) container.innerHTML = '<div class="historial-empty">Sin conexión a Supabase.</div>';
            console.error(e);
        }
    },

    renderizar() {
        const container = document.getElementById('domicilios-container');
        container.innerHTML = '';

        const tarjetaEstado = document.createElement('div');
        tarjetaEstado.className = 'dom-estado-card';
        tarjetaEstado.innerHTML = `
            <div class="dom-estado-titulo">Mi estado</div>
            ${disponibilidad.selector(domicilios._estado, 'dom-mi-estado')}`;
        container.appendChild(tarjetaEstado);
        tarjetaEstado.querySelector('select').addEventListener('change', async (e) => {
            await disponibilidad.guardar(state.perfil.id, e.target.value);
            domicilios.cargar(true);
        });

        const pendientes = domicilios._pedidos
            .filter(p => p.estado !== 'Entregado')
            .sort((a, b) => (a.ordenRuta ?? 99) - (b.ordenRuta ?? 99) || a.creadoMs - b.creadoMs);
        const entregados = domicilios._pedidos.filter(p => p.estado === 'Entregado');

        const listos = pendientes.filter(p => p.estado === 'Listo');
        if (listos.length > 0) {
            const btn = document.createElement('button');
            btn.className = 'btn-action';
            btn.innerText = `SALIR A RUTA (${listos.length} pedido${listos.length > 1 ? 's' : ''})`;
            btn.addEventListener('click', () => domicilios.cambiarEstado(listos.map(p => p.uuid), 'En camino', btn));
            container.appendChild(btn);
        }

        if (pendientes.length === 0) {
            container.insertAdjacentHTML('beforeend', '<div class="historial-empty">No tienes domicilios pendientes.</div>');
        }

        pendientes.forEach(p => {
            let acciones = '';
            if (p.estado === 'En camino') {
                acciones = `<button class="btn-estado" data-id="${esc(p.uuid)}">Marcar entregado</button>`;
            } else if (p.estado !== 'Listo') {
                acciones = '<div class="dom-espera">Esperando que cocina lo marque listo</div>';
            }
            const card = pedidosDelDia.crearTarjeta(p, { precios: true, acciones });
            if (p.ordenRuta) card.insertAdjacentHTML('afterbegin', `<div class="ruta-numero">${esc(p.ordenRuta)}</div>`);
            card.classList.add('dom-card');
            container.appendChild(card);
        });

        container.querySelectorAll('.btn-estado[data-id]').forEach(btn => {
            btn.addEventListener('click', () => domicilios.cambiarEstado([btn.dataset.id], 'Entregado', btn));
        });

        if (entregados.length > 0) {
            const titulo = document.createElement('div');
            titulo.className = 'section-label';
            titulo.innerText = `Entregados hoy (${entregados.length})`;
            container.appendChild(titulo);
            entregados.forEach(p => {
                const card = pedidosDelDia.crearTarjeta(p, { precios: true });
                card.classList.add('pedido-listo');
                container.appendChild(card);
            });
        }
    },

    async cambiarEstado(ids, estado, btn) {
        btn.disabled = true;
        const { error } = await supabaseClient
            .from('customer_orders')
            .update({ order_status: estado })
            .in('id', ids);
        if (error) {
            btn.disabled = false;
            ui.alert('Error', 'No se pudo actualizar el pedido. Verifica tu conexión.');
            console.error(error);
            return;
        }
        domicilios.cargar(true);
    },
};

// Selector compartido: el domiciliario (o el admin por el) marca disponibilidad y bandeja
const disponibilidad = {
    selector(estado, id) {
        const valor = estado?.disponible ? estado.bandeja : 'no';
        const opt = (v, txt) => `<option value="${v}" ${valor === v ? 'selected' : ''}>${txt}</option>`;
        return `<select class="domicilio-input dom-selector" id="${id}">
            ${opt('no', 'No disponible')}
            ${opt('grande', `Disponible · bandeja grande (${DESPACHO_CFG.CAPACIDAD.grande})`)}
            ${opt('mediana', `Disponible · bandeja mediana (${DESPACHO_CFG.CAPACIDAD.mediana})`)}
        </select>`;
    },

    async guardar(profileId, valor) {
        const fila = {
            profile_id: profileId,
            disponible: valor !== 'no',
            bandeja: valor === 'no' ? null : valor,
            actualizado_at: new Date().toISOString(),
        };
        const { error } = await supabaseClient.from('domiciliarios_estado').upsert(fila, { onConflict: 'profile_id' });
        if (error) {
            ui.alert('Error', 'No se pudo actualizar la disponibilidad.');
            console.error(error);
            return false;
        }
        ui.mostrarToast(fila.disponible ? 'Disponible' : 'No disponible');
        return true;
    },
};

const COLORES_RUTA = ['#005b96', '#c0392b', '#1a7a47', '#8e44ad', '#d35400', '#16a085'];

const despacho = {
    _timer: null,
    _mapa: null,
    _capa: null,
    _datos: null,
    _plan: null,
    _ocupado: false,

    abrir() {
        if (!puede('despacho')) return;
        state.currentView = 'despacho';
        app._mostrarVista('despacho-view');
        document.getElementById('btn-historial').style.display = 'none';
        document.getElementById('btn-toggle').style.display = 'none';
        document.getElementById('header-title').innerText = 'Despacho de domicilios';

        despacho._initMapa();
        despacho.detener();
        despacho.cargar();
        despacho._timer = setInterval(() => { if (!despacho._ocupado) despacho.cargar(true); }, CONFIG.DESPACHO_REFRESH_MS);
    },

    detener() {
        if (despacho._timer) clearInterval(despacho._timer);
        despacho._timer = null;
    },

    _initMapa() {
        if (despacho._mapa) {
            setTimeout(() => despacho._mapa.invalidateSize(), 0);
            return;
        }
        if (!window.L) return;
        const mapa = L.map('despacho-mapa').setView([CONFIG.LOCAL.lat, CONFIG.LOCAL.lng], 16);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapa);
        L.marker([CONFIG.LOCAL.lat, CONFIG.LOCAL.lng], {
            icon: L.divIcon({ className: 'mapa-local', html: 'M', iconSize: [30, 30] }),
            interactive: false,
        }).addTo(mapa);
        despacho._capa = L.layerGroup().addTo(mapa);
        despacho._mapa = mapa;
        setTimeout(() => mapa.invalidateSize(), 0);
    },

    async cargar(silencioso = false) {
        const panel = document.getElementById('despacho-panel');
        if (!silencioso) panel.innerHTML = '<div class="historial-empty">Cargando...</div>';
        try {
            const [pedidos, { data: doms, error }] = await Promise.all([
                pedidosDelDia.obtener(),
                supabaseClient.from('profiles')
                    .select('id, nombre, domiciliarios_estado(disponible, bandeja, actualizado_at)')
                    .eq('rol', 'domiciliario').eq('activo', true).order('nombre'),
            ]);
            if (error) throw error;
            despacho._datos = { pedidos, doms };
            despacho._calcular();
            despacho._render();
        } catch (e) {
            if (!silencioso) panel.innerHTML = '<div class="historial-empty">Sin conexión a Supabase.</div>';
            console.error(e);
        }
    },

    // Mediana del tiempo de cocina de hoy (pedido -> listo); si hay pocos datos, el valor por defecto
    _estimarPrepMin(pedidos) {
        const t = pedidos.filter(p => p.listoMs).map(p => (p.listoMs - p.creadoMs) / 60000)
            .filter(x => x > 0 && x < 120).sort((a, b) => a - b);
        return t.length >= 3 ? Math.round(t[Math.floor(t.length / 2)]) : DESPACHO_CFG.PREP_MIN_DEFECTO;
    },

    _calcular() {
        const ahora = Date.now();
        const cfg = DESPACHO_CFG;
        const local = CONFIG.LOCAL;
        const { pedidos, doms } = despacho._datos;
        const prepMin = despacho._estimarPrepMin(pedidos);

        const listoEstimado = (p) => {
            if (['Listo', 'En camino', 'Entregado'].includes(p.estado)) return p.listoMs || ahora;
            return Math.max(p.creadoMs + prepMin * 60000, ahora + 60000);
        };
        const aParada = (p) => ({
            id: p.uuid, nombre: p.destino, creadoMs: p.creadoMs,
            listoMs: listoEstimado(p), unidades: p.unidades, pos: p.pos,
        });

        const domiciliosHoy = pedidos.filter(p => p.tipo === 'Domicilio');
        const activos = domiciliosHoy.filter(p => p.estado !== 'Entregado');
        const cola = activos.filter(p => !p.deliveryPersonId);

        const repartidores = doms.map((d, i) => {
            const est = (Array.isArray(d.domiciliarios_estado) ? d.domiciliarios_estado[0] : d.domiciliarios_estado)
                || { disponible: false, bandeja: null };
            const asignados = activos.filter(p => p.deliveryPersonId === d.id)
                .sort((a, b) => (a.ordenRuta ?? 99) - (b.ordenRuta ?? 99));
            let libreMs = ahora;
            let situacion = 'En el local';

            const enCamino = asignados.filter(p => p.estado === 'En camino');
            if (enCamino.length) {
                const salio = Math.min(...enCamino.map(p => p.enCaminoMs || ahora));
                const ultimo = domiciliosHoy
                    .filter(p => p.deliveryPersonId === d.id && p.entregadoMs && p.entregadoMs >= salio)
                    .sort((a, b) => b.entregadoMs - a.entregadoMs)[0];
                const inicio = ultimo
                    ? { pos: ultimo.pos || local, ms: ultimo.entregadoMs }
                    : { pos: local, ms: salio };
                libreMs = despachoAlgoritmo.simular(local, enCamino.map(aParada), inicio.ms, cfg, inicio).regresoMs;
                situacion = `En ruta · ${enCamino.length} por entregar`;
            } else if (asignados.length) {
                const salida = Math.max(ahora, ...asignados.map(listoEstimado));
                libreMs = despachoAlgoritmo.simular(local, asignados.map(aParada), salida, cfg).regresoMs;
                situacion = `Asignado · ${asignados.length} por salir`;
            } else {
                const ultimo = domiciliosHoy.filter(p => p.deliveryPersonId === d.id && p.entregadoMs)
                    .sort((a, b) => b.entregadoMs - a.entregadoMs)[0];
                if (ultimo) {
                    const vuelta = ultimo.entregadoMs + despachoAlgoritmo.minutos(ultimo.pos, local, cfg) * 60000;
                    if (vuelta > ahora) { libreMs = vuelta; situacion = 'Regresando al local'; }
                }
            }

            return {
                id: d.id, nombre: d.nombre, color: COLORES_RUTA[i % COLORES_RUTA.length],
                estado: est, disponible: !!est.disponible,
                capacidad: cfg.CAPACIDAD[est.bandeja] || 0,
                libreMs: Math.max(libreMs, ahora), situacion, asignados,
            };
        });

        const disponibles = repartidores.filter(r => r.disponible && r.capacidad > 0);
        const plan = despachoAlgoritmo.planificar({
            pedidos: cola.map(aParada),
            domiciliarios: disponibles.map(r => ({ id: r.id, nombre: r.nombre, capacidad: r.capacidad, libreMs: r.libreMs })),
            ahora, local, cfg,
        });

        despacho._plan = {
            ahora, prepMin, repartidores, cola, plan,
            porId: new Map(pedidos.map(p => [p.uuid, p])),
            colorDe: new Map(repartidores.map(r => [r.id, r.color])),
        };
    },

    _render() {
        const { ahora, prepMin, repartidores, cola, plan, porId, colorDe } = despacho._plan;
        const hora = (ms) => new Date(ms).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        const minDesde = (ms, desde) => Math.round((ms - desde) / 60000);

        const disponibles = repartidores.filter(r => r.disponible);
        const sinUbicacion = cola.filter(p => !p.pos).length;
        document.getElementById('despacho-resumen').innerHTML = `
            <span><strong>${cola.length}</strong> sin asignar</span>
            <span><strong>${disponibles.length}</strong> de ${repartidores.length} domiciliarios disponibles</span>
            <span>Cocina ~<strong>${prepMin}</strong> min</span>
            ${sinUbicacion ? `<span class="resumen-alerta">${sinUbicacion} sin ubicación</span>` : ''}`;

        let html = '';

        // --- Sugerencias
        html += '<div class="section-label">Sugerencias</div>';
        if (plan.viajes.length === 0 && plan.sinAsignar.length === 0) {
            html += '<div class="historial-empty">No hay domicilios por asignar.</div>';
        }
        plan.viajes.forEach((v, i) => {
            const color = colorDe.get(v.domiciliario.id);
            const sale = v.salidaMs <= ahora + 60000 ? 'Salir ahora' : `Salir ~${hora(v.salidaMs)}`;
            const paradas = v.paradas.map((p, j) => {
                const ped = porId.get(p.id);
                const espera = minDesde(v.llegadas[p.id], p.creadoMs);
                return `<li>
                    <span class="parada-num" style="background:${color}">${j + 1}</span>
                    <span class="parada-nombre">${esc(p.nombre)}${p.pos ? '' : ' <em class="tag-alerta">sin ubicación</em>'}</span>
                    <span class="parada-info">${p.unidades} prod · ${esc(ped?.estado || '')} · llega ${hora(v.llegadas[p.id])}
                        <strong class="${espera > DESPACHO_CFG.META_MIN ? 'tarde' : ''}">(${espera} min)</strong></span>
                </li>`;
            }).join('');
            html += `<div class="viaje-card" style="border-left-color:${color}">
                <div class="viaje-header">
                    <span class="viaje-dom">${esc(v.domiciliario.nombre)}</span>
                    <span class="viaje-carga">${v.carga}/${v.domiciliario.capacidad} productos</span>
                </div>
                <div class="viaje-sub">${sale} · regresa ~${hora(v.regresoMs)}</div>
                <ol class="viaje-paradas">${paradas}</ol>
                ${v.avisos.map(a => `<div class="viaje-aviso">${esc(a)}</div>`).join('')}
                ${v.asignableAhora
                    ? `<button class="btn-estado" data-asignar="${i}">Asignar a ${esc(v.domiciliario.nombre)}</button>`
                    : '<div class="viaje-proximo">Próximo viaje (se podrá asignar cuando esté por salir)</div>'}
            </div>`;
        });
        plan.sinAsignar.forEach(({ pedido, motivo }) => {
            html += `<div class="viaje-card viaje-sin">
                <strong>${esc(pedido.nombre)}</strong> · espera ${minDesde(ahora, pedido.creadoMs)} min
                <div class="viaje-aviso">${esc(motivo)}</div></div>`;
        });

        // --- Domiciliarios
        html += '<div class="section-label">Domiciliarios</div>';
        if (repartidores.length === 0) {
            html += '<div class="historial-empty">No hay usuarios con rol domiciliario.</div>';
        }
        repartidores.forEach(r => {
            const asignados = r.asignados.map(p => `
                <li>${esc(p.ordenRuta ?? '-')}. ${esc(p.destino)} <span class="pedido-estado pedido-estado-${p.estado === 'En camino' ? 'en-camino' : 'listo'}">${esc(p.estado)}</span>
                ${p.estado !== 'En camino' ? `<button class="btn-link" data-quitar="${esc(p.uuid)}">quitar</button>` : ''}</li>`).join('');
            html += `<div class="dom-fila">
                <div class="dom-fila-top">
                    <span class="dom-color" style="background:${r.color}"></span>
                    <span class="dom-nombre">${esc(r.nombre)}</span>
                    <span class="dom-situacion">${esc(r.situacion)}${r.libreMs > ahora + 60000 ? ` · libre ~${hora(r.libreMs)}` : ''}</span>
                </div>
                ${disponibilidad.selector(r.estado, 'disp-' + r.id).replace('<select', `<select data-dom="${esc(r.id)}"`)}
                ${asignados ? `<ul class="dom-asignados">${asignados}</ul>` : ''}
            </div>`;
        });

        const panel = document.getElementById('despacho-panel');
        panel.innerHTML = html;

        panel.querySelectorAll('[data-asignar]').forEach(b =>
            b.addEventListener('click', () => despacho.asignar(plan.viajes[Number(b.dataset.asignar)], b)));
        panel.querySelectorAll('[data-quitar]').forEach(b =>
            b.addEventListener('click', () => despacho.quitar(b.dataset.quitar, b)));
        panel.querySelectorAll('select[data-dom]').forEach(s =>
            s.addEventListener('change', async () => {
                despacho._ocupado = true;
                await disponibilidad.guardar(s.dataset.dom, s.value);
                despacho._ocupado = false;
                despacho.cargar(true);
            }));

        despacho._renderMapa();
    },

    _renderMapa() {
        if (!despacho._capa) return;
        const { plan, repartidores, colorDe } = despacho._plan;
        const local = [CONFIG.LOCAL.lat, CONFIG.LOCAL.lng];
        despacho._capa.clearLayers();

        const numero = (n, color) => L.divIcon({
            className: 'mapa-parada', html: `<span style="background:${color}">${n}</span>`, iconSize: [24, 24],
        });

        plan.viajes.forEach(v => {
            const color = colorDe.get(v.domiciliario.id);
            const puntos = [local, ...v.paradas.filter(p => p.pos).map(p => [p.pos.lat, p.pos.lng]), local];
            L.polyline(puntos, { color, weight: 4, opacity: v.asignableAhora ? 0.9 : 0.4, dashArray: v.asignableAhora ? null : '6 8' })
                .addTo(despacho._capa);
            v.paradas.forEach((p, j) => {
                if (!p.pos) return;
                L.marker([p.pos.lat, p.pos.lng], { icon: numero(j + 1, color) })
                    .bindTooltip(`${p.nombre} (${v.domiciliario.nombre})`).addTo(despacho._capa);
            });
        });

        // Pedidos ya asignados (en ruta o por salir)
        repartidores.forEach(r => r.asignados.forEach(p => {
            if (!p.pos) return;
            L.circleMarker([p.pos.lat, p.pos.lng], { radius: 7, color: '#fff', weight: 2, fillColor: r.color, fillOpacity: 1 })
                .bindTooltip(`${p.destino} · ${r.nombre} · ${p.estado}`).addTo(despacho._capa);
        }));
    },

    async asignar(viaje, btn) {
        btn.disabled = true;
        despacho._ocupado = true;
        try {
            const resultados = await Promise.all(viaje.paradas.map((p, j) =>
                supabaseClient.from('customer_orders')
                    .update({ delivery_person_id: viaje.domiciliario.id, orden_ruta: j + 1 })
                    .eq('id', p.id)));
            const fallo = resultados.find(r => r.error);
            if (fallo) throw fallo.error;
            ui.mostrarToast(`Asignado a ${viaje.domiciliario.nombre}`);
        } catch (e) {
            ui.alert('Error', 'No se pudo asignar el viaje completo. Revisa la lista de domiciliarios.');
            console.error(e);
        } finally {
            despacho._ocupado = false;
            despacho.cargar(true);
        }
    },

    async quitar(id, btn) {
        btn.disabled = true;
        const { error } = await supabaseClient.from('customer_orders').update({ delivery_person_id: null }).eq('id', id);
        if (error) {
            ui.alert('Error', 'No se pudo quitar la asignación.');
            console.error(error);
        }
        despacho.cargar(true);
    },
};

const clientesMapa = {
    _mapa: null,
    _capaClientes: null,
    _marcadorEdicion: null,
    _clientes: [],
    _seleccionado: null,
    _pendiente: null,

    async abrir() {
        if (!puede('configurar')) return;
        state.currentView = 'clientes';
        app._mostrarVista('clientes-view');
        document.getElementById('btn-historial').style.display = 'none';
        document.getElementById('btn-toggle').style.display = 'none';
        document.getElementById('header-title').innerText = 'Ubicación de clientes';
        document.getElementById('clientes-buscar').value = '';

        clientesMapa._initMapa();
        await clientesMapa.cargar();
    },

    _initMapa() {
        if (clientesMapa._mapa) {
            setTimeout(() => clientesMapa._mapa.invalidateSize(), 0);
            return;
        }
        if (!window.L) {
            document.getElementById('clientes-mapa').innerHTML =
                '<div class="historial-empty">No se pudo cargar el mapa. Verifica tu conexión.</div>';
            return;
        }
        const mapa = L.map('clientes-mapa').setView([CONFIG.LOCAL.lat, CONFIG.LOCAL.lng], 17);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap',
        }).addTo(mapa);

        L.marker([CONFIG.LOCAL.lat, CONFIG.LOCAL.lng], {
            icon: L.divIcon({ className: 'mapa-local', html: 'M', iconSize: [30, 30] }),
            interactive: false,
        }).addTo(mapa);

        clientesMapa._capaClientes = L.layerGroup().addTo(mapa);
        mapa.on('click', (e) => clientesMapa._ubicar(e.latlng));
        clientesMapa._mapa = mapa;
        setTimeout(() => mapa.invalidateSize(), 0);
    },

    async cargar() {
        const { data, error } = await supabaseClient
            .from('clients')
            .select('id, name, direccion, lat, lng, ubicacion_fuente, ubicacion_nota, ubicacion_verificada')
            .order('name');
        if (error) {
            ui.alert('Error', 'No se pudieron cargar los clientes.');
            console.error(error);
            return;
        }
        clientesMapa._clientes = data;
        clientesMapa.renderLista();
        clientesMapa._renderMarcadores();
    },

    _estado(c) {
        if (c.lat != null && c.ubicacion_verificada) return 'verificado';
        if (c.lat != null) return 'sin-verificar';
        return 'sin-ubicacion';
    },

    renderLista() {
        const texto = document.getElementById('clientes-buscar').value.trim().toLowerCase();
        const filtro = document.getElementById('clientes-filtro').value;
        const lista = document.getElementById('clientes-lista');

        const total = clientesMapa._clientes.length;
        const verificados = clientesMapa._clientes.filter(c => clientesMapa._estado(c) === 'verificado').length;
        document.getElementById('clientes-progreso').innerText = `${verificados} de ${total} clientes verificados`;

        const visibles = clientesMapa._clientes.filter(c => {
            if (texto && !c.name.toLowerCase().includes(texto)) return false;
            if (filtro === 'pendientes') return clientesMapa._estado(c) !== 'verificado';
            if (filtro === 'verificados') return clientesMapa._estado(c) === 'verificado';
            return true;
        });

        lista.innerHTML = visibles.length === 0
            ? '<div class="historial-empty">No hay clientes con ese filtro.</div>'
            : visibles.map(c => `
                <div class="cliente-item ${c.id === clientesMapa._seleccionado?.id ? 'activo' : ''}" data-id="${esc(c.id)}">
                    <span class="cliente-punto cliente-${clientesMapa._estado(c)}"></span>
                    <span class="cliente-nombre">${esc(c.name)}</span>
                    ${c.direccion ? `<span class="cliente-dir">${esc(c.direccion)}</span>` : ''}
                </div>`).join('');

        lista.querySelectorAll('.cliente-item').forEach(el => {
            el.addEventListener('click', () => clientesMapa.seleccionar(el.dataset.id));
        });
    },

    _renderMarcadores() {
        if (!clientesMapa._capaClientes) return;
        clientesMapa._capaClientes.clearLayers();
        clientesMapa._clientes.filter(c => c.lat != null).forEach(c => {
            if (c.id === clientesMapa._seleccionado?.id) return;
            L.circleMarker([c.lat, c.lng], {
                radius: 6,
                weight: 1,
                color: '#ffffff',
                fillOpacity: 0.9,
                fillColor: c.ubicacion_verificada ? '#1a7a47' : '#e67e22',
            })
                .bindTooltip(c.name)
                .on('click', (e) => { L.DomEvent.stopPropagation(e); clientesMapa.seleccionar(c.id); })
                .addTo(clientesMapa._capaClientes);
        });
    },

    seleccionar(id) {
        const c = clientesMapa._clientes.find(x => x.id === id);
        if (!c) return;
        clientesMapa._seleccionado = c;
        clientesMapa._pendiente = c.lat != null ? { lat: c.lat, lng: c.lng } : null;

        if (clientesMapa._marcadorEdicion) {
            clientesMapa._marcadorEdicion.remove();
            clientesMapa._marcadorEdicion = null;
        }
        if (clientesMapa._pendiente && clientesMapa._mapa) {
            clientesMapa._ponerMarcador(clientesMapa._pendiente);
            clientesMapa._mapa.setView([c.lat, c.lng], Math.max(clientesMapa._mapa.getZoom(), 17));
        }

        clientesMapa._renderPanel();
        clientesMapa._renderMarcadores();
        clientesMapa.renderLista();
    },

    _ponerMarcador(pos) {
        if (!clientesMapa._marcadorEdicion) {
            clientesMapa._marcadorEdicion = L.marker([pos.lat, pos.lng], { draggable: true }).addTo(clientesMapa._mapa);
            clientesMapa._marcadorEdicion.on('dragend', (e) => {
                const ll = e.target.getLatLng();
                clientesMapa._pendiente = { lat: ll.lat, lng: ll.lng };
                clientesMapa._renderPanel();
            });
        } else {
            clientesMapa._marcadorEdicion.setLatLng([pos.lat, pos.lng]);
        }
    },

    _ubicar(latlng) {
        if (!clientesMapa._seleccionado) {
            ui.mostrarToast('Primero elige un cliente de la lista');
            return;
        }
        clientesMapa._pendiente = { lat: latlng.lat, lng: latlng.lng };
        clientesMapa._ponerMarcador(clientesMapa._pendiente);
        clientesMapa._renderPanel();
    },

    _renderPanel() {
        const panel = document.getElementById('clientes-seleccion');
        const c = clientesMapa._seleccionado;
        if (!c) {
            panel.innerHTML = 'Elige un cliente de la lista y toca su ubicación en el mapa.';
            return;
        }
        const p = clientesMapa._pendiente;
        const distancia = p ? `A ${Math.round(distanciaMetros(CONFIG.LOCAL, p))} m del local (línea recta)` : 'Toca el mapa donde queda este cliente.';
        const estado = c.ubicacion_verificada ? 'Verificada' : (c.lat != null ? `Sin verificar (${esc(c.ubicacion_fuente || '')})` : 'Sin ubicación');

        // Conservar lo que el usuario ya escribio al re-renderizar
        const dirActual = document.getElementById('cs-direccion')?.dataset.id === c.id
            ? document.getElementById('cs-direccion').value
            : (c.direccion || '');

        panel.innerHTML = `
            <div class="cs-nombre">${esc(c.name)}</div>
            <div class="cs-info">${esc(distancia)} · ${estado}</div>
            ${c.ubicacion_nota ? `<div class="cs-nota">${esc(c.ubicacion_nota)}</div>` : ''}
            <input type="text" id="cs-direccion" class="domicilio-input" data-id="${esc(c.id)}"
                placeholder="Dirección (opcional, ej: Cra 58 # 45-20)" value="${esc(dirActual)}">
            <div class="cs-botones">
                <button class="btn-estado" id="cs-guardar" ${p ? '' : 'disabled'}>Guardar y siguiente</button>
                ${c.lat != null ? '<button class="btn-cancel" id="cs-quitar">Quitar ubicación</button>' : ''}
            </div>`;

        document.getElementById('cs-guardar').addEventListener('click', () => clientesMapa.guardar());
        document.getElementById('cs-quitar')?.addEventListener('click', () => clientesMapa.quitar());
    },

    async guardar() {
        const c = clientesMapa._seleccionado;
        const p = clientesMapa._pendiente;
        if (!c || !p) return;
        const direccion = document.getElementById('cs-direccion').value.trim() || null;

        const cambios = {
            lat: p.lat,
            lng: p.lng,
            direccion,
            ubicacion_fuente: 'manual',
            ubicacion_verificada: true,
            updated_at: new Date().toISOString(),
        };
        const { error } = await supabaseClient.from('clients').update(cambios).eq('id', c.id);
        if (error) {
            ui.alert('Error', 'No se pudo guardar la ubicación.');
            console.error(error);
            return;
        }
        Object.assign(c, cambios);
        ui.mostrarToast('Ubicación guardada');

        // Siguiente cliente sin verificar (en orden alfabetico)
        const idx = clientesMapa._clientes.indexOf(c);
        const siguiente = [...clientesMapa._clientes.slice(idx + 1), ...clientesMapa._clientes.slice(0, idx)]
            .find(x => clientesMapa._estado(x) !== 'verificado');
        if (siguiente) {
            clientesMapa.seleccionar(siguiente.id);
        } else {
            clientesMapa._seleccionado = null;
            clientesMapa._pendiente = null;
            clientesMapa._marcadorEdicion?.remove();
            clientesMapa._marcadorEdicion = null;
            clientesMapa._renderPanel();
            clientesMapa._renderMarcadores();
            clientesMapa.renderLista();
        }
    },

    async quitar() {
        const c = clientesMapa._seleccionado;
        if (!c) return;
        const ok = await ui.confirmar('Quitar ubicación', `¿Quitar la ubicación de "${c.name}"?`);
        if (!ok) return;
        const cambios = { lat: null, lng: null, ubicacion_verificada: false, ubicacion_fuente: null, updated_at: new Date().toISOString() };
        const { error } = await supabaseClient.from('clients').update(cambios).eq('id', c.id);
        if (error) {
            ui.alert('Error', 'No se pudo quitar la ubicación.');
            console.error(error);
            return;
        }
        Object.assign(c, cambios);
        clientesMapa.seleccionar(c.id);
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
