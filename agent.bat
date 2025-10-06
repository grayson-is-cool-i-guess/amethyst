@echo off
setlocal enabledelayedexpansion

REM === Install dir (user profile so we avoid Program Files permission weirdness) ===
set "INSTALL_DIR=%USERPROFILE%\AmethystAgent"

REM === Where to fetch the agent and which packages to install ===
set "AGENT_URL=https://github.com/grayson-is-cool-i-guess/amethyst/raw/refs/heads/main/agent.js"
set "AGENT_NPM_PACKAGES=@nut-tree-fork/nut-js socket.io-client socket.io express"

REM === Elevate to admin if not already (needed for Node MSI on first run) ===
>nul 2>&1 net session
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

REM === Ensure Node.js is installed ===
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Node.js 20.9.0...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.9.0/node-v20.9.0-x64.msi' -OutFile '%TEMP%\nodejs.msi'"
    msiexec /i "%TEMP%\nodejs.msi" /quiet /norestart
    echo Node installed. Close this window and run this script again.
    pause
    exit /b
)

REM === Create install directory ===
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

REM === Fetch latest agent.js ===
echo Downloading agent.js to "%INSTALL_DIR%"...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%AGENT_URL%' -OutFile '%INSTALL_DIR%\agent.js' -UseBasicParsing"

cd /d "%INSTALL_DIR%"

REM === Init package.json if missing ===
if not exist package.json (
    call npm init -y >nul 2>&1
)

REM === Install required packages (synchronously) ===
echo Installing npm packages...
call npm install %AGENT_NPM_PACKAGES%
if errorlevel 1 (
    echo.
    echo npm install failed. Check the error above and fix it, then re-run this script.
    pause
    exit /b
)

echo.
set /p ROOM_CODE=Room ID: 
if "%ROOM_CODE%"=="" (
    echo No Room ID provided. Exiting.
    exit /b
)

REM === Set env vars and run agent in the SAME window ===
set "ROOM_CODE=%ROOM_CODE%"
set "SERVER_URL=https://streamamethyst.org"

echo.
echo Launching agent with:
echo   INSTALL_DIR=%INSTALL_DIR%
echo   ROOM_CODE=%ROOM_CODE%
echo   SERVER_URL=%SERVER_URL%
echo.

REM If agent crashes, you will see the error here.
node agent.js

echo.
echo Agent exited with code %errorlevel%.
pause
exit /b
