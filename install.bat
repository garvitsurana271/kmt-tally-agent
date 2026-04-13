@echo off
echo KMT Tally Agent - Windows Service Installer
echo ============================================

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js is not installed.
  echo Download from https://nodejs.org and install, then run this again.
  pause
  exit /b 1
)

echo Node.js found.

:: Install node-windows for service management
call npm install node-windows --save 2>nul

:: Install the service
node install-service.js

echo.
echo Done! The KMT Tally Agent will now start automatically with Windows.
echo It runs silently in the background whenever TallyPrime is open.
echo.
echo To check status: services.msc -> look for "KMT Tally Agent"
echo To view logs:    check kmt-agent.log in this folder
echo.
pause
