# 👾 Outlet Hunter — BLE Proximity Detector

App Android para detectar dispositivos Bluetooth cercanos con RSSI real,
indicador de intensidad de señal y dirección (acercando / alejando).

---

## ¿Qué hace?

- Escanea todos los dispositivos BLE cercanos en tiempo real
- Muestra RSSI real en dBm (no simulado)
- Calcula distancia aproximada con la fórmula del path-loss
- Indica si **te estás acercando** o **alejando** del dispositivo seleccionado
- Mini-gráfica del historial de señal
- Vibración háptica al acercarse
- Pantalla siempre encendida mientras rastreas

---

## Cómo compilar (EAS Build — nube)

### 1. Instalar herramientas (solo la primera vez)

```bash
npm install -g expo-cli eas-cli
```

### 2. Login en Expo

```bash
eas login
```

### 3. Instalar dependencias

```bash
cd OutletHunter
npm install
```

### 4. Configurar proyecto (solo primera vez)

```bash
eas init
```
> Cuando pregunte, elige crear un nuevo proyecto llamado `outlet-hunter`

### 5. Compilar APK en la nube

```bash
eas build --platform android --profile preview
```

- Primera vez tarda ~10 min en la nube
- Al terminar te da un link para descargar el APK
- Instálalo en tu Android (necesitas activar "fuentes desconocidas")

---

## Permisos que pide

- `BLUETOOTH_SCAN` — para escanear dispositivos cercanos
- `BLUETOOTH_CONNECT` — requerido en Android 12+
- `ACCESS_FINE_LOCATION` — requerido por Android para BLE scan

---

## Notas técnicas

- RSSI típico: -40 dBm (muy cerca) a -100 dBm (lejos o sin señal)
- Distancia calculada con TxPower = -59 dBm, n = 2.0 (interior)
- El RSSI se suaviza con promedio de las últimas 8 lecturas
- Tendencia basada en diferencia entre últimas 3 muestras (±3 dBm threshold)
- Dispositivos sin actividad por 15s se eliminan de la lista
