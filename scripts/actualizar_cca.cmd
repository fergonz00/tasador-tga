@echo off
REM Mira si el CCA publico una edicion nueva y, si paso las validaciones, la
REM deja en la pestaña que lee el tasador. Avisa por WhatsApp SOLO cuando hizo
REM algo o cuando hubo un problema: si es la misma edicion del mes pasado,
REM termina en segundos y no molesta a nadie.
REM
REM Corre todos los dias porque el PDF del CCA no sale un dia fijo: la Comision
REM de Valuacion se reune a fin de mes y lo publican cuando lo publican.
REM Chequear a diario es gratis: es local, NO gasta minutos de GitHub Actions.
REM
REM OJO: hay que apuntar al python del venv (pdfplumber y openpyxl). El
REM Programador de tareas no hereda el PATH y "python" le resuelve al del
REM sistema.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PY=C:\proyectos\scraper-autoahorro\.venv\Scripts\python.exe
if not exist "%PY%" (
  echo ERROR: no encuentro el interprete %PY% >> "_actualizar_cca.log"
  exit /b 9
)
echo. >> "_actualizar_cca.log"
echo ===== %DATE% %TIME% ===== >> "_actualizar_cca.log"
"%PY%" -u actualizar_cca.py >> "_actualizar_cca.log" 2>&1
exit /b %ERRORLEVEL%
