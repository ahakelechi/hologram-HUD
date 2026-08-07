@echo off
REM Adds the bridge to Windows startup, so the wallpaper's microphone button
REM works after every reboot without opening anything by hand.
setlocal
set "SRC=%~dp0holo-bridge.js"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\holo-bridge.vbs"
REM A .vbs launcher keeps it windowless; a .bat would leave a console open.
> "%LNK%" echo Set s = CreateObject("WScript.Shell")
>> "%LNK%" echo s.CurrentDirectory = "%~dp0"
>> "%LNK%" echo s.Run "node ""%SRC%"" 8787", 0, False
echo Installed. The bridge will start automatically at login.
echo Remove it by deleting:
echo   %LNK%
pause
