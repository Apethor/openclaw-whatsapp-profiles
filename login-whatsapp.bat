@echo off
setlocal
cd /d "%~dp0"

echo.
echo OpenClaw WhatsApp login
echo If a QR code appears, scan it in WhatsApp ^> Linked devices.
echo.

call npx openclaw channels login --channel whatsapp --account default
set "LOGIN_STATUS=%ERRORLEVEL%"

echo.
echo Channel status:
call npx openclaw channels status

echo.
echo Runtime status:
call npm run warmup:status

echo.
if not "%LOGIN_STATUS%"=="0" (
  echo Login command exited with status %LOGIN_STATUS%.
)
pause
exit /b %LOGIN_STATUS%
