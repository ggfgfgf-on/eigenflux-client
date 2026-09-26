@echo off
rem EigenFlux CLI 便捷入口（全部在本文件夹内，无系统 PATH 依赖）
"%~dp0..\bin\eigenflux.exe" --homedir "%~dp0..\.eigenflux" %*
