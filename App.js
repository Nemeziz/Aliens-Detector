import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput,
  Animated, Alert, Platform, PermissionsAndroid, Dimensions, Modal,
  ActivityIndicator, NativeEventEmitter, NativeModules,
} from 'react-native';
import BleManager from 'react-native-ble-manager';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import RegisterMode from './RegisterMode';
import { parseAppleAdvertising, appleDisplayName, isSameAppleDevice } from './AppleFingerprint';
import ScanScreen from './ScanScreen';
// Background via expo-notifications (sin task-manager)
async function setupNotifications() {
  await Notifications.setNotificationChannelAsync('ble-tracker', {
    name: 'BLE Tracker',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
    enableVibrate: true,
  });
  await Notifications.setNotificationChannelAsync('ble-foreground', {
    name: 'Rastreo Activo',
    importance: Notifications.AndroidImportance.LOW,
    enableVibrate: false,
  });
  await Notifications.requestPermissionsAsync();
}
async function showForegroundNotification(names = []) {
  return Notifications.scheduleNotificationAsync({
    content: {
      title: '👾 MOTION TRACKER ACTIVO',
      body: `Buscando: ${names.join(', ')}`,
      android: { channelId: 'ble-foreground', ongoing: true, color: '#00ff41', priority: 'low' },
    },
    trigger: null,
  });
}
async function dismissForegroundNotification() {
  await Notifications.dismissAllNotificationsAsync();
}


const { width } = Dimensions.get('window');
const RADAR_SIZE = width * 0.85;
const RADAR_R = RADAR_SIZE / 2;
const RSSI_MIN = -100;
const RSSI_MAX = -45;
const HISTORY_SIZE = 10;
const SCAN_SECONDS = 10; // ciclo de scan en segundos
const CONTACTS_KEY = 'aliens_contacts';
const NAME_CACHE_KEY = 'aliens_name_cache';
const FINGERPRINT_KEY = 'aliens_fingerprints'; // MAC → fingerprint Apple
const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';
const GREEN = '#00ff41';
const DIMGREEN = '#00551a';
const BG = '#000d00';

const BleManagerEmitter = new NativeEventEmitter(NativeModules.BleManager);

// ── helpers ───────────────────────────────────────────────────────────────────
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
function shortId(id) { return id.length > 17 ? id.slice(-17) : id; }

// ── OUI database ──────────────────────────────────────────────────────────────
const OUI = {
  '28:6B:B4': { abbr: 'IPH', label: 'iPhone',   icon: '📱' },
  '68:DF:A5': { abbr: 'IPH', label: 'iPhone',   icon: '📱' },
  '61:AC:E9': { abbr: 'IPH', label: 'iPhone',   icon: '📱' },
  'A4:C3:F0': { abbr: 'IPH', label: 'iPhone',   icon: '📱' },
  'F0:DB:E2': { abbr: 'IPH', label: 'iPhone',   icon: '📱' },
  'DC:2C:26': { abbr: 'IPH', label: 'iPhone',   icon: '📱' },
  'F8:4D:89': { abbr: 'IPH', label: 'iPhone',   icon: '📱' },
  'BC:D0:74': { abbr: 'MAC', label: 'MacBook',  icon: '💻' },
  'A8:51:AB': { abbr: 'APD', label: 'AirPods',  icon: '🎧' },
  'F4:7B:5E': { abbr: 'SAM', label: 'Samsung',  icon: '📱' },
  '8C:F5:A3': { abbr: 'SAM', label: 'Samsung',  icon: '📱' },
  'DC:71:96': { abbr: 'SAM', label: 'Samsung',  icon: '📱' },
  'CC:4B:73': { abbr: 'SAM', label: 'Samsung',  icon: '📱' },
  'A0:82:1F': { abbr: 'SGW', label: 'Galaxy W', icon: '⌚' },
  '78:BD:BC': { abbr: 'SBD', label: 'Buds',     icon: '🎧' },
  'AC:C1:EE': { abbr: 'XIA', label: 'Xiaomi',   icon: '📱' },
  '64:B4:73': { abbr: 'XIA', label: 'Xiaomi',   icon: '📱' },
  '28:6C:07': { abbr: 'XIA', label: 'Xiaomi',   icon: '📱' },
  'F8:A2:D6': { abbr: 'MIB', label: 'Mi Band',  icon: '⌚' },
  'F4:85:89': { abbr: 'PIX', label: 'Pixel',    icon: '📱' },
  'A4:77:33': { abbr: 'PIX', label: 'Pixel',    icon: '📱' },
  'AC:E0:10': { abbr: 'HUA', label: 'Huawei',   icon: '📱' },
  '54:92:BE': { abbr: 'HUW', label: 'Huawei W', icon: '⌚' },
  '94:65:2D': { abbr: 'OPL', label: 'OnePlus',  icon: '📱' },
  'AC:37:43': { abbr: 'MOT', label: 'Moto',     icon: '📱' },
  '9C:D2:1E': { abbr: 'MOT', label: 'Moto',     icon: '📱' },
  'C4:36:6C': { abbr: 'LG',  label: 'LG',       icon: '📱' },
  '00:17:EF': { abbr: 'SNY', label: 'Sony',     icon: '🎧' },
  'A8:9C:ED': { abbr: 'SNY', label: 'Sony',     icon: '📱' },
  'AC:87:A3': { abbr: 'AMZ', label: 'Amazfit',  icon: '⌚' },
  'C4:BE:84': { abbr: 'FIT', label: 'Fitbit',   icon: '⌚' },
  '00:1D:0A': { abbr: 'GAR', label: 'Garmin',   icon: '⌚' },
  '00:15:5D': { abbr: 'MSF', label: 'PC',       icon: '💻' },
};

