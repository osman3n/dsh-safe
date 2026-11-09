@echo off
setlocal
node "%~dp0dsh-safe.mjs" ui %*
exit /b %errorlevel%
