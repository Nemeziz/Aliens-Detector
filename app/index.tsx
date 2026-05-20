import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, Vibration, Alert, Platform, PermissionsAndroid,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

// ─── constantes ────────────────────────────────────────────────────────────────
const RSSI_MIN = -100;  // señal mínima (lejos)
const RSSI_MAX = -40;   // señal máxima (muy cerca)
const HISTORY_SIZE = 8; // muestras para suavizar RSSI
const SCAN_INTERVAL = 1500; // ms entre lecturas de señal

// ─── helpers ───────────────────────────────────────────────────────────────────
function rssiToPercent(rssi: number): number {
  const clamped = Math.max(RSSI_MIN, Math.min(RSSI_MAX, rssi));
  return Math.round(((clamped - RSSI_MIN) / (RSSI_MAX - RSSI_MIN)) * 100);
}

function rssiToDistance(rssi: number): string {
  // Fórmula: d = 10 ^ ((TxPower - RSSI) / (10 * n))
  // TxPower ≈ -59 dBm a 1 metro, n = 2.0 en interior
  const txPower = -59;
  const n = 2.0;
  const d = Math.pow(10, (txPower - rssi) / (10 * n));
  if (d < 1) return `${Math.round(d * 100)} cm`;
  if (d > 50) return `+50 m`;
  return `${d.toFixed(1)} m`;
}

function trend(history: number[]): 'acercando' | 'alejando' | 'estable' {
  if (history.length < 3) return 'estable';
  const recent = history.slice(-3);
  const diff = recent[recent.length - 1] - recent[0];
  if (diff > 3) return 'acercando';   // RSSI subió → más cerca
  if (diff < -3) return 'alejando';   // RSSI bajó → más lejos
  return 'estable';
}

