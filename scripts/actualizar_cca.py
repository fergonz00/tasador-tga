# -*- coding: utf-8 -*-
"""Actualiza solo la tabla del CCA cuando sale la edicion nueva, y avisa.

    python actualizar_cca.py --dry     # mira si hay edicion nueva, no publica
    python actualizar_cca.py           # la publica si pasa las validaciones
    python actualizar_cca.py --forzar  # la rehace aunque sea la misma edicion

Fer, 5-10-2026: *"todo lo que es CCA lo estas actualizando x mes fijandote en la
pagina de cca? eso tiene que estar automatizado como esto, todos los meses tenes
que actualizarlo sin que te lo pida, solo que cuando lo hagas avisame que lo
hiciste y si hubo algun problema avisame."*

Antes de esto el circuito existia pero habia que acordarse de correrlo: bajar el
PDF, parsearlo, armar el xlsx y subirlo. Asi se nos paso que la tabla que
estabamos usando era de **julio** cuando creiamos que era de agosto.

Corre TODOS LOS DIAS y no hace nada hasta que la edicion del PDF cambia: la
Comision de Valuacion del CCA se reune a fin de mes, pero el PDF no aparece un
dia fijo. Chequear a diario sale gratis (es una tarea local, no gasta minutos de
GitHub Actions) y asi la tabla nueva entra el dia que se publica.

El circuito completo:
  1. baja https://www.cca.org.ar/descargas/precios/Autos.pdf
  2. lee la edicion de la primera pagina ("... Octubre 2026")
  3. si es la misma que la ultima procesada, termina y no avisa nada
  4. parse_cca_pdf.py -> csv  ·  build_cca_sheet.py -> xlsx
  5. VALIDA contra la tabla que esta viva (abajo)
  6. subir_cca.py -> pisa la pestaña gid 904791552 y deja backup de la anterior
  7. vuelve a leer la planilla para confirmar, y manda el WhatsApp

⚠️ El porton de validacion es lo que hace que esto pueda correr solo. El PDF
viene rotado 90 grados y con la moneda indicada por el COLOR de la anotacion:
si el parseo sale mal, sale mal en silencio. Antes de publicar se exige que la
tabla nueva se parezca a la vieja; si no, NO publica y avisa. Vale mas quedarse
con la tabla del mes pasado que tasar con numeros inventados.
"""
import argparse
import csv
import hashlib
import io
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join("C:" + os.sep, "proyectos", "kavak-cotizador"))

PDF_URL = "https://www.cca.org.ar/descargas/precios/Autos.pdf"
SSID = "1MJWeHCTbxdqBJwifzgNbHssLLsxAwaSkb66Zc9yv3ko"
GID_VIVA = 904791552
GVIZ = ("https://docs.google.com/spreadsheets/d/%s/gviz/tq?tqx=out:csv&gid=%d"
        "&headers=1" % (SSID, GID_VIVA))
ESTADO = os.path.join(AQUI, "_cca_estado.json")
ENV_SIM = os.path.join("C:" + os.sep, "proyectos", ".secrets", "simulador-vwfs.env")
MESES = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre")


def _env():
    out = {}
    for l in open(ENV_SIM, encoding="utf-8"):
        l = l.strip()
        if l and not l.startswith("#") and "=" in l:
            k, v = l.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def bajar_pdf(destino):
    req = urllib.request.Request(PDF_URL, headers={"User-Agent": "Mozilla/5.0"})
    datos = urllib.request.urlopen(req, timeout=300).read()
    open(destino, "wb").write(datos)
    return hashlib.sha256(datos).hexdigest(), len(datos)


def edicion_de(pdf):
    """La edicion sale de la primera pagina: '... Utilitarios Octubre 2026'."""
    import pdfplumber
    with pdfplumber.open(pdf) as d:
        txt = (d.pages[0].extract_text() or "").lower()
    m = re.search(r"(" + "|".join(MESES) + r")\s+(20\d\d)", txt)
    return (m.group(1) + " " + m.group(2)) if m else None


def estado():
    if os.path.exists(ESTADO):
        return json.load(open(ESTADO, encoding="utf-8"))
    return {}


