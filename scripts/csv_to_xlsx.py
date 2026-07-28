"""Convierte cca_fixed.csv a XLSX para importar en Google Sheets sin ambiguedad."""
import csv
from pathlib import Path
from openpyxl import Workbook

HERE = Path(__file__).parent
src = HERE / 'cca_fixed.csv'
dst = HERE / 'cca_fixed.xlsx'

with src.open(encoding='utf-8', newline='') as f:
    rows = list(csv.reader(f))

wb = Workbook()
ws = wb.active
ws.title = 'cca_precios_abril_2026'
for r in rows:
    # Convertir precios a int/float cuando se pueda (para que Sheets los trate como numeros)
    out = []
    for c in r:
        if c == '':
            out.append(None)
        else:
            # Intentar parsear como numero
            try:
                # Si tiene coma decimal tipo "77940,0"
                if ',' in c and c.replace(',','').replace('.','').isdigit():
                    out.append(float(c.replace(',','.')))
                elif c.isdigit():
                    out.append(int(c))
                else:
                    out.append(c)
            except Exception:
                out.append(c)
    ws.append(out)

wb.save(dst)
print(f"Generado: {dst}")
print(f"Filas: {len(rows)}")
