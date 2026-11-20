# Build HG Android APK without Gradle (aapt2 + javac + d8 + zipalign + apksigner)
# ASCII-only on purpose: Windows PowerShell 5.1 misreads BOM-less UTF-8 scripts.
$ErrorActionPreference = 'Stop'

$SDK = "C:\Android\sdk"
$BT = Join-Path $SDK "build-tools\36.0.0"
$ANDROID_JAR = Join-Path $SDK "platforms\android-34\android.jar"
$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
# aapt2 在 Windows 下会把 -A 的路径分隔符原样写进 assets 条目名（assets/www\index.html），
# Android 端按 assets/www/index.html 取不到，所以这里统一转成 / 再传。
$ASSETS = ((Join-Path $HERE "assets") -replace '\\', '/')
$OUT = Join-Path $HERE "build"
$VENDOR = Join-Path $HERE "vendor"
$APK_NAME = "HG-1.5.46.apk"

$JAVAC = (Get-Command javac -ErrorAction SilentlyContinue).Source
if (-not $JAVAC) { $JAVAC = "C:\Program Files\Java\openjdk-25.0.2\bin\javac.exe" }

foreach ($p in @($BT, $ANDROID_JAR, $VENDOR, $JAVAC, (Join-Path $HERE "assets\www\index.html"))) {
    if (-not (Test-Path $p)) { throw "missing: $p" }
}

$vendorJars = (Get-ChildItem -LiteralPath $VENDOR -Filter *.jar | ForEach-Object { $_.FullName })
if (-not $vendorJars) { throw "no jars in vendor" }
$cp = ($vendorJars + $ANDROID_JAR) -join ';'

Remove-Item -Recurse -Force $OUT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$OUT\classes", "$OUT\dex" | Out-Null

Write-Host "== 1/6 aapt2 compile + link"
& "$BT\aapt2.exe" compile --dir "$HERE\res" -o "$OUT\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

$LINK = @(
    'link',
    '-o', "$OUT\base.apk",
    '-I', $ANDROID_JAR,
    '--manifest', "$HERE\AndroidManifest.xml",
    '-R', "$OUT\res.zip",
    '-A', $ASSETS,
    '--min-sdk-version', '24',
    '--target-sdk-version', '34'
)
# version line kept on one row so tools/sync_version.py can rewrite it
$LINK += '--version-code 124 --version-name 1.5.46'.Split(' ')

# 内置前端版本号：App 启动时用它判断「随包页面」是否比私有目录里的副本新。
# 注意这里写的是 **前端版本**（version.json 的 web），不是 APK 版本：
# 写成 APK 版本会让内置的 1.5.42 页面被标成 1.5.34，启动时触发一次多余的热更新下载 + 刷新。
$VERJSON = Get-Content -Raw -Encoding UTF8 (Join-Path $HERE "..\version.json") | ConvertFrom-Json
$WEBVER = [string]$VERJSON.web
Set-Content -LiteralPath (Join-Path $HERE "assets\www\version.txt") -Value $WEBVER -NoNewline -Encoding ascii

& "$BT\aapt2.exe" @LINK
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "== 2/6 javac (with media3 vendor jars)"
$sources = Get-ChildItem -Recurse -Filter *.java "$HERE\src" | ForEach-Object { $_.FullName }
& $JAVAC -encoding UTF-8 --release 17 -classpath $cp -d "$OUT\classes" $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "== 3/6 d8 (app classes + media3)"
$classes = Get-ChildItem -Recurse -Filter *.class "$OUT\classes" | ForEach-Object { $_.FullName }
& "$BT\d8.bat" --lib $ANDROID_JAR --min-api 24 --output "$OUT\dex" $classes $vendorJars
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "== 4/6 add dex files"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$OUT\base.apk", 'Update')
Get-ChildItem -LiteralPath "$OUT\dex" -Filter *.dex | ForEach-Object {
    $name = $_.Name
    $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    $in = [System.IO.File]::OpenRead($_.FullName)
    $outS = $entry.Open()
    $in.CopyTo($outS)
    $outS.Close(); $in.Close()
    Write-Host "   + $name ($([math]::Round($_.Length/1MB,2)) MB)"
}
$zip.Dispose()

Write-Host "== 5/6 fix asset names + zipalign"
# aapt2 在 Windows 下把 assets 条目名写成了 assets/www\index.html（反斜杠），
# Android 端按 assets/www/index.html 取不到 → 这里重打包，把所有条目名统一成 /。
$fixed = "$OUT\fixed.apk"
Remove-Item -Force $fixed -ErrorAction SilentlyContinue
$zin = [System.IO.Compression.ZipFile]::OpenRead("$OUT\base.apk")
$zout = [System.IO.Compression.ZipFile]::Open($fixed, 'Create')
foreach ($e in $zin.Entries) {
    $nm = $e.FullName -replace '\\', '/'
    # resources.arsc / native 库必须 STORED（不压缩），否则 Android 11+ 判为非法包
    $stored = ($nm -eq 'resources.arsc') -or ($nm -like '*.so')
    $lvl = if ($stored) { [System.IO.Compression.CompressionLevel]::NoCompression }
           else { [System.IO.Compression.CompressionLevel]::Optimal }
    $ne = $zout.CreateEntry($nm, $lvl)
    $s = $e.Open(); $t = $ne.Open()
    $s.CopyTo($t)
    $t.Close(); $s.Close()
}
$zout.Dispose(); $zin.Dispose()

& "$BT\zipalign.exe" -f -p 4 $fixed "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "== 6/6 sign"
$ks = Join-Path $HERE "debug.keystore"
if (-not (Test-Path $ks)) {
    & keytool -genkeypair -v -keystore $ks -storepass android -keypass android `
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=HG Debug,O=HG,C=CN" | Out-Null
}
& "$BT\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android `
    --out "$HERE\$APK_NAME" "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

& "$BT\apksigner.bat" verify "$HERE\$APK_NAME"
$size = [math]::Round((Get-Item "$HERE\$APK_NAME").Length / 1MB, 2)
Write-Host ""
Write-Host "done: $HERE\$APK_NAME  ($size MB)"
