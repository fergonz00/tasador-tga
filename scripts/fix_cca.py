"""
Repara las filas de la planilla CCA donde la columna 'modelo' quedo vacia
porque al cargarla desde el PDF se perdio la jerarquia modelo -> versiones.

Input:
  /tmp/cca.csv  (descargado de Google Sheets)
  /tmp/cca.txt  (PDF convertido con pdftotext -layout)

Output:
  /tmp/cca_fixed.csv  (listo para pegar en Google Sheets, reemplazando todas las filas)
  /tmp/cca_report.txt (resumen: filas arregladas, dudas flageadas)
"""
import csv
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
PDF_TXT = (HERE / 'cca.txt').read_text(encoding='utf-8', errors='replace')
CSV_IN  = HERE / 'cca.csv'
CSV_OUT = HERE / 'cca_fixed.csv'
REPORT  = HERE / 'cca_report.txt'

# Marcas en el orden en que aparecen en el CSV/PDF
ALL_BRANDS = ['AGRALE','ALFA ROMEO','AUDI','BAIC','BMW','BYD','CHANGAN','CHERY',
              'CHEVROLET','CHRYSLER','CITROEN','DFSK','DODGE','DONGFENG','DS AUTOMOBILES',
              'FAW','FERRARI','FIAT','FORD','FOTON','GAC','GEELY','GREAT WALL','HAVAL',
              'HONDA','HYUNDAI','ISUZU','JAC','JAGUAR','JEEP','JETOUR','JMC','JMEV',
              'KAIYI','KIA','KYC','LAND ROVER','LEXUS','LIFAN','LOTUS','MASERATI','MAXUS',
              'MERCEDES BENZ','MG','MINI COOPER','MITSUBISHI','McLAREN','NISSAN','PEUGEOT',
              'PORSCHE','RAM','RENAULT','SUBARU','SUZUKI','TOYOTA','VOLKSWAGEN','VOLVO']

# Marcas con filas rotas (modelo vacio)
AFFECTED = {'PEUGEOT','BMW','MINI COOPER','FIAT','RAM','TOYOTA','GEELY','ALFA ROMEO','PORSCHE','CHRYSLER'}

# Prefijos de texto que indican que la linea es una VERSION (no un modelo)
VERSION_PREFIXES = re.compile(
    r'^(\d+P\b|\d+D\b|C/S\b|D/C\b|FURGON\b|VAN\b|MINIBUS\b|CHASIS\b|CHASSIS\b|'
    r'COUPE\b|CABRIO\b|CONV\b|SEDAN\b|HATCH\b|HATCHBACK\b|SW\b|'
    r'GRAN COUPE\b|ROADSTER\b|'
    r'PICK UP\b|PICKUP\b|PATAGONICA\b|CC\b|'
    r'AM \d|MARRUA\b)',
    re.IGNORECASE
)

# Lineas basura del PDF (cabeceras de pagina, headers de columnas)
def is_garbage(text):
    if not text:
        return True
    t = text.strip()
    if not t:
        return True
    if t.startswith('0 Km'):
        return True
    if t.startswith('Autos - Pick Ups'):
        return True
    if t.startswith('Visite Nuestro Sitio'):
        return True
    return False

def strip_prices(line):
    """Quita numeros de precio al final, devuelve el texto limpio.
    Un numero entre 2010-2030 se considera anio (parte del texto), no precio."""
    parts = line.rstrip().split()
    while len(parts) > 1 and re.match(r'^[0-9.,]+$', parts[-1]):
        last = parts[-1]
        num = last.replace(',', '').replace('.', '')
        if num.isdigit() and 2010 <= int(num) <= 2030 and len(num) == 4:
            break  # es anio, parte del texto
        parts.pop()
    return ' '.join(parts).strip()

def is_version_line(text):
    """Una linea es version si su texto limpio matchea un prefijo conocido."""
    return bool(VERSION_PREFIXES.match(text))

def is_price_only(line):
    """Linea huerfana de precios sueltos (solo numeros y con leading whitespace grande).
    Una linea tipo '206   7495' NO es price-only porque 206 es modelo."""
    stripped = line.strip()
    if not stripped:
        return True
    if not re.match(r'^[0-9.,\s]+$', stripped):
        return False
    leading = len(line) - len(line.lstrip())
    return leading > 5

def extract_brand_block(brand):
    """Devuelve las lineas del PDF que corresponden a esta marca."""
    lines = PDF_TXT.splitlines()
    start = None
    idx = ALL_BRANDS.index(brand)
    next_brand = ALL_BRANDS[idx + 1] if idx + 1 < len(ALL_BRANDS) else None

    # Buscar primera linea que arranque con la marca (en col 0, sin indent)
    for i, line in enumerate(lines):
        if line.startswith(brand + ' ') or line == brand or line.rstrip() == brand:
            start = i
            break
    if start is None:
        return []

    end = len(lines)
    if next_brand:
        for j in range(start + 1, len(lines)):
            line = lines[j]
            if line.startswith(next_brand + ' ') or line == next_brand or line.rstrip() == next_brand:
                end = j
                break
    return lines[start:end]

