# -*- coding: utf-8 -*-
"""
Toma el CSV que sale de parse_cca_pdf.py y arma el .xlsx listo para importar a
la hoja `cca_precios` del Sheet del tasador.

Convencion UNICA de valores: cada celda = PRECIO EN MILES de la moneda de la fila.
  - anios usados 2025..2012 -> moneda de la columna `moneda`
  - columna 0Km             -> moneda de la columna `moneda_0km`
  ej: 23783 con moneda ARS = $23.783.000 | 111.66 con moneda_0km USD = US$111.660

Reglas de moneda (leidas de las anotaciones en color del PDF de CCA):
  - Marcas 100% en US$ (todos los anios): FERRARI, JAGUAR, LOTUS, MASERATI,
    McLAREN, PORSCHE.
  - El resto: anios usados en miles de PESOS.
  - Columna 0Km en US$ salvo excepciones (ver USD_0KM / EXCEPCIONES_0KM).
"""
import sys, csv, re
from openpyxl import Workbook

ANIOS = ["0Km"] + [str(a) for a in range(2025, 2011, -1)]

# Marcas cuya tabla COMPLETA esta en US$ ("<MARCA> EN US$", sin "0KM")
MARCAS_USD_TOTAL = {"FERRARI", "JAGUAR", "LOTUS", "MASERATI", "McLAREN", "PORSCHE"}

# Marcas con 0Km en US$ ("<MARCA> 0KM EN US$")
USD_0KM = {
    "AGRALE", "ALFA ROMEO", "ARCFOX", "AUDI", "BAIC", "BMW", "BYD", "CHANGAN",
    "CHERY", "DFSK", "DONGFENG", "DOMY", "DS AUTOMOBILES", "FORTHING", "GAC",
    "GEELY", "GREAT WALL", "HAVAL", "HYUNDAI", "ISUZU", "JAC", "JEEP", "JETOUR",
    "JMEV", "KAIYI", "KIA", "LEXUS", "LYNK&CO", "MAXUS", "MERCEDES BENZ", "MG",
    "MINI COOPER", "MITSUBISHI", "RAM", "RELY", "SKYWELL", "SUBARU", "SUZUKI",
    "VOLVO",
}
# Excepciones por modelo dentro de una marca de USD_0KM -> 0Km en PESOS
EXCEPCIONES_0KM_PESOS = {
    "HYUNDAI": ["HB20"],
    "JEEP": ["COMMANDER", "COMPASS", "RENEGADE"],
    "MERCEDES BENZ": ["SPRINTER"],
    "RAM": ["DAKOTA", "RAMPAGE"],
}
# Marcas donde SOLO algunos modelos tienen 0Km en US$
SOLO_MODELOS_0KM_USD = {
    "HONDA": ["ACCORD", "CIVIC", "CR-V"],
    "TOYOTA": ["86", "BZ4X", "CROWN", "HIACE", "LAND CRUISER", "RAV", "YARIS"],
}


def moneda_fila(marca):
    return "USD" if (marca or "").upper() in {m.upper() for m in MARCAS_USD_TOTAL} else "ARS"


def moneda_0km(marca, modelo):
    m, mo = (marca or "").upper(), (modelo or "").upper()
    if m in {x.upper() for x in MARCAS_USD_TOTAL}:
        return "USD"
    if m in SOLO_MODELOS_0KM_USD:
        return "USD" if any(k in mo for k in SOLO_MODELOS_0KM_USD[m]) else "ARS"
    if m in {x.upper() for x in USD_0KM}:
        for k in EXCEPCIONES_0KM_PESOS.get(m, []):
            if k in mo:
                return "ARS"
        return "USD"
    return "ARS"


def num(raw, es_0km, mon):
    """Normaliza el texto del PDF a MILES de la moneda."""
    raw = (raw or "").strip()
    if not raw:
        return None
    if "," in raw:
        ent, dec = raw.split(",", 1)
        if len(dec) == 3:          # coma = separador de miles -> valor en unidades
            v = float(ent + dec)
            return round(v / 1000, 3) if es_0km else v
        v = float(ent + "." + dec)  # coma = decimal -> ya viene en miles
        return v
    return float(raw)


def build(src, out):
    rows = list(csv.DictReader(open(src, encoding="utf-8")))
    wb = Workbook(); ws = wb.active; ws.title = "cca_precios"
    ws.append(["marca", "modelo", "version", "moneda", "moneda_0km"] + ANIOS)
    for r in rows:
        mon = moneda_fila(r["marca"])
        m0 = moneda_0km(r["marca"], r["modelo"])
        vals = [num(r[a], a == "0Km", m0 if a == "0Km" else mon) for a in ANIOS]
        if not any(v is not None for v in vals):
            continue
        ws.append([r["marca"], r["modelo"], r["version"], mon, m0] + vals)
    for col, w in zip("ABCDE", (18, 22, 46, 9, 11)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "D2"
    wb.save(out)
    print(f"{ws.max_row - 1} filas -> {out}")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "cca_julio.xlsx")
