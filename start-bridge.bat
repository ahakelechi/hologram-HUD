@echo off
REM HOLO // NEXUS - start the voice bridge.
REM This is the only piece that has to be running. Once it is, the
REM microphone is turned on and off from the wallpaper's own Voice panel.
cd /d "%~dp0"
echo Starting holo-bridge...
echo In the wallpaper: Settings -^> Voice -^> START LISTENING
echo.
node holo-bridge.js 8787
pause
