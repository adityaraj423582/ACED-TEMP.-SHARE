' Double-click to start Aced.
'
' No console window, no taskbar button, nothing on screen but the overlay itself.
' Works from wherever you cloned the repo - the path is resolved from this script's
' own location, so nothing needs editing after a clone.
'
' To stop Aced: Ctrl+Shift+Q (quit) or Ctrl+D (instant kill).

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

repoRoot = fso.GetParentFolderName(WScript.ScriptFullName)
desktopApp = fso.BuildPath(repoRoot, "apps\desktop")

If Not fso.FolderExists(desktopApp) Then
  MsgBox "Cannot find apps\desktop next to this script." & vbCrLf & vbCrLf & _
         "Keep 'Start Aced.vbs' in the repository root.", 16, "Aced"
  WScript.Quit 1
End If

' The build output must exist, otherwise Electron starts and immediately dies with a
' blank error. Checking here turns that into a message that says what to actually do.
If Not fso.FileExists(fso.BuildPath(desktopApp, "dist\main.js")) Then
  MsgBox "Aced has not been built yet." & vbCrLf & vbCrLf & _
         "Open a terminal in the project folder and run:" & vbCrLf & _
         "    pnpm install" & vbCrLf & _
         "    pnpm build", 48, "Aced"
  WScript.Quit 1
End If

sh.CurrentDirectory = desktopApp
' 0 = hidden window, False = do not wait, so this script exits immediately.
sh.Run "cmd /c pnpm start", 0, False
