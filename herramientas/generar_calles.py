"""
Genera calles.json: la red peatonal alrededor del restaurante (OpenStreetMap),
usada por rutas.js para calcular distancias reales caminando.

Uso (desde la raiz del repo):
    python herramientas/generar_calles.py

Solo hace falta volver a correrlo si cambian las calles o el radio de cobertura.
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

CENTRO = (6.2490, -75.5779)  # Cra. 60 #45A-21 (aprox.)
RADIO_M = 1500
SERVIDORES = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Vias que no se caminan (o no deben usarse para cruzar)
EXCLUIR = "motorway|motorway_link|trunk|trunk_link|busway|bus_guideway|construction|proposed|raceway|platform"
# Vias a las que NO se "pega" un cliente (un local no queda sobre una escalera o una ciclorruta)
NO_SNAP = {"steps", "cycleway", "corridor"}

QUERY = f"""
[out:json][timeout:120];
way(around:{RADIO_M},{CENTRO[0]},{CENTRO[1]})
  ["highway"]["highway"!~"{EXCLUIR}"]
  ["foot"!~"no"]["access"!~"private|no"]["area"!="yes"];
(._;>;);
out body qt;
"""


def distancia(a, b):
    r = math.pi / 180
    dlat, dlng = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlng / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def main():
    salida = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "calles.json")

    datos = None
    for intento in range(3):
        for servidor in SERVIDORES:
            print(f"Descargando red peatonal de OpenStreetMap ({servidor}, intento {intento + 1})...")
            req = urllib.request.Request(
                servidor,
                data=urllib.parse.urlencode({"data": QUERY}).encode(),
                headers={"User-Agent": "pos-restaurante-calles/1.0"},
            )
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    datos = json.load(r)
                break
            except Exception as e:  # servidor ocupado: probar el siguiente
                print(f"  fallo: {e}")
        if datos:
            break
        time.sleep(10)
    if not datos:
        print("No se pudo descargar la red. Intenta de nuevo en unos minutos.")
        return 1

    nodos = {e["id"]: (e["lat"], e["lon"]) for e in datos["elements"] if e["type"] == "node"}
    vias = [e for e in datos["elements"] if e["type"] == "way"]

    adj, snap_ok = {}, set()
    for via in vias:
        tipo = via.get("tags", {}).get("highway")
        ns = [n for n in via["nodes"] if n in nodos]
        if tipo not in NO_SNAP:
            snap_ok.update(ns)
        for a, b in zip(ns, ns[1:]):
            if a != b:
                adj.setdefault(a, set()).add(b)
                adj.setdefault(b, set()).add(a)

    # Quedarse con la componente conectada mas grande (descarta pedazos aislados)
    vistos, mayor = set(), set()
    for s in adj:
        if s in vistos:
            continue
        comp, pila = {s}, [s]
        vistos.add(s)
        while pila:
            u = pila.pop()
            for v in adj[u]:
                if v not in vistos:
                    vistos.add(v)
                    comp.add(v)
                    pila.append(v)
        if len(comp) > len(mayor):
            mayor = comp

    ids = sorted(mayor)
    indice = {n: i for i, n in enumerate(ids)}
    coords, aristas, snap = [], [], []
    for n in ids:
        lat, lng = nodos[n]
        coords += [round(lat, 6), round(lng, 6)]
        snap.append(1 if n in snap_ok else 0)
    for a in ids:
        for b in adj[a]:
            if b in indice and indice[a] < indice[b]:
                aristas += [indice[a], indice[b]]

    resultado = {
        "generado": date.today().isoformat(),
        "fuente": "OpenStreetMap (ODbL) via Overpass",
        "centro": CENTRO,
        "radio_m": RADIO_M,
        "coords": coords,      # [lat0, lng0, lat1, lng1, ...]
        "aristas": aristas,    # [a0, b0, a1, b1, ...] indices de nodo, no dirigidas
        "snap": snap,          # 1 si a ese nodo se puede "pegar" un cliente
    }
    with open(salida, "w", encoding="utf-8") as f:
        json.dump(resultado, f, separators=(",", ":"))

    total_m = sum(distancia(nodos[ids[aristas[i]]], nodos[ids[aristas[i + 1]]]) for i in range(0, len(aristas), 2))
    print(f"Nodos: {len(ids)} (de {len(adj)}), aristas: {len(aristas) // 2}, "
          f"red: {total_m / 1000:.1f} km, archivo: {os.path.getsize(salida) / 1024:.0f} KB")
    print(f"Guardado en {salida}")


if __name__ == "__main__":
    sys.exit(main())
