param(
  [Parameter(Mandatory = $true)][int]$TargetProcessId,
  [string]$TargetFilePath,
  [switch]$Cancel,
  [switch]$RequireDialog,
  [switch]$SaveFile,
  [switch]$CloseWindow,
  [ValidateSet('Save', 'Discard', 'Cancel')][string]$Decision,
  [ValidateSet('New', 'Open', 'Save', 'Save As')][string]$MenuCommand,
  [string]$ExpectedFileMenuLabel,
  [string]$ScreenshotPath,
  [int]$TimeoutMs = 15000
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DocsNativeTestWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wParam, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")]
  public static extern IntPtr GetDlgItem(IntPtr dialog, int controlId);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
}
'@
if ($CloseWindow) {
  $process = Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) { exit 0 }
  $handle = $process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw 'The owned Qt process has no main window.' }
  if (-not [DocsNativeTestWindow]::PostMessageW($handle, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero)) {
    throw 'The owned Qt window could not receive WM_CLOSE.'
  }
  exit 0
}
$owner = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetProcessId)
if ($ExpectedFileMenuLabel) {
  $menuItemType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $owner)
  foreach ($window in $windows) {
    foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemType)) {
      if ($item.Current.Name.Replace('&', '') -eq $ExpectedFileMenuLabel) { exit 0 }
    }
  }
  throw 'The owned native File menu did not use the requested locale.'
}
if ($MenuCommand) {
  $expectedCommandLabel = if ($MenuCommand -eq 'New') { 'New Document' } else { $MenuCommand }
  $menuItemType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $owner)
  $fileMenu = $null
  foreach ($window in $windows) {
    foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemType)) {
      if ($item.Current.Name.Replace('&', '') -eq 'File') { $fileMenu = $item; break }
    }
  }
  if ($null -eq $fileMenu) { throw 'The owned Qt File menu was not found.' }
  $expand = $null
  if ($fileMenu.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) { $expand.Expand() }
  else { $fileMenu.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $commandItem = $null
  while ($null -eq $commandItem -and [DateTime]::UtcNow -lt $deadline) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $owner)
    foreach ($window in $windows) {
      foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemType)) {
        if ($item.Current.Name.Replace('&', '').Replace([string][char]0x2026, '').Split([char]9)[0] -eq $expectedCommandLabel) { $commandItem = $item; break }
      }
    }
    if ($null -eq $commandItem) { Start-Sleep -Milliseconds 100 }
  }
  if ($null -eq $commandItem) { throw "The owned Qt menu command $MenuCommand was not found." }
  $commandItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  if (-not $Decision -and -not $TargetFilePath) { exit 0 }
}
$dialogClass = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, $(if ($Decision) { 'QMessageBox' } else { '#32770' }))
$condition = [System.Windows.Automation.AndCondition]::new($owner, $dialogClass)
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$dialog = $null
while ($null -eq $dialog -and [DateTime]::UtcNow -lt $deadline) {
  $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Children, $condition)
  if ($null -eq $dialog) {
    $ownedWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children, $owner)
    foreach ($window in $ownedWindows) {
      $dialog = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if ($null -ne $dialog) { break }
    }
  }
  if ($null -eq $dialog) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $dialog) {
  if ($Cancel -and -not $RequireDialog) { exit 0 }
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $owner)
  $description = @($windows | ForEach-Object { "class=$($_.Current.ClassName) name=$($_.Current.Name) offscreen=$($_.Current.IsOffscreen)" }) -join '; '
  throw "The owned native file dialog did not appear. Owned windows: $description"
}
if ($ScreenshotPath) {
  Add-Type -AssemblyName System.Drawing
  $bounds = $dialog.Current.BoundingRectangle
  $image = [System.Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($image)
  try {
    $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $image.Size)
    $image.Save($ScreenshotPath)
  } finally { $graphics.Dispose(); $image.Dispose() }
}
if ($Decision) {
  $expectedDecisionLabel = if ($Decision -eq 'Discard') { "Don't Save" } else { $Decision }
  $buttonType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($button in $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonType)) {
    if ($button.Current.Name.Replace('&', '') -eq $expectedDecisionLabel) {
      $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      exit 0
    }
  }
  throw "The owned message-box decision $Decision was not found."
}
if ($SaveFile) {
  if (-not [System.IO.Path]::IsPathRooted($TargetFilePath)) { throw 'An absolute save fixture path is required.' }
  $fileNameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
  $fileNameElement = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileNameCondition)
  if ($null -eq $fileNameElement) {
    $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $description = @($controls | Where-Object { $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::ComboBox) -or $_.Current.ClassName -match 'Edit|Combo' } | ForEach-Object { "id=$($_.Current.AutomationId) class=$($_.Current.ClassName) type=$($_.Current.ControlType.ProgrammaticName)" }) -join '; '
    throw "The native file-name control was not found. Dialog=$($dialog.Current.Name); fields=$description"
  }
  $fileName = [IntPtr]$fileNameElement.Current.NativeWindowHandle
  if ($fileName -eq [IntPtr]::Zero) { throw 'The native file-name control has no window.' }
  if ($fileNameElement.Current.ClassName -ne 'Edit') { throw 'The save file-name control is not a native edit.' }
  $result = [UIntPtr]::Zero
  if ([DocsNativeTestWindow]::SendMessageTimeoutW($fileName, 0x000C, [UIntPtr]::Zero, $TargetFilePath, 2, 5000, [ref]$result) -eq [IntPtr]::Zero) {
    throw 'The native file-name edit did not accept its value.'
  }
} elseif (-not $Cancel) {
  if (-not [System.IO.Path]::IsPathRooted($TargetFilePath)) { throw 'An absolute fixture path is required.' }
  $itemCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty, [System.IO.Path]::GetFileName($TargetFilePath))
  $matches = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $itemCondition)
  $selected = $false
  foreach ($item in $matches) {
    $selection = $null
    if ($item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
      $selection.Select()
      $selected = $true
      break
    }
  }
  if (-not $selected) { throw 'The fixture file was not available for selection in the native dialog.' }
}
# Win32 dialog IDs are distinct from UIA item IDs (the file list also has an item '1').
$buttonId = if ($Cancel) { 2 } else { 1 }
$button = [DocsNativeTestWindow]::GetDlgItem([IntPtr]$dialog.Current.NativeWindowHandle, $buttonId)
if ($button -eq [IntPtr]::Zero) { throw 'The native file dialog action was not found.' }
if (-not [DocsNativeTestWindow]::PostMessageW($button, 0x00F5, [UIntPtr]::Zero, [IntPtr]::Zero)) {
  throw 'The native file dialog action could not receive BM_CLICK.'
}
