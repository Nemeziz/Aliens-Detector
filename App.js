import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput,
  Animated, Alert, Platform, PermissionsAndroid, Dimensions, Modal, ActivityIndicator,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');
const RADAR_SIZE = width * 0.85;
const RADAR_R = RADAR_SIZE / 2;
const RSSI_MIN = -100;
const RSSI_MAX = -45;
const HISTORY_SIZE = 10;
const SCAN_INTERVAL = 1200;
const CONTACTS_KEY = 'aliens_contacts';
const NAME_CACHE_KEY = 'aliens_name_cache';
const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';
const GREEN = '#00ff41';
const DIMGREEN = '#00551a';
const BG = '#000d00';

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
function shortId(id) {
  // Muestra solo los últimos 17 chars (formato MAC) o los últimos 8
  return id.length > 17 ? id.slice(-17) : id;
}

// ── Audio beep ────────────────────────────────────────────────────────────────
function generateBeepWav(frequency = 880, durationMs = 80, volume = 0.8) {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  ws(0,'RIFF'); view.setUint32(4,36+numSamples*2,true); ws(8,'WAVE'); ws(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true); ws(36,'data');
  view.setUint32(40,numSamples*2,true);
  for (let i = 0; i < numSamples; i++) {
    const a = Math.min(1,i/(sampleRate*0.005));
    const r = Math.max(0,1-(i-numSamples*0.7)/(numSamples*0.3));
    const s = Math.sin(2*Math.PI*frequency*(i/sampleRate))*volume*a*r;
    view.setInt16(44+i*2,Math.max(-32768,Math.min(32767,s*32767)),true);
  }
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

function useTrackerSound(trackedDevice, scanning) {
  const timerRef = useRef(null);
  const activeRef = useRef(false);
  const stopBeeps = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);
  const scheduleBeep = useCallback(async (pct) => {
    if (!activeRef.current) return;
    try {
      const freq = 600 + Math.round(pct * 800);
      const dur = 60 + Math.round(pct * 30);
      const vol = 0.3 + pct * 0.7;
      const interval = Math.max(120, 2000 - Math.round(pct * 1880));
      const { sound } = await Audio.Sound.createAsync({ uri: generateBeepWav(freq, dur, vol) }, { volume: vol });
      await sound.playAsync();
      timerRef.current = setTimeout(async () => {
        try { await sound.unloadAsync(); } catch {}
        if (activeRef.current) scheduleBeep(pct);
      }, interval);
    } catch {}
  }, []);
  useEffect(() => {
    if (!scanning || !trackedDevice) { stopBeeps(); return; }
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    activeRef.current = true;
    scheduleBeep(trackedDevice.percent);
    return stopBeeps;
  }, [trackedDevice?.id, scanning]);
  return stopBeeps;
}

