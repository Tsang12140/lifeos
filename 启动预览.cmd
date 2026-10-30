@echo off
chcp 65001>nul
rem LifeOS local preview: API 3011 + Web 5199, loopback only, admin pages on.
rem For a phone on the same Wi-Fi, double-click the LAN launcher instead.
node "%~dp0scripts\preview.mjs"
if errorlevel 1 pause
