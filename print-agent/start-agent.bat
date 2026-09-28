@echo off
title PULSAR print agent
cd /d "%~dp0"
:loop
node agent.js
echo.
echo Agent to'xtadi. 5 soniyadan keyin qayta ishga tushadi...
timeout /t 5 /nobreak >nul
goto loop
