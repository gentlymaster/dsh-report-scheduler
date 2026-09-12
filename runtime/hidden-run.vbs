' hidden-run.vbs — 以隐藏窗口方式运行 tick.cmd
' 用途：Windows 任务计划程序每 15 分钟调用本脚本，避免弹出 cmd 控制台窗口。
' wscript.exe 属于 GUI 子系统，自身不创建控制台；Run(..., 0, False) 让子进程窗口不可见。
' 同时把工作目录固定到脚本所在目录，避免无头 agent 的 cwd 落在 C:\Windows\System32。
Dim shell, scriptDir, target
Set shell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
target = scriptDir & "tick.cmd"
shell.CurrentDirectory = scriptDir
shell.Run "cmd.exe /c """ & target & """", 0, False
