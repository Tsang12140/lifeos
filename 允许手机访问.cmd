@echo off
chcp 65001>nul
rem Asks for UAC once: allow inbound TCP 5199/5499 from the same subnet only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\allow-lan-firewall.ps1"
if errorlevel 1 pause
