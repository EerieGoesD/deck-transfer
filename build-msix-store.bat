@echo off
set MSIX_PATH=C:\Users\eerie\Documents\GitHub\deck-transfer\DeckTransfer_0.3.6.0_x64.msix
"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe" pack /d "C:\Users\eerie\Documents\GitHub\deck-transfer\msix-dist" /p "%MSIX_PATH%" /o /v
if %ERRORLEVEL% neq 0 (
  echo MAKEAPPX FAILED: %ERRORLEVEL%
  exit /b %ERRORLEVEL%
)
"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" sign /fd SHA256 /sha1 D9AF32367822F473442F5A91D6035F200A5AB7B1 "%MSIX_PATH%"
echo EXIT CODE: %ERRORLEVEL%
