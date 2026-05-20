# setup_and_push.ps1 — limpia y sube todo al repo

$REPO = "https://github.com/Nemeziz/Aliens-Detector.git"

Write-Host "==> Borrando node_modules y cache..." -ForegroundColor Yellow
if (Test-Path "node_modules") { Remove-Item -Recurse -Force "node_modules" }
if (Test-Path ".expo") { Remove-Item -Recurse -Force ".expo" }
if (Test-Path "package-lock.json") { Remove-Item -Force "package-lock.json" }

Write-Host "==> Instalando dependencias limpias..." -ForegroundColor Cyan
npm install --legacy-peer-deps

Write-Host "==> Subiendo a GitHub..." -ForegroundColor Cyan
if (-not (Test-Path ".git")) { git init }
git remote remove origin 2>$null
git remote add origin $REPO
git add .
git commit -m "feat: Aliens Motion Tracker con sonido BLE"
git branch -M main
git push -u origin main --force

Write-Host "" 
Write-Host "==> Lanzando EAS Build..." -ForegroundColor Green
eas build --platform android --profile preview
