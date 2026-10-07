@echo off
REM StepForge setup for Windows. Installs dependencies, the Playwright Chromium browser and builds the dashboard.
setlocal
cd /d "%~dp0"

echo ==^> Checking Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install it from https://nodejs.org and run this script again.
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)"
if errorlevel 1 (
  echo Node.js 22+ is required. Update it from https://nodejs.org
  exit /b 1
)

echo ==^> Installing dependencies
call npm install || exit /b 1

echo ==^> Installing Playwright Chromium
call npx playwright install chromium || exit /b 1

echo ==^> Installing Mailpit (local email catcher)
call npm run mailpit:install || echo     Mailpit could not be installed now; retry from Settings - Email.

echo ==^> Building the dashboard
call npm run build || exit /b 1

if not exist data mkdir data
echo.
echo StepForge is ready. Start it with:  start.bat
endlocal