def guardar_estado(d):
    json.dump(d, open(ESTADO, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def tabla_viva():
    """La tabla que el tasador esta usando ahora, para comparar contra ella."""
    req = urllib.request.Request(GVIZ, headers={"User-Agent": "Mozilla/5.0"})
    txt = urllib.request.urlopen(req, timeout=180).read().decode("utf-8", "replace")
    return list(csv.DictReader(io.StringIO(txt)))


def hojas():
    cfg = _env()
    u = (cfg["PP_EXEC_URL"] + "?panel=inspect&token=" + cfg["PP_TOKEN"] +
         "&id=" + SSID)
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=180)).get("hojas", [])


def validar(nuevas, viejas):
    """Devuelve la lista de problemas. Vacia = se puede publicar.

    No busca que sea idéntica: busca que sea CREÍBLE. Un mes del CCA cambia
    precios y agrega o saca alguna version, no se da vuelta entero.
    """
    problemas = []
    if not nuevas:
        return ["el parseo no devolvio ninguna fila"]
    if len(nuevas) < len(viejas) * 0.9:
        problemas.append("la tabla nueva tiene %d filas contra %d de la vieja "
                         "(se perdio mas del 10%%)" % (len(nuevas), len(viejas)))
    if len(nuevas) > len(viejas) * 1.3:
        problemas.append("la tabla nueva tiene %d filas contra %d de la vieja "
                         "(crecio mas del 30%%)" % (len(nuevas), len(viejas)))
    vw = len([r for r in nuevas if (r.get("marca") or "").upper().startswith("VOLKSWAGEN")])
    if vw < 600:
        problemas.append("solo %d filas de Volkswagen (venian 717)" % vw)

    clave = lambda r: (r.get("marca"), r.get("modelo"), r.get("version"))
    idx = {clave(r): r for r in nuevas}
    sobrevivieron = len([r for r in viejas if clave(r) in idx])
    if sobrevivieron < len(viejas) * 0.6:
        problemas.append("solo %d de las %d versiones viejas siguen estando; "
                         "cambio el formato de la version" % (sobrevivieron, len(viejas)))

    # Variacion de precios: un mes se mueve, no se multiplica ni se derrumba.
    razones = []
    for col in ("2020", "2018"):
        for r in viejas:
            n = idx.get(clave(r))
            if not n:
                continue
            try:
                a, b = float(r.get(col) or 0), float(n.get(col) or 0)
            except ValueError:
                continue
            if a > 0 and b > 0:
                razones.append(b / a)
    if len(razones) < 50:
        problemas.append("solo pude comparar %d precios contra la tabla vieja" % len(razones))
    else:
        med = statistics.median(razones)
        if not (0.97 <= med <= 1.30):
            problemas.append("los precios se movieron %+.1f%% en la mediana, "
                             "fuera de lo creible para un mes" % (100 * (med - 1)))
    return problemas