// Íconos y abreviaturas por vendor string (manufacturer data)
const MF_VENDOR_MAP = {
  'Apple':     { icon: '🍎', abbr: 'APL' },
  'Microsoft': { icon: '🪟', abbr: 'MSF' },
  'Samsung':   { icon: '📱', abbr: 'SAM' },
  'Xiaomi':    { icon: '📱', abbr: 'XIA' },
  'Huawei':    { icon: '📱', abbr: 'HUA' },
  'Google':    { icon: '📱', abbr: 'PIX' },
  'Sony':      { icon: '📱', abbr: 'SNY' },
  'Garmin':    { icon: '⌚', abbr: 'GAR' },
  'Amazfit':   { icon: '⌚', abbr: 'AMZ' },
  'Nordic':    { icon: '📡', abbr: 'NRF' },
};

function resolveDevice(id, advertisedName, mfVendor = null) {
  const mac = id.replace(/-/g, ':').toUpperCase();
  const oui = mac.substring(0, 8);
  const fullMac = mac.length >= 17 ? mac.slice(-17) : mac;
  const ouiEntry = OUI[oui];
  const firstByte = parseInt(mac.split(':')[0] || '0', 16);
  const isRandom = !!(firstByte & 0x02);

  // Prioridad: nombre anunciado > OUI > manufacturer data > MAC
  let displayName = advertisedName;
  let vendorInfo = ouiEntry;

  // Si no hay OUI pero sí manufacturer vendor, usarlo
  if (!ouiEntry && mfVendor) {
    vendorInfo = MF_VENDOR_MAP[mfVendor] || { icon: '📡', abbr: mfVendor.slice(0,3).toUpperCase() };
  }

  if (!displayName || displayName.startsWith('DEV-') || displayName.startsWith('[')) {
    if (vendorInfo) {
      displayName = `${vendorInfo.icon} ${vendorInfo.abbr} ${fullMac}`;
    } else if (isRandom) {
      displayName = `🔀 ${fullMac}`;
    } else {
      displayName = fullMac;
    }
  }

  const ouiLabel = ouiEntry
    ? `${ouiEntry.icon} ${ouiEntry.label}`
    : mfVendor
      ? `${MF_VENDOR_MAP[mfVendor]?.icon || '📡'} ${mfVendor}`
      : isRandom ? '🔀 MAC Privada' : '';

  return { displayName, ouiLabel, ouiEntry, vendorInfo, fullMac, isRandom, mfVendor };
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
    const a = Math.min(1, i/(sampleRate*0.005));
    const r = Math.max(0, 1-(i-numSamples*0.7)/(numSamples*0.3));
    const s = Math.sin(2*Math.PI*frequency*(i/sampleRate))*volume*a*r;
    view.setInt16(44+i*2, Math.max(-32768,Math.min(32767,s*32767)), true);
  }
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

