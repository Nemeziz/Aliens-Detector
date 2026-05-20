import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, Alert, Platform, PermissionsAndroid, Dimensions,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Audio } from 'expo-av';

const { width } = Dimensions.get('window');
const RADAR_SIZE = width * 0.85;
const RADAR_R = RADAR_SIZE / 2;
const RSSI_MIN = -100;
const RSSI_MAX = -45;
const HISTORY_SIZE = 10;
const SCAN_INTERVAL = 1200;

// ── helpers ────────────────────────────────────────────────────────────────────
function rssiToPercent(rssi) {
  const c = Math.max(RSSI_MIN, Math.min(RSSI_MAX, rssi));
  return (c - RSSI_MIN) / (RSSI_MAX - RSSI_MIN);
}
function rssiToDistance(rssi) {
  const d = Math.pow(10, (-59 - rssi) / 20);
  if (d < 1) return `${Math.round(d * 100)}cm`;
  if (d > 50) return '>50m';
  return `${d.toFixed(1)}m`;
}
function getTrend(history) {
  if (history.length < 3) return 'estable';
  const diff = history[history.length - 1] - history[0];
  if (diff > 4) return 'acercando';
  if (diff < -4) return 'alejando';
  return 'estable';
}
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function strToAngle(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 360) * (Math.PI / 180);
}
function rssiToRadarPos(pct, angleRad) {
  const dist = RADAR_R * (1 - pct * 0.82);
  return { x: RADAR_R + dist * Math.cos(angleRad), y: RADAR_R + dist * Math.sin(angleRad) };
}

// ── Audio engine: genera pitidos con Web Audio via expo-av HTML trick ──────────
// Usamos expo-av con un buffer PCM generado en JS para el beep característico
function generateBeepWav(frequency = 880, durationMs = 80, volume = 0.8) {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // WAV header
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // PCM samples — tono con envelope ADSR rápido
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, i / (sampleRate * 0.005));
    const release = Math.max(0, 1 - (i - numSamples * 0.7) / (numSamples * 0.3));
    const envelope = attack * release;
    const sample = Math.sin(2 * Math.PI * frequency * t) * volume * envelope;
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, sample * 32767)), true);
  }

  // Convertir a base64
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
}

// ── useTrackerSound: pitidos estilo Aliens ─────────────────────────────────────
function useTrackerSound(trackedDevice, scanning) {
  const soundRef = useRef(null);
  const timerRef = useRef(null);
  const activeRef = useRef(false);

  const stopBeeps = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (soundRef.current) { soundRef.current.unloadAsync(); soundRef.current = null; }
  }, []);

  const scheduleBeep = useCallback(async (pct) => {
    if (!activeRef.current) return;
    try {
      // frecuencia sube con proximidad: 600Hz lejos → 1400Hz cerca
      const freq = 600 + Math.round(pct * 800);
      // duración del pitido: 60ms lejos → 90ms cerca
      const dur = 60 + Math.round(pct * 30);
      // volumen sube con proximidad
      const vol = 0.3 + pct * 0.7;
      // intervalo entre pitidos: 2000ms lejos → 120ms cerca
      const interval = Math.max(120, 2000 - Math.round(pct * 1880));

      const uri = generateBeepWav(freq, dur, vol);
      const { sound } = await Audio.Sound.createAsync({ uri }, { volume: vol });
      soundRef.current = sound;
      await sound.playAsync();

      timerRef.current = setTimeout(async () => {
        try { await sound.unloadAsync(); } catch {}
        if (activeRef.current) scheduleBeep(pct);
      }, interval);
    } catch {}
  }, []);

  useEffect(() => {
    if (!scanning || !trackedDevice) { stopBeeps(); return; }
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false });
    activeRef.current = true;
    scheduleBeep(trackedDevice.percent);
    return stopBeeps;
  }, [trackedDevice?.id, scanning]);

  // actualizar cadencia sin reiniciar cuando cambia el porcentaje
  useEffect(() => {
    if (!trackedDevice || !activeRef.current) return;
    // el scheduleBeep usa el pct en closure, se auto-actualiza en el siguiente ciclo
  }, [trackedDevice?.percent]);

  return stopBeeps;
}