def correr(args_lista):
    r = subprocess.run([sys.executable] + args_lista, cwd=AQUI,
                       capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError("%s fallo: %s" % (args_lista[0],
                                             (r.stderr or r.stdout)[-400:]))
    return (r.stdout or "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--forzar", action="store_true")
    ap.add_argument("--verificar", action="store_true",
                    help="el chequeo mensual: avisa SIEMPRE, haya novedad o no. "
                         "Fer lo pidio el 5-10-2026 -- 'los 5 de cada mes "
                         "chequees la pagina desde donde se baja el pdf de cca "
                         "para que el precio este ok y actualizado'. La corrida "
                         "diaria es silenciosa cuando no hay nada nuevo, asi "
                         "que sin esto no hay forma de saber si el circuito "
                         "sigue vivo o si se quedo con una tabla vieja")
    args = ap.parse_args()

    import aviso

    est = estado()
    pdf = os.path.join(AQUI, "_cca_ultimo.pdf")
    try:
        sha, tam = bajar_pdf(pdf)
    except Exception as e:
        aviso.resultado("la tabla de precios del CCA", [],
                        ["no pude bajar el PDF de cca.org.ar: %s" % str(e)[:120]],
                        ["revisar si la pagina del CCA cambio de direccion"])
        return 1
    ed = edicion_de(pdf)
    print("PDF: %s (%.1f MB) | edicion leida: %s" % (sha[:12], tam / 1048576.0, ed))
    print("ultima procesada:", est.get("edicion"), est.get("sha", "")[:12])

    if not ed:
        aviso.resultado("la tabla de precios del CCA", [],
                        ["baje el PDF pero no pude leerle la edicion"],
                        ["mirar el PDF a mano: cambio la primera pagina"])
        return 1
    if ed == est.get("edicion") and sha == est.get("sha") and not args.forzar:
        print("misma edicion que la ultima procesada: no hago nada.")
        if args.verificar:
            # ⚠️ Avisar aunque no haya novedad es el punto del chequeo mensual.
            # Y si la edicion en uso NO es la del mes corriente, eso SI es un
            # problema: el CCA ya deberia haber publicado.
            mes_ahora = int(time.strftime("%m"))
            anio_ahora = time.strftime("%Y")
            try:
                m_ed = MESES.index(ed.split()[0]) + 1
                a_ed = ed.split()[1]
            except Exception:
                m_ed, a_ed = 0, ""
            al_dia = (a_ed == anio_ahora and m_ed == mes_ahora)
            viva = [h for h in hojas() if h.get("gid") == GID_VIVA]
            filas = (viva[0].get("filas") - 1) if viva else 0
            detalle = ("la tabla en uso es la de %s, %d versiones, en la pestaña %s"
                       % (ed, filas, viva[0].get("nombre") if viva else "?"))
            if al_dia:
                print('aviso:', aviso.resultado("la tabla de precios del CCA",
                                ["chequee la pagina del CCA: la edicion de %s "
                                 "sigue siendo la ultima y es la que estamos "
                                 "usando" % ed], [detalle], []))
            else:
                print('aviso:', aviso.resultado("la tabla de precios del CCA", [],
                                ["chequee la pagina del CCA y la ultima edicion "
                                 "publicada sigue siendo la de %s. " % ed + detalle],
                                ["el CCA todavia no publico la edicion de este "
                                 "mes; si pasan varios dias, mirar la pagina a mano"]))
        return 0

    mes, anio = ed.split()
    base = "cca_%s_%s" % (mes, anio)
    csv_out, xlsx_out = os.path.join(AQUI, base + ".csv"), os.path.join(AQUI, base + ".xlsx")
    try:
        print(correr(["parse_cca_pdf.py", pdf, csv_out])[-300:])
        print(correr(["build_cca_sheet.py", csv_out, xlsx_out])[-300:])
    except Exception as e:
        aviso.resultado("la tabla de precios del CCA", [],
                        ["salio la edicion de %s pero el parseo fallo: %s"
                         % (ed, str(e)[:160])],
                        ["correr a mano parse_cca_pdf.py y mirar el PDF"])
        return 1

    nuevas = list(csv.DictReader(open(csv_out, encoding="utf-8")))
    viejas = tabla_viva()
    problemas = validar(nuevas, viejas)
    print("filas: %d nuevas contra %d vivas | problemas: %d"
          % (len(nuevas), len(viejas), len(problemas)))
    for p in problemas:
        print("   PROBLEMA:", p)
    if problemas:
        aviso.resultado(
            "la tabla de precios del CCA", [],
            ["salio la edicion de %s pero NO la publique: %s" % (ed, "; ".join(problemas))],
            ["revisar el parseo del PDF de %s antes de publicarlo" % ed])
        return 1
    if args.dry:
        print("(dry) pasa las validaciones, no publico.")
        return 0

    try:
        print(correr(["subir_cca.py", xlsx_out, "cca_precios_%s_%s" % (mes, anio)])[-400:])
    except Exception as e:
        aviso.resultado("la tabla de precios del CCA", [],
                        ["la tabla de %s quedo armada pero no la pude subir: %s"
                         % (ed, str(e)[:160])],
                        ["correr a mano subir_cca.py"])
        return 1

    viva = [h for h in hojas() if h.get("gid") == GID_VIVA]
    confirmado = viva[0] if viva else {}
    guardar_estado({"edicion": ed, "sha": sha, "filas": len(nuevas),
                    "pestania": confirmado.get("nombre"),
                    "procesado_at": time.strftime("%Y-%m-%d %H:%M")})
    aviso.resultado(
        "la tabla de precios del CCA",
        ["publique la edicion de %s: %d versiones en la pestaña %s"
         % (ed, len(nuevas), confirmado.get("nombre"))],
        ["la anterior quedo de backup en la misma planilla"],
        [])
    print("listo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
