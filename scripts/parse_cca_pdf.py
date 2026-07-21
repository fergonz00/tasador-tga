# -*- coding: utf-8 -*-
"""
Parser del PDF de CCA (Guia Oficial "nuestrosautos") por COORDENADAS.

El PDF viene ROTADO 90 grados: cada vehiculo es una COLUMNA (banda de x) y los
anios corren por el eje y. Por eso `pdftotext -layout` desalinea todo (fue la
causa del desastre de la carga de abril 2026).

Reglas descubiertas (validadas contra "cca 04-26.pdf" y "Autos.pdf" = julio 2026):
  - La columna de x con los labels de anio (2012..2025, "0 Km") define y -> anio.
  - Cada banda de x = un vehiculo (o un header de marca/modelo).
  - Fuente TT1996t00 -> MODELO. Fuente TT1986t00 -> MARCA o VERSION.
  - Una banda sin precios precedida por un hueco de >=2 slots = MARCA.
  - El label se lee en orden de y DESCENDENTE (texto rotado 90).
  - Columna "0 Km" en US$; anios usados en MILES de pesos.
  - Las anotaciones "<MARCA> 0KM EN US$" vienen en color != 0: se descartan.

Uso:  python parse_cca_pdf.py <pdf> [salida.csv]
"""
import sys, re, csv, statistics
from collections import defaultdict
import fitz

# La fuente de MODELO cambia entre ediciones del PDF (abril: TT1996t00 vs
# TT1986t00 / julio: ArialNarrow,BoldItalic vs ArialNarrow,Bold). No se
# hardcodea: se deduce por pagina como "la que no usan las filas con precios".
Y_TOL = 18.0   # tolerancia y para matchear un precio a su fila de anio (paso ~37)


def page_spans(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                t = s["text"].strip()
                if t:
                    out.append({"x": s["bbox"][0],
                                "y": (s["bbox"][1] + s["bbox"][3]) / 2,
                                "t": t, "font": s["font"], "color": s["color"]})
    return out


def year_axis(spans):
    """Encuentra la columna de encabezados de anio -> ({anio: y}, x_eje)."""
    by_x = defaultdict(list)
    for s in spans:
        by_x[round(s["x"])].append(s)
    for x, ss in sorted(by_x.items()):
        labels = {}
        for s in ss:
            if re.fullmatch(r"20\d{2}", s["t"]):
                labels[s["t"]] = s["y"]
            elif s["t"].replace(" ", "").upper() == "0KM":
                labels["0Km"] = s["y"]
            elif s["t"].strip() == "0":
                labels["0Km"] = s["y"]
        if len(labels) >= 10:
            if "0Km" not in labels:
                ys = sorted(labels.values())
                labels["0Km"] = ys[-1] + (ys[-1] - ys[-2])
            return labels, x
    return None, None


def bands_of(spans, year_x):
    """Agrupa spans en bandas de x (un vehiculo por banda). Devuelve lista ordenada."""
    items = [s for s in spans if s["x"] > year_x + 5 and s["color"] == 0]
    if not items:
        return []
    xs = sorted({round(s["x"], 1) for s in items})
    # agrupar x casi iguales (mismo vehiculo, spans con x que difiere <2pt)
    groups, cur = [], [xs[0]]
    for x in xs[1:]:
        if x - cur[-1] < 3:
            cur.append(x)
        else:
            groups.append(cur); cur = [x]
    groups.append(cur)
    band_x = [statistics.mean(g) for g in groups]
    bands = [[] for _ in band_x]
    for s in items:
        i = min(range(len(band_x)), key=lambda i: abs(band_x[i] - s["x"]))
        bands[i].append(s)
    return list(zip(band_x, bands))


def parse_band(ss, year_map):
    label_parts, precios = [], {}
    for s in sorted(ss, key=lambda s: -s["y"]):
        txt = s["t"].strip()
        if re.fullmatch(r"[\d][\d.,]*", txt):
            hit = min(year_map.items(), key=lambda kv: abs(kv[1] - s["y"]))
            if abs(hit[1] - s["y"]) <= Y_TOL:
                precios[hit[0]] = txt
                continue
        label_parts.append(txt)
    return " ".join(label_parts).strip(), precios


def parse_pdf(path, verbose=False):
    doc = fitz.open(path)
    filas, marca, modelo = [], None, None
    warnings = []
    for pno, page in enumerate(doc):
        spans = page_spans(page)
        year_map, year_x = year_axis(spans)
        if not year_map:
            warnings.append(f"pag {pno+1}: sin eje de anios, salteada")
            continue
        bands = bands_of(spans, year_x)
        if not bands:
            continue
        # ancho de slot = mediana de las distancias entre bandas contiguas
        diffs = [b - a for a, b in zip([x for x, _ in bands], [x for x, _ in bands][1:])]
        slot = statistics.median([d for d in diffs if d > 5]) if diffs else 16.0

        parsed = [(bx, ss) + parse_band(ss, year_map) for bx, ss in bands]
        # fuente de VERSION = la mas usada entre las filas que traen precios.
        # Cualquier otra fuente en una banda de label => es un MODELO.
        cnt = defaultdict(int)
        for bx, ss, label, precios in parsed:
            if precios:
                for s in ss:
                    cnt[s["font"]] += 1
        font_version = max(cnt, key=cnt.get) if cnt else None

        prev_x = None
        for bx, ss, label, precios in parsed:
            if not label:
                prev_x = bx
                continue
            fonts = {s["font"] for s in ss}
            gap = prev_x is None or (bx - prev_x) >= slot * 1.6
            prev_x = bx
            if font_version and fonts and font_version not in fonts:
                modelo = label
                if precios:
                    filas.append([marca, modelo, "", precios, pno + 1])
                continue
            if not precios and gap:
                marca, modelo = label, None
                continue
            filas.append([marca, modelo or "", label, precios, pno + 1])
    return filas, warnings


ANIOS = ["0Km"] + [str(a) for a in range(2025, 2011, -1)]


def write_csv(filas, out):
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["marca", "modelo", "version"] + ANIOS + ["pag"])
        for marca, modelo, version, precios, pag in filas:
            w.writerow([marca or "", modelo or "", version] +
                       [precios.get(a, "") for a in ANIOS] + [pag])


if __name__ == "__main__":
    pdf = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "cca_parsed.csv"
    filas, warns = parse_pdf(pdf)
    write_csv(filas, out)
    for w in warns:
        print("WARN", w)
    marcas = [f[0] for f in filas]
    print(f"{len(filas)} filas, {len(set(marcas))} marcas -> {out}")
    print(f"sin marca: {sum(1 for m in marcas if not m)} | sin modelo: {sum(1 for f in filas if not f[1])}")
