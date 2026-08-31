param(
  [Parameter(Mandatory=$true)][ValidateSet('read','write')][string]$Action,
  [string]$Target = 'gemini:antigravity',
  [string]$User = 'antigravity',
  [string]$JsonPath
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AgyCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credPtr);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
}
"@

if ($Action -eq 'read') {
  $p = [IntPtr]::Zero
  if (-not [AgyCred]::CredRead($Target, 1, 0, [ref]$p)) {
    Write-Output "ERR CredRead $($Error[0]) last=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 1
  }
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][AgyCred+CREDENTIAL])
  $bytes = New-Object byte[] $c.CredentialBlobSize
  if ($c.CredentialBlobSize -gt 0) {
    [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
  }
  [AgyCred]::CredFree($p)
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
  exit 0
}

if (-not $JsonPath -or -not (Test-Path -LiteralPath $JsonPath)) {
  Write-Output "ERR json path missing"
  exit 1
}
$json = [IO.File]::ReadAllText($JsonPath, [Text.Encoding]::UTF8)
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
  $cred = New-Object AgyCred+CREDENTIAL
  $cred.Type = 1
  $cred.TargetName = $Target
  $cred.UserName = $User
  $cred.CredentialBlobSize = [uint32]$bytes.Length
  $cred.CredentialBlob = $blob
  $cred.Persist = 2
  $cred.AttributeCount = 0
  $cred.Attributes = [IntPtr]::Zero
  if (-not [AgyCred]::CredWrite([ref]$cred, 0)) {
    Write-Output "ERR CredWrite last=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 1
  }
  Write-Output "OK bytes=$($bytes.Length)"
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
}
