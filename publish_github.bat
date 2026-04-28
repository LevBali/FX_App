@echo off
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not in PATH.
  echo Install Git for Windows or open/publish this folder through GitHub Desktop.
  echo.
  echo Download: https://git-scm.com/download/win
  pause
  exit /b 1
)

for /f "usebackq tokens=* delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -Raw package.json | ConvertFrom-Json).version"`) do set APP_VERSION=%%v
if "%APP_VERSION%"=="" set APP_VERSION=unknown

if not exist ".git" (
  git init
  git branch -M main
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin https://github.com/LevBali/FX_App.git
)

git add .gitignore index.html main.js package.json package-lock.json start_fx.bat publish_github.bat
git commit -m "Release v%APP_VERSION%"
if errorlevel 1 (
  echo Nothing to commit or commit failed. Continuing to push existing state.
)

git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed. Check GitHub login/permissions and repository name.
  pause
  exit /b 1
)

echo.
echo Published FX_App v%APP_VERSION% to GitHub.
pause
