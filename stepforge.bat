@echo off
REM StepForge CLI for Windows (by Md Zarin Tasnim). Usage: stepforge run --app <slug> --env <name>
node "%~dp0apps\cli\bin\stepforge.mjs" %*
exit /b %ERRORLEVEL%