// ── Radar ─────────────────────────────────────────────────────────────────────
function RadarDisplay({ devices, trackedId, sweepAngle, contacts }) {
  const rings = [0.25, 0.5, 0.75, 1.0];
  return (
    <View style={[styles.radarContainer, { width: RADAR_SIZE, height: RADAR_SIZE }]}>
      <View style={[styles.radarBg, { borderRadius: RADAR_R }]} />
      {rings.map((r, i) => (
        <View key={i} style={[styles.radarRing, {
          width: RADAR_SIZE * r, height: RADAR_SIZE * r,
          borderRadius: RADAR_SIZE * r / 2,
          left: RADAR_R - RADAR_SIZE * r / 2, top: RADAR_R - RADAR_SIZE * r / 2,
        }]} />
      ))}
      <View style={[styles.radarLine, { width: RADAR_SIZE, height: 1, top: RADAR_R - 0.5, left: 0 }]} />
      <View style={[styles.radarLine, { width: 1, height: RADAR_SIZE, top: 0, left: RADAR_R - 0.5 }]} />
      <Animated.View style={[styles.sweepLine, {
        width: RADAR_R, left: RADAR_R, top: RADAR_R - 1,
        transform: [{ rotate: sweepAngle.interpolate({ inputRange: [0,1], outputRange: ['0deg','360deg'] }) }],
      }]} />
      {Array.from(devices.values()).map(dev => {
        const pct = rssiToPercent(avg(dev.rssiHistory));
        const angle = strToAngle(dev.id);
        const pos = rssiToRadarPos(pct, angle);
        const isTracked = dev.id === trackedId;
        const contact = contacts[dev.id];
        const blipSize = isTracked ? 14 : contact ? 12 : 8;
        const blipColor = isTracked ? '#00ff41' : contact ? '#00ccff' : '#00cc33';
        return (
          <View key={dev.id}>
            <View style={[styles.blip, {
              width: blipSize, height: blipSize, borderRadius: blipSize/2,
              left: pos.x - blipSize/2, top: pos.y - blipSize/2,
              backgroundColor: blipColor, shadowColor: blipColor, shadowOpacity: 0.9, shadowRadius: isTracked ? 10 : 5,
            }]} />
            {contact && (
              <Text style={[styles.blipLabel, { left: pos.x+6, top: pos.y-8 }]}>
                {contact.alias.slice(0,6)}
              </Text>
            )}
          </View>
        );
      })}
      <Text style={[styles.radarLabel,{top:RADAR_R-RADAR_SIZE*.25/2-13,left:RADAR_R+4}]}>~5m</Text>
      <Text style={[styles.radarLabel,{top:RADAR_R-RADAR_SIZE*.5/2-13,left:RADAR_R+4}]}>~15m</Text>
      <Text style={[styles.radarLabel,{top:RADAR_R-RADAR_SIZE*.75/2-13,left:RADAR_R+4}]}>~30m</Text>
    </View>
  );
}

// ── Modal alta de contacto ─────────────────────────────────────────────────────
function SaveContactModal({ visible, device, nameCache, existingContact, onSave, onDelete, onClose, onResolveGatt, resolvingGatt }) {
  const [alias, setAlias] = useState('');
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [selectedName, setSelectedName] = useState('');

  // Construir lista de opciones de nombre
  const nameOptions = [];
  const seen = new Set();
  const addOption = (name, source) => {
    if (name && !seen.has(name)) { seen.add(name); nameOptions.push({ name, source }); }
  };

  if (device) {
    // 1. Nombre del advertising (BLE packet)
    if (device.name && !device.name.startsWith('DEV-') && !device.name.startsWith('[')) {
      addOption(device.name, 'Advertising BLE');
    }
    // 2. Nombre resuelto por GATT
    if (nameCache?.[device.id]) addOption(nameCache[device.id], 'GATT (nombre real)');
    // 3. Nombre previo del contacto
    if (existingContact?.name) addOption(existingContact.name, 'Guardado anterior');
    // 4. ID corto como fallback
    addOption(shortId(device.id), 'ID del dispositivo');
  }

  useEffect(() => {
    if (!visible || !device) return;
    setAlias(existingContact?.alias || nameOptions[0]?.name || '');
    setAlertEnabled(existingContact?.alertEnabled ?? true);
    setSelectedName(nameOptions[0]?.name || '');
  }, [visible, device?.id]);

  if (!device) return null;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          <Text style={styles.modalTitle}>
            {existingContact ? '[ EDITAR CONTACTO ]' : '[ NUEVO CONTACTO ]'}
          </Text>

          {/* ID del dispositivo */}
          <Text style={styles.modalDevId}>{shortId(device.id)}</Text>

          {/* Opciones de nombre detectadas */}
          <Text style={styles.modalLabel}>NOMBRE DETECTADO</Text>
          {nameOptions.map((opt, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.nameOption, selectedName === opt.name && styles.nameOptionSelected]}
              onPress={() => { setSelectedName(opt.name); setAlias(opt.name); }}
            >
              <Text style={[styles.nameOptionText, selectedName === opt.name && { color: GREEN }]}>
                {opt.name}
              </Text>
              <Text style={styles.nameOptionSource}>{opt.source}</Text>
            </TouchableOpacity>
          ))}

          {/* Botón resolver GATT */}
          <TouchableOpacity
            style={styles.btnGatt}
            onPress={() => onResolveGatt(device.id)}
            disabled={resolvingGatt}
          >
            {resolvingGatt
              ? <ActivityIndicator color={GREEN} size="small" />
              : <Text style={styles.btnGattText}>⟳ CONECTAR Y RESOLVER NOMBRE REAL</Text>
            }
          </TouchableOpacity>
          {resolvingGatt && <Text style={styles.gattHint}>Conectando al dispositivo...</Text>}

          {/* Alias personalizado */}
          <Text style={[styles.modalLabel, { marginTop: 12 }]}>ALIAS (NOMBRE EN TU LISTA)</Text>
          <TextInput
            style={styles.modalInput}
            value={alias}
            onChangeText={setAlias}
            placeholder="ej: Mamá, Juan, Esposa..."
            placeholderTextColor="#004410"
            maxLength={20}
          />

          {/* Toggle alerta */}
          <TouchableOpacity
            style={[styles.modalToggle, alertEnabled && styles.modalToggleOn]}
            onPress={() => setAlertEnabled(v => !v)}
          >
            <Text style={[styles.modalToggleText, alertEnabled && { color: GREEN }]}>
              {alertEnabled ? '🔔 ALERTA PROXIMIDAD: ON' : '🔕 ALERTA PROXIMIDAD: OFF'}
            </Text>
          </TouchableOpacity>

          <View style={styles.modalButtons}>
            {existingContact && (
              <TouchableOpacity style={styles.modalBtnDelete} onPress={() => onDelete(device.id)}>
                <Text style={styles.modalBtnDeleteText}>[ BORRAR ]</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.modalBtnCancel} onPress={onClose}>
              <Text style={styles.modalBtnCancelText}>[ CANCEL ]</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalBtnSave, !alias.trim() && { opacity: 0.4 }]}
              onPress={() => alias.trim() && onSave(device.id, alias.trim(), selectedName, alertEnabled)}
              disabled={!alias.trim()}
            >
              <Text style={styles.modalBtnSaveText}>[ GUARDAR ]</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Modal lista de contactos ───────────────────────────────────────────────────
