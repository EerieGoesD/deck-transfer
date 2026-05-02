@echo off
"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe" pack /d "C:\Users\eerie\Documents\GitHub\deck-transfer\msix-dist" /p "C:\Users\eerie\Documents\GitHub\deck-transfer\DeckTransfer_0.3.2.0_x64.msix" /o /v
echo EXIT CODE: %ERRORLEVEL%
