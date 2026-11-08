@echo off
setlocal
if "%~1"=="" goto usage
if "%~2"=="" goto usage
rem MSVC's localized /showIncludes output must match CMake/Ninja's UTF-8 prefix.
rem Set this before the first configure, so header dependencies are recorded.
chcp 65001 >nul
cmake -S "%~dp0" -B "%~f1" -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_PREFIX_PATH=%~f2"
if errorlevel 1 exit /b %errorlevel%
cmake --build "%~f1" --parallel 2
exit /b %errorlevel%
:usage
echo Usage: build-windows.cmd BUILD_DIRECTORY QT_MSVC_PREFIX
echo Run in a Visual Studio developer command prompt with CMake and Ninja on PATH.
exit /b 2
