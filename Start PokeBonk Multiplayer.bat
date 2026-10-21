@echo off
title PokeBonk Multiplayer
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required on this PC: https://nodejs.org  ^(download the LTS version^)
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
echo.
echo  How are you playing?
echo    1 = Everyone on the same network (home WiFi / cable)
echo    2 = Over the internet: get a link to send to your friends
echo.
choice /c 12 /n /m "Press 1 or 2: "
set MODE=
if errorlevel 2 set MODE=--internet
echo.
echo Keep this window open while you play. Close it to stop the server.
echo.
node server.js %MODE%
pause
