@echo off
REM Antigravity proxy — starter (port 1413)
REM VPS: set AGY_PROXY_HOST=0.0.0.0 lalu buka /admin/ui?key=sk-agy-local
title Antigravity Proxy :1413
cd /d C:\Users\RYZEN\agy-proxy
echo Menjalankan Antigravity proxy
echo Dashboard : http://127.0.0.1:1413/admin/ui
echo VPS bind  : set AGY_PROXY_HOST=0.0.0.0
echo.
node server.js
pause