function average(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function signalLabel(pct: number): string {
  if (pct >= 80) return '🟢 MUY CERCA';
  if (pct >= 60) return '🟡 CERCA';
  if (pct >= 40) return '🟠 MODERADO';
  if (pct >= 20) return '🔴 LEJOS';
  return '⚫ MUY LEJOS';
}

function signalColor(pct: number): string {
  if (pct >= 80) return '#00ff41';
  if (pct >= 60) return '#ffff00';
  if (pct >= 40) return '#ff8c00';
  if (pct >= 20) return '#ff4444';
  return '#555555';
}

// ─── tipos ─────────────────────────────────────────────────────────────────────
interface ScannedDevice {
  id: string;
  name: string;
  rssi: number;
  rssiHistory: number[];
  lastSeen: number;
  pinned: boolean;
}

interface TrackedDevice extends ScannedDevice {
  percent: number;
  distance: string;
  trend: 'acercando' | 'alejando' | 'estable';
  avgRssi: number;
}

// ─── componente principal ──────────────────────────────────────────────────────
export default function HomeScreen() {
  const manager = useRef<BleManager | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<Map<string, ScannedDevice>>(new Map());
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [trackedDevice, setTrackedDevice] = useState<TrackedDevice | null>(null);
  const [permissionsOk, setPermissionsOk] = useState(false);
  const scanRef = useRef<boolean>(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const prevTrendRef = useRef<string>('estable');

  // ── pedir permisos ──────────────────────────────────────────────────────────
  const requestPermissions = async () => {
    if (Platform.OS !== 'android') { setPermissionsOk(true); return; }
    try {
      const grants = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      const ok = Object.values(grants).every(
        v => v === PermissionsAndroid.RESULTS.GRANTED
      );
      setPermissionsOk(ok);
      if (!ok) Alert.alert('Permisos necesarios', 'Activa Bluetooth y Ubicación en Configuración.');
    } catch {
      setPermissionsOk(false);
    }
  };

  // ── inicializar BLE ─────────────────────────────────────────────────────────
  useEffect(() => {
    manager.current = new BleManager();
    requestPermissions();
    activateKeepAwakeAsync();
    return () => {
      manager.current?.destroy();
      deactivateKeepAwake();
    };
  }, []);

  // ── animación pulso ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!scanning) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [scanning]);

  // ── animación glow por intensidad ───────────────────────────────────────────
  useEffect(() => {
    if (!trackedDevice) return;
    Animated.timing(glowAnim, {
      toValue: trackedDevice.percent / 100,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [trackedDevice?.percent]);

  // ── vibración al acercarse ──────────────────────────────────────────────────
  useEffect(() => {
    if (!trackedDevice) return;
    const t = trackedDevice.trend;
    if (t === 'acercando' && prevTrendRef.current !== 'acercando') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else if (t === 'estable' && trackedDevice.percent >= 80) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    prevTrendRef.current = t;
  }, [trackedDevice?.trend]);

  // ── escaneo continuo ────────────────────────────────────────────────────────
  const startScan = useCallback(() => {
    if (!manager.current || !permissionsOk) return;
    scanRef.current = true;
    setScanning(true);

    const doScan = () => {
      if (!scanRef.current) return;
      manager.current!.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
        if (error || !device) return;
        const rssi = device.rssi ?? -100;

        setDevices(prev => {
          const next = new Map(prev);
          const existing = next.get(device.id);
          const history = existing
            ? [...existing.rssiHistory.slice(-(HISTORY_SIZE - 1)), rssi]
            : [rssi];
          next.set(device.id, {
            id: device.id,
            name: device.name || device.localName || `[${device.id.slice(-5)}]`,
            rssi,
            rssiHistory: history,
            lastSeen: Date.now(),
            pinned: existing?.pinned ?? false,
          });
          return next;
        });
      });

      setTimeout(() => {
        if (!scanRef.current) return;
        manager.current!.stopDeviceScan();
        setTimeout(doScan, 200);
      }, SCAN_INTERVAL);
    };

    doScan();
  }, [permissionsOk]);

  const stopScan = useCallback(() => {
    scanRef.current = false;
    setScanning(false);
    manager.current?.stopDeviceScan();
    setTrackedId(null);
    setTrackedDevice(null);
  }, []);

  // ── actualizar device rastreado ─────────────────────────────────────────────
  useEffect(() => {
    if (!trackedId) { setTrackedDevice(null); return; }
    const dev = devices.get(trackedId);
    if (!dev) return;
    const avg = average(dev.rssiHistory);
    setTrackedDevice({
      ...dev,
      avgRssi: avg,
      percent: rssiToPercent(avg),
      distance: rssiToDistance(avg),
      trend: trend(dev.rssiHistory),
    });
  }, [devices, trackedId]);

  // ── limpiar dispositivos viejos ─────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setDevices(prev => {
        const next = new Map(prev);
        for (const [id, d] of next) {
          if (!d.pinned && now - d.lastSeen > 15000) next.delete(id);
        }
        return next;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── lista de dispositivos ordenada ──────────────────────────────────────────
  const deviceList = Array.from(devices.values())
    .sort((a, b) => b.rssi - a.rssi)
    .slice(0, 30);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      {/* ── cabecera ── */}
      <View style={styles.header}>
        <Text style={styles.title}>👾 OUTLET HUNTER</Text>
        <Text style={styles.subtitle}>BLE Proximity Detector</Text>
      </View>

      {/* ── panel de dispositivo rastreado ── */}
      {trackedDevice ? (
        <View style={styles.trackerPanel}>
          <Text style={styles.trackerName} numberOfLines={1}>{trackedDevice.name}</Text>

          {/* barra de intensidad */}
          <View style={styles.barBg}>
            <Animated.View
              style={[
                styles.barFill,
                {
                  width: `${trackedDevice.percent}%`,
                  backgroundColor: glowAnim.interpolate({
                    inputRange: [0, 0.4, 0.7, 1],
                    outputRange: ['#555', '#ff4444', '#ff8c00', '#00ff41'],
                  }),
                },
              ]}
            />
          </View>

          {/* métricas */}
          <View style={styles.metricsRow}>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>RSSI</Text>
              <Text style={[styles.metricValue, { color: signalColor(trackedDevice.percent) }]}>
                {Math.round(trackedDevice.avgRssi)} dBm
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>DISTANCIA</Text>
              <Text style={[styles.metricValue, { color: signalColor(trackedDevice.percent) }]}>
                {trackedDevice.distance}
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>SEÑAL</Text>
              <Text style={[styles.metricValue, { color: signalColor(trackedDevice.percent) }]}>
                {trackedDevice.percent}%
              </Text>
            </View>
          </View>

          {/* tendencia */}
          <View style={styles.trendRow}>
            <Text style={[
              styles.trendText,
              trackedDevice.trend === 'acercando' && styles.trendUp,
              trackedDevice.trend === 'alejando' && styles.trendDown,
              trackedDevice.trend === 'estable' && styles.trendStable,
            ]}>
              {trackedDevice.trend === 'acercando' && '▲ TE ESTÁS ACERCANDO'}
              {trackedDevice.trend === 'alejando' && '▼ TE ESTÁS ALEJANDO'}
              {trackedDevice.trend === 'estable' && '● DISTANCIA ESTABLE'}
            </Text>
          </View>

          {/* historial RSSI mini-gráfica */}
          <View style={styles.miniChart}>
            {trackedDevice.rssiHistory.map((r, i) => {
              const h = rssiToPercent(r);
              return (
                <View key={i} style={styles.miniBarCol}>
                  <View style={[
                    styles.miniBar,
                    { height: `${h}%`, backgroundColor: signalColor(h) }
                  ]} />
                </View>
              );
            })}
          </View>

          <Text style={[styles.signalLabel, { color: signalColor(trackedDevice.percent) }]}>
            {signalLabel(trackedDevice.percent)}
          </Text>

          <TouchableOpacity style={styles.btnStop} onPress={() => setTrackedId(null)}>
            <Text style={styles.btnStopText}>✕ DEJAR DE RASTREAR</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.noTrackPanel}>
          <Text style={styles.noTrackText}>
            {scanning
              ? '📡 Selecciona un dispositivo de la lista para rastrearlo'
              : 'Presiona ESCANEAR para buscar dispositivos Bluetooth'}
          </Text>
        </View>
      )}

      {/* ── botón escanear / detener ── */}
      <TouchableOpacity
        style={[styles.btnScan, scanning && styles.btnScanActive]}
        onPress={scanning ? stopScan : startScan}
        disabled={!permissionsOk}
      >
        <Animated.Text style={[
          styles.btnScanText,
          scanning && { transform: [{ scale: pulseAnim }] }
        ]}>
          {permissionsOk
            ? scanning ? '⏹ DETENER' : '▶ ESCANEAR'
            : '⚠ PERMITIR BLUETOOTH'}
        </Animated.Text>
      </TouchableOpacity>

      {/* ── lista de dispositivos ── */}
      {scanning && (
        <>
          <Text style={styles.listHeader}>
            📶 {deviceList.length} DISPOSITIVOS ENCONTRADOS
          </Text>
          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 20 }}>
            {deviceList.map(dev => {
              const pct = rssiToPercent(dev.rssi);
              const isTracked = dev.id === trackedId;
              return (
                <TouchableOpacity
                  key={dev.id}
                  style={[styles.deviceRow, isTracked && styles.deviceRowActive]}
                  onPress={() => setTrackedId(dev.id)}
                >
                  {/* barra lateral de intensidad */}
                  <View style={styles.deviceBarCol}>
                    <View style={styles.deviceBarBg}>
                      <View style={[
                        styles.deviceBarFill,
                        { height: `${pct}%`, backgroundColor: signalColor(pct) }
                      ]} />
                    </View>
                  </View>

                  <View style={styles.deviceInfo}>
                    <Text style={styles.deviceName} numberOfLines={1}>{dev.name}</Text>
                    <Text style={styles.deviceId} numberOfLines={1}>{dev.id}</Text>
                  </View>

                  <View style={styles.deviceRssiCol}>
                    <Text style={[styles.deviceRssiVal, { color: signalColor(pct) }]}>
                      {dev.rssi}
                    </Text>
                    <Text style={styles.deviceRssiUnit}>dBm</Text>
                    <Text style={[styles.devicePct, { color: signalColor(pct) }]}>{pct}%</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </>
      )}
    </View>
  );
}

// ─── estilos ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', paddingTop: 50, paddingHorizontal: 16 },
  header: { alignItems: 'center', marginBottom: 12 },
  title: { color: '#00ff41', fontSize: 22, fontWeight: 'bold', letterSpacing: 4, fontFamily: 'monospace' },
  subtitle: { color: '#444', fontSize: 11, letterSpacing: 2, marginTop: 2 },

  // ── panel rastreado
  trackerPanel: {
    backgroundColor: '#0a0a0a', borderWidth: 1, borderColor: '#00ff4133',
    borderRadius: 12, padding: 14, marginBottom: 12,
  },
  trackerName: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginBottom: 10, letterSpacing: 1 },
  barBg: { height: 18, backgroundColor: '#111', borderRadius: 9, overflow: 'hidden', marginBottom: 12 },
  barFill: { height: '100%', borderRadius: 9 },
  metricsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  metricBox: { alignItems: 'center', flex: 1 },
  metricLabel: { color: '#555', fontSize: 9, letterSpacing: 1, marginBottom: 2 },
  metricValue: { fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace' },
  trendRow: { alignItems: 'center', marginBottom: 8 },
  trendText: { fontSize: 14, fontWeight: 'bold', letterSpacing: 2 },
  trendUp: { color: '#00ff41' },
  trendDown: { color: '#ff4444' },
  trendStable: { color: '#888' },
  miniChart: {
    flexDirection: 'row', height: 40, alignItems: 'flex-end',
    backgroundColor: '#0d0d0d', borderRadius: 6, padding: 4, marginBottom: 8,
  },
  miniBarCol: { flex: 1, height: '100%', justifyContent: 'flex-end', paddingHorizontal: 1 },
  miniBar: { borderRadius: 2, minHeight: 2 },
  signalLabel: { textAlign: 'center', fontSize: 13, letterSpacing: 2, fontWeight: 'bold', marginBottom: 10 },
  btnStop: {
    borderWidth: 1, borderColor: '#ff4444', borderRadius: 8,
    paddingVertical: 8, alignItems: 'center',
  },
  btnStopText: { color: '#ff4444', fontSize: 12, letterSpacing: 2 },

  // ── sin rastreo
  noTrackPanel: {
    backgroundColor: '#0a0a0a', borderWidth: 1, borderColor: '#222',
    borderRadius: 12, padding: 20, marginBottom: 12, alignItems: 'center',
  },
  noTrackText: { color: '#555', textAlign: 'center', fontSize: 13, lineHeight: 20 },

  // ── botón escanear
  btnScan: {
    backgroundColor: '#111', borderWidth: 2, borderColor: '#00ff41',
    borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginBottom: 12,
  },
  btnScanActive: { borderColor: '#ff4444', backgroundColor: '#1a0000' },
  btnScanText: { color: '#00ff41', fontSize: 16, fontWeight: 'bold', letterSpacing: 3 },

  // ── lista
  listHeader: { color: '#444', fontSize: 10, letterSpacing: 2, marginBottom: 6 },
  list: { flex: 1 },
  deviceRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0a0a0a', borderRadius: 8,
    marginBottom: 6, padding: 10, borderWidth: 1, borderColor: '#1a1a1a',
  },
  deviceRowActive: { borderColor: '#00ff41', backgroundColor: '#001a00' },
  deviceBarCol: { width: 8, height: 40, marginRight: 10 },
  deviceBarBg: { flex: 1, backgroundColor: '#222', borderRadius: 4, overflow: 'hidden', justifyContent: 'flex-end' },
  deviceBarFill: { width: '100%', borderRadius: 4 },
  deviceInfo: { flex: 1, marginRight: 8 },
  deviceName: { color: '#ddd', fontSize: 13, fontWeight: '600' },
  deviceId: { color: '#333', fontSize: 10, marginTop: 2, fontFamily: 'monospace' },
  deviceRssiCol: { alignItems: 'flex-end' },
  deviceRssiVal: { fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace' },
  deviceRssiUnit: { color: '#444', fontSize: 9 },
  devicePct: { fontSize: 11, fontWeight: 'bold' },
});
