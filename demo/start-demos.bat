@echo off
REM Starts the StepForge demo apps on their own (StepForge's "Load demo workspace" starts them for you):
REM   CareClinic http://127.0.0.1:8101 - ShopDesk http://127.0.0.1:8102 - Mailpit http://127.0.0.1:8025 (SMTP 1025)
cd /d "%~dp0.."
if exist data\bin\mailpit.exe start "Mailpit" data\bin\mailpit.exe --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025
start "ShopDesk" cmd /c npm run start -w @stepforge/demo-shop
call npm run start -w @stepforge/demo-clinic
