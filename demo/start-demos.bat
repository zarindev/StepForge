@echo off
REM Starts the StepForge demo apps. CareClinic: http://127.0.0.1:8101
REM (ShopDesk and Mailpit join in later build phases.)
cd /d "%~dp0.."
call npm run start -w @stepforge/demo-clinic
