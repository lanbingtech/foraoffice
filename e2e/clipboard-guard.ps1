# Keep existing clipboard formats in memory while the owned editor tests native copy/paste.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$snapshot = [System.Windows.Forms.DataObject]::new()
$original = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -ne $original) {
  foreach ($format in $original.GetFormats($false)) {
    $value = $original.GetData($format, $false)
    if ($null -eq $value) { throw "Cannot preserve clipboard format $format before testing." }
    if ($value -is [System.IO.MemoryStream]) { $value = [System.IO.MemoryStream]::new($value.ToArray()) }
    if ($value -is [System.Drawing.Image]) { $value = $value.Clone() }
    $snapshot.SetData($format, $false, $value)
  }
}
try {
  [Console]::WriteLine('ready')
  [Console]::Out.Flush()
  $null = [Console]::ReadLine()
} finally {
  if ($null -eq $original) { [System.Windows.Forms.Clipboard]::Clear() }
  else { [System.Windows.Forms.Clipboard]::SetDataObject($snapshot, $true, 10, 100) }
}
