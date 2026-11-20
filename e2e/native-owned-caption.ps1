param([Parameter(Mandatory)][int]$ProcessId,[Parameter(Mandatory)][string]$Handle,[Parameter(Mandatory)][string]$StartUtc)
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GuardedTitleClick {
  [StructLayout(LayoutKind.Sequential)] public struct Bounds { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Mouse mouse; }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w,out Bounds b);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr w,uint flag);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll",SetLastError=true,ExactSpelling=true)]
  private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wParam,
      IntPtr lParam, uint flags, uint milliseconds, out UIntPtr result);
  public static bool IsCaption(IntPtr window, Point point) {
    if (GetAncestor(WindowFromPoint(point),2)!=window) return false;
    uint packed = (uint)(ushort)point.X | ((uint)(ushort)point.Y << 16);
    UIntPtr result;
    return SendMessageTimeoutW(window,0x84,UIntPtr.Zero,new IntPtr(unchecked((int)packed)),2,200,out result)!=IntPtr.Zero
        && result.ToUInt64()==2;
  }
  public static bool Held() {
    foreach(int k in new int[]{1,2,4,16,17,18,91,92}) if((GetAsyncKeyState(k)&0x8000)!=0) return true;
    return false;
  }
  public sealed class ClickReceipt {
    public uint Submitted { get; set; }
    public string Cursor { get; set; }
  }
  public static ClickReceipt SendOwnedTitleClick(IntPtr expected, uint expectedPid, Point target) {
    var result = new ClickReceipt { Cursor = "not moved" };
    if (Held() || !IsCaption(expected,target)) return result;
    Point previous;
    if (!GetCursorPos(out previous) || !SetCursorPos(target.X,target.Y)) return result;
    try {
      Point actual;
      if (!GetCursorPos(out actual) || actual.X!=target.X || actual.Y!=target.Y || !IsCaption(expected,actual))
        return result;
      uint owner;
      if (GetWindowThreadProcessId(expected,out owner)==0 || owner!=expectedPid) return result;
      Input[] events = new Input[2];
      events[0].mouse.flags = 2;
      events[1].mouse.flags = 4;
      // The caption query crosses a thread boundary. Check the current pointer
      // and held input again at the point of submission.
      if (!GetCursorPos(out actual) || actual.X!=target.X || actual.Y!=target.Y
          || GetAncestor(WindowFromPoint(actual),2)!=expected || Held()
          || !GetCursorPos(out actual) || actual.X!=target.X || actual.Y!=target.Y) return result;
      result.Submitted=SendInput(2,events,Marshal.SizeOf(typeof(Input)));
      if (result.Submitted==1) {
        // Release our own partial synthetic button-down. An up-only event
        // cannot initiate another click and no second down is submitted.
        var release=new Input[]{events[1]};
        if (SendInput(1,release,Marshal.SizeOf(typeof(Input)))!=1)
          throw new InvalidOperationException("Windows rejected release of a partially injected button");
        throw new InvalidOperationException("Windows inserted only a button-down; it was released");
      }
      return result;
    } finally {
      Point current;
      if (!GetCursorPos(out current)) throw new InvalidOperationException("Unable to verify cursor placement");
      if (current.X==target.X && current.Y==target.Y) {
        if (!SetCursorPos(previous.X,previous.Y)
            || !GetCursorPos(out current) || current.X!=previous.X || current.Y!=previous.Y)
          throw new InvalidOperationException("Unable to restore the original cursor position");
        result.Cursor="restored";
      } else {
        result.Cursor="position already changed by other input";
      }
    }
  }
}
"@
$target=Get-Process -Id $ProcessId -ErrorAction Stop
$window=[IntPtr]::new([long]$Handle)
[uint32]$owner=0
$thread=[GuardedTitleClick]::GetWindowThreadProcessId($window,[ref]$owner)
if($owner -ne $target.Id -or $thread -eq 0 -or $target.StartTime.ToUniversalTime().ToString('o') -cne $StartUtc -or ![GuardedTitleClick]::IsWindowVisible($window) -or [GuardedTitleClick]::IsIconic($window)) {throw 'Exact foreground candidate is not the visible owned test window'}
$rect=[GuardedTitleClick+Bounds]::new()
if(![GuardedTitleClick]::GetWindowRect($window,[ref]$rect)){throw 'Owned window has no rectangle'}
$owned=@()
foreach($vertical in @(12,18,26)) {
  foreach($horizontal in @(.35,.48,.60,.71)) {
    $pt=[GuardedTitleClick+Point]::new()
    $pt.X=$rect.Left+[int](($rect.Right-$rect.Left)*$horizontal)
    $pt.Y=$rect.Top+$vertical
    if([GuardedTitleClick]::IsCaption($window,$pt)){$owned+= $pt}
  }
}
$before=[GuardedTitleClick]::GetForegroundWindow() -eq $window
$submitted=0
$cursor='not moved'
if(!$before -and $owned.Count){
  $click=[GuardedTitleClick]::SendOwnedTitleClick($window,[uint32]$target.Id,$owned[0])
  $submitted=$click.Submitted
  $cursor=$click.Cursor
  Start-Sleep -Milliseconds 160
}
@{ownedBefore=$before;ownedAfter=[GuardedTitleClick]::GetForegroundWindow() -eq $window;safeTitlePoints=$owned.Count;submittedInputs=$submitted;cursor=$cursor;heldInput=[GuardedTitleClick]::Held()}|ConvertTo-Json -Compress
