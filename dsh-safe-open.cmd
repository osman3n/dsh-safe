@echo off
setlocal
node "%~dp0dsh-safe.mjs" open --ui %*
exit /b %errorlevel%
