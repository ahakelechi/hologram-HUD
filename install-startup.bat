@echo off
REM Adds the bridge to Windows startup AND starts it now, so the wallpaper's
REM microphone button works immediately rather than only after a reboot.
setlocal
set "SRC=%~dp0holo-bridge.js"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\holo-bridge.vbs"
REM A .vbs launcher keeps it windowless; a .bat would leave a console open.
> "%LNK%" echo Set s = CreateObject("WScript.Shell")
>> "%LNK%" echo s.CurrentDirectory = "%~dp0"
>> "%LNK%" echo s.Run "node ""%SRC%"" 8787", 0, False

echo Installed - the bridge will start automatically at login.

REM Start it now too, unless it is already up.
powershell -NoProfile -Command "$up=$false; try { $null=Invoke-WebRequest 'http://127.0.0.1:8787/status' -TimeoutSec 2 -UseBasicParsing; $up=$true } catch {}; if ($up) { 'Bridge is already running.' } else { Start-Process wscript -ArgumentList '\"%LNK%\"' ; Start-Sleep 2; try { $null=Invoke-WebRequest 'http://127.0.0.1:8787/status' -TimeoutSec 3 -UseBasicParsing; 'Bridge started.' } catch { 'Could not start the bridge - is node installed?' } }"

echo.
echo In the wallpaper: Settings -^> Voice -^> START LISTENING
echo.
echo Remove startup later by deleting:
echo   %LNK%
pause
