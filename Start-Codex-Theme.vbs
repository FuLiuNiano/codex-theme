Option Explicit

Dim shell, fileSystem, scriptDir, powershellPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = """" & powershellPath & """ -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & scriptDir & "\codex-theme-controller.ps1"" -Action Start"
shell.Run command, 0, False

