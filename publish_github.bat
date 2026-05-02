@echo off
setlocal
cd /d "%~dp0"

set "SCRIPT_DIR=%~dp0"
set "SOURCE_DIR=%SCRIPT_DIR%"
set "MAIN_APP_DIR=%USERPROFILE%\2222\FX_App\"
set "GITHUB_REPO=%USERPROFILE%\Desktop\FX_App_GitHub\FX_App"

if exist "%MAIN_APP_DIR%index.html" if exist "%MAIN_APP_DIR%package.json" (
  set "SOURCE_DIR=%MAIN_APP_DIR%"
)

set "WORK_DIR=%SOURCE_DIR%"
set "GIT_EXE=git"
where git >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\Git\cmd\git.exe" (
    set "GIT_EXE=C:\Program Files\Git\cmd\git.exe"
  ) else if exist "C:\Program Files\Git\bin\git.exe" (
    set "GIT_EXE=C:\Program Files\Git\bin\git.exe"
  ) else (
    echo Git is not installed or not in PATH.
    echo Install Git for Windows or open/publish this folder through GitHub Desktop.
    echo.
    echo Download: https://git-scm.com/download/win
    pause
    exit /b 1
  )
)

for /f "usebackq tokens=* delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -Raw -LiteralPath '%SOURCE_DIR%package.json' | ConvertFrom-Json).version"`) do set APP_VERSION=%%v
if "%APP_VERSION%"=="" set APP_VERSION=unknown

if exist "%GITHUB_REPO%\.git" (
  echo Source app: %SOURCE_DIR%
  echo Using GitHub repository: %GITHUB_REPO%
  echo Version: %APP_VERSION%
  set "WORK_DIR=%GITHUB_REPO%"
  copy /Y "%SOURCE_DIR%index.html" "%WORK_DIR%\index.html" >nul
  copy /Y "%SOURCE_DIR%main.js" "%WORK_DIR%\main.js" >nul
  copy /Y "%SOURCE_DIR%package.json" "%WORK_DIR%\package.json" >nul
  copy /Y "%SOURCE_DIR%package-lock.json" "%WORK_DIR%\package-lock.json" >nul
  copy /Y "%SOURCE_DIR%start_fx.bat" "%WORK_DIR%\start_fx.bat" >nul
  copy /Y "%SOURCE_DIR%publish_github.bat" "%WORK_DIR%\publish_github.bat" >nul
  if exist "%SOURCE_DIR%.gitignore" copy /Y "%SOURCE_DIR%.gitignore" "%WORK_DIR%\.gitignore" >nul
)

cd /d "%WORK_DIR%"

if not exist ".git" (
  "%GIT_EXE%" init
  "%GIT_EXE%" branch -M main
)

"%GIT_EXE%" remote get-url origin >nul 2>nul
if errorlevel 1 (
  "%GIT_EXE%" remote add origin https://github.com/LevBali/FX_App.git
)

"%GIT_EXE%" add .gitignore index.html main.js package.json package-lock.json start_fx.bat publish_github.bat
"%GIT_EXE%" commit -m "Release v%APP_VERSION%"
if errorlevel 1 (
  echo Nothing to commit or commit failed. Continuing to push existing state.
)

"%GIT_EXE%" push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed. Check GitHub login/permissions and repository name.
  pause
  exit /b 1
)

echo.
echo Published FX_App v%APP_VERSION% to GitHub.
pause
