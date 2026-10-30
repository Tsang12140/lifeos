@echo off
chcp 65001>nul
rem LifeOS LAN preview: same 5199, bound to 0.0.0.0, login required, admin pages off.
rem If the phone still cannot connect, run 允许手机访问.cmd once (Windows Firewall, needs UAC).
node "%~dp0scripts\preview.mjs" --lan
if errorlevel 1 pause
