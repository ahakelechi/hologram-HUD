@echo off
REM HOLO // NEXUS - start the voice stack.
REM Opens the bridge in one window and the listener in another, so each can be
REM read and stopped on its own. Close either window to stop that half.
setlocal

set "HERE=%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if not exist "%PY%" set "PY=python"

echo Starting holo-bridge (wallpaper link)...
start "HOLO bridge" cmd /k node "%HERE%holo-bridge.js" 8787

REM The bridge needs its port open before the listener tries to post to it.
timeout /t 2 /nobreak >nul

echo Starting holo-listen (speech to text)...
start "HOLO listen" cmd /k "%PY%" "%HERE%holo-listen.py" --model small

echo.
echo Both windows are open.
echo In the wallpaper, turn on "Local voice bridge".
echo Then say:  nexus what time is it
echo.
pause
