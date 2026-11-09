@echo off
setlocal
node "%~dp0dsh-safe.mjs" %*
exit /b %errorlevel%
