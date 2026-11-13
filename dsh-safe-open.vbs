' dsh-safe: open the recovery window without a console window.
'
' Double-click this file (or the desktop shortcut that points at it) when
' Harness will not start. The page appears in its own window, not a browser
' tab, and nothing flashes on screen.
'
' Output goes to %USERPROFILE%\.dsh\safety\ui.log so a failure here is still
' readable afterwards.

Option Explicit

Dim shell, fso, here, home, logDir, logFile, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Folder that holds this script, with a trailing backslash.
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
home = shell.ExpandEnvironmentStrings("%USERPROFILE%")
logDir = home & "\.dsh\safety"
logFile = logDir & "\ui.log"

' Make the log folder first: a failed redirect would stop node from starting.
On Error Resume Next
If Not fso.FolderExists(home & "\.dsh") Then fso.CreateFolder home & "\.dsh"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
On Error GoTo 0

command = "cmd /c node """ & here & "dsh-safe.mjs"" open --ui >> """ & logFile & """ 2>&1"

' 0 = hidden window, False = do not wait for it to finish.
shell.Run command, 0, False