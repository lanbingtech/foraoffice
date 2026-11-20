param(
  [Parameter(Mandatory)][int]$ProcessId,
  [Parameter(Mandatory)][string]$Handle,
  [Parameter(Mandatory)][string]$StartUtc,
  [switch]$RaiseOwnedWindow
)
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
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
  private delegate bool EnumWindowCallback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll", SetLastError=true, ExactSpelling=true)] private static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);
  [DllImport("user32.dll", SetLastError=true, ExactSpelling=true)] private static extern int GetWindowLongW(IntPtr window, int index);
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
  [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
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
  private sealed class PhysicalPixelScope : IDisposable {
    private readonly IntPtr previous;
    public PhysicalPixelScope() {
      var perMonitorV2 = new IntPtr(-4);
      previous = SetThreadDpiAwarenessContext(perMonitorV2);
      if (previous == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public void Dispose() {
      if (SetThreadDpiAwarenessContext(previous) == IntPtr.Zero ||
          !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), previous))
        throw new InvalidOperationException("Unable to restore the caption helper's DPI context");
    }
  }
  public static Point[] FindPhysicalCaptions(IntPtr window) {
    using (var dpi = new PhysicalPixelScope()) {
      Bounds bounds;
      if (!GetWindowRect(window, out bounds)) throw new InvalidOperationException("Owned window has no rectangle");
      var points = new List<Point>();
      foreach (int vertical in new int[] {12, 18, 26, 34}) {
        foreach (double horizontal in new double[] {.35, .48, .60, .71}) {
          var point = new Point {
            X = bounds.Left + (int)Math.Round((bounds.Right - bounds.Left) * horizontal),
            Y = bounds.Top + vertical
          };
          if (IsCaption(window, point)) points.Add(point);
        }
      }
      return points.ToArray();
    }
  }
  public static ClickReceipt SendOwnedPhysicalTitleClick(IntPtr expected, uint expectedPid, Point target) {
    using (var dpi = new PhysicalPixelScope()) return SendOwnedTitleClick(expected, expectedPid, target);
  }
  public static bool IsTopmost(IntPtr window) {
    const int ExtendedStyle = -20;
    const int TopmostStyle = 0x0008;
    SetLastError(0);
    long style = IntPtr.Size == 8 ? GetWindowLongPtrW(window, ExtendedStyle).ToInt64() : GetWindowLongW(window, ExtendedStyle);
    int error = Marshal.GetLastWin32Error();
    if (style == 0 && error != 0) throw new Win32Exception(error);
    return (style & TopmostStyle) != 0;
  }
  public static void RequireOwnedWindowGroup(IntPtr window, uint processId) {
    const uint RootOwner = 3;
    IntPtr group = GetAncestor(window, RootOwner);
    uint groupPid;
    if (group == IntPtr.Zero || GetWindowThreadProcessId(group, out groupPid) == 0 || groupPid != processId)
      throw new InvalidOperationException("The test window has a foreign native owner");
    bool hasForeignWindow = false;
    if (!EnumWindows((candidate, _) => {
      uint candidatePid;
      if (GetAncestor(candidate, RootOwner) == group &&
          (GetWindowThreadProcessId(candidate, out candidatePid) == 0 || candidatePid != processId))
        hasForeignWindow = true;
      return true;
    }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (hasForeignWindow) throw new InvalidOperationException("The test window group contains a foreign native window");
  }
  public static void RequestRaiseWithinBand(IntPtr window) {
    RequestPosition(window, IntPtr.Zero); // HWND_TOP preserves the current Z-order band.
  }
  private static void RequestPosition(IntPtr window, IntPtr after) {
    const uint NoSize = 0x0001, NoMove = 0x0002, NoActivate = 0x0010, NoOwnerZOrder = 0x0200, AsyncWindowPos = 0x4000;
    if (!SetWindowPos(window, after, 0, 0, 0, 0, NoSize | NoMove | NoActivate | NoOwnerZOrder | AsyncWindowPos))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public sealed class OwnedWindowFamily {
    private const uint RootOwner = 3, Owner = 4;
    private readonly IntPtr root;
    private readonly uint processId;
    private readonly string startUtc;
    private readonly Dictionary<IntPtr, Member> original;
    private sealed class Member {
      public uint Thread;
      public IntPtr OwnerWindow;
      public bool Topmost;
    }
    public OwnedWindowFamily(IntPtr root, uint processId, string startUtc) {
      this.root = root;
      this.processId = processId;
      this.startUtc = startUtc;
      original = ReadFamily();
      if (!AllInBand(original, false))
        throw new InvalidOperationException("The owned test window family is already topmost");
    }
    private void RequireProcess() {
      using (var process = Process.GetProcessById((int)processId)) {
        if (process.HasExited || process.StartTime.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture) != startUtc)
          throw new InvalidOperationException("The test launcher process identity changed");
      }
    }
    private Dictionary<IntPtr, Member> ReadFamily() {
      RequireProcess();
      if (GetAncestor(root, RootOwner) != root)
        throw new InvalidOperationException("The test window is not its native root owner");
      var windows = new List<IntPtr>();
      if (!EnumWindows((candidate, _) => {
        if (GetAncestor(candidate, RootOwner) == root) windows.Add(candidate);
        return true;
      }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var snapshot = new Dictionary<IntPtr, Member>();
      foreach (var window in windows) {
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        if (thread == 0 || pid != processId || GetAncestor(window, RootOwner) != root)
          throw new InvalidOperationException("The test window family contains a foreign or changed native window");
        snapshot.Add(window, new Member { Thread = thread, OwnerWindow = GetWindow(window, Owner), Topmost = IsTopmost(window) });
      }
      if (!snapshot.ContainsKey(root) || snapshot[root].OwnerWindow != IntPtr.Zero)
        throw new InvalidOperationException("The exact native root owner was not observed");
      foreach (var member in snapshot.Values) {
        if (member.OwnerWindow != IntPtr.Zero && !snapshot.ContainsKey(member.OwnerWindow))
          throw new InvalidOperationException("The test window family has an unverified native owner");
      }
      RequireProcess();
      return snapshot;
    }
    private Dictionary<IntPtr, Member> RequireUnchangedFamily() {
      var current = ReadFamily();
      if (current.Count != original.Count)
        throw new InvalidOperationException("The test window family membership changed");
      foreach (var pair in original) {
        Member observed;
        if (!current.TryGetValue(pair.Key, out observed) || observed.Thread != pair.Value.Thread || observed.OwnerWindow != pair.Value.OwnerWindow)
          throw new InvalidOperationException("The test window family identity changed");
      }
      return current;
    }
    private static bool AllInBand(Dictionary<IntPtr, Member> windows, bool topmost) {
      foreach (var item in windows.Values) if (item.Topmost != topmost) return false;
      return true;
    }
    public int Count { get { return original.Count; } }
    public bool InBand(bool topmost) {
      return AllInBand(RequireUnchangedFamily(), topmost);
    }
    public void RequestBand(bool topmost) {
      var current = RequireUnchangedFamily();
      if (topmost && !AllInBand(current, false))
        throw new InvalidOperationException("The test window family left the original band before promotion");
      // HWND_TOPMOST and HWND_NOTOPMOST propagate through the verified owner family.
      RequestPosition(root, new IntPtr(topmost ? -1 : -2));
    }
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
function Assert-OwnedWindow([switch]$RequireVisible) {
  [uint32]$observedOwner=0
  $observedThread=[GuardedTitleClick]::GetWindowThreadProcessId($window,[ref]$observedOwner)
  $target.Refresh()
  if ($thread -eq 0 -or $observedThread -ne $thread -or $observedOwner -ne $ProcessId -or
      $target.HasExited -or $target.StartTime.ToUniversalTime().ToString('o') -cne $StartUtc -or
      [GuardedTitleClick]::GetAncestor($window,2) -ne $window) {
    throw 'Exact foreground candidate is not the owned test window'
  }
  if ($RequireVisible -and (![GuardedTitleClick]::IsWindowVisible($window) -or [GuardedTitleClick]::IsIconic($window))) {
    throw 'Owned test window is not visible'
  }
}
function Find-OwnedCaption {
  if ($RaiseOwnedWindow) {return [GuardedTitleClick]::FindPhysicalCaptions($window)}
  $rect=[GuardedTitleClick+Bounds]::new()
  if(![GuardedTitleClick]::GetWindowRect($window,[ref]$rect)){throw 'Owned window has no rectangle'}
  foreach($vertical in @(12,18,26)) {
    foreach($horizontal in @(.35,.48,.60,.71)) {
      $pt=[GuardedTitleClick+Point]::new()
      $pt.X=$rect.Left+[int](($rect.Right-$rect.Left)*$horizontal)
      $pt.Y=$rect.Top+$vertical
      if([GuardedTitleClick]::IsCaption($window,$pt)){$pt}
    }
  }
}
function Confirm-FamilyBand($Family,[bool]$Topmost) {
  $timer=[System.Diagnostics.Stopwatch]::StartNew()
  do {
    if ($Family.InBand($Topmost)) {return}
    Start-Sleep -Milliseconds 20
  } while ($timer.ElapsedMilliseconds -lt 2000)
  throw 'Native test window family layer change was not observed'
}
Assert-OwnedWindow -RequireVisible
$before=[GuardedTitleClick]::GetForegroundWindow() -eq $window
$submitted=0
$cursor='not moved'
$originalTopmost=$null
$observedTopmost=$null
$raiseRequested=$false
$family=$null
$promotionRequested=$false
$familyRestored=$false
$owned=@(Find-OwnedCaption)
try {
  if ($RaiseOwnedWindow -and !$before -and !$owned.Count -and ![GuardedTitleClick]::Held()) {
    Assert-OwnedWindow -RequireVisible
    $originalTopmost=[GuardedTitleClick]::IsTopmost($window)
    if (!$originalTopmost) {
      [GuardedTitleClick]::RequireOwnedWindowGroup($window,[uint32]$ProcessId)
      Assert-OwnedWindow -RequireVisible
      if ([GuardedTitleClick]::IsTopmost($window) -or [GuardedTitleClick]::Held()) {
        throw 'Owned test window or input state changed before the raise'
      }
      [GuardedTitleClick]::RequestRaiseWithinBand($window)
      $raiseRequested=$true
      $timer=[System.Diagnostics.Stopwatch]::StartNew()
      do {
        Assert-OwnedWindow -RequireVisible
        if ([GuardedTitleClick]::IsTopmost($window) -ne $originalTopmost) {
          throw 'Owned test window left its original Z-order band'
        }
        $owned=@(Find-OwnedCaption)
        if ($owned.Count -or [GuardedTitleClick]::Held()) {break}
        Start-Sleep -Milliseconds 20
      } while ($timer.ElapsedMilliseconds -lt 2000)
      if (!$owned.Count -and ![GuardedTitleClick]::Held() -and [GuardedTitleClick]::GetForegroundWindow() -ne $window) {
        Assert-OwnedWindow -RequireVisible
        $family=[GuardedTitleClick+OwnedWindowFamily]::new($window,[uint32]$ProcessId,$StartUtc)
        $family.RequestBand($true)
        $promotionRequested=$true
        Confirm-FamilyBand $family $true
        $owned=@(Find-OwnedCaption)
      }
    }
  }
  if (!$before -and $owned.Count -and [GuardedTitleClick]::GetForegroundWindow() -ne $window) {
    Assert-OwnedWindow -RequireVisible
    if ($promotionRequested) {
      if (!$family.InBand($true)) {throw 'Owned test window family changed band before the caption click'}
    } elseif ($raiseRequested -and [GuardedTitleClick]::IsTopmost($window) -ne $originalTopmost) {
      throw 'Owned test window left its original Z-order band'
    }
    $click=if ($RaiseOwnedWindow) {
      [GuardedTitleClick]::SendOwnedPhysicalTitleClick($window,[uint32]$ProcessId,$owned[0])
    } else {
      [GuardedTitleClick]::SendOwnedTitleClick($window,[uint32]$ProcessId,$owned[0])
    }
    $submitted=$click.Submitted
    $cursor=$click.Cursor
    Start-Sleep -Milliseconds 160
  }
} finally {
  if ($promotionRequested) {
    Assert-OwnedWindow
    # Undo the queued promotion even if its confirmation failed.
    $family.RequestBand($false)
    Confirm-FamilyBand $family $false
    $familyRestored=$true
  }
  if ($null -ne $originalTopmost) {
    Assert-OwnedWindow
    $observedTopmost=[GuardedTitleClick]::IsTopmost($window)
    if ($observedTopmost -ne $originalTopmost) {throw 'Owned test window left its original Z-order band'}
  }
}
@{ownedBefore=$before;ownedAfter=[GuardedTitleClick]::GetForegroundWindow() -eq $window;safeTitlePoints=$owned.Count;submittedInputs=$submitted;cursor=$cursor;heldInput=[GuardedTitleClick]::Held();physicalPixelProbe=[bool]$RaiseOwnedWindow;raiseRequested=$raiseRequested;originalTopmost=$originalTopmost;observedTopmost=$observedTopmost;promotionRequested=$promotionRequested;promotedFamilySize=if($family){$family.Count}else{0};familyRestored=$familyRestored}|ConvertTo-Json -Compress
