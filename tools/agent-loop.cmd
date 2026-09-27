@echo off
rem Houdt de Discogs-agent draaiend: start hem opnieuw als hij stopt (crash, netwerk, update).
rem Wordt bij het opstarten van Windows gestart door een geplande taak (zie de documentatie).
cd /d "%~dp0.."
:loop
node tools\discogs-agent.mjs
timeout /t 10 /nobreak >nul
goto loop