// ── Radar ──────────────────────────────────────────────────────────────────────
function RadarDisplay({ devices, trackedId, sweepAngle }) {
  const rings = [0.25, 0.5, 0.75, 1.0];
  return (
    <View style={[styles.radarContainer, { width: RADAR_SIZE, height: RADAR_SIZE }]}>
      <View style={[styles.radarBg, { borderRadius: RADAR_R }]} />
      {rings.map((r, i) => (
        <View key={i} style={[styles.radarRing, {
          width: RADAR_SIZE * r, height: RADAR_SIZE * r,
          borderRadius: RADAR_SIZE * r / 2,
          left: RADAR_R - RADAR_SIZE * r / 2,
          top: RADAR_R - RADAR_SIZE * r / 2,
        }]} />
      ))}
      <View style={[styles.radarLine, { width: RADAR_SIZE, height: 1, top: RADAR_R - 0.5, left: 0 }]} />
      <View style={[styles.radarLine, { width: 1, height: RADAR_SIZE, top: 0, left: RADAR_R - 0.5 }]} />
      <Animated.View style={[styles.sweepLine, {
        width: RADAR_R, left: RADAR_R, top: RADAR_R - 1,
        transform: [{ rotate: sweepAngle.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
      }]} />
      {Array.from(devices.values()).map(dev => {
        const pct = rssiToPercent(avg(dev.rssiHistory));
        const angle = strToAngle(dev.id);
        const pos = rssiToRadarPos(pct, angle);
        const isTracked = dev.id === trackedId;
        const blipSize = isTracked ? 14 : 9;
        return (
          <View key={dev.id} style={[styles.blip, {
            width: blipSize, height: blipSize, borderRadius: blipSize / 2,
            left: pos.x - blipSize / 2, top: pos.y - blipSize / 2,
            backgroundColor: isTracked ? '#00ff41' : '#00cc33',
            shadowColor: '#00ff41', shadowOpacity: isTracked ? 1 : 0.5, shadowRadius: isTracked ? 10 : 4,
          }]} />
        );
      })}
      <Text style={[styles.radarLabel, { top: RADAR_R - RADAR_SIZE*0.25/2 - 13, left: RADAR_R + 4 }]}>~5m</Text>
      <Text style={[styles.radarLabel, { top: RADAR_R - RADAR_SIZE*0.5/2 - 13, left: RADAR_R + 4 }]}>~15m</Text>
      <Text style={[styles.radarLabel, { top: RADAR_R - RADAR_SIZE*0.75/2 - 13, left: RADAR_R + 4 }]}>~30m</Text>
    </View>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  const manager = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState(new Map());
  const [trackedId, setTrackedId] = useState(null);
  const [trackedDevice, setTrackedDevice] = useState(null);
  const [permissionsOk, setPermissionsOk] = useState(false);
  const [showList, setShowList] = useState(false);
  const scanRef = useRef(false);
  const sweepAngle = useRef(new Animated.Value(0)).current;
  const sweepAnim = useRef(null);
  const prevTrendRef = useRef('estable');

  useTrackerSound(trackedDevice, scanning);

  const requestPermissions = async () => {
    if (Platform.OS !== 'android') { setPermissionsOk(true); return; }
    try {
      const grants = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      const ok = Object.values(grants).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
      setPermissionsOk(ok);
      if (!ok) Alert.alert('Permisos necesarios', 'Activa Bluetooth y Ubicación en Configuración.');
    } catch { setPermissionsOk(false); }
  };

  useEffect(() => {
    manager.current = new BleManager();
    requestPermissions();
    activateKeepAwakeAsync();
    return () => { manager.current?.destroy(); deactivateKeepAwake(); };
  }, []);

  useEffect(() => {
    if (scanning) {
      sweepAngle.setValue(0);
      sweepAnim.current = Animated.loop(
        Animated.timing(sweepAngle, { toValue: 1, duration: 2500, useNativeDriver: false })
      );
      sweepAnim.current.start();
    } else {
      sweepAnim.current?.stop();
    }
    return () => sweepAnim.current?.stop();
  }, [scanning]);

  const startScan = useCallback(() => {
    if (!manager.current || !permissionsOk) return;
    scanRef.current = true;
    setScanning(true);
    const doScan = () => {
      if (!scanRef.current) return;
      manager.current.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
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
            name: device.name || device.localName || `DEV-${device.id.slice(-4).toUpperCase()}`,
            rssi, rssiHistory: history, lastSeen: Date.now(),
          });
          return next;
        });
      });
      setTimeout(() => {
        if (!scanRef.current) return;
        manager.current.stopDeviceScan();
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
    setDevices(new Map());
  }, []);

  useEffect(() => {
    if (!trackedId) { setTrackedDevice(null); return; }
    const dev = devices.get(trackedId);
    if (!dev) return;
    const avgRssi = avg(dev.rssiHistory);
    const t = getTrend(dev.rssiHistory);
    if (t === 'acercando' && prevTrendRef.current !== 'acercando')
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    prevTrendRef.current = t;
    setTrackedDevice({ ...dev, avgRssi, percent: rssiToPercent(avgRssi), distance: rssiToDistance(avgRssi), trend: t });
  }, [devices, trackedId]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setDevices(prev => {
        const next = new Map(prev);
        for (const [id, d] of next) if (now - d.lastSeen > 15000) next.delete(id);
        return next;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const deviceList = Array.from(devices.values()).sort((a, b) => b.rssi - a.rssi);
  const count = deviceList.length;
  const trendColor = !trackedDevice ? GREEN :
    trackedDevice.trend === 'acercando' ? '#00ff41' :
    trackedDevice.trend === 'alejando' ? '#ff4444' : '#ffaa00';

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerModel}>MU-TH-UR 6000</Text>
        <Text style={styles.headerTitle}>MOTION TRACKER</Text>
        <View style={styles.headerLine} />
      </View>

      <View style={styles.radarWrapper}>
        <RadarDisplay devices={devices} trackedId={trackedId} sweepAngle={sweepAngle} />
        {!scanning && (
          <View style={[styles.radarOverlay, { borderRadius: RADAR_R }]}>
            <Text style={styles.radarOffText}>OFFLINE</Text>
          </View>
        )}
      </View>

      <View style={styles.infoPanel}>
        {trackedDevice ? (
          <>
            <View style={styles.infoPanelRow}>
              <View style={styles.infoCol}>
                <Text style={styles.infoKey}>TARGET</Text>
                <Text style={styles.infoVal} numberOfLines={1}>{trackedDevice.name}</Text>
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoKey}>DIST</Text>
                <Text style={[styles.infoValLg, { color: GREEN }]}>{trackedDevice.distance}</Text>
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoKey}>SIGNAL</Text>
                <Text style={[styles.infoValLg, { color: trendColor }]}>{Math.round(trackedDevice.avgRssi)} dBm</Text>
              </View>
            </View>
            <View style={styles.signalBarBg}>
              <View style={[styles.signalBarFill, {
                width: `${Math.round(trackedDevice.percent * 100)}%`,
                backgroundColor: trackedDevice.percent > 0.6 ? GREEN : trackedDevice.percent > 0.35 ? '#ffaa00' : '#ff4444',
              }]} />
            </View>
            <Text style={[styles.trendText, { color: trendColor }]}>
              {trackedDevice.trend === 'acercando' && '▲  ACERCÁNDOSE'}
              {trackedDevice.trend === 'alejando' && '▼  ALEJÁNDOSE'}
              {trackedDevice.trend === 'estable' && '●  POSICIÓN ESTABLE'}
            </Text>
          </>
        ) : (
          <Text style={styles.infoIdle}>
            {scanning ? `${count} SEÑALES DETECTADAS — SELECCIONA UN OBJETIVO` : 'SISTEMA EN ESPERA'}
          </Text>
        )}
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.btnMain, scanning && styles.btnMainActive]}
          onPress={scanning ? stopScan : startScan}
          disabled={!permissionsOk}
        >
          <Text style={[styles.btnMainText, scanning && { color: '#ff4444' }]}>
            {!permissionsOk ? 'SIN PERMISOS' : scanning ? '[ APAGAR ]' : '[ ACTIVAR ]'}
          </Text>
        </TouchableOpacity>
        {scanning && count > 0 && (
          <TouchableOpacity style={styles.btnSecondary} onPress={() => setShowList(v => !v)}>
            <Text style={styles.btnSecondaryText}>{showList ? '[ RADAR ]' : `[ ${count} SEÑALES ]`}</Text>
          </TouchableOpacity>
        )}
        {trackedId && (
          <TouchableOpacity style={styles.btnCancel} onPress={() => setTrackedId(null)}>
            <Text style={styles.btnCancelText}>[ SOLTAR ]</Text>
          </TouchableOpacity>
        )}
      </View>

      {showList && scanning && (
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 20 }}>
          {deviceList.map(dev => {
            const pct = rssiToPercent(avg(dev.rssiHistory));
            const isTracked = dev.id === trackedId;
            return (
              <TouchableOpacity key={dev.id}
                style={[styles.devRow, isTracked && styles.devRowActive]}
                onPress={() => { setTrackedId(dev.id); setShowList(false); }}
              >
                <View style={styles.devBarBg}>
                  <View style={[styles.devBarFill, {
                    width: `${Math.round(pct * 100)}%`,
                    backgroundColor: pct > 0.6 ? GREEN : pct > 0.35 ? '#ffaa00' : '#ff4444',
                  }]} />
                </View>
                <Text style={styles.devName} numberOfLines={1}>{dev.name}</Text>
                <Text style={[styles.devRssi, { color: pct > 0.6 ? GREEN : pct > 0.35 ? '#ffaa00' : '#ff4444' }]}>
                  {dev.rssi} dBm
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>WEYLAND-YUTANI CORP  ·  UNIT 0{Math.floor(Math.random() * 9 + 1)}</Text>
      </View>
    </View>
  );
}

// ── estilos ────────────────────────────────────────────────────────────────────
const GREEN = '#00ff41';
const DIMGREEN = '#00551a';
const BG = '#000d00';
const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG, paddingTop: 44, paddingHorizontal: 12 },
  header: { alignItems: 'center', marginBottom: 8 },
  headerModel: { color: DIMGREEN, fontSize: 10, letterSpacing: 6, fontFamily: MONO },
  headerTitle: { color: GREEN, fontSize: 20, fontWeight: 'bold', letterSpacing: 8, fontFamily: MONO },
  headerLine: { width: '100%', height: 1, backgroundColor: DIMGREEN, marginTop: 6 },
  radarWrapper: { alignItems: 'center', marginVertical: 8, position: 'relative' },
  radarContainer: { position: 'relative' },
  radarBg: { position: 'absolute', width: '100%', height: '100%', backgroundColor: BG },
  radarRing: { position: 'absolute', borderWidth: 1, borderColor: '#003310' },
  radarLine: { position: 'absolute', backgroundColor: '#003310' },
  sweepLine: {
    position: 'absolute', height: 2, backgroundColor: GREEN, opacity: 0.85,
    shadowColor: GREEN, shadowOpacity: 1, shadowRadius: 10,
  },
  blip: { position: 'absolute', elevation: 5 },
  radarLabel: { position: 'absolute', color: '#005520', fontSize: 8, fontFamily: MONO },
  radarOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#000d00cc',
  },
  radarOffText: { color: '#ff4444', fontSize: 18, letterSpacing: 6, fontFamily: MONO },
  infoPanel: {
    borderWidth: 1, borderColor: DIMGREEN, borderRadius: 6,
    padding: 10, marginBottom: 10, backgroundColor: '#00080050', minHeight: 70,
  },
  infoPanelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  infoCol: { flex: 1, alignItems: 'center' },
  infoKey: { color: '#005520', fontSize: 8, letterSpacing: 2, fontFamily: MONO },
  infoVal: { color: GREEN, fontSize: 11, fontFamily: MONO },
  infoValLg: { fontSize: 15, fontWeight: 'bold', fontFamily: MONO },
  signalBarBg: { height: 6, backgroundColor: '#001a00', borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  signalBarFill: { height: '100%', borderRadius: 3 },
  trendText: { textAlign: 'center', fontSize: 11, letterSpacing: 3, fontFamily: MONO },
  infoIdle: { color: '#005520', fontSize: 11, textAlign: 'center', letterSpacing: 2, fontFamily: MONO, paddingVertical: 8 },
  controls: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  btnMain: { flex: 1, borderWidth: 1, borderColor: GREEN, borderRadius: 4, paddingVertical: 12, alignItems: 'center' },
  btnMainActive: { borderColor: '#ff4444' },
  btnMainText: { color: GREEN, fontSize: 13, letterSpacing: 3, fontFamily: MONO },
  btnSecondary: { flex: 1, borderWidth: 1, borderColor: '#ffaa00', borderRadius: 4, paddingVertical: 12, alignItems: 'center' },
  btnSecondaryText: { color: '#ffaa00', fontSize: 11, letterSpacing: 2, fontFamily: MONO },
  btnCancel: { flex: 1, borderWidth: 1, borderColor: '#ff4444', borderRadius: 4, paddingVertical: 12, alignItems: 'center' },
  btnCancelText: { color: '#ff4444', fontSize: 11, letterSpacing: 2, fontFamily: MONO },
  list: { flex: 1 },
  devRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: '#001a00', paddingVertical: 8 },
  devRowActive: { backgroundColor: '#001a00' },
  devBarBg: { width: 60, height: 4, backgroundColor: '#001a00', borderRadius: 2, marginRight: 8, overflow: 'hidden' },
  devBarFill: { height: '100%', borderRadius: 2 },
  devName: { flex: 1, color: GREEN, fontSize: 11, fontFamily: MONO },
  devRssi: { fontSize: 11, fontFamily: MONO },
  footer: { paddingVertical: 8, alignItems: 'center' },
  footerText: { color: '#002a0a', fontSize: 8, letterSpacing: 3, fontFamily: MONO },
});
