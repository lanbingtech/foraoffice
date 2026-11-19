param([Parameter(Mandatory = $true)][string]$RequestBase64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
  if ($request.targetProcessId -le 0) { throw 'A positive owned process ID is required' }
  $target = Get-Process -Id $request.targetProcessId -ErrorAction Stop
  $window = $target.MainWindowHandle
  if ($window -eq [IntPtr]::Zero) { throw 'The owned process has no visible main window' }
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DocsNativeIme {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUI {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public RECT caretRect;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEY {
    public ushort virtualKey, scan;
    public uint flags, time;
    public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSE {
    public int x, y;
    public uint data, flags, time;
    public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] public struct UNION {
    [FieldOffset(0)] public KEY key;
    [FieldOffset(0)] public MOUSE mouse;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  public delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetGUIThreadInfo(uint thread, ref GUI info);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, [Out] IntPtr[] layouts);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern short GetKeyState(int key);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyExW(uint key, uint map, IntPtr layout);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT bounds);
  [DllImport("imm32.dll", CharSet=CharSet.Unicode)] public static extern uint ImmGetDescriptionW(IntPtr layout, StringBuilder text, uint count);
  [DllImport("imm32.dll", CharSet=CharSet.Unicode)] public static extern uint ImmGetIMEFileNameW(IntPtr layout, StringBuilder text, uint count);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr window);
  [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr window, IntPtr context);
  [DllImport("imm32.dll")] public static extern bool ImmGetOpenStatus(IntPtr context);
  [DllImport("imm32.dll")] public static extern bool ImmGetConversionStatus(IntPtr context, out uint conversion, out uint sentence);
  public static INPUT ScanKey(ushort scan, uint flags) {
    var input = new INPUT();
    input.type = 1;
    input.data.key.scan = scan;
    input.data.key.flags = flags;
    return input;
  }
  public static IntPtr[] VisibleWindows(uint process) {
    var windows = new List<IntPtr>();
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == process && IsWindowVisible(window)) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
  function Get-WindowOwner([IntPtr]$handle) {
    if ($handle -eq [IntPtr]::Zero -or -not [DocsNativeIme]::IsWindow($handle)) { return $null }
    [uint32]$ownerId = 0
    $thread = [DocsNativeIme]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    $owner = Get-Process -Id $ownerId -ErrorAction Stop
    return @{
      targetProcessId = [int]$ownerId
      windowHandle = $handle.ToInt64().ToString()
      processStartTime = $owner.StartTime.ToUniversalTime().ToString('o')
      threadId = $thread
    }
  }
  function Get-Profile([IntPtr]$layout) {
    $description = [Text.StringBuilder]::new(512)
    $file = [Text.StringBuilder]::new(1024)
    [void][DocsNativeIme]::ImmGetDescriptionW($layout, $description, $description.Capacity)
    [void][DocsNativeIme]::ImmGetIMEFileNameW($layout, $file, $file.Capacity)
    return @{
      keyboardLayout = $layout.ToInt64().ToString()
      languageId = [int]($layout.ToInt64() -band 0xffff)
      imeDescription = $description.ToString()
      imeFile = $file.ToString()
    }
  }
  $owned = Get-WindowOwner $window
  if ($owned.targetProcessId -ne $request.targetProcessId -or
      -not [DocsNativeIme]::IsWindowVisible($window) -or [DocsNativeIme]::IsIconic($window)) {
    throw 'The owned process has no visible main window'
  }
  if ($request.action -ne 'inspect' -and
      ($request.windowHandle -cne $owned.windowHandle -or
       $request.processStartTime -cne $owned.processStartTime)) {
    throw 'The owned window or process identity changed'
  }
  function Get-Snapshot {
    $gui = [DocsNativeIme+GUI]::new()
    $gui.size = [Runtime.InteropServices.Marshal]::SizeOf($gui)
    if (-not [DocsNativeIme]::GetGUIThreadInfo($owned.threadId, [ref]$gui)) {
      throw 'The owned GUI thread could not be inspected'
    }
    $profile = Get-Profile ([DocsNativeIme]::GetKeyboardLayout($owned.threadId))
    $profile.open = $null
    $profile.nativeMode = $null
    $context = [DocsNativeIme]::ImmGetContext($gui.focus)
    if ($context -ne [IntPtr]::Zero) {
      try {
        $profile.open = [DocsNativeIme]::ImmGetOpenStatus($context)
        [uint32]$conversion = 0
        [uint32]$sentence = 0
        if ([DocsNativeIme]::ImmGetConversionStatus($context, [ref]$conversion, [ref]$sentence)) {
          $profile.nativeMode = ($conversion -band 1) -ne 0
        }
      } finally {
        if (-not [DocsNativeIme]::ImmReleaseContext($gui.focus, $context)) {
          throw 'The observed IME context could not be released'
        }
      }
    }
    $foreground = [DocsNativeIme]::GetAncestor([DocsNativeIme]::GetForegroundWindow(), 2)
    return @{
      owner = $owned
      foreground = Get-WindowOwner $foreground
      focusedWindowHandle = $gui.focus.ToInt64().ToString()
      foregroundOwned = $foreground -eq $window
      focusOwned = $gui.focus -ne [IntPtr]::Zero -and [DocsNativeIme]::GetAncestor($gui.focus, 2) -eq $window
      profile = $profile
      observedUtc = [DateTime]::UtcNow.ToString('o')
    }
  }
  function Assert-Focus {
    $snapshot = Get-Snapshot
    if (-not $snapshot.foregroundOwned -or -not $snapshot.focusOwned) {
      throw 'The owned editor window is not foreground and focused; no keys were submitted'
    }
    return $snapshot
  }
  function Request-Layout([string]$keyboardLayout) {
    $layout = [IntPtr]::new([long]$keyboardLayout)
    $count = [DocsNativeIme]::GetKeyboardLayoutList(0, $null)
    if ($count -le 0) { throw 'The loaded input locales could not be enumerated' }
    $layouts = [IntPtr[]]::new($count)
    if ([DocsNativeIme]::GetKeyboardLayoutList($count, $layouts) -ne $count -or $layout -notin $layouts) {
      throw 'The requested input locale is not already loaded'
    }
    $gui = [DocsNativeIme+GUI]::new()
    $gui.size = [Runtime.InteropServices.Marshal]::SizeOf($gui)
    if (-not [DocsNativeIme]::GetGUIThreadInfo($owned.threadId, [ref]$gui) -or
        $gui.focus -eq [IntPtr]::Zero -or [DocsNativeIme]::GetAncestor($gui.focus, 2) -ne $window) {
      throw 'The owned focused child window is no longer available'
    }
    if (-not [DocsNativeIme]::PostMessageW($gui.focus, 0x0050, [UIntPtr]::Zero, $layout)) {
      throw 'The owned window did not accept the input-language request'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
      $observed = Get-Snapshot
      if ($observed.profile.keyboardLayout -ceq $keyboardLayout) { return $observed }
      Start-Sleep -Milliseconds 20
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The requested input locale was not observed on the owned thread'
  }
  function Assert-Input {
    $snapshot = Assert-Focus
    if ($snapshot.profile.keyboardLayout -cne $request.keyboardLayout -or
        [string]::IsNullOrWhiteSpace($request.imeDescription) -or
        $snapshot.profile.imeDescription -cne $request.imeDescription) {
      throw 'The observed input profile changed or is unavailable; no keys were submitted'
    }
    if ($snapshot.profile.languageId -ne 0x0804 -or
        $snapshot.profile.open -ne $true -or $snapshot.profile.nativeMode -ne $true) {
      throw 'Chinese conversion mode is not confirmed; no keys were submitted'
    }
    foreach ($key in @(0x10, 0x11, 0x12, 0x5b, 0x5c)) {
      if (([int][DocsNativeIme]::GetAsyncKeyState($key) -band 0x8000) -ne 0) {
        throw 'A physical modifier is held; no keys were submitted'
      }
    }
    if (([int][DocsNativeIme]::GetKeyState(0x14) -band 1) -ne 0) {
      throw 'Caps Lock is enabled; no keys were submitted'
    }
    return $snapshot
  }
  $before = Get-Snapshot
  $result = @{ action = $request.action; channel = 'win32-window-inspection'; before = $before }
  switch ($request.action) {
    'inspect' {
      $count = [DocsNativeIme]::GetKeyboardLayoutList(0, $null)
      if ($count -le 0) { throw 'The loaded input locales could not be enumerated' }
      $layouts = [IntPtr[]]::new($count)
      $copied = [DocsNativeIme]::GetKeyboardLayoutList($count, $layouts)
      if ($copied -ne $count) { throw 'The loaded input locale list changed during inspection' }
      $result.loadedProfiles = @($layouts | ForEach-Object { Get-Profile $_ })
      if ($request.includeCandidates) {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $candidateWindows = @()
        $candidateErrors = @()
        foreach ($imeProcess in @(Get-Process -Name ChsIME, TextInputHost -ErrorAction SilentlyContinue)) {
          try {
            $image = $imeProcess.Path
            if (-not $image.StartsWith([Environment]::GetFolderPath('Windows') + '\', [StringComparison]::OrdinalIgnoreCase) -or
                [Diagnostics.FileVersionInfo]::GetVersionInfo($image).CompanyName -ne 'Microsoft Corporation') {
              throw 'The candidate UI process does not have the expected Microsoft Windows identity'
            }
            foreach ($candidateWindow in [DocsNativeIme]::VisibleWindows($imeProcess.Id)) {
              $class = [Text.StringBuilder]::new(256)
              [void][DocsNativeIme]::GetClassNameW($candidateWindow, $class, $class.Capacity)
              $bounds = [DocsNativeIme+RECT]::new()
              if (-not [DocsNativeIme]::GetWindowRect($candidateWindow, [ref]$bounds)) {
                throw 'The native candidate UI bounds could not be read'
              }
              $element = [System.Windows.Automation.AutomationElement]::FromHandle($candidateWindow)
              $children = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
              $names = @($element.Current.Name)
              for ($child = 0; $child -lt [Math]::Min($children.Count, 500); $child++) {
                $name = $children[$child].Current.Name
                if ($name) { $names += $name }
              }
              $candidateWindows += @{
                processId = $imeProcess.Id; image = $image
                windowHandle = $candidateWindow.ToInt64().ToString(); windowClass = $class.ToString()
                left = $bounds.left; top = $bounds.top; right = $bounds.right; bottom = $bounds.bottom
                names = $names; truncated = $children.Count -gt 500
              }
            }
          } catch { $candidateErrors += $_.Exception.Message }
        }
        $result.candidateInspection = @{ windows = $candidateWindows; errors = $candidateErrors }
      }
    }
    'focus' {
      $result.channel = 'win32-window-state'
      if (-not $before.foregroundOwned -and -not [DocsNativeIme]::SetForegroundWindow($window)) {
        throw 'Windows refused foreground activation of the owned window'
      }
      $result.after = Assert-Focus
    }
    'select-language' {
      $result.channel = 'win32-input-language-request'
      [void](Assert-Focus)
      $layout = [IntPtr]::new([long]$request.keyboardLayout)
      $profile = Get-Profile $layout
      if ([string]::IsNullOrWhiteSpace($request.imeDescription) -or
          $profile.imeDescription -cne $request.imeDescription) {
        throw 'The requested input profile could not be confirmed'
      }
      $observed = Request-Layout $request.keyboardLayout
      [void](Assert-Focus)
      if ($observed.profile.keyboardLayout -cne $request.keyboardLayout -or
          $observed.profile.imeDescription -cne $request.imeDescription) {
        throw 'The requested input profile was not observed on the owned thread'
      }
      $result.after = $observed
    }
    'restore' {
      $result.channel = 'win32-window-state'
      $result.after = Request-Layout $request.keyboardLayout
      $previous = $request.previousForeground
      if ($previous) {
        $previousWindow = [IntPtr]::new([long]$previous.windowHandle)
        $currentOwner = Get-WindowOwner $previousWindow
        if ($null -eq $currentOwner -or $currentOwner.targetProcessId -ne $previous.targetProcessId -or
            $currentOwner.processStartTime -cne $previous.processStartTime) {
          throw 'The previous foreground window identity changed; it was not activated'
        }
        if ([DocsNativeIme]::GetAncestor([DocsNativeIme]::GetForegroundWindow(), 2) -ne $window) {
          $result.foregroundRestored = $false
        } elseif (-not [DocsNativeIme]::SetForegroundWindow($previousWindow)) {
          throw 'Windows refused restoration of the previous foreground window'
        } else {
          $result.foregroundRestored = [DocsNativeIme]::GetForegroundWindow() -eq $previousWindow
          if (-not $result.foregroundRestored) { throw 'The previous foreground window was not observed' }
        }
      } else { $result.foregroundRestored = $false }
    }
    { $_ -in @('type', 'commit', 'cancel') } {
      $result.channel = 'win32-sendinput-scancode'
      $inputState = Assert-Input
      if ($request.action -eq 'type') {
        if ($request.text -cnotmatch '^[a-z]{1,64}$') { throw 'Only lowercase phonetic keys are allowed' }
        $keys = @($request.text.ToUpperInvariant().ToCharArray() | ForEach-Object { [uint32][char]$_ })
      } else { $keys = if ($request.action -eq 'commit') { @(0x20) } else { @(0x1b) } }
      $events = [DocsNativeIme+INPUT[]]::new($keys.Count * 2)
      $layout = [IntPtr]::new([long]$inputState.profile.keyboardLayout)
      for ($index = 0; $index -lt $keys.Count; $index++) {
        if (([int][DocsNativeIme]::GetAsyncKeyState($keys[$index]) -band 0x8000) -ne 0) {
          throw 'A requested physical key is already held; no keys were submitted'
        }
        $scan = [DocsNativeIme]::MapVirtualKeyExW($keys[$index], 4, $layout)
        if ($scan -eq 0) { throw 'A phonetic key has no scan-code mapping' }
        for ($release = 0; $release -lt 2; $release++) {
          $flags = [uint32](8 -bor ($release * 2) -bor $(if (($scan -band 0xff00) -ne 0) { 1 } else { 0 }))
          $events[$index * 2 + $release] = [DocsNativeIme]::ScanKey([uint16]($scan -band 0xff), $flags)
        }
      }
      [void](Assert-Input)
      $result.submission = @{
        requestedEvents = $events.Length
        utcBefore = [DateTime]::UtcNow.ToString('o')
        qpcBefore = [Diagnostics.Stopwatch]::GetTimestamp().ToString()
        qpcFrequency = [Diagnostics.Stopwatch]::Frequency.ToString()
      }
      $inserted = [DocsNativeIme]::SendInput($events.Length, $events, [Runtime.InteropServices.Marshal]::SizeOf([DocsNativeIme+INPUT]::new()))
      $result.submission.win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $result.submission.qpcAfter = [Diagnostics.Stopwatch]::GetTimestamp().ToString()
      $result.submission.utcAfter = [DateTime]::UtcNow.ToString('o')
      $result.submission.insertedEvents = $inserted
      if ($inserted -ne $events.Length) {
        $recovery = ''
        if (($inserted -band 1) -ne 0) {
          $release = [DocsNativeIme+INPUT[]]::new(1)
          $release[0] = $events[$inserted]
          $released = [DocsNativeIme]::SendInput(1, $release, [Runtime.InteropServices.Marshal]::SizeOf($release[0]))
          $result.submission.keyUpRecovery = @{
            requestedEvents = 1; insertedEvents = $released
            win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          }
          $recovery = "; compensating key-up inserted $released of 1 events"
        }
        throw "Windows inserted only $inserted of $($events.Length) native key events$recovery"
      }
      $result.after = Get-Snapshot
    }
    default { throw 'Unknown native IME action' }
  }
  $result | ConvertTo-Json -Depth 10 -Compress
} catch {
  if ($result) {
    $result.error = $_.Exception.Message
    $result | ConvertTo-Json -Depth 10 -Compress
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
