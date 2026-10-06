@echo off
REM Starts StepForge at http://127.0.0.1:4400 (or the next free port) and opens the dashboard.
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Dependencies are missing. Run setup.bat first.
  exit /b 1
)
if not exist apps\web\dist\index.html (
  echo ==^> Building the dashboard ^(first start^)
  call npm run build || exit /b 1
)
call npm start
endlocal
