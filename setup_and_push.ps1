# setup_and_push.ps1
# Sube el proyecto OutletHunter a GitHub y lanza EAS Build

$REPO = "https://github.com/Nemeziz/Aliens-Detector.git"

Write-Host "==> Inicializando git..." -ForegroundColor Cyan

if (Test-Path ".git") {
    Write-Host "    (repo ya inicializado, continuando)" -ForegroundColor Yellow
} else {
    git init
    git remote add origin $REPO
}

Write-Host "==> Instalando dependencias npm..." -ForegroundColor Cyan
npm install

Write-Host "==> Agregando archivos al commit..." -ForegroundColor Cyan
git add .
git commit -m "feat: Outlet Hunter BLE proximity detector"
git branch -M main
git push -u origin main --force

Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "  Codigo subido a: $REPO"              -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host ""
Write-Host "==> Iniciando EAS Build (APK en la nube)..." -ForegroundColor Cyan
Write-Host "    (necesitas tener eas-cli instalado: npm install -g eas-cli)" -ForegroundColor Yellow
Write-Host ""

$easInstalled = Get-Command eas -ErrorAction SilentlyContinue
if (-not $easInstalled) {
    Write-Host "    Instalando eas-cli..." -ForegroundColor Yellow
    npm install -g eas-cli
}

eas login
eas build --platform android --profile preview

Write-Host ""
Write-Host "Listo! Cuando termine el build (aprox 10 min) EAS te da el link para descargar el APK." -ForegroundColor Green
