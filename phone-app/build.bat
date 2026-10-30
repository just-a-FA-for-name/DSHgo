@echo off
setlocal
rem ============================================================
rem  DSHgo phone client - build script (no Gradle needed)
rem  Output: build\DSHRemote.apk  (auto-generated signing key)
rem
rem  Toolchain locations come from the environment (edit or copy
rem  build-env.example.bat to build-env.bat for local defaults):
rem    JAVA_HOME      JDK 17 root
rem    ANDROID_HOME   Android SDK root (build-tools 34, platform 34)
rem    TAILSCALE_AAR  path to libtailscale.aar (built from tailscale-android
rem                   with gomobile, or downloaded from Tailscale CI)
rem ============================================================
if exist "%~dp0build-env.bat" call "%~dp0build-env.bat"
if not defined JAVA_HOME set JAVA_HOME=%~dp0toolchain\jdk17
if not defined ANDROID_HOME set ANDROID_HOME=%~dp0toolchain\sdk
if not defined TAILSCALE_AAR set TAILSCALE_AAR=%~dp0third_party\libtailscale.aar

set JDK=%JAVA_HOME%\bin
set SDK=%ANDROID_HOME%
set BT=%SDK%\build-tools\34.0.0
set PLAT=%SDK%\platforms\android-34\android.jar
set P=%~dp0
if "%P:~-1%"=="\" set P=%P:~0,-1%
set OUT=%P%\build
set PATH=%JDK%;%PATH%
set JAVA_HOME=%JAVA_HOME%

if not exist "%OUT%" mkdir "%OUT%"
if not exist "%OUT%\classes" mkdir "%OUT%\classes"
if not exist "%OUT%\dex" mkdir "%OUT%\dex"

echo [1/6] compile resources...
"%BT%\aapt2.exe" compile --dir "%P%\res" -o "%OUT%\res.zip" || goto :fail
"%BT%\aapt2.exe" link "%OUT%\res.zip" -I "%PLAT%" --manifest "%P%\AndroidManifest.xml" --java "%P%\gen" -o "%OUT%\app.unsigned.apk" || goto :fail

echo [2/6] unpack libtailscale AAR...
if exist "%OUT%\aar" rmdir /s /q "%OUT%\aar"
mkdir "%OUT%\aar"
pushd "%OUT%\aar"
"%JDK%\jar.exe" xf "%TAILSCALE_AAR%" classes.jar jni
if exist jni move /y jni lib >nul
if exist lib\x86 rmdir /s /q lib\x86
if exist lib\x86_64 rmdir /s /q lib\x86_64
popd

echo [3/6] compile java...
"%JDK%\javac.exe" -encoding UTF-8 -classpath "%PLAT%;%OUT%\aar\classes.jar" -d "%OUT%\classes" "%P%\gen\com\dsh\remote\R.java" "%P%\src\com\dsh\remote\Prefs.java" "%P%\src\com\dsh\remote\Diagnostics.java" "%P%\src\com\dsh\remote\NetworkChangePolicy.java" "%P%\src\com\dsh\remote\EndpointPolicy.java" "%P%\src\com\dsh\remote\ThemePalette.java" "%P%\src\com\dsh\remote\SecureStore.java" "%P%\src\com\dsh\remote\Tunnel.java" "%P%\src\com\dsh\remote\LocalForwarder.java" "%P%\src\com\dsh\remote\Discovery.java" "%P%\src\com\dsh\remote\TailscaleVpnService.java" "%P%\src\com\dsh\remote\BootAnimView.java" "%P%\src\com\dsh\remote\MainActivity.java" "%P%\src\com\dsh\remote\SettingsActivity.java" || goto :fail

echo [4/6] dex...
"%JDK%\jar.exe" cf "%OUT%\classes.jar" -C "%OUT%\classes" . || goto :fail
if exist "%OUT%\dex\classes.dex" del "%OUT%\dex\classes.dex"
call "%BT%\d8.bat" --release --min-api 26 --output "%OUT%\dex" "%OUT%\classes.jar" "%OUT%\aar\classes.jar" || goto :fail

echo [5/6] package dex + native libs into apk...
copy /y "%OUT%\app.unsigned.apk" "%OUT%\app.withdex.apk" >nul
pushd "%OUT%\dex"
"%JDK%\jar.exe" uf "%OUT%\app.withdex.apk" classes.dex || goto :fail
popd
"%JDK%\jar.exe" uf "%OUT%\app.withdex.apk" -C "%OUT%\aar" lib || goto :fail

echo [5/6] align...
"%BT%\zipalign.exe" -f -p 4 "%OUT%\app.withdex.apk" "%OUT%\app.aligned.apk" || goto :fail

echo [6/6] sign...
if not exist "%OUT%\dsh.keystore" (
  "%JDK%\keytool.exe" -genkeypair -keystore "%OUT%\dsh.keystore" -alias dsh -keyalg RSA -keysize 2048 -validity 10000 -storepass dshremote -keypass dshremote -dname "CN=DSH Remote, OU=Mobile, O=DSH, C=CN" || goto :fail
)
call "%BT%\apksigner.bat" sign --ks "%OUT%\dsh.keystore" --ks-pass pass:dshremote --key-pass pass:dshremote --out "%OUT%\DSHRemote.apk" "%OUT%\app.aligned.apk" || goto :fail

echo.
echo BUILD OK: %OUT%\DSHRemote.apk
exit /b 0
:fail
echo BUILD FAILED
exit /b 1
