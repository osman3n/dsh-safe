' dsh-safe: open the recovery window without a console window.
'
' Double-click this file (or the desktop shortcut that points at it) when
' Harness will not start. The page appears in its own window, not a browser
' tab, and nothing flashes on screen.
'
' dsh-safe writes its own log (%USERPROFILE%\.dsh\safety\ui.log), so this script
' never redirects cmd's output into it: a running instance would hold that handle
' and the next launch would die before node started.

Option Explicit

Dim shell, fso, here, home, logDir, logFile, command, rc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Folder that holds this script, with a trailing backslash.
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
home = shell.ExpandEnvironmentStrings("%USERPROFILE%")
logDir = home & "\.dsh\safety"
logFile = logDir & "\ui.log"

On Error Resume Next
If Not fso.FolderExists(home & "\.dsh") Then fso.CreateFolder home & "\.dsh"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
On Error GoTo 0

command = "cmd /c node """ & here & "dsh-safe.mjs"" open --ui"

' 0 = hidden window, False = do not wait for it to finish.
On Error Resume Next
rc = shell.Run(command, 0, False)
If Err.Number <> 0 Then
  Dim log
  Set log = fso.OpenTextFile(logFile, 8, True)
  log.WriteLine Now & "  [fail] could not start dsh-safe: " & Err.Description
  log.Close
End If
On Error GoTo 0