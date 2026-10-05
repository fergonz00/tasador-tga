@echo off
REM El chequeo del 5 de cada mes. A diferencia de la corrida diaria, este AVISA
REM SIEMPRE: haya edicion nueva o no. Fer, 5-10-2026: "quiero que los 5 de cada
REM mes chequees la pagina desde donde se baja el pdf de cca para que el precio
REM este ok y actualizado".
REM
REM La corrida diaria es silenciosa cuando no hay novedad, y eso esta bien para
REM no molestar, pero deja una duda: no se sabe si el circuito sigue vivo o si
REM se quedo con una tabla vieja. Este chequeo contesta eso una vez por mes, y
REM si el CCA todavia no publico la edicion del mes lo marca como algo a mirar.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PY=C:\proyectos\scraper-autoahorro\.venv\Scripts\python.exe
if not exist "%PY%" (
  echo ERROR: no encuentro el interprete %PY% >> "_actualizar_cca.log"
  exit /b 9
)
echo. >> "_actualizar_cca.log"
echo ===== CHEQUEO MENSUAL %DATE% %TIME% ===== >> "_actualizar_cca.log"
"%PY%" -u actualizar_cca.py --verificar >> "_actualizar_cca.log" 2>&1
exit /b %ERRORLEVEL%