def parse_brand_block(brand, block_lines):
    """Devuelve lista de (modelo, version) en orden segun el PDF.
    La primera linea del bloque es la marca misma - la salteamos."""
    result = []
    current_model = None
    # (DEBUG se redefine abajo)
    for raw in block_lines[1:]:  # saltar linea "MARCA"
        if is_price_only(raw):
            continue
        text = strip_prices(raw)
        if is_garbage(text):
            continue
        if is_version_line(text):
            if current_model is None:
                # Version sin modelo previo - algo raro
                result.append((None, text))
            else:
                result.append((current_model, text))
        else:
            # Es un modelo (o titulo)
            current_model = text
    return result

def norm_version(v):
    """Normaliza version para comparar (quita dobles espacios, comillas)."""
    return re.sub(r'\s+', ' ', v.strip().replace('"', ''))

def main():
    # Leer CSV
    with CSV_IN.open(encoding='utf-8', newline='') as f:
        reader = csv.reader(f)
        rows = list(reader)
    header = rows[0]
    data = rows[1:]

    report_lines = []
    fixed_count = 0
    ambiguous_count = 0

    # Para cada marca afectada, parsear PDF y alinear
    for brand in AFFECTED:
        block = extract_brand_block(brand)
        if not block:
            report_lines.append(f"[{brand}] NO encontrado en PDF - skip")
            continue
        pdf_pairs = parse_brand_block(brand, block)

        # Filas del CSV de esta marca (con indices)
        csv_rows = [(i, r) for i, r in enumerate(data) if r[0] == brand]

        report_lines.append(f"\n=== {brand} ===")
        report_lines.append(f"PDF: {len(pdf_pairs)} pares (modelo, version)")
        report_lines.append(f"CSV: {len(csv_rows)} filas")

        if len(pdf_pairs) != len(csv_rows):
            report_lines.append(f"!! tamanos distintos: PDF {len(pdf_pairs)} vs CSV {len(csv_rows)}")

        # Alineacion con puntero avanzante (tolera extras en ambos lados)
        pdf_ptr = 0
        for n, (csv_idx, row) in enumerate(csv_rows):
            csv_model = row[1]
            csv_version = norm_version(row[2]).upper()
            # Buscar matching version en PDF desde pdf_ptr
            search_ptr = pdf_ptr
            matched_at = None
            while search_ptr < len(pdf_pairs):
                pdf_model, pdf_version = pdf_pairs[search_ptr]
                if norm_version(pdf_version).upper() == csv_version:
                    matched_at = search_ptr
                    break
                search_ptr += 1
            if matched_at is None:
                report_lines.append(
                    f"  [CSV row {n}] version sin match en PDF: '{row[2]}' (modelo CSV='{csv_model}')"
                )
                ambiguous_count += 1
                continue
            # Match encontrado
            pdf_model, pdf_version = pdf_pairs[matched_at]
            skipped = matched_at - pdf_ptr
            if skipped > 0:
                report_lines.append(
                    f"  [CSV row {n}] salteadas {skipped} lineas PDF antes del match de '{row[2]}'"
                )
            pdf_ptr = matched_at + 1

            if csv_model == '' and pdf_model:
                row[1] = pdf_model
                fixed_count += 1
            elif csv_model != '' and pdf_model and csv_model.upper() != pdf_model.upper():
                report_lines.append(
                    f"  [CSV row {n}] modelo mismatch (dejo el CSV): CSV='{csv_model}' vs PDF='{pdf_model}' (version='{row[2]}')"
                )

    # Listado final de filas que siguen con modelo vacio (para revision manual)
    pendientes = []
    for i, r in enumerate(data):
        if r[1] == '' and r[0] in AFFECTED:
            pendientes.append((i + 2, r[0], r[2]))  # +2: encabezado + base 1 de Sheets
    if pendientes:
        report_lines.append("\n\n########## FILAS QUE QUEDARON SIN MODELO (revisar a mano) ##########")
        report_lines.append(f"Total: {len(pendientes)}")
        for fila, marca, version in pendientes:
            report_lines.append(f"  Fila {fila}: {marca} | version='{version}'")

    # Escribir CSV corregido
    with CSV_OUT.open('w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL)
        writer.writerow(header)
        writer.writerows(data)

    # Escribir reporte
    summary = [
        f"Filas arregladas: {fixed_count}",
        f"Filas ambiguas (no tocadas): {ambiguous_count}",
        "",
    ]
    REPORT.write_text('\n'.join(summary + report_lines), encoding='utf-8')
    print('\n'.join(summary[:3]))
    print(f"Output: {CSV_OUT}")
    print(f"Reporte: {REPORT}")

if __name__ == '__main__':
    main()
