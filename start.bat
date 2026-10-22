@echo off
rem 切换到 UTF-8 代码页，否则 Node 输出的中文在 cmd 窗口会显示为乱码
chcp 65001 >nul
cd /d "%~dp0"
title AI Robot Test Platform

echo.
echo   ============================================
echo      AI Robot QA Test Platform
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found. Please install Node.js 18+ first.
  echo           https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   Installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [ERROR] npm install failed.
    pause
    exit /b 1
  )
  echo.
)

echo   Starting server, browser will open automatically...
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:3789'"

node server.js

echo.
echo   Server stopped.
pause
