@echo off
rem Double-click to open the mcpbridge control panel. Keep the window open while you use it.
cd /d "%~dp0"
if not exist dist\index.js (
  echo First run: installing and building, this takes a minute...
  call npm install || goto :fail
)
node dist\index.js ui
if errorlevel 1 goto :fail
goto :eof
:fail
echo.
echo Something went wrong above. Press a key to close.
pause >nul
