@echo off
REM Build MSIX for Microsoft Store upload. NO signtool - Microsoft re-signs Store uploads.
set MSIX_PATH=C:\Users\eerie\Documents\GitHub\deck-transfer\DeckTransfer_0.4.3.0_x64.msix
"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe" pack /d "C:\Users\eerie\Documents\GitHub\deck-transfer\msix-dist" /p "%MSIX_PATH%" /o /v
if %ERRORLEVEL% neq 0 (
  echo MAKEAPPX FAILED: %ERRORLEVEL%
  exit /b %ERRORLEVEL%
)
echo MSIX READY FOR STORE UPLOAD: %MSIX_PATH%
echo EXIT CODE: %ERRORLEVEL%
