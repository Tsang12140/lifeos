# LifeOS 局域网预览：放行 Windows 防火墙的入站端口。
#
# 为什么需要它：手机的连接先撞防火墙，再撞 Vite。这台机器的网络被识别成「公用」，
# 而 Node.js 一条入站规则都没有 —— 就算 Vite 绑了 0.0.0.0，手机照样连不上。
#
#   双击 允许手机访问.cmd        （会弹一次 UAC）
#   powershell -File scripts\allow-lan-firewall.ps1 -Remove   撤销
#
# 只放行这两个 TCP 端口，且只允许同一网段（LocalSubnet）连进来。不写死程序路径
# （换 Node 版本不会失效），也不对公网开放。
#
# ⚠️ 这个文件必须以 UTF-8 + BOM 保存：Windows PowerShell 5.1 会把无 BOM 的文件
#    按 ANSI 读，中文注释会变成乱码，还可能让解析器在中途炸掉。
param(
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ruleName = "LifeOS LAN preview"
$ports = @(5199, 5499)

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Elevated)) {
    # 改防火墙必须要管理员；双击进来的窗口没有，就自己再起一个带 UAC 的。
    Write-Host "修改防火墙规则需要管理员权限，正在请求提权……"
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($Remove) { $arguments += "-Remove" }
    $process = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

if ($null -eq (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
    Write-Host "这台机器上没有 Get-NetFirewallRule（NetSecurity 模块缺失），无法自动放行。"
    Write-Host "手动做法：Windows 安全中心 > 防火墙和网络保护 > 高级设置 > 入站规则 > 新建规则 > 端口 > TCP 5199。"
    exit 1
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($Remove) {
    if ($null -eq $existing) {
        Write-Host "没有找到规则「$ruleName」，不需要删除。"
        exit 0
    }
    $existing | Remove-NetFirewallRule
    Write-Host "已删除规则「$ruleName」：手机将无法再连接 5199/5499。"
    exit 0
}

# 先删后建，不做原地改端口 —— 端口过滤器改起来有版本差异，重建更省事也更干净。
if ($null -ne $existing) {
    $existing | Remove-NetFirewallRule
}

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Description "LifeOS 预览：允许同一局域网内的手机访问 5199/5499" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $ports `
    -RemoteAddress LocalSubnet `
    -Profile Any `
    -Enabled True | Out-Null

$created = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -eq $created) {
    Write-Host "规则没有建成功（Get-NetFirewallRule 查不到「$ruleName」）。"
    exit 1
}

$filter = $created | Get-NetFirewallPortFilter
Write-Host ""
Write-Host "✓ 已放行 TCP $($filter.LocalPort -join '/')，来源限定为同一网段。"
Write-Host ""

# 门牌号：只列手机真能用的物理网卡（VMware / WSL / VPN 的地址手机打不到）。
$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -ne "127.0.0.1" -and
        $_.AddressState -eq "Preferred" -and
        $_.InterfaceAlias -notmatch "vEthernet|VMware|VirtualBox|Tailscale|ZeroTier|Hyper-V|docker|Loopback|蓝牙"
    } |
    Select-Object -ExpandProperty IPAddress

if ($addresses.Count -eq 0) {
    Write-Host "没找到可用的局域网 IPv4（先确认这台电脑连着 Wi-Fi 或网线）。"
} else {
    Write-Host "手机（同一个 Wi-Fi）打开："
    foreach ($address in $addresses) { Write-Host "    http://${address}:5199/" }
    Write-Host ""
    Write-Host "前提是电脑上正开着局域网预览：双击 启动局域网预览.cmd，窗口里会打印登录密码。"
}

Write-Host ""
Write-Host "如果加完还是打不开，通常是路由器开了「AP 隔离 / 访客网络隔离」—— 把手机挪到主 Wi-Fi 再试。"
exit 0
