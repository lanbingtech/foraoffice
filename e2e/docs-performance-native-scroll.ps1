param([Parameter(Mandatory)][string]$Request)

$ErrorActionPreference = 'Stop'
$command = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)))
$windowProcess = Get-Process -Id $command.owner.targetProcessId
if ($windowProcess.StartTime.ToUniversalTime().ToString('o') -cne $command.owner.processStartTime) {
  throw 'Native benchmark process identity changed'
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;

public static class DocsPerformanceInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct GuiThreadInfo {
    public uint Size, Flags;
    public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
    public Rect CaretRect;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MouseInput {
    public int X, Y;
    public uint Data, Flags, Time;
    public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KeyInput {
    public ushort Key, Scan;
    public uint Flags, Time;
    public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Explicit)]
  struct InputData {
    [FieldOffset(0)] public MouseInput Mouse;
    [FieldOffset(0)] public KeyInput Key;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Input {
    public uint Type;
    public InputData Data;
  }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flag);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, Input[] input, int size);

  public static void CheckForeground(long handle, uint expectedPid) {
    IntPtr hwnd = new IntPtr(handle);
    uint actualPid;
    if (GetWindowThreadProcessId(hwnd, out actualPid) == 0 ||
        actualPid != expectedPid || GetForegroundWindow() != hwnd)
      throw new InvalidOperationException("The benchmark window does not own foreground");
  }

  static bool IdleInput() {
    for (int key = 1; key < 0xFF; key++) {
      if ((GetAsyncKeyState(key) & 0x8000) != 0) return false;
    }
    return true;
  }

  public static void RequireIdleInput() {
    if (!IdleInput()) throw new InvalidOperationException("A mouse button or key is held");
  }

  static Rect Client(long handle, uint ownerPid) {
    CheckForeground(handle, ownerPid);
    Rect rect;
    if (!GetClientRect(new IntPtr(handle), out rect))
      throw new InvalidOperationException("The benchmark client rectangle is unavailable");
    return rect;
  }

  static Point OwnedPoint(long handle, uint ownerPid, int x, int y) {
    Rect rect = Client(handle, ownerPid);
    IntPtr hwnd = new IntPtr(handle);
    Point point = new Point { X = x, Y = y };
    if (x < 0 || x >= rect.Right || y < 0 || y >= rect.Bottom ||
        !ClientToScreen(hwnd, ref point) || GetAncestor(WindowFromPoint(point), 2) != hwnd)
      throw new InvalidOperationException("The input target is outside the unobstructed benchmark window");
    return point;
  }

  static Point Cursor() {
    Point point;
    if (!GetCursorPos(out point)) throw new InvalidOperationException("Cursor position is unavailable");
    return point;
  }

  static bool Same(Point first, Point second) { return first.X == second.X && first.Y == second.Y; }

  static void Move(long handle, uint ownerPid, Point target, ref Point last) {
    CheckForeground(handle, ownerPid);
    if (!Same(Cursor(), last) || GetAncestor(WindowFromPoint(target), 2) != new IntPtr(handle))
      throw new InvalidOperationException("Cursor moved externally or target is obstructed");
    if (!SetCursorPos(target.X, target.Y)) throw new InvalidOperationException("Pointer positioning failed");
    last = target;
  }

  static void RestoreCursor(long handle, Point original, Point last) {
    if (Same(original, last) || GetForegroundWindow() != new IntPtr(handle) || !Same(Cursor(), last) ||
        GetAncestor(WindowFromPoint(last), 2) != new IntPtr(handle) || !IdleInput()) return;
    if (!SetCursorPos(original.X, original.Y)) throw new InvalidOperationException("Cursor restoration failed");
  }

  public static Point Calibrate(long handle, uint ownerPid, double fraction) {
    Rect rect = Client(handle, ownerPid);
    var client = new Point { X = (int)(rect.Right * fraction), Y = (int)(rect.Bottom * fraction) };
    Point target = OwnedPoint(handle, ownerPid, client.X, client.Y);
    Point original = Cursor(), last = original;
    RequireIdleInput();
    try {
      Move(handle, ownerPid, target, ref last);
      Thread.Sleep(120);
      return client;
    } finally { RestoreCursor(handle, original, last); }
  }

  static string Stamp() { return Stopwatch.GetTimestamp().ToString(); }
  public static string Frequency() { return Stopwatch.Frequency.ToString(); }

  static void Submit(Input input) {
    if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
      throw new InvalidOperationException("Windows rejected benchmark input: " + Marshal.GetLastWin32Error());
  }

  public static string PressReturn(long handle, uint ownerPid) {
    RequireIdleInput();
    CheckForeground(handle, ownerPid);
    var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
    uint focusedPid;
    if (!GetGUIThreadInfo(0, ref info) || info.Focus == IntPtr.Zero ||
        GetAncestor(info.Focus, 2) != new IntPtr(handle) ||
        GetWindowThreadProcessId(info.Focus, out focusedPid) == 0 || focusedPid != ownerPid)
      throw new InvalidOperationException("The benchmark window does not own keyboard focus");
    var down = new Input { Type = 1 };
    down.Data.Key.Key = 0x0D;
    var up = down;
    up.Data.Key.Flags = 2;
    CheckForeground(handle, ownerPid);
    string started = Stamp();
    uint inserted = SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(Input)));
    if (inserted != 2) {
      int error = Marshal.GetLastWin32Error();
      if (inserted == 1) Release(up);
      throw new InvalidOperationException("Windows inserted " + inserted + " of 2 Enter events: " + error);
    }
    CheckForeground(handle, ownerPid);
    return started;
  }

  static void Release(Input up) {
    for (int attempt = 0; attempt < 3; attempt++) {
      if (SendInput(1, new[] { up }, Marshal.SizeOf(typeof(Input))) == 1) return;
      Thread.Sleep(10);
    }
    throw new InvalidOperationException("Windows rejected benchmark input release: " + Marshal.GetLastWin32Error());
  }

  public static string[] Drag(long handle, uint ownerPid, int x, int y, int[] waypoints,
                              int[] steps, int[] intervals) {
    if (waypoints.Length < 1 || waypoints.Length > 3 || steps.Length != waypoints.Length ||
        intervals.Length != waypoints.Length) throw new InvalidOperationException("Invalid drag plan");
    for (int leg = 0; leg < steps.Length; leg++)
      if (steps[leg] < 1 || steps[leg] > 20 || intervals[leg] < 1 || intervals[leg] > 24)
        throw new InvalidOperationException("Invalid drag timing");
    Point original = Cursor(), last = original;
    Point start = OwnedPoint(handle, ownerPid, x, y);
    var down = new Input();
    down.Data.Mouse.Flags = 2;
    var up = new Input();
    up.Data.Mouse.Flags = 4;
    string[] stamps = new string[2 + waypoints.Length];
    bool downInserted = false, released = false;
    try {
      RequireIdleInput();
      Move(handle, ownerPid, start, ref last);
      Thread.Sleep(45);
      RequireIdleInput();
      CheckForeground(handle, ownerPid);
      if (!Same(Cursor(), start) || GetAncestor(WindowFromPoint(start), 2) != new IntPtr(handle))
        throw new InvalidOperationException("Scrollbar target lost before mouse down");
      stamps[0] = Stamp();
      Submit(down);
      downInserted = true;
      var elapsed = Stopwatch.StartNew();
      for (int leg = 0; leg < waypoints.Length; leg++) {
        int destination = waypoints[leg];
        for (int step = 1; step <= steps[leg]; step++) {
          if (elapsed.ElapsedMilliseconds > 2500) throw new TimeoutException("Mouse drag expired");
          Point target = OwnedPoint(handle, ownerPid, x, y + (destination - y) * step / steps[leg]);
          Move(handle, ownerPid, target, ref last);
          Thread.Sleep(intervals[leg]);
        }
        stamps[leg + 1] = Stamp();
        y = destination;
      }
    } finally {
      try {
        if (downInserted) {
          stamps[stamps.Length - 1] = Stamp();
          Release(up);
        }
        released = true;
      } finally {
        if (released) RestoreCursor(handle, original, last);
      }
    }
    CheckForeground(handle, ownerPid);
    return stamps;
  }

  public static bool SetPerMonitorDpi() {
    return SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero;
  }
}
'@

if (-not [DocsPerformanceInput]::SetPerMonitorDpi()) { throw 'Per-monitor DPI coordinates unavailable' }
$handle = [long]$command.owner.windowHandle
$ownerPid = [uint32]$command.owner.targetProcessId
[DocsPerformanceInput]::RequireIdleInput()
$receipt = @{ action = $command.action; utcBefore = [DateTime]::UtcNow.ToString('o') }
switch ($command.action) {
  'calibrate' {
    $point = [DocsPerformanceInput]::Calibrate($handle, $ownerPid, $command.fraction)
    $receipt.position = @{ x = $point.X; y = $point.Y }
  }
  'drag' {
    $receipt.qpc = [DocsPerformanceInput]::Drag($handle, $ownerPid, $command.x, $command.y,
      [int[]]$command.segments.y, [int[]]$command.segments.steps, [int[]]$command.segments.pauseMs)
  }
  'submit' { $receipt.qpc = @([DocsPerformanceInput]::PressReturn($handle, $ownerPid)) }
  default { throw 'Unknown native benchmark input action' }
}
$receipt.utcAfter = [DateTime]::UtcNow.ToString('o')
$receipt.qpcFrequency = [DocsPerformanceInput]::Frequency()
$receipt | ConvertTo-Json -Compress
