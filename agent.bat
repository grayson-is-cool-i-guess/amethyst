@echo off
setlocal enabledelayedexpansion

set "INSTALL_DIR=%ProgramFiles%\AmethystAgent"
if "%PROCESSOR_ARCHITECTURE%"=="x86" set "INSTALL_DIR=%ProgramFiles(x86)%\AmethystAgent"
if not exist "%ProgramFiles%" set "INSTALL_DIR=%TEMP%\AmethystAgent"

set "AGENT_URL=https://github.com/grayson-is-cool-i-guess/amethyst/raw/refs/heads/main/agent.js"
set "AGENT_NPM_PACKAGES=@nut-tree-fork/nut-js socket.io-client socket.io"

>nul 2>&1 net session
if %errorlevel% neq 0 (
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

node -v >nul 2>&1
if %errorlevel% neq 0 (
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.9.0/node-v20.9.0-x64.msi' -OutFile '%TEMP%\nodejs.msi'"
    msiexec /i "%TEMP%\nodejs.msi" /quiet /norestart
    pause
    exit /b
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

powershell -Command "Invoke-WebRequest -Uri '%AGENT_URL%' -OutFile '%INSTALL_DIR%\agent.js' -UseBasicParsing"

cd /d "%INSTALL_DIR%"
if not exist package.json npm init -y >nul 2>&1

:: Install all required npm packages
start cmd /k "cd /d %INSTALL_DIR% && npm install %AGENT_NPM_PACKAGES%"

pause

set /p ROOM_CODE="Room ID: "
if "%ROOM_CODE%"=="" exit /b

set /p SERVER_URL="Server URL (default https://streamamethyst.org): "
if "%SERVER_URL%"=="" set "SERVER_URL=https://streamamethyst.org"

start cmd /k "set ROOM_CODE=%ROOM_CODE%&& set SERVER_URL=%SERVER_URL%&& node agent.js"

pause
exit /b

