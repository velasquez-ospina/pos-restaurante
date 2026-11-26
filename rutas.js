// =====================================================================
// Rutas a pie por las calles (red peatonal de OpenStreetMap en calles.json)
// ---------------------------------------------------------------------
// - cargar():        descarga y prepara la red (una sola vez)
// - metros(a, b):    distancia caminando entre dos puntos {lat, lng}, o null
// - camino(a, b):    lista de [lat, lng] siguiendo las calles, o null
// Si la red no carga, metros() devuelve null y el algoritmo usa su estimado.
// Regenerar la red: python herramientas/generar_calles.py
// =====================================================================

const rutasCalles = {
    _promesa: null,
    listo: false,
    _lat: null,
    _lng: null,
    _inicio: null,   // CSR: vecinos de i en _destino[_inicio[i] .. _inicio[i+1])
    _destino: null,
    _peso: null,
    _celdas: null,   // indice espacial para encontrar el nodo mas cercano
    _cacheSnap: new Map(),
    _cacheDijkstra: new Map(),
    MAX_CACHE_DIJKSTRA: 80,
    TAM_CELDA: 0.002, // grados (~220 m)

    cargar() {
        if (!rutasCalles._promesa) {
            rutasCalles._promesa = fetch('calles.json')
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(datos => { rutasCalles._preparar(datos); rutasCalles.listo = true; })
                .catch(e => { console.warn('Red de calles no disponible; se usa distancia estimada.', e); });
        }
        return rutasCalles._promesa;
    },

    _preparar({ coords, aristas, snap }) {
        const n = coords.length / 2;
        const lat = new Float64Array(n), lng = new Float64Array(n);
        for (let i = 0; i < n; i++) { lat[i] = coords[2 * i]; lng[i] = coords[2 * i + 1]; }

        const grado = new Int32Array(n + 1);
        for (let k = 0; k < aristas.length; k += 2) { grado[aristas[k]]++; grado[aristas[k + 1]]++; }
        const inicio = new Int32Array(n + 1);
        for (let i = 0; i < n; i++) inicio[i + 1] = inicio[i] + grado[i];
        const destino = new Int32Array(inicio[n]), peso = new Float64Array(inicio[n]);
        const pos = inicio.slice(0, n);
        for (let k = 0; k < aristas.length; k += 2) {
            const a = aristas[k], b = aristas[k + 1];
            const w = distanciaMetros({ lat: lat[a], lng: lng[a] }, { lat: lat[b], lng: lng[b] });
            destino[pos[a]] = b; peso[pos[a]++] = w;
            destino[pos[b]] = a; peso[pos[b]++] = w;
        }

        const celdas = new Map();
        for (let i = 0; i < n; i++) {
            if (!snap[i]) continue;
            const clave = rutasCalles._clave(lat[i], lng[i]);
            if (!celdas.has(clave)) celdas.set(clave, []);
            celdas.get(clave).push(i);
        }

        Object.assign(rutasCalles, { _lat: lat, _lng: lng, _inicio: inicio, _destino: destino, _peso: peso, _celdas: celdas });
    },

    _clave(lat, lng) {
        return Math.floor(lat / rutasCalles.TAM_CELDA) + ':' + Math.floor(lng / rutasCalles.TAM_CELDA);
    },

    // Nodo de la red mas cercano a un punto (solo calles donde puede quedar un local)
    _pegar(p) {
        const k = p.lat.toFixed(6) + ',' + p.lng.toFixed(6);
        if (rutasCalles._cacheSnap.has(k)) return rutasCalles._cacheSnap.get(k);

        const T = rutasCalles.TAM_CELDA;
        const ci = Math.floor(p.lat / T), cj = Math.floor(p.lng / T);
        // Recorre anillos de celdas; al encontrar el primer nodo revisa un anillo mas
        // (el mas cercano puede estar justo al otro lado del borde de la celda).
        let mejor = -1, mejorD = Infinity, anilloEncontrado = -1;
        for (let r = 0; r <= 4; r++) {
            if (anilloEncontrado >= 0 && r > anilloEncontrado + 1) break;
            for (let di = -r; di <= r; di++) {
                for (let dj = -r; dj <= r; dj++) {
                    if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
                    for (const i of rutasCalles._celdas.get((ci + di) + ':' + (cj + dj)) || []) {
                        const d = distanciaMetros(p, { lat: rutasCalles._lat[i], lng: rutasCalles._lng[i] });
                        if (d < mejorD) { mejorD = d; mejor = i; }
                    }
                }
            }
            if (mejor >= 0 && anilloEncontrado < 0) anilloEncontrado = r;
        }
        const res = mejor >= 0 ? { nodo: mejor, metros: mejorD } : null;
        rutasCalles._cacheSnap.set(k, res);
        return res;
    },

    // Camino mas corto desde un nodo a todos los demas (Dijkstra con heap binario)
    _dijkstra(origen) {
        const cache = rutasCalles._cacheDijkstra;
        if (cache.has(origen)) {
            const r = cache.get(origen);
            cache.delete(origen); cache.set(origen, r); // LRU
            return r;
        }
        const n = rutasCalles._lat.length;
        const dist = new Float64Array(n).fill(Infinity);
        const prev = new Int32Array(n).fill(-1);
        const { _inicio: inicio, _destino: destino, _peso: peso } = rutasCalles;

        const heapN = [], heapD = [];
        const push = (v, d) => {
            let i = heapN.length; heapN.push(v); heapD.push(d);
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (heapD[p] <= d) break;
                heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p;
            }
            heapN[i] = v; heapD[i] = d;
        };
        const pop = () => {
            const v = heapN[0], d = heapD[0];
            const lv = heapN.pop(), ld = heapD.pop();
            if (heapN.length) {
                let i = 0;
                for (;;) {
                    let c = 2 * i + 1;
                    if (c >= heapN.length) break;
                    if (c + 1 < heapN.length && heapD[c + 1] < heapD[c]) c++;
                    if (heapD[c] >= ld) break;
                    heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c;
                }
                heapN[i] = lv; heapD[i] = ld;
            }
            return [v, d];
        };

        dist[origen] = 0;
        push(origen, 0);
        while (heapN.length) {
            const [u, du] = pop();
            if (du > dist[u]) continue;
            for (let k = inicio[u]; k < inicio[u + 1]; k++) {
                const v = destino[k], nd = du + peso[k];
                if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(v, nd); }
            }
        }

        const r = { dist, prev };
        cache.set(origen, r);
        if (cache.size > rutasCalles.MAX_CACHE_DIJKSTRA) cache.delete(cache.keys().next().value);
        return r;
    },

    metros(a, b) {
        if (!rutasCalles.listo || !a || !b || a.lat == null || b.lat == null) return null;
        const sa = rutasCalles._pegar(a), sb = rutasCalles._pegar(b);
        if (!sa || !sb) return null;
        const d = rutasCalles._dijkstra(sa.nodo).dist[sb.nodo];
        return Number.isFinite(d) ? d + sa.metros + sb.metros : null;
    },

    camino(a, b) {
        if (!rutasCalles.listo || !a || !b || a.lat == null || b.lat == null) return null;
        const sa = rutasCalles._pegar(a), sb = rutasCalles._pegar(b);
        if (!sa || !sb) return null;
        const { dist, prev } = rutasCalles._dijkstra(sa.nodo);
        if (!Number.isFinite(dist[sb.nodo])) return null;
        const puntos = [[b.lat, b.lng]];
        for (let v = sb.nodo; v !== -1; v = prev[v]) puntos.push([rutasCalles._lat[v], rutasCalles._lng[v]]);
        puntos.push([a.lat, a.lng]);
        return puntos.reverse();
    },
};