function useTrackerSound(trackedDevice, scanning) {
  const timerRef = useRef(null);
  const activeRef = useRef(false);
  const pctRef = useRef(0); // siempre tiene el porcentaje actual

  // actualizar pctRef cada vez que cambia el porcentaje
  useEffect(() => {
    if (trackedDevice) pctRef.current = trackedDevice.percent;
  }, [trackedDevice?.percent]);

  const stopBeeps = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const scheduleBeep = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      const pct = pctRef.current; // leer el valor ACTUAL, no el del closure
      const freq = 600 + Math.round(pct * 800);
      const dur = 60 + Math.round(pct * 30);
      const vol = 0.3 + pct * 0.7;
      const interval = Math.max(120, 2000 - Math.round(pct * 1880));
      const { sound } = await Audio.Sound.createAsync(
        { uri: generateBeepWav(freq, dur, vol) },
        { volume: vol }
      );
      await sound.playAsync();
      timerRef.current = setTimeout(async () => {
        try { await sound.unloadAsync(); } catch {}
        if (activeRef.current) scheduleBeep(); // sin argumento — lee pctRef cada vez
      }, interval);
    } catch {}
  }, []); // sin dependencias — siempre lee pctRef.current

  useEffect(() => {
    if (!scanning || !trackedDevice) { stopBeeps(); return; }
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    activeRef.current = true;
    pctRef.current = trackedDevice.percent;
    scheduleBeep();
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
          width: RADAR_SIZE*r, height: RADAR_SIZE*r,
          borderRadius: RADAR_SIZE*r/2,
          left: RADAR_R-RADAR_SIZE*r/2, top: RADAR_R-RADAR_SIZE*r/2,
        }]} />
      ))}
      <View style={[styles.radarLine, { width: RADAR_SIZE, height: 1, top: RADAR_R-0.5, left: 0 }]} />
      <View style={[styles.radarLine, { width: 1, height: RADAR_SIZE, top: 0, left: RADAR_R-0.5 }]} />
      <Animated.View style={[styles.sweepLine, {
        width: RADAR_R, left: RADAR_R, top: RADAR_R-1,
        transform: [{ rotate: sweepAngle.interpolate({ inputRange:[0,1], outputRange:['0deg','360deg'] }) }],
      }]} />
      {Array.from(devices.values()).map(dev => {
        const pct = rssiToPercent(avg(dev.rssiHistory));
        const angle = strToAngle(dev.id);
        const pos = rssiToRadarPos(pct, angle);
        const isTracked = dev.id === trackedId;
        const contact = contacts[dev.id];
        const sz = isTracked ? 14 : contact ? 12 : 8;
        const color = isTracked ? '#00ff41' : contact ? '#00ccff' : '#00cc33';
        return (
          <View key={dev.id}>
            <View style={[styles.blip, {
              width: sz, height: sz, borderRadius: sz/2,
              left: pos.x-sz/2, top: pos.y-sz/2,
              backgroundColor: color, shadowColor: color,
              shadowOpacity: 0.9, shadowRadius: isTracked ? 10 : 5,
            }]} />
            {contact && (
              <Text style={[styles.blipLabel, { left: pos.x+6, top: pos.y-8 }]}>
                {contact.alias.slice(0,8)}
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

// ── Modal guardar contacto ────────────────────────────────────────────────────
function SaveContactModal({ visible, device, nameCache, existingContact, onSave, onDelete, onClose, onResolveGatt, resolvingGatt }) {
  const [alias, setAlias] = useState('');
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [selectedName, setSelectedName] = useState('');

  const nameOptions = [];
  const seen = new Set();
  const add = (name, source) => { if (name && !seen.has(name)) { seen.add(name); nameOptions.push({ name, source }); } };
  if (device) {
    if (device.name && !device.name.startsWith('🔀') && device.name.length > 4) add(device.name, 'Nombre del dispositivo');
    if (nameCache?.[device.id]) add(nameCache[device.id], 'Nombre resuelto (GATT)');
    if (existingContact?.name) add(existingContact.name, 'Guardado anterior');
    const { displayName, ouiLabel } = resolveDevice(device.id, null);
    if (ouiLabel) add(displayName, `Fabricante: ${ouiLabel}`);
    add(shortId(device.id), 'MAC address');
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
        <ScrollView contentContainerStyle={{ flexGrow:1, justifyContent:'center', padding:16 }}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{existingContact ? '[ EDITAR ]' : '[ NUEVO CONTACTO ]'}</Text>
            <Text style={styles.modalDevId}>{shortId(device.id)}</Text>
            <Text style={styles.modalLabel}>NOMBRE DETECTADO — toca para seleccionar</Text>
            {nameOptions.map((opt, i) => (
              <TouchableOpacity key={i}
                style={[styles.nameOption, selectedName===opt.name && styles.nameOptionSelected]}
                onPress={() => { setSelectedName(opt.name); setAlias(opt.name); }}
              >
                <Text style={[styles.nameOptionText, selectedName===opt.name && {color:GREEN}]} numberOfLines={1}>{opt.name}</Text>
                <Text style={styles.nameOptionSource}>{opt.source}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.btnGatt} onPress={() => onResolveGatt(device.id)} disabled={resolvingGatt}>
              {resolvingGatt
                ? <ActivityIndicator color={GREEN} size="small" />
                : <Text style={styles.btnGattText}>⟳ CONECTAR Y RESOLVER NOMBRE (GATT)</Text>}
            </TouchableOpacity>
            <Text style={[styles.modalLabel, {marginTop:12}]}>ALIAS PERSONAL</Text>
            <TextInput
              style={styles.modalInput}
              value={alias}
              onChangeText={setAlias}
              placeholder="ej: Mamá, Juan, Esposa..."
              placeholderTextColor="#004410"
              maxLength={20}
            />
            <TouchableOpacity
              style={[styles.modalToggle, alertEnabled && styles.modalToggleOn]}
              onPress={() => setAlertEnabled(v => !v)}
            >
              <Text style={[styles.modalToggleText, alertEnabled && {color:GREEN}]}>
                {alertEnabled ? '🔔 ALERTA PROXIMIDAD: ON' : '🔕 ALERTA PROXIMIDAD: OFF'}
              </Text>
            </TouchableOpacity>
            {alertEnabled && <Text style={styles.modalHint}>Notificación cuando esté cerca, aunque la pantalla esté apagada</Text>}
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
                style={[styles.modalBtnSave, !alias.trim() && {opacity:0.4}]}
                onPress={() => alias.trim() && onSave(device.id, alias.trim(), selectedName, alertEnabled)}
                disabled={!alias.trim()}
              >
                <Text style={styles.modalBtnSaveText}>[ OK ]</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Modal contactos ───────────────────────────────────────────────────────────
function ContactsListModal({ visible, contacts, devices, onEdit, onClose, onTrack }) {
  const entries = Object.values(contacts);
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, {maxHeight:'85%', margin:16}]}>
          <Text style={styles.modalTitle}>[ CONTACTOS ]</Text>
          {entries.length === 0
            ? <Text style={styles.modalEmpty}>Sin contactos.{'\n'}Usa [ + REGISTRAR ] para agregar.</Text>
            : (
              <ScrollView>
                {entries.map(c => {
                  const dev = devices.get(c.id);
                  const online = !!dev;
                  const pct = dev ? rssiToPercent(avg(dev.rssiHistory)) : 0;
                  const distColor = pct>0.6 ? GREEN : pct>0.35 ? '#ffaa00' : '#ff4444';
                  return (
                    <View key={c.id} style={styles.contactRow}>
                      <View style={[styles.contactDot, {backgroundColor: online ? GREEN : '#1a1a1a'}]} />
                      <View style={{flex:1}}>
                        <View style={{flexDirection:'row', alignItems:'center', gap:6}}>
                          <Text style={styles.contactAlias}>{c.alias}</Text>
                          <Text style={{color: c.alertEnabled ? GREEN : '#333', fontSize:12}}>{c.alertEnabled ? '🔔' : '🔕'}</Text>
                        </View>
                        <Text style={styles.contactSub} numberOfLines={1}>{c.name}</Text>
                        {online
                          ? <Text style={[styles.contactDist, {color:distColor}]}>{rssiToDistance(avg(dev.rssiHistory))}  ·  {Math.round(avg(dev.rssiHistory))} dBm</Text>
                          : <Text style={[styles.contactSub, {color:'#222'}]}>OFFLINE</Text>
                        }
                      </View>
                      <View style={{gap:4}}>
                        {online && (
                          <TouchableOpacity style={styles.contactTrack} onPress={() => {onTrack(c.id); onClose();}}>
                            <Text style={styles.contactTrackText}>RADAR</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity style={styles.contactEdit} onPress={() => onEdit(c.id)}>
                          <Text style={styles.contactEditText}>EDITAR</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            )
          }
          <TouchableOpacity style={[styles.modalBtnCancel, {marginTop:10}]} onPress={onClose}>
            <Text style={styles.modalBtnCancelText}>[ CERRAR ]</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState(new Map());
  const [trackedId, setTrackedId] = useState(null);
  const [trackedDevice, setTrackedDevice] = useState(null);
  const [permissionsOk, setPermissionsOk] = useState(false);
  const [showList, setShowList] = useState(false);
  const [scanScreen, setScanScreen] = useState(false);
  const [contacts, setContacts] = useState({});
  const [nameCache, setNameCache] = useState({});
  const [fingerprintMap, setFingerprintMap] = useState({}); // fingerprint → contactId
  const [saveModal, setSaveModal] = useState({ visible: false, device: null });
  const [contactsModal, setContactsModal] = useState(false);
  const [resolvingGatt, setResolvingGatt] = useState(false);
  const [backgroundActive, setBackgroundActive] = useState(false);
  const [registerModal, setRegisterModal] = useState(false);
  const scanRef = useRef(false);
  const deviceOrderRef = useRef([]); // orden de aparición fijo
  const sweepAngle = useRef(new Animated.Value(0)).current;
  const sweepAnim = useRef(null);
  const prevTrendRef = useRef('estable');
  const listenersRef = useRef([]);

  useTrackerSound(trackedDevice, scanning);

  // ── init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    BleManager.start({ showAlert: false });
    requestPermissions();
    activateKeepAwakeAsync();
    setupNotifications();
    Promise.all([
      AsyncStorage.getItem(CONTACTS_KEY),
      AsyncStorage.getItem(NAME_CACHE_KEY),
      AsyncStorage.getItem(FINGERPRINT_KEY),
    ]).then(([c, n, fp]) => {
      if (c) setContacts(JSON.parse(c));
      if (n) setNameCache(JSON.parse(n));
      if (fp) setFingerprintMap(JSON.parse(fp));
    });
    setBackgroundActive(false);

    // ── listeners de ble-manager ─────────────────────────────────────────
    const onDiscover = BleManagerEmitter.addListener(
      'BleManagerDiscoverPeripheral',
      (peripheral) => {
        const rssi = peripheral.rssi ?? -100;
        const id = peripheral.id;
        // ble-manager sí devuelve peripheral.name para Classic y BLE
        const advName = peripheral.name || peripheral.advertising?.localName || null;

        // Leer manufacturer ID del advertising data para identificar fabricante
        const mfData = peripheral.advertising?.manufacturerData;
        let mfVendor = null;
        if (mfData) {
          // manufacturerData puede ser objeto {bytes:[]} o string hex
          let mfId = null;
          if (mfData.bytes && mfData.bytes.length >= 2) {
            mfId = mfData.bytes[0] | (mfData.bytes[1] << 8);
          } else if (typeof mfData === 'string' && mfData.length >= 4) {
            const b0 = parseInt(mfData.substring(0,2), 16);
            const b1 = parseInt(mfData.substring(2,4), 16);
            mfId = b0 | (b1 << 8);
          }
          const MF_IDS = {
            0x004C: 'Apple',    0x0006: 'Microsoft', 0x0075: 'Samsung',
            0x01D7: 'Xiaomi',   0x038F: 'Xiaomi',    0x0157: 'Huawei',
            0x0310: 'Huawei',   0x0059: 'Nordic',    0x00E0: 'Google',
            0x048F: 'Google',   0x02D5: 'Sony',      0x012D: 'Garmin',
            0x0171: 'Amazfit',  0x0499: 'Ruuvi',     0x0087: 'Garmin',
          };
          mfVendor = mfId !== null ? MF_IDS[mfId] : null;
        }

        // Parsear fingerprint Apple para identificación cross-MAC
        const appleParsed = parseAppleAdvertising(mfData);
        const appleFingerprint = appleParsed?.fingerprint || null;

        // Buscar si este fingerprint ya corresponde a un contacto guardado
        // aunque la MAC sea diferente
        if (appleFingerprint) {
          setFingerprintMap(prev => {
            if (prev[appleFingerprint] === id) return prev;
            const updated = { ...prev, [appleFingerprint]: id };
            AsyncStorage.setItem(FINGERPRINT_KEY, JSON.stringify(updated));
            return updated;
          });
        }

        setNameCache(prev => {
          if (advName && prev[id] !== advName) {
            const updated = { ...prev, [id]: advName };
            AsyncStorage.setItem(NAME_CACHE_KEY, JSON.stringify(updated));
            return updated;
          }
          return prev;
        });

        // registrar orden de aparición (nunca reordenar)
        if (!deviceOrderRef.current.includes(id)) {
          deviceOrderRef.current = [...deviceOrderRef.current, id];
        }
        setDevices(prev => {
          const next = new Map(prev);
          const existing = next.get(id);
          const history = existing
            ? [...existing.rssiHistory.slice(-(HISTORY_SIZE-1)), rssi]
            : [rssi];
          const resolvedName = advName || existing?.rawName || null;
          const resolvedMfVendor = mfVendor || existing?.mfVendor || null;
          const { displayName } = resolveDevice(id, resolvedName, resolvedMfVendor);
          // Buscar contacto por fingerprint Apple (aunque cambió el MAC)
          let matchedContactId = null;
          if (appleFingerprint) {
            const allContacts = Object.values(contacts);
            const fpMatch = allContacts.find(c => c.appleFingerprint === appleFingerprint);
            if (fpMatch && fpMatch.id !== id) {
              matchedContactId = fpMatch.id;
              // Actualizar el ID del contacto al MAC actual
              console.log(`Apple fingerprint match: ${fpMatch.alias} ahora en ${id}`);
            }
          }

          next.set(id, {
            id,
            name: displayName,
            rawName: resolvedName,
            mfVendor: resolvedMfVendor,
            appleFingerprint: appleFingerprint || existing?.appleFingerprint || null,
            appleParsed: appleParsed || existing?.appleParsed || null,
            matchedContactId, // contacto reconocido por fingerprint aunque cambió MAC
            rssi,
            rssiHistory: history,
            firstSeen: existing?.firstSeen || Date.now(),
            lastSeen: Date.now(),
          });
          return next;
        });
      }
    );

    const onStop = BleManagerEmitter.addListener('BleManagerStopScan', () => {
      if (scanRef.current) startScanCycle();
    });

    listenersRef.current = [onDiscover, onStop];
    return () => {
      listenersRef.current.forEach(l => l.remove());
      BleManager.stopScan();
      deactivateKeepAwake();
    };
  }, []);

  // ── permisos ──────────────────────────────────────────────────────────────
  const requestPermissions = async () => {
    if (Platform.OS !== 'android') { setPermissionsOk(true); return; }
    try {
      const grants = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      ]);
      const ok = Object.values(grants).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
      setPermissionsOk(ok);
      if (!ok) Alert.alert('Permisos necesarios', 'Activa Bluetooth y Ubicación en Configuración.');
    } catch { setPermissionsOk(false); }
  };

  // ── scan ──────────────────────────────────────────────────────────────────
  const startScanCycle = useCallback(() => {
    if (!scanRef.current) return;
    // allowDuplicates=true para actualizar RSSI continuamente
    // scanMode 2 = SCAN_MODE_LOW_LATENCY (máxima frecuencia)
    BleManager.scan([], SCAN_SECONDS, true, {
      scanMode: 2,
      callbackType: 1, // ALL_MATCHES
      matchMode: 1,    // AGGRESSIVE
      numberOfMatches: 3,
      reportDelay: 0,
    }).catch(() => {});
  }, []);

  const startScan = useCallback(() => {
    if (!permissionsOk) return;
    scanRef.current = true;
    setScanning(true);
    deviceOrderRef.current = [];
    setDevices(new Map());
    startScanCycle();
  }, [permissionsOk, startScanCycle]);

  const stopScan = useCallback(() => {
    scanRef.current = false;
    setScanning(false);
    BleManager.stopScan();
    setTrackedId(null);
    setTrackedDevice(null);
    setDevices(new Map());
  }, []);

  // ── sweep animation ───────────────────────────────────────────────────────
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

  // ── tracked device ────────────────────────────────────────────────────────
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

  // ── limpiar viejos ────────────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setDevices(prev => {
        const next = new Map(prev);
        for (const [id, d] of next) if (now - d.lastSeen > 20000) next.delete(id);
        return next;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── GATT resolve ──────────────────────────────────────────────────────────
  const resolveGatt = useCallback(async (deviceId) => {
    setResolvingGatt(true);
    try {
      await BleManager.stopScan();
      await BleManager.connect(deviceId);
      const info = await BleManager.retrieveServices(deviceId);
      const name = info.name || null;
      await BleManager.disconnect(deviceId);
      if (name) {
        const updated = { ...nameCache, [deviceId]: name };
        setNameCache(updated);
        await AsyncStorage.setItem(NAME_CACHE_KEY, JSON.stringify(updated));
        setDevices(prev => {
          const next = new Map(prev);
          const ex = next.get(deviceId);
          if (ex) next.set(deviceId, { ...ex, rawName: name, name: resolveDevice(deviceId, name).displayName });
          return next;
        });
        Alert.alert('✓ Nombre resuelto', name);
      } else {
        Alert.alert('Sin nombre', 'El dispositivo no expone nombre.\nEscribe el alias manualmente.');
      }
    } catch {
      Alert.alert('Error', 'No se pudo conectar.\nEscribe el alias manualmente.');
    } finally {
      setResolvingGatt(false);
      if (scanRef.current) startScanCycle();
    }
  }, [nameCache, startScanCycle]);

  // ── persistencia ──────────────────────────────────────────────────────────
  const persistContacts = useCallback(async (updated) => {
    setContacts(updated);
    await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(updated));
  }, []);

  const handleSaveContact = useCallback((id, alias, name, alertEnabled) => {
    const dev = devices.get(id);
    const fp = dev?.appleFingerprint || null;
    const updated = { ...contacts, [id]: { id, alias, name, alertEnabled, appleFingerprint: fp } };
    persistContacts(updated);
    setSaveModal({ visible: false, device: null });
    if (backgroundActive) {
      const names = Object.values(updated).filter(c => c.alertEnabled).map(c => c.alias);
      showForegroundNotification(names);
    }
  }, [contacts, persistContacts, backgroundActive]);

  const handleDeleteContact = useCallback((id) => {
    const updated = { ...contacts };
    delete updated[id];
    persistContacts(updated);
    setSaveModal({ visible: false, device: null });
  }, [contacts, persistContacts]);

  const handleRegisterDevice = useCallback((dev) => {
    setRegisterModal(false);
    const displayDev = {
      id: dev.id,
      name: dev.name || nameCache[dev.id] || dev.id.slice(-17),
      rssi: dev.rssi,
      rssiHistory: [dev.rssi],
    };
    setTimeout(() => setSaveModal({ visible: true, device: displayDev }), 300);
  }, [nameCache]);

  // ── background ────────────────────────────────────────────────────────────
  const toggleBackground = async () => {
    const alertContacts = Object.values(contacts).filter(c => c.alertEnabled);
    if (alertContacts.length === 0) {
      Alert.alert('Sin contactos', 'Primero guarda contactos con 🔔 Alerta activada.');
      return;
    }
    if (backgroundActive) {
      await dismissForegroundNotification();
      setBackgroundActive(false);
    } else {
      await showForegroundNotification(alertContacts.map(c => c.alias));
      setBackgroundActive(true);
      Alert.alert('👾 Background activado', `Buscando:\n${alertContacts.map(c => c.alias).join('\n')}`);
    }
  };

  // ── alerta proximidad contactos ───────────────────────────────────────────
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

  // ── render ────────────────────────────────────────────────────────────────
  // lista en orden de aparición (nunca se reordena, nunca se borra)
  const deviceList = deviceOrderRef.current
    .map(id => devices.get(id))
    .filter(Boolean);
  const count = deviceList.length;
  const contactCount = Object.keys(contacts).length;
  const alertContactCount = Object.values(contacts).filter(c => c.alertEnabled).length;
  const contactsOnline = Object.values(contacts).filter(c => devices.has(c.id)).length;
  const trendColor = !trackedDevice ? GREEN :
    trackedDevice.trend==='acercando' ? GREEN :
    trackedDevice.trend==='alejando' ? '#ff4444' : '#ffaa00';
  const trackedContact = trackedId ? contacts[trackedId] : null;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerModel}>MU-TH-UR 6000</Text>
        <Text style={styles.headerTitle}>MOTION TRACKER</Text>
        <View style={styles.headerLine} />
      </View>

      <View style={styles.radarWrapper}>
        <RadarDisplay devices={devices} trackedId={trackedId} sweepAngle={sweepAngle} contacts={contacts} />
        {!scanning && !backgroundActive && (
          <View style={[styles.radarOverlay, {borderRadius:RADAR_R}]}>
            <Text style={styles.radarOffText}>OFFLINE</Text>
          </View>
        )}
        {!scanning && backgroundActive && (
          <View style={[styles.radarOverlay, {borderRadius:RADAR_R}]}>
            <Text style={[styles.radarOffText, {color:'#ffaa00', fontSize:13}]}>🔍 BACKGROUND{'\n'}ACTIVO</Text>
          </View>
        )}
      </View>

      <View style={styles.infoPanel}>
        {trackedDevice ? (
          <>
            <View style={styles.infoPanelRow}>
              <View style={styles.infoCol}>
                <Text style={styles.infoKey}>TARGET</Text>
                <Text style={[styles.infoVal, trackedContact && {color:'#00ccff'}]} numberOfLines={1}>
                  {trackedContact ? trackedContact.alias : (trackedDevice.rawName || trackedDevice.name)}
                </Text>
                {trackedContact && <Text style={styles.infoSubVal} numberOfLines={1}>{trackedDevice.rawName || trackedDevice.name}</Text>}
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoKey}>DIST</Text>
                <Text style={[styles.infoValLg, {color:GREEN}]}>{trackedDevice.distance}</Text>
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoKey}>SIGNAL</Text>
                <Text style={[styles.infoValLg, {color:trendColor}]}>{Math.round(trackedDevice.avgRssi)} dBm</Text>
              </View>
            </View>
            <View style={styles.signalBarBg}>
              <View style={[styles.signalBarFill, {
                width: `${Math.round(trackedDevice.percent*100)}%`,
                backgroundColor: trackedDevice.percent>0.6 ? GREEN : trackedDevice.percent>0.35 ? '#ffaa00' : '#ff4444',
              }]} />
            </View>
            <View style={styles.trendRow}>
              <Text style={[styles.trendText, {color:trendColor}]}>
                {trackedDevice.trend==='acercando' && '▲  ACERCÁNDOSE'}
                {trackedDevice.trend==='alejando' && '▼  ALEJÁNDOSE'}
                {trackedDevice.trend==='estable' && '●  ESTABLE'}
              </Text>
              <TouchableOpacity style={styles.btnSaveInline}
                onPress={() => setSaveModal({visible:true, device:trackedDevice})}>
                <Text style={styles.btnSaveInlineText}>{contacts[trackedId] ? '✎ EDITAR' : '＋ GUARDAR'}</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <Text style={styles.infoIdle}>
            {scanning
              ? `${count} SEÑALES  ·  ${contactsOnline}/${contactCount} CONTACTOS`
              : backgroundActive
                ? `🔍 BACKGROUND ACTIVO\n${alertContactCount} contactos monitoreados`
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
          <Text style={[styles.btnMainText, scanning && {color:'#ff4444'}]}>
            {!permissionsOk ? 'SIN PERMISOS' : scanning ? '[ APAGAR ]' : '[ ACTIVAR ]'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btnContacts, contactsOnline>0 && styles.btnContactsActive]}
          onPress={() => setContactsModal(true)}
        >
          <Text style={[styles.btnContactsText, contactsOnline>0 && {color:'#00ccff'}]}>
            {contactCount>0 ? `[ ${contactsOnline>0?'●':'○'} ${contactCount} ]` : '[ LISTA ]'}
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.btnRegister} onPress={() => setRegisterModal(true)}>
        <Text style={styles.btnRegisterText}>[ ＋ REGISTRAR NUEVO CONTACTO ]</Text>
      </TouchableOpacity>

      {alertContactCount > 0 && (
        <TouchableOpacity
          style={[styles.btnBackground, backgroundActive && styles.btnBackgroundActive]}
          onPress={toggleBackground}
        >
          <Text style={[styles.btnBackgroundText, backgroundActive && {color:'#ffaa00'}]}>
            {backgroundActive
              ? `[ 🔍 BACKGROUND ON — ${alertContactCount} CONTACTOS ]`
              : `[ 🔕 ACTIVAR RASTREO EN BACKGROUND ]`}
          </Text>
        </TouchableOpacity>
      )}

      {scanning && (
        <View style={[styles.controls, {marginTop:2}]}>
          {count>0 && (
            <TouchableOpacity style={styles.btnSecondary} onPress={() => setScanScreen(true)}>
              <Text style={styles.btnSecondaryText}>`[ ${count} SEÑALES ]`</Text>
            </TouchableOpacity>
          )}
          {trackedId && (
            <TouchableOpacity style={styles.btnCancel} onPress={() => setTrackedId(null)}>
              <Text style={styles.btnCancelText}>[ SOLTAR ]</Text>
            </TouchableOpacity>
          )}
        </View>
      )}



      <View style={styles.footer}>
        <Text style={styles.footerText}>WEYLAND-YUTANI CORP  ·  v4.0</Text>
      </View>

      <SaveContactModal
        visible={saveModal.visible}
        device={saveModal.device}
        nameCache={nameCache}
        existingContact={saveModal.device ? contacts[saveModal.device.id] : null}
        onSave={handleSaveContact}
        onDelete={handleDeleteContact}
        onClose={() => setSaveModal({visible:false, device:null})}
        onResolveGatt={resolveGatt}
        resolvingGatt={resolvingGatt}
      />
      <ContactsListModal
        visible={contactsModal}
        contacts={contacts}
        devices={devices}
        onEdit={(id) => {
          const dev = devices.get(id) || {id, name: contacts[id]?.name || nameCache[id] || id};
          setContactsModal(false);
          setSaveModal({visible:true, device:dev});
        }}
        onClose={() => setContactsModal(false)}
        onTrack={(id) => { setTrackedId(id); setContactsModal(false); }}
      />
      <RegisterMode
        visible={registerModal}
        manager={BleManager}
        onDeviceFound={handleRegisterDevice}
        onClose={() => setRegisterModal(false)}
      />
      <ScanScreen
        visible={scanScreen}
        devices={deviceList}
        contacts={contacts}
        scanning={scanning}
        onClose={() => setScanScreen(false)}
        onTrack={(id) => { setTrackedId(id); setScanScreen(false); }}
        onStar={(dev) => {
          setScanScreen(false);
          setTimeout(() => setSaveModal({ visible: true, device: dev }), 300);
        }}
        onLongPress={(dev) => {
          setScanScreen(false);
          setTimeout(() => setSaveModal({ visible: true, device: dev }), 300);
        }}
      />
    </View>
  );
}

// ── estilos ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:{flex:1,backgroundColor:BG,paddingTop:44,paddingHorizontal:12},
  header:{alignItems:'center',marginBottom:6},
  headerModel:{color:DIMGREEN,fontSize:10,letterSpacing:6,fontFamily:MONO},
  headerTitle:{color:GREEN,fontSize:20,fontWeight:'bold',letterSpacing:8,fontFamily:MONO},
  headerLine:{width:'100%',height:1,backgroundColor:DIMGREEN,marginTop:6},
  radarWrapper:{alignItems:'center',marginVertical:6,position:'relative'},
  radarContainer:{position:'relative'},
  radarBg:{position:'absolute',width:'100%',height:'100%',backgroundColor:BG},
  radarRing:{position:'absolute',borderWidth:1,borderColor:'#003310'},
  radarLine:{position:'absolute',backgroundColor:'#003310'},
  sweepLine:{position:'absolute',height:2,backgroundColor:GREEN,opacity:0.85,shadowColor:GREEN,shadowOpacity:1,shadowRadius:10},
  blip:{position:'absolute',elevation:5},
  blipLabel:{position:'absolute',color:'#00ccff',fontSize:7,fontFamily:MONO},
  radarLabel:{position:'absolute',color:'#005520',fontSize:8,fontFamily:MONO},
  radarOverlay:{position:'absolute',top:0,left:0,right:0,bottom:0,alignItems:'center',justifyContent:'center',backgroundColor:'#000d00cc'},
  radarOffText:{color:'#ff4444',fontSize:18,letterSpacing:6,fontFamily:MONO,textAlign:'center'},
  infoPanel:{borderWidth:1,borderColor:DIMGREEN,borderRadius:6,padding:10,marginBottom:6,backgroundColor:'#00080050',minHeight:62},
  infoPanelRow:{flexDirection:'row',justifyContent:'space-between',marginBottom:6},
  infoCol:{flex:1,alignItems:'center'},
  infoKey:{color:'#005520',fontSize:8,letterSpacing:2,fontFamily:MONO},
  infoVal:{color:GREEN,fontSize:11,fontFamily:MONO},
  infoSubVal:{color:'#005520',fontSize:9,fontFamily:MONO},
  infoValLg:{fontSize:15,fontWeight:'bold',fontFamily:MONO},
  signalBarBg:{height:5,backgroundColor:'#001a00',borderRadius:3,overflow:'hidden',marginBottom:5},
  signalBarFill:{height:'100%',borderRadius:3},
  trendRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  trendText:{fontSize:11,letterSpacing:2,fontFamily:MONO},
  btnSaveInline:{borderWidth:1,borderColor:'#005520',borderRadius:4,paddingHorizontal:8,paddingVertical:2},
  btnSaveInlineText:{color:'#00aa33',fontSize:9,fontFamily:MONO},
  infoIdle:{color:'#005520',fontSize:11,textAlign:'center',letterSpacing:1,fontFamily:MONO,paddingVertical:6,lineHeight:18},
  controls:{flexDirection:'row',gap:8,marginBottom:6},
  btnMain:{flex:2,borderWidth:1,borderColor:GREEN,borderRadius:4,paddingVertical:11,alignItems:'center'},
  btnMainActive:{borderColor:'#ff4444'},
  btnMainText:{color:GREEN,fontSize:13,letterSpacing:3,fontFamily:MONO},
  btnContacts:{flex:1,borderWidth:1,borderColor:DIMGREEN,borderRadius:4,paddingVertical:11,alignItems:'center'},
  btnContactsActive:{borderColor:'#00ccff'},
  btnContactsText:{color:DIMGREEN,fontSize:12,letterSpacing:1,fontFamily:MONO},
  btnRegister:{borderWidth:1,borderColor:'#004422',borderRadius:4,paddingVertical:10,alignItems:'center',marginBottom:6},
  btnRegisterText:{color:'#008833',fontSize:11,letterSpacing:1,fontFamily:MONO},
  btnBackground:{borderWidth:1,borderColor:'#333',borderRadius:4,paddingVertical:10,alignItems:'center',marginBottom:6},
  btnBackgroundActive:{borderColor:'#ffaa00',backgroundColor:'#1a1200'},
  btnBackgroundText:{color:'#555',fontSize:10,letterSpacing:1,fontFamily:MONO},
  btnSecondary:{flex:1,borderWidth:1,borderColor:'#ffaa00',borderRadius:4,paddingVertical:10,alignItems:'center'},
  btnSecondaryText:{color:'#ffaa00',fontSize:11,letterSpacing:1,fontFamily:MONO},
  btnCancel:{flex:1,borderWidth:1,borderColor:'#ff4444',borderRadius:4,paddingVertical:10,alignItems:'center'},
  btnCancelText:{color:'#ff4444',fontSize:11,letterSpacing:1,fontFamily:MONO},
  list:{flex:1},
  devRow:{flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderColor:'#001a00',paddingVertical:7},
  devRowActive:{backgroundColor:'#001a00'},
  devRowContact:{borderLeftWidth:2,borderLeftColor:'#00ccff',paddingLeft:6},
  devBarBg:{width:50,height:4,backgroundColor:'#001a00',borderRadius:2,marginRight:8,overflow:'hidden'},
  devBarFill:{height:'100%',borderRadius:2},
  devName:{color:GREEN,fontSize:11,fontFamily:MONO},
  devSubName:{color:'#005520',fontSize:9,fontFamily:MONO},
  devRssi:{fontSize:11,fontFamily:MONO},
  listHint:{color:'#003310',fontSize:9,textAlign:'center',marginTop:8,fontFamily:MONO},
  footer:{paddingVertical:6,alignItems:'center'},
  footerText:{color:'#002a0a',fontSize:8,letterSpacing:3,fontFamily:MONO},
  modalOverlay:{flex:1,backgroundColor:'#000d00dd',justifyContent:'center'},
  modalBox:{backgroundColor:'#000f00',borderWidth:1,borderColor:GREEN,borderRadius:8,padding:18,width:'100%'},
  modalTitle:{color:GREEN,fontSize:13,letterSpacing:3,fontFamily:MONO,textAlign:'center',marginBottom:10},
  modalDevId:{color:'#003310',fontSize:9,fontFamily:MONO,textAlign:'center',marginBottom:10},
  modalLabel:{color:DIMGREEN,fontSize:9,letterSpacing:2,fontFamily:MONO,marginBottom:6},
  nameOption:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',borderWidth:1,borderColor:'#002a00',borderRadius:4,paddingHorizontal:10,paddingVertical:8,marginBottom:4},
  nameOptionSelected:{borderColor:GREEN,backgroundColor:'#001a00'},
  nameOptionText:{color:'#009933',fontSize:12,fontFamily:MONO,flex:1},
  nameOptionSource:{color:'#005520',fontSize:8,fontFamily:MONO},
  btnGatt:{borderWidth:1,borderColor:'#005520',borderRadius:4,paddingVertical:9,alignItems:'center',marginTop:4},
  btnGattText:{color:'#00aa33',fontSize:10,fontFamily:MONO},
  modalInput:{borderWidth:1,borderColor:DIMGREEN,borderRadius:4,color:GREEN,fontFamily:MONO,fontSize:16,paddingHorizontal:12,paddingVertical:8,marginBottom:10,backgroundColor:'#000d00'},
  modalToggle:{borderWidth:1,borderColor:'#003310',borderRadius:4,paddingVertical:10,alignItems:'center',marginBottom:4},
  modalToggleOn:{borderColor:GREEN,backgroundColor:'#001a00'},
  modalToggleText:{color:'#005520',fontSize:12,fontFamily:MONO},
  modalHint:{color:'#005520',fontSize:9,fontFamily:MONO,textAlign:'center',marginBottom:6,lineHeight:14},
  modalEmpty:{color:'#005520',fontSize:11,fontFamily:MONO,textAlign:'center',marginVertical:20,lineHeight:20},
  modalButtons:{flexDirection:'row',gap:8,marginTop:10},
  modalBtnSave:{flex:1,borderWidth:1,borderColor:GREEN,borderRadius:4,paddingVertical:10,alignItems:'center'},
  modalBtnSaveText:{color:GREEN,fontSize:11,fontFamily:MONO},
  modalBtnCancel:{flex:1,borderWidth:1,borderColor:DIMGREEN,borderRadius:4,paddingVertical:10,alignItems:'center'},
  modalBtnCancelText:{color:DIMGREEN,fontSize:11,fontFamily:MONO},
  modalBtnDelete:{flex:1,borderWidth:1,borderColor:'#ff4444',borderRadius:4,paddingVertical:10,alignItems:'center'},
  modalBtnDeleteText:{color:'#ff4444',fontSize:11,fontFamily:MONO},
  contactRow:{flexDirection:'row',alignItems:'center',paddingVertical:10,borderBottomWidth:1,borderColor:'#001a00',gap:8},
  contactDot:{width:8,height:8,borderRadius:4},
  contactAlias:{color:'#00ccff',fontSize:14,fontFamily:MONO},
  contactSub:{color:'#005520',fontSize:9,fontFamily:MONO,marginTop:2},
  contactDist:{fontSize:10,fontFamily:MONO,marginTop:2},
  contactTrack:{borderWidth:1,borderColor:GREEN,borderRadius:4,paddingHorizontal:8,paddingVertical:4},
  contactTrackText:{color:GREEN,fontSize:9,fontFamily:MONO},
  contactEdit:{borderWidth:1,borderColor:DIMGREEN,borderRadius:4,paddingHorizontal:8,paddingVertical:4},
  contactEditText:{color:DIMGREEN,fontSize:9,fontFamily:MONO},
});