function ContactsListModal({ visible, contacts, devices, onEdit, onClose, onTrack }) {
  const entries = Object.values(contacts);
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, { maxHeight: '80%' }]}>
          <Text style={styles.modalTitle}>[ CONTACTOS GUARDADOS ]</Text>
          {entries.length === 0 ? (
            <Text style={styles.modalEmpty}>
              Sin contactos aún.{'\n'}Escanea y mantén presionado un dispositivo.
            </Text>
          ) : (
            <ScrollView>
              {entries.map(c => {
                const dev = devices.get(c.id);
                const online = !!dev;
                const pct = dev ? rssiToPercent(avg(dev.rssiHistory)) : 0;
                return (
                  <View key={c.id} style={styles.contactRow}>
                    <View style={[styles.contactDot, { backgroundColor: online ? GREEN : '#333' }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.contactAlias}>{c.alias}</Text>
                      <Text style={styles.contactSub}>{c.name}  {c.alertEnabled ? '🔔' : '🔕'}</Text>
                      {online && (
                        <Text style={[styles.contactDist, { color: pct > 0.6 ? GREEN : pct > 0.35 ? '#ffaa00' : '#ff4444' }]}>
                          {rssiToDistance(avg(dev.rssiHistory))}  ·  {Math.round(avg(dev.rssiHistory))} dBm
                        </Text>
                      )}
                    </View>
                    {online && (
                      <TouchableOpacity style={styles.contactTrack} onPress={() => { onTrack(c.id); onClose(); }}>
                        <Text style={styles.contactTrackText}>RADAR</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity style={styles.contactEdit} onPress={() => onEdit(c.id)}>
                      <Text style={styles.contactEditText}>EDITAR</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </ScrollView>
          )}
          <TouchableOpacity style={[styles.modalBtnCancel, { marginTop: 10 }]} onPress={onClose}>
            <Text style={styles.modalBtnCancelText}>[ CERRAR ]</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── App principal ─────────────────────────────────────────────────────────────
export default function App() {
  const manager = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState(new Map());
  const [trackedId, setTrackedId] = useState(null);
  const [trackedDevice, setTrackedDevice] = useState(null);
  const [permissionsOk, setPermissionsOk] = useState(false);
  const [showList, setShowList] = useState(false);
  const [contacts, setContacts] = useState({});
  const [nameCache, setNameCache] = useState({});
  const [saveModal, setSaveModal] = useState({ visible: false, device: null });
  const [contactsModal, setContactsModal] = useState(false);
  const [resolvingGatt, setResolvingGatt] = useState(false);
  const scanRef = useRef(false);
  const sweepAngle = useRef(new Animated.Value(0)).current;
  const sweepAnim = useRef(null);
  const prevTrendRef = useRef('estable');

  useTrackerSound(trackedDevice, scanning);

  // ── persistencia ────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(CONTACTS_KEY),
      AsyncStorage.getItem(NAME_CACHE_KEY),
    ]).then(([c, n]) => {
      if (c) setContacts(JSON.parse(c));
      if (n) setNameCache(JSON.parse(n));
    });
  }, []);

  const persistContacts = useCallback(async (updated) => {
    setContacts(updated);
    await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(updated));
  }, []);

  const persistNameCache = useCallback(async (updated) => {
    setNameCache(updated);
    await AsyncStorage.setItem(NAME_CACHE_KEY, JSON.stringify(updated));
  }, []);

  // ── resolver nombre por GATT ────────────────────────────────────────────────
  const resolveGatt = useCallback(async (deviceId) => {
    if (!manager.current) return;
    setResolvingGatt(true);
    try {
      // pausar scan temporalmente para conectar
      manager.current.stopDeviceScan();
      const device = await manager.current.connectToDevice(deviceId, { timeout: 8000 });
      await device.discoverAllServicesAndCharacteristics();
      // leer característica Device Name (0x2A00) del servicio Generic Access (0x1800)
      const name = device.name || null;
      await device.cancelConnection();
      if (name) {
        const updated = { ...nameCache, [deviceId]: name };
        await persistNameCache(updated);
        // actualizar también en devices
        setDevices(prev => {
          const next = new Map(prev);
          const existing = next.get(deviceId);
          if (existing) next.set(deviceId, { ...existing, name });
          return next;
        });
        Alert.alert('✓ Nombre resuelto', `Dispositivo: ${name}`);
      } else {
        Alert.alert('Sin nombre', 'El dispositivo no expone nombre por GATT.');
      }
    } catch (e) {
      Alert.alert('Error GATT', 'No se pudo conectar. El dispositivo puede no estar disponible o rechaza conexiones.\n\nEscribe el nombre manualmente.');
    } finally {
      setResolvingGatt(false);
    }
  }, [nameCache, persistNameCache]);

  // ── guardar contacto ────────────────────────────────────────────────────────
  const handleSaveContact = useCallback((id, alias, name, alertEnabled) => {
    const updated = { ...contacts, [id]: { id, alias, name, alertEnabled } };
    persistContacts(updated);
    setSaveModal({ visible: false, device: null });
  }, [contacts, persistContacts]);

  const handleDeleteContact = useCallback((id) => {
    const updated = { ...contacts };
    delete updated[id];
    persistContacts(updated);
    setSaveModal({ visible: false, device: null });
  }, [contacts, persistContacts]);

  // ── alerta de proximidad para contactos ────────────────────────────────────
  useEffect(() => {
    if (!scanning) return;
    const interval = setInterval(() => {
      for (const [id, dev] of devices) {
        const contact = contacts[id];
        if (!contact?.alertEnabled) continue;
        if (rssiToPercent(avg(dev.rssiHistory)) > 0.55) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          break;
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [scanning, devices, contacts]);

  // ── permisos ────────────────────────────────────────────────────────────────
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

  // ── sweep ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (scanning) {
      sweepAngle.setValue(0);
      sweepAnim.current = Animated.loop(
        Animated.timing(sweepAngle, { toValue: 1, duration: 2500, useNativeDriver: false })
      );
      sweepAnim.current.start();
    } else { sweepAnim.current?.stop(); }
    return () => sweepAnim.current?.stop();
  }, [scanning]);

  // ── BLE scan ────────────────────────────────────────────────────────────────
  const startScan = useCallback(() => {
    if (!manager.current || !permissionsOk) return;
    scanRef.current = true;
    setScanning(true);
    const doScan = () => {
      if (!scanRef.current) return;
      manager.current.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
        if (error || !device) return;
        const rssi = device.rssi ?? -100;
        // resolver nombre: advertising > cache GATT > ID corto
        const resolvedName = device.name || device.localName || nameCache[device.id] || `DEV-${device.id.slice(-4).toUpperCase()}`;
        // si el cache tiene nombre y el dispositivo no lo anuncia, actualizar cache
        if ((device.name || device.localName) && !nameCache[device.id]) {
          const n = device.name || device.localName;
          setNameCache(prev => {
            if (prev[device.id] === n) return prev;
            const updated = { ...prev, [device.id]: n };
            AsyncStorage.setItem(NAME_CACHE_KEY, JSON.stringify(updated));
            return updated;
          });
        }
        setDevices(prev => {
          const next = new Map(prev);
          const existing = next.get(device.id);
          const history = existing
            ? [...existing.rssiHistory.slice(-(HISTORY_SIZE - 1)), rssi] : [rssi];
          next.set(device.id, {
            id: device.id,
            name: resolvedName,
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
  }, [permissionsOk, nameCache]);

  const stopScan = useCallback(() => {
    scanRef.current = false;
    setScanning(false);
    manager.current?.stopDeviceScan();
    setTrackedId(null);
    setTrackedDevice(null);
    setDevices(new Map());
  }, []);

  // ── tracked ─────────────────────────────────────────────────────────────────
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
  const contactCount = Object.keys(contacts).length;
  const contactsOnline = Object.values(contacts).filter(c => devices.has(c.id)).length;
  const trendColor = !trackedDevice ? GREEN :
    trackedDevice.trend === 'acercando' ? GREEN :
    trackedDevice.trend === 'alejando' ? '#ff4444' : '#ffaa00';
  const trackedContact = trackedId ? contacts[trackedId] : null;

  // nombre a mostrar en el panel
  const displayName = trackedContact
    ? `${trackedContact.alias}`
    : trackedDevice?.name || '';

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerModel}>MU-TH-UR 6000</Text>
        <Text style={styles.headerTitle}>MOTION TRACKER</Text>
        <View style={styles.headerLine} />
      </View>

      <View style={styles.radarWrapper}>
        <RadarDisplay devices={devices} trackedId={trackedId} sweepAngle={sweepAngle} contacts={contacts} />
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
                <Text style={[styles.infoVal, trackedContact && { color: '#00ccff' }]} numberOfLines={1}>
                  {displayName}
                </Text>
                {trackedContact && <Text style={styles.infoSubVal} numberOfLines={1}>{trackedDevice.name}</Text>}
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
            <View style={styles.trendRow}>
              <Text style={[styles.trendText, { color: trendColor }]}>
                {trackedDevice.trend === 'acercando' && '▲  ACERCÁNDOSE'}
                {trackedDevice.trend === 'alejando' && '▼  ALEJÁNDOSE'}
                {trackedDevice.trend === 'estable' && '●  POSICIÓN ESTABLE'}
              </Text>
              <TouchableOpacity style={styles.btnSaveInline}
                onPress={() => setSaveModal({ visible: true, device: trackedDevice })}>
                <Text style={styles.btnSaveInlineText}>
                  {contacts[trackedId] ? '✎ EDITAR' : '＋ GUARDAR'}
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <Text style={styles.infoIdle}>
            {scanning
              ? `${count} SEÑALES  ·  ${contactsOnline}/${contactCount} CONTACTOS ONLINE`
              : 'SISTEMA EN ESPERA'}
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
        <TouchableOpacity
          style={[styles.btnContacts, contactsOnline > 0 && styles.btnContactsActive]}
          onPress={() => setContactsModal(true)}
        >
          <Text style={[styles.btnContactsText, contactsOnline > 0 && { color: '#00ccff' }]}>
            {contactCount > 0 ? `[ ${contactsOnline > 0 ? '●' : '○'} ${contactCount} ]` : '[ LISTA ]'}
          </Text>
        </TouchableOpacity>
      </View>

      {scanning && (
        <View style={[styles.controls, { marginTop: -2 }]}>
          {count > 0 && (
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
      )}

      {showList && scanning && (
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 20 }}>
          {deviceList.map(dev => {
            const pct = rssiToPercent(avg(dev.rssiHistory));
            const isTracked = dev.id === trackedId;
            const contact = contacts[dev.id];
            const barColor = pct > 0.6 ? GREEN : pct > 0.35 ? '#ffaa00' : '#ff4444';
            const cachedName = nameCache[dev.id];
            return (
              <TouchableOpacity key={dev.id}
                style={[styles.devRow, isTracked && styles.devRowActive, contact && styles.devRowContact]}
                onPress={() => { setTrackedId(dev.id); setShowList(false); }}
                onLongPress={() => setSaveModal({ visible: true, device: dev })}
              >
                <View style={styles.devBarBg}>
                  <View style={[styles.devBarFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: barColor }]} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.devName, contact && { color: '#00ccff' }]} numberOfLines={1}>
                    {contact ? contact.alias : (dev.name || cachedName || shortId(dev.id))}
                  </Text>
                  {(contact || cachedName) && (
                    <Text style={styles.devSubName} numberOfLines={1}>
                      {contact ? dev.name : `GATT: ${cachedName}`}
                    </Text>
                  )}
                </View>
                <Text style={styles.devBadge}>{contact?.alertEnabled ? '🔔' : ''}</Text>
                <Text style={[styles.devRssi, { color: barColor }]}>{dev.rssi} dBm</Text>
              </TouchableOpacity>
            );
          })}
          <Text style={styles.listHint}>Mantén presionado → guardar contacto</Text>
        </ScrollView>
      )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>WEYLAND-YUTANI CORP  ·  v2.1</Text>
      </View>

      <SaveContactModal
        visible={saveModal.visible}
        device={saveModal.device}
        nameCache={nameCache}
        existingContact={saveModal.device ? contacts[saveModal.device.id] : null}
        onSave={handleSaveContact}
        onDelete={handleDeleteContact}
        onClose={() => setSaveModal({ visible: false, device: null })}
        onResolveGatt={resolveGatt}
        resolvingGatt={resolvingGatt}
      />
      <ContactsListModal
        visible={contactsModal}
        contacts={contacts}
        devices={devices}
        onEdit={(id) => {
          const dev = devices.get(id) || { id, name: contacts[id]?.name || nameCache[id] || id };
          setContactsModal(false);
          setSaveModal({ visible: true, device: dev });
        }}
        onClose={() => setContactsModal(false)}
        onTrack={(id) => { setTrackedId(id); setContactsModal(false); }}
      />
    </View>
  );
}

// ── estilos ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG, paddingTop: 44, paddingHorizontal: 12 },
  header: { alignItems: 'center', marginBottom: 8 },
  headerModel: { color: DIMGREEN, fontSize: 10, letterSpacing: 6, fontFamily: MONO },
  headerTitle: { color: GREEN, fontSize: 20, fontWeight: 'bold', letterSpacing: 8, fontFamily: MONO },
  headerLine: { width: '100%', height: 1, backgroundColor: DIMGREEN, marginTop: 6 },
  radarWrapper: { alignItems: 'center', marginVertical: 6, position: 'relative' },
  radarContainer: { position: 'relative' },
  radarBg: { position: 'absolute', width: '100%', height: '100%', backgroundColor: BG },
  radarRing: { position: 'absolute', borderWidth: 1, borderColor: '#003310' },
  radarLine: { position: 'absolute', backgroundColor: '#003310' },
  sweepLine: { position: 'absolute', height: 2, backgroundColor: GREEN, opacity: 0.85, shadowColor: GREEN, shadowOpacity: 1, shadowRadius: 10 },
  blip: { position: 'absolute', elevation: 5 },
  blipLabel: { position: 'absolute', color: '#00ccff', fontSize: 7, fontFamily: MONO },
  radarLabel: { position: 'absolute', color: '#005520', fontSize: 8, fontFamily: MONO },
  radarOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000d00cc' },
  radarOffText: { color: '#ff4444', fontSize: 18, letterSpacing: 6, fontFamily: MONO },
  infoPanel: { borderWidth: 1, borderColor: DIMGREEN, borderRadius: 6, padding: 10, marginBottom: 8, backgroundColor: '#00080050', minHeight: 65 },
  infoPanelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  infoCol: { flex: 1, alignItems: 'center' },
  infoKey: { color: '#005520', fontSize: 8, letterSpacing: 2, fontFamily: MONO },
  infoVal: { color: GREEN, fontSize: 11, fontFamily: MONO },
  infoSubVal: { color: '#005520', fontSize: 9, fontFamily: MONO },
  infoValLg: { fontSize: 15, fontWeight: 'bold', fontFamily: MONO },
  signalBarBg: { height: 5, backgroundColor: '#001a00', borderRadius: 3, overflow: 'hidden', marginBottom: 5 },
  signalBarFill: { height: '100%', borderRadius: 3 },
  trendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  trendText: { fontSize: 11, letterSpacing: 2, fontFamily: MONO },
  btnSaveInline: { borderWidth: 1, borderColor: '#005520', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
  btnSaveInlineText: { color: '#00aa33', fontSize: 9, fontFamily: MONO },
  infoIdle: { color: '#005520', fontSize: 11, textAlign: 'center', letterSpacing: 2, fontFamily: MONO, paddingVertical: 8 },
  controls: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  btnMain: { flex: 2, borderWidth: 1, borderColor: GREEN, borderRadius: 4, paddingVertical: 11, alignItems: 'center' },
  btnMainActive: { borderColor: '#ff4444' },
  btnMainText: { color: GREEN, fontSize: 13, letterSpacing: 3, fontFamily: MONO },
  btnContacts: { flex: 1, borderWidth: 1, borderColor: DIMGREEN, borderRadius: 4, paddingVertical: 11, alignItems: 'center' },
  btnContactsActive: { borderColor: '#00ccff' },
  btnContactsText: { color: DIMGREEN, fontSize: 12, letterSpacing: 1, fontFamily: MONO },
  btnSecondary: { flex: 1, borderWidth: 1, borderColor: '#ffaa00', borderRadius: 4, paddingVertical: 10, alignItems: 'center' },
  btnSecondaryText: { color: '#ffaa00', fontSize: 11, letterSpacing: 1, fontFamily: MONO },
  btnCancel: { flex: 1, borderWidth: 1, borderColor: '#ff4444', borderRadius: 4, paddingVertical: 10, alignItems: 'center' },
  btnCancelText: { color: '#ff4444', fontSize: 11, letterSpacing: 1, fontFamily: MONO },
  list: { flex: 1 },
  devRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: '#001a00', paddingVertical: 7 },
  devRowActive: { backgroundColor: '#001a00' },
  devRowContact: { borderLeftWidth: 2, borderLeftColor: '#00ccff', paddingLeft: 6 },
  devBarBg: { width: 50, height: 4, backgroundColor: '#001a00', borderRadius: 2, marginRight: 8, overflow: 'hidden' },
  devBarFill: { height: '100%', borderRadius: 2 },
  devName: { color: GREEN, fontSize: 11, fontFamily: MONO },
  devSubName: { color: '#005520', fontSize: 9, fontFamily: MONO },
  devBadge: { fontSize: 10, marginRight: 4 },
  devRssi: { fontSize: 11, fontFamily: MONO },
  listHint: { color: '#003310', fontSize: 9, textAlign: 'center', marginTop: 8, fontFamily: MONO },
  footer: { paddingVertical: 6, alignItems: 'center' },
  footerText: { color: '#002a0a', fontSize: 8, letterSpacing: 3, fontFamily: MONO },
  // modal
  modalOverlay: { flex: 1, backgroundColor: '#000d00dd', justifyContent: 'center', alignItems: 'center', padding: 16 },
  modalBox: { backgroundColor: '#000f00', borderWidth: 1, borderColor: GREEN, borderRadius: 8, padding: 18, width: '100%' },
  modalTitle: { color: GREEN, fontSize: 13, letterSpacing: 3, fontFamily: MONO, textAlign: 'center', marginBottom: 10 },
  modalDevId: { color: '#003310', fontSize: 9, fontFamily: MONO, textAlign: 'center', marginBottom: 10 },
  modalLabel: { color: DIMGREEN, fontSize: 9, letterSpacing: 2, fontFamily: MONO, marginBottom: 6 },
  nameOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#002a00', borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 4 },
  nameOptionSelected: { borderColor: GREEN, backgroundColor: '#001a00' },
  nameOptionText: { color: '#009933', fontSize: 12, fontFamily: MONO, flex: 1 },
  nameOptionSource: { color: '#005520', fontSize: 8, fontFamily: MONO },
  btnGatt: { borderWidth: 1, borderColor: '#005520', borderRadius: 4, paddingVertical: 9, alignItems: 'center', marginTop: 6 },
  btnGattText: { color: '#00aa33', fontSize: 10, fontFamily: MONO, letterSpacing: 1 },
  gattHint: { color: '#005520', fontSize: 9, fontFamily: MONO, textAlign: 'center', marginTop: 4 },
  modalInput: { borderWidth: 1, borderColor: DIMGREEN, borderRadius: 4, color: GREEN, fontFamily: MONO, fontSize: 16, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10, backgroundColor: '#000d00' },
  modalToggle: { borderWidth: 1, borderColor: '#003310', borderRadius: 4, paddingVertical: 10, alignItems: 'center', marginBottom: 4 },
  modalToggleOn: { borderColor: GREEN, backgroundColor: '#001a00' },
  modalToggleText: { color: '#005520', fontSize: 12, fontFamily: MONO },
  modalEmpty: { color: '#005520', fontSize: 11, fontFamily: MONO, textAlign: 'center', marginVertical: 20, lineHeight: 20 },
  modalButtons: { flexDirection: 'row', gap: 8, marginTop: 10 },
  modalBtnSave: { flex: 1, borderWidth: 1, borderColor: GREEN, borderRadius: 4, paddingVertical: 10, alignItems: 'center' },
  modalBtnSaveText: { color: GREEN, fontSize: 11, fontFamily: MONO },
  modalBtnCancel: { flex: 1, borderWidth: 1, borderColor: DIMGREEN, borderRadius: 4, paddingVertical: 10, alignItems: 'center' },
  modalBtnCancelText: { color: DIMGREEN, fontSize: 11, fontFamily: MONO },
  modalBtnDelete: { flex: 1, borderWidth: 1, borderColor: '#ff4444', borderRadius: 4, paddingVertical: 10, alignItems: 'center' },
  modalBtnDeleteText: { color: '#ff4444', fontSize: 11, fontFamily: MONO },
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#001a00' },
  contactDot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  contactAlias: { color: '#00ccff', fontSize: 14, fontFamily: MONO },
  contactSub: { color: '#005520', fontSize: 9, fontFamily: MONO, marginTop: 2 },
  contactDist: { fontSize: 10, fontFamily: MONO, marginTop: 2 },
  contactTrack: { borderWidth: 1, borderColor: GREEN, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4, marginRight: 6 },
  contactTrackText: { color: GREEN, fontSize: 9, fontFamily: MONO },
  contactEdit: { borderWidth: 1, borderColor: DIMGREEN, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  contactEditText: { color: DIMGREEN, fontSize: 9, fontFamily: MONO },
});
