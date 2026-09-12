@echo off
chcp 65001 >nul
rem dsh-report-scheduler installer (double click me)
setlocal
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" (
    set "NODE=%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd"
  ) else (
    echo [!] Node not found. Install Node 22+, or run this from DSH Desktop's bundled node.
    pause
    exit /b 1
  )
)
"%NODE%" "%~dp0install.mjs" %*
echo.
pause
