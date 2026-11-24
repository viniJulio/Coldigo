@echo off
title Ponte Coldigo (conta demo da Binance)
cd /d "%~dp0"
where node >nul 2>nul || (echo O Node.js nao esta instalado. Baixe a versao LTS em https://nodejs.org e tente de novo. & pause & exit /b 1)
node servidor.js
pause
