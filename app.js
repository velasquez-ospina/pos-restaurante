
const CONFIG = {
    TOAST_DURATION_MS: 2000,
    SYNC_INTERVAL_MS: 10_000,
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

                        let combos = [ { mods: [], price: 0, str: [] } ];
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

    async guardarMenuDia(platosSeleccionados, bebidasSeleccionadas) {
        return { status: 'success' };
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
                const p = pedido.payload;
                
                const { data: orderData, error: orderErr } = await supabaseClient.from('customer_orders').insert({
                    order_type: p.tipo,
                    customer_name: p.domicilio_quien || null,
                    delivery_destination: p.domicilio_para || null,
                    total_amount: p.total
                }).select().single();
                
                if (orderErr) throw orderErr;

                if (p.carrito && p.carrito.length > 0) {
                    const lineItems = p.carrito.map(c => ({
                        customer_order_id: orderData.id,
                        menu_dish_id: c.dish_id,
                        quantity: c.qty,
                        unit_price: c.precio,
                        modifications_selected: c.mods && c.mods.length > 0 ? c.mods.join(', ') : null
                    }));

                    const { error: lineErr } = await supabaseClient.from('order_line_items').insert(lineItems);
                    if (lineErr) throw lineErr;
                }

                state.colaPedidos = state.colaPedidos.filter(q => q.idLocal !== pedido.idLocal);
                localStorage.setItem(CONFIG.LOCAL_STORAGE_KEYS.COLA, JSON.stringify(state.colaPedidos));
                console.log('Pedido insertado en Supabase:', orderData.id);
                cola.retryDelay = 2000;
            } catch (e) {
                console.warn('Fallo Supabase. Reintentando luego.', e);
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
                            <span class="acc-v-price">$${(item.precio||0).toLocaleString('es-CO')}</span>
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
            const { data, error } = await supabaseClient
                .from('customer_orders')
                .select('*, order_line_items(*, menu_dishes(name))')
                .order('created_at', { ascending: false })
                .limit(20);

            if (error) throw error;

            state.historialPedidos = data.map(o => ({
                idPedido: o.id.split('-')[0].toUpperCase(),
                fecha: o.created_at,
                tipo: o.order_type,
                domicilioPara: o.delivery_destination || '',
                domicilioQuien: o.customer_name || '',
                items: o.order_line_items.map(li => ({
                    nombre: li.menu_dishes ? li.menu_dishes.name : 'Item',
                    qty: li.quantity,
                    precio: li.unit_price,
                    categoria: 'Plato',
                    modificaciones: li.modifications_selected
                })),
                total: o.total_amount
            }));

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
                const modStr = it.modificaciones ? `<div style="font-size:0.8rem;color:#6b8fa3;margin-left:25px;">${it.modificaciones}</div>` : '';
                return `<div class="historial-item-wrapper" style="display:flex; flex-direction:column; gap:2px; margin-bottom:4px;">
                    <div class="historial-item">
                        <span class="historial-item-qty">${it.qty}×</span>
                        <span class="historial-item-nombre">${it.nombre}</span>
                        ${precioStr}
                    </div>
                    ${modStr}
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
