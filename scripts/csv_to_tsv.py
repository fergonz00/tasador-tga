"""Convierte cca_fixed.csv a TSV para pegado directo en Google Sheets."""
import csv
from pathlib import Path

HERE = Path(__file__).parent
src = HERE / 'cca_fixed.csv'
dst = HERE / 'cca_fixed.tsv'

with src.open(encoding='utf-8', newline='') as f:
    rows = list(csv.reader(f))

with dst.open('w', encoding='utf-8', newline='') as f:
    for r in rows:
        # Reemplazar cualquier tab dentro de celdas por espacio (seguridad)
        clean = [c.replace('\t', ' ') for c in r]
        f.write('\t'.join(clean) + '\n')

print(f"Generado: {dst}")
print(f"Filas: {len(rows)}")
